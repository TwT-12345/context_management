// Real OpenCode 1.2.27 integration regression of the merged plugin (stage layer on). Isolated localhost Provider only;
// validates data flow, not model summary quality or actual billing/cache usage.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertCacheDiagnostics } from "./assert-cache-diagnostics.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const registryFixture = process.env.ADAPTIVE_TEST_REGISTRY ?? path.join(root, "test/stage/fixtures/step-registry.yaml")
const opencode = process.env.OPENCODE_BIN ?? path.join(root, "node_modules", ".bin", "opencode")
assert.equal(execFileSync(opencode, ["--version"], { encoding: "utf8" }).trim(), "1.2.27")
const runtime = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-compaction-research-")))
const markers = ["CANARY_STAGE_A_SECRET", "CANARY_STAGE_B_FIRST", "CANARY_STAGE_B_SECOND"]
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const digest = (value) => createHash("sha256").update(value).digest("hex")
async function sourceManifest() {
  const result = {}
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) result[name] = digest(await fs.readFile(path.join(root, name)))
    }
  }
  await visit("src")
  return result
}
const beforeSource = await sourceManifest()

// This wrapper only observes. It delegates to the unmodified copied hook once.
const wrapperSource = `
import fs from "node:fs/promises"
import path from "node:path"
import { server } from ${JSON.stringify(path.join(root, "src", "index.ts"))}
export const ResearchTrace = async (input) => {
  const base = await server(input, { stage: ${JSON.stringify(path.join(root, "src", "stage", "default-config.json"))} })
  const trace = path.join(input.directory, ".opencode", "research-trace.jsonl")
  const state = path.join(input.directory, ".opencode", "bugfix-adaptive-context.state.json")
  const append = async event => fs.appendFile(trace, JSON.stringify(event) + "\\n")
  const snapshot = async () => { try { return JSON.parse(await fs.readFile(state, "utf8")) } catch { return null } }
  return {
    ...base,
    "experimental.session.compacting": async (i, o) => {
      await append({ type:"compacting", input:i, output:o })
      await base["experimental.session.compacting"]?.(i, o)
    },
    "experimental.chat.messages.transform": async (i, o) => {
      const sessionID = o.messages.find(m => m.info?.sessionID)?.info.sessionID
      const kind = "business"
      const before = structuredClone(o.messages)
      const stateBefore = await snapshot()
      await base["experimental.chat.messages.transform"]?.(i, o)
      await append({type:"transform", kind, sessionID, before, after:o.messages,
        stateBefore, stateAfter:await snapshot()})
    },
    event: async i => {
      if (i.event?.type === "session.compacted") await append({type:"compacted",event:i.event})
      await base.event?.(i)
    },
  }
}
`

