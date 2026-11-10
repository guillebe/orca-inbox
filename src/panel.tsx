// The Inbox panel: a list of threads and, once one is picked, the thread with its reply form.
// The worker owns the data; this panel only asks for it and re-asks when the worker posts.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Code,
  EmptyState,
  Input,
  Link,
  Heading,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Separator,
  Row,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import {
  agentStateLabel,
  allAnswered,
  groupByWorkspace,
  markdownChunks,
  type Question,
  type Response,
  type Thread,
  type ThreadSummary
} from './model'
import type { RespondResult } from './protocol'

const summaries = atom<ThreadSummary[] | null>(null)
const view = atom('view', 'open', { persist: 'plugin' })
const selectedId = atom<string | null>(null)
const selected = atom<Thread | null>(null)
/** Chosen option labels per question index. */
const picks = atom<string[][]>([])
/** Text typed in each question's "Other" field, by question index. */
const others = atom<string[]>([])
/** Whether the open thread's agent terminal still exists; null until known or when unknowable. */
const sessionAlive = atom<boolean | null>(null)
const draft = atom('')
const failure = atom<string | null>(null)
const sending = atom(false)

/** A question or plan is only `resolved` when the person answered it in the agent's terminal. */
function stateLabel(kind: ThreadSummary['kind'], state: ThreadSummary['state']): string {
  return state === 'resolved' && kind !== 'attention' ? 'answered in terminal' : state
}

const KIND_ICON = { question: 'lightbulb', plan: 'file-text', attention: 'warning' } as const

const FAILURE_TEXT: Record<Exclude<RespondResult, { ok: true }>['reason'], string> = {
  not_found: 'This thread no longer exists.',
  not_open: 'This thread was already closed.',
  mismatch: 'Pick an answer or write something first.',
  agent_blocked: 'The agent is waiting on a prompt in its terminal. Answer that first, then send.',
  not_delivered: 'The agent’s terminal did not take the reply. Is it still open?'
}

async function refresh(): Promise<void> {
  set(summaries, await plugin.request('inbox.list'))
  const id = read(selectedId)
  if (!id) return
  const thread = await plugin.request('inbox.get', { id })
  if (read(selectedId) === id) set(selected, thread)
}

async function openThread(id: string): Promise<void> {
  set(selectedId, id)
  set(selected, null)
  set(picks, [])
  set(others, [])
  set(sessionAlive, null)
  set(draft, '')
  set(failure, null)
  const thread = await plugin.request('inbox.get', { id })
  // A slower answer for a thread the person already left must not replace the one now open.
  if (read(selectedId) !== id) return
  set(selected, thread)
  if (thread?.status.state !== 'open') return
  const { alive } = await plugin.request('inbox.alive', { id })
  if (read(selectedId) === id) set(sessionAlive, alive)
}

async function clearClosed(): Promise<void> {
  await plugin.request('inbox.clearClosed')
  await refresh()
}

function typeOther(index: number, value: string): void {
  update(others, (previous) => {
    const next = [...previous]
    next[index] = value
    return next
  })
}

function back(): void {
  set(selectedId, null)
  set(selected, null)
}

async function respond(response: Response): Promise<void> {
  const thread = read(selected)
  if (!thread || read(sending)) return
  set(sending, true)
  try {
    const result = await plugin.request('inbox.respond', { id: thread.id, response })
    set(failure, result.ok ? null : FAILURE_TEXT[result.reason])
    if (result.ok) back()
  } finally {
    set(sending, false)
  }
  await refresh()
}

async function focusSession(): Promise<void> {
  const thread = read(selected)
  if (!thread) return
  const { ok } = await plugin.request('inbox.focus', { id: thread.id })
  set(failure, ok ? null : 'Could not open that session. Its workspace or terminal may be closed.')
}

async function dismiss(): Promise<void> {
  const thread = read(selected)
  if (!thread) return
  await plugin.request('inbox.dismiss', { id: thread.id })
  back()
  await refresh()
}

