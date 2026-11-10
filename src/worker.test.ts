// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Thread } from './model'
import * as main from './worker'

const question = {
  agent: 'claude',
  workspaceId: 'w1',
  terminalId: 't1',
  tool: 'AskUserQuestion',
  input: { questions: [{ question: 'Ship?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }] }
}
const plan = { ...question, tool: 'ExitPlanMode', input: { plan: '# Plan\n\n1. Do it' } }

const storedThreads = (host: ReturnType<typeof mockHost>): Thread[] =>
  (host.data().storage as { threads?: Thread[] }).threads ?? []

test('queues a question, refuses the call and dedupes a retry', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } } })
  const worker = await mountWorker(main, { host })
  const first = await worker.hooks.fire('agent.tool.before', question)
  assert.equal(first.kind, 'deny')
  if (first.kind === 'deny') assert.match(first.reason, /Do not call this tool again/)
  const retry = await worker.hooks.fire('agent.tool.before', question)
  assert.equal(retry.kind, 'deny')
  assert.equal(storedThreads(host).length, 1)
  assert.equal(host.callsOf('notifications.show').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('lets other agents and tools through untouched', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.hooks.fire('agent.tool.before', { ...question, agent: 'codex' })).kind, 'continue')
  assert.equal((await worker.hooks.fire('agent.tool.before', { ...question, tool: 'Bash', input: {} })).kind, 'continue')
  assert.equal(storedThreads(host).length, 0)
  await worker.deactivate()
})

test('an answer is typed into the agent terminal and closes the thread', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } } })
  const worker = await mountWorker(main, { host })
  await worker.hooks.fire('agent.tool.before', question)
  const [summary] = await worker.request('inbox.list')
  assert.equal(summary?.state, 'open')
  const result = await worker.request('inbox.respond', {
    id: summary?.id ?? '',
    response: { kind: 'answers', picks: [['Yes']], note: '' }
  })
  assert.deepEqual(result, { ok: true })
  const [sent] = host.callsOf('terminal.sendText')
  assert.equal((sent as { terminalId: string }).terminalId, 't1')
  assert.match((sent as { text: string }).text, /«Ship\?» → Yes/)
  assert.equal(storedThreads(host)[0]?.status.state, 'answered')
  await worker.deactivate()
})

test('an undelivered reply keeps the thread open', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: false } } })
  const worker = await mountWorker(main, { host })
  await worker.hooks.fire('agent.tool.before', question)
  const [summary] = await worker.request('inbox.list')
  const result = await worker.request('inbox.respond', {
    id: summary?.id ?? '',
    response: { kind: 'answers', picks: [['No']], note: '' }
  })
  assert.deepEqual(result, { ok: false, reason: 'not_delivered' })
  assert.equal(storedThreads(host)[0]?.status.state, 'open')
  await worker.deactivate()
})

test('an approved plan lets the next ExitPlanMode through once', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } } })
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'deny')
  const [summary] = await worker.request('inbox.list')
  await worker.request('inbox.respond', {
    id: summary?.id ?? '',
    response: { kind: 'plan', decision: 'approve', feedback: '' }
  })
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'continue')
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'deny')
  await worker.deactivate()
})

test('a blocked agent opens one attention thread that closes when it works again', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const event = { workspaceId: 'w1', paneKey: 'p', terminalId: 't9', title: 'Claude', receivedAt: 1 }
  await worker.emit('agent.status.changed', { ...event, state: 'blocked' })
  await worker.emit('agent.status.changed', { ...event, state: 'blocked' })
  assert.equal(storedThreads(host).length, 1)
  await worker.emit('agent.status.changed', { ...event, state: 'working' })
  assert.equal(storedThreads(host)[0]?.status.state, 'resolved')
  await worker.deactivate()
})

