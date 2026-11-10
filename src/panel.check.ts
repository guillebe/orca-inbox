// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const origin = { agent: 'claude', terminalId: 't1', workspaceId: 'w1' }

export default defineCheck({
  empty: {},
  pending: {
    storage: {
      threads: [
        {
          id: 'q1',
          createdAt: 0,
          origin,
          body: {
            kind: 'question',
            questions: [
              {
                question: 'Which database should the cache use?',
                header: 'Cache',
                multiSelect: false,
                options: [{ label: 'Redis', description: 'already deployed' }, { label: 'Postgres' }]
              }
            ]
          },
          status: { state: 'open' }
        },
        {
          id: 'p1',
          createdAt: 0,
          origin,
          body: { kind: 'plan', plan: '# Move sessions to Redis\n\n1. Add client\n2. Dual write' },
          status: { state: 'open' }
        },
        {
          id: 'a1',
          createdAt: 0,
          origin: { ...origin, terminalId: 't2' },
          body: { kind: 'attention', title: 'Claude' },
          status: { state: 'answered', at: 0, reply: '[Orca Inbox] ok' }
        }
      ]
    }
  }
})