async function runCase({ name, scenario, largeRead = false,
  resume = false, overflow = false, businessStage = "issue-analysis" }) {
  const runRoot = path.join(runtime, name)
  const workspace = path.join(runRoot, "workspace")
  const openCode = path.join(workspace, ".opencode")
  const plugins = path.join(openCode, "plugins")
  await Promise.all([plugins, path.join(openCode, "agents")]
    .map(directory => fs.mkdir(directory, { recursive: true })))
  await fs.writeFile(path.join(plugins, "research-wrapper.js"), wrapperSource)
  await fs.writeFile(path.join(openCode, "agents", "bug-fix-adaptive.md"),
    "---\ndescription: Isolated compaction dataflow probe.\nmode: all\n---\nExecute the requested research steps.\n")
  const files = ["a.txt", "b1.txt", "b2.txt"].map(file => path.join(workspace, file))
  for (let index = 0; index < files.length; index++) {
    const padding = largeRead && index === 1
      ? "\n" + Array.from({length: 800}, (_, line) => `source_code_payload_${line}`).join("\n") : ""
    await fs.writeFile(files[index], markers[index] + padding + "\n")
  }

  const workflowReferences = { registryPath: path.join(workspace, "step-registry.yaml"),
    workPlanPath: path.join(workspace, ".bugfix", "fixture", "workflow_plan.json"),
    workspaceRoot: workspace, projectRoot: workspace, issueNumber: "fixture" }
  const { workspaceRoot: _runtimeWorkspace, ...stageReferences } = workflowReferences
  await fs.copyFile(registryFixture, workflowReferences.registryPath)
  const handoff = `CODE_HANDOFF_${name}: src/code.ts::target is a fixture code reference; check actual artifacts/code before use.`
  const stage = (stageID, id) => ({ tool: "bugfix-adaptive-stage", id,
    args: { stageID, ...stageReferences, ...(id === "call_stage_b" ? { handoff } : {}) } })
  const read = (index, high = false) => ({ tool: "read", id: `call_read_${index}`, args: { filePath: files[index] }, high })
  const actions = scenario === "cross-stage"
    ? [stage("project-understanding", "call_stage_a"), read(0, true),
      stage(businessStage, "call_stage_b"), read(1, true), { text: "RESEARCH_DONE" }]
    : [stage("project-understanding", "call_stage_a"), read(0),
      stage(businessStage, "call_stage_b"), read(1, true),
      ...(resume ? [{ text: "RESEARCH_PAUSE" }] : []), read(2, true), { text: "RESEARCH_DONE" }]
  let actionIndex = 0
  let summaries = 0
  let pendingOverflow = false
  const requests = []
  const failures = []
  function respond(response, action) {
    const base = { id: `chatcmpl-${name}-${requests.length}`, object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model: "probe-model" }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const chunk = payload => response.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`)
    const delta = action.tool ? { role: "assistant", tool_calls: [{ index: 0, id: action.id,
      type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }
      : { role: "assistant", content: action.text }
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] })
    const promptTokens = action.high ? 15000 : 10
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: action.tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } })
    response.end("data: [DONE]\n\n")
  }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const finalContent = JSON.stringify(body.messages.at(-1)?.content)
        const summary = !(body.tools?.length) && finalContent.includes("bugfix-adaptive-compaction")
        const present = markers.filter(marker => JSON.stringify(body.messages).includes(marker))
        const kind = summary ? "summary" : pendingOverflow ? "overflow-error" : "business"
        requests.push({ number: requests.length + 1, kind, actionIndex,
          present, body })
        if (requests.length > 25) throw new Error("Request budget exceeded")
        if (kind === "overflow-error") {
          pendingOverflow = false
          response.writeHead(400, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "This model's maximum context length is 16384 tokens. Your messages exceed the context length.",
            type: "invalid_request_error", code: "context_length_exceeded" } }))
        } else if (summary) {
          summaries++
          // No invented facts: echo only markers actually visible in this request.
          respond(response, { text: `RESEARCH_SUMMARY_${summaries}\n${present.join("\n")}\nContinue remaining work.` })
        } else {
          const action = actions[actionIndex++] ?? { text: "RESEARCH_DONE" }
          if (overflow && action.high) {
            pendingOverflow = true
            respond(response, { ...action, high: false })
          } else respond(response, action)
        }
      } catch (error) {
        failures.push(error.stack)
        if (!response.headersSent) respond(response, { text: "RESEARCH_FAILED" })
        else response.end()
      }
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const compaction = { auto: !overflow, prune: false }
  await fs.writeFile(path.join(workspace, "opencode.json"), json({
    autoupdate: false, model: "probe/probe-model", compaction, permission: "allow",
    provider: { probe: { npm: "@ai-sdk/openai-compatible", name: "Research localhost only",
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "LOCAL_FIXTURE_NOT_A_SECRET" },
      models: { "probe-model": { name: "Probe", limit: { context: 16384, output: 2048 } } } } },
  }))
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith("OPENCODE_")) delete environment[key]
  Object.assign(environment, {
    PWD: workspace, INIT_CWD: workspace, XDG_DATA_HOME: path.join(runRoot, "data"),
    XDG_STATE_HOME: path.join(runRoot, "state"), XDG_CONFIG_HOME: path.join(runRoot, "config"),
    XDG_CACHE_HOME: path.join(runRoot, "cache"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  })
  async function runAgent(sessionID = null) {
    return await new Promise((resolve, reject) => {
      const child = spawn(opencode, ["run", "--format", "json", "--model", "probe/probe-model",
        "--agent", "bug-fix-adaptive", "--title", name,
        ...(sessionID ? ["--session", sessionID, "Continue the same current stage with the next research read."]
          : ["Complete the isolated research workflow."])],
      { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "", stderr = ""
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${name} timed out`)) }, 90000)
      child.stdout.on("data", data => stdout += data)
      child.stderr.on("data", data => stderr += data)
      child.once("error", error => { clearTimeout(timer); reject(error) })
      child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
  }
  let run, resumedRun
  try {
    run = await runAgent()
    if (resume) {
      const firstTrace = JSON.parse((await fs.readFile(path.join(openCode, "research-trace.jsonl"), "utf8")).split("\n")[0])
      resumedRun = await runAgent(firstTrace.sessionID)
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
  await fs.writeFile(path.join(runRoot, "provider-requests.json"), json(requests))
  await fs.writeFile(path.join(runRoot, "run-output.json"), json({ run, resumedRun }))
  assert.deepEqual(failures, [], `${name}: provider fixture errors`)
  assert.equal(run.code, 0, `${name}: OpenCode exit\n${run.stderr}\n${run.stdout}`)
  if (resume) assert.equal(resumedRun.code, 0)
  assert.equal(summaries, 2, `${name}: expected exactly two native compactions`)
  const traces = (await fs.readFile(path.join(openCode, "research-trace.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line))
  const sessionID = traces.find(trace => trace.type === "transform")?.sessionID
  // A regular file FD avoids the CLI's process-exit truncation of piped stdout.
  const exportFile = await fs.open(path.join(runRoot, "session-export.json"), "w")
  try {
    execFileSync(opencode, ["export", sessionID], { cwd: workspace, env: environment,
      stdio: ["ignore", exportFile.fd, "pipe"], timeout: 30000 })
  } finally { await exportFile.close() }
  const exported = await fs.readFile(path.join(runRoot, "session-export.json"), "utf8")
  JSON.parse(exported)
  const summaryRequests = requests.filter(item => item.kind === "summary")
  for (const request of summaryRequests) {
    const prompt = JSON.stringify(request.body.messages.at(-1).content)
    assert.match(prompt, /本次调用仅生成供后续继续任务使用的摘要/)
    assert.match(prompt, /不要在摘要中新增阶段推进限制或等待用户指示的要求/)
    assert.doesNotMatch(prompt, /不执行下一阶段|Resume the registered stage/)
  }
  const compactedEvents = traces.filter(item => item.type === "compacted")
  const business = requests.filter(item => item.kind === "business")
  const pluginAudit = (await fs.readFile(path.join(openCode, "bugfix-adaptive-context.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line))
  const cacheDiagnostics = await assertCacheDiagnostics(openCode, requests)
  // Evidence for 1.2.27's actual lifecycle: the FIRST Transform that observes
  // each prepared job already contains its finished native summary.
  const firstAfterCompacting = traces.filter(trace => trace.type === "transform" &&
    Object.values(trace.stateBefore?.sessions[sessionID]?.compactions ?? {}).some(record => record.status === "prepared"))
  assert.equal(firstAfterCompacting.length, 2)
  for (const trace of firstAfterCompacting) {
    const record = Object.values(trace.stateBefore.sessions[sessionID].compactions).find(record => record.status === "prepared")
    assert.ok(trace.before.some(message => message.info.summary === true && message.info.finish &&
      message.info.parentID === record.controlMessageID), "next Transform is normal continuation, not summary input")
  }
  const result = {
    name, scenario, resume, overflow, businessStage, compaction, runtime: runRoot, sessionID,
    registryFixture: path.basename(registryFixture),
    providerCalls: requests.length, summaryCalls: summaries, compactedEvents: compactedEvents.length,
    cacheDiagnostics,
    summaryProviderMarkers: summaryRequests.map(item => item.present),
    firstTransformAfterCompactingHasSummary: firstAfterCompacting.length,
    finalBusinessMarkers: business.at(-1).present,
    businessMarkerTimeline: business.map(item => ({ request: item.number, actionIndex: item.actionIndex, present: item.present })),
    profileAuditRecords: pluginAudit.filter(item => item.type === "bugfix-adaptive-stage-context").length,
    auditBytes: (await fs.stat(path.join(openCode, "bugfix-adaptive-context.jsonl"))).size,
    rawSessionMarkers: markers.filter(marker => exported.includes(marker)),
  }
  assert.equal(compactedEvents.length, 2)
  assert.equal(requests.length, (scenario === "cross-stage" ? 7 : resume ? 9 : 8) + (overflow ? 2 : 0),
    "No additional model calls beyond the scripted business, native summary and intentional overflow requests")
  if (overflow) assert.equal(requests.filter(request => request.kind === "overflow-error").length, 2)
  if (scenario === "cross-stage") {
    assert.ok(business.some(item => item.actionIndex === 3 && !item.present.includes(markers[0])), "stage B initially prunes stage A")
    assert.ok(result.finalBusinessMarkers.includes(markers[0]), "unmodified native summary can carry older-stage memory")
  } else {
    assert.ok(result.finalBusinessMarkers.includes(markers[1]), "B1 survives repeated compaction/restart")
    assert.ok(result.finalBusinessMarkers.includes(markers[2]), "B2 reaches final business context")
  }
  const saved = JSON.parse(await fs.readFile(path.join(openCode, "bugfix-adaptive-context.state.json"), "utf8"))
  assert.equal(saved.version, 9)
  assert.equal(Object.keys(saved.sessions).length, 1)
  const session = saved.sessions[sessionID]
  assert.equal(session.stageSequence, 2)
  assert.equal(session.currentStageID, businessStage)
  assert.equal(session.stageHandoff.content, handoff)
  assert.equal(session.stageHandoff.fromStageRunID, "stage_project-understanding_01")
  assert.ok(session.stageHandoff.sourceMessageID)
  assert.equal(session.contextProfile.registrySha256, digest(await fs.readFile(registryFixture, "utf8")))
  assert.deepEqual(session.observations, [])
  assert.deepEqual(session.observationRequests, [])
  assert.equal(Object.values(session.compactions).filter(record => record.status === "completed").length, 2)
  assert.ok(Object.values(session.compactions).every(record => record.inputIsolation === "native-unscoped"))
  assert.equal(pluginAudit.length, 2, "only stage entries write profiles, not compaction or ordinary calls")
  assert.ok(pluginAudit.every(event => event.type === "bugfix-adaptive-stage-context"))
  for (const event of pluginAudit) {
    assert.equal(event.scope, "stage-entry-context")
    const carrier = event.contextProfile.carrier
    assert.ok(traces.some(trace => trace.type === "transform" && trace.after.some(message =>
      JSON.stringify(message) === JSON.stringify(carrier))), "audit must record the actual projected Carrier")
    const data = JSON.parse(carrier.parts[0].text.split("\n\n")[1])
    assert.equal(data.instructions.length, 3)
    assert.equal(data.registryConfiguration.workflowRules.step_order, undefined)
    assert.equal(data.registryConfiguration.registrySha256, undefined)
  }
  assert.equal(pluginAudit.at(-1).contextProfile.handoff.content, handoff)
  assert.equal(pluginAudit.at(-1).contextProfile.handoff.sourceCallID, session.stageHandoff.sourceCallID)
  assert.ok(traces.some(trace => trace.type === "transform" && trace.after.some(message => message.info.summary === true)))
  assert.ok(!pluginAudit.some(event => event.phase === "head-projected" || event.phase === "rejected"))
  assert.ok(!pluginAudit.some(event => event.decision === "failed"))
  const finalRequest = JSON.stringify(business.at(-1).body.messages)
  assert.equal(finalRequest.split(`CODE_HANDOFF_${name}`).length - 1, 1)
  assert.match(finalRequest, /<bugfix-adaptive-handoff /)
  assert.ok(traces.some(trace => trace.type === "transform" && trace.after.some(message =>
    message.parts.some(part => part.tool === "bugfix-adaptive-stage" && part.state?.input?.handoff === handoff))))
  assert.doesNotMatch(JSON.stringify(pluginAudit), /beforeMessages|afterMessages|CANARY_STAGE_[AB]/)
  result.codeHandoffRestoredOnce = true
  result.exactCarrierAndHandoffLogged = true
  result.providerBoilerplateFiltered = true
  assert.match(finalRequest, /<bugfix-adaptive-context /)
  assert.match(finalRequest, /RESEARCH_SUMMARY_2/)
  for (const location of Object.values(workflowReferences)) assert.ok(finalRequest.includes(location))
  if (businessStage === "issue-reproduction") assert.match(finalRequest, /Complete the isolated research workflow/)
  const carrierGroups = new Map()
  for (const trace of traces.filter(trace => trace.type === "transform")) {
    for (const message of trace.after.filter(message => message.parts.some(part => part.text?.startsWith("<bugfix-adaptive-context ")))) {
      const group = carrierGroups.get(message.info.id) ?? new Set()
      group.add(JSON.stringify(message))
      carrierGroups.set(message.info.id, group)
    }
  }
  assert.ok([...carrierGroups.values()].every(group => group.size === 1), "same-stage Carrier byte stability")
  assert.ok(requests.filter(request => request.kind === "summary").every(request =>
    !JSON.stringify(request.body.messages).includes("<bugfix-adaptive-context ")), "no business Carrier in summary calls")
  await fs.writeFile(path.join(runRoot, "result.json"), json(result))
  console.log(JSON.stringify(result))
  return result
}

console.log(`Research runtime: ${runtime}`)
const cases = [
  { name: "native-cross-stage", scenario: "cross-stage" },
  { name: "native-same-stage", scenario: "same-stage" },
  { name: "native-process-resume", scenario: "same-stage", resume: true },
  { name: "native-large-read", scenario: "same-stage", largeRead: true },
  { name: "native-provider-overflow", scenario: "same-stage", overflow: true },
  { name: "native-reproduction", scenario: "same-stage", businessStage: "issue-reproduction" },
]
const selected = process.env.RESEARCH_CASES?.split(",")
const results = []
for (const entry of cases) if (!selected || selected.includes(entry.name)) results.push(await runCase(entry))
const afterSource = await sourceManifest()
assert.deepEqual(afterSource, beforeSource, "Research must not modify production plugin source, prompt, Registry or zips")
await fs.writeFile(path.join(runtime, "source-manifest.json"), json(beforeSource))
await fs.writeFile(path.join(runtime, "results.json"), json({ runtime, opencodeVersion: "1.2.27", results, sourceUnchanged: true }))
console.log(`ALL_COMPACTION_E2E_PASSED ${runtime}/results.json`)
