import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"
import { readConfig } from "../../src/stage/config.mjs"
import { readState, writeState, STATE_VERSION } from "../../src/stage/state.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/stage")
function user(id, text, sessionID = "ses_scope", agent = "bug-fix-adaptive", synthetic = false) {
  return { info: { id, sessionID, role: "user", agent },
    parts: [{ type: "text", id: `prt_${id}`, messageID: id, sessionID, text, ...(synthetic ? { synthetic: true } : {}) }] }
}
function tool(id, callID, output = "tool-result", sessionID = "ses_scope", name = "read") {
  return { info: { id, sessionID, role: "assistant" }, parts: [{ type: "tool", id: `prt_${id}`,
    messageID: id, sessionID, tool: name, callID, state: { status: "completed", input: {}, output } }] }
}
function control(id, sessionID = "ses_scope", tailID = null, agent = "bug-fix-adaptive") {
  return { info: { id, role: "user", sessionID, agent }, parts: [{ type: "compaction", auto: true,
    ...(tailID ? { tail_start_id: tailID } : {}) }] }
}
function summary(id, parentID, text, sessionID = "ses_scope") {
  return { info: { id, parentID, sessionID, role: "assistant", agent: "compaction", mode: "compaction", summary: true, finish: "stop" },
    parts: [{ type: "text", text }] }
}
const visible = (messages) => JSON.stringify(messages)
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stage-only-compaction-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const oc = path.join(directory, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  const config = await readConfig(path.join(oc, "bugfix-adaptive-context.config.json"))
  const statePath = path.join(oc, "bugfix-adaptive-context.state.json")
  const history = []
  let reads = 0
  const client = { session: { messages: async ({ path: { id } }) => {
    reads++
    return { data: structuredClone(history.filter(message => message.info.sessionID === id)) }
  } } }
  let hooks = await BugfixAdaptiveContext({ directory, client })
  async function restart() { hooks = await BugfixAdaptiveContext({ directory, client }) }
  async function transform(messages) {
    const original = structuredClone(messages)
    const output = { messages: structuredClone(messages) }
    await hooks["experimental.chat.messages.transform"]({}, output)
    assert.deepEqual(messages, original, "Session input must remain unchanged")
    return output.messages
  }
  async function start(sessionID = "ses_scope") {
    const source = user("msg_0100", "修复当前缺陷 ORIGINAL_INPUT", sessionID)
    history.push(source)
    await transform([source])
    return source
  }
  async function stage(id, stageID, sessionID = "ses_scope") {
    const callID = `call_${id}`
    const registryPath = path.join(directory, "step-registry.yaml")
    await fs.copyFile(path.join(root, "../../test/stage/fixtures/step-registry.yaml"), registryPath)
    await hooks["tool.execute.before"]({ tool: config.stageControlTool, sessionID, callID }, { args: { stageID, handoff: "",
      registryPath, projectRoot: directory, issueNumber: "#复现问题", workPlanPath: "\\\\server\\共享\\plan.json" } })
    const message = tool(id, callID, "Stage registration complete", sessionID, config.stageControlTool)
    history.push(message)
    return message
  }
  async function prepare(id, sessionID = "ses_scope", tailID = null) {
    const message = control(id, sessionID, tailID)
    history.push(message)
    const output = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID }, output)
    return { message, output }
  }
  return { directory, oc, history, config, statePath, get hooks() { return hooks }, get reads() { return reads },
    start, stage, prepare, transform, restart, state: () => readState(statePath, config) }
}

test("compaction reminder only guides memory writing, without issuing workflow execution restrictions", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  const stage = await f.stage("msg_0200", "issue-reproduction")
  const initial = await f.transform([source, stage])
  const carrier = initial[0]
  const { output } = await f.prepare("msg_0300")
  assert.equal(output.prompt, undefined, "native prompt is not replaced")
  assert.equal(output.context.length, 1)
  const reminder = output.context[0]
  for (const required of [
    "以下要求仅约束本次摘要的内容与写法", "沿用原生摘要格式", "issue-reproduction",
    "后续补充与纠正", "关键发现", "产物路径", "失败尝试", "原流程要求的用户确认",
    "不把计划写成已执行事实", "不要在摘要中新增阶段推进限制或等待用户指示的要求",
  ]) assert.ok(reminder.includes(required), required)
  assert.doesNotMatch(reminder, /不执行下一阶段|不要进入下一阶段|Resume the registered stage|call the Stage Tool/)
  assert.ok(reminder.includes(JSON.stringify((await f.state()).sessions.ses_scope.workflowReferences)))
  assert.match(reminder, /ORIGINAL_INPUT/)
  const continued = await f.transform([source, stage])
  assert.deepEqual(continued[0], carrier, "summary-only guidance must never be accumulated into Carrier")
  assert.deepEqual(continued, initial, "compaction bookkeeping alone must not change the business prefix")
  assert.doesNotMatch(visible(continued), /以下要求仅约束本次摘要的内容与写法/)
  const next = await f.transform([source, stage, tool("msg_0400", "call_next_read", "NEW_FINDING")])
  assert.deepEqual(next.slice(0, initial.length), initial, "new work appends without rewriting the existing prefix")
})

