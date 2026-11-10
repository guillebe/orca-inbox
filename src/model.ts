// Pure inbox logic: what a thread is, how a Claude Code tool call becomes one, and the text a
// reply sends back to the agent. No Orca calls here, so everything is unit-tested in Node.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Option = { label: string; description?: string }
export type Question = { question: string; header?: string; multiSelect: boolean; options: Option[] }

/**
 * Where a thread came from. Only threads with a terminal can get a reply delivered.
 * `sessionTitle` is the title Orca shows on the agent's tab (usually a summary of its task),
 * caught when the thread opens; threads stored before it existed have none.
 */
export type Origin = {
  agent: string
  terminalId: string
  workspaceId: string | null
  sessionTitle?: string | null
}

export type ThreadBody =
  | { kind: 'question'; questions: Question[] }
  | { kind: 'plan'; plan: string }
  | { kind: 'attention'; title: string | null }

export type ThreadStatus =
  | { state: 'open' }
  | { state: 'answered'; at: number; reply: string }
  | { state: 'resolved'; at: number }
  | { state: 'dismissed'; at: number }

export type Thread = {
  id: string
  createdAt: number
  origin: Origin
  body: ThreadBody
  status: ThreadStatus
}

/** What Orca last reported about the agent behind a thread. */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type ThreadSummary = {
  id: string
  createdAt: number
  kind: ThreadBody['kind']
  title: string
  /** Which session and workspace asked, for the list. */
  source: string
  /** The workspace folder alone, to group the list; null when unknown. */
  workspace: string | null
  state: ThreadStatus['state']
  /** Null when no status event arrived for that agent since the worker started. */
  agentState: AgentState | null
}

/** What the person sends from the panel; its shape follows the thread kind. */
export type Response =
  /** `others[i]`: text typed in question i's "Other" field, as Claude Code's own prompt offers. */
  | { kind: 'answers'; picks: string[][]; others?: string[]; note: string }
  | { kind: 'plan'; decision: 'approve' | 'revise'; feedback: string }
  | { kind: 'text'; text: string }

export type ToolCall = {
  agent: string
  workspaceId: string | null
  terminalId?: string
  tool: string
  input: Json
}

/**
 * What the `agent.tool.before` hook should do with one tool call.
 * - `ignore`: not ours (another tool, another agent, or no terminal to answer into).
 * - `capture`: queue it as a thread and refuse the call with a reason the agent reads.
 * - `release-plan`: the person already approved this terminal's plan, so let the call through.
 */
export type ToolDecision =
  | { action: 'ignore' }
  | { action: 'capture'; origin: Origin; body: ThreadBody }
  | { action: 'release-plan'; terminalId: string }

export type CaptureSettings = { captureQuestions: boolean; capturePlans: boolean }

export const MAX_THREADS = 200
const DEDUPE_WINDOW_MS = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isClaude = (agent: string): boolean => /claude/i.test(agent)

/**
 * Orca refuses a panel render with a text over 16 KiB or a label prop over 1 KiB, and keeps the
 * last good one: a single oversized string would make a thread impossible to open. These caps
 * are in characters, sized so even 3-byte UTF-8 text stays under those byte limits.
 */
export const LIMITS = { label: 150, question: 300, title: 200, markdown: 5000 } as const

/** Cuts `text` to `max` characters, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Splits markdown into pieces of at most `max` characters, breaking between paragraphs where it
 * can, so a long plan renders whole as several Markdown blocks instead of one refused text.
 */