function choose(index: number, label: string, multi: boolean, on: boolean): void {
  update(picks, (previous) => {
    const next = [...previous]
    const current = next[index] ?? []
    if (multi) next[index] = on ? [...current, label] : current.filter((item) => item !== label)
    else next[index] = on ? [label] : []
    return next
  })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('inbox.changed', () => void refresh()))
  void refresh()
}

function QuestionField({ question, index }: { question: Question; index: number }) {
  const chosen = read(picks)[index] ?? []
  // Checkboxes for both kinds: Orca's radio options cannot show a description. A single-choice
  // question keeps one pick, as a radio would.
  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Row gap="xs">
          {question.header ? <Badge tone="accent">{question.header}</Badge> : null}
          <Text size="xs" muted>
            {question.multiSelect ? 'Pick any' : 'Pick one'}
          </Text>
        </Row>
        <Text weight="medium">{question.question}</Text>
      </Stack>
      <Stack gap="xs">
        {question.options.map((option) => (
          <Checkbox
            label={option.label}
            description={option.description}
            checked={chosen.includes(option.label)}
            onChange={(on) => choose(index, option.label, question.multiSelect, on)}
          />
        ))}
      </Stack>
      <Input
        label={question.multiSelect ? 'Other (added to your picks)' : 'Other (replaces your pick)'}
        placeholder="Type your own answer"
        value={read(others)[index] ?? ''}
        onChange={(value) => typeOther(index, value)}
      />
    </Stack>
  )
}

function OpenActions({ thread }: { thread: Thread }) {
  // A closed session can no longer take a reply; sending would only fail.
  const busy = read(sending) || read(sessionAlive) === false
  const text = read(draft)
  if (thread.body.kind === 'question') {
    return (
      <Stack gap="sm">
        <Separator />
        <Textarea label="Note for the agent (optional)" value={text} rows={2} onChange={(value) => set(draft, value)} />
        <Row gap="xs">
          <Button
            icon="next"
            disabled={busy || !allAnswered(thread.body.questions, read(picks), read(others))}
            onPress={() => respond({ kind: 'answers', picks: read(picks), others: read(others), note: read(draft) })}
          >
            Send
          </Button>
          <Button variant="ghost" onPress={dismiss}>Dismiss</Button>
        </Row>
      </Stack>
    )
  }
  if (thread.body.kind === 'plan') {
    return (
      <Stack gap="sm">
        <Separator />
        <Textarea label="Feedback" value={text} rows={3} onChange={(value) => set(draft, value)} />
        <Row gap="xs" wrap>
          <Button icon="check" tone="success" disabled={busy} onPress={() => respond({ kind: 'plan', decision: 'approve', feedback: read(draft) })}>
            Approve
          </Button>
          <Button variant="outline" disabled={busy || text.trim() === ''} onPress={() => respond({ kind: 'plan', decision: 'revise', feedback: read(draft) })}>
            Request changes
          </Button>
          <Button variant="ghost" onPress={dismiss}>Dismiss</Button>
        </Row>
      </Stack>
    )
  }
  return (
    <Row gap="xs">
      <Button variant="ghost" onPress={dismiss}>Dismiss</Button>
    </Row>
  )
}

