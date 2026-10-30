import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { server } from "../src/index"
import { describeWireBody, fingerprint } from "../src/stage/cache-diagnostics.mjs"

type Msg = { info: Record<string, any>; parts: Record<string, any>[] }

const CONFIG = path.join(import.meta.dir, "../src/stage/default-config.json")
const STAGE = "bugfix-adaptive-stage"
const BODY = (tag: string) => Array.from({ length: 400 }, (_, i) => `${i + 1}:     x = ${i}  # ${tag}`).join("\n")

const user: Msg = { info: { id: "msg_00", role: "user", agent: "bug-fix-adaptive", sessionID: "s" }, parts: [{ type: "text", text: "Fix it" }] }
const call = (n: number, tool: string, input: Record<string, any>, output: string, text = ""): Msg => ({
  info: { id: `msg_${String(n).padStart(2, "0")}`, role: "assistant", sessionID: "s" },
  parts: [{ type: "text", text }, { type: "tool", tool, callID: `call_${n}`, state: { status: "completed", input, output } }],
})
const read = (n: number, file: string, output: string, text = "") => call(n, "read", { filePath: file }, output, text)

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

async function setup(options: Record<string, any>, history: () => Msg[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "cm-stage-"))
  dirs.push(directory)
  const client = { session: { messages: async () => ({ data: structuredClone(history()) }) } }
  const hooks: any = await server({ directory, client } as any, options)
  const transform = async (msgs: Msg[]) => {
    const output = { messages: structuredClone(msgs) }
    await hooks["experimental.chat.messages.transform"]({}, output)
    return output.messages as Msg[]
  }
  const declare = (n: number, args: Record<string, any>) => hooks["tool.execute.before"]({ tool: STAGE, sessionID: "s", callID: `call_${n}` }, { args })
  return { directory, hooks, transform, declare }
}

/** Stage A: three reads. Stage B, entered with `handoff`: a long read of c.py, short steps, and at its turn 12 a KEEP line. */
async function twoStages(handoff = "HANDOFF: c.py line 12") {
  const msgs: Msg[] = [user]
  const s = await setup({ stage: CONFIG, start: 0 }, () => msgs)
  await s.transform(msgs)
  await s.declare(1, { stageID: "project-understanding" })
  msgs.push(call(1, STAGE, { stageID: "project-understanding" }, "registered"))
  for (const n of [2, 3, 4]) msgs.push(read(n, "/repo/a.py", BODY("STAGE_A")))
  await s.declare(5, { stageID: "issue-analysis", handoff })
  msgs.push(call(5, STAGE, { stageID: "issue-analysis", handoff }, "registered"))
  msgs.push(read(6, "/repo/c.py", BODY("STAGE_B")))
  for (let n = 7; n <= 15; n++) msgs.push(read(n, `/repo/c${n}.py`, "ok"))
  msgs.push(read(16, "/repo/c16.py", "ok", "KEEP: -"))
  return { ...s, msgs }
}

