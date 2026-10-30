import { tool } from "@opencode-ai/plugin"

export default tool({
  description: [
    "Register the workflow-selected Context Stage before its work; await the result, then continue. No stage-end call is needed.",
    "First registration preserves startup history; changing stages prunes old history. Same-stage repeats are no-ops, including references and handoff.",
    "stageID is the step being entered, both for first registration and later transitions. Pass known Registry/Plan absolute paths and template variables; omissions carry forward. This Tool never completes or validates a business step.",
  ].join(" "),
  args: {
    stageID: tool.schema
      .string()
      .describe("Exact step ID declared by the active Adaptive Bug Fix prompt."),
    handoff: tool.schema.string().optional()
      .describe('Required on every real stage change: Markdown code handoff from the stage being left; use "" only when nothing is reusable. Omit on first/same-stage registration. Use existing context: exact paths/symbols/ranges, verified vs tentative findings and evidence references, constraints, open questions/reload conditions. Carry forward only useful upstream findings; no transcripts, long code or new exploration. Working memory, not workflow evidence.'),
    registryPath: tool.schema.string().optional()
      .describe("Already discovered Registry absolute path; preserve the exact Windows/POSIX path. Omit if unknown, do not rediscover merely to fill this field."),
    workPlanPath: tool.schema.string().optional()
      .describe("Resolved intended Work Plan absolute path, even before creation. Omit if unresolved; this is not a file existence/status claim."),
    projectRoot: tool.schema.string().optional()
      .describe("Resolved absolute {{project_root_dir}}; omit if unknown."),
    issueNumber: tool.schema.string().optional()
      .describe("Agent-resolved {{issue_number}} path-template value; no fixed issue-number pattern. Omit if unknown."),
  },
  async execute(args) {
    return JSON.stringify({
      accepted: true,
      stageID: args.stageID,
      stageDeclarationStatus: "registered",
      currentStageDeclarationRequired: false,
      message: `Stage ${args.stageID} registration is complete. Do not redeclare or reconfirm it; continue its business work. Declare again only when entering a different step.`,
    })
  },
})
