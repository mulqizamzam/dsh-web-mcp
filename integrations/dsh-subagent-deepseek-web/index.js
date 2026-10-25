/**
 * dsh-subagent-deepseek-web: delegates a subagent task to a DeepSeek web
 * conversation driven by a browser extension, instead of running the child
 * loop inside the harness.
 *
 * The point is cost placement. Subagent work — exploration, batch search,
 * parallel sub-tasks — is where token spend concentrates, while the parent loop
 * stays comparatively light. Routing that work to a browser session the user is
 * already signed into keeps it off the metered API, and the parent keeps its
 * own model.
 *
 * Structurally this is an out-of-process provider, the same shape as the
 * `codex` and `claude-code` backends: the AI lives elsewhere, the harness hands
 * over text and collects text. It advertises no start capabilities, does not
 * inherit parent context, and mints its own run id because there is no local
 * child session.
 *
 * @module dsh-subagent-deepseek-web
 */

import { randomUUID } from 'node:crypto'
import { TaskBridge } from './bridge.js'
import { registerBridgeTools } from './tools.js'

export const name = 'subagent-deepseek-web'

/**
 * No start-time capability is supported.
 *
 * The child is an external chat session: it has no dsh tool registry to filter,
 * no persona slot the harness controls, no structured-output mode, and no
 * delegation depth the harness can enforce. The service checks these before
 * calling `start()`, so a request asking for one is refused there rather than
 * silently ignored here.
 */
const NO_START_CAPABILITIES = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/** Defaults for every optional config field. */
const DEFAULTS = {
  providerName: 'deepseek-web',
  taskTimeoutMs: 900_000,
  claimWaitMs: 55_000,
}

/**
 * Validate and default the plugin config.
 * @param config - the raw config from the cordis patch.
 * @returns the resolved config.
 * @throws when a field is present but unusable.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const providerName = raw.providerName ?? DEFAULTS.providerName
  if (typeof providerName !== 'string' || providerName.length === 0) {
    throw new Error('dsh-subagent-deepseek-web: `providerName` must be a non-empty string.')
  }
  const taskTimeoutMs = raw.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs
  // The seam has no timeout of its own, so an unbounded task would hang the
  // parent's tool call for the life of the process.
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) {
    throw new Error('dsh-subagent-deepseek-web: `taskTimeoutMs` must be a positive finite number.')
  }
  const claimWaitMs = raw.claimWaitMs ?? DEFAULTS.claimWaitMs
  // Held-open claims must return before the caller's own request timeout, or
  // the delegate sees a transport error instead of "no task available".
  if (!Number.isFinite(claimWaitMs) || claimWaitMs <= 0) {
    throw new Error('dsh-subagent-deepseek-web: `claimWaitMs` must be a positive finite number.')
  }
  return { providerName, taskTimeoutMs, claimWaitMs }
}

/**
 * Flatten a prompt to the text the browser session receives.
 *
 * A DeepSeek web conversation takes text, so a non-text block cannot be
 * delivered. Refusing names the unsupported block instead of silently dropping
 * content the caller believed was sent.
 * @param prompt - the request's content blocks.
 * @returns the joined text.
 * @throws when a block is not text, or the whole prompt is blank.
 */
function textTask(prompt) {
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error(`subagent-deepseek-web: the task must contain only text blocks, got ${block.type}`)
    }
    texts.push(block.text)
  }
  const joined = texts.join('')
  if (joined.trim() === '') {
    throw new Error('subagent-deepseek-web: the task must not be empty')
  }
  return joined
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const bridge = new TaskBridge()

  // Published before the provider is registered so a consumer mounted in either
  // order reaches the same table.
  ctx.provide('deepseekWebTasks', bridge)

  // The delegate-facing tools are registered independently of the provider:
  // they serve the same bridge, but `tools` and `subagents` become available at
  // different times, and neither half needs the other to be useful.
  ctx.inject(['tools'], (toolCtx) => {
    registerBridgeTools(toolCtx, bridge, config.claimWaitMs)
  })

  ctx.inject(['subagents'], (scoped) => {
    const provider = {
      name: config.providerName,
      capabilities: NO_START_CAPABILITIES,
      // The child is a separate conversation with none of the parent's history.
      inheritsParentContext: false,

      /**
       * Queue the task and return a handle whose result settles when the
       * browser session reports back.
       *
       * `start()` fulfills once the task is queued rather than once the browser
       * accepts it: the bridge is the established resource, and a delivery
       * failure afterwards is reported through `result` as the seam intends.
       * @param request - the resolved start request.
       * @returns the run handle.
       */
      async start(request) {
        // Pre-publication cancellation: nothing has been queued yet, so this
        // rejects instead of settling a run the caller never received.
        if (request.signal.aborted) {
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new Error('subagent-deepseek-web: start was aborted')
        }
        const prompt = textTask(request.prompt)
        const { id, settled } = bridge.submit({
          prompt,
          label: request.label,
          cwd: request.parent?.session?.header?.cwd,
        })

        let timer
        const timedOut = new Promise((resolve) => {
          timer = setTimeout(() => {
            // Settled through the bridge, not raced past it: a task left in the
            // table after the parent stopped waiting would still be claimable,
            // and a delegate would run work whose result nobody receives.
            const text = `The delegated task exceeded ${String(config.taskTimeoutMs)}ms with no reply.`
            bridge.settle(id, { text, stopReason: 'error' })
            resolve({ output: [{ type: 'text', text }], stopReason: 'error' })
          }, config.taskTimeoutMs)
        })

        const onAbort = () => { bridge.settle(id, { text: '', stopReason: 'aborted' }) }
        request.signal.addEventListener('abort', onAbort, { once: true })

        const result = Promise.race([settled, timedOut]).finally(() => {
          clearTimeout(timer)
          request.signal.removeEventListener('abort', onAbort)
        })

        let disposed
        return {
          // Remote runs mint an id; there is no local child session to share one with.
          id: `session-${randomUUID()}`,
          localAgent: undefined,
          result,
          /**
           * Cancel the task and wait for the result to settle. Idempotent: the
           * first call memoizes the settlement every later call awaits.
           * @returns a promise resolving once the run is quiescent.
           */
          dispose() {
            disposed ??= (async () => {
              bridge.settle(id, { text: '', stopReason: 'aborted' })
              // Quiescence here is bridge-level: the harness owns no browser
              // process it could wait on, so a conversation already running in
              // the tab may finish on its own with nothing listening.
              await result.catch(() => undefined)
            })()
            return disposed
          },
        }
      },
    }

    scoped.effect(() => scoped.subagents.registerProvider(provider))
    scoped.effect(() => () => { bridge.dispose() })
    scoped.logger?.info?.(
      `dsh-subagent-deepseek-web: provider "${config.providerName}" registered, task timeout ${String(config.taskTimeoutMs)}ms`,
    )
  })
}
