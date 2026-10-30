import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { BugfixAdaptiveContext } from "../../src/stage/plugin.mjs"
import { readConfig, validateConfig } from "../../src/stage/config.mjs"
import { contextCarrier } from "../../src/stage/carrier.mjs"
import { compileRegistryProfile, providerRegistryProfile, resolveArtifactPath, validateRegistryProfile } from "../../src/stage/registry-profile.mjs"
import { createSession, readState } from "../../src/stage/state.mjs"
import { load, CORE_SCHEMA } from "../../src/stage/vendor/js-yaml.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/stage")
const yaml = await fs.readFile(path.join(root, "../../test/stage/fixtures/step-registry.yaml"), "utf8")
const dependsOnYaml = await fs.readFile(path.join(root, "../../test/stage/fixtures/step-registry.depends-on.yaml"), "utf8")
const refs = { registryPath: "C:\\配置\\step-registry.yaml", workPlanPath: null,
  projectRoot: "C:\\代码 项目\\仓库", workspaceRoot: "C:\\代码 项目\\仓库", issueNumber: "#问题-123" }
const body = message => JSON.parse(message.parts[0].text.split("\n\n").find(section => section.startsWith("{")))

test("actual Registry yields all upstream references, current rules and only referenced checks", () => {
  const p = compileRegistryProfile(yaml, "root-cause-localization", refs)
  assert.deepEqual(p.upstreamArtifacts, [
    { stepID: "project-understanding", path: "C:\\代码 项目\\仓库\\codebase-structure.md" },
    { stepID: "issue-analysis", path: "C:\\代码 项目\\仓库\\.bugfix\\#问题-123\\analysis_results.json" },
    { stepID: "issue-reproduction", path: "C:\\代码 项目\\仓库\\.bugfix\\#问题-123\\reproduction\\reproduction_result.json" },
  ])
  assert.equal(p.outputArtifact.path, "C:\\代码 项目\\仓库\\.bugfix\\#问题-123\\localization\\root_cause_localization.json")
  assert.deepEqual(Object.keys(p.checkProfiles), ["canonical_json"])
  assert.equal(p.stepRules.derive.source.result, "issue-reproduction.artifact")
  assert.deepEqual(p.stepRules.generate.selector.map(item => item.skill),
    ["static-root-cause-localization", "dynamic-root-cause-localization", "static-root-cause-localization"])
  assert.deepEqual(p.stepRules.confirmation, { required_in: "DEFAULT", skipped_in: "FULL_AUTO" })
  assert.equal(p.workflowRules.execution_mode, undefined, "Registry default is not the actual invocation/Plan mode")
  assert.equal(p.registryID, "bug-fix-adaptive-v3", "Plan creation need not reread Registry for its ID")
  assert.deepEqual(p.registryDefaults, { execution_mode: "FULL_AUTO" }, "default is explicitly named, never a frozen resolved mode")
  assert.doesNotMatch(JSON.stringify(p), /selectedRoute|plan_state|producedBy|validated|issueDescriptionProvided/)
  const reproduction = compileRegistryProfile(yaml, "issue-reproduction", refs)
  assert.deepEqual(Object.keys(reproduction.checkProfiles).sort(), ["reproduction_result", "trusted_reproduction_result"])
  const first = compileRegistryProfile(yaml, "project-understanding", refs)
  assert.deepEqual(first.upstreamArtifacts, [])
  assert.equal(first.outputArtifact.path, "C:\\代码 项目\\仓库\\codebase-structure.md")
  assert.deepEqual(first.stepRules.generate.sequence.map(item => item.skill), ["codebase-structure", "fix-build-command"])
})

