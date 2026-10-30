// Steps, labels and folds. Each assistant response is a step; its tool outputs are labeled
// [step N], or [step N.k] when it made several calls. A folded step, with its reasoning, text
// and calls, is replaced by a [context-manager] note. Steps are decided when a boundary moves,
// every K steps, and folded once that pays (./index, plan()). Taken from ReFold (arXiv
// 2610.07863, sections 3.2-3.3); archive/experiments/refold.ts has the version with its STALE lines.
// A file view that is out of date (stale()) can also be folded alone: only its output is replaced.

type Part = Record<string, any>
export type Msg = { info: Record<string, any>; parts: Part[] }

export const K = 3

export const estimate = (text: string) => Math.ceil(text.length / 4)

/** `result`: "ok", "exit N" for a command that failed, or "failed: <first line of the error>". */
export type Output = { label: string; part: number; tool: string; input: Record<string, any>; text: string; result: string }
/** `learned`: what the agent wrote it learned from the step's output, at step `learnedAt`, kept in its fold. */
export type Step = { index: number; msg: number; learned?: string; learnedAt?: number; outputs: Output[] }

/** "3, 4", "3-5", "1.1, 1.2" or "-" as step numbers. */
export function numbers(text: string) {
  const out: number[] = []
  for (const m of text.matchAll(/(\d+)(?:\.\d+)?(?:\s*-\s*(\d+)(?:\.\d+)?)?/g)) {
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    for (let i = from; i <= to && i - from < 100; i++) out.push(i)
  }
  return out
}

/** The steps in the order of the history, counted from 1. */
export function steps(msgs: Msg[]) {
  const all: Step[] = []
  msgs.forEach((msg, m) => {
    if (msg.info.role !== "assistant" || msg.info.summary) return
    const step: Step = { index: all.length + 1, msg: m, outputs: [] }
    const calls = msg.parts.flatMap((part, p) => (part.type === "tool" && ["completed", "error"].includes(part.state?.status) ? [p] : []))
    for (const p of calls) {
      const part = msg.parts[p]!
      const label = calls.length > 1 ? `${step.index}.${step.outputs.length + 1}` : `${step.index}`
      const text = String((part.state.status === "error" ? part.state.error : part.state.output) ?? "")
      const exit = part.state.metadata?.exit
      const result = part.state.status === "error" ? `failed: ${short(text.trim().split("\n")[0] ?? "", 100)}` : typeof exit === "number" && exit !== 0 ? `exit ${exit}` : "ok"
      step.outputs.push({ label, part: p, tool: String(part.tool), input: part.state.input ?? {}, text, result })
    }
    all.push(step)
  })
  return all
}

/** A step is decided, folded or kept for good, once it is this many steps old: by then the agent has let go of most of what it keeps. */
export const DELAY = 9
/** Steps up to here are old enough to be decided; it moves every K steps, so the request prefix stays the same in between. */
export const boundary = (t: number) => Math.max(0, K * Math.floor((t - DELAY) / K))

function short(text: string, n: number) {
  return text.length > n ? `${text.slice(0, n)}...` : text
}
const SIGNATURE = /^\s*(?:export\s+|pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:def|class|function|interface|struct|enum|trait|impl|fn|func)\b/
const SEARCH = /^\s*(?:grep|rg|find|ls|git\s+grep)\b/
const VIEW = /^\s*(?:sed\s+-n|cat|head|tail|nl)\b/
// OpenCode 1.2's read puts the first line right after a <content> tag.
const NUMBERED = /^\s*(?:<content>)?(\d+)(?::\s|\t|:)(.*)$/

/** What a step did: its calls. */
export const did = (s: Step) => s.outputs.map((o) => `${o.tool} ${short(String(Object.values(o.input).find((v) => typeof v === "string") ?? ""), 60)}`).join(", ")

