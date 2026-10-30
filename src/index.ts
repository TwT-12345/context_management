// OpenCode plugin: folds old turns, and out-of-date file views, into short notes. Steps, labels, notes and the
// boundary are in ./steps. Nothing is refused, and nothing calls the model on its own. Each module is an option
// (docs/design.md, section 4); the defaults are the first values.
// Option `turns`, which old turns are let go. "ask": when a step is about 9 steps old (a boundary move, every 3
// steps) the request ends with a user message that lists the steps to decide, and the response begins with a KEEP
// line naming the ones still needed: the others are let go. Without a KEEP line nothing is decided, and the next
// request asks again. A step kept then is asked about again at later boundary moves if it is large; a small one
// stays; a KEEP line that names a step let go but not folded yet takes it back. "recent": every step is let go once
// it is that old, without asking. "off": no turn is let go.
// Option `stale` (false): a file view whose lines a later step shows again is let go at once, whatever the KEEP
// lines say; one whose file a later step changed is let go once it is that old, unless `turns` is "ask" (then the
// KEEP line decides). Only that output is folded, not the step.
// Option `summary`, what a folded turn becomes. "note": what the rules record of its calls (./steps) and the NOTE
// line of the response after it: every response then begins with a NOTE line, the agent's own observations and
// conclusions from the output just received. "rule": the record only, and no NOTE line is asked for. "placeholder":
// only what each call was and how it ended.
// Option `timing`, when what is let go is folded. "rent": once keeping it has cost as much as folding it would
// (see plan()). "now": at once.
// Labels, the explanation and the messages at the end are only there when the agent writes something: labels
// with "ask", the explanation and the messages with "ask" or "note". The user messages at the end are only in the
// request, never stored, so the request prefix stays the same.
// Option `start` (tokens, default 10000; 0 starts at once): nothing at all changes until the messages reach that size, so short tasks
// pay nothing. Then a message after that step says what context management is and, with "ask", lists the steps
// so far; only later outputs are labeled, and the system prompt and the task are never changed.
// Option `stage` (default ./stage/default-config.json, or the path of another stage config; false turns it
// off): the stage layer first keeps only the current stage of the agent it is for; steps are then numbered,
// kept and folded within that stage, and `start` counts from its beginning.
// Option `cache` (default 0.1): the price of an input token read from the provider's cache, as a share of one that is not.
// Option `log` (default .opencode/context-manage.jsonl in the project, or another path; false: no log).
// OpenCode 1.2 calls a plugin with its input only, so the options come from the entry file that loads this one.

import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { BugfixAdaptiveContext } from "./stage/plugin.mjs"
import { type Msg, type Output, type Step, boundary, did, estimate, note, numbers, show, size, stale, staleNote, steps } from "./steps"

/** One value per module; see the top of this file. */
export type Config = { turns: "ask" | "recent" | "off"; stale: boolean; summary: "note" | "rule" | "placeholder"; timing: "rent" | "now" }
export const DEFAULT: Config = { turns: "ask", stale: false, summary: "note", timing: "rent" }
/** Price of an input token read from cache, as a share of one that is not: 0.1 for most providers. */
export const CACHE = 0.1

const FOLDS = "Context management: the harness folds older turns into a `[context-manager]` note, which is NOT an error: it says which turns were folded and what they called."
const LABELS = " A turn is one of your responses with its tool calls, and each earlier tool output is labeled `[turn N]`; when earlier history is removed or summarized, the numbers start again from 1."

const WHICH = "the output you will still consult: the file you are changing, the test results you are working against, the read that pinned down the root cause"

