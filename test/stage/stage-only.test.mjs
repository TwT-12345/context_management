import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { readConfig, validateConfig } from "../../src/stage/config.mjs"
import { compileProjection } from "../../src/stage/projection.mjs"
import { projectionMetrics } from "../../src/stage/messages.mjs"
import { createSession, declareStage, readState } from "../../src/stage/state.mjs"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/stage")
const config = () => readConfig(path.join(root, "default-config.json"))
const user = (id = "msg_user", text = "Fix the reported defect", sessionID = "ses_test", agent = "bug-fix-adaptive") => ({
  info: { id, role: "user", sessionID, agent },
  parts: [{ type: "text", text, id: `prt_${id}`, messageID: id, sessionID }],
})
const tool = (id, name, callID, output = "ok", status = "completed") => ({
  info: { id, role: "assistant", sessionID: "ses_test" },
  parts: [{ type: "tool", tool: name, callID, state: {
    status, input: { filePath: "C:\\代码\\src\\a.ts", path: "src", pattern: "handler" },
    ...(status === "completed" ? { output } : { error: output }),
  } }],
})
const text = (messages) => JSON.stringify(messages)
function session() {
  const state = createSession({ sessionID: "ses_test", issueSourceMessageID: "msg_user", issueSourceText: "Fix the reported defect" })
  declareStage(state, { handoff: "", stageID: "issue-reproduction", boundaryToolCallID: "call_stage" })
  return state
}
const messages = () => [user(), tool("msg_stage", "bugfix-adaptive-stage", "call_stage")]
async function temporary(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), label))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test("stage-only config cannot enable Observation", async () => {
  const value = await config()
  assert.equal(value.pluginID, "bugfix-adaptive-stage-only-v1")
  assert.equal(value.observationPolicy.enabled, false)
  assert.throws(() => validateConfig({ ...value, observationPolicy: { ...value.observationPolicy, enabled: true } }), /enabled=false/)
})

test("stageID registers first entry and workflow-selected transitions without a next-stage hint", async () => {
  const state = createSession({ sessionID: "ses_test", issueSourceMessageID: "msg_user", issueSourceText: "Fix the reported defect" })
  const first = declareStage(state, { stageID: "project-understanding", boundaryToolCallID: "call_first" })
  assert.equal(first.previousStageID, null)
  assert.equal(state.currentStageID, "project-understanding")
  // The Agent may skip a step according to its workflow; the plugin must not pick a route.
  const next = declareStage(state, { stageID: "root-cause-localization", handoff: "", boundaryToolCallID: "call_next" })
  assert.equal(next.previousStageID, "project-understanding")
  assert.equal(state.currentStageID, "root-cause-localization")
  assert.equal(state.stageBoundary.enteredAfterToolCallID, "call_next")
  assert.deepEqual(state.stageHistory.map(entry => entry.stageID), ["project-understanding", "root-cause-localization"])
  assert.doesNotMatch(JSON.stringify({ state, first, next }), /nextStageID/)
})

test("large read/grep/glob and failures remain byte-for-byte unchanged through repeated projections", async () => {
  const value = await config()
  const state = session()
  const large = Array.from({ length: 6000 }, (_, index) => `中文_RECORD_${index}`).join("\r\n")
  const parts = [tool("msg_read", "read", "call_read", large), tool("msg_grep", "grep", "call_grep", large),
    tool("msg_glob", "glob", "call_glob", large), tool("msg_error", "read", "call_error", "读取失败", "error")]
  const input = [...messages(), ...parts]
  const original = structuredClone(input)
  for (let count = 0; count < 4; count += 1) {
    const result = await compileProjection({ config: value, session: state, messages: input })
    for (const part of parts) assert.deepEqual(result.messages.find((item) => item.info.id === part.info.id), part)
    assert.equal(result.request, null)
    assert.deepEqual(result.manifest, [])
    assert.deepEqual(result.observationChanges, [])
    assert.doesNotMatch(text(result.messages), /observation-request|observation-memory|tool-output-receipt/)
  }
  assert.deepEqual(input, original)
  assert.deepEqual(state.observationRequests, [])
  assert.deepEqual(state.observations, [])
})