test("Provider projection omits global boilerplate and audit metadata, preserving configured YAML contracts", async () => {
  const config = await readConfig(path.join(root, "default-config.json"))
  const internal = compileRegistryProfile(dependsOnYaml, "root-cause-localization", refs)
  const original = structuredClone(internal)
  const view = providerRegistryProfile(config, internal)
  assert.deepEqual(Object.keys(view.workflowRules), ["input_policy", "input_policies"])
  for (const field of ["step_order", "states", "reason_codes", "plan", "preplan", "route_precedence"]) {
    assert.equal(view.workflowRules[field], undefined)
  }
  for (const field of ["registrySha256", "registryPath", "stepID"]) assert.equal(view[field], undefined)
  for (const field of ["phase", "outcome", "depends_on", "context", "candidates"]) assert.equal(view.stepRules[field], undefined)
  assert.deepEqual(view.stepRules.generate, internal.stepRules.generate)
  assert.deepEqual(view.stepRules.derive, internal.stepRules.derive)
  assert.deepEqual(view.stepRules.confirmation, internal.stepRules.confirmation)
  assert.deepEqual(view.checkProfiles, internal.checkProfiles)
  assert.deepEqual(view.upstreamArtifacts, internal.upstreamArtifacts)
  assert.deepEqual(view.outputArtifact, internal.outputArtifact)
  assert.deepEqual(internal, original, "Provider selection must not corrupt cached validation/source data")
  assert.ok(JSON.stringify(view).length < JSON.stringify(internal).length)
})

test("explicit field selection supports YAML extensions or paths-only without guessing prompt semantics", async () => {
  const config = await readConfig(path.join(root, "default-config.json"))
  const internal = compileRegistryProfile(yaml, "issue-analysis", refs)
  internal.workflowRules.custom_policy = { flag: true }
  internal.stepRules.custom_action = { tool: "custom-tool", check_profile: "canonical_json" }
  config.registryProjection = { workflowFields: ["custom_policy"], stepFields: ["custom_action"] }
  validateConfig(config)
  const view = providerRegistryProfile(config, internal)
  assert.deepEqual(view.workflowRules, { custom_policy: { flag: true } })
  assert.deepEqual(view.stepRules.custom_action, internal.stepRules.custom_action)
  assert.deepEqual(Object.keys(view.checkProfiles), ["canonical_json"])
  config.registryProjection = { workflowFields: [], stepFields: [] }
  const paths = providerRegistryProfile(config, internal)
  assert.deepEqual(paths.workflowRules, {})
  assert.deepEqual(paths.stepRules, {})
  assert.deepEqual(paths.checkProfiles, {})
  assert.deepEqual(paths.outputArtifact, internal.outputArtifact)
})

test("Config v2 rejects v1 and malformed projection selectors without implicit migration", async () => {
  const config = await readConfig(path.join(root, "default-config.json"))
  assert.throws(() => validateConfig({ ...config, version: 1 }), /version must be 2.*--replace-config --reset-state/)
  for (const registryProjection of [null, {}, { workflowFields: [], stepFields: [], extra: [] },
    { workflowFields: "all", stepFields: [] }, { workflowFields: [], stepFields: ["generate", "generate"] },
    { workflowFields: ["*"], stepFields: [] }, { workflowFields: ["__proto__"], stepFields: [] }]) {
    assert.throws(() => validateConfig({ ...config, registryProjection }), /registryProjection/)
  }
})

test("output names, dependencies and skill names come from YAML, not hardcoded stage mappings", () => {
  const alternate = yaml.replaceAll("analysis_results.json", "triage/custom-analysis.json")
    .replaceAll("codebase-structure.md", "docs/项目地图.md")
    .replace('skill: "issue-reproduction"', 'skill: "custom-reproducer"')
  const p = compileRegistryProfile(alternate, "issue-reproduction", refs)
  assert.equal(p.stepRules.generate.skill, "custom-reproducer")
  assert.match(p.upstreamArtifacts[0].path, /docs\\项目地图\.md$/u)
  assert.match(p.upstreamArtifacts[1].path, /triage\\custom-analysis\.json$/u)
  assert.doesNotMatch(JSON.stringify(p), /analysis_results\.json|codebase-structure\.md/)
})