/** What the agent is told: what the notes are, and the lines it writes (KEEP with "ask", NOTE with "note"); nothing when it writes none. */
export function prompt(config: Config) {
  const asks = config.turns === "ask"
  const notes = config.summary === "note"
  if (!asks && !notes) return ""
  const lines = [
    ...(notes ? ["Begin every response with this line:", "NOTE: <1-3 sentences: your own observations and conclusions from the output you just received, saying so when one is a guess, or `-`>"] : []),
    ...(asks ? [`When a \`[context-manager]\` message lists turns about to be let go, ${notes ? "put this line before it" : "begin your response with this line"}:`, "KEEP: <the listed turns whose output you still need for the rest of the task, such as `3, 7`, or `-` if none>"] : []),
    asks && notes ? `Write the labels KEEP and NOTE in English, as shown. The calls you made and what they returned are recorded for you; NOTE is only what you made of them. Turns you let go are folded later; a folded turn keeps the NOTE written right after it. Keep ${WHICH}.`
      : asks ? `Write the label KEEP in English, as shown. Turns you let go are folded later. Keep ${WHICH}.`
      : "Write the label NOTE in English, as shown. The calls you made and what they returned are recorded for you; NOTE is only what you made of them. A folded turn keeps the NOTE written right after it.",
  ]
  return `${FOLDS}${asks ? LABELS : ""}\n\n${lines.join("\n")}`
}

export const TAIL = "[context-manager] Begin this response with the NOTE line, then continue the task."

export const ask = (want: Step[], notes = true) =>
  `[context-manager] These turns are about to be let go: ${want.map((s) => `${s.index} ${did(s)}`).join(" · ")}. Begin this response with KEEP: <the ones you still need for the rest of the task, or ->${notes ? " and then the NOTE line" : ""}, then continue the task.`

const LINE = /^\s*KEEP:[ \t]*([^\n]*)/m
const NOTE = /^\s*NOTE:[ \t]*([^\n]*)/m

/** What follows a line's label in a response, from its text or else its reasoning; undefined without one. */
function said(msgs: Msg[], s: Step, line: RegExp) {
  const msg = msgs[s.msg]!
  for (const type of ["text", "reasoning"]) {
    const m = line.exec(msg.parts.filter((p) => p.type === type && !p.ignored && !p.synthetic).map((p) => p.text ?? "").join(""))
    if (m) return m[1]!.trim()
  }
}

/** The steps named in a response's KEEP line; undefined without one, or with one that names no turn and is not \`-\`. */
export function kept(msgs: Msg[], s: Step) {
  const line = said(msgs, s, LINE)
  if (line === undefined) return
  const named = numbers(line)
  if (named.length || /^`?-`?/.test(line)) return new Set(named)
}

/** A response's NOTE line; undefined without one, or with \`-\`. */
export function noted(msgs: Msg[], s: Step) {
  const line = said(msgs, s, NOTE)?.replace(/^`?-`?$/, "")
  return line || undefined
}

/** The first step at which the messages so far reach `start` tokens; undefined before that. */
export function opening(all: Step[], msgs: Msg[], start: number) {
  let total = 0
  let m = 0
  for (const s of all) {
    for (; m <= s.msg; m++) total += size(msgs[m]!)
    if (total >= start) return s.index
  }
}

/** The message put in after the step at which context management starts: what it is, and with "ask" the steps so far. */
export const open = (before: Step[], config: Config) =>
  `[context-manager] ${prompt(config)}${config.turns === "ask" ? `\nThe turns so far, whose outputs are not labeled: ${before.map((s) => `${s.index} ${did(s)}`).join(" · ")}.` : ""}`

/** A kept step larger than this (tokens) is asked about again at later boundary moves; a smaller one stays. */
export const BIG = 2000

/**
 * Goes through the steps in order, one request each, and works out which are folded, and which steps the next
 * request asks about. Nothing happens up to step `from`, where context management starts. Steps that call a tool in
 * `pinned` are never folded.
 *
 * At a boundary move the request lists the steps to decide: the ones the boundary has just passed, the large ones
 * kept before, and the ones let go but not folded yet. The response's KEEP line keeps some; the rest are let go.
 * Without a KEEP line nothing is decided and the next request asks again.
 *
 * Steps let go are folded when that pays, which depends on how many requests are left, and that is not known.
 * So they are rented before they are bought: keeping them costs `cache` × what folding them would free, on every
 * request; folding them costs (1 − `cache`) × everything from the first of them on, sent once more without the
 * cache. They are folded once the rent paid adds up to that. However long the task goes on, this costs at most
 * twice what folding at the best moment would (the ski rental problem). Each decision lets go a group of its own,
 * with its own rent. Folding a group sends again all that comes after it, so the groups after it are best folded
 * with it: the held groups from some group on are folded together once their rent adds up to what that sends
 * again. Small groups then pay for one fold between them, and the cache breaks once, not once per group.
 *
 * With `stale`, out-of-date file views are let go too, each output on its own, and go through the same rent.
 */
