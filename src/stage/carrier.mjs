import { createHash } from "node:crypto"
import { lastRealUserMessage, messageID, xmlAttribute } from "./messages.mjs"
import { providerRegistryProfile } from "./registry-profile.mjs"

export function projectionUserMessage(session, kind, text) {
  const digest = createHash("sha256")
    .update(`${session.sessionID}\0${session.currentStageRunID ?? "activation"}\0${kind}`)
    .digest("hex")
    .slice(0, 16)
  const id = `msg_adaptive_${kind}_${digest}`
  return {
    info: { id, role: "user", sessionID: session.sessionID, synthetic: true },
    parts: [{
      type: "text",
      text,
      id: `prt_adaptive_${kind}_${digest}`,
      messageID: id,
      sessionID: session.sessionID,
      synthetic: true,
    }],
  }
}

function includesIssueSource(config, session) {
  return session.currentStageID === null ||
    config.includeIssueSourceByStage.includes(session.currentStageID)
}

export function contextCarrier(config, session) {
  const stageID = session.currentStageID ?? "not-declared"
  const instructions = [
    session.currentStageID === null
      ? `Follow original startup/resume rules, then call ${config.stageControlTool} once to enter the selected first stage; report known paths only.`
      : `Stage ${stageID} is registered; do not redeclare it.`,
    "Use provided artifact paths, configuration and handoff directly. Read Registry only for required information absent here or an explicit configuration change; do not repeat Registry discovery or reconfirm provided rules/paths. Paths do not prove existence or validation. Handoff is fallible memory; check code/artifacts when needed. Registry defaults are not the actual execution mode/policy.",
    `The Agent prompt/Work Plan own business decisions. Complete this stage's required work, then select and enter the next step with ${config.stageControlTool} and continue in this Session; do not end with an intermediate report or ask whether to continue. Every real transition requires handoff from existing context ("" only if nothing is reusable); do not explore to write it. Follow original Plan read/create/check timing, never create it early or reread after a successful update merely to confirm. Preserve required validation, confirmations and true stop conditions; return normally when the workflow is complete.`,
  ]
  const sections = [
    `<bugfix-adaptive-context authority="plugin" stage="${xmlAttribute(stageID)}" stageRun="${xmlAttribute(session.currentStageRunID ?? "none")}">`,
    JSON.stringify({
      scope: "message-projection-only",
      currentStageID: session.currentStageID,
      stageDeclarationStatus: session.currentStageID === null ? "not-declared" : "registered",
      currentStageDeclarationRequired: session.currentStageID === null,
      stageRunID: session.currentStageRunID,
      workflowReferences: session.workflowReferences,
      registryConfiguration: providerRegistryProfile(config, session.contextProfile),
      instructions,
    }),
  ]
  if (includesIssueSource(config, session)) {
    sections.push("<authoritative-invocation-input>", session.issueSourceText, "</authoritative-invocation-input>")
  }
  sections.push("</bugfix-adaptive-context>")
  return projectionUserMessage(session, "context", sections.join("\n\n"))
}

// User supplements are messages, not mutable fields in the early Carrier.
// Preserve the last entry-time supplement and invocation attachments separately.
export function entryInputMessages(config, session, messages, tail) {
  const tailIDs = new Set(tail.map(messageID))
  const firstTailIndex = tail.length > 0
    ? messages.findIndex((message) => messageID(message) === messageID(tail[0]))
    : messages.length
  const entryUser = lastRealUserMessage(messages.slice(0, firstTailIndex))
  const inputs = []
  if (
    entryUser &&
    messageID(entryUser) !== session.issueSourceMessageID &&
    !tailIDs.has(messageID(entryUser))
  ) {
    inputs.push(structuredClone(entryUser))
  }
  if (includesIssueSource(config, session) && !tailIDs.has(session.issueSourceMessageID)) {
    const invocation = messages.find((message) => messageID(message) === session.issueSourceMessageID)
    const attachments = invocation?.parts?.filter((part) => part.type !== "text") ?? []
    if (attachments.length > 0) {
      inputs.unshift({ ...structuredClone(invocation), parts: structuredClone(attachments) })
    }
  }
  return inputs
}
