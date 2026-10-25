/**
 * The model-facing side of the bridge: the tools a delegate uses to take work
 * and report back.
 *
 * These are ordinary harness tools, so the browser side reaches them through
 * the MCP endpoint it already speaks — no separate transport, no extension
 * manifest change, and the same bearer token guards both directions.
 *
 * `web_task_claim` holds its response open until work arrives rather than
 * returning empty, so a delegate that calls it is woken the moment a task is
 * queued instead of polling on a timer.
 *
 * @module dsh-subagent-deepseek-web/tools
 */

/** Stop reasons a delegate may report, mirroring the seam's set. */
const REPORTABLE_STOP_REASONS = ['completed', 'error', 'refusal', 'max-tokens']

/**
 * Render the call format a delegate must use, with the task's own id filled in.
 *
 * The instruction travels in the claim *result* rather than only in a system
 * prompt because that is where it is read: the model writes its next call
 * immediately after this text, and a nearby concrete example survives a long
 * context far better than a distant rule. Browser-side clients parse
 * `<tool_name>{json}</tool_name>` and ignore wrapper forms such as
 * `<invoke name=…>` silently, so a model that improvises a wrapper produces a
 * turn with no tool call at all and the task stalls.
 * @param taskId - the claimed task's id.
 * @returns the formatted reminder block.
 */
function settleInstruction(taskId) {
  return [
    'When the work is done, report it with exactly this call — tag name is the tool name, body is JSON:',
    '',
    `<web_task_settle>{"taskId": "${taskId}", "text": "<your full result here>", "stopReason": "completed"}</web_task_settle>`,
    '',
    'If the work failed, send the same call with "stopReason": "error" and put the reason in text.',
    'Do not wrap the call in <invoke>, <tool_call>, <rwscript>, or a markdown code fence — those are ignored and the task will hang.',
  ].join('\n')
}

/**
 * Resolve which task a settle report belongs to.
 *
 * An exact id always wins. A missing or unknown id falls back to the one task
 * in flight, because that is unambiguous and the alternative — refusing — costs
 * the parent its full timeout and discards work that was actually done. With
 * several tasks running there is a real choice to make, so the report is
 * refused and the caller is told which ids are open.
 * @param bridge - the task bridge.
 * @param taskId - the id the delegate supplied, if any.
 * @returns `{ taskId }`, or `{ error }` explaining what to send instead.
 */
function resolveTaskId(bridge, taskId) {
  const queued = bridge.list()
  if (typeof taskId === 'string' && queued.some((task) => task.id === taskId)) {
    return { taskId }
  }
  const running = queued.filter((task) => task.status === 'running')
  const candidates = running.length > 0 ? running : queued
  if (candidates.length === 1) return { taskId: candidates[0].id }
  if (candidates.length === 0) {
    return { error: 'No task is waiting to be reported. Call web_task_claim to take one first.' }
  }
  const ids = candidates.map((task) => task.id).join(', ')
  return { error: `Several tasks are in flight (${ids}); repeat the call with the taskId this result belongs to.` }
}

/**
 * Register the claim/settle/list tools against a task bridge.
 * @param ctx - the injected context carrying `tools`.
 * @param bridge - the task bridge to serve.
 * @param waitMs - how long `web_task_claim` holds before reporting no work.
 */
