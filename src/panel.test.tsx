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
      'inbox.respond': ({ response }) => {
        sent.push(response)
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.select({ label: 'Which DB?' }, 'SQLite')
  await view.press({ text: 'Send' })
  assert.deepEqual(sent, [{ kind: 'answers', picks: [['SQLite']], note: '' }])
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
      'inbox.respond': () => ({ ok: false, reason: 'not_delivered' })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.select({ label: 'Which DB?' }, 'Postgres')
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
      'inbox.get': () => thread
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, true)
  await view.select({ label: 'Which DB?' }, 'Postgres')
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, false)
  await view.unmount()
})

test('the back button returns to the list', async () => {
  const host = mockHost({
    requests: {
      'inbox.list': () => [{ id: 'q1', createdAt: 0, kind: 'question', title: 'Which DB?', source: 'DB work · acme/web-app', state: 'open' }],
      'inbox.get': () => thread
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: /Which DB\?/ })
  await view.press({ role: 'button', text: '← Inbox' })
  assert.ok(view.find({ text: 'Open' }))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
