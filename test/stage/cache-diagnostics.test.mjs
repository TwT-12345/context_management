import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"
import { compareMessages, createCacheDiagnostics, describeWireBody, fingerprint } from "../../src/stage/cache-diagnostics.mjs"

const session = (id = "ses_a", stage = "issue-reproduction") => ({
  sessionID: id, currentStageID: stage, currentStageRunID: `stage_${stage}_01`,
})
const carrier = (id = "ses_a", stage = "issue-reproduction") =>
  `<bugfix-adaptive-context stage="${stage}">TASK_${id}</bugfix-adaptive-context>`
const native = (text = carrier()) => [{
  info: { id: "msg_carrier", role: "user" }, parts: [{ type: "text", text }],
}]
const body = (text = carrier()) => ({
  model: "fixture-model", messages: [{ role: "system", content: "SYSTEM_SECRET" }, { role: "user", content: text }],
  tools: [{ type: "function", function: { name: "mcp_read", description: "TOOL_DESCRIPTION_SECRET", parameters: { type: "object" } } }],
})
function fixture(options = {}) {
  const events = [], sent = []
  const result = { status: 200, body: "untouched response" }
  const fetch = function(...args) { sent.push({ args, receiver: this }); return Promise.resolve(result) }
  const diagnostics = createCacheDiagnostics({ append: async event => events.push(event), ...options })
  const providerConfig = { provider: { fixture: { options: { fetch } } } }
  diagnostics.configure(providerConfig)
  const request = async value => {
    const init = { method: "POST", headers: { Authorization: "Bearer KEY_SECRET" }, body: JSON.stringify(value) }
    assert.equal(await providerConfig.provider.fixture.options.fetch("https://fixture.invalid/v1/chat/completions?api_key=URL_SECRET", init), result)
    assert.equal(sent.at(-1).args[1], init, "fetch init must be the original object")
    assert.equal(sent.at(-1).args[1].body, JSON.stringify(value))
  }
  return { diagnostics, providerConfig, events, sent, result, request }
}

test("fingerprints measure UTF-8 JSON without retaining prompt text", () => {
  const value = { text: "中文\r\nsource" }
  const stats = fingerprint(value)
  assert.equal(stats.serializedCharacters, JSON.stringify(value).length)
  assert.equal(stats.serializedBytes, Buffer.byteLength(JSON.stringify(value), "utf8"))
  assert.equal(stats.sha256.length, 64)
  assert.deepEqual(Object.keys(stats).sort(), ["serializedBytes", "serializedCharacters", "sha256"])
  assert.notEqual(fingerprint({ a: 1, b: 2 }).sha256, fingerprint({ b: 2, a: 1 }).sha256)
})

test("message comparison separates baseline, append, replacement, deletion and equality", () => {
  const a = { ...fingerprint("a"), role: "user" }, b = { ...fingerprint("b"), role: "assistant" }
  assert.equal(compareMessages(null, [a]).kind, "unavailable")
  assert.equal(compareMessages([a], null).kind, "unavailable")
  assert.equal(compareMessages([a], [a, b]).kind, "appended")
  assert.equal(compareMessages([a], [a, b]).firstChangedIndex, 1)
  assert.equal(compareMessages([a, b], [a, a]).kind, "replaced")
  assert.equal(compareMessages([a, b], [a]).kind, "removed")
  assert.equal(compareMessages([a], [a]).firstChangedIndex, null)
})

test("wire snapshots cover Chat, Anthropic, Responses, Gemini and Bedrock tool definitions", () => {
  const chat = describeWireBody(body())
  assert.equal(chat.format, "messages")
  assert.equal(chat.messages.count, 2)
  assert.deepEqual(chat.toolOrder, ["mcp_read"])
  const anthropic = describeWireBody({ system: [{ type: "text", text: "sys" }], messages: [], tools: [{ name: "read", input_schema: {} }] })
  assert.deepEqual(anthropic.toolOrder, ["read"])
  const responses = describeWireBody({ instructions: "sys", input: "user", tools: [{ type: "function", name: "search" }] })
  assert.equal(responses.format, "responses")
  assert.equal(responses.messages.count, 1)
  const gemini = describeWireBody({ systemInstruction: { parts: [{ text: "sys" }] }, contents: [], tools: [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }] })
  assert.deepEqual(gemini.toolOrder, ["a", "b"])
  const bedrock = describeWireBody({ system: [{ text: "sys" }], messages: [], toolConfig: { tools: [{ toolSpec: { name: "read" } }] } })
  assert.deepEqual(bedrock.toolOrder, ["read"])
  assert.equal(describeWireBody({ embedding: [1, 2] }), null)
})

