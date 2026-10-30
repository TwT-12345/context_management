import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { load, CORE_SCHEMA } from "./vendor/js-yaml.mjs"

const FIELDS = ["registryPath", "registrySha256", "registryID", "registryDefaults", "stepID", "workflowRules", "stepRules", "checkProfiles", "upstreamArtifacts", "outputArtifact", "diagnostics"]
const VARIABLES = { workspace_root_dir: "workspaceRoot", project_root_dir: "projectRoot", issue_number: "issueNumber" }
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const fail = message => { throw new Error(`Invalid adaptive Registry profile: ${message}`) }
const windowsPath = value => /^[A-Za-z]:[\\/]/u.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)

// Never resolve a Windows path using the host's POSIX cwd (or vice versa).
export function resolveArtifactPath(template, references) {
  if (typeof template !== "string" || template.trim() === "" || /[\u0000-\u001f]/u.test(template)) fail("artifact.path must be a non-empty path")
  const missingVariables = new Set()
  const substituted = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (token, name) => {
    const field = Object.hasOwn(VARIABLES, name) ? VARIABLES[name] : null
    const value = field ? references[field] : null
    if (!value || (field === "issueNumber" && (/[\\/]/u.test(value) || value === "." || value === ".."))) {
      missingVariables.add(name)
      return token
    }
    return value
  })
  if (missingVariables.size > 0) return { path: null, template, missingVariables: [...missingVariables] }
  if (substituted.includes("{{") || substituted.includes("}}")) fail("malformed path template")
  if (windowsPath(substituted)) return { path: path.win32.normalize(substituted) }
  if (path.posix.isAbsolute(substituted)) return { path: path.posix.normalize(substituted) }
  fail("artifact.path must resolve to an absolute path; no cwd-based guessing")
}

function selectedChecks(step, definitions) {
  const result = Object.create(null)
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!object(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "check_profile" || key.endsWith("_check_profile")) {
        if (typeof child !== "string" || !object(definitions) || !Object.hasOwn(definitions, child)) fail(`unresolved check profile ${String(child)}`)
        result[child] = definitions[child]
      } else visit(child)
    }
  }
  visit(step)
  return result
}

function directDependencies(step, order) {
  const dependencies = Object.hasOwn(step, "depends_on") ? step.depends_on : []
  if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length ||
    dependencies.some(id => typeof id !== "string" || !order.includes(id) || order.indexOf(id) >= order.indexOf(step.id))) {
    fail(`invalid depends_on for ${step.id}: require unique, known, earlier step IDs (no self/cyclic/forward dependencies)`)
  }
  return dependencies
}

function upstreamStepIDs(workflow, steps, stageID) {
  const order = workflow.step_order
  const policy = workflow.dependency_policy
  if (policy !== undefined && policy !== "all_earlier_steps_in_step_order") fail(`unsupported dependency policy ${String(policy)}`)
  if (policy === undefined && !steps.some(step => Object.hasOwn(step, "depends_on"))) fail("dependency_policy or step depends_on declarations are required")
  const dependencies = new Map(steps.map(step => [step.id, directDependencies(step, order)]))
  if (policy === "all_earlier_steps_in_step_order") return order.slice(0, order.indexOf(stageID))
  const upstream = new Set()
  const pending = [...dependencies.get(stageID)]
  while (pending.length > 0) {
    const id = pending.pop()
    if (upstream.has(id)) continue
    upstream.add(id)
    pending.push(...dependencies.get(id))
  }
  return order.filter(id => upstream.has(id))
}

export function compileRegistryProfile(text, stageID, references) {
  let registry
  try {
    registry = load(text, { schema: CORE_SCHEMA, json: false })
    // Reject cycles, non-JSON YAML objects and non-finite values, not partial rules.
    JSON.stringify(registry, (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite YAML value")
      return value
    })
  } catch (error) { fail(`cannot parse YAML: ${error.message}`) }
  const workflow = registry?.workflow
  const steps = registry?.steps
  if (typeof registry?.registry_id !== "string" || registry.registry_id.trim() === "") fail("registry_id is required for Work Plan creation")
  if (!object(workflow) || !Array.isArray(steps) || !Array.isArray(workflow.step_order)) fail("workflow.step_order and steps are required")
  const order = workflow.step_order
  const ids = steps.map(step => step?.id)
  if (!order.every(id => typeof id === "string" && id !== "") || new Set(order).size !== order.length ||
    !ids.every(id => typeof id === "string" && id !== "") || new Set(ids).size !== ids.length ||
    ids.length !== order.length || order.some(id => !ids.includes(id))) fail("step IDs/order must be unique and aligned")
  const index = order.indexOf(stageID)
  if (index < 0) fail(`declared stage ${stageID} is not in Registry`)
  const upstreamIDs = upstreamStepIDs(workflow, steps, stageID)
  const byID = new Map(steps.map(step => [step.id, step]))
  const step = byID.get(stageID)
  if (!object(step.artifact)) fail(`missing artifact for ${stageID}`)
  const artifact = id => {
    const definition = byID.get(id)?.artifact
    if (!object(definition)) fail(`missing artifact for ${id}`)
    return { stepID: id, ...resolveArtifactPath(definition.path, references) }
  }
  // Static configuration only. Actual route, execution mode and completion stay
  // in the invocation/Plan. Never load a Plan or artifact body here.
  const { execution_mode: _defaultMode, ...workflowRules } = workflow
  if (registry.input_policies !== undefined) workflowRules.input_policies = registry.input_policies
  const { id: _id, artifact: outputDefinition, ...stepRules } = step
  const { path: _template, ...outputRules } = outputDefinition
  stepRules.artifact = outputRules
  const profile = {
    registryPath: references.registryPath,
    registrySha256: createHash("sha256").update(text).digest("hex"),
    registryID: registry.registry_id,
    registryDefaults: { execution_mode: workflow.execution_mode ?? null },
    stepID: stageID,
    workflowRules,
    stepRules,
    checkProfiles: selectedChecks(step, registry.check_profiles),
    upstreamArtifacts: upstreamIDs.map(artifact),
    outputArtifact: artifact(stageID),
    diagnostics: [],
  }
  return JSON.parse(JSON.stringify(profile))
}