export function plan(all: Step[], msgs: Msg[], config: Config, from = 0, pinned = new Set<string>(), cache = CACHE) {
  const asks = config.turns === "ask"
  const brief = config.summary === "placeholder"
  const folded = new Set<number>()
  // The step at which each folded step was folded.
  const batch = new Map<number, number>()
  // Out-of-date outputs by label, and why; `gone` holds the folded ones.
  const why = new Map<string, "again" | "edited">()
  const gone = new Map<string, "again" | "edited">()
  const checks: { step: number; steps: number[]; outputs?: string[]; removed: number; reread: number; rent?: number; fold: boolean; waiting?: boolean }[] = []
  let decided = 0
  // Large steps kept so far, asked about again at each boundary move.
  let large: Step[] = []
  // What is let go but not folded yet, in groups of steps or of single outputs, with the rent paid on each since.
  type Group = { steps: Step[]; outs: { s: Step; o: Output }[]; rent: number }
  let held: Group[] = []
  const first = (g: Pick<Group, "steps" | "outs">) => Math.min(...g.steps.map((s) => s.index), ...g.outs.map((x) => x.s.index))
  // Tokens folding an out-of-date output frees.
  const saved = (o: Output) => estimate(o.text) - estimate(staleNote(o, why.get(o.label)!))
  // What folding `want` frees, and what it sends again: everything from its first step to step `c`.
  const measure = (want: Pick<Group, "steps" | "outs">, c: number) => {
    const cut = new Set(want.outs.map((x) => x.o.label))
    const removed = want.steps.reduce((sum, s) => sum + size(msgs[s.msg]!) - estimate(note([s], brief)), 0) + want.outs.reduce((sum, x) => sum + saved(x.o), 0)
    const shown = (s: Step) => folded.has(s.index) || want.steps.includes(s) ? estimate(note([s], brief))
      : size(msgs[s.msg]!) - s.outputs.reduce((sum, o) => sum + (gone.has(o.label) || cut.has(o.label) ? saved(o) : 0), 0)
    const reread = all.slice(first(want) - 1, c).reduce((sum, s) => sum + shown(s), 0)
    return { steps: want.steps.map((s) => s.index), ...(cut.size ? { outputs: [...cut] } : {}), removed, reread }
  }
  // The steps the request for step `c` asks about: the undecided ones the boundary has passed that folding would
  // make shorter, the large ones kept, and the held ones. None when the boundary has not moved.
  const question = (c: number) => {
    const b = boundary(c)
    if (b <= decided) return []
    const due = all.slice(decided, b).filter((s) => !s.outputs.some((o) => pinned.has(o.tool)) && size(msgs[s.msg]!) > estimate(note([s], brief)))
    return [...due, ...large, ...held.flatMap((g) => g.steps)].sort((x, y) => x.index - y.index)
  }
  for (let c = from + 1; c <= all.length; c++) {
    if (config.turns !== "off") {
      const asked = question(c)
      if (boundary(c) > decided && !asked.length) decided = boundary(c)
      if (asked.length) {
        // "recent" lets go all it would ask about.
        const line = asks ? kept(msgs, all[c - 1]!) : new Set<number>()
        if (!line) checks.push({ step: c, steps: asked.map((s) => s.index), removed: 0, reread: 0, fold: false, waiting: true })
        else {
          // The ones it names are kept (taken back, if held); the others are let go, as a group of their own. A step
          // let go whole needs none of its outputs folded on their own.
          const go = asked.filter((s) => !line.has(s.index) && !held.some((g) => g.steps.includes(s)))
          held = held.map((g) => ({ ...g, steps: g.steps.filter((s) => !line.has(s.index)), outs: g.outs.filter((x) => !go.includes(x.s)) })).filter((g) => g.steps.length || g.outs.length)
          large = asked.filter((s) => line.has(s.index) && size(msgs[s.msg]!) > BIG)
          if (go.length) held.push({ steps: go, outs: [], rent: 0 })
          decided = boundary(c)
        }
      }
    }
    if (config.stale) {
      // Out-of-date file views in steps not let go whole: one shown again at once, one whose file changed once the
      // boundary has passed it, and not with "ask", where the KEEP line decides.
      const outs: Group["outs"] = []
      for (const s of all.slice(0, c)) {
        if (folded.has(s.index) || held.some((g) => g.steps.includes(s)) || s.outputs.some((o) => pinned.has(o.tool))) continue
        for (const o of s.outputs) {
          const w = why.has(o.label) ? undefined : stale(all, s, o, c)
          if (!w || (w === "edited" && (asks || s.index > boundary(c)))) continue
          why.set(o.label, w)
          outs.push({ s, o })
        }
      }
      if (outs.length) held.push({ steps: [], outs, rent: 0 })
    }
    // Rent on every group. Then the held groups from some group on are folded together, if the rent they have paid
    // adds up to what that sends again; of those, the one that gains the most.
    for (const g of held) g.rent += cache * measure(g, c).removed
    held.sort((x, y) => first(x) - first(y))
    let best: { from: number; check: (typeof checks)[number]; gain: number } | undefined
    for (let k = 0; k < held.length; k++) {
      const tail = held.slice(k)
      const m = measure({ steps: tail.flatMap((g) => g.steps).sort((x, y) => x.index - y.index), outs: tail.flatMap((g) => g.outs) }, c)
      const rent = tail.reduce((sum, g) => sum + g.rent, 0)
      const gain = rent - (1 - cache) * m.reread
      if (!best || gain > best.gain) best = { from: k, gain, check: { step: c, ...m, rent: Math.round(rent), fold: gain >= 0 } }
    }
    if (best) {
      checks.push(best.check)
      if (best.check.fold) {
        for (const g of held.slice(best.from)) {
          for (const s of g.steps) {
            folded.add(s.index)
            batch.set(s.index, c)
          }
          for (const x of g.outs) gone.set(x.o.label, why.get(x.o.label)!)
        }
        held = held.slice(0, best.from)
      }
    }
  }
  return { folded, batch, gone, checks, asked: asks ? question(all.length + 1) : [] }
}

