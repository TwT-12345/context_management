import { describe, expect, test } from "bun:test"
import { RESUME, TAIL, render, server } from "../src/index"

type Msg = { info: Record<string, any>; parts: Record<string, any>[] }

const user = (text: string): Msg => ({ info: { id: "u", role: "user", sessionID: "s" }, parts: [{ type: "text", text }] })
const step = (id: string, text: string, output = "ok"): Msg => ({
  info: { id, role: "assistant", sessionID: "s" },
  parts: [{ type: "text", text }, { type: "tool", tool: "read", state: { status: "completed", input: { filePath: `/repo/${id}.py` }, output } }],
})
// A long file, much longer than its note.
const BODY = Array.from({ length: 400 }, (_, i) => `${i + 1}:     x = ${i}  # filler`).join("\n")
const id = (n: number) => `a${String(n).padStart(2, "0")}`
/** `n` steps (12: the first boundary move that decides anything, steps 1 to 3); step 1 reads a long file. `texts` and `outputs` by step. */
const history = (texts: Record<number, string> = {}, n = 12, outputs: Record<number, string> = { 1: BODY }) =>
  [user("task"), ...Array.from({ length: n }, (_, i) => step(id(i + 1), texts[i + 1] ?? "", outputs[i + 1] ?? "ok"))]
const ids = (msgs: Msg[]) => msgs.map((m) => m.info.id)
const fold = (msgs: Msg[]) => msgs.find((m) => m.info.role === "user" && String(m.parts[0]?.text).startsWith("[context-manager] turn"))?.parts[0]?.text as string

describe("keep: step", () => {
  test("decides a step once it is 9 steps old: folds it unless the KEEP line then names it", () => {
    expect(render(history({ 11: "KEEP: -" }, 11), {}).folded).toEqual([]) // nothing is old enough yet
    const msgs = history({ 12: "KEEP: -" })
    const r = render(msgs, {})
    expect(r.folded).toEqual([1]) // steps 2 and 3 are shorter than their notes would be
    expect(ids(msgs).slice(0, 4)).toEqual(["u", "a01", "a02", "a03"])
    expect(msgs[1]!.parts[0]!.text).toStartWith("[context-manager] turn 1 folded:")
    expect(msgs.at(-1)!.parts[0]!.text).toBe(TAIL)
  })

  test("without a KEEP line at the boundary move nothing is decided, and the next request asks again", () => {
    const r = render(history({ 11: "KEEP: -" }), {})
    expect(r.folded).toEqual([])
    expect(r.check).toMatchObject({ step: 12, waiting: true })
    expect(r.asked).toEqual([1])
    expect(render(history({ 13: "KEEP: -" }, 13), {}).folded).toEqual([1])
  })

  test("a KEEP line that names no turn counts as none", () => {
    const r = render(history({ 12: "KEEP: The full outputs were saved to files" }), {})
    expect(r.check).toMatchObject({ step: 12, waiting: true })
  })

  test("a small step kept stays; a large one is asked about again, and let go when no longer named", () => {
    const short = BODY.split("\n").slice(0, 60).join("\n")
    expect(render(history({ 12: "KEEP: 1", 15: "KEEP: -" }, 15, { 1: short }), {}, 0, new Set(), 1).folded).toEqual([])
    expect(render(history({ 12: "KEEP: 1" }, 14, { 1: short }), {}).asked).toBeUndefined()
    expect(render(history({ 12: "KEEP: 1" }, 14), {}).asked).toEqual([1])
    const msgs = history({ 12: "KEEP: 1", 15: "KEEP: -" }, 15)
    expect(render(msgs, {}, 0, new Set(), 1).folded).toEqual([1])
  })
})

describe("asking", () => {
  test("the request at a boundary move lists the steps to decide; the others only ask for the NOTE line", () => {
    const at = history({}, 11)
    expect(render(at, {}).asked).toEqual([1])
    expect(at.at(-1)!.parts[0]!.text).toStartWith("[context-manager] These turns are about to be let go: 1 read /repo/a01.py")
    const before = history({}, 10)
    expect(render(before, {}).asked).toBeUndefined()
    expect(before.at(-1)!.parts[0]!.text).toBe(TAIL)
  })

  test("a step let go but not folded yet is taken back when a KEEP line names it", () => {
    // A short read let go at step 12, while a long one after it is kept: the fold waits for its rent.
    const short = BODY.split("\n").slice(0, 60).join("\n")
    const texts = (back: boolean): Record<number, string> => ({ ...Object.fromEntries(Array.from({ length: 99 }, (_, i) => [i + 3, "KEEP: 2"])), ...(back ? { 15: "KEEP: 1, 2" } : ({} as Record<number, string>)) })
    // Without it, the rent has paid for the fold by step 101.
    expect(render(history(texts(false), 101, { 1: short, 2: BODY }), {}).folded).toEqual([1])
    expect(render(history(texts(true), 101, { 1: short, 2: BODY }), {}).folded).toEqual([])
  })
})