test("even a preseeded Observation cannot replace a source or inject Memory", async () => {
  const value = await config()
  const state = session()
  state.observations.push({ stageRunID: state.currentStageRunID, sourceCallID: "call_read", retention: "replace", content: "DO_NOT_PROJECT_MEMORY" })
  const source = tool("msg_read", "read", "call_read", "KEEP_ORIGINAL_SOURCE")
  const result = await compileProjection({ config: value, session: state, messages: [...messages(), source] })
  assert.deepEqual(result.messages.find((item) => item.info.id === source.info.id), source)
  assert.doesNotMatch(text(result.messages), /DO_NOT_PROJECT_MEMORY|observation-memory|tool-output-receipt/)
})

test("stage switching still clears exploration and changes Carrier only on entry", async () => {
  const value = await config()
  const state = session()
  const old = tool("msg_old", "read", "call_old", "OLD_STAGE_CANARY")
  const first = await compileProjection({ config: value, session: state, messages: [...messages(), old] })
  const supplement = user("msg_supplement", "NEW_USER_CONSTRAINT")
  const second = await compileProjection({ config: value, session: state, messages: [...messages(), old, supplement] })
  assert.deepEqual(second.messages[0], first.messages[0])
  assert.deepEqual(second.messages.find((item) => item.info.id === supplement.info.id), supplement)
  const beforeRepeat = structuredClone(state)
  declareStage(state, { handoff: "", stageID: "issue-reproduction", boundaryToolCallID: "call_repeat" })
  assert.deepEqual(state, beforeRepeat)
  declareStage(state, { handoff: "", stageID: "root-cause-localization", boundaryToolCallID: "call_next" })
  const current = tool("msg_current", "grep", "call_current", "CURRENT_STAGE_CANARY")
  const next = await compileProjection({ config: value, session: state, messages: [...messages(), old, supplement,
    tool("msg_next", value.stageControlTool, "call_next"), current] })
  assert.doesNotMatch(text(next.messages), /OLD_STAGE_CANARY/)
  assert.deepEqual(next.messages.find((item) => item.info.id === current.info.id), current)
  assert.deepEqual(next.messages.find((item) => item.info.id === supplement.info.id), supplement)
  assert.notEqual(next.messages[0].info.id, first.messages[0].info.id)
  assert.match(text([next.messages[0]]), /root-cause-localization/)
  assert.doesNotMatch(text([next.messages[0]]), /nextStageID/)
})

test("first stage binding retains startup and existing work; only a genuine transition clears it", async () => {
  const value = await config()
  const state = createSession({ sessionID: "ses_test", issueSourceMessageID: "msg_user", issueSourceText: "Fix the reported defect" })
  const startup = [user(), tool("msg_registry", "read", "call_registry", "REGISTRY_PATH_AND_CONTENT"),
    tool("msg_init", "initialize-bugfix-workspace", "call_init", "PROJECT_ROOT_AND_INITIALIZATION"),
    tool("msg_work", "read", "call_work", "EARLY_STEP_WORK"),
  ]
  declareStage(state, { handoff: "", stageID: "project-understanding", boundaryToolCallID: "call_first" })
  const input = [...startup, tool("msg_first", value.stageControlTool, "call_first")]
  const first = await compileProjection({ config: value, session: state, messages: input })
  assert.equal(first.boundaryResolution, "initial-stage-history")
  for (const original of startup.slice(1)) {
    assert.deepEqual(first.messages.find((message) => message.info.id === original.info.id), original)
  }
  declareStage(state, { handoff: "", stageID: "project-understanding", boundaryToolCallID: "call_repeat" })
  const repeated = await compileProjection({ config: value, session: state, messages: input })
  assert.deepEqual(repeated.messages, first.messages)
  declareStage(state, { handoff: "", stageID: "issue-analysis", boundaryToolCallID: "call_next" })
  const next = await compileProjection({ config: value, session: state, messages: [...input,
    tool("msg_next", value.stageControlTool, "call_next"), tool("msg_current", "read", "call_current", "CURRENT_STAGE_WORK")],
  })
  assert.equal(next.boundaryResolution, "exact-stage-tool")
  assert.doesNotMatch(text(next.messages), /REGISTRY_PATH_AND_CONTENT|PROJECT_ROOT_AND_INITIALIZATION|EARLY_STEP_WORK/)
  assert.match(text(next.messages), /CURRENT_STAGE_WORK/)
})

