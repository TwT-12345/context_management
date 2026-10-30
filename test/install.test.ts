import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const plugin = path.join(root, "src", "index.ts")

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const project = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-install-"))
  dirs.push(dir)
  return dir
}
const write = (dir: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), text)
}
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), "utf8")
const install = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["node", path.join(root, "install.mjs"), dir, ...args])
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const ENTRY = ".opencode/plugins/context-manage.js"
const CONFIG = ".opencode/bugfix-adaptive-context.config.json"
const options = (dir: string) => JSON.parse(read(dir, ENTRY).match(/^const OPTIONS = (.*)$/m)![1]!)
const backup = (dir: string, out: string) => JSON.parse(out).backupDirectory as string

describe("install", () => {
  test("copies the plugin and writes the config, its options and .gitignore in a new project", () => {
    const dir = project()
    const r = install(dir, "my-agent")
    expect(r.code).toBe(0)
    expect(options(dir)).toEqual({ stage: CONFIG })
    expect(read(dir, ".opencode/plugins/context-manage/index.ts")).toBe(readFileSync(plugin, "utf8"))
    expect(JSON.parse(read(dir, CONFIG)).targetAgent).toBe("my-agent")
    expect(read(dir, ".opencode/.gitignore")).toContain("context-manage.jsonl")
    expect(backup(dir, r.out)).toBeNull()
    expect(install(dir).code).toBe(0) // the same version again changes nothing that needs --replace
  })

  test("the entry exports a plain function, as OpenCode 1.2 calls every export", async () => {
    const dir = project()
    install(dir)
    // OpenCode installs @opencode-ai/plugin into .opencode/node_modules; here the repository's copy stands in.
    symlinkSync(path.join(root, "node_modules"), path.join(dir, ".opencode/node_modules"))
    write(dir, ENTRY, read(dir, ENTRY).replace(/^const OPTIONS = .*$/m, 'const OPTIONS = {"stage":false,"log":false}'))
    const mod = await import(path.join(dir, ENTRY))
    expect(Object.keys(mod)).toEqual(["ContextManage"])
    const hooks = await mod.ContextManage({ directory: dir, client: {} })
    expect(hooks.tool).toBeUndefined()
  })

  test("needs --replace for a different copy, keeps the edited OPTIONS and backs up the old copy", () => {
    const dir = project()
    install(dir)
    write(dir, ENTRY, read(dir, ENTRY).replace(/^const OPTIONS = .*$/m, 'const OPTIONS = {"keep":"ask"}'))
    write(dir, ".opencode/plugins/context-manage/index.ts", "OLD")
    const refused = install(dir)
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("Use --replace")
    const r = install(dir, "--replace")
    expect(r.code).toBe(0)
    expect(options(dir)).toEqual({ keep: "ask" })
    expect(read(dir, ".opencode/plugins/context-manage/index.ts")).toBe(readFileSync(plugin, "utf8"))
    expect(readFileSync(path.join(backup(dir, r.out), "context-manage/index.ts"), "utf8")).toBe("OLD")
  })

  test("replaces an installed Stage-Only only with --replace, and keeps its config", () => {
    const dir = project()
    write(dir, ".opencode/plugins/bugfix-adaptive-context.js", "OLD")
    write(dir, ".opencode/plugins/bugfix-adaptive-context-lib/state.mjs", "OLD")
    write(dir, ".opencode/tools/bugfix-adaptive-stage.js", "OLD")
    const config = { ...JSON.parse(readFileSync(path.join(root, "src/stage/default-config.json"), "utf8")), targetAgent: "theirs" }
    write(dir, CONFIG, JSON.stringify(config))
    const refused = install(dir)
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("Stage-Only is installed")
    expect(existsSync(path.join(dir, ENTRY))).toBe(false)
    const r = install(dir, "--replace")
    expect(r.code).toBe(0)
    expect(existsSync(path.join(dir, ".opencode/plugins/bugfix-adaptive-context.js"))).toBe(false)
    expect(existsSync(path.join(dir, ".opencode/tools/bugfix-adaptive-stage.js"))).toBe(false)
    expect(JSON.parse(read(dir, CONFIG)).targetAgent).toBe("theirs")
    expect(readdirSync(backup(dir, r.out)).sort()).toEqual(["bugfix-adaptive-context-lib", "bugfix-adaptive-context.config.json", "bugfix-adaptive-context.js", "bugfix-adaptive-stage.js"])
  })

  test("an old state needs --reset-state, which deletes it and the logs after the backup", () => {
    const dir = project()
    write(dir, ".opencode/bugfix-adaptive-context.state.json", JSON.stringify({ version: 5 }))
    write(dir, ".opencode/context-manage.jsonl", "{}\n")
    write(dir, ".opencode/bugfix-adaptive-cache.jsonl", '{"schemaVersion":2}\n')
    const refused = install(dir)
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("--reset-state")
    const r = install(dir, "--reset-state")
    expect(r.code).toBe(0)
    expect(existsSync(path.join(dir, ".opencode/bugfix-adaptive-context.state.json"))).toBe(false)
    expect(existsSync(path.join(dir, ".opencode/context-manage.jsonl"))).toBe(false)
    expect(existsSync(path.join(dir, ".opencode/bugfix-adaptive-cache.jsonl"))).toBe(false)
    expect(readdirSync(backup(dir, r.out))).toContain("bugfix-adaptive-context.state.json")
    expect(readFileSync(path.join(backup(dir, r.out), "bugfix-adaptive-cache.jsonl"), "utf8")).toContain('"schemaVersion":2')
    expect(read(dir, ".opencode/.gitignore")).toContain("bugfix-adaptive-cache.jsonl")
  })

  test("--replace-config needs --reset-state, and a broken OPTIONS line stops it", () => {
    const dir = project()
    install(dir)
    expect(install(dir, "--replace-config").err).toContain("requires --reset-state")
    expect(install(dir, "other", "--replace-config", "--reset-state").code).toBe(0)
    expect(JSON.parse(read(dir, CONFIG)).targetAgent).toBe("other")
    write(dir, ENTRY, "const OPTIONS = { keep: 'ask' }\n")
    const bad = install(dir)
    expect(bad.code).not.toBe(0)
    expect(bad.err).toContain("one line of JSON")
  })
})