/**
 * Rewrites the messages as they are sent, in place. Does not touch the messages it was given, only replaces them.
 * With `start`, nothing changes until the messages reach that many tokens; from then on a message after
 * that step says what context management is, and only later outputs are labeled.
 */
export function render(msgs: Msg[], given: Partial<Config> = {}, start = 0, pinned = new Set<string>(), cache = CACHE) {
  const config = { ...DEFAULT, ...given }
  const asks = config.turns === "ask"
  const notes = config.summary === "note"
  let all = steps(msgs)
  const from = start ? opening(all, msgs, start) : 0
  if (from === undefined) return { steps: all.length, off: true }
  if (start && prompt(config)) {
    const text = open(all.slice(0, from), config)
    msgs.splice(all[from - 1]!.msg + 1, 0, { info: { id: "msg_zzzz_open", role: "user", sessionID: msgs[0]!.info.sessionID }, parts: [{ type: "text", text }] })
    all = steps(msgs)
  }
  // The NOTE of a response is about the output it had just received: the step before.
  if (notes)
    for (const s of all.slice(Math.max(1, from))) {
      all[s.index - 2]!.learned = noted(msgs, s)
      all[s.index - 2]!.learnedAt = s.index
    }
  // After a compaction OpenCode sends only its summary and what came after, so the steps are numbered from 1.
  const p = plan(all, msgs, config, from, pinned, config.timing === "now" ? 1 : cache)
  // Before folding: it moves the messages.
  const last = asks && all.at(-1) ? kept(msgs, all.at(-1)!) : undefined
  const lastNote = notes && !!(all.at(-1) && noted(msgs, all.at(-1)!))
  show(msgs, all, p.folded, from, p.batch, p.gone, asks, config.summary === "placeholder")
  const tail = asks && p.asked.length ? ask(p.asked, notes) : notes ? TAIL : undefined
  if (tail && msgs.at(-1)?.info.role === "assistant")
    msgs.push({ info: { id: "msg_zzzz_tail", role: "user", sessionID: msgs.at(-1)!.info.sessionID }, parts: [{ type: "text", text: tail }] })
  return {
    steps: all.length,
    from,
    folded: [...p.folded],
    outputs: p.gone.size ? [...p.gone.keys()] : undefined,
    check: p.checks.findLast((c) => c.step === all.length),
    asked: p.asked.length ? p.asked.map((s) => s.index) : undefined,
    keep: last && [...last],
    note: lastNote,
  }
}

