import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"
import { readConfig } from "../../src/stage/config.mjs"
import { readState } from "../../src/stage/state.mjs"
import { outputHash } from "../../src/stage/messages.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/stage")
const visible = messages => JSON.stringify(messages)
const memory = messages => messages.filter(message => message.parts.some(part => part.text?.startsWith("<bugfix-adaptive-handoff ")))
const count = (messages, marker) => visible(messages).split(marker).length - 1

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-handoff-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const oc = path.join(directory, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  const registryPath = path.join(directory, "step-registry.yaml")
  await fs.copyFile(path.join(root, "../../test/stage/fixtures/step-registry.depends-on.yaml"), registryPath)
  const config = await readConfig(path.join(oc, "bugfix-adaptive-context.config.json"))
  const statePath = path.join(oc, "bugfix-adaptive-context.state.json")
  const history = []
  let sequence = 0, reads = 0
  const nextID = () => `msg_${String(sequence += 10).padStart(6, "0")}`
  const client = { session: { messages: async ({ path: { id } }) => {
    reads++
    return { data: structuredClone(history.filter(message => message.info.sessionID === id)) }
  } } }
  let hooks = await BugfixAdaptiveContext({ directory, client })
  async function transform(messages = history) {
    const original = structuredClone(messages)
    const output = { messages: structuredClone(messages) }
    await hooks["experimental.chat.messages.transform"]({}, output)
    assert.deepEqual(messages, original, "never modify the Session input")
    return output.messages
  }
  async function start(sessionID = "ses_handoff") {
    const source = { info: { id: nextID(), sessionID, role: "user", agent: config.targetAgent },
      parts: [{ type: "text", text: `修复任务 ${sessionID}` }] }
    history.push(source)
    await transform([source])
    return source
  }
  async function stage(stageID, handoff, sessionID = "ses_handoff") {
    const id = nextID(), callID = `call_${id}`
    const args = { stageID, registryPath, projectRoot: directory, issueNumber: "#问题-123",
      ...(handoff === undefined ? {} : { handoff }) }
    await hooks["tool.execute.before"]({ tool: config.stageControlTool, sessionID, callID }, { args })
    const message = { info: { id, sessionID, role: "assistant" }, parts: [{ type: "tool", tool: config.stageControlTool,
      callID, state: { status: "completed", input: structuredClone(args), output: "Stage registration is complete" } }] }
    history.push(message)
    await hooks["tool.execute.after"]?.({ tool: config.stageControlTool, sessionID, callID }, {})
    return message
  }
  function work(text, sessionID = "ses_handoff") {
    const id = nextID()
    const message = { info: { id, sessionID, role: "assistant" }, parts: [{ type: "tool", tool: "read", callID: `call_${id}`,
      state: { status: "completed", input: { filePath: "C:\\代码\\src\\file.ts" }, output: text } }] }
    history.push(message)
    return message
  }
  async function compact(sessionID = "ses_handoff") {
    const control = { info: { id: nextID(), sessionID, role: "user", agent: config.targetAgent },
      parts: [{ type: "compaction", auto: true }] }
    history.push(control)
    await hooks["experimental.session.compacting"]({ sessionID }, { context: [] })
    const summary = { info: { id: nextID(), parentID: control.info.id, sessionID, role: "assistant", summary: true,
      agent: "compaction", mode: "compaction", finish: "stop" }, parts: [{ type: "text", text: "NATIVE_CURRENT_STAGE_MEMORY" }] }
    const continuation = { info: { id: nextID(), sessionID, role: "user", agent: config.targetAgent },
      parts: [{ type: "text", text: "Continue if you have next steps", synthetic: true }] }
    history.push(summary, continuation)
    return [control, summary, continuation]
  }
  return { directory, oc, config, statePath, history, start, stage, work, compact, transform,
    get reads() { return reads }, state: () => readState(statePath, config),
    restart: async () => { hooks = await BugfixAdaptiveContext({ directory, client }) },
    audit: async () => (await fs.readFile(path.join(oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse) }
}

test("initial registration needs no handoff and retains startup; non-empty unowned handoff is rejected", async t => {
  const f = await fixture(t)
  const source = await f.start()
  const before = await fs.readFile(f.statePath, "utf8")
  await assert.rejects(f.stage("project-understanding", "UNOWNED"), /first stage registration/)
  assert.equal(await fs.readFile(f.statePath, "utf8"), before)
  f.work("STARTUP_HISTORY")
  await f.stage("project-understanding")
  const messages = await f.transform()
  assert.ok(messages.some(message => visible([message]).includes("STARTUP_HISTORY")))
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff, null)
  assert.equal(memory(messages).length, 0)
  assert.deepEqual(f.history[0], source)
})

test("true transition retains one native handoff, prunes exploration and never puts content in Carrier", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  f.work("OLD_EXPLORATION_ONLY")
  const entry = await f.stage("issue-analysis", "HANDOFF_CODE_LOCATION")
  const messages = await f.transform()
  assert.doesNotMatch(visible(messages), /OLD_EXPLORATION_ONLY/)
  assert.equal(count(messages, "HANDOFF_CODE_LOCATION"), 1)
  assert.equal(memory(messages).length, 0)
  assert.doesNotMatch(visible([messages[0]]), /HANDOFF_CODE_LOCATION/)
  assert.deepEqual(messages.find(message => message.info.id === entry.info.id), entry)
  const saved = (await f.state()).sessions.ses_handoff.stageHandoff
  assert.equal(saved.fromStageRunID, "stage_project-understanding_01")
  assert.equal(saved.toStageRunID, "stage_issue-analysis_02")
  assert.equal(saved.sourceMessageID, entry.info.id)
  assert.equal(saved.sha256, outputHash(saved.content))
  const audit = (await f.audit()).at(-1)
  assert.equal(audit.callID, entry.parts[0].callID)
  assert.deepEqual(audit.contextProfile.carrier, messages[0])
  assert.equal(audit.contextProfile.handoff.mode, "entry-tool")
  assert.equal(audit.contextProfile.handoff.content, "HANDOFF_CODE_LOCATION")
  assert.equal(audit.contextProfile.handoff.sourceCallID, entry.parts[0].callID)
  assert.ok(!JSON.stringify(audit.contextProfile.carrier).includes("HANDOFF_CODE_LOCATION"))
})