describe("a kept step early on", () => {
  test("does not stop the steps after it from being folded", () => {
    // Step 2 is long and kept; step 3 is folded, and only what comes after it is sent again.
    expect(render(history({ 12: "KEEP: 2" }, 12, { 2: BODY, 3: BODY }), {}).folded).toEqual([3])
  })
})

describe("modules", () => {
  const view = (id: string, tool: string, filePath: string, output: string): Msg => ({
    info: { id, role: "assistant", sessionID: "s" },
    parts: [{ type: "tool", tool, state: { status: "completed", input: { filePath }, output } }],
  })

  test("turns off: no turn is let go, nothing is asked, outputs are not labeled", () => {
    const msgs = history({ 12: "KEEP: -" })
    const r = render(msgs, { turns: "off" })
    expect(r.folded).toEqual([])
    expect(r.asked).toBeUndefined()
    expect(msgs[2]!.parts[1]!.state.output).toBe("ok")
    expect(msgs.at(-1)!.parts[0]!.text).toBe(TAIL) // NOTE is still asked for
  })

  test("turns recent: a step is let go once it is old enough, without asking", () => {
    expect(render(history({}, 11), { turns: "recent" }).folded).toEqual([])
    const msgs = history({}, 12)
    const r = render(msgs, { turns: "recent" })
    expect(r.folded).toEqual([1])
    expect(r.asked).toBeUndefined()
    expect(msgs.at(-1)!.parts[0]!.text).toBe(TAIL)
  })

  test("turns recent, summary rule: the messages are not changed before something is folded", () => {
    const msgs = history({}, 11)
    render(msgs, { turns: "recent", summary: "rule" })
    expect(msgs).toEqual(history({}, 11))
  })

  test("summary rule: no NOTE is asked for or kept; placeholder: only what each call was", () => {
    const at = history({}, 11)
    render(at, { summary: "rule" })
    expect(at.at(-1)!.parts[0]!.text).toStartWith("[context-manager] These turns are about to be let go: 1 read /repo/a01.py")
    expect(at.at(-1)!.parts[0]!.text).not.toContain("NOTE")
    const msgs = history({ 2: "NOTE: a1.py defines x.", 12: "KEEP: -" })
    render(msgs, { summary: "rule" })
    expect(fold(msgs)).toContain("turn 1 read /repo/a01.py lines 1-400 (ok)")
    expect(fold(msgs)).not.toContain("you thought")
    const brief = history({ 12: "KEEP: -" })
    render(brief, { summary: "placeholder" })
    expect(fold(brief)).toBe("[context-manager] turn 1 folded:\nturn 1 read /repo/a01.py (ok)")
  })

  test("timing now: what is let go is folded at once", () => {
    // A short read, then a long one kept at every turn after: folding the first sends the second again.
    const short = BODY.split("\n").slice(0, 60).join("\n")
    const msgs = () => history(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 3, "KEEP: 2"])), 12, { 1: short, 2: BODY })
    expect(render(msgs(), {}).folded).toEqual([])
    expect(render(msgs(), { timing: "now" }).folded).toEqual([1])
  })

  test("stale: a view whose lines are shown again is folded alone, whatever its age", () => {
    const msgs = [user("task"), view("a01", "read", "/repo/x.py", BODY), view("a02", "read", "/repo/x.py", BODY)]
    // With "rent" it would wait: folding it sends the second view again.
    expect(render(structuredClone(msgs), { stale: true }).outputs).toBeUndefined()
    const r = render(msgs, { stale: true, timing: "now" })
    expect(r.outputs).toEqual(["1"])
    expect(msgs[1]!.parts[0]!.state.output).toBe("[turn 1]\n[context-manager] output folded: read /repo/x.py lines 1-400; these lines were shown again later.")
    expect(msgs[2]!.parts[0]!.state.output).toBe(`[turn 2]\n${BODY}`)
  })

  test("stale: a view of a file changed later is folded once the boundary passes it, unless turns is ask", () => {
    const msgs = (n: number) => [user("task"), step("a01", "", BODY), view("a02", "edit", "/repo/a01.py", "Edit applied successfully."), ...history({}, n - 2, {}).slice(1)]
    expect(render(msgs(11), { turns: "off", stale: true }).outputs).toBeUndefined()
    const at = msgs(12)
    expect(render(at, { turns: "off", stale: true }).outputs).toEqual(["1"])
    expect(at[1]!.parts[1]!.state.output).toBe("[context-manager] output folded: read /repo/a01.py lines 1-400; the file was changed later; read it again if you need it.")
    expect(render(msgs(12), { stale: true }).outputs).toBeUndefined()
  })
})