test('never types a reply while the agent sits on a prompt', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } }, settings: { trackBlocked: false } })
  const worker = await mountWorker(main, { host })
  await worker.hooks.fire('agent.tool.before', question)
  const [summary] = await worker.request('inbox.list')
  const respond = () =>
    worker.request('inbox.respond', { id: summary?.id ?? '', response: { kind: 'answers', picks: [['Yes']], note: '' } })
  const status = { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', receivedAt: 1 }
  await worker.emit('agent.status.changed', { ...status, state: 'blocked' })
  assert.deepEqual(await respond(), { ok: false, reason: 'agent_blocked' })
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  await worker.emit('agent.status.changed', { ...status, state: 'working' })
  assert.deepEqual(await respond(), { ok: true })
  await worker.deactivate()
})

test('a thread records the session title and workspace it came from', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', {
    workspaceId: 'r::/Users/me/code/acme/web-app',
    paneKey: 'p',
    terminalId: 't1',
    title: 'Migrate sessions',
    state: 'working',
    receivedAt: 1
  })
  await worker.hooks.fire('agent.tool.before', { ...question, workspaceId: 'r::/Users/me/code/acme/web-app' })
  const [summary] = await worker.request('inbox.list')
  assert.equal(summary?.source, 'Migrate sessions · acme/web-app')
  await worker.deactivate()
})

test('focus opens the workspace the thread came from', async () => {
  const host = mockHost({ results: { 'workspace.open': { opened: true } } })
  const worker = await mountWorker(main, { host })
  await worker.hooks.fire('agent.tool.before', question)
  const [summary] = await worker.request('inbox.list')
  assert.deepEqual(await worker.request('inbox.focus', { id: summary?.id ?? '' }), { ok: true })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'w1' }])
  assert.deepEqual(await worker.request('inbox.focus', { id: 'missing' }), { ok: false })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an attention thread closes once the prompt is gone, whatever the next state', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const event = { workspaceId: 'w1', paneKey: 'p', terminalId: 't5', title: 'Claude', receivedAt: 1 }
  await worker.emit('agent.status.changed', { ...event, state: 'blocked' })
  await worker.emit('agent.status.changed', { ...event, state: 'waiting' })
  assert.equal(storedThreads(host)[0]?.status.state, 'resolved')
  await worker.deactivate()
})

test('an undelivered plan approval is rolled back', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: false } } })
  const worker = await mountWorker(main, { host })
  await worker.hooks.fire('agent.tool.before', plan)
  const [summary] = await worker.request('inbox.list')
  const result = await worker.request('inbox.respond', {
    id: summary?.id ?? '',
    response: { kind: 'plan', decision: 'approve', feedback: '' }
  })
  assert.deepEqual(result, { ok: false, reason: 'not_delivered' })
  assert.equal(storedThreads(host)[0]?.status.state, 'open')
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'deny')
  await worker.deactivate()
})

test('tools the inbox never captures pass without touching storage', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.hooks.fire('agent.tool.before', { ...question, tool: 'Read', input: {} })).kind, 'continue')
  assert.deepEqual(host.data().storage, {})
  await worker.deactivate()
})

test('a question answered by typing in the terminal closes its thread', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const status = { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', receivedAt: 1 }
  await worker.hooks.fire('agent.tool.before', question)
  // Still finishing its turn after the deny: not an answer.
  await worker.emit('agent.status.changed', { ...status, state: 'working' })
  assert.equal(storedThreads(host)[0]?.status.state, 'open')
  await worker.emit('agent.status.changed', { ...status, state: 'waiting' })
  await worker.emit('agent.status.changed', { ...status, state: 'working' })
  assert.equal(storedThreads(host)[0]?.status.state, 'resolved')
  await worker.deactivate()
})

test('a plan reviewed in the terminal lets its next ExitPlanMode stay there', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const status = { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', receivedAt: 1 }
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'deny')
  await worker.emit('agent.status.changed', { ...status, state: 'waiting' })
  await worker.emit('agent.status.changed', { ...status, state: 'working' })
  assert.equal(storedThreads(host)[0]?.status.state, 'resolved')
  assert.equal((await worker.hooks.fire('agent.tool.before', plan)).kind, 'continue')
  await worker.deactivate()
})
