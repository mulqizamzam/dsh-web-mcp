/**
 * Verifies the provider against the subagent seam's hard contracts: result
 * settles rather than rejects, dispose is idempotent and reaches quiescence,
 * cancellation is honored before and after publication, and the task times out
 * instead of hanging the parent forever.
 *
 * Run: node verify-provider.mjs
 */

const cordisEntry = process.env.DSH_CORDIS_ENTRY
if (!cordisEntry) {
  throw new Error('Set DSH_CORDIS_ENTRY to the installed DSH Cordis module entry before running this provider verification.')
}
const { Context } = await import(cordisEntry)
const plugin = await import('./index.js')

let registered
const subagentsStub = {
  name: 'subagentsStub',
  apply(ctx) {
    return ctx.provide('subagents', {
      registerProvider(provider) {
        registered = provider
        return () => { registered = undefined }
      },
    })
  },
}

const registeredTools = new Map()
const toolsStub = {
  name: 'toolsStub',
  apply(ctx) {
    return ctx.provide('tools', {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => { registeredTools.delete(definition.name) }
      },
    })
  },
}

let failures = 0
/**
 * Assert one condition and record the outcome.
 * @param label - what is being checked.
 * @param condition - the assertion result.
 * @param detail - extra context printed on failure.
 */
function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); return }
  failures += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Build a start request.
 * @param text - the task prompt text.
 * @param signal - the caller's cancellation signal.
 * @returns a request shaped like ResolvedSubagentStartRequest.
 */
function startRequest(text, signal) {
  return {
    label: 'probe',
    prompt: [{ type: 'text', text }],
    parent: { session: { header: { cwd: 'G:/dsh-plugins' } } },
    signal: signal ?? new AbortController().signal,
    descriptor: {},
  }
}