describe("keep: start", () => {
  // Each step with BODY is about 3000 tokens.
  const long = (...texts: string[]) => [user("task"), ...texts.map((t, i) => step(id(i + 1), t, BODY))]

  test("changes nothing before the messages reach the start size", () => {
    const msgs = long("", "")
    const r = render(msgs, {}, 100000)
    expect(r.off).toBe(true)
    expect(ids(msgs)).toEqual(["u", "a01", "a02"])
    expect(msgs[1]!.parts[1]!.state.output).toBe(BODY)
  })

  test("from the step that reaches it: a message after it, labels only later, the tail", () => {
    const msgs = long("", "", "", "")
    const r = render(msgs, {}, 5000)
    expect(r.from).toBe(2)
    expect(ids(msgs)).toEqual(["u", "a01", "a02", "msg_zzzz_open", "a03", "a04", "msg_zzzz_tail"])
    expect(msgs[3]!.parts[0]!.text).toStartWith("[context-manager] Context management:")
    expect(msgs[3]!.parts[0]!.text).toEndWith("The turns so far, whose outputs are not labeled: 1 read /repo/a01.py · 2 read /repo/a02.py.")
    expect(msgs[2]!.parts[1]!.state.output).toBe(BODY)
    expect(msgs[4]!.parts[1]!.state.output).toStartWith("[turn 3]\n")
  })

  // Two long reads, then short steps.
  const reads = (texts: Record<number, string> = {}) => history(texts, 12, { 1: BODY, 2: BODY })

  test("folds only after it starts, with the same consent", () => {
    expect(render(reads(), {}, 5000).folded).toEqual([])
    expect(render(reads({ 12: "KEEP: -" }), {}, 5000).folded).toEqual([1, 2])
  })

  test("the first NOTE after it starts goes into the fold of the turns before it", () => {
    const msgs = reads({ 3: "KEEP: -\nNOTE: a1.py and a2.py only define x.", 12: "KEEP: -" })
    render(msgs, {}, 5000)
    expect(fold(msgs)).toStartWith("[context-manager] turns 1-2")
    expect(fold(msgs)).toContain("At turn 3 you thought: a1.py and a2.py only define x.")
  })

  test("asks nothing before it starts", () => {
    expect(render(reads(), {}, 100000).asked).toBeUndefined()
    expect(render(reads(), {}, 5000).asked).toEqual([1, 2])
  })
})

describe("notes", () => {
  test("a step folded later gets a note of its own, and the earlier note does not change", () => {
    // Six long reads; with cache reads at full price each boundary move folds what it lets go at once.
    const six = (n: number) => history({ 12: "KEEP: -", 15: "KEEP: -" }, n, Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, BODY])))
    const notes = (n: number) => {
      const msgs = six(n)
      render(msgs, {}, 0, new Set(), 1)
      return msgs.filter((m) => m.info.role === "user" && String(m.parts[0]?.text).startsWith("[context-manager] turn")).map((m) => m.parts[0]!.text)
    }
    const early = notes(12), late = notes(15)
    expect(early.map((t) => t.split("\n")[0])).toEqual(["[context-manager] turns 1-3 folded:"])
    expect(late.map((t) => t.split("\n")[0])).toEqual(["[context-manager] turns 1-3 folded:", "[context-manager] turns 4-6 folded:"])
    expect(late[0]).toBe(early[0])
  })
})

