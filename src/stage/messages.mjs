import { createHash } from "node:crypto"

const CJK_OR_SYLLABIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const ASCII_WORD = /^[A-Za-z0-9_]+$/u

function jsonText(value) {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

export function outputText(output) {
  return typeof output === "string" ? output : jsonText(output)
}

export function outputHash(output) {
  return createHash("sha256").update(outputText(output)).digest("hex")
}

export function estimateTextTokens(text) {
  if (typeof text !== "string" || text === "") return 0
  const segments = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9_]+|[^\s]/gu,
  ) ?? []
  return segments.reduce((total, segment) => {
    if (CJK_OR_SYLLABIC.test(segment)) return total + 1
    if (ASCII_WORD.test(segment)) return total + Math.max(1, Math.ceil(segment.length / 4))
    return total + 1
  }, 0)
}

export function isRealUserMessage(message) {
  if (message?.info?.role !== "user") return false
  return (message.parts ?? []).some((part) => part.type !== "compaction" && part.synthetic !== true)
}

// filterCompacted can reorder the native view. Agent identity follows the latest
// native User, including the compaction control/continuation, not array position.
export function latestAgentUser(messages) {
  return messages.filter((message) => message.info?.role === "user" &&
    typeof message.info.agent === "string").reduce((latest, message) =>
    !latest || message.info.id > latest.info.id ? message : latest, null)
}

export function textFromMessage(message) {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n")
}

export function lastRealUserMessage(messages) {
  const index = messages.findLastIndex(isRealUserMessage)
  return index < 0 ? null : messages[index]
}

export function messageID(message) {
  return typeof message?.info?.id === "string" ? message.info.id : null
}

export function isCompactionSummary(message) {
  return (
    message?.info?.role === "assistant" &&
    (message.info.summary === true || message.info.mode === "compaction")
  )
}

export function compactionSummaryText(message) {
  return (message.parts ?? []).filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n\n").trim()
}

export function toolPart(messages, callID) {
  for (const message of messages) {
    const part = (message.parts ?? []).find(
      (candidate) => candidate.type === "tool" && candidate.callID === callID,
    )
    if (part) return { message, part }
  }
  return null
}

export function currentStageTail(messages, session) {
  const window = stageRawMessages(messages, session)
  const allowed = new Set([session.currentStageRunID ?? "activation"])
  if (session.stageSequence === 1) allowed.add("activation")
  const cutoff = session.stageSequence > 1
    ? session.stageBoundary?.messageID : session.issueSourceMessageID
  const summaries = messages.filter(isCompactionSummary).filter((message) => {
    if (!message.info.finish || message.info.error) return false
    const record = Object.values(session.compactions ?? {}).find((item) => item.summaryMessageID === messageID(message))
    if (record?.status === "completed") {
      if (message.info.parentID !== record.controlMessageID ||
        outputHash(compactionSummaryText(message)) !== record.summarySha256) {
        throw new Error(`Compaction summary integrity changed: ${messageID(message)}`)
      }
      return allowed.has(record.stageRunID)
    }
    // A summary older than the current entry cannot cover current-stage work.
    if (cutoff && messageID(message) < cutoff) return false
    throw new Error(`Untracked compaction summary ${messageID(message)}; cannot establish its Stage Run ownership`)
  }).sort((left, right) => messageID(left) < messageID(right) ? -1 : 1)
  return {
    messages: [...summaries.slice(-1), ...window.messages],
    boundaryResolution: summaries.length > 0 ? "native-compaction-summary" : window.boundaryResolution,
  }
}

export function resolveStageBoundary(messages, session) {
  if (!session.stageBoundary) return true
  const callID = session.stageBoundary.enteredAfterToolCallID
  const match = toolPart(messages, callID)
  if (!match) return session.stageBoundary.messageID !== null
  const id = messageID(match.message)
  if (!id) throw new Error("Stage Tool boundary has no Message ID")
  const index = match.message.parts.indexOf(match.part)
  if (session.stageBoundary.messageID !== null && (
    session.stageBoundary.messageID !== id || (session.stageBoundary.partID !== null &&
      session.stageBoundary.partID !== (match.part.id ?? null))
  )) throw new Error(`Stage Tool boundary changed for ${callID}`)
  Object.assign(session.stageBoundary, { messageID: id, partID: match.part.id ?? null, partIndex: index })
  const entry = session.stageHistory.find((item) => item.stageRunID === session.currentStageRunID)
  if (entry) Object.assign(entry, { messageID: id, partID: match.part.id ?? null, partIndex: index })
  return true
}