test("same-stage wire history is append-only; unchanged tool order is referenced, not repeated", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  await f.diagnostics.system({ sessionID: "ses_a", model: { providerID: "fixture", id: "fixture-model" } }, { system: ["SYSTEM_SECRET"] })
  await f.request(body())
  const next = body()
  next.messages.push({ role: "assistant", content: "NEW_MESSAGE_SECRET" })
  f.diagnostics.projection(session(), [...native(), { info: { id: "msg_new", role: "assistant" }, parts: [{ type: "text", text: "NEW_MESSAGE_SECRET" }] }])
  await f.request(next)
  const hook = f.events[0], first = f.events[1], second = f.events[2]
  assert.equal(hook.layer, "system-transform-hook")
  assert.equal(hook.tools.available, false)
  assert.equal(hook.transportObservation, "not-observed")
  assert.equal(first.hookRequestID, hook.requestID)
  assert.equal(first.layer, "provider-fetch-input")
  assert.equal(first.finalHttpBodyGuaranteed, false)
  assert.equal(first.downstreamCustomFetch, true)
  assert.deepEqual(first.toolOrder, ["mcp_read"])
  assert.equal(second.toolOrder, null)
  assert.equal(second.toolOrderFromRequestID, first.requestID)
  assert.equal(second.changes.toolsChanged, false)
  assert.equal(second.changes.systemChanged, false)
  assert.equal(second.changes.messages.kind, "appended")
  assert.equal(second.changes.messages.firstChangedIndex, 2)
  assert.doesNotMatch(JSON.stringify(f.events), /SYSTEM_SECRET|TOOL_DESCRIPTION_SECRET|NEW_MESSAGE_SECRET|KEY_SECRET|URL_SECRET/)
})

test("detects historical tool-output replacement, tool reorder, changed System and cache options", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  const initial = body()
  initial.tools.push({ type: "function", function: { name: "mcp_search" } })
  initial.messages.push({ role: "tool", tool_call_id: "call_read", content: "ORIGINAL_SOURCE_SECRET" })
  await f.request(initial)
  const next = structuredClone(initial)
  next.messages[2].content = "[Old tool result content cleared]"
  next.messages[0].content = "NEW_SYSTEM_SECRET"
  next.tools.reverse()
  next.reasoning_effort = "high"
  await f.request(next)
  const event = f.events.at(-1)
  assert.equal(event.changes.messages.firstChangedIndex, 0)
  assert.equal(event.changes.systemChanged, true)
  assert.equal(event.changes.toolsChanged, true)
  assert.equal(event.changes.cacheSettingsChanged, true)
  assert.deepEqual(event.toolOrder, ["mcp_search", "mcp_read"])
  next.messages[2].content = "NEW_TOOL_OUTPUT"
  await f.request(next)
  assert.equal(f.events.at(-1).changes.messages.firstChangedIndex, 2)
  assert.doesNotMatch(JSON.stringify(f.events), /ORIGINAL_SOURCE_SECRET|NEW_SYSTEM_SECRET|NEW_TOOL_OUTPUT/)
})

test("stage transition compares against the prior stage without changing the body", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  await f.request(body())
  const nextStage = "root-cause-localization"
  f.diagnostics.projection(session("ses_a", nextStage), native(carrier("ses_a", nextStage)))
  await f.request(body(carrier("ses_a", nextStage)))
  const event = f.events.at(-1)
  assert.equal(event.currentStageID, nextStage)
  assert.equal(event.changes.messages.firstChangedIndex, 1)
  assert.equal(event.changes.systemChanged, false)
  assert.equal(event.changes.toolsChanged, false)
})

