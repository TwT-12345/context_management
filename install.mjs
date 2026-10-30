// Installs this plugin into an OpenCode 1.2 project, the way the Stage-Only package installs itself:
//   node install.mjs /path/to/project [targetAgent] [--replace] [--replace-config] [--reset-state]
// src/ is copied to .opencode/plugins/context-manage/ and .opencode/plugins/context-manage.js loads it (OpenCode
// loads the top-level files of .opencode/plugins/ by itself and installs @opencode-ai/plugin into
// .opencode/node_modules). The plugin's options are the OPTIONS line of that file, one line of JSON; a reinstall
// keeps them. The stage config is .opencode/bugfix-adaptive-context.config.json, written for targetAgent
// (default bug-fix-adaptive) when missing. The flags mean what they mean for Stage-Only: --replace overwrites a
// different copy of this plugin and moves away what Stage-Only installed (its plugin, library and stage tool, and
// the full version's observation tool, since this plugin registers the stage tool itself); --replace-config
// writes the config again and needs --reset-state, which deletes the state and the logs. Everything replaced is
// copied first to .opencode/bugfix-adaptive-backups/context-manage-*. Restart OpenCode and start a new Session after.

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateConfig } from "./src/stage/config.mjs"
import { STATE_VERSION } from "./src/stage/state.mjs"

async function filesIn(directory, base = directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesIn(absolute, base))
    else if (entry.isFile()) files.push(path.relative(base, absolute))
  }
  return files.sort()
}

async function directoriesEqual(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([filesIn(left), filesIn(right)])
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false
  for (const relative of leftFiles) {
    const [a, b] = await Promise.all([fs.readFile(path.join(left, relative)), fs.readFile(path.join(right, relative))])
    if (!a.equals(b)) return false
  }
  return true
}

const exists = (file) => fs.stat(file).catch((error) => {
  if (error?.code === "ENOENT") return null
  throw error
})

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(["--replace", "--replace-config", "--reset-state"])
const [projectArgument, targetAgentArgument] = args.filter((argument) => !flags.has(argument))
const replace = args.includes("--replace")
const replaceConfig = args.includes("--replace-config")
const resetState = args.includes("--reset-state")

if (!projectArgument) {
  throw new Error("Usage: node install.mjs /absolute/path/to/project [targetAgent] [--replace] [--replace-config] [--reset-state]")
}
const project = path.resolve(projectArgument)
if (!(await exists(project))?.isDirectory()) throw new Error(`Project directory does not exist: ${project}`)
const targetAgent = targetAgentArgument ?? "bug-fix-adaptive"
if (targetAgent.trim() === "") throw new Error("targetAgent must be non-empty")

const openCode = path.join(project, ".opencode")
const plugins = path.join(openCode, "plugins")
const entryDestination = path.join(plugins, "context-manage.js")
const libraryDestination = path.join(plugins, "context-manage")
const configDestination = path.join(openCode, "bugfix-adaptive-context.config.json")
const stateDestination = path.join(openCode, "bugfix-adaptive-context.state.json")
const auditDestination = path.join(openCode, "bugfix-adaptive-context.jsonl")
const cacheDestination = path.join(openCode, "bugfix-adaptive-cache.jsonl")
const logDestination = path.join(openCode, "context-manage.jsonl")
const stageOnly = [
  path.join(plugins, "bugfix-adaptive-context.js"),
  path.join(plugins, "bugfix-adaptive-context-lib"),
  path.join(openCode, "tools", "bugfix-adaptive-stage.js"),
  path.join(openCode, "tools", "bugfix-adaptive-observation.js"),
]

const requestedConfig = JSON.parse(await fs.readFile(path.join(root, "src", "stage", "default-config.json"), "utf8"))
requestedConfig.targetAgent = targetAgent
validateConfig(requestedConfig, "default-config.json")

// The options of an installed entry are kept; a new one loads the config above.
const OPTIONS_LINE = /^const OPTIONS = (.*)$/m
const installedEntry = await fs.readFile(entryDestination, "utf8").catch(() => undefined)
let options = { stage: path.relative(project, configDestination).split(path.sep).join("/") }
if (installedEntry !== undefined) {
  try {
    options = JSON.parse(installedEntry.match(OPTIONS_LINE)[1])
  } catch {
    throw new Error(`The OPTIONS line of ${entryDestination} must be one line of JSON`)
  }
}
const entry = [
  "// Loads the context-management plugin in ./context-manage/ (written by its install.mjs).",
  "// OPTIONS are the plugin's options (its docs/design.md, section 9), for example {\"turns\": \"recent\", \"summary\": \"rule\"}.",
  "// Keep them one line of JSON: a reinstall reads them back.",
  'import { server } from "./context-manage/index.ts"',
  `const OPTIONS = ${JSON.stringify(options)}`,
  "export const ContextManage = (input) => server(input, OPTIONS)",
  "",
].join("\n")