function ThreadView({ thread }: { thread: Thread }) {
  const error = read(failure)
  const { body, status } = thread
  // The worker already worded the origin for the list; reuse it rather than duplicate the rule.
  const summary = read(summaries)?.find((item) => item.id === thread.id)
  const source = summary?.source
  const agentState = agentStateLabel(summary?.agentState ?? null)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Link onPress={back}>← Inbox</Link>
        <Text muted size="xs">
          <RelativeTime at={thread.createdAt} />
        </Text>
      </Row>
      {source ? (
        <Stack gap="xs">
          <Text size="sm">{source}</Text>
          <Row justify="between" wrap>
            <Row gap="xs">
              <Badge>{thread.origin.agent}</Badge>
              {agentState ? <Badge tone={summary?.agentState === 'blocked' ? 'warning' : 'neutral'}>{agentState}</Badge> : null}
            </Row>
            <Button variant="outline" size="sm" icon="terminal" onPress={focusSession}>
              Go to session
            </Button>
          </Row>
        </Stack>
      ) : null}
      <Separator />
      {body.kind === 'question' ? (
        <Stack gap="lg">
          {body.questions.map((question, index) => QuestionField({ question, index }))}
        </Stack>
      ) : null}
      {body.kind === 'plan' ? (
        <Box border radius="md" padding="sm">
          <Stack gap="sm">
            {markdownChunks(body.plan).map((chunk) => (
              <Markdown content={chunk} />
            ))}
          </Stack>
        </Box>
      ) : null}
      {body.kind === 'attention' ? (
        <Callout tone="warning" title="Waiting for you in its terminal">
          <Text>
            {body.title ?? 'An agent'} is blocked, for example on a permission prompt. Answer it in its terminal; this
            thread closes when the agent works again.
          </Text>
        </Callout>
      ) : null}
      {status.state === 'open' && read(sessionAlive) === false ? (
        <Callout tone="warning" title="This session is closed">
          <Text>Its terminal no longer exists, so the agent cannot get an answer. Dismiss the thread.</Text>
        </Callout>
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {status.state === 'open' ? OpenActions({ thread }) : null}
      {status.state === 'answered' ? (
        <Stack gap="xs">
          <Text muted size="xs">Sent to the agent</Text>
          <Code block>{status.reply}</Code>
        </Stack>
      ) : null}
      {status.state === 'resolved' || status.state === 'dismissed' ? <Badge>{stateLabel(body.kind, status.state)}</Badge> : null}
    </Stack>
  )
}

function describe(item: ThreadSummary): string {
  if (item.state !== 'open') return `${item.source} · ${stateLabel(item.kind, item.state)}`
  const agent = agentStateLabel(item.agentState)
  return agent ? `${item.source} · ${agent}` : item.source
}

function ThreadItems({ items, label }: { items: ThreadSummary[]; label: string }) {
  return (
    <List label={label}>
      {items.map((item) => (
        <ListItem
          icon={KIND_ICON[item.kind]}
          title={item.title}
          description={describe(item)}
          onPress={() => openThread(item.id)}
        />
      ))}
    </List>
  )
}

function ThreadList({ items }: { items: ThreadSummary[] }) {
  if (items.length === 0) {
    return read(view) === 'open' ? (
      <EmptyState icon="check" title="Nothing waiting" description="Questions and plans from Claude Code agents land here." />
    ) : (
      <EmptyState icon="info" title="No closed threads yet" />
    )
  }
  const groups = groupByWorkspace(items)
  // One workspace needs no headings; several get one each, so parallel work reads apart.
  if (groups.length < 2) return ThreadItems({ items, label: 'Threads' })
  return (
    <Stack gap="md">
      {groups.map((group) => (
        <Stack gap="xs">
          <Text size="xs" weight="semibold" muted>
            {group.workspace}
          </Text>
          {ThreadItems({ items: group.items, label: group.workspace })}
        </Stack>
      ))}
    </Stack>
  )
}

export default function Panel() {
  const thread = read(selected)
  if (read(selectedId) && thread) return ThreadView({ thread })
  const all = read(summaries)
  const open = all?.filter((item) => item.state === 'open') ?? []
  const closed = all?.filter((item) => item.state !== 'open') ?? []
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Inbox</Heading>
        {open.length > 0 ? <Badge tone="accent">{open.length}</Badge> : null}
      </Row>
      <Tabs label="Threads" value={read(view)} onChange={(value) => set(view, value)}>
        <Tab value="open" label="Open">
          {ThreadList({ items: open })}
        </Tab>
        <Tab value="closed" label="Closed">
          <Stack gap="sm">
            {closed.length > 0 ? (
              <Row justify="end">
                <Button variant="ghost" size="sm" icon="delete" onPress={clearClosed}>
                  Clear closed
                </Button>
              </Row>
            ) : null}
            {ThreadList({ items: closed })}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