export function registerBridgeTools(ctx, bridge, waitMs) {
  ctx.effect(() => ctx.tools.register({
    name: 'web_task_claim',
    description: [
      'Take the next task delegated to you and return its instructions.',
      'Waits for work when the queue is empty, so call it again after reporting a result to stay available.',
      'Returns "No task available." when nothing arrived in time — call it again to keep waiting.',
      'Report the outcome with web_task_settle when the work is done.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const claimed = await claimWithWait(bridge, waitMs, exec.signal)
      if (claimed === undefined) {
        return 'No task available. Call web_task_claim again to keep waiting: <web_task_claim>{}</web_task_claim>'
      }
      const lines = [`Task ${claimed.id}`]
      if (claimed.label !== undefined) lines.push(`Label: ${claimed.label}`)
      if (claimed.cwd !== undefined) lines.push(`Working directory: ${claimed.cwd}`)
      lines.push('', '--- task ---', claimed.prompt, '--- end task ---', '', settleInstruction(claimed.id))
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'web_task_settle',
    description: [
      'Report the outcome of a task taken with web_task_claim. The text becomes the delegating agent\'s result.',
      'Call it as <web_task_settle>{"taskId": "task-…", "text": "…", "stopReason": "completed"}</web_task_settle>.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task id reported by web_task_claim.' },
        text: { type: 'string', description: 'The result the delegating agent receives.' },
        stopReason: {
          type: 'string',
          enum: REPORTABLE_STOP_REASONS,
          description: 'How the task ended. Defaults to completed.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // A missing or stale id is recovered when it is unambiguous. The failure
      // it prevents is severe and one-sided: the parent hangs to its timeout
      // while the delegate believes it reported, and the work is lost. With one
      // task in flight there is nothing else the report could have meant.
      const resolved = resolveTaskId(bridge, args.taskId)
      if (resolved.error !== undefined) return resolved.error
      const accepted = bridge.settle(resolved.taskId, {
        text: args.text,
        stopReason: args.stopReason ?? 'completed',
      })
      // A rejected settle is reported rather than thrown: the task was already
      // cancelled or answered, which is information the delegate should see.
      const head = accepted
        ? `Reported ${resolved.taskId}.`
        : `Task ${resolved.taskId} was already settled or cancelled; the report was discarded.`

      // The next task is handed over in this same result rather than leaving the
      // delegate to call claim again. That extra hop is where a delegation loop
      // most often ends: having just reported success, a model reads the turn as
      // finished and stops. Folding the handover in removes the decision.
      const next = await claimWithWait(bridge, waitMs, exec?.signal ?? new AbortController().signal)
      if (next === undefined) {
        return `${head}\nNo further task yet. Stay available by calling <web_task_claim>{}</web_task_claim> again.`
      }
      const lines = [head, '', `Next task ${next.id}`]
      if (next.label !== undefined) lines.push(`Label: ${next.label}`)
      if (next.cwd !== undefined) lines.push(`Working directory: ${next.cwd}`)
      lines.push('', '--- task ---', next.prompt, '--- end task ---', '', settleInstruction(next.id))
      return lines.join('\n')
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'web_task_list',
    description: 'List tasks currently queued for browser delegates, with their status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const tasks = bridge.list()
      if (tasks.length === 0) return 'No queued tasks.'
      return tasks.map((t) => `${t.id}  ${t.status}  ${t.label ?? '(no label)'}`).join('\n')
    },
  }))
}

/**
 * Claim a task, waiting for one when the queue is empty.
 *
 * Every exit path removes the waiter and clears the timer, so an abandoned
 * claim leaves nothing behind on the bridge.
 * @param bridge - the task bridge.
 * @param waitMs - how long to wait before giving up.
 * @param signal - the tool call's cancellation signal.
 * @returns the claimed task, or undefined when none arrived.
 */
function claimWithWait(bridge, waitMs, signal) {
  const immediate = bridge.claim()
  if (immediate !== undefined) return Promise.resolve(immediate)
  if (signal.aborted) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      removeWaiter()
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => { finish(bridge.claim()) }, waitMs)
    const onAbort = () => { finish(undefined) }
    // Registered before the waiter so an already-queued wake cannot resolve
    // ahead of the abort wiring.
    signal.addEventListener('abort', onAbort, { once: true })
    const removeWaiter = bridge.waitForTask(() => {
      const claimed = bridge.claim()
      if (claimed !== undefined) finish(claimed)
    })
  })
}
