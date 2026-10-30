import fs from "node:fs/promises"
import path from "node:path"
import { readConfig } from "./config.mjs"
import stageTool from "./tool.mjs"
import {
  latestAgentUser,
  isRealUserMessage,
  projectionMetrics,
  resolveStageBoundary,
  textFromMessage,
} from "./messages.mjs"
import { compileProjection } from "./projection.mjs"
import { observeStageHandoff } from "./handoff.mjs"
import { createCacheDiagnostics } from "./cache-diagnostics.mjs"
import {
  createSession,
  createStateSerializer,
  declareStage,
  readState,
  writeState,
} from "./state.mjs"
import {
  prepareCompaction, readNativeMessages, reconcileCompactions,
} from "./compaction.mjs"

const CONFIG_FILENAME = "bugfix-adaptive-context.config.json"
const STATE_FILENAME = "bugfix-adaptive-context.state.json"
const AUDIT_FILENAME = "bugfix-adaptive-context.jsonl"
const CACHE_FILENAME = "bugfix-adaptive-cache.jsonl"
const IGNORE_ENTRIES = [STATE_FILENAME, `${STATE_FILENAME}.*.tmp`, AUDIT_FILENAME, CACHE_FILENAME, "context-manage.jsonl"]

async function appendEvent(file, event) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(event)}\n`)
}

async function ensureRuntimeFilesIgnored(directory) {
  const ignorePath = path.join(directory, ".opencode", ".gitignore")
  let existing = ""
  try {
    existing = await fs.readFile(ignorePath, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const entries = new Set(existing.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))
  const missing = IGNORE_ENTRIES.filter((entry) => !entries.has(entry))
  if (missing.length === 0) return
  const newline = existing.includes("\r\n") ? "\r\n" : "\n"
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}${newline}`
  await fs.mkdir(path.dirname(ignorePath), { recursive: true })
  await fs.writeFile(ignorePath, `${prefix}${missing.join(newline)}${newline}`)
}

function sessionIDFromMessage(message) {
  const value = message?.info?.sessionID ?? message?.parts?.[0]?.sessionID
  return typeof value === "string" && value !== "" ? value : null
}

