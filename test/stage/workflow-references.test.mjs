import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"
import { readConfig } from "../../src/stage/config.mjs"
import { compileProjection } from "../../src/stage/projection.mjs"
import { createSession, declareStage, readState, writeState, STATE_VERSION } from "../../src/stage/state.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/stage")
const refs = {
  registryPath: "C:\\Agent 配置\\workflow\\step-registry.yaml",
  workPlanPath: "C:\\代码\\项目 A\\.bugfix\\#问题-123\\workflow_plan.json",
  workspaceRoot: "C:\\代码\\项目 A",
  projectRoot: "C:\\代码\\项目 A",
  issueNumber: "#问题-123",
}
function user(sessionID = "ses_refs") {
  return { info: { id: `msg_${sessionID}`, role: "user", agent: "bug-fix-adaptive", sessionID },
    parts: [{ type: "text", text: "Fix the reported defect" }] }
}
function tool(callID, name = "bugfix-adaptive-stage", output = "registration is complete") {
  return { info: { id: `msg_${callID}`, role: "assistant", sessionID: "ses_refs" },
    parts: [{ type: "tool", tool: name, callID, state: { status: "completed", input: {}, output } }] }
}
function carrier(result) {
  return JSON.parse(result.messages[0].parts[0].text.split("\n\n").find((section) => section.startsWith("{")))
}
function session() {
  return createSession({ sessionID: "ses_refs", issueSourceMessageID: "msg_ses_refs", issueSourceText: "Fix the reported defect" })
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-references-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const oc = path.join(directory, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  const config = await readConfig(path.join(root, "default-config.json"))
  const hooks = await BugfixAdaptiveContext({ directory })
  const statePath = path.join(oc, "bugfix-adaptive-context.state.json")
  return { directory, oc, config, hooks, statePath }
}

test("real hooks hand off Windows paths while workspaceRoot comes only from runtime", async (t) => {
  const { hooks, config, statePath, oc, directory } = await fixture(t)
  const expected = { ...refs, workspaceRoot: directory }
  const transform = hooks["experimental.chat.messages.transform"]
  const before = hooks["tool.execute.before"]
  const input = [user(), tool("call_discovery", "read", "OLD_REGISTRY_DISCOVERY_CANARY")]
  await transform({}, { messages: structuredClone(input) })
  await before({ tool: config.stageControlTool, sessionID: "ses_refs", callID: "call_project" },
    { args: { stageID: "project-understanding", ...refs } })
  input.push(tool("call_project"))
  const first = { messages: structuredClone(input) }
  await transform({}, first)
  assert.match(JSON.stringify(first.messages), /OLD_REGISTRY_DISCOVERY_CANARY/)
  assert.deepEqual(carrier(first).workflowReferences, expected)

  await before({ tool: config.stageControlTool, sessionID: "ses_refs", callID: "call_analysis" },
    { args: { stageID: "issue-analysis", handoff: "" } })
  input.push(tool("call_analysis"))
  const next = { messages: structuredClone(input) }
  await transform({}, next)
  assert.doesNotMatch(JSON.stringify(next.messages), /OLD_REGISTRY_DISCOVERY_CANARY/)
  assert.deepEqual(carrier(next).workflowReferences, expected)
  assert.equal(carrier(next).currentStageID, "issue-analysis")
  const instructions = carrier(next).instructions.join("\n")
  assert.match(instructions, /do not repeat Registry discovery/)
  assert.match(instructions, /never create it early/)
  assert.match(instructions, /Paths do not prove existence or validation/)
  assert.doesNotMatch(JSON.stringify(carrier(next)), /analysis_results\.json|reproduction_result\.json|planExists|planCreated|planStatus/)
  assert.deepEqual((await readState(statePath, config)).sessions.ses_refs.workflowReferences, expected)
  const events = (await fs.readFile(path.join(oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.length, 2)
  assert.ok(events.every(event => event.type === "bugfix-adaptive-stage-context"))
  assert.deepEqual(events.at(-1).contextProfile.carrier, next.messages[0])
})

test("unknown paths never block initial declaration and are only filled on a real next entry", async (t) => {
  const { config, directory } = await fixture(t)
  const state = session()
  declareStage(state, { handoff: "", stageID: "project-understanding", boundaryToolCallID: "call_first" })
  assert.ok(Object.values(state.workflowReferences).every((value) => value === null))
  const input = [user(), tool("call_first")]
  const first = await compileProjection({ config, session: state, messages: input, directory })
  const saved = structuredClone(state)
  declareStage(state, { handoff: "", stageID: "project-understanding", boundaryToolCallID: "call_repeat", ...refs })
  assert.deepEqual(state, saved)
  const repeat = await compileProjection({ config, session: state, messages: [...input, tool("call_repeat")], directory })
  assert.deepEqual(repeat.messages[0], first.messages[0])
  declareStage(state, { handoff: "", stageID: "issue-analysis", boundaryToolCallID: "call_next", ...refs })
  assert.deepEqual(state.workflowReferences, { ...refs, workspaceRoot: null })
})

test("creating or revising the Plan within a stage leaves the Carrier unchanged and carries no stale absence claim", async (t) => {
  const { config, directory } = await fixture(t)
  const planPath = path.join(directory, ".bugfix", "local-key", "workflow_plan.json")
  const state = session()
  declareStage(state, { handoff: "", stageID: "issue-analysis", boundaryToolCallID: "call_first", workPlanPath: planPath })
  const input = [user(), tool("call_first")]
  const first = await compileProjection({ config, session: state, messages: input, directory })
  await assert.rejects(fs.stat(planPath), { code: "ENOENT" })
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, '{"plan_state":"READY","private":"DO_NOT_COPY_PLAN"}')
  const next = await compileProjection({ config, session: state,
    messages: [...input, tool("call_write", "write", "Plan written")], directory })
  assert.deepEqual(next.messages[0], first.messages[0])
  assert.doesNotMatch(JSON.stringify(carrier(next)), /DO_NOT_COPY_PLAN|"plan_state"|not-created|暂未创建/)
  await fs.writeFile(planPath, '{"plan_state":"RUNNING"}')
  const revised = await compileProjection({ config, session: state, messages: input, directory })
  assert.deepEqual(revised.messages[0], first.messages[0])
})

test("partial reference corrections merge only at the next stage and persist without path normalization", async (t) => {
  const { config, statePath } = await fixture(t)
  const state = session()
  declareStage(state, { handoff: "", stageID: "project-understanding", boundaryToolCallID: "call_first", ...refs })
  const corrected = "\\\\server\\共享目录\\Agent\\step-registry.yaml"
  declareStage(state, { handoff: "", stageID: "issue-analysis", boundaryToolCallID: "call_next", registryPath: corrected })
  const expected = { ...refs, registryPath: corrected, workspaceRoot: null }
  assert.deepEqual(state.workflowReferences, expected)
  const container = { version: STATE_VERSION, pluginID: config.pluginID, configHash: config.configHash,
    targetAgent: config.targetAgent, sessions: { ses_refs: state } }
  await writeState(statePath, container)
  assert.deepEqual((await readState(statePath, config)).sessions.ses_refs.workflowReferences, expected)
})

test("malformed references reject atomically without changing the stage or state file", async (t) => {
  const { hooks, config, statePath } = await fixture(t)
  await hooks["experimental.chat.messages.transform"]({}, { messages: [user()] })
  const original = await fs.readFile(statePath, "utf8")
  for (const invalid of [
    { registryPath: "relative/step-registry.yaml" }, { projectRoot: "C:relative" },
    { workPlanPath: "/repo/{{issue_number}}/plan.json" },
    { registryPath: "" }, { projectRoot: "/bad\npath" }, { issueNumber: false },
  ]) {
    await assert.rejects(hooks["tool.execute.before"](
      { tool: config.stageControlTool, sessionID: "ses_refs", callID: "call_bad" },
      { args: { stageID: "project-understanding", ...invalid } },
    ), /Invalid adaptive workflow reference/)
    assert.equal(await fs.readFile(statePath, "utf8"), original)
  }
})

test("State v9 refuses old and malformed reference state without migration", async (t) => {
  const { config, statePath } = await fixture(t)
  const state = session()
  const container = { version: STATE_VERSION, pluginID: config.pluginID, configHash: config.configHash,
    targetAgent: config.targetAgent, sessions: { ses_refs: state } }
  for (const invalid of [
    { ...container, version: 2 },
    { ...container, version: 3 },
    { ...container, version: 5 },
    { ...container, version: 7 },
    { ...container, version: 8 },
    { ...container, sessions: { ses_refs: { ...state, workflowReferences: undefined } } },
    { ...container, sessions: { ses_refs: { ...state, workflowReferences: { ...state.workflowReferences, planStatus: "READY" } } } },
    { ...container, sessions: { ses_refs: { ...state, workflowReferences: { ...state.workflowReferences, registryPath: "relative" } } } },
  ]) {
    const content = JSON.stringify(invalid)
    await fs.writeFile(statePath, content)
    await assert.rejects(readState(statePath, config), /State|state|reference/)
    assert.equal(await fs.readFile(statePath, "utf8"), content)
  }
})

test("workflow references stay isolated between target Agent Sessions", async (t) => {
  const { hooks, config, statePath, directory } = await fixture(t)
  for (const sessionID of ["ses_one", "ses_two"]) {
    await hooks["experimental.chat.messages.transform"]({}, { messages: [user(sessionID)] })
    await hooks["tool.execute.before"]({ tool: config.stageControlTool, sessionID, callID: `call_${sessionID}` },
      { args: { stageID: "project-understanding", ...(sessionID === "ses_one" ? refs : {}) } })
  }
  const saved = await readState(statePath, config)
  assert.deepEqual(saved.sessions.ses_one.workflowReferences, { ...refs, workspaceRoot: directory })
  assert.equal(saved.sessions.ses_two.workflowReferences.workspaceRoot, directory)
  assert.ok(Object.entries(saved.sessions.ses_two.workflowReferences).filter(([key]) => key !== "workspaceRoot").every(([, value]) => value === null))
})