if (installedEntry !== undefined && installedEntry !== entry && !replace) {
  throw new Error(`Refusing to overwrite a different plugin: ${entryDestination}. Use --replace.`)
}
const librarySource = path.join(root, "src")
const installedLibrary = await exists(libraryDestination)
if (installedLibrary?.isDirectory() && !replace && !(await directoriesEqual(librarySource, libraryDestination))) {
  throw new Error(`Refusing to overwrite a different plugin library: ${libraryDestination}. Use --replace.`)
}
const oldStageOnly = []
for (const file of stageOnly) if (await exists(file)) oldStageOnly.push(file)
if (oldStageOnly.length && !replace) {
  throw new Error(`Stage-Only is installed (${oldStageOnly.map((file) => path.relative(project, file)).join(", ")}); this plugin replaces it. Use --replace (it will be backed up).`)
}

let existingConfig
let existingConfigInvalid = null
try {
  existingConfig = JSON.parse(await fs.readFile(configDestination, "utf8"))
  validateConfig(existingConfig, configDestination)
} catch (error) {
  if (error?.code === "ENOENT") existingConfig = undefined
  else existingConfigInvalid = error
}
if (existingConfigInvalid && !replaceConfig) throw existingConfigInvalid
if ((existingConfig !== undefined || existingConfigInvalid) && replaceConfig && !resetState) {
  throw new Error("Replacing adaptive projection config requires --reset-state")
}
if (!resetState) {
  try {
    const installedState = JSON.parse(await fs.readFile(stateDestination, "utf8"))
    if (installedState.version !== STATE_VERSION) {
      throw new Error(`Adaptive State upgrade requires --reset-state and a new Session: ${stateDestination}`)
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

// Everything that is replaced, moved or reset is copied first.
const backupTargets = [entryDestination, libraryDestination, configDestination, stateDestination, auditDestination, cacheDestination, logDestination, ...oldStageOnly]
const existingTargets = []
for (const file of backupTargets) if (await exists(file)) existingTargets.push(file)
let backupDirectory = null
if (existingTargets.length) {
  const backupRoot = path.join(openCode, "bugfix-adaptive-backups")
  await fs.mkdir(backupRoot, { recursive: true })
  backupDirectory = await fs.mkdtemp(path.join(backupRoot, "context-manage-"))
  for (const file of existingTargets) await fs.cp(file, path.join(backupDirectory, path.basename(file)), { recursive: true })
}
for (const file of oldStageOnly) await fs.rm(file, { recursive: true })

await fs.mkdir(plugins, { recursive: true })
await fs.rm(libraryDestination, { recursive: true, force: true })
await fs.cp(librarySource, libraryDestination, { recursive: true })
await fs.writeFile(entryDestination, entry)
if (existingConfig === undefined || replaceConfig) {
  await fs.writeFile(configDestination, `${JSON.stringify(requestedConfig, null, 2)}\n`)
}

const resetFiles = []
if (resetState) {
  for (const file of [stateDestination, auditDestination, cacheDestination, logDestination]) {
    try {
      await fs.unlink(file)
      resetFiles.push(file)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
}

const ignorePath = path.join(openCode, ".gitignore")
const ignore = await fs.readFile(ignorePath, "utf8").catch(() => "")
const newline = ignore.includes("\r\n") ? "\r\n" : "\n"
const ignoreEntries = new Set(ignore.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))
const missing = [
  "bugfix-adaptive-context.state.json",
  "bugfix-adaptive-context.state.json.*.tmp",
  "bugfix-adaptive-context.jsonl",
  "bugfix-adaptive-cache.jsonl",
  "context-manage.jsonl",
].filter((item) => !ignoreEntries.has(item))
if (missing.length) {
  const prefix = ignore === "" || ignore.endsWith("\n") ? ignore : `${ignore}${newline}`
  await fs.writeFile(ignorePath, `${prefix}${missing.join(newline)}${newline}`)
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  project,
  targetAgent,
  plugin: entryDestination,
  pluginLibrary: libraryDestination,
  options,
  removedStageOnly: oldStageOnly,
  backupDirectory,
  config: configDestination,
  state: stateDestination,
  audit: auditDestination,
  cacheDiagnostics: cacheDestination,
  log: logDestination,
  stateVersion: STATE_VERSION,
  resetFiles,
  next: "Restart OpenCode and start a new Session.",
}, null, 2)}\n`)
