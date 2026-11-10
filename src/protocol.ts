// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Response, Thread, ThreadSummary } from './model'

export type RespondResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_open' | 'mismatch' | 'agent_blocked' | 'not_delivered' }

declare module 'orca' {
  interface PluginRequests {
    /** Every thread, newest first, without bodies. */
    'inbox.list': { output: ThreadSummary[] }
    /** One thread with its body; null when it is gone. */
    'inbox.get': { input: { id: string }; output: Thread | null }
    /** Types the reply into the agent's terminal and closes the thread. */
    'inbox.respond': { input: { id: string; response: Response }; output: RespondResult }
    /** Shows the agent's workspace and brings its terminal tab to the front. */
    'inbox.focus': { input: { id: string }; output: { ok: boolean } }
    /** Whether the thread's agent terminal still exists; null when Orca cannot tell. */
    'inbox.alive': { input: { id: string }; output: { alive: boolean | null } }
    /** Removes every closed thread; open ones stay. */
    'inbox.clearClosed': { output: { removed: number } }
    /** Closes a thread without telling the agent. */
    'inbox.dismiss': { input: { id: string }; output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after any thread changes. */
    'inbox.changed': { open: number }
  }
}
