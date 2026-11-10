import { assert, test } from 'orca/testing'
import {
  activeApprovalTerminals,
  cleanTitle,
  allAnswered,
  agentStateLabel,
  CLOSED_RETENTION_MS,
  groupByWorkspace,
  pruneClosed,
  questionAnswer,
  summarize,
  denyReason,
  clip,
  LIMITS,
  markdownChunks,
  retitleThreads,
  describeOrigin,
  workspaceLabel,
  addThread,
  approve,
  consumeApproval,
  PLAN_APPROVAL_TTL_MS,
  trackBlocked,
  classifyToolCall,
  findDuplicate,
  formatReply,
  MAX_THREADS,
  oneLine,
  parseQuestions,
  resolveAttention,
  threadTitle,
  type Thread,
  type ToolCall
} from './model'

const settings = { captureQuestions: true, capturePlans: true }
const questionInput = {
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }]
    }
  ]
}
const call = (overrides: Partial<ToolCall>): ToolCall => ({
  agent: 'claude',
  workspaceId: 'w1',
  terminalId: 't1',
  tool: 'AskUserQuestion',
  input: questionInput,
  ...overrides
})
const thread = (overrides: Partial<Thread>): Thread => ({
  id: 'abc',
  createdAt: 1_000,
  origin: { agent: 'claude', terminalId: 't1', workspaceId: 'w1' },
  body: { kind: 'question', questions: parseQuestions(questionInput) ?? [] },
  status: { state: 'open' },
  ...overrides
})

test('captures a Claude question with its options', () => {
  const decision = classifyToolCall(call({}), settings, [])
  assert.equal(decision.action, 'capture')
  if (decision.action !== 'capture' || decision.body.kind !== 'question') return
  assert.equal(decision.body.questions[0]?.options[0]?.description, 'relational')
  assert.equal(decision.origin.terminalId, 't1')
})

test('ignores other agents, calls without a terminal, other tools and unknown shapes', () => {
  assert.equal(classifyToolCall(call({ agent: 'codex' }), settings, []).action, 'ignore')
  assert.equal(classifyToolCall(call({ terminalId: undefined }), settings, []).action, 'ignore')
  assert.equal(classifyToolCall(call({ tool: 'Bash' }), settings, []).action, 'ignore')
  assert.equal(classifyToolCall(call({ input: { questions: 'nope' } }), settings, []).action, 'ignore')
  assert.equal(classifyToolCall(call({}), { ...settings, captureQuestions: false }, []).action, 'ignore')
})

test('captures a plan, then releases the next one once approved', () => {
  const plan = call({ tool: 'ExitPlanMode', input: { plan: '# Ship it\n\nSteps' } })
  assert.equal(classifyToolCall(plan, settings, []).action, 'capture')
  assert.deepEqual(classifyToolCall(plan, settings, ['t1']), { action: 'release-plan', terminalId: 't1' })
  assert.equal(classifyToolCall(plan, settings, ['t2']).action, 'capture')
})

test('formats answers on one line with every question and the note', () => {
  const reply = formatReply(thread({}), { kind: 'answers', picks: [['SQLite']], note: 'keep\nit small' })
  assert.equal(reply, '[Orca Inbox] Answers to thread abc: «Which database?» → SQLite | Note: keep / it small')
})

test('plan replies tell the agent what to do next', () => {
  const plan = thread({ body: { kind: 'plan', plan: '# P' } })
  assert.match(formatReply(plan, { kind: 'plan', decision: 'approve', feedback: '' }) ?? '', /Call ExitPlanMode again/)
  assert.match(formatReply(plan, { kind: 'plan', decision: 'revise', feedback: 'split step 2' }) ?? '', /split step 2/)
  assert.equal(formatReply(plan, { kind: 'answers', picks: [], note: '' }), null)
  assert.equal(formatReply(plan, { kind: 'text', text: '  \n ' }), null)
})

test('a retried call within a minute reuses the open thread', () => {
  const existing = thread({})
  assert.equal(findDuplicate([existing], existing.origin, existing.body, 30_000)?.id, 'abc')
  assert.equal(findDuplicate([existing], existing.origin, existing.body, 90_000), null)
  assert.equal(findDuplicate([existing], { ...existing.origin, terminalId: 't2' }, existing.body, 2_000), null)
})

test('the cap drops closed threads before open ones', () => {
  const closed = Array.from({ length: MAX_THREADS }, (_, index) =>
    thread({ id: `c${index}`, status: { state: 'dismissed', at: 0 } })
  )
  const next = addThread(closed, thread({ id: 'new' }))
  assert.equal(next.length, MAX_THREADS)
  assert.equal(next[0]?.id, 'new')
  assert.equal(next.at(-1)?.id, `c${MAX_THREADS - 2}`)
})

test('attention threads close when the agent works again', () => {
  const blocked = thread({ id: 'b', body: { kind: 'attention', title: 'Claude' } })
  const [after] = resolveAttention([blocked], 't1', 5)
  assert.deepEqual(after?.status, { state: 'resolved', at: 5 })
})

test('titles and one-line text', () => {
  assert.equal(threadTitle({ kind: 'plan', plan: '\n## Migrate auth\nbody' }), 'Migrate auth')
  assert.equal(threadTitle(thread({}).body), 'DB: Which database?')
  assert.equal(oneLine(' a \n\n b  c '), 'a / b c')
})

test('plan approvals expire and are consumed once', () => {
  const approvals = approve([], 't1', 0)
  assert.deepEqual(activeApprovalTerminals(approvals, 1_000), ['t1'])
  assert.deepEqual(activeApprovalTerminals(approvals, PLAN_APPROVAL_TTL_MS + 1), [])
  assert.deepEqual(consumeApproval(approvals, 't1'), [])
})

