import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { optionalRealProvider } from "./real-provider.mjs"
import { assertCacheDiagnostics } from "./assert-cache-diagnostics.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const registryFixture = process.env.ADAPTIVE_TEST_REGISTRY ?? path.join(root, "test/stage/fixtures/step-registry.yaml")
const realProvider = await optionalRealProvider()
const probeMissingHandoff = process.env.ADAPTIVE_TEST_MISSING_HANDOFF === "1"
const opencode = process.env.OPENCODE_BIN ?? path.join(root, "node_modules", ".bin", "opencode")
assert.equal(execFileSync(opencode, ["--version"], { encoding: "utf8" }).trim(), "1.2.27")

const runtime = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-context-e2e-")))
const workspace = path.join(runtime, "workspace")
const openCode = path.join(workspace, ".opencode")
const tools = path.join(openCode, "tools")
const agents = path.join(openCode, "agents")
await Promise.all([
  fs.mkdir(tools, { recursive: true }),
  fs.mkdir(agents, { recursive: true }),
  fs.mkdir(path.join(workspace, "src"), { recursive: true }),
])
await fs.writeFile(
  path.join(agents, "bug-fix-adaptive.md"),
  [
    "---",
    "description: Adaptive projection E2E main or child agent.",
    "mode: all",
    "---",
    "# Adaptive Bug Fix E2E",
    // Deliberately no plugin handshake: its instructions must be injected.
    "Execute the Adaptive workflow selected by the prompt and Work Plan.",
    "In project-understanding, once workspace initialization is complete, the next business action is to load the codebase-structure skill with the skill Tool. Do not initialize again after a completed initialization result.",
    "Remain in this child Session until the final patch stage completes.",
  ].join("\n"),
)
const fixtureSkill = path.join(openCode, "skills", "codebase-structure")
await fs.mkdir(fixtureSkill, { recursive: true })
await fs.writeFile(path.join(fixtureSkill, "SKILL.md"), "---\nname: codebase-structure\ndescription: Project understanding fixture.\n---\nPROJECT_UNDERSTANDING_SKILL_CANARY\nThis fixture confirms skill loading only; do not execute external commands.\n")
await fs.writeFile(path.join(tools, "initialize-bugfix-workspace.js"), [
  'import { tool } from "@opencode-ai/plugin"',
  'export default tool({description:"Initialize this isolated fixture workspace.",args:{mode:tool.schema.string()},async execute(){return "BOOTSTRAP_COMPLETED"}})',
].join("\n"))

const stageTwoFile = path.join(workspace, "stage-two.txt")
const startupFile = path.join(workspace, "startup-context.txt")
// Deliberately outside the project and outside .opencode. Paths come only from
// the Stage Tool, not from Registry discovery/output parsing in the plugin.
const registryPath = path.join(runtime, "Agent 配置", "workflow", "step-registry.yaml")
const workPlanPath = path.join(workspace, ".bugfix", "#问题-123", "workflow_plan.json")
const workflowReferences = {
  registryPath, workPlanPath, workspaceRoot: workspace, projectRoot: workspace, issueNumber: "#问题-123",
}
const { workspaceRoot: _runtimeWorkspace, ...stageReferences } = workflowReferences
await fs.mkdir(path.dirname(registryPath), { recursive: true })
await fs.copyFile(registryFixture, registryPath)
const largeFile = path.join(workspace, "src", "large-source.txt")
await fs.writeFile(stageTwoFile, "STAGE_TWO_EXPLORATION_CANARY\n")
await fs.writeFile(startupFile, "REGISTRY_BOOTSTRAP_STARTUP_CANARY\n")
await fs.writeFile(
  largeFile,
  Array.from({ length: 5000 }, (_, index) => `LARGE_SOURCE_${index}`).join("\n"),
)

