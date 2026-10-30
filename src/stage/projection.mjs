import { currentStageTail } from "./messages.mjs"
import { contextCarrier, entryInputMessages } from "./carrier.mjs"
import { loadRegistryProfile } from "./registry-profile.mjs"
import { projectStageHandoff } from "./handoff.mjs"

// Ablation variant: deliberately no Observation code, memory, requests or receipts.
export async function compileProjection({ config, session, messages }) {
  if (config.observationPolicy.enabled !== false) {
    throw new Error("Stage-only experiment requires observationPolicy.enabled=false")
  }
  const window = currentStageTail(messages, session)
  if (session.currentStageID !== null && session.contextProfile === null) {
    session.contextProfile = await loadRegistryProfile(session.currentStageID, session.workflowReferences)
  }
  // Stage acknowledgments remain visible, just like completed business Tools.
  const tail = window.messages.map((original) => structuredClone(original))
    .filter((message) => (message.parts ?? []).length > 0)
  const handoff = projectStageHandoff(config, session, tail)
  const carrier = contextCarrier(config, session)
  const inputs = entryInputMessages(config, session, messages, window.messages)
  session.updatedAt = new Date().toISOString()
  return {
    messages: [carrier, ...inputs, ...handoff.messages, ...tail],
    // The complete logical entry profile includes handoff regardless of whether
    // its one Provider copy is in the entry Tool or a restored memory Message.
    contextProfile: {
      carrier,
      inputs,
      handoff: session.stageHandoff
        ? { ...handoff.audit, content: session.stageHandoff.content }
        : { mode: "none", content: null },
    },
    stageID: session.currentStageID,
    stageRunID: session.currentStageRunID,
    boundaryResolution: window.boundaryResolution,
    handoffProjection: handoff.audit,
    manifest: [],
    request: null,
    observationChanges: [],
    observationDiagnostics: [],
  }
}
