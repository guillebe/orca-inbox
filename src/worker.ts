// The Inbox worker: turns Claude Code questions and plans into threads (agent.tool.before),
// tracks blocked agents (agent.status.changed), answers the panel, and types replies into the
// agent's terminal. Decisions live in src/model.ts; this file only does the I/O around them.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  activeApprovalTerminals,
  addThread,
  approve,
  classifyToolCall,
  consumeApproval,
  denyReason,
  findDuplicate,
  formatReply,
  hasOpenAttention,
  isCapturableTool,
  openCount,
  readApprovals,
  readStringList,
  readThreads,
  replaceThread,
  resolveAttention,
  retitleThreads,
  summarize,
  trackBlocked,
  type CaptureSettings,
  type Origin,
  type Thread,
  type ThreadBody,
  type ToolCall
} from './model'

const THREADS = 'threads'
/** Terminals whose plan the person approved: their next ExitPlanMode goes through once. */
const APPROVED_PLANS = 'approvedPlans'
/** Terminals whose agent sits on a prompt: no reply is typed there until it clears. */
const BLOCKED = 'blockedTerminals'
const STATUS_ITEM = 'open-threads'
/** Under Orca's 2 s hook limit. Past it the call goes through and the agent asks in its terminal. */
const HOOK_BUDGET_MS = 1500

type Settings = CaptureSettings & { trackBlocked: boolean; notify: boolean }

/** Where the app bundles its CLI on macOS; `orca` on PATH is the fallback elsewhere. */
const BUNDLED_ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

/**
 * Brings a terminal tab to the front. The plugin host API has no method for it, so this runs
 * Orca's own CLI (the worker already runs as the user). Only real runtime handles
 * (`term_…`) are tried, which also keeps tests from reaching a live Orca. Resolves false on any
 * failure: the caller has already opened the workspace.
 */
function switchToTerminal(terminalId: string): Promise<boolean> {
  if (!terminalId.startsWith('term_')) return Promise.resolve(false)
  const cli = existsSync(BUNDLED_ORCA_CLI) ? BUNDLED_ORCA_CLI : 'orca'
  return new Promise((resolve) => {
    execFile(cli, ['terminal', 'switch', '--terminal', terminalId, '--json'], { timeout: 5000 }, (error) =>
      resolve(!error)
    )
  })
}

const newId = (): string => globalThis.crypto.randomUUID().slice(0, 8)