test("1.2.27 continuation restores native summary, task, references and byte-stable Carrier without a head Hook", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  await f.stage("msg_0200", "issue-analysis")
  const stage = await f.stage("msg_0300", "issue-reproduction")
  const carrier = (await f.transform([source, stage]))[0]
  const job = await f.prepare("msg_0400")
  assert.equal(job.output.prompt, undefined, "keep native summary prompt")
  assert.match(job.output.context.join("\n"), /native-unscoped|ORIGINAL_INPUT/)
  const memory = summary("msg_0500", "msg_0400",
    "Task: FIX_INPUT. Older project understanding completed. Reproduction in progress; NEXT_REPRO_ACTION.")
  const continuation = user("msg_0600",
    "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    "ses_scope", "bug-fix-adaptive", true)
  f.history.push(memory, continuation)
  const result = await f.transform([job.message, memory, continuation])
  assert.deepEqual(result[0], carrier)
  assert.deepEqual(result.slice(1), [memory, continuation], "summary must not disappear behind Continue")
  assert.match(visible(result), /ORIGINAL_INPUT|C:\\\\Agent|NEXT_REPRO_ACTION/)
  const state = (await f.state()).sessions.ses_scope
  assert.equal(state.currentStageID, "issue-reproduction")
  assert.equal(state.compactions.msg_0400.status, "completed")
  assert.equal(state.compactions.msg_0400.inputIsolation, "native-unscoped")
  assert.equal(state.issueSourceText, "修复当前缺陷 ORIGINAL_INPUT", "synthetic Continue cannot become the invocation")
  const audit = (await fs.readFile(path.join(f.oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(audit.length, 1, "native compaction does not write repeated profile snapshots")
  assert.equal(audit[0].type, "bugfix-adaptive-stage-context")
  assert.equal(audit[0].currentStageID, "issue-reproduction")
  assert.ok(!audit.some(event => event.phase === "head-projected" || event.phase === "rejected"))
})

test("repeated native compaction and process restart preserve current memory without copying bodies into State", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  const stage = await f.stage("msg_0200", "issue-reproduction")
  const carrier = (await f.transform([source, stage]))[0]
  const first = await f.prepare("msg_0300")
  const memory1 = summary("msg_0400", "msg_0300", "B1_INFORMATION")
  f.history.push(memory1)
  await f.restart() // Native summary was saved before normal Transform.
  const supplement = user("msg_0500", "用户补充 NEW_CONSTRAINT")
  const read = tool("msg_0600", "call_b2", "B2_INFORMATION")
  f.history.push(supplement, read)
  const resumed = await f.transform([first.message, memory1, supplement, read])
  assert.deepEqual(resumed[0], carrier)
  assert.match(visible(resumed), /B1_INFORMATION/)
  const second = await f.prepare("msg_0700")
  assert.doesNotMatch(second.output.context.join("\n"), /B1_INFORMATION/, "native history already contains previous summary")
  const memory2 = summary("msg_0800", "msg_0700", "B1_INFORMATION B2_INFORMATION NEW_CONSTRAINT")
  const continuation = user("msg_0900", "continue", "ses_scope", "bug-fix-adaptive", true)
  f.history.push(memory2, continuation)
  const result = await f.transform([second.message, memory2, continuation])
  assert.deepEqual(result[0], carrier)
  assert.deepEqual(result.slice(1), [memory2, continuation])
  assert.doesNotMatch(await fs.readFile(f.statePath, "utf8"), /B1_INFORMATION|B2_INFORMATION|NEW_CONSTRAINT/)
  assert.equal((await f.state()).sessions.ses_scope.stageSequence, 1)
})

test("real stage transitions remove old raw history and old summaries, but native summary input is not claimed isolated", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  const a = await f.stage("msg_0200", "project-understanding")
  const old = tool("msg_0250", "call_a", "OLD_A_RAW")
  f.history.push(old)
  const first = await f.prepare("msg_0300")
  const memoryA = summary("msg_0400", "msg_0300", "OLD_A_SUMMARY")
  f.history.push(memoryA)
  await f.transform([first.message, memoryA])
  const b = await f.stage("msg_0500", "issue-reproduction")
  const readB = tool("msg_0600", "call_b", "NEW_B")
  f.history.push(readB)
  const entered = await f.transform([source, a, old, first.message, memoryA, b, readB])
  assert.doesNotMatch(visible(entered), /OLD_A_RAW|OLD_A_SUMMARY/)
  const second = await f.prepare("msg_0700")
  // Old-stage information can reappear inside a native summary: accepted tradeoff.
  const memoryB = summary("msg_0800", "msg_0700", "Old project complete: OLD_A_SUMMARY. Current work: NEW_B")
  const result = await f.transform([second.message, memoryB])
  assert.deepEqual(result[0], entered[0])
  assert.deepEqual(result[1], memoryB)
  assert.doesNotMatch(visible(result), /OLD_A_RAW/)
  assert.equal((await f.state()).sessions.ses_scope.currentStageID, "issue-reproduction")
})

test("first declaration inherits activation memory; later same-name entry is a distinct Run", async (t) => {
  const f = await fixture(t)
  await f.start()
  const job = await f.prepare("msg_0200")
  const memory = summary("msg_0300", "msg_0200", "BOOTSTRAP_DATA")
  f.history.push(memory)
  const first = await f.stage("msg_0400", "project-understanding")
  assert.match(visible(await f.transform([job.message, memory, first])), /BOOTSTRAP_DATA/)
  await f.stage("msg_0500", "issue-analysis")
  const returning = await f.stage("msg_0600", "project-understanding")
  assert.doesNotMatch(visible(await f.transform([job.message, memory, returning])), /BOOTSTRAP_DATA/)
  assert.equal((await f.state()).sessions.ses_scope.currentStageRunID, "stage_project-understanding_03")
})

test("failed native summary is not used and cannot advance the current stage", async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.stage("msg_0200", "issue-reproduction")
  const job = await f.prepare("msg_0300")
  const failure = summary("msg_0400", "msg_0300", "UNSAFE_FAILED_SUMMARY")
  failure.info.error = { message: "provider failed" }
  const continuation = user("msg_0500", "retry")
  assert.doesNotMatch(visible(await f.transform([job.message, failure, continuation])), /UNSAFE_FAILED_SUMMARY/)
  const state = (await f.state()).sessions.ses_scope
  assert.equal(state.currentStageID, "issue-reproduction")
  assert.equal(state.compactions.msg_0300.status, "failed")
})