export function markdownChunks(markdown: string, max: number = LIMITS.markdown): string[] {
  const chunks: string[] = []
  let current = ''
  for (const paragraph of markdown.split(/\n{2,}/)) {
    const pieces = paragraph.length > max ? (paragraph.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? []) : [paragraph]
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > max) {
        chunks.push(current)
        current = piece
      } else {
        current = current ? `${current}\n\n${piece}` : piece
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function parseOption(value: unknown): Option | null {
  if (!isRecord(value) || typeof value.label !== 'string') return null
  const label = clip(value.label, LIMITS.label)
  return typeof value.description === 'string'
    ? { label, description: clip(value.description, LIMITS.label) }
    : { label }
}

function parseQuestion(value: unknown): Question | null {
  if (!isRecord(value) || typeof value.question !== 'string') return null
  const options = Array.isArray(value.options) ? value.options.map(parseOption) : []
  if (options.some((option) => option === null)) return null
  return {
    question: clip(value.question, LIMITS.question),
    ...(typeof value.header === 'string' ? { header: clip(value.header, LIMITS.label) } : {}),
    multiSelect: value.multiSelect === true,
    options: options as Option[]
  }
}

/** Reads Claude Code's `AskUserQuestion` input; null when it is not the shape we know. */
export function parseQuestions(input: unknown): Question[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null
  const questions = input.questions.map(parseQuestion)
  if (questions.length === 0 || questions.some((question) => question === null)) return null
  return questions as Question[]
}

/** Reads Claude Code's `ExitPlanMode` input; null when there is no plan text. */
export function parsePlan(input: unknown): string | null {
  if (!isRecord(input) || typeof input.plan !== 'string' || input.plan.trim() === '') return null
  return input.plan
}

/**
 * Decides what the hook does. Only Claude Code waits for `agent.tool.before`, so a deny from
 * any other agent would be ignored and the question asked twice: those calls are left alone.
 */
export function classifyToolCall(
  call: ToolCall,
  settings: CaptureSettings,
  approvedPlanTerminals: readonly string[]
): ToolDecision {
  if (!isClaude(call.agent) || !call.terminalId) return { action: 'ignore' }
  const origin: Origin = {
    agent: call.agent,
    terminalId: call.terminalId,
    workspaceId: call.workspaceId
  }
  if (call.tool === 'AskUserQuestion' && settings.captureQuestions) {
    const questions = parseQuestions(call.input)
    return questions ? { action: 'capture', origin, body: { kind: 'question', questions } } : { action: 'ignore' }
  }
  if (call.tool === 'ExitPlanMode' && settings.capturePlans) {
    if (approvedPlanTerminals.includes(call.terminalId)) {
      return { action: 'release-plan', terminalId: call.terminalId }
    }
    const plan = parsePlan(call.input)
    return plan ? { action: 'capture', origin, body: { kind: 'plan', plan } } : { action: 'ignore' }
  }
  return { action: 'ignore' }
}

/**
 * The reason Claude Code reads when the hook refuses the call. It is a protocol, not a
 * courtesy: a vague reason makes the agent call the tool again and open a second thread.
 */
export function denyReason(thread: Thread): string {
  // The person may be away from the panel (on a phone, say) and only see this terminal, so the
  // agent restates what it asked here and takes an answer from either place.
  const restate =
    thread.body.kind === 'plan'
      ? 'Then end your turn with a short message saying the plan is waiting for review, so the person can also reply right here.'
      : 'Then end your turn with a short message that repeats the question and numbers its options, so the person can also answer right here, maybe with just a number.'
  const what = thread.body.kind === 'plan' ? 'Your plan was sent' : 'Your question was sent'
  return [
    `${what} to the person's Orca Inbox (thread ${thread.id}).`,
    'Do not call this tool again for it.',
    'First finish any work that does not depend on the answer.',
    restate,
    'The answer arrives as your next user message: prefixed with [Orca Inbox], or typed directly in this terminal.'
  ].join(' ')
}

/**
 * Open questions and plans a person answered by typing in the agent's terminal. The plugin never
 * sees that text; it sees the agent go idle after asking (`idleSince`) and then start working
 * again without an Inbox reply. Null when nothing closes. A prompt sent by something other than
 * the person (an orchestrator, say) looks the same, and closes the thread too.
 */
export function resolveAnsweredInTerminal(
  threads: readonly Thread[],
  terminalId: string,
  idleSince: number,
  now: number
): Thread[] | null {
  let changed = false
  const next = threads.map((thread) => {
    if (
      thread.status.state !== 'open' ||
      thread.body.kind === 'attention' ||
      thread.origin.terminalId !== terminalId ||
      thread.createdAt > idleSince
    ) {
      return thread
    }
    changed = true
    return { ...thread, status: { state: 'resolved' as const, at: now } }
  })
  return changed ? next : null
}

/** Text typed into a TUI: a newline would submit early, so everything goes on one line. */
export function oneLine(text: string): string {
  return text.trim().replace(/\s*\n+\s*/g, ' / ').replace(/\s+/g, ' ').trim()
}

/** True when every question has at least one picked option: the only answers worth sending. */
/**
 * One question's answer as the agent reads it; null when nothing was picked or typed. Typed
 * text is quoted so the agent can tell it from an option label, and on a single-choice
 * question it replaces the pick, as "Other" does in Claude Code's own prompt.
 */
export function questionAnswer(question: Question, picks: readonly string[], other: string): string | null {
  const typed = oneLine(other)
  const quoted = typed ? `"${typed}"` : null
  if (!question.multiSelect) return quoted ?? picks[0] ?? null
  const parts = quoted ? [...picks, quoted] : [...picks]
  return parts.length > 0 ? parts.join(', ') : null
}

/** True when every question has an answer, picked or typed: the only answers worth sending. */
export const allAnswered = (
  questions: readonly Question[],
  picks: readonly string[][],
  others: readonly string[] = []
): boolean => questions.every((question, index) => questionAnswer(question, picks[index] ?? [], others[index] ?? '') !== null)

function formatAnswers(thread: Thread, questions: Question[], picks: string[][], others: string[], note: string): string | null {
  if (!allAnswered(questions, picks, others)) return null
  const parts = questions.map(
    (question, index) => `«${question.question}» → ${questionAnswer(question, picks[index] ?? [], others[index] ?? '')}`
  )
  const trimmed = oneLine(note)
  if (trimmed) parts.push(`Note: ${trimmed}`)
  return oneLine(`[Orca Inbox] Answers to thread ${thread.id}: ${parts.join(' | ')}`)
}

function formatPlan(thread: Thread, decision: 'approve' | 'revise', feedback: string): string {
  const trimmed = oneLine(feedback)
  if (decision === 'approve') {
    const extra = trimmed ? ` Notes: ${trimmed}` : ''
    return `[Orca Inbox] Plan in thread ${thread.id} is approved. Call ExitPlanMode again with the same plan to start.${extra}`
  }
  return `[Orca Inbox] Plan in thread ${thread.id} needs changes before approval: ${trimmed || '(no details given)'}. Revise the plan and call ExitPlanMode again.`
}

/** The single-line prompt a response types into the agent's terminal; null when it does not fit the thread. */
export function formatReply(thread: Thread, response: Response): string | null {
  const { body } = thread
  if (body.kind === 'question' && response.kind === 'answers') {
    return formatAnswers(thread, body.questions, response.picks, response.others ?? [], response.note)
  }
  if (body.kind === 'plan' && response.kind === 'plan') {
    return formatPlan(thread, response.decision, response.feedback)
  }
  if (response.kind === 'text' && oneLine(response.text)) {
    return oneLine(`[Orca Inbox] Reply to thread ${thread.id}: ${response.text}`)
  }
  return null
}

export function threadTitle(body: ThreadBody): string {
  switch (body.kind) {
    case 'question': {
      const first = body.questions[0]
      const title = first?.header ? `${first.header}: ${first.question}` : (first?.question ?? 'Question')
      return clip(body.questions.length > 1 ? `${title} (+${body.questions.length - 1})` : title, LIMITS.title)
    }
    case 'plan': {
      const heading = body.plan.split('\n').find((line) => line.trim() !== '') ?? 'Plan'
      return clip(heading.replace(/^#+\s*/, ''), LIMITS.title)
    }
    case 'attention':
      return clip(body.title ? `${body.title} needs you in its terminal` : 'An agent needs you in its terminal', LIMITS.title)
  }
}

export function summarize(thread: Thread, agentState: AgentState | null = null): ThreadSummary {
  return {
    id: thread.id,
    createdAt: thread.createdAt,
    kind: thread.body.kind,
    title: threadTitle(thread.body),
    source: describeOrigin(thread.origin),
    workspace: workspaceLabel(thread.origin.workspaceId),
    state: thread.status.state,
    agentState: thread.status.state === 'open' ? agentState : null
  }
}

/** Closed threads are kept this long, so the Closed tab stays a recent history. */
export const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60_000

/** Drops closed threads older than the retention; open ones always stay. */
export function pruneClosed(threads: readonly Thread[], now: number, maxAgeMs: number = CLOSED_RETENTION_MS): Thread[] {
  return threads.filter((thread) => thread.status.state === 'open' || now - thread.status.at < maxAgeMs)
}

/** Groups summaries by workspace in first-seen order; threads with no workspace go last. */
export function groupByWorkspace(items: readonly ThreadSummary[]): { workspace: string; items: ThreadSummary[] }[] {
  const groups = new Map<string, ThreadSummary[]>()
  for (const item of items) {
    const key = item.workspace ?? 'Other'
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const other = groups.get('Other')
  groups.delete('Other')
  const ordered = [...groups].map(([workspace, grouped]) => ({ workspace, items: grouped }))
  return other ? [...ordered, { workspace: 'Other', items: other }] : ordered
}

/** How the agent's state reads next to an open thread. */
export function agentStateLabel(state: AgentState | null): string | null {
  switch (state) {
    case 'working':
      return 'agent working'
    case 'blocked':
      return 'agent blocked'
    case 'waiting':
    case 'done':
      return 'agent waiting'
    default:
      return null
  }
}

const sameBody = (a: ThreadBody, b: ThreadBody): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * An open thread from the same terminal with the same body, created within the dedupe window.
 * A retried tool call reuses it instead of opening a second thread.
 */
export function findDuplicate(
  threads: readonly Thread[],
  origin: Origin,
  body: ThreadBody,
  now: number
): Thread | null {
  return (
    threads.find(
      (thread) =>
        thread.status.state === 'open' &&
        thread.origin.terminalId === origin.terminalId &&
        now - thread.createdAt < DEDUPE_WINDOW_MS &&
        sameBody(thread.body, body)
    ) ?? null
  )
}

/** Newest first, capped: closed threads fall off the end before open ones. */
export function addThread(threads: readonly Thread[], thread: Thread): Thread[] {
  const next = [thread, ...threads]
  if (next.length <= MAX_THREADS) return next
  const open = next.filter((item) => item.status.state === 'open')
  const closed = next.filter((item) => item.status.state !== 'open')
  const keepClosed = Math.max(0, MAX_THREADS - open.length)
  const kept = new Set([...open, ...closed.slice(0, keepClosed)].map((item) => item.id))
  return next.filter((item) => kept.has(item.id))
}

export function replaceThread(threads: readonly Thread[], thread: Thread): Thread[] {
  return threads.map((item) => (item.id === thread.id ? thread : item))
}

export const openCount = (threads: readonly Thread[]): number =>
  threads.filter((thread) => thread.status.state === 'open').length

/** Open attention threads for a terminal: closed once the agent is working again. */
export function resolveAttention(threads: readonly Thread[], terminalId: string, now: number): Thread[] {
  return threads.map((thread) =>
    thread.body.kind === 'attention' &&
    thread.status.state === 'open' &&
    thread.origin.terminalId === terminalId
      ? { ...thread, status: { state: 'resolved', at: now } }
      : thread
  )
}

export const hasOpenAttention = (threads: readonly Thread[], terminalId: string): boolean =>
  threads.some(
    (thread) =>
      thread.body.kind === 'attention' &&
      thread.status.state === 'open' &&
      thread.origin.terminalId === terminalId
  )

/** Reads stored threads defensively: storage is JSON written by an earlier version. */
export function readThreads(value: unknown): Thread[] {
  return Array.isArray(value) ? (value.filter(isRecord) as unknown as Thread[]) : []
}

export function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** A plan approval: the terminal's next ExitPlanMode passes once, if it comes soon enough. */
export type PlanApproval = { terminalId: string; at: number }

/** Past this an approval is stale: the person may have left plan mode by hand meanwhile. */
export const PLAN_APPROVAL_TTL_MS = 30 * 60_000

export function readApprovals(value: unknown): PlanApproval[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is PlanApproval =>
      isRecord(item) && typeof item.terminalId === 'string' && typeof item.at === 'number'
  )
}

/** Terminals with an approval younger than the TTL. */
export const activeApprovalTerminals = (approvals: readonly PlanApproval[], now: number): string[] =>
  approvals.filter((item) => now - item.at < PLAN_APPROVAL_TTL_MS).map((item) => item.terminalId)

export const approve = (approvals: readonly PlanApproval[], terminalId: string, now: number): PlanApproval[] => [
  ...approvals.filter((item) => item.terminalId !== terminalId && now - item.at < PLAN_APPROVAL_TTL_MS),
  { terminalId, at: now }
]

export const consumeApproval = (approvals: readonly PlanApproval[], terminalId: string): PlanApproval[] =>
  approvals.filter((item) => item.terminalId !== terminalId)

/**
 * Terminals whose agent is `blocked` (a permission prompt, say). A reply typed there would
 * press Enter on the prompt and accept its highlighted option, so replies wait until it clears.
 */
export function trackBlocked(blocked: readonly string[], terminalId: string, state: string): string[] {
  const others = blocked.filter((id) => id !== terminalId)
  return state === 'blocked' ? [...others, terminalId] : others
}

/** Tools this plugin captures; an ignored call to one of them is worth a log line. */
export const isCapturableTool = (tool: string): boolean => tool === 'AskUserQuestion' || tool === 'ExitPlanMode'

/**
 * The workspace's folder, from Orca's workspace id (`<repo id>::<absolute path>`), as its last
 * two path segments (`acme/web-app`). Null when the id has another shape.
 */
export function workspaceLabel(workspaceId: string | null): string | null {
  const path = workspaceId?.split('::')[1]
  if (!path) return null
  const segments = path.split('/').filter(Boolean)
  return segments.length > 0 ? segments.slice(-2).join('/') : null
}

/** "Session title · acme/web-app", whichever parts are known. */
export function describeOrigin(origin: Origin): string {
  const title = isGenericTitle(origin.sessionTitle) ? null : (origin.sessionTitle?.trim() ?? null)
  const parts = [title, workspaceLabel(origin.workspaceId)].filter(
    (part): part is string => Boolean(part)
  )
  return parts.length > 0 ? clip(parts.join(' · '), LIMITS.title) : 'Unknown session'
}

/** Titles Orca shows before an agent names its task: they say nothing about the work. */
export const isGenericTitle = (title: string | null | undefined): boolean =>
  !title?.trim() || /^(claude( code)?|codex|opencode|terminal|zsh|bash)$/i.test(title.trim())

/**
 * The agent names its task a few seconds after it starts, often after it already asked: give
 * that terminal's open threads the new title. Null when nothing changes, so callers skip the write.
 */
export function retitleThreads(threads: readonly Thread[], terminalId: string, title: string): Thread[] | null {
  if (isGenericTitle(title)) return null
  let changed = false
  const next = threads.map((thread) => {
    if (
      thread.status.state !== 'open' ||
      thread.origin.terminalId !== terminalId ||
      thread.origin.sessionTitle === title
    ) {
      return thread
    }
    changed = true
    return { ...thread, origin: { ...thread.origin, sessionTitle: title } }
  })
  return changed ? next : null
}