export default function activate(orca: OrcaWorkerApi): void {
  // Hook, events and panel requests all read-modify-write the same keys: run them one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  const loadThreads = async (): Promise<Thread[]> => readThreads(await orca.storage.get(THREADS))
  const loadApprovals = async () => readApprovals(await orca.storage.get(APPROVED_PLANS))
  const loadBlocked = async (): Promise<string[]> => readStringList(await orca.storage.get(BLOCKED))

  async function loadSettings(): Promise<Settings> {
    const all = await orca.settings.get()
    return {
      captureQuestions: all.captureQuestions !== false,
      capturePlans: all.capturePlans !== false,
      trackBlocked: all.trackBlocked !== false,
      notify: all.notify !== false
    }
  }

  function showCount(threads: readonly Thread[]): void {
    const open = openCount(threads)
    void orca.host
      .call('statusBar.update', {
        id: STATUS_ITEM,
        text: open > 0 ? `Inbox ${open}` : 'Inbox',
        tone: open > 0 ? 'accent' : 'neutral'
      })
      .catch(() => undefined)
  }

  async function saveThreads(threads: Thread[]): Promise<void> {
    await orca.storage.set(THREADS, threads)
    orca.panels.post('inbox.changed', { open: openCount(threads) })
    showCount(threads)
  }

  function notifyNew(settings: Settings, thread: Thread): void {
    if (!settings.notify) return
    const title = thread.body.kind === 'plan' ? 'Plan to review' : thread.body.kind === 'question' ? 'Agent question' : 'Agent blocked'
    void orca.host
      .call('notifications.show', { title: `Inbox: ${title}`, body: summarize(thread).title })
      .catch(() => undefined)
  }

  /** Stores a new thread, or returns the open one a retried call already made. */
  async function openThread(origin: Origin, body: ThreadBody): Promise<{ thread: Thread; created: boolean }> {
    const threads = await loadThreads()
    const now = Date.now()
    const duplicate = findDuplicate(threads, origin, body, now)
    if (duplicate) return { thread: duplicate, created: false }
    const thread: Thread = { id: newId(), createdAt: now, origin, body, status: { state: 'open' } }
    await saveThreads(addThread(threads, thread))
    return { thread, created: true }
  }

  /** Closes an open thread without telling the agent. */
  async function closeThread(id: string, state: 'dismissed'): Promise<{ ok: boolean }> {
    const threads = await loadThreads()
    const thread = threads.find((item) => item.id === id)
    if (!thread || thread.status.state !== 'open') return { ok: false }
    await saveThreads(replaceThread(threads, { ...thread, status: { state, at: Date.now() } }))
    return { ok: true }
  }

  // Tab titles by terminal, from agent status events. In memory only: a worker restart loses
  // them, and `agents.list` (the focused workspace's agents) fills the gap after the fact.
  const titles = new Map<string, string>()

  /** Looks the title up after the hook has answered, so the hook never waits on it. */
  function fillTitleLater(terminalId: string): void {
    void orca.host
      .call('agents.list', {})
      .then(({ agents }) => agents.find((agent) => agent.terminalId === terminalId)?.title ?? null)
      .then((title) => {
        if (!title) return
        titles.set(terminalId, title)
        return serially(async () => {
          const retitled = retitleThreads(await loadThreads(), terminalId, title)
          if (retitled) await saveThreads(retitled)
        })
      })
      .catch(() => undefined)
  }

  /**
   * The hook's decision; null lets the call through unchanged. `deadline.expired` turns true
   * when the hook's budget runs out: the call has then gone through to the terminal, so a
   * thread must not be created, and one created in that instant is closed again.
   */
  async function handleToolCall(call: ToolCall, deadline: { expired: boolean }): Promise<{ deny: string } | null> {
    const settings = await loadSettings()
    const approved = activeApprovalTerminals(await loadApprovals(), Date.now())
    const decision = classifyToolCall(call, settings, approved)
    if (decision.action === 'ignore') {
      orca.log(`ignored ${call.tool} from agent "${call.agent}" terminal ${call.terminalId ?? 'none'}`)
      return null
    }
    if (decision.action === 'release-plan') {
      void serially(async () => {
        await orca.storage.set(APPROVED_PLANS, consumeApproval(await loadApprovals(), decision.terminalId))
      })
      return null
    }
    const { terminalId } = decision.origin
    const origin: Origin = { ...decision.origin, sessionTitle: titles.get(terminalId) ?? null }
    // Persist first, then deny: if storage fails the call passes and the agent asks in its
    // terminal as usual, instead of believing a question was queued that never was.
    const stored = await serially(async () => (deadline.expired ? null : openThread(origin, decision.body)))
    if (!stored) return null
    if (deadline.expired) {
      if (stored.created) void serially(() => closeThread(stored.thread.id, 'dismissed'))
      return null
    }
    if (stored.created) notifyNew(settings, stored.thread)
    if (!origin.sessionTitle) fillTitleLater(terminalId)
    return { deny: denyReason(stored.thread) }
  }

  orca.hooks.on('agent.tool.before', async (event) => {
    const call = event as ToolCall
    // Every tool call of every agent comes through here: leave all but ours before any I/O.
    if (!isCapturableTool(call.tool)) return undefined
    const deadline = { expired: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    // The whole decision races the budget, reads included, so Orca never times the hook out.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        deadline.expired = true
        resolve('timeout')
      }, HOOK_BUDGET_MS)
    })
    const result = await Promise.race([handleToolCall(call, deadline), timeout]).catch(() => null)
    clearTimeout(timer)
    if (result === 'timeout') {
      orca.log(`could not queue ${call.tool} from ${call.terminalId} in time; let it through`)
      return undefined
    }
    return result ?? undefined
  })

  orca.events.on('agent.status.changed', (event) => {
    const terminalId = event.terminalId
    if (!terminalId) return
    if (event.title) titles.set(terminalId, event.title)
    // Returned so Orca (and tests) can wait for the write to land.
    return serially(async () => {
      // Tracked whatever the settings say: replies must never press Enter on a prompt.
      const blocked = await loadBlocked()
      const nextBlocked = trackBlocked(blocked, terminalId, event.state)
      if (nextBlocked.join() !== blocked.join()) await orca.storage.set(BLOCKED, nextBlocked)

      let threads = await loadThreads()
      let changed = false
      const retitled = event.title ? retitleThreads(threads, terminalId, event.title) : null
      if (retitled) [threads, changed] = [retitled, true]
      // Any state but blocked means the prompt is gone (answered, refused or cancelled).
      if (event.state !== 'blocked' && hasOpenAttention(threads, terminalId)) {
        ;[threads, changed] = [resolveAttention(threads, terminalId, Date.now()), true]
      }
      if (changed) await saveThreads(threads)
      if (event.state !== 'blocked' || hasOpenAttention(threads, terminalId)) return
      const settings = await loadSettings()
      if (!settings.trackBlocked) return
      const origin: Origin = {
        agent: 'agent',
        terminalId,
        workspaceId: event.workspaceId,
        sessionTitle: event.title ?? null
      }
      const { thread, created } = await openThread(origin, { kind: 'attention', title: event.title ?? null })
      if (created) notifyNew(settings, thread)
    })
  })

  orca.panels.handle('inbox.list', async () => (await loadThreads()).map(summarize))

  orca.panels.handle('inbox.get', async ({ id }) => (await loadThreads()).find((thread) => thread.id === id) ?? null)

  /**
   * Replies in three steps so storage never lags what the agent was told: mark the thread
   * answered (and store a plan approval) first, type the reply outside the queue so a slow
   * terminal never holds up the hook, and undo both if the terminal refuses it.
   */
  orca.panels.handle('inbox.respond', async ({ id, response }) => {
    const prepared = await serially(async () => {
      const threads = await loadThreads()
      const thread = threads.find((item) => item.id === id)
      if (!thread) return { ok: false, reason: 'not_found' } as const
      if (thread.status.state !== 'open') return { ok: false, reason: 'not_open' } as const
      const reply = formatReply(thread, response)
      if (!reply) return { ok: false, reason: 'mismatch' } as const
      if ((await loadBlocked()).includes(thread.origin.terminalId)) return { ok: false, reason: 'agent_blocked' } as const
      const approving = response.kind === 'plan' && response.decision === 'approve'
      if (approving) {
        await orca.storage.set(APPROVED_PLANS, approve(await loadApprovals(), thread.origin.terminalId, Date.now()))
      }
      await saveThreads(replaceThread(threads, { ...thread, status: { state: 'answered', at: Date.now(), reply } }))
      return { ok: true, thread, reply, approving } as const
    })
    if (!prepared.ok) return prepared
    const { thread, reply, approving } = prepared
    const accepted = await orca.host
      .call('terminal.sendText', { terminalId: thread.origin.terminalId, text: reply, enter: true })
      .then((answer) => answer.accepted)
      .catch(() => false)
    if (accepted) return { ok: true }
    await serially(async () => {
      const threads = await loadThreads()
      const current = threads.find((item) => item.id === id)
      if (current?.status.state === 'answered') await saveThreads(replaceThread(threads, { ...current, status: { state: 'open' } }))
      if (approving) await orca.storage.set(APPROVED_PLANS, consumeApproval(await loadApprovals(), thread.origin.terminalId))
    })
    return { ok: false, reason: 'not_delivered' }
  })

  orca.panels.handle('inbox.focus', async ({ id }) => {
    const thread = (await loadThreads()).find((item) => item.id === id)
    if (!thread) return { ok: false }
    const { workspaceId, terminalId } = thread.origin
    const opened = workspaceId
      ? await orca.host
          .call('workspace.open', { workspaceId })
          .then(() => true)
          .catch(() => false)
      : false
    const switched = await switchToTerminal(terminalId)
    return { ok: opened || switched }
  })

  orca.panels.handle('inbox.dismiss', ({ id }) => serially(() => closeThread(id, 'dismissed')))

  // The status bar forgets its text when Orca restarts; storage does not. Open threads also pick
  // up titles their agents got while this worker was not running (focused workspace only).
  void serially(async () => {
    let threads = await loadThreads()
    let changed = false
    const { agents } = await orca.host.call('agents.list', {}).catch(() => ({ agents: [] }))
    for (const agent of agents) {
      const retitled = agent.terminalId && agent.title ? retitleThreads(threads, agent.terminalId, agent.title) : null
      if (retitled) [threads, changed] = [retitled, true]
    }
    if (changed) await saveThreads(threads)
    else showCount(threads)
  }).catch(() => undefined)
}