export type Options = Partial<Config> & { start?: number; cache?: number; log?: string | false; stage?: string | false }

export async function server(input: PluginInput, options: Options = {}): Promise<Hooks> {
  const file = options?.log === false ? undefined : typeof options?.log === "string" ? options.log : path.join(input.directory, ".opencode", "context-manage.jsonl")
  if (file) mkdirSync(path.dirname(file), { recursive: true })
  // A value it does not know is the default.
  const modules: Config = {
    turns: options?.turns === "recent" || options?.turns === "off" ? options.turns : "ask",
    stale: options?.stale === true,
    summary: options?.summary === "rule" || options?.summary === "placeholder" ? options.summary : "note",
    timing: options?.timing === "now" ? "now" : "rent",
  }
  const text = prompt(modules)
  // Tokens the messages reach before context management starts (default 10000); 0: from the first request.
  const start = typeof options?.start === "number" ? options.start : 10000
  const cache = typeof options?.cache === "number" && options.cache > 0 && options.cache <= 1 ? options.cache : CACHE
  const config = options?.stage === false ? undefined : typeof options?.stage === "string" ? options.stage : fileURLToPath(new URL("./stage/default-config.json", import.meta.url))
  const stage = config ? await BugfixAdaptiveContext(input, config) : undefined
  // A turn that calls the stage layer's tool is never folded: its arguments carry the handoff.
  const pinned = new Set(Object.keys(stage?.tool ?? {}))
  const log = (session: unknown, event: Record<string, unknown>) => {
    if (!file) return
    try {
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), session, ...event }) + "\n")
    } catch {}
  }
  log(undefined, { type: "config", ...modules, start, cache })

  return {
    // Forward the complete Stage-Only hook surface, including cache diagnostics.
    ...stage,

    "experimental.chat.system.transform": async (_input, output) => {
      if (!start && text) output.system[0] = output.system.length ? `${text}\n\n${output.system[0]}` : text
      // Observe after this layer's optional instruction, without changing stage behavior.
      await stage?.["experimental.chat.system.transform"]?.(_input, output)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      // The stage layer's errors stop the request, as it means them to.
      await stage?.["experimental.chat.messages.transform"](_input, output)
      const msgs = output.messages as unknown as Msg[]
      const session = msgs[0]?.info.sessionID
      try {
        const task = msgs.find((m) => m.info.role === "user")
        const at = task?.parts.findIndex((p) => p.type === "text" && !p.ignored && !p.synthetic && p.text) ?? -1
        if (!start && text && at >= 0) task!.parts[at] = { ...task!.parts[at], text: `${text}\n\n${task!.parts[at]!.text}` }
        log(session, { type: "request", ...render(msgs, modules, start, pinned, cache) })
      } catch (error) {
        log(session, { type: "error", message: String(error) })
      }
    },
  }
}