export async function loadRegistryProfile(stageID, references) {
  if (references.registryPath !== null) {
    let text
    try { text = await fs.readFile(references.registryPath, "utf8") }
    catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error.code)) throw error
      return unavailable("registry-read-unavailable", error.code)
    }
    return compileRegistryProfile(text, stageID, references)
  }
  return unavailable("registry-path-unreported", null)

  function unavailable(code, errorCode) {
    return {
      registryPath: references.registryPath, registrySha256: null, stepID: stageID,
      registryID: null, registryDefaults: null,
      workflowRules: null, stepRules: null, checkProfiles: {}, upstreamArtifacts: [], outputArtifact: null,
      diagnostics: [{ code, ...(errorCode ? { errorCode } : {}) }],
    }
  }
}

// A configurable Provider view, not a second workflow. Keep the compiled source
// in State for validation; never infer which rules a prompt contains via NLP.
export function providerRegistryProfile(config, profile) {
  if (profile === null) return null
  const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value ?? {}, key))
    .map(key => [key, value[key]]))
  const stepRules = pick(profile.stepRules, config.registryProjection.stepFields)
  return {
    registryID: profile.registryID,
    registryDefaults: profile.registryDefaults,
    workflowRules: pick(profile.workflowRules, config.registryProjection.workflowFields),
    stepRules,
    checkProfiles: { ...selectedChecks(stepRules, profile.checkProfiles) },
    upstreamArtifacts: profile.upstreamArtifacts,
    outputArtifact: profile.outputArtifact,
    diagnostics: profile.diagnostics,
  }
}

export function validateRegistryProfile(profile, session) {
  if (profile === null) return // Not materialized until the first business projection.
  if (!object(profile) || Object.keys(profile).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(profile, key)) ||
    profile.stepID !== session.currentStageID || profile.registryPath !== session.workflowReferences.registryPath ||
    !Array.isArray(profile.diagnostics) || !Array.isArray(profile.upstreamArtifacts) || !object(profile.checkProfiles)) fail("invalid stored fields; reset state and use a new Session")
  if (profile.registrySha256 === null) {
    if (profile.registryID !== null || profile.registryDefaults !== null ||
      profile.workflowRules !== null || profile.stepRules !== null || profile.outputArtifact !== null ||
      profile.upstreamArtifacts.length !== 0 || Object.keys(profile.checkProfiles).length !== 0 || profile.diagnostics.length !== 1 ||
      !["registry-path-unreported", "registry-read-unavailable"].includes(profile.diagnostics[0]?.code)) fail("invalid unavailable profile")
    return
  }
  if (!/^[a-f0-9]{64}$/u.test(profile.registrySha256) || typeof profile.registryID !== "string" || profile.registryID.trim() === "" ||
    !object(profile.registryDefaults) || Object.keys(profile.registryDefaults).length !== 1 || !Object.hasOwn(profile.registryDefaults, "execution_mode") ||
    !object(profile.workflowRules) || !object(profile.stepRules) ||
    profile.diagnostics.length !== 0 || (profile.workflowRules.dependency_policy !== undefined &&
      profile.workflowRules.dependency_policy !== "all_earlier_steps_in_step_order")) fail("invalid stored rules")
  const order = profile.workflowRules.step_order
  if (!Array.isArray(order) || !order.every(id => typeof id === "string" && id !== "") ||
    new Set(order).size !== order.length || !order.includes(profile.stepID) || !profile.upstreamArtifacts.every(object)) fail("invalid upstream references")
  const upstreamIDs = profile.upstreamArtifacts.map(item => item.stepID)
  const earlierIDs = order.slice(0, order.indexOf(profile.stepID))
  if (profile.workflowRules.dependency_policy === "all_earlier_steps_in_step_order") {
    if (JSON.stringify(upstreamIDs) !== JSON.stringify(earlierIDs)) fail("invalid upstream references")
  } else {
    // Whole-graph closure was checked on entry. The cached Profile stores only
    // current-step rules: validate ordered earlier refs and required direct deps.
    const direct = directDependencies({ ...profile.stepRules, id: profile.stepID }, order)
    if (new Set(upstreamIDs).size !== upstreamIDs.length ||
      JSON.stringify(upstreamIDs) !== JSON.stringify(earlierIDs.filter(id => upstreamIDs.includes(id))) ||
      direct.some(id => !upstreamIDs.includes(id)) || (direct.length === 0 && upstreamIDs.length !== 0)) fail("invalid upstream depends_on references")
  }
  for (const ref of [...profile.upstreamArtifacts, profile.outputArtifact]) {
    if (!object(ref) || typeof ref.stepID !== "string") fail("invalid stored artifact reference")
    if (ref.path === null) {
      const expected = resolveArtifactPath(ref.template, session.workflowReferences)
      if (JSON.stringify(expected) !== JSON.stringify({ path: ref.path, template: ref.template, missingVariables: ref.missingVariables })) fail("invalid unresolved artifact reference")
    } else if (typeof ref.path !== "string" || resolveArtifactPath(ref.path, {}).path !== ref.path) {
      fail("invalid absolute artifact reference")
    }
  }
  if (profile.outputArtifact.stepID !== profile.stepID) fail("output belongs to another step")
}
