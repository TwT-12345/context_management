import { messageID, outputHash, toolPart, xmlAttribute, estimateTextTokens } from "./messages.mjs"
import { projectionUserMessage } from "./carrier.mjs"

const FIELDS = ["fromStageRunID", "toStageRunID", "sourceCallID", "sourceMessageID", "content", "sha256"]
const fail = message => { throw new Error(`Invalid adaptive Stage handoff State: ${message}`) }

export function createStageHandoff(session, toStageRunID, sourceCallID, content) {
  if (content === undefined) {
    if (session.currentStageRunID === null) return null
    const error = new Error('BUGFIX_HANDOFF_REQUIRED: No stage change or history pruning occurred. Retry the requested next-stage call with handoff summarizing reusable code findings from existing context; use "" only when nothing is reusable. Do not redeclare the current stage or stop at a report.')
    error.code = "BUGFIX_HANDOFF_REQUIRED"
    throw error
  }
  if (typeof content !== "string" || content.includes("\0")) fail("handoff must be Markdown text without NUL characters")
  if (content.trim() === "") return null
  if (session.currentStageRunID === null) fail("omit handoff on the first stage registration")
  return {
    fromStageRunID: session.currentStageRunID, toStageRunID, sourceCallID,
    sourceMessageID: null, content, sha256: outputHash(content),
  }
}

export function validateStageHandoff(session) {
  if (!Object.hasOwn(session, "stageHandoff")) fail("missing stageHandoff; reset and use a new Session")
  const record = session.stageHandoff
  if (record === null) return
  if (typeof record !== "object" || Array.isArray(record) ||
    Object.keys(record).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(record, field)) ||
    session.stageSequence < 2 || record.fromStageRunID !== session.stageHistory.at(-2)?.stageRunID ||
    record.toStageRunID !== session.currentStageRunID || record.sourceCallID !== session.stageBoundary?.enteredAfterToolCallID ||
    typeof record.sourceCallID !== "string" || record.sourceCallID === "" ||
    (record.sourceMessageID !== null && (typeof record.sourceMessageID !== "string" ||
      record.sourceMessageID === "" || record.sourceMessageID !== session.stageBoundary?.messageID)) ||
    typeof record.content !== "string" || record.content.trim() === "" || record.content.includes("\0") ||
    record.sha256 !== outputHash(record.content)) fail("invalid content, integrity or Stage Run ownership")
}

// Archive only a real completed entry Tool. The before Hook's arguments alone
// are insufficient to restore memory after native compaction hides the call.
export function observeStageHandoff(config, session, messages) {
  const record = session.stageHandoff
  if (!record) return true
  const match = toolPart(messages, record.sourceCallID)
  if (!match) return record.sourceMessageID !== null
  const id = messageID(match.message)
  if (!id || match.part.tool !== config.stageControlTool || match.part.state?.status !== "completed" ||
    match.part.state.input?.stageID !== session.currentStageID || match.part.state.input?.handoff !== record.content ||
    (record.sourceMessageID !== null && record.sourceMessageID !== id)) fail("entry Tool is not the matching completed handoff source")
  record.sourceMessageID = id
  return true
}

export function projectStageHandoff(config, session, messages) {
  const record = session.stageHandoff
  if (!record) return { messages: [], audit: { mode: "none" } }
  if (!observeStageHandoff(config, session, messages)) fail("cannot restore an unobserved entry Tool")
  const audit = {
    fromStageRunID: record.fromStageRunID, toStageRunID: record.toStageRunID,
    sourceCallID: record.sourceCallID, sourceMessageID: record.sourceMessageID,
    sha256: record.sha256, contentEstimatedTokens: estimateTextTokens(record.content),
  }
  // Keep the native Tool Call/receipt unchanged. Its input already contains the
  // handoff; a second memory Message would needlessly duplicate that content.
  if (toolPart(messages, record.sourceCallID)) return { messages: [], audit: { ...audit, mode: "entry-tool" } }
  const text = [
    `<bugfix-adaptive-handoff authority="memory" fromStageRun="${xmlAttribute(record.fromStageRunID)}" toStageRun="${xmlAttribute(record.toStageRunID)}">`,
    "Agent-authored working memory, not verified evidence or workflow authority. Current artifacts and code take precedence.",
    record.content,
    "</bugfix-adaptive-handoff>",
  ].join("\n\n")
  const message = projectionUserMessage(session, "handoff", text)
  return { messages: [message], audit: { ...audit, mode: "restored-message", messageID: messageID(message) } }
}