test("same-stage repeats cannot replace handoff or references and ordinary requests preserve the prefix", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  await f.stage("issue-analysis", "ACCEPTED_HANDOFF")
  const first = await f.transform()
  const record = (await f.state()).sessions.ses_handoff.stageHandoff
  const reads = f.reads
  f.work("NEW_CODE_FINDING")
  const second = await f.transform()
  assert.deepEqual(second.slice(0, first.length), first)
  await f.stage("issue-analysis", "IGNORED_REDECLARATION_HANDOFF")
  assert.deepEqual((await f.transform())[0], first[0])
  assert.deepEqual((await f.state()).sessions.ses_handoff.stageHandoff, record)
  assert.equal(f.reads, reads, "no native history query on ordinary calls")
})

test("missing handoff preserves current history/state; explicit blank permits a transition without memory", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  await f.stage("issue-analysis", "PREVIOUS_HANDOFF")
  f.work("EXPLORATION_MUST_SURVIVE_REJECTION")
  await f.transform()
  const before = await fs.readFile(f.statePath, "utf8")
  await assert.rejects(f.stage("issue-reproduction"), /BUGFIX_HANDOFF_REQUIRED.*No stage change or history pruning/)
  assert.equal(await fs.readFile(f.statePath, "utf8"), before)
  const rejected = (await f.audit()).at(-1)
  assert.equal(rejected.decision, "rejected")
  assert.equal(rejected.historyPruning, false)
  assert.equal((await f.state()).sessions.ses_handoff.currentStageID, "issue-analysis")
  assert.match(visible(await f.transform()), /EXPLORATION_MUST_SURVIVE_REJECTION/)
  await f.stage("issue-reproduction", "")
  assert.doesNotMatch(visible(await f.transform()), /PREVIOUS_HANDOFF/)
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff, null)
  await f.stage("root-cause-localization", " \r\n ")
  await f.transform()
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff, null)
  assert.equal((await f.audit()).at(-1).currentStageID, "root-cause-localization")
})

test("malformed handoff rejects atomically before stage/state/Provider changes", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  const before = await fs.readFile(f.statePath, "utf8")
  for (const value of [null, 42, [], {}, "bad\0text"]) {
    await assert.rejects(f.stage("issue-analysis", value), /handoff/)
    assert.equal(await fs.readFile(f.statePath, "utf8"), before)
  }
})

test("native compaction restores one fixed memory and restart/repeated compaction do not mutate Carrier", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  await f.stage("issue-reproduction", "CODE_HANDOFF_CANARY")
  const initial = await f.transform()
  const initialAudit = await f.audit()
  const compacted = await f.compact()
  await f.restart()
  const restored = await f.transform(compacted)
  assert.deepEqual(restored[0], initial[0])
  assert.equal(memory(restored).length, 1)
  assert.equal(count(restored, "CODE_HANDOFF_CANARY"), 1)
  assert.match(memory(restored)[0].parts[0].text, /authority="memory"/)
  assert.match(memory(restored)[0].parts[0].text, /not verified evidence/)
  const next = f.work("NEW_TAIL")
  assert.deepEqual((await f.transform([...compacted, next])).slice(0, restored.length), restored)
  const twice = await f.compact()
  await f.restart()
  const resumed = await f.transform(twice)
  assert.deepEqual(memory(resumed), memory(restored))
  assert.deepEqual(resumed[0], initial[0])
  assert.deepEqual(await f.audit(), initialAudit, "compaction and restart do not append profiles")
  assert.equal((await f.state()).version, 9)
})