export const BugfixAdaptiveContext = async ({ directory, client }, configFile) => {
  const configPath =
    (configFile && path.resolve(directory, configFile)) ??
    process.env.OPENCODE_BUGFIX_ADAPTIVE_CONFIG ??
    path.join(directory, ".opencode", CONFIG_FILENAME)
  const statePath =
    process.env.OPENCODE_BUGFIX_ADAPTIVE_STATE ??
    path.join(directory, ".opencode", STATE_FILENAME)
  const auditPath =
    process.env.OPENCODE_BUGFIX_ADAPTIVE_LOG ??
    path.join(directory, ".opencode", AUDIT_FILENAME)
  const config = await readConfig(configPath)
  const serializeState = createStateSerializer()
  const cachePath = process.env.OPENCODE_BUGFIX_ADAPTIVE_CACHE_LOG ?? path.join(directory, ".opencode", CACHE_FILENAME)
  const diagnostics = createCacheDiagnostics({
    append: event => appendEvent(cachePath, event),
    enabled: process.env.OPENCODE_BUGFIX_ADAPTIVE_CACHE_DIAGNOSTICS !== "0",
  })
  await ensureRuntimeFilesIgnored(directory)

  return {
    tool: { [config.stageControlTool]: stageTool },
    config: async value => diagnostics.configure(value),
    "experimental.chat.system.transform": async (input, output) => diagnostics.system(input, output),
    "chat.params": async (input) => diagnostics.runtime(input),
    "experimental.session.compacting": async ({ sessionID }, output) => {
      await serializeState(async () => {
        const state = await readState(statePath, config)
        const session = state.sessions[sessionID]
        if (!session) return
        const history = await readNativeMessages(client, directory, sessionID)
        const control = history.findLast((message) => message.parts.some((part) => part.type === "compaction"))
        if (control?.info.agent !== config.targetAgent) {
          diagnostics.forget(sessionID)
          return
        }
        const { context } = prepareCompaction(config, session, history)
        await writeState(statePath, state)
        // Keep the native summarizer and history selection intact on 1.2.27.
        output.context.push(context)
        diagnostics.compaction(session, context)
      })
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const currentUser = latestAgentUser(output.messages)
      const diagnosticCall = diagnostics.begin(output.messages, currentUser, config.targetAgent)
      if (!currentUser) {
        await diagnostics.decision(diagnosticCall, {
          decision: "skipped", reason: "no-agent-bearing-user", messages: output.messages,
        })
        return
      }
      const observedAgent = currentUser?.info?.agent ?? null
      const observedSessionID = sessionIDFromMessage(currentUser) ?? sessionIDFromMessage(output.messages[0])

      const failureContext = { phase: "state-read" }
      let result
      try {
        result = await serializeState(async () => {
          // Agent selection is evaluated for every Provider call. Session hierarchy is
          // intentionally irrelevant: both top-level and child Sessions are eligible,
          // while switching this Session to another Agent disables projection at once.
          if (observedAgent !== config.targetAgent) {
            return { skipped: true, reason: "non-target-agent" }
          }
          if (!observedSessionID || output.messages.some((message) => sessionIDFromMessage(message) !== observedSessionID)) {
            throw new Error("Target Messages Transform must contain exactly one identifiable Session")
          }
          const state = await readState(statePath, config)
          let session = state.sessions[observedSessionID]
          if (!session) {
            const issueSourceText = isRealUserMessage(currentUser) ? textFromMessage(currentUser) : ""
            if (issueSourceText === "") {
              return { skipped: true, reason: "target-agent-user-message-has-no-text" }
            }
            if (typeof currentUser.info?.id !== "string" || currentUser.info.id === "") {
              throw new Error("Target Agent activation Message has no stable Message ID")
            }
            session = createSession({
              sessionID: observedSessionID,
              issueSourceMessageID: currentUser.info.id,
              issueSourceText,
              workspaceRoot: directory,
            })
            state.sessions[observedSessionID] = session
          }

          Object.assign(failureContext, {
            currentStageID: session.currentStageID, currentStageRunID: session.currentStageRunID,
            registryPath: session.workflowReferences.registryPath, phase: "boundary-resolution",
          })
          reconcileCompactions(session, output.messages)
          if (!resolveStageBoundary(output.messages, session) || !observeStageHandoff(config, session, output.messages)) {
            const history = await readNativeMessages(client, directory, observedSessionID)
            reconcileCompactions(session, history)
            if (!resolveStageBoundary(history, session)) throw new Error("Cannot resolve Stage Tool boundary from the native Session")
            if (!observeStageHandoff(config, session, history)) throw new Error("Cannot observe completed Stage handoff in the native Session")
          }
          failureContext.phase = "context-projection"
          const buildingProfile = session.currentStageID !== null && session.contextProfile === null
          const projection = await compileProjection({
            config,
            session,
            messages: output.messages,
            directory,
          })
          // Only a newly built stage profile is audited. Do not clone, measure or
          // serialize the full history on ordinary same-stage Provider calls.
          if (buildingProfile) {
            failureContext.phase = "profile-audit"
            await appendEvent(auditPath, {
              type: "bugfix-adaptive-stage-context",
              scope: "stage-entry-context",
              callID: session.stageBoundary.enteredAfterToolCallID,
              observedSessionID,
              currentStageID: session.currentStageID,
              currentStageRunID: session.currentStageRunID,
              declarationType: session.stageSequence === 1 ? "initialization" : "transition",
              historyPruning: session.stageSequence > 1,
              contextProfile: projection.contextProfile,
              registrySource: { path: session.workflowReferences.registryPath, sha256: session.contextProfile.registrySha256 },
              tokenMetrics: projectionMetrics(output.messages, projection.messages),
            })
          }
          state.sessions[observedSessionID] = session
          failureContext.phase = "state-write"
          await writeState(statePath, state)
          return { skipped: false, projection, session }
        })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        await diagnostics.decision(diagnosticCall, {
          decision: "failed", reason: "projection-exception-rethrown", phase: failureContext.phase,
          messages: output.messages,
        })
        try {
          await appendEvent(auditPath, {
            type: "bugfix-adaptive-context-projection", decision: "failed",
            errorCode: "BUGFIX_ADAPTIVE_PROJECTION_FAILED",
            projectionID: diagnosticCall?.projectionID ?? null,
            observedAgent, observedSessionID, ...failureContext,
            error: { name: failure.name, message: failure.message },
            beforeCount: output.messages.length, providerMessagesUnchanged: true,
          })
        } catch (auditError) {
          failure.message += `; projection Audit write failed: ${auditError.message}`
        }
        throw failure
      }

      if (result.skipped) {
        await diagnostics.decision(diagnosticCall, {
          decision: "skipped", reason: result.reason, messages: output.messages,
        })
        return
      }

      output.messages.splice(0, output.messages.length, ...result.projection.messages)
      await diagnostics.decision(diagnosticCall, {
        decision: "projected", reason: "projection-applied", session: result.session,
        boundaryResolution: result.projection.boundaryResolution, messages: output.messages,
      })
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === config.stageControlTool) {
        if (typeof input.sessionID !== "string" || typeof input.callID !== "string") {
          throw new Error(`${config.stageControlTool} requires Session and Tool Call IDs`)
        }
        await serializeState(async () => {
          const state = await readState(statePath, config)
          const session = state.sessions[input.sessionID]
          if (!session) throw new Error(`${config.stageControlTool} cannot update an unknown Session`)
          const stageID = output.args?.stageID
          if (typeof stageID !== "string" || !config.stages.includes(stageID)) {
            throw new Error(
              `${config.stageControlTool} stageID must be one of: ${config.stages.join(", ")}`,
            )
          }
          const beforeStage = diagnostics.stageSnapshot(session)
          let declaration
          try {
            declaration = declareStage(session, {
              stageID,
              boundaryToolCallID: input.callID,
              handoff: output.args?.handoff,
              registryPath: output.args?.registryPath,
              workPlanPath: output.args?.workPlanPath,
              projectRoot: output.args?.projectRoot,
              issueNumber: output.args?.issueNumber,
            })
          } catch (error) {
            await diagnostics.stage({ ...input, stageID }, session, beforeStage, "rejected", error.code ?? "stage-declaration-rejected")
            if (error.code === "BUGFIX_HANDOFF_REQUIRED") {
              await appendEvent(auditPath, {
                type: "bugfix-adaptive-stage-declaration", decision: "rejected",
                errorCode: error.code, observedSessionID: input.sessionID, callID: input.callID,
                currentStageID: session.currentStageID, requestedStageID: stageID, historyPruning: false,
              })
            }
            throw error
          }
          state.sessions[input.sessionID] = session
          await writeState(statePath, state)
          await diagnostics.stage({ ...input, stageID }, session, beforeStage,
            declaration.changed ? "committed" : "idempotent")
        })
        return
      }
    },
  }
}