// Raw history only: summaries travel through the Stage Run ownership
// channel, and native compaction controls are never real user instructions.
export function stageRawMessages(messages, session) {
  resolveStageBoundary(messages, session)
  const initial = session.stageSequence <= 1
  const callID = session.stageBoundary?.enteredAfterToolCallID
  const visibleIndex = initial
    ? messages.findIndex((message) => messageID(message) === session.issueSourceMessageID)
    : messages.findIndex((message) => message.parts?.some((part) => part.type === "tool" && part.callID === callID))
  const cutoff = initial ? session.issueSourceMessageID : session.stageBoundary?.messageID
  if (!cutoff) throw new Error("Cannot resolve Stage message boundary; refusing silent history deletion")
  if (!initial && visibleIndex < 0 && messages.some((message) => messageID(message) === cutoff)) {
    throw new Error("Stage boundary Message is visible without its Tool Part")
  }
  const selected = visibleIndex >= 0
    ? messages.slice(visibleIndex + (initial ? 1 : 0))
    // Native ascending Message IDs remain usable after compaction hides the
    // entry Tool. Never replace this cutoff with a timestamp guess.
    : messages.filter((message) => messageID(message) > cutoff)
  const result = []
  for (const original of selected) {
    if (isCompactionSummary(original)) continue
    const message = structuredClone(original)
    if (!initial && messageID(message) === cutoff) {
      message.parts = message.parts.slice(session.stageBoundary.partIndex)
    }
    message.parts = (message.parts ?? []).filter((part) => part.type !== "compaction")
    if (message.parts.length > 0) result.push(message)
  }
  return { messages: result, boundaryResolution: visibleIndex >= 0
    ? initial ? session.stageSequence === 1 ? "initial-stage-history" : "activation-message" : "exact-stage-tool"
    : "stage-message-boundary" }
}

function partVisibleText(part) {
  if ((part?.type === "text" || part?.type === "reasoning") && part.ignored !== true) {
    return typeof part.text === "string" ? part.text : ""
  }
  if (part?.type !== "tool") return ""
  const state = part.state ?? {}
  const values = [part.tool, jsonText(state.input)]
  if (state.status === "completed") values.push(outputText(state.output))
  if (state.status === "error") values.push(outputText(state.error))
  return values.filter(Boolean).join("\n")
}

function measureMessages(messages) {
  const items = messages.map((message, index) => {
    const text = (message.parts ?? []).map(partVisibleText).filter(Boolean).join("\n")
    return {
      messageID: messageID(message) ?? `unidentified-${index}`,
      role: message.info?.role ?? "unknown",
      characters: text.length,
      estimatedTokens: estimateTextTokens(text) + 4,
    }
  })
  return {
    messageCount: items.length,
    characters: items.reduce((sum, item) => sum + item.characters, 0),
    estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
    items,
  }
}

export function projectionMetrics(beforeMessages, afterMessages) {
  const before = measureMessages(beforeMessages)
  const after = measureMessages(afterMessages)
  const afterIDs = new Set(after.items.map((item) => item.messageID))
  const removed = before.items.filter((item) => !afterIDs.has(item.messageID))
  const { items: _beforeItems, ...beforeTotals } = before
  const { items: _afterItems, ...afterTotals } = after
  return {
    mode: "estimated",
    scope: "messages-only",
    before: beforeTotals,
    after: afterTotals,
    savings: {
      estimatedTokens: before.estimatedTokens - after.estimatedTokens,
      ratio: before.estimatedTokens === 0
        ? 0
        : Number(((before.estimatedTokens - after.estimatedTokens) / before.estimatedTokens).toFixed(4)),
    },
    removedMessages: {
      count: removed.length,
      estimatedTokens: removed.reduce((sum, item) => sum + item.estimatedTokens, 0),
    },
  }
}

export function xmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