test("first post-entry compaction archives the real completed source through native history", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  const entry = await f.stage("issue-reproduction", "EARLY_COMPACTION_HANDOFF")
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff.sourceMessageID, null)
  const compacted = await f.compact()
  await f.restart()
  const result = await f.transform(compacted)
  assert.equal(count(result, "EARLY_COMPACTION_HANDOFF"), 1)
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff.sourceMessageID, entry.info.id)
  const profile = (await f.audit()).at(-1).contextProfile
  assert.deepEqual(profile.carrier, result[0])
  assert.equal(profile.handoff.mode, "restored-message")
  assert.equal(profile.handoff.content, "EARLY_COMPACTION_HANDOFF")
  assert.equal(profile.handoff.messageID, memory(result)[0].info.id)
})

test("failed, forged or modified entry Tools cannot become a restored handoff", async t => {
  const f = await fixture(t)
  const source = await f.start()
  await f.stage("project-understanding")
  const entry = await f.stage("issue-analysis", "SOURCE_TEXT")
  const before = await fs.readFile(f.statePath, "utf8")
  for (const mutate of [
    part => part.state.status = "error",
    part => part.state.status = "running",
    part => part.state.input.handoff = "different",
    part => part.state.input.stageID = "patch-generation",
    part => part.tool = "read",
  ]) {
    const invalid = structuredClone(entry)
    mutate(invalid.parts[0])
    await assert.rejects(f.transform([source, invalid]), /matching completed/)
    assert.equal(await fs.readFile(f.statePath, "utf8"), before)
  }
  assert.equal((await f.audit()).at(-1).decision, "failed")
})

test("State v9 rejects missing, corrupt, cross-Run and old-version handoff state without migration", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  await f.stage("issue-analysis", "CONTENT")
  await f.transform()
  const valid = await f.state()
  for (const mutate of [
    state => state.version = 6,
    state => state.version = 7,
    state => state.version = 8,
    state => delete state.sessions.ses_handoff.stageHandoff,
    state => state.sessions.ses_handoff.stageHandoff.content = "tampered",
    state => state.sessions.ses_handoff.stageHandoff.fromStageRunID = "stage_unknown_01",
    state => state.sessions.ses_handoff.stageHandoff.toStageRunID = "stage_unknown_02",
    state => state.sessions.ses_handoff.stageHandoff.sourceCallID = "another_call",
    state => state.sessions.ses_handoff.stageHandoff.sourceMessageID = "another_message",
    state => state.sessions.ses_handoff.stageHandoff.extra = true,
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    await fs.writeFile(f.statePath, JSON.stringify(invalid))
    await assert.rejects(f.state(), /State|state/)
  }
})

test("handoff preserves Windows/UNC paths, Unicode, CRLF and long Markdown without truncation", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  const content = "位置：C:\\代码 项目\\src\\组件.vue；\\\\server\\共享\\evidence.json\r\n" +
    "已验证事实、待验证假设、约束与按需重读条件\r\n".repeat(2000)
  await f.stage("issue-analysis", content)
  await f.transform()
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff.content, content)
  const result = await f.transform(await f.compact())
  assert.ok(memory(result)[0].parts[0].text.includes(content))
})

test("next transition carries only the newly submitted selection, not accumulated summaries", async t => {
  const f = await fixture(t)
  await f.start()
  await f.stage("project-understanding")
  await f.stage("issue-analysis", "USEFUL_UPSTREAM OLD_DISCARDED_DETAIL")
  await f.transform()
  const compacted = await f.compact()
  await f.transform(compacted)
  const entry = await f.stage("issue-reproduction", "USEFUL_UPSTREAM NEW_SELECTED_DETAIL")
  const result = await f.transform([...compacted, entry])
  assert.equal(count(result, "USEFUL_UPSTREAM"), 1)
  assert.doesNotMatch(visible(result), /OLD_DISCARDED_DETAIL/)
  assert.equal(memory(result).length, 0)
  assert.equal((await f.state()).sessions.ses_handoff.stageHandoff.fromStageRunID, "stage_issue-analysis_02")
})

test("handoff state and restored messages are isolated between eligible Sessions", async t => {
  const f = await fixture(t)
  for (const sessionID of ["ses_one", "ses_two"]) {
    await f.start(sessionID)
    await f.stage("project-understanding", undefined, sessionID)
    await f.stage("issue-analysis", `MEMORY_${sessionID}`, sessionID)
    await f.transform(f.history.filter(message => message.info.sessionID === sessionID))
    const result = await f.transform(await f.compact(sessionID))
    assert.equal(count(result, `MEMORY_${sessionID}`), 1)
    assert.doesNotMatch(visible(result), sessionID === "ses_one" ? /MEMORY_ses_two/ : /MEMORY_ses_one/)
  }
  assert.notEqual((await f.state()).sessions.ses_one.stageHandoff.content, (await f.state()).sessions.ses_two.stageHandoff.content)
})
