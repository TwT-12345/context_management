import fs from "node:fs/promises"
import path from "node:path"
import { validateCompactionState } from "./compaction.mjs"
import { validateRegistryProfile } from "./registry-profile.mjs"
import { createStageHandoff, validateStageHandoff } from "./handoff.mjs"

export const STATE_VERSION = 9

const REFERENCE_FIELDS = ["registryPath", "workPlanPath", "workspaceRoot", "projectRoot", "issueNumber"]

function emptyReferences() {
  return Object.fromEntries(REFERENCE_FIELDS.map((field) => [field, null]))
}

function validateReferences(references) {
  if (!references || typeof references !== "object" || Array.isArray(references) ||
    Object.keys(references).length !== REFERENCE_FIELDS.length) {
    throw new Error("Invalid adaptive workflow references. Reset state and use a new Session.")
  }
  for (const field of REFERENCE_FIELDS) {
    const value = references[field]
    if (value === null) continue
    if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f]/u.test(value)) {
      throw new Error(`Invalid adaptive workflow reference ${field}: expected a non-empty string`)
    }
    if (field !== "issueNumber" && (
      !(path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value)) ||
      value.includes("{{") || value.includes("}}")
    )) {
      throw new Error(`Invalid adaptive workflow reference ${field}: expected a resolved absolute path`)
    }
  }
}

function now() {
  return new Date().toISOString()
}

function emptyState(config) {
  return {
    version: STATE_VERSION,
    pluginID: config.pluginID,
    configHash: config.configHash,
    targetAgent: config.targetAgent,
    sessions: {},
  }
}

function validateSession(session, sessionID, config) {
  if (
    session?.sessionID !== sessionID ||
    typeof session.issueSourceMessageID !== "string" ||
    typeof session.issueSourceText !== "string" ||
    !Number.isSafeInteger(session.stageSequence) || session.stageSequence < 0 ||
    !Array.isArray(session.stageHistory) ||
    !Array.isArray(session.observationRequests) ||
    !Array.isArray(session.observations)
  ) {
    throw new Error(`Invalid adaptive projection Session State: ${sessionID}`)
  }
  validateReferences(session.workflowReferences)
  if (!Object.hasOwn(session, "contextProfile") || (session.currentStageID === null && session.contextProfile !== null)) {
    throw new Error(`Invalid adaptive Context Profile State: ${sessionID}. Reset state and use a new Session.`)
  }
  validateRegistryProfile(session.contextProfile, session)
  if (session.currentStageID !== null && !config.stages.includes(session.currentStageID)) {
    throw new Error(`Unknown adaptive Context Stage ${String(session.currentStageID)} in ${sessionID}`)
  }
  if ((session.currentStageID === null) !== (session.currentStageRunID === null)) {
    throw new Error(`Adaptive Context Stage and Run must be bound together: ${sessionID}`)
  }
  const lastStage = session.stageHistory.at(-1)
  if (session.stageSequence !== session.stageHistory.length ||
    new Set(session.stageHistory.map((entry) => entry.stageRunID)).size !== session.stageHistory.length ||
    (session.stageSequence === 0 && (session.currentStageID !== null || session.stageBoundary !== null)) ||
    (session.stageSequence > 0 && (!session.stageBoundary || lastStage.stageRunID !== session.currentStageRunID ||
      lastStage.stageID !== session.currentStageID || lastStage.enteredAfterToolCallID !== session.stageBoundary.enteredAfterToolCallID))) {
    throw new Error(`Invalid adaptive Stage Run ledger in ${sessionID}`)
  }
  validateCompactionState(session)
  validateStageHandoff(session)
  const observationKeys = new Set()
  for (const observation of session.observations) {
    const key = `${observation.stageRunID}\0${observation.sourceCallID}`
    if (observationKeys.has(key)) {
      throw new Error(`Duplicate adaptive Observation source ${observation.sourceCallID}: ${sessionID}`)
    }
    observationKeys.add(key)
  }
}

function validateState(state, file, config) {
  if (
    state?.version !== STATE_VERSION ||
    state.pluginID !== config.pluginID ||
    state.configHash !== config.configHash ||
    state.targetAgent !== config.targetAgent ||
    !state.sessions ||
    typeof state.sessions !== "object" ||
    Array.isArray(state.sessions)
  ) {
    throw new Error(`Invalid or stale adaptive projection State: ${file}. Reset state and use a new Session after plugin/config upgrades.`)
  }
  for (const [sessionID, session] of Object.entries(state.sessions)) {
    validateSession(session, sessionID, config)
  }
  return state
}

export async function readState(file, config) {
  try {
    return validateState(JSON.parse(await fs.readFile(file, "utf8")), file, config)
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(config)
    throw error
  }
}

export async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(
    temporary,
    `${JSON.stringify({ ...state, updatedAt: now() }, null, 2)}\n`,
  )
  await fs.rename(temporary, file)
}

export function createStateSerializer() {
  let tail = Promise.resolve()
  return async (operation) => {
    const previous = tail
    let release
    tail = new Promise((resolve) => (release = resolve))
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export function createSession({ sessionID, issueSourceMessageID, issueSourceText, workspaceRoot = null }) {
  const createdAt = now()
  return {
    sessionID,
    issueSourceMessageID,
    issueSourceText,
    currentStageID: null,
    currentStageRunID: null,
    stageSequence: 0,
    stageBoundary: null,
    stageHistory: [],
    compactions: {},
    workflowReferences: { ...emptyReferences(), workspaceRoot },
    contextProfile: null,
    stageHandoff: null,
    observationRequests: [],
    observations: [],
    createdAt,
    updatedAt: createdAt,
  }
}

export function declareStage(session, { stageID, boundaryToolCallID, handoff, ...references }) {
  const previousStageID = session.currentStageID
  if (session.currentStageID === stageID) {
    return {
      changed: false,
      previousStageID,
      stageID,
      stageRunID: session.currentStageRunID,
      reason: "same-stage-idempotent",
    }
  }
  // Only a genuine stage entry may change the Carrier. Omitted references carry
  // forward; no file probing, path inference, business state, or existence cache.
  const workflowReferences = { ...session.workflowReferences }
  for (const field of REFERENCE_FIELDS) {
    if (field !== "workspaceRoot" && references[field] !== undefined) workflowReferences[field] = references[field]
  }
  validateReferences(workflowReferences)
  const stageRunID = `stage_${stageID}_${String(session.stageSequence + 1).padStart(2, "0")}`
  const stageHandoff = createStageHandoff(session, stageRunID, boundaryToolCallID, handoff)
  const changedAt = now()
  session.stageSequence += 1
  session.currentStageID = stageID
  session.workflowReferences = workflowReferences
  session.contextProfile = null
  session.currentStageRunID = stageRunID
  session.stageHandoff = stageHandoff
  session.stageBoundary = {
    enteredAfterToolCallID: boundaryToolCallID,
    enteredAt: changedAt,
    messageID: null,
    partID: null,
    partIndex: null,
  }
  session.stageHistory.push({
    stageID,
    stageRunID: session.currentStageRunID,
    enteredAfterToolCallID: boundaryToolCallID,
    enteredAt: changedAt,
    messageID: null,
    partID: null,
    partIndex: null,
  })
  session.updatedAt = changedAt
  return {
    changed: true,
    previousStageID,
    stageID,
    stageRunID: session.currentStageRunID,
    reason: "prompt-declared-stage",
  }
}
