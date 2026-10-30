import { describe, expect, test } from "bun:test"
import { type Msg, boundary, numbers, show, steps, touched } from "../src/steps"

const user = (text: string): Msg => ({ info: { id: "u", role: "user", sessionID: "s" }, parts: [{ type: "text", text }] })
const step = (id: string, ...calls: [string, Record<string, any>, string][]): Msg => ({
  info: { id, role: "assistant", sessionID: "s" },
  parts: [{ type: "reasoning", text: "thinking" }, ...calls.map(([tool, input, output]) => ({ type: "tool", tool, state: { status: "completed", input, output } }))],
})
const read = (path: string, output: string): [string, Record<string, any>, string] => ["read", { filePath: path }, output]
const output = (m: Msg, i = 0) => m.parts.filter((p) => p.type === "tool")[i]!.state.output

describe("numbers", () => {
  test("lists, ranges, sub-steps and none", () => {
    expect(numbers("3, 4")).toEqual([3, 4])
    expect(numbers("3-5")).toEqual([3, 4, 5])
    expect(numbers("1.1, 1.2")).toEqual([1, 1])
    expect(numbers("-")).toEqual([])
  })
})

describe("boundary", () => {
  test("moves every 3 steps and leaves the last 9 to 11 undecided", () => {
    expect([9, 11, 12, 14, 15, 17, 18].map(boundary)).toEqual([0, 0, 3, 3, 6, 6, 9])
  })
})

describe("show", () => {
  const history = () => [
    user("task"),
    step("a1", ["glob", { pattern: "**/parser.py" }, "/repo/parser.py"]),
    step("a2", read("/repo/parser.py", "<path>/repo/parser.py</path>\n<type>file</type>\n<content>1: import re\n2: def parse(tokens):\n3:     return tokens[:-1]\n</content>")),
    step("a3", read("/repo/test.py", "1: def test(): pass")),
    step("a4", ["bash", { command: "pytest" }, "1 failed"], ["bash", { command: "ls" }, "a\nb"]),
  ]

  test("folds steps one after another into one note, with signatures, search hits and NOTEs", () => {
    const msgs = history()
    const all = steps(msgs)
    all[1]!.learned = "parse drops the last token."
    show(msgs, all, new Set([1, 2]))
    expect(msgs.map((m) => m.info.role)).toEqual(["user", "user", "assistant", "assistant"])
    expect(msgs[1]!.parts[0]!.text).toBe(
      '[context-manager] turns 1-2 folded:\n' +
        "turn 1 glob **/parser.py (ok) -> /repo/parser.py\n" +
        "turn 2 read /repo/parser.py lines 1-3 (ok): 2: def parse(tokens):\n" +
        "  At turn 3 you thought: parse drops the last token.",
    )
  })

  test("records how each call ended, the lines of a sed view, and the lines a NOTE points to", () => {
    const msgs: Msg[] = [
      user("task"),
      { info: { id: "a1", role: "assistant", sessionID: "s" }, parts: [{ type: "tool", tool: "edit", state: { status: "error", input: { filePath: "/repo/a.py" }, error: "Error: You must read file /repo/a.py before overwriting it.\nmore" } }] },
      step("a2", ["bash", { command: "sed -n '10,13p' /repo/b.py" }, "def f(x):\n    y = g(x)\n    return y\nclass C:"]),
      { info: { id: "a3", role: "assistant", sessionID: "s" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "cargo test" }, output: "test result: FAILED", metadata: { exit: 101 } } }] },
    ]
    const all = steps(msgs)
    all[1]!.learned = "`f` passes x to g at line 11; `helper_fn` is never used."
    show(msgs, all, new Set([1, 2, 3]))
    expect(msgs[1]!.parts[0]!.text).toBe(
      '[context-manager] turns 1-3 folded:\n' +
        "turn 1 edit /repo/a.py (failed: Error: You must read file /repo/a.py before overwriting it.)\n" +
        "turn 2 bash sed -n '10,13p' /repo/b.py lines 10-13 (ok): 10: def f(x): | 13: class C:\n" +
        "  At turn 3 you thought: `f` passes x to g at line 11; `helper_fn` is never used.\n" +
        "  11: y = g(x) | 12: return y\n" +
        "turn 3 bash cargo test (exit 101)",
    )
  })

  test("a plain sed view gives its file, under the workdir, and its lines; a pipe gives none", () => {
    const view = (command: string) => steps([user("task"), step("a1", ["bash", { command, workdir: "/repo" }, "def f(x):\n    y = g(x)\n    return y\nclass C:"])])[0]!.outputs[0]!
    expect(touched(view("sed -n '10,13p' src/b.py"))).toEqual({ file: "/repo/src/b.py", lines: [10, 13] })
    expect(touched(view("sed -n '10,13p' src/b.py | cat"))).toBeUndefined()
  })

  test("several commands in one call give no line numbers", () => {
    const msgs: Msg[] = [user("task"), step("a1", ["bash", { command: "sed -n '10,11p' /repo/a.rs; sed -n '40,41p' /repo/b.rs" }, "fn a() {\n}\nfn b() {\n}"])]
    show(msgs, steps(msgs), new Set([1]))
    expect(msgs[1]!.parts[0]!.text).toBe("[context-manager] turn 1 folded:\nturn 1 bash sed -n '10,11p' /repo/a.rs; sed -n '40,41p' /repo/b.rs (ok)")
  })

  test("a NOTE picks out lines by whole names only", () => {
    const msgs: Msg[] = [user("task"), step("a1", ["edit", { filePath: "/repo/src/app.rs" }, "Edit applied successfully."]), step("a2", ["bash", { command: "grep -n flag src/*.rs" }, "src/app.rs:94: .arg(flag(\"x\"))\nsrc/args.rs:12: x"])]
    const all = steps(msgs)
    all[0]!.learned = "Flag added to app.rs; next wire it through args.rs."
    all[1]!.learned = "The flag is defined in app.rs."
    show(msgs, all, new Set([1, 2]))
    const text = msgs[1]!.parts[0]!.text
    expect(text).not.toContain("  Edit applied successfully.") // "app" is not "applied"
    expect(text).toContain("  src/app.rs:94: .arg(flag(\"x\"))")
  })

  test("labels the outputs in full, N.k when a step made several calls, and leaves the stored messages alone", () => {
    const stored = history()
    const msgs = [...stored]
    show(msgs, steps(msgs), new Set())
    expect(output(msgs[3]!)).toBe("[turn 3]\n1: def test(): pass")
    expect(output(msgs[4]!, 1)).toBe("[turn 4.2]\na\nb")
    expect(output(stored[3]!)).toBe("1: def test(): pass")
  })

  test("labels nothing up to step `from`", () => {
    const msgs = history()
    show(msgs, steps(msgs), new Set(), 2)
    expect(output(msgs[2]!)).toStartWith("<path>/repo/parser.py")
    expect(output(msgs[3]!)).toStartWith("[turn 3]\n")
  })
})