test("repeated declaration acknowledgments remain visible while Carrier stays registered and stable", async () => {
  const value = await config()
  const state = session()
  const input = [...messages(), tool("msg_init", "initialize-bugfix-workspace", "call_init", "BOOTSTRAP_COMPLETED")]
  const first = await compileProjection({ config: value, session: state, messages: input })
  assert.match(text([first.messages[0]]), /stageDeclarationStatus.*registered/)
  assert.match(text([first.messages[0]]), /currentStageDeclarationRequired.*false/)
  for (let index = 0; index < 4; index += 1) {
    const callID = `call_repeat_${index}`
    declareStage(state, { handoff: "", stageID: "issue-reproduction", boundaryToolCallID: callID })
    const repeat = tool(`msg_repeat_${index}`, value.stageControlTool, callID, "Stage registration is complete; execute the business action now.")
    input.push(repeat)
    const projected = await compileProjection({ config: value, session: state, messages: input })
    assert.deepEqual(projected.messages[0], first.messages[0])
    assert.deepEqual(projected.messages.find((message) => message.info.id === repeat.info.id), repeat)
    assert.match(text(projected.messages), /BOOTSTRAP_COMPLETED/)
    assert.equal(state.stageSequence, 1)
    assert.equal(state.stageBoundary.enteredAfterToolCallID, "call_stage")
  }
  declareStage(state, { handoff: "", stageID: "root-cause-localization", boundaryToolCallID: "call_next" })
  const receipt = tool("msg_next", value.stageControlTool, "call_next", "NEW_STAGE_ACKNOWLEDGMENT")
  const next = await compileProjection({ config: value, session: state, messages: [...input, receipt] })
  assert.deepEqual(next.messages.find((message) => message.info.id === receipt.info.id), receipt)
  assert.doesNotMatch(text(next.messages), /call_repeat_0|BOOTSTRAP_COMPLETED/)
})

