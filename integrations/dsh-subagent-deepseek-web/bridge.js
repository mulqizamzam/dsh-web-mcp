/**
 * The bridge between dsh and the browser extension: a task table plus the two
 * directions of traffic over it.
 *
 * dsh hands a task in and receives a promise; the extension takes the task,
 * runs it in a DeepSeek web conversation, and hands back text. Because the
 * subagent seam requires `SubagentRun.result` to resolve rather than reject on
 * child-level failure, every terminal path here produces a result object, and
 * only a bridge fault rejects.
 *
 * @module dsh-subagent-deepseek-web/bridge
 */

import { randomUUID } from 'node:crypto'

/** Terminal states a task can settle into, mapped to seam stop reasons. */
const STOP_REASONS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

/**
 * A task table shared by the subagent provider and the delivery channel.
 *
 * Tasks are held by id rather than streamed to a single consumer: the extension
 * may reconnect, and a task outlives any one connection.
 */
export class TaskBridge {
  #tasks = new Map()
  #waiters = new Set()

  /**
   * Queue a task and return its id plus a promise that settles when the
   * extension reports an outcome.
   * @param spec - `{ prompt, label, cwd }` describing the work.
   * @returns `{ id, settled }` — the task id and its terminal-result promise.
   */
  submit(spec) {
    const id = `task-${randomUUID()}`
    const { promise, resolve } = Promise.withResolvers()
    const task = {
      id,
      prompt: spec.prompt,
      label: spec.label,
      cwd: spec.cwd,
      createdAt: Date.now(),
      status: 'pending',
      resolve,
    }
    this.#tasks.set(id, task)
    this.#notifyWaiters()
    return { id, settled: promise }
  }

  /**
   * Settle a task with a terminal outcome. Later settlements are ignored: the
   * first terminal report wins, so a late extension reply cannot overwrite a
   * cancellation the parent already observed.
   * @param id - the task id.
   * @param outcome - `{ text, stopReason }`.
   * @returns true when this call settled the task.
   */
  settle(id, outcome) {
    const task = this.#tasks.get(id)
    if (task === undefined || task.status === 'settled') return false
    task.status = 'settled'
    const stopReason = STOP_REASONS.has(outcome?.stopReason) ? outcome.stopReason : 'error'
    const text = typeof outcome?.text === 'string' ? outcome.text : ''
    task.resolve({
      output: text === '' ? [] : [{ type: 'text', text }],
      stopReason,
    })
    this.#tasks.delete(id)
    return true
  }

  /**
   * Hand out the oldest unclaimed task, marking it running.
   * @returns the claimed task's public fields, or undefined when none waits.
   */
  claim() {
    for (const task of this.#tasks.values()) {
      if (task.status !== 'pending') continue
      task.status = 'running'
      return { id: task.id, prompt: task.prompt, label: task.label, cwd: task.cwd }
    }
    return undefined
  }

  /**
   * Wait until a task is claimable or the wait is abandoned.
   *
   * This is what lets a consumer hold a request open instead of polling. The
   * returned disposer must be called on every path so an abandoned waiter does
   * not accumulate.
   * @param onAvailable - invoked once when a task may be claimable.
   * @returns the disposer removing the waiter.
   */
  waitForTask(onAvailable) {
    this.#waiters.add(onAvailable)
    return () => { this.#waiters.delete(onAvailable) }
  }

  /**
   * Report a queued task as unclaimable, returning it to the pending pool.
   *
   * Used when a claimant disappears without settling; the task is offered again
   * rather than lost with the connection that held it.
   * @param id - the task id.
   */
  release(id) {
    const task = this.#tasks.get(id)
    if (task === undefined || task.status !== 'running') return
    task.status = 'pending'
    this.#notifyWaiters()
  }

  /** Snapshot of queued tasks, for diagnostics. */
  list() {
    return [...this.#tasks.values()].map((task) => ({
      id: task.id,
      status: task.status,
      label: task.label,
      createdAt: task.createdAt,
    }))
  }

  /**
   * Settle every outstanding task as aborted and drop all waiters.
   *
   * Called on plugin disposal: a parent awaiting a result must not hang past
   * the lifetime of the bridge that would have delivered it.
   */
  dispose() {
    for (const id of [...this.#tasks.keys()]) {
      this.settle(id, { text: '', stopReason: 'aborted' })
    }
    this.#waiters.clear()
  }

  /** Wake every waiter; each removes itself through its own disposer. */
  #notifyWaiters() {
    for (const waiter of [...this.#waiters]) {
      waiter()
    }
  }
}
