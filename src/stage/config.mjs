import { createHash } from "node:crypto"
import fs from "node:fs/promises"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validateConfig(config, file = "<config>") {
  assert(config?.version === 2, `Adaptive projection config version must be 2. Use --replace-config --reset-state and a new Session: ${file}`)
  assert(typeof config.pluginID === "string" && config.pluginID !== "", `pluginID is required: ${file}`)
  assert(typeof config.targetAgent === "string" && config.targetAgent !== "", `targetAgent is required: ${file}`)
  assert(
    typeof config.stageControlTool === "string" && config.stageControlTool !== "",
    `stageControlTool is required: ${file}`,
  )
  assert(
    typeof config.observationTool === "string" && config.observationTool !== "",
    `observationTool is required: ${file}`,
  )
  assert(
    Array.isArray(config.stages) && config.stages.length > 0,
    `stages must be a non-empty array: ${file}`,
  )
  assert(
    config.stages.every((stage) => typeof stage === "string" && stage !== ""),
    `every stage must be a non-empty string: ${file}`,
  )
  assert(new Set(config.stages).size === config.stages.length, `stages must be unique: ${file}`)
  assert(
    Array.isArray(config.includeIssueSourceByStage) &&
      config.includeIssueSourceByStage.every((stage) => config.stages.includes(stage)),
    `includeIssueSourceByStage must reference configured stages: ${file}`,
  )

  const policy = config.observationPolicy
  assert(isObject(policy), `observationPolicy is required: ${file}`)
  assert(policy.enabled === true || policy.enabled === false, `observationPolicy.enabled must be boolean: ${file}`)
  assert(policy.enabled === false, `Stage-only experiment requires observationPolicy.enabled=false: ${file}`)
  assert(config.pluginID === "bugfix-adaptive-stage-only-v1", `Stage-only experiment requires its own pluginID: ${file}`)
  assert(Array.isArray(policy.tools) && policy.tools.length > 0, `observationPolicy.tools is required: ${file}`)
  assert(isObject(policy.minOutputEstimatedTokensByTool), `observation thresholds are required: ${file}`)
  for (const tool of policy.tools) {
    assert(typeof tool === "string" && tool !== "", `observation tool names must be non-empty: ${file}`)
    assert(
      Number.isSafeInteger(policy.minOutputEstimatedTokensByTool[tool]) &&
        policy.minOutputEstimatedTokensByTool[tool] > 0,
      `missing positive observation threshold for ${tool}: ${file}`,
    )
  }
  assert(
    Number.isFinite(policy.maxProjectedRatio) &&
      policy.maxProjectedRatio > 0 &&
      policy.maxProjectedRatio < 1,
    `maxProjectedRatio must be between 0 and 1: ${file}`,
  )
  assert(
    Number.isSafeInteger(policy.minAbsoluteSavingsEstimatedTokens) &&
      policy.minAbsoluteSavingsEstimatedTokens >= 0,
    `minAbsoluteSavingsEstimatedTokens must be a non-negative integer: ${file}`,
  )
  assert(
    Number.isSafeInteger(policy.maxRequests) && policy.maxRequests >= 1,
    `maxRequests must be a positive integer: ${file}`,
  )
  for (const key of [
    "protectBugfixPaths",
    "protectSkillDirectories",
    "allowModelRetainFull",
  ]) {
    assert(policy[key] === true || policy[key] === false, `${key} must be boolean: ${file}`)
  }
  assert(isObject(config.audit), `audit config is required: ${file}`)
  const projection = config.registryProjection
  assert(isObject(projection) && Object.keys(projection).length === 2, `registryProjection must define workflowFields and stepFields: ${file}`)
  for (const field of ["workflowFields", "stepFields"]) {
    assert(Array.isArray(projection[field]) && new Set(projection[field]).size === projection[field].length &&
      projection[field].every(key => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) &&
        !["__proto__", "prototype", "constructor"].includes(key)),
    `registryProjection.${field} must contain unique YAML field names: ${file}`)
  }
  assert(config.audit.includeMessages === false,
    `Stage-only audit requires audit.includeMessages=false. Replace config, reset state and use a new Session (--replace-config --reset-state): ${file}`)
  return config
}

export async function readConfig(file) {
  let config
  try {
    config = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Adaptive projection config not found: ${file}`)
    }
    throw error
  }
  validateConfig(config, file)
  return {
    ...config,
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
  }
}