const providerRequests = []
function begin(response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  return {
    id: "chatcmpl-adaptive",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "probe-model",
  }
}
function chunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}
function tool(response, id, name, args) {
  const base = begin(response)
  chunk(response, {
    ...base,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })
  chunk(response, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  response.end("data: [DONE]\n\n")
}
function text(response, content) {
  const base = begin(response)
  chunk(response, {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })
  chunk(response, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  response.end("data: [DONE]\n\n")
}

const toolContent = (message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)
const skillLoaded = (body) => body.messages.some((message) => message.role === "tool" && toolContent(message)?.includes("PROJECT_UNDERSTANDING_SKILL_CANARY"))
const registrationVisible = (body) => body.messages.some((message) => message.role === "tool" && toolContent(message)?.includes("registration is complete")) &&
  body.messages.some((message) => message.role === "user" && toolContent(message)?.includes('"stageDeclarationStatus":"registered"')) &&
  JSON.stringify(body.messages).includes("BOOTSTRAP_COMPLETED")
let missingAcknowledgments = 0
function projectBusinessAction(response, body) {
  if (!registrationVisible(body)) {
    if (++missingAcknowledgments > 3) throw new Error("Missing stage acknowledgment would cause a repeated-declaration loop")
    tool(response, `call_ack_retry_${missingAcknowledgments}`, "bugfix-adaptive-stage", { stageID: "project-understanding" })
    return false
  }
  tool(response, "call_business_skill", "skill", { name: "codebase-structure" })
}
const actions = [
  (response) => tool(response, "call_task", "task", {
    description: "Run adaptive bug fix E2E",
    prompt: "FULL_AUTO ADAPTIVE_ISSUE_SOURCE_CANARY",
    subagent_type: "bug-fix-adaptive",
  }),
  (response) => tool(response, "call_startup_context", "read", { filePath: startupFile }),
  (response) => tool(response, "call_stage_project", "bugfix-adaptive-stage", { stageID: "project-understanding", ...stageReferences }),
  (response) => tool(response, "call_bootstrap", "initialize-bugfix-workspace", { mode: "single" }),
  (response) => tool(response, "call_project_repeat_1", "bugfix-adaptive-stage", { stageID: "project-understanding" }),
  (response) => tool(response, "call_project_repeat_2", "bugfix-adaptive-stage", { stageID: "project-understanding" }),
  (response) => tool(response, "call_project_repeat_3", "bugfix-adaptive-stage", { stageID: "project-understanding" }),
  projectBusinessAction,
  (response) => tool(response, "call_stage_analysis", "bugfix-adaptive-stage", { stageID: "issue-analysis", handoff: "HANDOFF_PROJECT_CODE: src/main.ts is the fixture entry point; consult the project artifact." }),
  (response) => tool(response, "call_stage_two_read", "read", { filePath: stageTwoFile }),
  (response) => tool(response, "call_stage_reproduction", "bugfix-adaptive-stage", { stageID: "issue-reproduction", handoff: "HANDOFF_ANALYSIS_KEYS: use canonical issue analysis; source owner remains unverified." }),
  (response) => tool(response, "call_large_read", "read", { filePath: largeFile }),
  (response) => tool(response, "call_large_read_again", "read", { filePath: largeFile }),
  (response) => tool(response, "call_repeat_reproduction", "bugfix-adaptive-stage", { stageID: "issue-reproduction" }),
  (response) => tool(response, "call_stage_localization", "bugfix-adaptive-stage", { stageID: "root-cause-localization", handoff: "HANDOFF_REPRO_CODE: src/large-source.txt was inspected; localize using the artifact, not the full exploration trace." }),
  (response) => tool(response, "call_stage_patch", "bugfix-adaptive-stage", { stageID: "patch-generation", handoff: "HANDOFF_PATCH_CODE: inspect only the located symbols before editing; retain unrelated changes. This is a fixture memory, not validated localization." }),
  (response) => text(response, "ADAPTIVE_CHILD_DONE"),
  (response) => text(response, "ADAPTIVE_PARENT_DONE"),
  (response) => tool(response, "call_primary_stage_project", "bugfix-adaptive-stage", { stageID: "project-understanding" }),
  (response) => text(response, "ADAPTIVE_PRIMARY_DONE"),
]
if (probeMissingHandoff) actions.splice(14, 0, response => tool(response,
  "call_missing_handoff", "bugfix-adaptive-stage", { stageID: "root-cause-localization" }))
let actionIndex = 0
const fixtureFailures = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on("data", (part) => chunks.push(part))
  request.on("end", async () => {
    try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    providerRequests.push({ method: request.method, url: request.url, body })
    if (providerRequests.length > 40) throw new Error("Fixture Provider request budget exceeded")
    let action = actions[actionIndex] ?? actions.at(-1)
    if (action === projectBusinessAction && skillLoaded(body)) action = actions[++actionIndex]
    if (action === projectBusinessAction && realProvider && registrationVisible(body)) {
      await realProvider.forward(body, response)
      return
    }
    if (action(response, body) !== false) actionIndex += 1
    } catch (error) {
      fixtureFailures.push(error.message)
      actionIndex = actions.length - 1
      if (!response.headersSent) text(response, "FIXTURE_FAILED")
      else response.end()
    }
  })
})
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const address = server.address()
await fs.writeFile(
  path.join(workspace, "opencode.json"),
  `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    permission: "allow",
    model: "probe/probe-model",
    provider: {
      probe: {
        npm: "@ai-sdk/openai-compatible",
        name: "Adaptive Probe",
        options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "probe" },
        models: { "probe-model": { name: "Probe", limit: { context: 131072, output: 2048 } } },
      },
    },
  }, null, 2)}\n`,
)

