import {
  compactionSummaryText, isCompactionSummary, messageID, outputHash, resolveStageBoundary,
} from "./messages.mjs"

// OpenCode 1.2.27 does not transform the summary input. Associate native memory
// with the Stage Run in which compaction started; do not claim input isolation.
export const SUMMARY_INPUT_ISOLATION = "native-unscoped"
const FIELDS = ["controlMessageID", "stageRunID", "status", "inputIsolation", "summaryMessageID", "summarySha256"]

export function validateCompactionState(session) {
  const fail = () => { throw new Error(`Invalid adaptive compaction State in ${session.sessionID}; reset State and use a new Session`) }
  if (!session.compactions || typeof session.compactions !== "object" || Array.isArray(session.compactions)) fail()
  const runs = new Set(["activation", ...session.stageHistory.map((entry) => entry.stageRunID)])
  const summaries = new Set()
  for (const [key, record] of Object.entries(session.compactions)) {
    if (!record || Object.keys(record).length !== FIELDS.length || Object.keys(record).some((field) => !FIELDS.includes(field)) ||
      record.controlMessageID !== key || key === "" || !runs.has(record.stageRunID) ||
      !["prepared", "completed", "failed"].includes(record.status) || record.inputIsolation !== SUMMARY_INPUT_ISOLATION) fail()
    if (record.status === "completed") {
      if (typeof record.summaryMessageID !== "string" || record.summaryMessageID <= key ||
        !/^[a-f0-9]{64}$/u.test(record.summarySha256) || summaries.has(record.summaryMessageID)) fail()
      summaries.add(record.summaryMessageID)
    } else if (record.summaryMessageID !== null || record.summarySha256 !== null) fail()
  }
  const boundary = session.stageBoundary
  if (boundary) {
    const optionalID = value => value === null || (typeof value === "string" && value !== "")
    if (!optionalID(boundary.messageID) || !optionalID(boundary.partID) ||
      !(boundary.partIndex === null || (Number.isSafeInteger(boundary.partIndex) && boundary.partIndex >= 0)) ||
      (boundary.messageID === null) !== (boundary.partIndex === null) ||
      (boundary.messageID === null && boundary.partID !== null)) fail()
    const entry = session.stageHistory.at(-1)
    if (entry.messageID !== boundary.messageID || entry.partID !== boundary.partID || entry.partIndex !== boundary.partIndex) fail()
  }
}

export async function readNativeMessages(client, directory, sessionID) {
  if (!client?.session?.messages) throw new Error("OpenCode Session client is required to resolve compaction ownership")
  const result = await client.session.messages({ path: { id: sessionID }, query: { directory } })
  if (result.error || !Array.isArray(result.data)) throw new Error(`Cannot read native Session ${sessionID} for compaction ownership`)
  const ids = new Set()
  for (const message of result.data) {
    if (message.info?.sessionID !== sessionID || !messageID(message) || ids.has(messageID(message)) || !Array.isArray(message.parts)) {
      throw new Error(`Invalid native Session messages for ${sessionID}`)
    }
    ids.add(messageID(message))
  }
  return [...result.data].sort((left, right) => messageID(left) < messageID(right) ? -1 : 1)
}

export function reconcileCompactions(session, messages) {
  const changes = []
  for (const record of Object.values(session.compactions)) {
    const candidates = messages.filter(message => isCompactionSummary(message) &&
      message.info.parentID === record.controlMessageID && message.info.finish && !message.info.error)
    if (candidates.length > 1) throw new Error(`Ambiguous completed compaction for ${record.controlMessageID}`)
    const summary = candidates[0]
    if (record.status === "completed") {
      if (summary && (record.summaryMessageID !== messageID(summary) ||
        record.summarySha256 !== outputHash(compactionSummaryText(summary)))) {
        throw new Error(`Compaction summary integrity changed: ${record.summaryMessageID}`)
      }
      continue
    }
    if (summary) {
      if (!compactionSummaryText(summary) || messageID(summary) <= record.controlMessageID) {
        throw new Error(`Invalid completed compaction summary for ${record.controlMessageID}`)
      }
      Object.assign(record, { status: "completed", summaryMessageID: messageID(summary),
        summarySha256: outputHash(compactionSummaryText(summary)) })
    } else if (record.status !== "failed" && messages.some(message => isCompactionSummary(message) &&
      message.info.parentID === record.controlMessageID && message.info.error)) {
      record.status = "failed"
    } else continue
    changes.push({ ...record })
  }
  return changes
}

export function prepareCompaction(config, session, history) {
  reconcileCompactions(session, history)
  if (!resolveStageBoundary(history, session)) throw new Error("Cannot resolve Stage Tool boundary before compaction")
  const control = history.findLast(message => message.info.role === "user" &&
    message.parts.some(part => part.type === "compaction"))
  if (!control || control.info.agent !== config.targetAgent) throw new Error("Cannot identify target compaction control Message")
  const id = messageID(control)
  const existing = session.compactions[id]
  const stageRunID = session.currentStageRunID ?? "activation"
  if (existing && (existing.stageRunID !== stageRunID || existing.status === "completed")) {
    throw new Error(`Compaction ${id} is already assigned or completed`)
  }
  const record = existing ?? { controlMessageID: id, stageRunID, status: "prepared",
    inputIsolation: SUMMARY_INPUT_ISOLATION, summaryMessageID: null, summarySha256: null }
  session.compactions[id] = record
  const context = [
    '<bugfix-adaptive-compaction inputIsolation="native-unscoped">',
    "以下要求仅约束本次摘要的内容与写法，沿用原生摘要格式。",
    `当前登记阶段：${session.currentStageID ?? "not-declared"}；Stage Run：${stageRunID}。`,
    `已知工作流路径（Agent 报告的定位信息，不代表阶段完成或文件已存在）：${JSON.stringify(session.workflowReferences)}`,
    "请优先保留：",
    "1. 用户的任务目标、后续补充与纠正，以及仍然有效的重要约束。",
    "2. 当前阶段已经实际完成的工作、关键发现和支持这些发现的证据。",
    "3. 已生成或修改的产物路径、相关代码位置，以及继续工作必需的关键细节。",
    "4. 尚未完成的工作、正在进行的操作、失败尝试及其原因，避免重复探索。",
    "5. 真实阻塞、原流程要求的用户确认、未确认事项和不确定性，不能把推测写成已完成事实。",
    "历史可能包含多个阶段。优先总结当前工作；旧阶段只保留后续仍需使用的结论和产物引用。",
    "省略重复叙述、冗长思考和可按路径重新读取的大段原文，但不要为缩短摘要而删除必要信息。",
    "摘要只是执行记忆，不决定阶段切换、路线或任务完成。",
    "本次调用仅生成供后续继续任务使用的摘要。准确区分已完成工作、正在进行的工作和待办事项，不把计划写成已执行事实。不要在摘要中新增阶段推进限制或等待用户指示的要求。",
    ...(session.currentStageID === null || config.includeIssueSourceByStage.includes(session.currentStageID)
      ? ["<original-invocation-input>", session.issueSourceText, "</original-invocation-input>"] : []),
    "</bugfix-adaptive-compaction>",
  ].join("\n")
  return { record, context }
}