/** The lines of a file view with their numbers: as the output numbers them, or from a plain `sed -n A,Bp`, `cat` or `head` (one command, not several). */
function numbered(out: Output) {
  const lines = out.text.split("\n")
  const own = lines.flatMap((l) => {
    const m = NUMBERED.exec(l)
    return m ? [{ n: Number(m[1]), text: m[2]! }] : []
  })
  if (own.length >= lines.filter((l) => l.trim()).length / 2) return own
  const command = String(out.input.command ?? "")
  if (out.tool !== "bash" || /[|;&\n]/.test(command.trim())) return []
  const from = /^\s*sed\s+-n\s+['"]?(\d+),\d+p/.exec(command)?.[1] ?? (/^\s*(?:cat|head)\s/.test(command) ? "1" : undefined)
  return from === undefined ? [] : lines.map((text, i) => ({ n: Number(from) + i, text }))
}

/** A call as a tool and its file, command or pattern. */
function what(out: Output) {
  const command = String(out.input.command ?? "")
  const target = out.tool === "bash" ? short(command.trim().split("\n")[0] ?? "", 80)
    : out.input.filePath ?? (out.input.pattern !== undefined ? `${out.input.pattern}${out.input.path ? ` ${out.input.path}` : ""}` : short(String(Object.values(out.input).find((v) => typeof v === "string") ?? ""), 60))
  return `${out.tool} ${target}`
}

/** One call of a folded step: what it was, how it ended, and what of its output stays: a file view's range and signatures, a search's first hits. `brief`: only what it was and how it ended. */
function record(out: Output, brief = false) {
  const command = String(out.input.command ?? "")
  const head = what(out)
  if (brief || out.result !== "ok") return `${head} (${out.result})`
  if (out.tool === "read" || (out.tool === "bash" && VIEW.test(command))) {
    const lines = numbered(out)
    if (!lines.length) return `${head} (ok)`
    const sigs = lines.filter((l) => SIGNATURE.test(l.text)).slice(0, 20).map((l) => short(`${l.n}: ${l.text.trim()}`, 100))
    return `${head} lines ${lines[0]!.n}-${lines.at(-1)!.n} (ok)${sigs.length ? `: ${sigs.join(" | ")}` : ""}`
  }
  if (["grep", "glob"].includes(out.tool) || (out.tool === "bash" && SEARCH.test(command)))
    return `${head} (ok) -> ${out.text.split("\n").filter((l) => l.trim()).slice(0, 5).map((l) => short(l, 100)).join(" | ")}`
  return `${head} (ok)`
}

// The file of a plain `sed -n 'A,Bp' f`, `cat f` or `head [-n N] f`.
const VIEWED = /^\s*(?:sed\s+-n\s+['"]?\d+,\d+p['"]?|cat|head(?:\s+-n\s*\d+|\s+-\d+)?)\s+(\S+)\s*$/

type Touched = { file: string; lines?: [number, number] } | undefined
// plan() asks about the same outputs at every request.
const looked = new WeakMap<Output, Touched>()

/** The file a call showed, with the first and last line it showed, or the file it changed (no lines). */
export function touched(out: Output): Touched {
  if (!looked.has(out)) looked.set(out, look(out))
  return looked.get(out)
}

function look(out: Output): Touched {
  if (out.result !== "ok") return
  if (["edit", "write", "multiedit"].includes(out.tool) && out.input.filePath) return { file: String(out.input.filePath) }
  const command = String(out.input.command ?? "")
  const named = out.tool === "read" ? out.input.filePath : out.tool === "bash" && !/[|;&\n]/.test(command.trim()) ? VIEWED.exec(command)?.[1] : undefined
  const lines = named ? numbered(out) : []
  if (!named || !lines.length) return
  const file = String(named).replace(/^['"]|['"]$/g, "").replace(/^\.\//, "")
  const dir = out.tool === "bash" && out.input.workdir && !file.startsWith("/") ? `${String(out.input.workdir).replace(/\/$/, "")}/` : ""
  return { file: dir + file, lines: [lines[0]!.n, lines.at(-1)!.n] }
}

// The same file, given whole or relative to an unknown directory.
const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)

/**
 * Why a file view of step `s` is out of date by step `upTo`: a later step showed all its lines again ("again"),
 * or changed the file ("edited"); undefined while it is not.
 */
export function stale(all: Step[], s: Step, out: Output, upTo: number): "again" | "edited" | undefined {
  const seen = touched(out)
  if (!seen?.lines) return
  let why: "edited" | undefined
  for (const later of all.slice(s.index, upTo))
    for (const o of later.outputs) {
      const t = touched(o)
      if (!t || !same(t.file, seen.file)) continue
      if (!t.lines) why = "edited"
      else if (t.lines[0] <= seen.lines[0] && t.lines[1] >= seen.lines[1]) return "again"
    }
  return why
}

/** What stands in for an out-of-date file view. */
export function staleNote(out: Output, why: "again" | "edited") {
  const lines = touched(out)?.lines
  return `[context-manager] output folded: ${what(out)}${lines ? ` lines ${lines[0]}-${lines[1]}` : ""}; ${why === "again" ? "these lines were shown again later." : "the file was changed later; read it again if you need it."}`
}

/** The lines of a step's outputs that its NOTE points to, by line number or by a name in code style, with the line after each. */
function pointed(s: Step) {
  if (!s.learned) return []
  const at = new Set<number>()
  for (const m of s.learned.matchAll(/\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?|\.\w+:(\d+)\b/gi)) {
    const from = Number(m[1] ?? m[3])
    for (let n = from; n <= Number(m[2] ?? from) && n - from < 10; n++) at.add(n)
  }
  // A dotted name such as app.rs or Foo.bar counts whole and by its parts; each is matched as a whole word.
  const names = [...new Set([...s.learned.matchAll(/`([^`]+)`|\b\w+(?:\.\w+)+\b|\b\w*_\w+\b|\b[A-Za-z]+[a-z][A-Z]\w*\b/g)]
    .flatMap((m) => {
      const name = (m[1] ?? m[0]).trim()
      return [...(/^[\w.]+$/.test(name) ? [name] : []), ...name.split(/[^\w]+/)]
    })
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w)))]
    .map((w) => new RegExp(`(?<!\\w)${w.replace(/\./g, "\\.")}(?!\\w)`))
  const out: string[] = []
  for (const o of s.outputs) {
    const lines = numbered(o)
    const all = lines.length ? lines.map((l) => ({ n: l.n as number | undefined, text: l.text })) : o.text.split("\n").map((text) => ({ n: undefined as number | undefined, text }))
    // A name on many lines picks nothing out.
    const rare = names.filter((w) => all.filter((l) => w.test(l.text)).length <= 5)
    all.forEach((l, i) => {
      if (!(l.n !== undefined && at.has(l.n)) && !rare.some((w) => w.test(l.text))) return
      for (const k of [l, all[i + 1]]) {
        const line = k && k.text.trim() && short(`${k.n !== undefined ? `${k.n}: ` : ""}${k.text.trim()}`, 160)
        if (line && !out.includes(line)) out.push(line)
      }
    })
  }
  return out.slice(0, 10)
}

/** The note that stands for a run of folded steps: what each call was and how it ended, the agent's NOTE and the lines it points to. `brief`: only what each call was and how it ended. */
export function note(run: Step[], brief = false) {
  const range = run.length > 1 ? `${run[0]!.index}-${run.at(-1)!.index}` : `${run[0]!.index}`
  const noted = new Set<string>()
  const lines = run.flatMap((s) => {
    // What the agent thought then, which later turns may have overturned.
    const own = s.learned && !noted.has(s.learned) ? (noted.add(s.learned), [`  At turn ${s.learnedAt ?? s.index + 1} you thought: ${s.learned}`]) : []
    const marked = pointed(s)
    return [...s.outputs.map((o) => `turn ${o.label} ${record(o, brief)}`), ...own, ...(marked.length ? [`  ${marked.join(" | ")}`] : [])]
  })
  return [`[context-manager] turn${run.length > 1 ? "s" : ""} ${range} folded:`, ...lines].join("\n")
}

/** Tokens of a message as it was stored. */
export const size = (msg: Msg) =>
  estimate(msg.parts.map((p) => (p.type === "tool" ? JSON.stringify(p.state?.input ?? {}) + String(p.state?.output ?? p.state?.error ?? "") : String(p.text ?? ""))).join(""))

/**
 * Labels the outputs, folds the out-of-date ones in `gone` (by label) and the steps in `folded`, in place.
 * Does not touch the messages it was given, only replaces them. `batch` tells when each step was folded: only steps
 * folded together share a note. `labels`: false leaves the outputs unlabeled; `brief` gives the notes only what each call was.
 */
export function show(msgs: Msg[], all: Step[], folded: Set<number>, from = 0, batch = new Map<number, number>(), gone = new Map<string, "again" | "edited">(), labels = true, brief = false) {
  const set = (m: number, p: number, part: Part) => (msgs[m] = { ...msgs[m]!, parts: msgs[m]!.parts.with(p, part) })
  const fold = all.filter((s) => folded.has(s.index))
  // Outputs up to step `from` were sent without labels, and stay so.
  for (const s of all)
    for (const out of s.outputs) {
      const why = gone.get(out.label)
      const label = labels && s.index > from
      if (!why && !label) continue
      const part = msgs[s.msg]!.parts[out.part]!
      const key = part.state.status === "error" ? "error" : "output"
      const text = why ? staleNote(out, why) : out.text
      set(s.msg, out.part, { ...part, state: { ...part.state, [key]: label ? `[turn ${out.label}]\n${text}` : text } })
    }
  // Steps folded one after another, with nothing in between, share one note if they were folded together. A step
  // folded later gets a note of its own, so a note once sent never changes and the request prefix up to it stays cached.
  const runs: Step[][] = []
  for (const s of fold) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    if (run && last!.index === s.index - 1 && last!.msg === s.msg - 1 && batch.get(last!.index) === batch.get(s.index)) run.push(s)
    else runs.push([s])
  }
  for (const run of runs.reverse()) {
    const first = msgs[run[0]!.msg]!
    const replacement: Msg = { info: { id: first.info.id, role: "user", sessionID: first.info.sessionID }, parts: [{ type: "text", text: note(run, brief) }] }
    msgs.splice(run[0]!.msg, run.length, replacement)
  }
}
