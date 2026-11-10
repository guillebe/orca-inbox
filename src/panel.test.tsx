// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { Response, Thread } from './model'
import * as panel from './panel'

const thread: Thread = {
  id: 'q1',
  createdAt: 0,
  origin: { agent: 'claude', terminalId: 't1', workspaceId: 'w1' },
  body: {
    kind: 'question',
    questions: [{ question: 'Which DB?', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]
  },
  status: { state: 'open' }
}

test('lists open threads and sends the picked answer', async () => {
  const sent: Response[] = []
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
      'inbox.respond': ({ response }) => {
        sent.push(response)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.toggle({ label: 'SQLite' })
  await view.press({ text: 'Send' })
  assert.deepEqual(sent, [{ kind: 'answers', picks: [['SQLite']], others: [], note: '' }])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows why a reply was not delivered', async () => {
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
      'inbox.respond': () => ({ ok: false, reason: 'not_delivered' })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.toggle({ label: 'Postgres' })
  await view.press({ text: 'Send' })
  assert.ok(view.find({ text: /did not take the reply/ }))
  await view.unmount()
})

test('reviews a plan: approve sends the decision', async () => {
  const sent: Response[] = []
  const plan: Thread = { ...thread, id: 'p1', body: { kind: 'plan', plan: '# Plan\n\n1. Step' } }
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'p1', createdAt: 0, kind: 'plan', title: 'Plan', source: 'Plan work · acme/web-app', state: 'open' }],
      'inbox.get': () => plan,
      'inbox.alive': () => ({ alive: true }),
      'inbox.respond': ({ response }) => {
        sent.push(response)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /^Plan/ })
  assert.ok(view.find({ text: 'Plan work · acme/web-app' }))
  await view.type({ label: 'Feedback' }, 'looks good')
  await view.press({ text: 'Approve' })
  assert.deepEqual(sent, [{ kind: 'plan', decision: 'approve', feedback: 'looks good' }])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('go to session asks the worker to focus the thread', async () => {
  const focused: string[] = []
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
      'inbox.focus': ({ id }) => {
        focused.push(id)
        return { ok: false }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.press({ text: 'Go to session' })
  assert.deepEqual(focused, ['q1'])
  assert.ok(view.find({ text: /Could not open that session/ }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('send stays disabled until every question has an answer', async () => {
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, true)
  await view.toggle({ label: 'Postgres' })
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, false)
  await view.unmount()
})

test('the back button returns to the list', async () => {
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.press({ text: '← Inbox' })
  assert.ok(view.find({ text: 'Open' }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

const listed = (overrides: Record<string, unknown> = {}) => [
  { id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', workspace: 'acme/web-app', state: 'open', agentState: 'waiting', ...overrides }
]

test('a typed Other answer is enough to send', async () => {
  const sent: Response[] = []
  const host = mockHost({
    requests: {
      'inbox.list': () => listed(),
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
      'inbox.respond': ({ response }) => {
        sent.push(response)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.type({ label: 'Other (replaces your pick)' }, 'DynamoDB')
  await view.press({ text: 'Send' })
  assert.deepEqual(sent, [{ kind: 'answers', picks: [], others: ['DynamoDB'], note: '' }])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a closed session says so and blocks sending', async () => {
  const host = mockHost({
    requests: { 'inbox.list': () => listed(), 'inbox.get': () => thread, 'inbox.alive': () => ({ alive: false }) }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.toggle({ label: 'SQLite' })
  assert.ok(view.find({ text: /no longer exists/ }))
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, true)
  await view.unmount()
})

test('the list shows the agent state and groups several workspaces', async () => {
  const host = mockHost({
    requests: {
      'inbox.list': () => [
        ...listed(),
        { ...listed()[0], id: 'q2', title: 'Ship?', workspace: 'acme/api', source: 'Release · acme/api', agentState: 'working' }
      ]
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'acme/api' }))
  assert.ok(view.find({ text: /DB work · acme\/web-app · agent waiting/ }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('clear closed asks the worker to drop closed threads', async () => {
  let cleared = 0
  const host = mockHost({
    requests: {
      'inbox.list': () => (cleared ? [] : listed({ state: 'dismissed' })),
      'inbox.clearClosed': () => {
        cleared += 1
        return { removed: 1 }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.select({ label: 'Threads' }, 'closed')
  await view.press({ text: 'Clear closed' })
  assert.equal(cleared, 1)
  assert.ok(view.find({ text: 'No closed threads yet' }))
  await view.unmount()
})

test('a single-choice question keeps one pick', async () => {
  const sent: Response[] = []
  const host = mockHost({
    requests: {
      'inbox.list': () => listed(),
      'inbox.get': () => thread,
      'inbox.alive': () => ({ alive: true }),
      'inbox.respond': ({ response }) => {
        sent.push(response)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  assert.ok(view.find({ text: 'Pick one' }))
  await view.toggle({ label: 'Postgres' })
  await view.toggle({ label: 'SQLite' })
  await view.press({ text: 'Send' })
  assert.deepEqual(sent, [{ kind: 'answers', picks: [['SQLite']], others: [], note: '' }])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