test("same-Message boundary cuts preceding Parts, not actual user questions with compaction-like wording", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  await f.stage("msg_0200", "project-understanding")
  const stage = await f.stage("msg_0300", "issue-analysis")
  stage.parts.unshift({ type: "text", text: "OLD_PART" })
  stage.parts.push({ type: "text", text: "AFTER_STAGE_PART" })
  const literal = user("msg_0400", "What did we do so far?")
  const result = await f.transform([source, stage, literal])
  assert.doesNotMatch(visible(result), /OLD_PART/)
  assert.match(visible(result), /AFTER_STAGE_PART/)
  assert.deepEqual(result.find(message => message.info.id === literal.info.id), literal)
})

test("untracked, empty, ambiguous or mutated summaries are rejected without rewriting input or State", async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.stage("msg_0200", "issue-analysis")
  const unknown = summary("msg_0400", "msg_0300", "UNKNOWN")
  const before = await fs.readFile(f.statePath, "utf8")
  await assert.rejects(f.transform([control("msg_0300"), unknown]), /Untracked compaction summary/)
  assert.equal(await fs.readFile(f.statePath, "utf8"), before)
  const job = await f.prepare("msg_0300")
  const prepared = await fs.readFile(f.statePath, "utf8")
  for (const summaries of [
    [summary("msg_0400", "msg_0300", "")],
    [summary("msg_0400", "msg_0300", "ONE"), summary("msg_0500", "msg_0300", "TWO")],
  ]) {
    const output = { messages: [job.message, ...summaries] }
    const input = structuredClone(output.messages)
    await assert.rejects(f.hooks["experimental.chat.messages.transform"]({}, output), /Invalid completed|Ambiguous completed/)
    assert.deepEqual(output.messages, input)
    assert.equal(await fs.readFile(f.statePath, "utf8"), prepared)
  }
  const good = summary("msg_0400", "msg_0300", "GOOD_MEMORY")
  await f.transform([job.message, good])
  const mutated = structuredClone(good)
  mutated.parts[0].text = "MODIFIED_WITHOUT_PROVENANCE"
  await assert.rejects(f.transform([job.message, mutated]), /integrity changed/)
})