describe("rent, then buy", () => {
  // A short read, then a long one the agent keeps at every turn after: folding the first sends the second again.
  const short = BODY.split("\n").slice(0, 60).join("\n")
  const kept = (n: number) => history(Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => [i + 3, "KEEP: 2"])), n, { 1: short, 2: BODY })

  test("with cache reads at full price folding costs nothing, so a step let go is folded at once", () => {
    expect(render(kept(12), {}, 0, new Set(), 1).folded).toEqual([1])
  })

  test("otherwise it is folded once the rent paid on it adds up to what folding sends again", () => {
    const at = (n: number) => render(kept(n), {})
    expect(at(12).folded).toEqual([])
    let n = 13
    while (!at(n).folded?.length) n++
    const before = at(n - 1).check!, now = at(n).check!
    expect(before.rent!).toBeLessThan(0.9 * before.reread)
    expect(now.rent!).toBeGreaterThanOrEqual(0.9 * now.reread)
    expect(at(n).folded).toEqual([1])
  })

  test("groups let go at different boundary moves are folded together, at one request", () => {
    // Short reads at steps 1 to 6, let go at steps 12 and 15; a long one at step 7, always kept.
    const texts = Object.fromEntries(Array.from({ length: 98 }, (_, i) => [i + 3, "KEEP: 7"]))
    const outputs = { ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, short])), 7: BODY }
    let n = 15
    while (!render(history(texts, n, outputs), {}).folded?.length) n++
    const r = render(history(texts, n, outputs), {})
    expect(r.folded).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe("keep: NOTE", () => {
  test("step: a folded step keeps the NOTE written right after it", () => {
    const msgs = history({ 2: "KEEP: -\nNOTE: a1.py defines x at line 12.", 12: "KEEP: -\nNOTE: -" })
    expect(render(msgs, {}).folded).toEqual([1, 2]) // step 2's text makes it longer than its note
    const text = fold(msgs)
    expect(text).toContain("At turn 2 you thought: a1.py defines x at line 12.")
    expect(text.match(/you thought/g)).toHaveLength(1) // "-" is no note
  })

  test("step: without NOTE lines the fold is the rule's alone", () => {
    const msgs = history({ 12: "KEEP: -" })
    render(msgs, {})
    expect(fold(msgs)).not.toContain("you thought")
  })

  test("the question and the tail ask for the NOTE line", () => {
    const msgs = history({}, 11)
    render(msgs, {})
    expect(msgs.at(-1)!.parts[0]!.text).toContain("NOTE")
    expect(TAIL).toContain("NOTE")
  })
})

describe("after a compaction", () => {
  // As OpenCode sends it: the compaction, its summary, then the newer turns.
  const view = (n: number, last = ""): Msg[] => [
    { info: { id: "b1", role: "user", sessionID: "s" }, parts: [{ type: "compaction" }] },
    { info: { id: "b2", role: "assistant", sessionID: "s", summary: true, finish: "stop", parentID: "b1" }, parts: [{ type: "text", text: "summary" }] },
    user("Continue"),
    ...history({ [n]: last }, n).slice(1),
  ]

  test("numbers the turns from 1 and folds once they are old enough and a KEEP line allows it", () => {
    expect(render(view(12, "KEEP: -"), {}).folded).toEqual([1])
    expect(render(view(11, "KEEP: -"), {}).folded).toEqual([])
    const shown = view(2)
    render(shown, {})
    expect(shown[3]!.parts[1]!.state.output).toStartWith("[turn 1]\n")
  })
})

describe("a response with only the labels", () => {
  const task: Msg = { info: { id: "u", role: "user", sessionID: "s", agent: "bug-fix-adaptive", model: { providerID: "p", modelID: "m" } }, parts: [{ type: "text", text: "task" }] }
  const reply = (text: string, info = {}): Msg => ({ info: { id: "r", role: "assistant", sessionID: "s", ...info }, parts: [{ type: "text", text }] })
  /** What the plugin sends when the session stops with these messages. */
  async function stopped(msgs: Msg[], session: Record<string, any> = {}, options = {}) {
    const sent: any[] = []
    const client = { session: { get: async () => ({ data: { id: "s", ...session } }), messages: async () => ({ data: structuredClone(msgs) }), promptAsync: async (x: any) => void sent.push(x) } }
    const hooks: any = await server({ directory: "/tmp", client } as any, { stage: false, log: false, ...options })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    return sent
  }

  test("asks once more, with the same agent and model", async () => {
    const sent = await stopped([task, step("a01", ""), reply("KEEP: -\nNOTE: need to check foo next.")])
    expect(sent).toEqual([{ path: { id: "s" }, body: { agent: "bug-fix-adaptive", model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: RESUME }] } }])
  })

  test("not when the response says more, calls a tool, or answers the question already asked", async () => {
    expect(await stopped([task, reply("NOTE: all tests pass.\n\nDone. Changed foo.")])).toEqual([])
    expect(await stopped([task, step("a01", "NOTE: reading foo")])).toEqual([])
    expect(await stopped([task, reply("NOTE: x"), { ...task, parts: [{ type: "text", text: RESUME }] }, reply("NOTE: still x")])).toEqual([])
  })

  test("not after an error, in a subagent's session, or when the agent writes no labels", async () => {
    const msgs = [task, reply("NOTE: x")]
    expect(await stopped([task, reply("NOTE: x", { error: { name: "MessageAbortedError" } })])).toEqual([])
    expect(await stopped(msgs, { parentID: "parent" })).toEqual([])
    expect(await stopped(msgs, {}, { turns: "recent", summary: "rule" })).toEqual([])
    expect(await stopped(msgs)).toHaveLength(1)
  })
})