describe("stage", () => {
  test("keeps only the current stage, numbered from 1, and folds within it", async () => {
    const { transform, msgs } = await twoStages()
    const out = await transform(msgs)
    const text = JSON.stringify(out)
    expect(out[0]!.parts[0]!.text).toStartWith("<bugfix-adaptive-context")
    expect(text).not.toContain("STAGE_A")
    expect(text).not.toContain("STAGE_B") // the long read of stage B is folded
    // The stage tool's step is never folded, and turn 3 is shorter than its note would be.
    expect(out[1]!.parts[0]!.state.output).toBe("[turn 1]\nregistered")
    expect(out[2]!.parts[0]!.text).toStartWith("[context-manager] turn 2 folded:\nturn 2 read /repo/c.py lines 1-400 (ok)")
    expect(text).toContain("[turn 4]\\nok")
    expect(out.at(-1)!.info.id).toBe("msg_zzzz_tail")
  })

  test("never folds the turn that entered the stage: it carries the handoff", async () => {
    const { transform, msgs } = await twoStages(BODY("HANDOFF"))
    const out = await transform(msgs)
    expect(out[1]!.parts[0]!.state.input.handoff).toBe(BODY("HANDOFF"))
    expect(out[2]!.parts[0]!.text).toStartWith("[context-manager] turn 2 folded")
  })

  test("after a compaction, the turns are numbered from 1", async () => {
    const { hooks, transform, msgs } = await twoStages()
    const control: Msg = { info: { id: "msg_20", role: "user", agent: "bug-fix-adaptive", sessionID: "s" }, parts: [{ type: "compaction" }] }
    const summary: Msg = { info: { id: "msg_21", role: "assistant", sessionID: "s", summary: true, finish: "stop", parentID: "msg_20" }, parts: [{ type: "text", text: "SUMMARY" }] }
    const resume: Msg = { info: { id: "msg_22", role: "user", agent: "bug-fix-adaptive", sessionID: "s" }, parts: [{ type: "text", text: "Continue", synthetic: true }] }
    msgs.push(control)
    const context = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({ sessionID: "s" }, context)
    expect(context.context[0]).toStartWith("<bugfix-adaptive-compaction")
    msgs.push(summary, resume, read(23, "/repo/d.py", "D_BODY"))
    // As OpenCode 1.2 sends it after the compaction: the compaction, its summary, then newer messages.
    const out = await transform([control, summary, resume, msgs.at(-1)!])
    const text = JSON.stringify(out)
    expect(out[0]!.parts[0]!.text).toStartWith("<bugfix-adaptive-context")
    expect(text).toContain("SUMMARY")
    expect(text).toContain("[turn 1]\\nD_BODY")
    expect(out.at(-1)!.info.id).toBe("msg_zzzz_tail")
  })

  test("registers the stage tool", async () => {
    const { hooks } = await twoStages()
    expect(Object.keys(hooks.tool)).toEqual([STAGE])
  })

  test("is on by default with the bundled config, and the log goes to .opencode/context-manage.jsonl", async () => {
    const { directory, hooks, transform } = await setup({}, () => [user])
    expect(Object.keys(hooks.tool)).toEqual([STAGE])
    await transform([user, read(1, "/repo/a.py", "ok")])
    expect(readFileSync(path.join(directory, ".opencode", "context-manage.jsonl"), "utf8")).toContain('"type":"request"')
    expect(readFileSync(path.join(directory, ".opencode", ".gitignore"), "utf8")).toContain("context-manage.jsonl")
  })

  test("forwards diagnostic hooks and fingerprints the final folded request, not the pre-fold view", async () => {
    const { directory, hooks, transform, msgs } = await twoStages()
    let sent: unknown
    const provider = { provider: { fixture: { options: { fetch: async (_url: unknown, init: any) => {
      sent = init
      return new Response("ok")
    } } } } }
    await hooks.config(provider)
    const out = await transform(msgs)
    const model = { providerID: "fixture", id: "fixture-model" }
    const system = { system: ["SYSTEM_SECRET"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s", model }, system)
    await hooks["chat.params"]({ sessionID: "s", model, agent: { name: "bug-fix-adaptive" }, message: user.info }, {})
    const body = {
      model: "fixture-model", messages: out.map(m => ({ role: m.info.role,
        content: m.parts.map(p => p.text ?? p.state?.output ?? "").join("\n") })),
      tools: [{ type: "function", function: { name: STAGE } }],
    }
    const init = { body: JSON.stringify(body) }
    await provider.provider.fixture.options.fetch("https://fixture.invalid/chat", init)
    expect(sent).toBe(init)
    const events = readFileSync(path.join(directory, ".opencode/bugfix-adaptive-cache.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    const wire = events.findLast(e => e.layer === "provider-fetch-input")
    expect(wire.messages.sha256).toBe(describeWireBody(body)!.messages.sha256)
    expect(wire.tools.count).toBe(1)
    expect(wire.runtimeAgent).toBe("bug-fix-adaptive")
    expect(wire.projectionDecision).toBe("projected")
    expect(wire.observedSessionID).toBe("s")
    expect(events.findLast(e => e.layer === "system-transform-hook").system.sha256).toBe(fingerprint(system.system).sha256)
    expect(events.findLast(e => e.type === "bugfix-adaptive-stage-decision").after.currentStageID).toBe("issue-analysis")
    expect(JSON.stringify(body)).not.toContain("STAGE_B")
    expect(JSON.stringify(events)).not.toContain("SYSTEM_SECRET")
  })
})

describe("without stage", () => {
  test("stage: false and log: false write no files and add no tool", async () => {
    const { directory, hooks, transform } = await setup({ stage: false, log: false, start: 0 }, () => [user])
    await transform([user, read(1, "/repo/a.py", "ok")])
    expect(readdirSync(directory)).toEqual([])
    expect(hooks.tool).toBeUndefined()
  })
})