test("native summary is recorded separately and subsequent business history is compared honestly", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  await f.request(body())
  const reminder = "<bugfix-adaptive-compaction>SUMMARY_REMINDER_SECRET</bugfix-adaptive-compaction>"
  f.diagnostics.compaction(session(), reminder)
  await f.diagnostics.system({ sessionID: "ses_a", model: { providerID: "fixture", id: "fixture-model" } }, { system: ["SUMMARY_SYSTEM"] })
  const summary = { model: "fixture-model", messages: [{ role: "user", content: `Native summary request\n${reminder}` }], tools: [] }
  await f.request(summary)
  assert.equal(f.events.at(-1).requestKind, "native-compaction")
  assert.equal(f.events.at(-1).tools.count, 0)
  assert.equal(f.events.at(-1).changes.systemChanged, true)
  assert.equal(f.events.at(-2).messages.available, false)
  f.diagnostics.projection(session(), native())
  await f.request(body())
  assert.equal(f.events.at(-1).requestKind, "business")
  assert.equal(f.events.at(-1).changes.toolsChanged, true)
  assert.doesNotMatch(JSON.stringify(f.events), /SUMMARY_REMINDER_SECRET/)
})

test("Session and model comparison baselines never cross-contaminate", async () => {
  const f = fixture()
  f.diagnostics.projection(session("ses_a"), native(carrier("ses_a")))
  await f.request(body(carrier("ses_a")))
  f.diagnostics.projection(session("ses_b"), native(carrier("ses_b")))
  await f.request(body(carrier("ses_b")))
  assert.equal(f.events.at(-1).previousRequestID, null)
  await f.request({ ...body(carrier("ses_a")), model: "another-model" })
  assert.equal(f.events.at(-1).previousRequestID, null)
  await f.request(body(carrier("ses_a")))
  assert.notEqual(f.events.at(-1).previousRequestID, null)
})

test("ambiguous identical Carriers and unrelated requests are not attributed to a guessed Session", async () => {
  const f = fixture()
  f.diagnostics.projection(session("ses_a"), native())
  f.diagnostics.projection(session("ses_b"), native())
  await f.request(body())
  await f.request(body("unrelated agent"))
  assert.equal(f.events.length, 2)
  assert.deepEqual(f.events.map(event => event.observedSessionID), [null, null])
  assert.deepEqual(f.events.map(event => event.correlation), ["ambiguous", "unattributed"])
  assert.equal(f.events[1].previousRequestID, null)
  assert.equal(f.events[1].transportPreviousRequestID, f.events[0].requestID)
  assert.equal(f.sent.length, 2)
})

test("large output does not appear in logs or make per-request diagnostic records grow with history", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  const request = body()
  request.messages.push({ role: "tool", content: "HUGE_CONTENT_SECRET".repeat(100000) })
  for (let index = 0; index < 5; index++) {
    await f.request(request)
    request.messages.push({ role: "assistant", content: "MORE_CONTENT_SECRET".repeat(10000) })
  }
  assert.ok(f.events.every(event => JSON.stringify(event).length < 5000))
  assert.doesNotMatch(JSON.stringify(f.events), /HUGE_CONTENT_SECRET|MORE_CONTENT_SECRET/)
})

test("large MCP definitions are fingerprinted; stable tool names aren't expanded every turn", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  const request = body()
  request.tools = Array.from({ length: 1000 }, (_, index) => ({
    type: "function", function: { name: `mcp_fixture_${index}`, description: "SCHEMA_CONTENT_SECRET".repeat(50), parameters: { type: "object" } },
  }))
  await f.request(request)
  await f.request(request)
  assert.equal(f.events[0].tools.count, 1000)
  assert.ok(f.events[0].tools.serializedBytes > 1000000)
  assert.equal(f.events[0].toolOrder.length, 1000)
  assert.equal(f.events[1].toolOrder, null)
  assert.ok(JSON.stringify(f.events[1]).length < 4000)
  assert.doesNotMatch(JSON.stringify(f.events), /SCHEMA_CONTENT_SECRET/)
})

test("forgetting a non-target Session removes attribution and its old comparison baseline", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  await f.request(body())
  f.diagnostics.forget("ses_a")
  await f.diagnostics.system({ sessionID: "ses_a", model: { providerID: "fixture", id: "fixture-model" } }, { system: ["unrelated agent"] })
  await f.request(body())
  assert.equal(f.events.length, 2)
  assert.equal(f.events.at(-1).observedSessionID, null)
  f.diagnostics.projection(session(), native())
  await f.request(body())
  assert.equal(f.events.at(-1).previousRequestID, null)
})