test("path templates resolve independently of host OS, preserving Unicode, dollars, UNC and roots", () => {
  for (const [projectRoot, expected] of [
    ["C:\\代码 A", "C:\\代码 A\\.bugfix\\#123$&\\result.json"],
    ["C:/代码 A/", "C:\\代码 A\\.bugfix\\#123$&\\result.json"],
    ["\\\\server\\共享\\代码 A", "\\\\server\\共享\\代码 A\\.bugfix\\#123$&\\result.json"],
    ["/tmp/代码 A/", "/tmp/代码 A/.bugfix/#123$&/result.json"],
  ]) assert.equal(resolveArtifactPath("{{project_root_dir}}/.bugfix/{{issue_number}}/result.json", { projectRoot, issueNumber: "#123$&" }).path, expected)
  assert.deepEqual(resolveArtifactPath("{{project_root_dir}}/{{issue_number}}/{{custom}}.json", { projectRoot: "/repo" }),
    { path: null, template: "{{project_root_dir}}/{{issue_number}}/{{custom}}.json", missingVariables: ["issue_number", "custom"] })
  assert.equal(resolveArtifactPath("{{project_root_dir}}/{{issue_number}}/r.json", { projectRoot: "/repo", issueNumber: "../other" }).path, null)
  assert.throws(() => resolveArtifactPath("relative/result.json", refs), /absolute path/)
})

async function fixture(t, registryText = yaml) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "adaptive-profile-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const oc = path.join(directory, ".opencode")
  await fs.mkdir(oc)
  await fs.copyFile(path.join(root, "default-config.json"), path.join(oc, "bugfix-adaptive-context.config.json"))
  const registryPath = path.join(directory, "配置", "step-registry.yaml")
  await fs.mkdir(path.dirname(registryPath))
  await fs.writeFile(registryPath, registryText)
  const references = { ...refs, registryPath, workspaceRoot: directory, projectRoot: directory,
    workPlanPath: path.join(directory, ".bugfix", refs.issueNumber, "workflow_plan.json") }
  const config = await readConfig(path.join(root, "default-config.json"))
  let hooks = await BugfixAdaptiveContext({ directory })
  const source = { info: { id: "msg_first", sessionID: "ses_profile", role: "user", agent: config.targetAgent },
    parts: [{ type: "text", text: "修复任务 ORIGINAL_USER_REQUIREMENT" }] }
  const messages = [source]
  async function transform() {
    const out = { messages: structuredClone(messages) }
    await hooks["experimental.chat.messages.transform"]({}, out)
    return out.messages
  }
  async function stage(stageID, callID) {
    const { workspaceRoot: _runtimeWorkspace, ...stageReferences } = references
    await hooks["tool.execute.before"]({ tool: config.stageControlTool, sessionID: "ses_profile", callID },
      { args: { stageID, handoff: "", ...stageReferences } })
    messages.push({ info: { id: `msg_${callID}`, sessionID: "ses_profile", role: "assistant" },
      parts: [{ type: "tool", tool: config.stageControlTool, callID, state: { status: "completed", input: {}, output: "registered" } }] })
  }
  await transform()
  return { directory, oc, references, messages, config, stage, transform,
    get hooks() { return hooks },
    restart: async () => { hooks = await BugfixAdaptiveContext({ directory }) },
    state: () => readState(path.join(oc, "bugfix-adaptive-context.state.json"), config) }
}