// Deployed the way users install it: copied into .opencode/plugins, with no dependencies installed by hand.
execFileSync("node", [path.join(root, "install.mjs"), workspace], { stdio: "ignore" })

const environment = {
  ...process.env,
  PWD: workspace,
  INIT_CWD: workspace,
  XDG_DATA_HOME: path.join(runtime, "data"),
  XDG_STATE_HOME: path.join(runtime, "state"),
  XDG_CONFIG_HOME: path.join(runtime, "config"),
  XDG_CACHE_HOME: path.join(runtime, "cache"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
}
async function run({ agent, title: sessionTitle, prompt }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(opencode, [
      "run",
      "--format",
      "json",
      "--model",
      "probe/probe-model",
      "--agent",
      agent,
      "--title",
      sessionTitle,
      prompt,
    ], { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`OpenCode exited ${code}\nruntime=${runtime}\n${stderr}\n${stdout}`))
    })
  })
}

try {
  await run({
    agent: "build",
    title: "adaptive-context-child-e2e",
    prompt: "launch adaptive bug fix",
  })
  await run({
    agent: "bug-fix-adaptive",
    title: "adaptive-context-primary-e2e",
    prompt: "PRIMARY_ADAPTIVE_ISSUE_SOURCE_CANARY",
  })
  assert.deepEqual(fixtureFailures, [])
  const state = JSON.parse(await fs.readFile(path.join(openCode, "bugfix-adaptive-context.state.json"), "utf8"))
  const sessions = Object.values(state.sessions)
  assert.equal(sessions.length, 2)
  const session = sessions.find((candidate) => candidate.currentStageID === "patch-generation")
  const primarySession = sessions.find((candidate) =>
    candidate.issueSourceText.trim() === "PRIMARY_ADAPTIVE_ISSUE_SOURCE_CANARY"
  )
  assert.ok(session)
  assert.ok(primarySession)
  assert.equal(state.version, 9)
  // The folding layer ran too: it logs every request.
  const requestLog = (await fs.readFile(path.join(openCode, "context-manage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(requestLog.some((event) => event.type === "request"))
  assert.equal(session.stageHandoff.fromStageRunID, "stage_root-cause-localization_04")
  assert.equal(session.stageHandoff.toStageRunID, "stage_patch-generation_05")
  assert.ok(session.stageHandoff.sourceMessageID)
  assert.equal(primarySession.stageHandoff, null)
  assert.deepEqual(session.workflowReferences, workflowReferences)
  assert.equal(primarySession.workflowReferences.workspaceRoot, workspace)
  assert.ok(Object.entries(primarySession.workflowReferences).filter(([key]) => key !== "workspaceRoot").every(([, value]) => value === null))
  await assert.rejects(fs.stat(workPlanPath), { code: "ENOENT" })
  for (const entry of sessions) {
    assert.equal(Object.hasOwn(entry, "nextStageID"), false)
    assert.ok(entry.stageHistory.every(stage => !Object.hasOwn(stage, "nextStageID")))
  }
  assert.equal(primarySession.currentStageID, "project-understanding")
  assert.deepEqual(
    session.stageHistory.map((entry) => entry.stageID),
    [
      "project-understanding",
      "issue-analysis",
      "issue-reproduction",
      "root-cause-localization",
      "patch-generation",
    ],
  )
  assert.equal(state.pluginID, "bugfix-adaptive-stage-only-v1")
  for (const candidate of sessions) {
    assert.deepEqual(candidate.observations, [])
    assert.deepEqual(candidate.observationRequests, [])
  }

  assert.equal(
    providerRequests.some((request) =>
      request.body.tools?.some((candidate) => candidate.function?.name === "bugfix-adaptive-stage")
    ),
    true,
  )
  assert.equal(
    providerRequests.some((request) =>
      request.body.tools?.some((candidate) => candidate.function?.name === "bugfix-adaptive-observation")
    ),
    false,
  )
  const firstStageRequest = providerRequests.find((request) =>
    JSON.stringify(request.body.messages).includes('stage=\\"project-understanding\\"')
  )
  assert.ok(firstStageRequest)
  assert.match(JSON.stringify(firstStageRequest.body.messages), /REGISTRY_BOOTSTRAP_STARTUP_CANARY/)
  const businessRequest = providerRequests.find((request) => skillLoaded(request.body))
  assert.ok(businessRequest, "must reach the real codebase-structure Skill after repeated declarations")
  assert.equal(missingAcknowledgments, 0)
  const secondStageRequest = providerRequests.find((request) =>
    JSON.stringify(request.body.messages).includes('stage=\\"issue-analysis\\"')
  )
  assert.ok(secondStageRequest)
  assert.doesNotMatch(JSON.stringify(secondStageRequest.body.messages), /REGISTRY_BOOTSTRAP_STARTUP_CANARY/)
  const secondCarrier = secondStageRequest.body.messages.find((message) =>
    JSON.stringify(message).includes("<bugfix-adaptive-context")
  )
  const secondCarrierText = toolContent(secondCarrier)
  for (const reference of Object.values(workflowReferences)) {
    assert.ok(secondCarrierText.includes(reference), "known references must survive old-history removal")
  }
  assert.match(secondCarrierText, /do not repeat Registry discovery/)
  assert.match(secondCarrierText, /Paths do not prove existence or validation/)
  const secondProfile = session.contextProfile
  assert.equal(secondProfile.stepID, "patch-generation")
  assert.equal(secondProfile.upstreamArtifacts.length, 4)
  assert.ok(secondProfile.outputArtifact.path.endsWith(`${path.sep}#问题-123.patch`))
  assert.ok(secondCarrierText.includes("analysis_results.json"))
  assert.ok(secondCarrierText.includes("codebase-structure.md"))
  assert.ok(secondCarrierText.includes("issue-download"))
  const reproductionStart = providerRequests.find((request) =>
    JSON.stringify(request.body.messages).includes('stage=\\"issue-reproduction\\"')
  )
  assert.ok(reproductionStart)
  assert.equal(
    JSON.stringify(reproductionStart.body.messages).includes("STAGE_TWO_EXPLORATION_CANARY"),
    false,
    "the issue-analysis read must be removed after entering issue-reproduction",
  )
  for (const request of providerRequests) {
    assert.doesNotMatch(JSON.stringify(request.body.messages), /bugfix-adaptive-observation-request|bugfix-adaptive-observation-memory|bugfix-adaptive-tool-output-receipt/)
  }
  const sourceResult = (request, callID) => request.body.messages.find((message) =>
    message.role === "tool" && message.tool_call_id === callID
  )
  const firstRead = providerRequests.find((request) => sourceResult(request, "call_large_read"))
  const repeatedRead = providerRequests.find((request) => sourceResult(request, "call_large_read_again"))
  assert.ok(firstRead)
  assert.ok(repeatedRead)
  // Folding works inside the stage: once the large read passes `start`, later outputs get turn labels.
  assert.match(JSON.stringify(repeatedRead.body.messages), /\[turn \d+\]/)
  assert.match(JSON.stringify(sourceResult(firstRead, "call_large_read")), /LARGE_SOURCE_0/)
  assert.deepEqual(sourceResult(firstRead, "call_large_read"), sourceResult(repeatedRead, "call_large_read"))
  const localizationStart = providerRequests.find((request) =>
    JSON.stringify(request.body.messages).includes('stage=\\"root-cause-localization\\"')
  )
  assert.ok(localizationStart)
  assert.equal(JSON.stringify(localizationStart.body.messages).includes("LARGE_SOURCE_0"), false)
  assert.equal(JSON.stringify(localizationStart.body.messages).split("HANDOFF_REPRO_CODE").length - 1, 1)
  assert.doesNotMatch(JSON.stringify(localizationStart.body.messages), /HANDOFF_ANALYSIS_KEYS|HANDOFF_PROJECT_CODE/)
  const providerCarrier = (request) => request.body.messages.find((message) =>
    JSON.stringify(message).includes("<bugfix-adaptive-context")
  )
  assert.deepEqual(providerCarrier(firstRead), providerCarrier(repeatedRead))
  assert.doesNotMatch(JSON.stringify(providerCarrier(localizationStart)), /HANDOFF_REPRO_CODE/)
  const stageSchema = firstRead.body.tools.find((candidate) => candidate.function?.name === "bugfix-adaptive-stage").function.parameters
  assert.equal(stageSchema.properties.handoff.type, "string")
  assert.equal(stageSchema.properties.workspaceRoot, undefined)
  assert.equal(stageSchema.required.includes("handoff"), false)
  assert.equal(stageSchema.properties.nextStageID, undefined)
  assert.deepEqual(stageSchema.required, ["stageID"])
  for (const field of Object.keys(stageReferences)) {
    assert.equal(stageSchema.properties[field].type, "string")
    assert.equal(stageSchema.required.includes(field), false)
  }

  const auditEvents = (await fs.readFile(path.join(openCode, "bugfix-adaptive-context.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const projections = auditEvents.filter(event => event.type === "bugfix-adaptive-stage-context")
  const firstDeclaration = projections[0]
  assert.equal(firstDeclaration.declarationType, "initialization")
  assert.equal(firstDeclaration.historyPruning, false)
  assert.equal(
    projections.length,
    6,
  )
  assert.ok(!auditEvents.some(event => event.callID === "call_repeat_reproduction"))
  assert.ok(auditEvents.every(event => !Object.hasOwn(event, "nextStageID")))
  assert.equal(auditEvents.length, probeMissingHandoff ? 7 : 6)
  assert.doesNotMatch(JSON.stringify(auditEvents), /beforeMessages|afterMessages|LARGE_SOURCE_0/)
  assert.equal(new Set(projections.map(event => `${event.observedSessionID}:${event.currentStageRunID}`)).size, 6)
  if (probeMissingHandoff) {
    const rejected = auditEvents.find(event => event.errorCode === "BUGFIX_HANDOFF_REQUIRED")
    assert.equal(rejected.currentStageID, "issue-reproduction")
    assert.equal(rejected.requestedStageID, "root-cause-localization")
    assert.equal(rejected.historyPruning, false)
    const retryRequest = providerRequests.find(request => JSON.stringify(request.body.messages).includes("BUGFIX_HANDOFF_REQUIRED"))
    assert.ok(retryRequest, "Tool error must return to the model, not abort the Session")
    assert.match(JSON.stringify(retryRequest.body.messages), /LARGE_SOURCE_0/)
    assert.match(JSON.stringify(providerCarrier(retryRequest)), /issue-reproduction/)
  }
  assert.equal(providerRequests.length, probeMissingHandoff ? 21 : 20)
  const cacheDiagnostics = await assertCacheDiagnostics(openCode, providerRequests)
  assert.ok(projections.length > 0)
  for (const event of projections) {
    assert.equal(event.scope, "stage-entry-context")
    const raw = event.contextProfile.carrier.parts[0].text
    const body = JSON.parse(raw.split("\n\n")[1])
    assert.equal(body.instructions.length, 3)
    assert.equal(body.registryConfiguration.workflowRules.step_order, undefined)
    assert.equal(body.registryConfiguration.workflowRules.plan, undefined)
    assert.equal(body.registryConfiguration.registrySha256, undefined)
    assert.ok(providerRequests.some(request => request.body.messages.some(message =>
      message.role === "user" && (typeof message.content === "string" ? message.content :
        (message.content ?? []).map(part => part.text ?? "").join("\n")).includes(raw))),
    "logged Carrier must actually reach the Provider")
    if (event.contextProfile.handoff.mode !== "none") {
      assert.ok(event.contextProfile.handoff.content)
      assert.equal(event.contextProfile.handoff.sourceCallID, event.callID)
      assert.equal(event.contextProfile.handoff.mode, "entry-tool")
      assert.doesNotMatch(raw, /HANDOFF_PROJECT_CODE|HANDOFF_ANALYSIS_KEYS|HANDOFF_REPRO_CODE/)
    }
    assert.ok(event.tokenMetrics.removedMessages.estimatedTokens >= 0)
    assert.equal(event.tokenMetrics.savings.estimatedTokens, event.tokenMetrics.before.estimatedTokens - event.tokenMetrics.after.estimatedTokens)
  }
  assert.ok(projections.some(event => event.tokenMetrics.removedMessages.estimatedTokens > 10000))
  const result = {
    ok: true,
    opencodeVersion: execFileSync(opencode, ["--version"], { encoding: "utf8" }).trim(),
    providerCalls: providerRequests.length,
    activationScopes: ["primary", "subagent"],
    stages: session.stageHistory.map((entry) => entry.stageID),
    primaryStage: primarySession.currentStageID,
    firstStageStartupPreserved: true,
    workflowReferencesPreserved: true,
    missingPlanPathAccepted: true,
    repeatedDeclarationAcknowledged: true,
    projectBusinessSkillLoaded: true,
    realProviderRequests: realProvider?.calls ?? 0,
    experimentMode: "stage-only",
    toolObservationEnabled: false,
    sameStageReadPreserved: true,
    previousStageReadRemoved: true,
    contextProfileProjected: true,
    codeHandoffProjectedOnce: true,
    missingHandoffRetryPreservedHistory: probeMissingHandoff,
    workspaceRootToolArgumentRemoved: true,
    stageIDOnlyDeclarations: true,
    profileAuditRecords: projections.length,
    auditBytes: (await fs.stat(path.join(openCode, "bugfix-adaptive-context.jsonl"))).size,
    cacheDiagnostics,
    removedMessageTokensRecorded: true,
    exactCarrierAndHandoffLogged: true,
    providerBoilerplateFiltered: true,
    configVersion: 2,
    stateVersion: state.version,
    registryFixture: path.basename(registryFixture),
  }
  await fs.writeFile(path.join(runtime, "results.json"), JSON.stringify(result, null, 2) + "\n")
  await fs.writeFile(path.join(runtime, "provider-requests.json"), JSON.stringify(providerRequests, null, 2) + "\n")
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  if (process.env.KEEP_E2E_RUNTIME !== "1") await fs.rm(runtime, { recursive: true, force: true })
  else process.stderr.write(`E2E runtime retained: ${runtime}\n`)
}