test("diagnostic write failure cannot block fetch or expose exception details", async () => {
  const original = console.warn, warnings = []
  console.warn = message => warnings.push(message)
  try {
    const f = fixture({ append: async () => { throw new Error("API_KEY_SECRET") } })
    f.diagnostics.projection(session(), native())
    await f.request(body())
    await f.request(body())
    assert.equal(f.sent.length, 2)
    assert.equal(warnings.length, 1)
    assert.doesNotMatch(warnings[0], /API_KEY_SECRET/)
  } finally { console.warn = original }
})

test("preserves fetch receiver, abort signal, Request bodies and delegate failures", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  const options = f.providerConfig.provider.fixture.options
  const signal = new AbortController().signal
  const request = new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(body()) })
  const init = { signal }
  await options.fetch(request, init)
  assert.equal(request.bodyUsed, false)
  assert.equal(f.sent[0].receiver, options)
  assert.equal(f.sent[0].args[1].signal, signal)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].layer, "provider-fetch-unavailable")
  const error = new Error("original network failure")
  const provider = { provider: { fixture: { options: { fetch: async () => { throw error } } } } }
  f.diagnostics.configure(provider)
  await assert.rejects(provider.provider.fixture.options.fetch("https://fixture.invalid", { body: JSON.stringify(body()) }), value => value === error)
})

test("disabled diagnostics and repeated configuration leave existing fetch intact", async () => {
  const f = fixture({ enabled: false })
  const original = f.providerConfig.provider.fixture.options.fetch
  f.diagnostics.configure(f.providerConfig)
  assert.equal(f.providerConfig.provider.fixture.options.fetch, original)
  f.diagnostics.projection(session(), native())
  await f.request(body())
  assert.deepEqual(f.events, [])
  const active = fixture()
  const once = active.providerConfig.provider.fixture.options.fetch
  active.diagnostics.configure(active.providerConfig)
  assert.equal(active.providerConfig.provider.fixture.options.fetch, once)
})