test("real hooks freeze the profile across Registry/Plan changes, file loss, repeated declaration and restart", async t => {
  const f = await fixture(t)
  await f.stage("project-understanding", "call_a")
  const first = (await f.transform())[0]
  assert.match(body(first).registryConfiguration.outputArtifact.path, /codebase-structure\.md$/)
  const revised = yaml.replaceAll("codebase-structure.md", "docs/new-map.md")
  await fs.writeFile(f.references.registryPath, revised)
  await fs.mkdir(path.dirname(f.references.workPlanPath), { recursive: true })
  await fs.writeFile(f.references.workPlanPath, '{"plan_state":"READY","private":"DO_NOT_COPY_PLAN"}')
  await f.stage("project-understanding", "call_repeat")
  assert.deepEqual((await f.transform())[0], first)
  await fs.unlink(f.references.registryPath)
  await f.restart()
  assert.deepEqual((await f.transform())[0], first, "restart must not reparse/rebuild the early prefix")
  await fs.writeFile(f.references.registryPath, revised)
  await f.stage("issue-analysis", "call_b")
  const next = (await f.transform())[0]
  assert.match(body(next).registryConfiguration.upstreamArtifacts[0].path, /docs\/new-map\.md$/)
  assert.notDeepEqual(body(next).registryConfiguration.upstreamArtifacts, body(first).registryConfiguration.upstreamArtifacts)
  assert.doesNotMatch(JSON.stringify(next), /DO_NOT_COPY_PLAN|plan_state|ORIGINAL_USER_REQUIREMENT.*ORIGINAL_USER_REQUIREMENT/)
  assert.match(next.parts[0].text, /ORIGINAL_USER_REQUIREMENT/)
  const events = (await fs.readFile(path.join(f.oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  const audit = events.filter(event => event.type === "bugfix-adaptive-stage-context").at(-1)
  assert.equal(events.length, 2, "repeated calls and restart must not duplicate a built profile")
  assert.deepEqual(audit.contextProfile.carrier, next)
  assert.deepEqual(providerRegistryProfile(f.config, (await f.state()).sessions.ses_profile.contextProfile), body(next).registryConfiguration)
})

test("unreadable or unknown Registry is explicit and does not invent files or business state", async t => {
  const f = await fixture(t)
  await fs.unlink(f.references.registryPath)
  await f.stage("issue-reproduction", "call_missing")
  const carrier = (await f.transform())[0]
  assert.deepEqual(body(carrier).registryConfiguration.diagnostics, [{ code: "registry-read-unavailable", errorCode: "ENOENT" }])
  assert.deepEqual(body(carrier).registryConfiguration.upstreamArtifacts, [])
  await fs.writeFile(f.references.registryPath, yaml)
  assert.deepEqual((await f.transform())[0], carrier, "no per-turn retries or mid-stage prefix rewrite")
})

test("malformed Registry leaves the Provider input and persisted state untouched, retry works after repair", async t => {
  const f = await fixture(t)
  await f.stage("issue-analysis", "call_a")
  const statePath = path.join(f.oc, "bugfix-adaptive-context.state.json")
  const before = await fs.readFile(statePath, "utf8")
  await fs.writeFile(f.references.registryPath, "steps: [")
  const input = structuredClone(f.messages)
  await assert.rejects(f.transform(), /cannot parse YAML/)
  assert.deepEqual(f.messages, input)
  assert.equal(await fs.readFile(statePath, "utf8"), before)
  const audit = (await fs.readFile(path.join(f.oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).at(-1)
  assert.equal(audit.decision, "failed")
  assert.equal(audit.errorCode, "BUGFIX_ADAPTIVE_PROJECTION_FAILED")
  assert.equal(audit.phase, "context-projection")
  assert.equal(audit.currentStageID, "issue-analysis")
  assert.equal(audit.registryPath, f.references.registryPath)
  assert.equal(audit.providerMessagesUnchanged, true)
  assert.match(audit.error.message, /cannot parse YAML/)
  await fs.writeFile(f.references.registryPath, yaml)
  assert.equal(body((await f.transform())[0]).registryConfiguration.outputArtifact.stepID, "issue-analysis")
})

test("missing template variables are carried explicitly and do not become invented absolute paths", () => {
  const references = { ...refs, issueNumber: null }
  const p = compileRegistryProfile(yaml, "issue-reproduction", references)
  assert.equal(p.upstreamArtifacts[0].path, "C:\\代码 项目\\仓库\\codebase-structure.md")
  assert.equal(p.upstreamArtifacts[1].path, null)
  assert.deepEqual(p.outputArtifact.missingVariables, ["issue_number"])
  const session = { currentStageID: "issue-reproduction", workflowReferences: references }
  validateRegistryProfile(p, session)
})

test("malformed YAML, duplicate keys, unknown stages/checks and unsupported dependencies fail explicitly", () => {
  for (const source of ["steps: [", "steps: []\nsteps: []", yaml.replace('"all_earlier_steps_in_step_order"', '"unknown-policy"'),
    yaml.replace('check_profile: "project_document"', 'check_profile: "missing-profile"'),
    yaml.replace('- "issue-analysis"', '- "project-understanding"'),
    yaml + "\nunsafe: &cycle [*cycle]\n",
  ]) assert.throws(() => compileRegistryProfile(source, "project-understanding", refs), /Invalid adaptive Registry profile/)
  assert.throws(() => compileRegistryProfile(yaml, "invented-stage", refs), /not in Registry/)
  const blockYaml = yaml + '\nnote: >\n  Supports normal YAML\n  block strings.\n'
  assert.equal(compileRegistryProfile(blockYaml, "issue-analysis", refs).stepID, "issue-analysis")
})

test("stored profiles reject cross-stage/corrupt data and missing profile fields; no migration", async t => {
  const f = await fixture(t)
  await f.stage("issue-reproduction", "call_a")
  await f.transform()
  const state = await f.state()
  const statePath = path.join(f.oc, "bugfix-adaptive-context.state.json")
  for (const mutate of [
    state => state.version = 5,
    state => delete state.sessions.ses_profile.contextProfile,
    state => state.sessions.ses_profile.contextProfile.stepID = "patch-generation",
    state => state.sessions.ses_profile.contextProfile.registrySha256 = "not-a-hash",
    state => state.sessions.ses_profile.contextProfile.outputArtifact.stepID = "issue-analysis",
    state => state.sessions.ses_profile.contextProfile.upstreamArtifacts[0].path = "relative.md",
    state => state.sessions.ses_profile.contextProfile.upstreamArtifacts[0] = null,
  ]) {
    const invalid = structuredClone(state)
    mutate(invalid)
    await fs.writeFile(statePath, JSON.stringify(invalid))
    await assert.rejects(f.state(), /State|state|profile|absolute path/)
  }
  validateRegistryProfile(state.sessions.ses_profile.contextProfile, state.sessions.ses_profile)
})

test("Carrier has three short cooperation instructions and no compaction/Observation tutorial", async () => {
  const config = await readConfig(path.join(root, "default-config.json"))
  const session = createSession({ sessionID: "ses_minimal", issueSourceMessageID: "msg_initial", issueSourceText: "task" })
  const instructions = body(contextCarrier(config, session)).instructions
  assert.equal(instructions.length, 3)
  assert.ok(instructions.join(" ").length < 1250)
  assert.doesNotMatch(instructions.join(" "), /compaction|summary|Observation|first declaration|no-op/i)
  assert.match(instructions.join(" "), /bugfix-adaptive-stage/)
})

test("every registered stage retains concise continuation guidance without overriding workflow stops", async t => {
  const f = await fixture(t, dependsOnYaml)
  for (const [index, stageID] of f.config.stages.entries()) {
    await f.stage(stageID, `call_continue_${index}`)
    const first = await f.transform()
    const instructions = body(first[0]).instructions
    assert.equal(instructions.length, 3)
    assert.ok(instructions.join(" ").length < 1250)
    assert.match(instructions[0], /is registered; do not redeclare/)
    assert.match(instructions[1], /Read Registry only for required information absent here/)
    assert.match(instructions[1], /Handoff is fallible memory/)
    assert.match(instructions[2], /Every real transition requires handoff from existing context/)
    assert.match(instructions[2], /do not end with an intermediate report or ask whether to continue/)
    assert.match(instructions[2], /Preserve required validation, confirmations and true stop conditions/)
    if (stageID === "issue-analysis") {
      assert.equal(body(first[0]).registryConfiguration.workflowRules.preplan, undefined)
      await assert.rejects(fs.access(f.references.workPlanPath), { code: "ENOENT" })
    }
    f.messages.push({ info: { id: `msg_checked_${index}`, sessionID: "ses_profile", role: "assistant" },
      parts: [{ type: "tool", tool: "read", callID: `call_checked_${index}`,
        state: { status: "completed", input: {}, output: "Artifact checks passed" } }] })
    assert.deepEqual((await f.transform())[0], first[0], "business results must not rewrite the Carrier")
    assert.equal((await f.state()).sessions.ses_profile.currentStageID, stageID, "only Stage Tool may change the cursor")
  }
})

function dependsOnRegistry(mutate) {
  const registry = load(dependsOnYaml, { schema: CORE_SCHEMA })
  mutate(registry)
  return JSON.stringify(registry) // JSON is a YAML subset; preserve all rule values.
}

test("357-line user Registry compiles every stage with declared transitive dependencies", () => {
  const registry = load(dependsOnYaml, { schema: CORE_SCHEMA })
  assert.equal(dependsOnYaml.trimEnd().split("\n").length, 357)
  assert.equal(registry.workflow.dependency_policy, undefined)
  for (const [index, stageID] of registry.workflow.step_order.entries()) {
    const p = compileRegistryProfile(dependsOnYaml, stageID, refs)
    assert.deepEqual(p.upstreamArtifacts.map(ref => ref.stepID), registry.workflow.step_order.slice(0, index))
    assert.deepEqual(p.stepRules.depends_on, registry.steps.find(step => step.id === stageID).depends_on)
    assert.deepEqual(p.workflowRules.defaults, registry.workflow.defaults)
    assert.equal(p.workflowRules.dependency_policy, undefined, "do not invent a global policy in the user's rules")
    validateRegistryProfile(p, { currentStageID: stageID, workflowReferences: refs })
  }
})

test("branching depends_on excludes unrelated earlier steps, deduplicates diamonds and uses step_order", () => {
  const text = dependsOnRegistry(registry => {
    registry.steps[1].depends_on = []
    registry.steps[2].depends_on = ["project-understanding", "issue-analysis"]
    registry.steps[3].depends_on = ["issue-analysis"]
    registry.steps[4].depends_on = ["root-cause-localization", "issue-analysis"]
    registry.steps.reverse()
  })
  const localization = compileRegistryProfile(text, "root-cause-localization", refs)
  assert.deepEqual(localization.upstreamArtifacts.map(ref => ref.stepID), ["issue-analysis"])
  const patch = compileRegistryProfile(text, "patch-generation", refs)
  assert.deepEqual(patch.upstreamArtifacts.map(ref => ref.stepID), ["issue-analysis", "root-cause-localization"])
  validateRegistryProfile(patch, { currentStageID: "patch-generation", workflowReferences: refs })
  const diamond = dependsOnRegistry(registry => {
    registry.steps[2].depends_on = ["project-understanding", "issue-analysis"]
    registry.steps[3].depends_on = ["issue-analysis", "issue-reproduction"]
  })
  assert.equal(compileRegistryProfile(diamond, "patch-generation", refs).upstreamArtifacts.length, 4)
})

test("omitted root depends_on means no dependencies, without inventing an order-based fallback", () => {
  const text = dependsOnRegistry(registry => { delete registry.steps[0].depends_on })
  const p = compileRegistryProfile(text, "project-understanding", refs)
  assert.deepEqual(p.upstreamArtifacts, [])
  validateRegistryProfile(p, { currentStageID: "project-understanding", workflowReferences: refs })
})

test("bad explicit dependencies and unknown global policies fail instead of guessing", () => {
  for (const mutate of [
    registry => registry.steps[1].depends_on = "project-understanding",
    registry => registry.steps[1].depends_on = null,
    registry => registry.steps[1].depends_on = ["unknown"],
    registry => registry.steps[1].depends_on = ["issue-analysis"],
    registry => registry.steps[1].depends_on = ["patch-generation"],
    registry => registry.steps[1].depends_on = ["project-understanding", "project-understanding"],
    registry => registry.steps[0].depends_on = ["issue-analysis"], // cycle with stage 2
    registry => registry.workflow.dependency_policy = "unsupported",
    registry => registry.steps.forEach(step => delete step.depends_on),
  ]) assert.throws(() => compileRegistryProfile(dependsOnRegistry(mutate), "project-understanding", refs), /depends_on|dependency/)
  const mixed = dependsOnRegistry(registry => { registry.workflow.dependency_policy = "all_earlier_steps_in_step_order" })
  assert.equal(compileRegistryProfile(mixed, "patch-generation", refs).upstreamArtifacts.length, 4)
})

test("real hooks continue without an after-event logger through five stages and restart", async t => {
  const f = await fixture(t, dependsOnYaml)
  const order = load(dependsOnYaml, { schema: CORE_SCHEMA }).workflow.step_order
  for (const [index, stageID] of order.entries()) {
    const callID = `call_stage_${index}`
    await f.stage(stageID, callID)
    assert.equal(f.hooks["tool.execute.after"], undefined)
    const messages = await f.transform()
    const carrier = messages[0]
    assert.equal(body(carrier).currentStageID, stageID)
    assert.equal(body(carrier).registryConfiguration.upstreamArtifacts.length, index)
    assert.ok(messages.some(message => message.parts.some(part => part.callID === callID)), "Stage acknowledgment stays visible")
    if (index > 0) assert.doesNotMatch(JSON.stringify(messages), new RegExp(`EXPLORATION_${index - 1}`))
    f.messages.push({ info: { id: `msg_work_${index}`, role: "assistant", sessionID: "ses_profile" },
      parts: [{ type: "tool", tool: "read", callID: `call_work_${index}`, state: { status: "completed", input: {}, output: `EXPLORATION_${index}` } }] })
    assert.deepEqual((await f.transform())[0], carrier)
    await f.restart()
    assert.deepEqual((await f.transform())[0], carrier)
  }
  assert.equal((await f.state()).sessions.ses_profile.stageSequence, 5)
  const events = (await fs.readFile(path.join(f.oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.ok(!events.some(event => event.decision === "failed"))
  assert.equal(events.length, 5)
  assert.ok(events.every(event => event.type === "bugfix-adaptive-stage-context"))
})

test("stored depends_on profiles reject missing direct inputs, duplicates and future refs", () => {
  const p = compileRegistryProfile(dependsOnYaml, "issue-reproduction", refs)
  const session = { currentStageID: "issue-reproduction", workflowReferences: refs }
  for (const mutate of [
    p => p.upstreamArtifacts.pop(),
    p => p.upstreamArtifacts.push(p.upstreamArtifacts[0]),
    p => p.upstreamArtifacts[0].stepID = "patch-generation",
    p => p.stepRules.depends_on = ["issue-reproduction"],
  ]) {
    const invalid = structuredClone(p)
    mutate(invalid)
    assert.throws(() => validateRegistryProfile(invalid, session), /depends_on|upstream/)
  }
})

test("dependency failure emits a useful compact error without changing input/state", async t => {
  const f = await fixture(t, dependsOnRegistry(registry => { registry.steps[1].depends_on = ["missing-stage"] }))
  await f.stage("project-understanding", "call_a")
  assert.equal(f.hooks["tool.execute.after"], undefined)
  const statePath = path.join(f.oc, "bugfix-adaptive-context.state.json")
  const saved = await fs.readFile(statePath, "utf8")
  const original = structuredClone(f.messages)
  await assert.rejects(f.transform(), /invalid depends_on/)
  assert.deepEqual(f.messages, original)
  assert.equal(await fs.readFile(statePath, "utf8"), saved)
  const events = (await fs.readFile(path.join(f.oc, "bugfix-adaptive-context.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.length, 1)
  assert.equal(events.at(-1).decision, "failed")
  assert.match(events.at(-1).error.message, /missing-stage|known, earlier/)
  await fs.writeFile(f.references.registryPath, dependsOnYaml)
  assert.equal(body((await f.transform())[0]).currentStageID, "project-understanding")
})