test("prepared metadata is Session-local and survives restart without a live next-call ticket", async (t) => {
  const f = await fixture(t)
  for (const id of ["ses_one", "ses_two"]) {
    await f.start(id)
    await f.stage("msg_0200", "issue-reproduction", id)
    await f.prepare("msg_0300", id)
  }
  const other = user("msg_0100", "OTHER_SESSION", "ses_other", "build")
  assert.deepEqual(await f.transform([other]), [other])
  await f.restart()
  assert.deepEqual(await f.transform([]), [])
  for (const id of ["ses_two", "ses_one"]) {
    const result = await f.transform([control("msg_0300", id), summary("msg_0400", "msg_0300", id + "_MEMORY", id)])
    assert.match(visible(result), new RegExp(id + "_MEMORY"))
    assert.equal((await f.state()).sessions[id].compactions.msg_0300.status, "completed")
  }
})

test("manual compaction keeps native prompt/context and does not inject a continuation Message", async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.stage("msg_0200", "issue-analysis")
  const manual = control("msg_0300")
  manual.parts[0].auto = false
  f.history.push(manual)
  const output = { context: ["OTHER_PLUGIN_CONTEXT"], prompt: "OTHER_PLUGIN_PROMPT" }
  await f.hooks["experimental.session.compacting"]({ sessionID: "ses_scope" }, output)
  assert.equal(output.prompt, "OTHER_PLUGIN_PROMPT")
  assert.equal(output.context[0], "OTHER_PLUGIN_CONTEXT")
  const memory = summary("msg_0400", "msg_0300", "MANUAL_FINDINGS")
  const result = await f.transform([manual, memory])
  assert.deepEqual(result.slice(1), [memory])
})

test("switching Agent bypasses projection and compaction context, unknown Sessions remain untouched", async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.stage("msg_0200", "issue-analysis")
  const other = user("msg_0300", "OTHER_AGENT_INPUT", "ses_scope", "build")
  const before = await fs.readFile(f.statePath, "utf8")
  assert.deepEqual(await f.transform([other]), [other])
  f.history.push(control("msg_0400", "ses_scope", null, "build"))
  for (const sessionID of ["ses_scope", "ses_unknown"]) {
    const output = { context: [] }
    await f.hooks["experimental.session.compacting"]({ sessionID }, output)
    assert.deepEqual(output, { context: [] })
  }
  assert.equal(await fs.readFile(f.statePath, "utf8"), before)
})

test("SDK errors or a corrupt Tool boundary fail rather than silently dropping unresolved history", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  await f.stage("msg_0200", "project-understanding")
  const next = await f.stage("msg_0300", "issue-analysis")
  await f.transform([source, next])
  await assert.rejects(f.transform([source, { ...next, parts: [{ type: "text", text: "missing boundary" }] }]), /without its Tool Part/)
  const noClient = await BugfixAdaptiveContext({ directory: f.directory })
  await f.stage("msg_0400", "issue-reproduction")
  await assert.rejects(noClient["experimental.chat.messages.transform"]({}, { messages: [user("msg_0500", "New input")] }), /Session client is required/)
})

test("State v9 rejects old versions, false isolation claims and malformed ownership without migration", async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.stage("msg_0200", "issue-analysis")
  await f.prepare("msg_0300")
  const valid = await f.state()
  for (const mutate of [
    state => state.version = 4,
    state => state.version = 5,
    state => state.version = 6,
    state => state.version = 7,
    state => state.version = 8,
    state => state.sessions.ses_scope.compactions = undefined,
    state => state.sessions.ses_scope.compactions.msg_0300.stageRunID = "invented",
    state => state.sessions.ses_scope.compactions.msg_0300.inputIsolation = "stage-isolated",
    state => state.sessions.ses_scope.compactions.msg_0300.status = "completed",
    state => state.sessions.ses_scope.compactions.msg_0300.headMessageCount = 10,
    state => state.sessions.ses_scope.stageBoundary.partIndex = -1,
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    await writeState(f.statePath, invalid)
    await assert.rejects(f.state(), /State|state/)
  }
  assert.equal(STATE_VERSION, 9)
})

test("ordinary same-stage Provider calls do not repeatedly fetch native history", async (t) => {
  const f = await fixture(t)
  const source = await f.start()
  const stage = await f.stage("msg_0200", "issue-analysis")
  const input = [source, stage]
  for (let index = 0; index < 5; index++) {
    input.push(tool(`msg_03${index}0`, `call_${index}`, "CURRENT_WORK"))
    await f.transform(input)
  }
  assert.equal(f.reads, 0)
  const first = await f.prepare("msg_0400")
  assert.equal(f.reads, 1)
  await f.transform([first.message, summary("msg_0500", "msg_0400", "CURRENT_WORK")])
  assert.equal(f.reads, 1)
})