test('blocked terminals are tracked by status', () => {
  const blocked = trackBlocked([], 't1', 'blocked')
  assert.deepEqual(blocked, ['t1'])
  assert.deepEqual(trackBlocked(blocked, 't1', 'blocked'), ['t1'])
  assert.deepEqual(trackBlocked(blocked, 't1', 'working'), [])
})

test('describes where a thread came from', () => {
  const workspaceId = 'ac21::/Users/me/code/acme/web-app'
  assert.equal(workspaceLabel(workspaceId), 'acme/web-app')
  assert.equal(workspaceLabel('plain-id'), null)
  assert.equal(
    describeOrigin({ agent: 'claude', terminalId: 't', workspaceId, sessionTitle: 'Inbox test' }),
    'Inbox test · acme/web-app'
  )
  assert.equal(describeOrigin({ agent: 'claude', terminalId: 't', workspaceId: null }), 'Unknown session')
})

test('open threads take the task title once the agent names it', () => {
  const open = thread({ origin: { agent: 'claude', terminalId: 't1', workspaceId: null, sessionTitle: 'Claude Code' } })
  const closed = thread({ id: 'old', status: { state: 'dismissed', at: 0 } })
  const next = retitleThreads([open, closed], 't1', 'Dark mode plan')
  assert.equal(next?.[0]?.origin.sessionTitle, 'Dark mode plan')
  assert.equal(next?.[1]?.origin.sessionTitle, undefined)
  assert.equal(retitleThreads([open], 't1', 'Claude Code'), null)
  assert.equal(retitleThreads([open], 't2', 'Other'), null)
  assert.equal(describeOrigin(open.origin), 'Unknown session')
})

test('answers are only sent when every question has a pick', () => {
  const two = thread({
    body: {
      kind: 'question',
      questions: [
        { question: 'A?', multiSelect: false, options: [{ label: 'x' }] },
        { question: 'B?', multiSelect: true, options: [{ label: 'y' }] }
      ]
    }
  })
  assert.equal(formatReply(two, { kind: 'answers', picks: [['x']], note: '' }), null)
  assert.equal(formatReply(two, { kind: 'answers', picks: [['x'], []], note: '' }), null)
  assert.match(formatReply(two, { kind: 'answers', picks: [['x'], ['y']], note: '' }) ?? '', /«B\?» → y/)
})

test('long texts are clipped and long plans split, never dropped', () => {
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 4), 'abc')
  const questions = parseQuestions({ questions: [{ question: 'q'.repeat(1000), multiSelect: false, options: [{ label: 'l'.repeat(500) }] }] })
  assert.equal(questions?.[0]?.question.length, LIMITS.question)
  assert.equal(questions?.[0]?.options[0]?.label.length, LIMITS.label)
  const plan = Array.from({ length: 30 }, (_, index) => `${index} ${'x'.repeat(400)}`).join('\n\n')
  const chunks = markdownChunks(plan, 1000)
  assert.ok(chunks.every((chunk) => chunk.length <= 1000))
  assert.equal(chunks.join('\n\n'), plan)
  assert.ok(markdownChunks('y'.repeat(2500), 1000).every((chunk) => chunk.length <= 1000))
})

test('the deny reason asks the agent to restate the question in its terminal', () => {
  const reason = denyReason(thread({}))
  assert.match(reason, /repeats the question and numbers its options/)
  assert.match(reason, /typed directly in this terminal/)
})

test('Other text joins or replaces the picks', () => {
  const single = { question: 'Q?', multiSelect: false, options: [{ label: 'a' }] }
  const multi = { ...single, multiSelect: true }
  assert.equal(questionAnswer(single, ['a'], ''), 'a')
  assert.equal(questionAnswer(single, ['a'], 'mine'), '"mine"')
  assert.equal(questionAnswer(multi, ['a'], 'mine'), 'a, "mine"')
  assert.equal(questionAnswer(multi, [], '  '), null)
  assert.ok(allAnswered([single], [], ['typed']))
})

test('closed threads past the retention are dropped, open ones never', () => {
  const old = thread({ id: 'old', status: { state: 'dismissed', at: 0 } })
  const recent = thread({ id: 'recent', status: { state: 'dismissed', at: CLOSED_RETENTION_MS } })
  const open = thread({ id: 'open', createdAt: 0 })
  const kept = pruneClosed([old, recent, open], CLOSED_RETENTION_MS + 1).map((item) => item.id)
  assert.deepEqual(kept, ['recent', 'open'])
})

test('summaries group by workspace with unknown ones last', () => {
  const a = summarize(thread({ id: 'a', origin: { agent: 'claude', terminalId: 't', workspaceId: null } }))
  const b = summarize(thread({ id: 'b', origin: { agent: 'claude', terminalId: 't', workspaceId: 'r::/x/acme/api' } }))
  assert.deepEqual(
    groupByWorkspace([a, b]).map((group) => [group.workspace, group.items.map((item) => item.id)]),
    [['acme/api', ['b']], ['Other', ['a']]]
  )
  assert.equal(agentStateLabel('done'), 'agent waiting')
})

test('spinner glyphs never reach a title', () => {
  assert.equal(cleanTitle('◐ Pick a test runner'), 'Pick a test runner')
  assert.equal(cleanTitle('✳ Inbox test'), 'Inbox test')
  const open = thread({ origin: { agent: 'claude', terminalId: 't1', workspaceId: null, sessionTitle: 'Inbox test' } })
  assert.equal(retitleThreads([open], 't1', '◓ Inbox test'), null)
  assert.equal(describeOrigin({ agent: 'claude', terminalId: 't', workspaceId: null, sessionTitle: '◑ Runner' }), 'Runner')
})