test("plugin keeps cache diagnostics in a separate file without modifying projection or State", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-cache-diagnostics-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const oc = path.join(root, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(new URL("../../src/stage/default-config.json", import.meta.url), path.join(oc, "bugfix-adaptive-context.config.json"))
  const hooks = await BugfixAdaptiveContext({ directory: root })
  const output = { messages: [{ info: { id: "msg_user", sessionID: "ses_a", agent: "bug-fix-adaptive", role: "user" }, parts: [{ type: "text", text: "USER_TASK_SECRET" }] }] }
  await hooks["experimental.chat.messages.transform"]({}, output)
  const statePath = path.join(oc, "bugfix-adaptive-context.state.json")
  const beforeState = await fs.readFile(statePath, "utf8"), beforeMessages = structuredClone(output)
  const system = { system: ["SYSTEM_SECRET"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_a", model: { providerID: "fixture", id: "fixture-model" } }, system)
  assert.deepEqual(system, { system: ["SYSTEM_SECRET"] })
  assert.deepEqual(output, beforeMessages)
  assert.equal(await fs.readFile(statePath, "utf8"), beforeState)
  const events = (await fs.readFile(path.join(oc, "bugfix-adaptive-cache.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, "bugfix-adaptive-projection-decision")
  assert.equal(events[0].decision, "projected")
  assert.equal(events[1].layer, "system-transform-hook")
  assert.doesNotMatch(JSON.stringify(events), /USER_TASK_SECRET|SYSTEM_SECRET/)
  assert.match(await fs.readFile(path.join(oc, ".gitignore"), "utf8"), /bugfix-adaptive-cache.jsonl/)
})

async function pluginFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-projection-decisions-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const oc = path.join(root, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(new URL("../../src/stage/default-config.json", import.meta.url), path.join(oc, "bugfix-adaptive-context.config.json"))
  const hooks = await BugfixAdaptiveContext({ directory: root })
  const sent = []
  const config = { provider: { fixture: { options: { fetch: async (...args) => { sent.push(args); return new Response("ok") } } } } }
  await hooks.config(config)
  const message = (id, agent = "bug-fix-adaptive", synthetic = false) => ({
    info: { id, sessionID: "ses_a", role: "user", ...(agent ? { agent } : {}) },
    parts: [{ type: "text", text: "TASK_CONTENT_SECRET", synthetic }],
  })
  const model = { providerID: "fixture", id: "fixture-model" }
  const events = async () => (await fs.readFile(path.join(oc, "bugfix-adaptive-cache.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  const run = async (messages, runtimeAgent = "bug-fix-adaptive") => {
    const output = { messages: structuredClone(messages) }
    await hooks["experimental.chat.messages.transform"]({}, output)
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_a", model }, { system: ["SYSTEM_SECRET"] })
    await hooks["chat.params"]({ sessionID: "ses_a", model, agent: { name: runtimeAgent }, message: messages[0].info }, {})
    // No Carrier on a skipped projection; the existing header is not required for logging.
    await config.provider.fixture.options.fetch("https://fixture.invalid/v1/chat/completions", {
      body: JSON.stringify({ ...body(), messages: output.messages.map(msg => ({ role: msg.info.role, content: msg.parts.map(part => part.text).join("\n") })) }),
    })
    return output
  }
  return { hooks, message, events, run, oc, model, config, sent }
}

test("logs projected → skipped synthetic metadata → projected without assuming a runtime Agent switch", async t => {
  const f = await pluginFixture(t)
  const source = f.message("msg_001")
  await f.run([source])
  const skipped = await f.run([source, f.message("msg_999", "build", true)])
  assert.deepEqual(skipped.messages, [source, f.message("msg_999", "build", true)], "business skip behavior is unchanged")
  await f.run([source])
  const events = await f.events()
  const decisions = events.filter(event => event.type === "bugfix-adaptive-projection-decision")
  assert.deepEqual(decisions.map(event => event.decision), ["projected", "skipped", "projected"])
  assert.equal(decisions[1].reason, "non-target-agent")
  assert.equal(decisions[1].selectedUser.messageID, "msg_999")
  assert.equal(decisions[1].selectedUser.synthetic, true)
  const runtime = events.filter(event => event.type === "bugfix-adaptive-runtime-agent")
  assert.deepEqual(runtime.map(event => event.runtimeAgent), Array(3).fill("bug-fix-adaptive"))
  assert.equal(runtime[1].agentMatchesSelection, false)
  assert.equal(runtime[1].projectionID, decisions[1].projectionID)
  assert.equal(runtime[1].runtimeMessage.messageID, "msg_001", "chat.params User info is not wrapped in info")
  assert.equal(runtime[1].runtimeMessage.agent, "bug-fix-adaptive")
  assert.equal(runtime[1].runtimeMessage.synthetic, null, "chat.params does not expose Parts")
  const wire = events.filter(event => event.layer === "provider-fetch-input")
  assert.equal(wire.length, 3)
  assert.equal(wire[1].observedSessionID, null)
  assert.equal(wire[1].correlation, "unattributed")
  assert.equal(wire[1].transportChanges.messages.firstChangedIndex, 0)
  assert.equal(wire[2].transportChanges.messages.firstChangedIndex, 0)
  assert.equal(wire[2].transportPreviousRequestID, wire[1].requestID)
  assert.equal(wire[2].previousRequestID, wire[0].requestID, "skip must not erase the known Session baseline")
  assert.doesNotMatch(JSON.stringify(events), /TASK_CONTENT_SECRET|SYSTEM_SECRET/)
})

test("missing User agent is logged; System does not reuse a stale projected snapshot", async t => {
  const f = await pluginFixture(t)
  await f.run([f.message("msg_001")])
  await f.run([f.message("msg_001", null)])
  let events = await f.events()
  const decision = events.findLast(event => event.type === "bugfix-adaptive-projection-decision")
  assert.equal(decision.reason, "no-agent-bearing-user")
  assert.equal(decision.selectedUser, null)
  const system = events.findLast(event => event.layer === "system-transform-hook")
  assert.equal(system.projectionDecision, "skipped")
  assert.equal(system.projectionID, decision.projectionID)
  assert.equal(system.changes.messages.firstChangedIndex, 0)
  await f.hooks["experimental.chat.system.transform"]({ sessionID: "ses_a", model: f.model }, { system: ["SYSTEM_SECRET"] })
  await f.hooks["chat.params"]({ sessionID: "ses_a", model: f.model, agent: "bug-fix-adaptive" }, {})
  events = await f.events()
  const unobserved = events.findLast(event => event.layer === "system-transform-hook")
  assert.equal(unobserved.projectionID, null)
  assert.equal(unobserved.messages.available, false)
  assert.equal(unobserved.changes.messages.kind, "unavailable")
})

test("real Agent switch and textless activation are logged without activating projection", async t => {
  const f = await pluginFixture(t)
  const input = f.message("msg_001", "build")
  assert.deepEqual((await f.run([input], "build")).messages, [input])
  const synthetic = f.message("msg_002", "bug-fix-adaptive", true)
  assert.deepEqual((await f.run([synthetic])).messages, [synthetic])
  const events = await f.events()
  assert.deepEqual(events.filter(event => event.type === "bugfix-adaptive-projection-decision").map(event => event.reason),
    ["non-target-agent", "target-agent-user-message-has-no-text"])
  assert.equal(events.find(event => event.type === "bugfix-adaptive-runtime-agent").agentMatchesSelection, true)
  await assert.rejects(fs.access(path.join(f.oc, "bugfix-adaptive-context.state.json")))
})

test("projection failure is logged and still rethrows instead of silently passing raw messages", async t => {
  const f = await pluginFixture(t)
  const foreign = f.message("msg_002")
  foreign.info.sessionID = "ses_b"
  const output = { messages: [f.message("msg_001"), foreign] }, before = structuredClone(output)
  await assert.rejects(f.hooks["experimental.chat.messages.transform"]({}, output), /exactly one identifiable Session/)
  assert.deepEqual(output, before)
  const decision = (await f.events()).at(-1)
  assert.equal(decision.decision, "failed")
  assert.equal(decision.observedSessionID, null)
  assert.equal(decision.reason, "projection-exception-rethrown")
})

test("stage diagnostics record the persisted boundary commit and idempotent declaration", async t => {
  const f = await pluginFixture(t)
  await f.run([f.message("msg_001")])
  const declare = (stageID, callID, handoff) => f.hooks["tool.execute.before"]({
    tool: "bugfix-adaptive-stage", sessionID: "ses_a", callID,
  }, { args: { stageID, ...(handoff === undefined ? {} : { handoff }) } })
  await declare("project-understanding", "call_first")
  await declare("project-understanding", "call_repeat")
  await assert.rejects(declare("issue-analysis", "call_missing"), /handoff/)
  await declare("issue-analysis", "call_next", "HANDOFF_SECRET")
  const events = (await f.events()).filter(event => event.type === "bugfix-adaptive-stage-decision")
  assert.deepEqual(events.map(event => event.decision), ["committed", "idempotent", "rejected", "committed"])
  assert.equal(events[1].after.boundary.enteredAfterToolCallID, "call_first")
  assert.equal(events[2].statePersisted, false)
  assert.equal(events[3].before.currentStageID, "project-understanding")
  assert.equal(events[3].after.boundary.enteredAfterToolCallID, "call_next")
  assert.equal(events[3].after.boundary.messageID, null, "boundary resolves on the next transform, not at commit")
  assert.doesNotMatch(JSON.stringify(events), /HANDOFF_SECRET/)
})

test("existing Session header attributes raw requests; conflicting markers are not guessed", async () => {
  const f = fixture()
  f.diagnostics.projection(session(), native())
  const fetch = f.providerConfig.provider.fixture.options.fetch
  await fetch("https://fixture.invalid/chat", { headers: { "x-opencode-session": "ses_a" }, body: JSON.stringify(body("RAW_SECRET")) })
  assert.equal(f.events.at(-1).correlation, "existing-session-header")
  assert.equal(f.events.at(-1).observedSessionID, "ses_a")
  f.diagnostics.projection(session("ses_b"), native(carrier("ses_b")))
  await fetch("https://fixture.invalid/chat", { headers: { "x-opencode-session": "ses_b" }, body: JSON.stringify(body()) })
  assert.equal(f.events.at(-1).correlation, "ambiguous")
  assert.equal(f.events.at(-1).observedSessionID, null)
  assert.doesNotMatch(JSON.stringify(f.events), /RAW_SECRET/)
})