test("runtime audit records only the newly built profile with token totals and no history", async (t) => {
  const dir = await temporary(t, "stage-only-hooks-")
  const oc = path.join(dir, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  const hooks = await BugfixAdaptiveContext({ directory: dir })
  await hooks["experimental.chat.messages.transform"]({}, { messages: [user()] })
  await hooks["tool.execute.before"]({ tool: "bugfix-adaptive-stage", sessionID: "ses_test", callID: "call_stage" },
    { args: { stageID: "issue-reproduction" } })
  const source = tool("msg_read", "read", "call_read", "A".repeat(16000))
  const output = { messages: [...messages(), source] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  assert.deepEqual(output.messages.find((item) => item.info.id === source.info.id), source)
  const events = (await fs.readFile(path.join(oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.length, 1)
  const event = events[0]
  assert.equal(event.type, "bugfix-adaptive-stage-context")
  assert.equal(event.callID, "call_stage")
  assert.equal(event.currentStageID, "issue-reproduction")
  assert.deepEqual(event.contextProfile.carrier, output.messages[0])
  assert.deepEqual(event.contextProfile.handoff, { mode: "none", content: null })
  assert.ok(JSON.parse(event.contextProfile.carrier.parts[0].text.split("\n\n")[1]).instructions.length === 3)
  assert.match(event.contextProfile.carrier.parts[0].text, /Fix the reported defect/)
  assert.equal(event.tokenMetrics.mode, "estimated")
  assert.equal(event.tokenMetrics.before.items, undefined)
  assert.equal(event.tokenMetrics.after.items, undefined)
  assert.equal(event.tokenMetrics.removedMessages.items, undefined)
  assert.doesNotMatch(JSON.stringify(event), /beforeMessages|afterMessages|AAAAAA/)
  assert.ok(events.every(item => !Object.hasOwn(item, "nextStageID")))
  const initialDeclaration = events[0]
  assert.equal(initialDeclaration.declarationType, "initialization")
  assert.equal(initialDeclaration.historyPruning, false)
  const saved = await readState(path.join(oc, "bugfix-adaptive-context.state.json"), await config())
  assert.deepEqual(saved.sessions.ses_test.observations, [])
  assert.deepEqual(saved.sessions.ses_test.observationRequests, [])
  assert.equal(Object.hasOwn(saved.sessions.ses_test, "nextStageID"), false)
  assert.ok(saved.sessions.ses_test.stageHistory.every(entry => !Object.hasOwn(entry, "nextStageID")))
})

test("large same-stage calls, duplicate declarations and restart do not grow the profile log", async t => {
  const dir = await temporary(t, "stage-only-small-log-")
  const oc = path.join(dir, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  let hooks = await BugfixAdaptiveContext({ directory: dir })
  const input = [user()]
  const transform = async () => {
    const output = { messages: structuredClone(input) }
    await hooks["experimental.chat.messages.transform"]({}, output)
    return output.messages
  }
  const stage = async (stageID, callID, handoff) => {
    await hooks["tool.execute.before"]({ tool: "bugfix-adaptive-stage", sessionID: "ses_test", callID },
      { args: { stageID, ...(handoff === undefined ? {} : { handoff }) } })
    input.push(tool(`msg_${callID}`, "bugfix-adaptive-stage", callID))
  }
  const file = path.join(oc, "bugfix-adaptive-context.jsonl")
  await transform()
  await assert.rejects(fs.stat(file), { code: "ENOENT" })
  await stage("project-understanding", "call_first")
  const large = tool("msg_large", "read", "call_large", "HUGE_SOURCE_CANARY ".repeat(60000))
  input.push(large)
  await transform()
  const first = await fs.readFile(file, "utf8")
  for (let count = 0; count < 25; count++) await transform()
  await stage("project-understanding", "call_repeat")
  await transform()
  hooks = await BugfixAdaptiveContext({ directory: dir })
  await transform()
  assert.equal(await fs.readFile(file, "utf8"), first)
  input.push(user("msg_supplement", "USER_CONSTRAINT_CANARY"))
  await stage("issue-analysis", "call_analysis", "")
  const after = await transform()
  const events = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.length, 2)
  assert.deepEqual(events[1].tokenMetrics, projectionMetrics(input, after))
  assert.deepEqual(events[1].contextProfile.inputs, [input.find(message => message.info.id === "msg_supplement")])
  assert.deepEqual(events[1].contextProfile.carrier, after[0])
  assert.ok(events[1].tokenMetrics.removedMessages.estimatedTokens > 100000)
  assert.ok(events[1].tokenMetrics.savings.estimatedTokens > 100000)
  assert.doesNotMatch(JSON.stringify(events), /HUGE_SOURCE_CANARY|beforeMessages|afterMessages/)
  assert.ok((await fs.stat(file)).size < 10000, "fixture log scales with profiles, not megabyte source outputs")
})

test("stage token totals distinguish deletion from net savings and ignore non-provider diffs", () => {
  const old = user("msg_old", "A".repeat(1000))
  const kept = user("msg_kept", "KEEP")
  const added = user("msg_carrier", "B".repeat(2000))
  const metrics = projectionMetrics([old, kept], [added, kept])
  assert.equal(metrics.removedMessages.count, 1)
  assert.equal(metrics.removedMessages.estimatedTokens, projectionMetrics([old], []).before.estimatedTokens)
  assert.equal(metrics.savings.estimatedTokens, metrics.before.estimatedTokens - metrics.after.estimatedTokens)
  assert.ok(metrics.savings.estimatedTokens < 0, "do not clamp the cost of adding a larger profile")
  const withDiff = structuredClone(old)
  withDiff.info.summary = { diffs: [{ before: "DO_NOT_COUNT".repeat(10000) }] }
  withDiff.parts.push({ type: "patch", files: ["ALSO_NOT_PROVIDER_TEXT".repeat(10000)] })
  assert.deepEqual(projectionMetrics([withDiff, kept], [added, kept]), metrics)
})

test("legacy full-message logging config is rejected", async () => {
  const value = await config()
  assert.equal(value.audit.includeMessages, false)
  const legacy = { ...value, audit: { includeMessages: true } }
  assert.throws(() => validateConfig(legacy), /includeMessages=false.*--replace-config --reset-state/)
})