const ctx = new Context()
await ctx.plugin(subagentsStub)
await ctx.plugin(toolsStub)
await ctx.plugin(plugin, { taskTimeoutMs: 1_000, claimWaitMs: 500 })
for (let i = 0; i < 50 && registered === undefined; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
if (registered === undefined) throw new Error('provider was not registered')

const bridge = ctx.get('deepseekWebTasks')

console.log('[registration]')
check('provider name', registered.name === 'deepseek-web')
check('advertises no start capabilities', Object.values(registered.capabilities).every((v) => v === false))
check('does not inherit parent context', registered.inheritsParentContext === false)
check('has no prepareContinuable', registered.prepareContinuable === undefined)
check('bridge is published', bridge !== undefined)

console.log('\n[config validation]')
for (const [label, cfg, expected] of [
  ['empty providerName refused', { providerName: '' }, '`providerName` must be'],
  ['zero timeout refused', { taskTimeoutMs: 0 }, '`taskTimeoutMs` must be'],
  ['NaN timeout refused', { taskTimeoutMs: Number.NaN }, '`taskTimeoutMs` must be'],
  ['zero claimWaitMs refused', { claimWaitMs: 0 }, '`claimWaitMs` must be'],
]) {
  const probe = new Context()
  await probe.plugin(subagentsStub)
  await probe.plugin(toolsStub)
  try {
    await probe.plugin(plugin, cfg)
    check(label, false, 'did not throw')
  } catch (error) {
    check(label, String(error.message).includes(expected), error.message)
  }
  await probe.stop?.()
}

console.log('\n[prompt validation]')
try {
  await registered.start(startRequest('   '))
  check('blank prompt refused', false, 'did not throw')
} catch (error) { check('blank prompt refused', String(error.message).includes('must not be empty')) }
try {
  await registered.start({ ...startRequest('x'), prompt: [{ type: 'image', attachment: {} }] })
  check('non-text block refused', false, 'did not throw')
} catch (error) { check('non-text block refused', String(error.message).includes('only text blocks')) }

console.log('\n[happy path]')
const run = await registered.start(startRequest('summarize the repo'))
check('start fulfills with a run handle', typeof run?.id === 'string' && run.id.startsWith('session-'))
check('no local agent for a remote run', run.localAgent === undefined)
const claimed = bridge.claim()
check('task is claimable', claimed?.prompt === 'summarize the repo', JSON.stringify(claimed))
check('task carries the parent cwd', claimed?.cwd === 'G:/dsh-plugins')
check('claimed task is not offered twice', bridge.claim() === undefined)
bridge.settle(claimed.id, { text: 'done: 3 packages', stopReason: 'completed' })
const settled = await run.result
check('result resolves with the text', settled.output?.[0]?.text === 'done: 3 packages', JSON.stringify(settled))
check('result carries the stop reason', settled.stopReason === 'completed')

console.log('\n[failure never rejects]')
const failing = await registered.start(startRequest('will fail'))
const failingTask = bridge.claim()
bridge.settle(failingTask.id, { text: 'the tab was closed', stopReason: 'error' })
const failed = await failing.result
check('child failure resolves rather than rejects', failed.stopReason === 'error')
check('failure keeps its text', failed.output?.[0]?.text === 'the tab was closed')

const bogus = await registered.start(startRequest('bogus reason'))
const bogusTask = bridge.claim()
bridge.settle(bogusTask.id, { text: 'x', stopReason: 'not-a-real-reason' })
check('unknown stop reason falls back to error', (await bogus.result).stopReason === 'error')

console.log('\n[cancellation]')
const preAborted = new AbortController()
preAborted.abort(new Error('caller went away'))
try {
  await registered.start(startRequest('never queued', preAborted.signal))
  check('pre-publication abort rejects', false, 'did not throw')
} catch (error) { check('pre-publication abort rejects', String(error.message).includes('caller went away')) }

const midController = new AbortController()
const midRun = await registered.start(startRequest('cancel me', midController.signal))
bridge.claim()
midController.abort(new Error('parent cancelled'))
const midResult = await midRun.result
check('post-publication abort settles as aborted', midResult.stopReason === 'aborted', JSON.stringify(midResult))
check('aborted run carries no output', midResult.output.length === 0)

console.log('\n[dispose]')
const disposeRun = await registered.start(startRequest('dispose me'))
bridge.claim()
const first = disposeRun.dispose()
const second = disposeRun.dispose()
check('dispose is idempotent', first === second)
await first
check('dispose settles the result', (await disposeRun.result).stopReason === 'aborted')

const lateRun = await registered.start(startRequest('late reply'))
const lateTask = bridge.claim()
await lateRun.dispose()
check('late settlement cannot overwrite', bridge.settle(lateTask.id, { text: 'too late', stopReason: 'completed' }) === false)
check('result keeps the abort', (await lateRun.result).stopReason === 'aborted')

console.log('\n[timeout]')
const slow = await registered.start(startRequest('never answered'))
bridge.claim()
const slowStart = Date.now()
const slowResult = await slow.result
const elapsed = Date.now() - slowStart
check('times out instead of hanging', slowResult.stopReason === 'error', JSON.stringify(slowResult))
check('timeout text names the bound', String(slowResult.output?.[0]?.text ?? '').includes('1000ms'))
check('timeout fires near the bound', elapsed < 4_000, `${String(elapsed)}ms`)
// A timed-out task must leave the queue: still claimable, a delegate would run
// work whose result the parent already stopped waiting for.
check('timeout removes the task from the queue', bridge.claim() === undefined, JSON.stringify(bridge.list()))

console.log('\n[bridge tools]')
check('claim/settle/list registered', ['web_task_claim', 'web_task_settle', 'web_task_list'].every((n) => registeredTools.has(n)), [...registeredTools.keys()].join(','))

const claimTool = registeredTools.get('web_task_claim')
const settleTool = registeredTools.get('web_task_settle')
const listTool = registeredTools.get('web_task_list')

check('empty queue lists nothing', (await listTool.execute({}, {})) === 'No queued tasks.')

// A claim issued before any task exists must be woken by the submission, which
// is what makes delegation prompt rather than poll-driven.
const waitingClaim = claimTool.execute({}, { signal: new AbortController().signal })
const woken = await registered.start(startRequest('woken task'))
const claimedText = await waitingClaim
check('held claim is woken by a new task', claimedText.includes('woken task'), claimedText.slice(0, 120))
const wokenId = /task-[0-9a-f-]+/.exec(claimedText)?.[0]
check('claim reports the task id', wokenId !== undefined)

const settleMsg = await settleTool.execute({ taskId: wokenId, text: 'answered', stopReason: 'completed' }, {})
check('settle confirms', settleMsg.includes(wokenId))
check('settle reaches the parent', (await woken.result).output?.[0]?.text === 'answered')
// With the queue empty, a repeat report has nothing to be re-routed to and is
// reported as such rather than silently accepted.
check('repeat settle on an empty queue explains itself', (await settleTool.execute({ taskId: wokenId, text: 'again' }, {})).includes('web_task_claim'))

console.log('\n[format guidance]')
// The call format travels in the tool results because that is where the model
// reads it: a wrapper form is dropped silently by browser-side clients, so a
// stalled task is the only symptom.
const guidedRun = await registered.start(startRequest('needs guidance'))
const guidedText = await claimTool.execute({}, { signal: new AbortController().signal })
const guidedId = /task-[0-9a-f-]+/.exec(guidedText)?.[0]
check('claim shows the settle call verbatim', guidedText.includes(`<web_task_settle>{"taskId": "${guidedId}"`), guidedText.slice(-260))
check('claim names the wrapper forms to avoid', guidedText.includes('<invoke>') && guidedText.includes('code fence'))
check('claim delimits the task text', guidedText.includes('--- task ---') && guidedText.includes('--- end task ---'))

console.log('\n[settle recovery]')
// A delegate that omits or mistypes the id would otherwise hang the parent to
// its full timeout while believing it reported.
const noIdMsg = await settleTool.execute({ text: 'no id supplied' }, {})
check('missing id resolves to the one task in flight', noIdMsg.includes(guidedId), noIdMsg.slice(0, 160))
check('recovered settle reaches the parent', (await guidedRun.result).output?.[0]?.text === 'no id supplied')

const staleRun = await registered.start(startRequest('stale id'))
await claimTool.execute({}, { signal: new AbortController().signal })
const staleMsg = await settleTool.execute({ taskId: 'task-does-not-exist', text: 'wrong id' }, {})
check('unknown id falls back to the task in flight', !staleMsg.includes('does-not-exist'), staleMsg.slice(0, 160))
check('fallback still reaches the parent', (await staleRun.result).output?.[0]?.text === 'wrong id')

const idleMsg = await settleTool.execute({ text: 'nothing running' }, {})
check('settle with nothing queued explains itself', idleMsg.includes('web_task_claim'), idleMsg)

const ambA = await registered.start(startRequest('ambiguous a'))
const ambB = await registered.start(startRequest('ambiguous b'))
await claimTool.execute({}, { signal: new AbortController().signal })
await claimTool.execute({}, { signal: new AbortController().signal })
const ambMsg = await settleTool.execute({ text: 'which one?' }, {})
check('several in flight refuses rather than guesses', ambMsg.includes('Several tasks'), ambMsg.slice(0, 200))
await ambA.dispose()
await ambB.dispose()

console.log('\n[settle hands over the next task]')
// The claim-again hop is where a delegation loop most often ends, so settle
// carries the next task itself.
const firstRun = await registered.start(startRequest('first of two'))
await claimTool.execute({}, { signal: new AbortController().signal })
const secondRun = await registered.start(startRequest('second of two'))
const handover = await settleTool.execute({ text: 'first done' }, { signal: new AbortController().signal })
check('settle reports and hands over in one result', handover.includes('Reported') && handover.includes('second of two'), handover.slice(0, 220))
check('handover carries its own settle call', handover.includes('<web_task_settle>{"taskId"'))
check('first task settled', (await firstRun.result).output?.[0]?.text === 'first done')
await settleTool.execute({ text: 'second done' }, { signal: new AbortController().signal })
check('handed-over task settles too', (await secondRun.result).output?.[0]?.text === 'second done')

const lastMsg = await settleTool.execute({ text: 'x' }, {})
check('settle with an empty queue is not an error', lastMsg.includes('web_task_claim'), lastMsg)

console.log('\n[claim waiting]')
// These assert the wait path, so the queue must be empty first.
for (const task of bridge.list()) bridge.settle(task.id, { text: '', stopReason: 'aborted' })
const emptyClaim = await claimTool.execute({}, { signal: new AbortController().signal })
check('claim gives up after the wait', emptyClaim.startsWith('No task available.'), emptyClaim.slice(0, 80))

const abortedClaimController = new AbortController()
const abortedClaim = claimTool.execute({}, { signal: abortedClaimController.signal })
abortedClaimController.abort(new Error('caller left'))
check('cancelled claim resolves rather than hangs', (await abortedClaim).startsWith('No task available.'))

const listedRun = await registered.start(startRequest('for listing'))
check('list shows a queued task', (await listTool.execute({}, {})).includes('pending'))
await listedRun.dispose()

console.log('\n[release and disposal]')
const releasable = await registered.start(startRequest('release me'))
const releasedTask = bridge.claim()
bridge.release(releasedTask.id)
check('released task is offered again', bridge.claim()?.id === releasedTask.id)
await releasable.dispose()

const orphan = await registered.start(startRequest('orphan'))
bridge.dispose()
check('bridge disposal settles outstanding work', (await orphan.result).stopReason === 'aborted')

await ctx.stop?.()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
