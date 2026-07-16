#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import path from "path"

const REPO = "https://github.com/anomalyco/opencode"
const TAG = process.argv[2] || "v1.18.2"
const WORK = path.resolve(import.meta.dirname, "..", ".work")
const DICT = path.resolve(import.meta.dirname, "zh-CN.json")
const ENZH = path.resolve(import.meta.dirname, "en-zh-map.json")
const BINARY_NAME = "68oc"

async function main() {
  const dict: Record<string, string> = JSON.parse(await Bun.file(DICT).text())
  const enzh: Record<string, string> = JSON.parse(await Bun.file(ENZH).text())
  const now = new Date().toISOString()
  const src = path.join(WORK, "source")

  if (fs.existsSync(WORK)) await $`rm -rf ${WORK}`
  await $`mkdir -p ${WORK}`

  process.stdout.write(`Cloning ${REPO} at ${TAG}...\n`)
  await $`git clone --depth 1 --branch ${TAG} ${REPO} ${src}`

  process.stdout.write("Setting up i18n infrastructure...\n")
  await setupI18n(src, dict, now)

  process.stdout.write("Applying patches...\n")
  await patchTuiFiles(src, dict, enzh)
  await patchTuiSpecial(src, dict)
  await patchCliFiles(src, dict, enzh)
  await patchCommandIndex(src, dict)

  process.stdout.write("Installing dependencies...\n")
  await $`bun install --cwd ${src}`

  process.stdout.write("Building binary...\n")
  const opencodeDir = path.join(src, "packages/opencode")
  const result = await $`bun run --cwd ${opencodeDir} build -- --skip-embed-web-ui --single`.nothrow()
  if (result.exitCode !== 0) throw new Error("Build failed")

  // Rename and copy output
  const distDir = path.join(opencodeDir, "dist")
  const out = path.resolve(import.meta.dirname, "..", "out")
  await $`mkdir -p ${out}`
  for (const binDir of fs.readdirSync(distDir).filter((d) => d.startsWith("opencode-"))) {
    const binFolder = path.join(distDir, binDir, "bin")
    for (const file of fs.readdirSync(binFolder)) {
      const old = path.join(binFolder, file)
      const newPath = path.join(binFolder, file.replace("opencode", BINARY_NAME))
      if (old !== newPath) fs.renameSync(old, newPath)
      await $`cp ${newPath} ${out}/`
    }
  }

  process.stdout.write(`\nDone! Binary in: ${out}\\${BINARY_NAME}.exe\n`)
}

// ========== i18n infrastructure ==========

async function setupI18n(src: string, dict: Record<string, string>, now: string) {
  const i18nDir = path.join(src, "packages/opencode/src/i18n")
  await $`mkdir -p ${i18nDir}`

  const tree = buildNestedTree(dict)
  await Bun.file(path.join(i18nDir, "zh-cn.ts")).write(`export const zh = ${dumpTree(tree)} as const\n`)

  await Bun.file(path.join(i18nDir, "index.ts")).write(`
import { zh } from "./zh-cn"
type Param = string | number | boolean | null | undefined
export function t(key: string, params?: Record<string, Param>) {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined
    return (node as Record<string, unknown>)[part]
  }, zh)
  if (typeof value !== "string") return key
  if (!params) return value
  return value.replace(/\\{([^}]+)\\}/g, (match, name) => {
    const next = params[name]
    return next === undefined || next === null ? match : String(next)
  })
}
export { zh }
`)
}

function buildNestedTree(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split(".")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!(part in node) || typeof node[part] !== "object") node[part] = {}
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = flat[key]
  }
  return root
}

function dumpTree(input: Record<string, unknown>, level = 0): string {
  const indent = "  ".repeat(level)
  const next = "  ".repeat(level + 1)
  const keys = Object.keys(input).sort()
  const rows = keys.map((key) => {
    const val = input[key]
    if (typeof val === "string") return `${next}${key}: ${JSON.stringify(val)},`
    return `${next}${key}: ${dumpTree(val as Record<string, unknown>, level + 1)},`
  })
  return `{\n${rows.join("\n")}\n${indent}}`
}

// ========== Direct string replacement (TUI files) ==========
// TUI files are in packages/tui/ where @/i18n alias doesn't exist.
// Strategy: direct English→Chinese string replacement, no t() calls.

async function patchTuiFiles(src: string, dict: Record<string, string>, enzh: Record<string, string>) {
  const tuiDir = path.join(src, "packages/tui/src")
  if (!fs.existsSync(tuiDir)) return

  const files: string[] = []
  walkDir(tuiDir, files)

  // Only use en-zh-map entries (complete English phrases), NOT dictionary key segments
  // This avoids false positives on short/generic words like "path", "import", etc.
  const sortedEnZh = Object.entries(enzh)
    .filter(([en]) => en.length >= 10)
    .sort((a, b) => b[0].length - a[0].length)

  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue
    let content = await Bun.file(file).text()
    let modified = false
    const orig = content
    const relPath = path.relative(src, file)

    // Match each English phrase inside string literals
    for (const [en, zh] of sortedEnZh) {
      const escaped = escapeRegex(en)
      // Replace "English text" → "Chinese text" (exact match inside quotes)
      const regex = new RegExp(`"${escaped}"`, "gi")
      if (regex.test(content)) {
        content = content.replace(regex, `"${zh}"`)
      }
    }

    if (content !== orig) {
      await Bun.file(file).write(content)
      process.stdout.write(`  TUI: ${relPath}\n`)
    }
  }
}

// ========== CLI file patches ==========
// CLI files are in packages/opencode/src/ where @/i18n alias works.
// Strategy: replace English text with t("key") calls.

async function patchCliFiles(src: string, dict: Record<string, string>, enzh: Record<string, string>) {
  const cliDir = path.join(src, "packages/opencode/src/cli")
  if (!fs.existsSync(cliDir)) return

  const files: string[] = []
  walkDir(cliDir, files)

  // Use en-zh-map for direct replacement of longer display strings only
  const sortedEnZh = Object.entries(enzh)
    .filter(([en]) => en.length >= 10) // Only longer strings to avoid false positives
    .sort((a, b) => b[0].length - a[0].length)

  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue
    let content = await Bun.file(file).text()
    let modified = false
    const relPath = path.relative(src, file)

    // Direct English→Chinese replacement for display strings
    for (const [en, zh] of sortedEnZh) {
      const escaped = escapeRegex(en)
      const regex = new RegExp(`(?<=["'\`])${escaped}(?=["'\`])`, "gi")
      if (regex.test(content)) {
        content = content.replace(regex, zh)
        modified = true
      }
    }

    if (modified) {
      await Bun.file(file).write(content)
      process.stdout.write(`  CLI: ${relPath}\n`)
    }
  }
}

// ========== Special patches for TUI files (direct string replacement, no t() calls) ==========

async function patchTuiSpecial(src: string, dict: Record<string, string>) {
  const ROOT = src

  // app.tsx: categories + command palette titles
  await patchFile(ROOT, "packages/tui/src/app.tsx", (content) => {
    let c = content
    const catMap: Record<string, string> = {
      System: dict["tui.cat.system"],
      Session: dict["tui.cat.session"],
      Workspace: dict["tui.cat.workspace"],
      Agent: dict["tui.cat.agent"],
      Provider: dict["tui.cat.provider"],
    }
    for (const [en, zh] of Object.entries(catMap)) {
      if (zh) c = c.replaceAll(`category: "${en}"`, `category: "${zh}"`)
    }
    const titles: [string, string][] = [
      ["Show command palette", "tui.cmd.commands"],
      ["Switch session", "tui.cmd.switch_session"],
      ["New session", "tui.cmd.new_session"],
      ["Copy worktree path", "tui.cmd.copy_worktree_path"],
      ["Manage workspaces", "tui.cmd.manage_workspaces"],
      ["Switch model", "tui.cmd.switch_model"],
      ["Model cycle", "tui.cmd.model_cycle"],
      ["Model cycle reverse", "tui.cmd.model_cycle_reverse"],
      ["Favorite cycle", "tui.cmd.favorite_cycle"],
      ["Favorite cycle reverse", "tui.cmd.favorite_cycle_reverse"],
      ["Switch agent", "tui.cmd.switch_agent"],
      ["Toggle MCPs", "tui.cmd.toggle_mcps"],
      ["Agent cycle", "tui.cmd.agent_cycle"],
      ["Agent cycle reverse", "tui.cmd.agent_cycle_reverse"],
      ["Variant cycle", "tui.cmd.variant_cycle"],
      ["Switch model variant", "tui.cmd.switch_model_variant"],
      ["Connect provider", "tui.cmd.connect_provider"],
      ["View status", "tui.cmd.view_status"],
      ["View debug info", "tui.cmd.view_debug_info"],
      ["Switch theme", "tui.cmd.switch_theme"],
      ["Help", "tui.cmd.help"],
      ["Open docs", "tui.cmd.open_docs"],
      ["Exit the app", "tui.cmd.exit_app"],
      ["Toggle debug panel", "tui.cmd.toggle_debug_panel"],
      ["Toggle console", "tui.cmd.toggle_console"],
      ["Write heap snapshot", "tui.cmd.write_heap_snapshot"],
      ["Suspend terminal", "tui.cmd.suspend_terminal"],
    ]
    for (const [en, key] of titles) {
      const zh = dict[key]
      if (zh) c = c.replaceAll(`title: "${en}"`, `title: "${zh}"`)
    }
    // Special: "The current model does not support any variants."
    const noVarKey = "tui.the_current_model_does_not_support_any_variants"
    if (dict[noVarKey]) c = c.replaceAll('"The current model does not support any variants."', `"${dict[noVarKey]}"`)
    return c === content ? null : c
  })

  // keybind.ts: replace description strings directly
  await patchFile(ROOT, "packages/tui/src/config/keybind.ts", (content) => {
    let c = content
    const descs: [string, string][] = [
      ["Export session to editor", "tui.export.to_editor"],
      ["Copy session transcript", "tui.session.copy_transcript"],
      ["Create a new session", "tui.session.create"],
      ["List all sessions", "tui.session.list"],
      ["Show session timeline", "tui.session.timeline"],
      ["Fork session from message", "tui.session.fork"],
      ["Rename session", "tui.session.rename"],
      ["Delete session", "tui.session.delete"],
      ["Share current session", "tui.session.share"],
      ["Unshare current session", "tui.session.unshare"],
      ["Interrupt current session", "tui.session.interrupt"],
      ["Compact the session", "tui.session.compact"],
      ["Toggle message timestamps", "tui.session.toggle_timestamps"],
      ["Go to first child session", "tui.session.child_first"],
      ["Go to next child session", "tui.session.child_next"],
      ["Go to previous child session", "tui.session.child_previous"],
      ["Go to parent session", "tui.session.parent"],
      ["Pin or unpin session in the session list", "tui.session.pin_unpin"],
    ]
    for (const [en, key] of descs) {
      const zh = dict[key]
      if (zh) c = c.replaceAll(en, zh)
    }
    return c === content ? null : c
  })

  // tips-view.tsx: replace tip texts directly
  await patchFile(ROOT, "packages/tui/src/feature-plugins/home/tips-view.tsx", (content) => {
    let c = content
    const tips: [string, string][] = [
      ["Type {highlight}@{/highlight} followed by a filename to fuzzy search and attach files", "tui.home.tips.0"],
      ["Start a message with {highlight}!{/highlight} to run shell commands directly", "tui.home.tips.1"],
      ["Use {highlight}/undo{/highlight} to revert the last message and file changes", "tui.home.tips.3"],
      ["Use {highlight}/redo{/highlight} to restore previously undone messages and file changes", "tui.home.tips.4"],
      ["Run {highlight}/share{/highlight} to create a public link to your conversation at opencode.ai", "tui.home.tips.5"],
      ["Drag and drop images or PDFs into the terminal to add them as context", "tui.home.tips.6"],
      ["Paste images from your clipboard into the prompt", "tui.home.tips.7"],
      ["Use /editor to compose messages in your external editor", "tui.home.tips.8"],
      ["Run {highlight}/init{/highlight} to auto-generate project rules based on your codebase", "tui.home.tips.9"],
      ["Run {highlight}/compact{/highlight} to summarize long sessions near context limits", "tui.home.tips.13"],
      ["Run {highlight}/connect{/highlight} to add API keys for 75+ supported LLM providers", "tui.home.tips.19"],
      ["Run {highlight}/connect{/highlight} to add an AI provider and start coding", "tui.home.tips.no_models"],
    ]
    // Replace exact strings inside quotes
    for (const [en, key] of tips) {
      const zh = dict[key]
      if (!zh) continue
      const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      c = c.replace(new RegExp(`"${escaped}"`, "g"), `"${zh}"`)
    }
    return c === content ? null : c
  })

  // home.tsx: placeholder examples
  await patchFile(ROOT, "packages/tui/src/routes/home.tsx", (content) => {
    let c = content
    const keys = ["tui.home.placeholder_1", "tui.home.placeholder_2", "tui.home.placeholder_3"]
    if (keys.every((k) => dict[k]) && c.includes("Fix a TODO")) {
      c = c.replace(
        /normal:\s*\["Fix a TODO in the codebase",\s*"What is the tech stack of this project\?",\s*"Fix broken tests"\]/,
        `normal: ["${dict[keys[0]]}", "${dict[keys[1]]}", "${dict[keys[2]]}"]`,
      )
      return c
    }
    return null
  })
}

async function patchCommandIndex(src: string, dict: Record<string, string>) {
  const filePath = path.join(src, "packages/opencode/src/command/index.ts")
  if (!fs.existsSync(filePath)) return

  let content = await Bun.file(filePath).text()
  let modified = false

  const cmdKeys: [string, RegExp][] = [
    ["tui.command.init_description", /description:\s*"guided AGENTS\.md setup"/],
    ["tui.command.review_description", /description:\s*"review changes \[commit\|branch\|pr\], defaults to uncommitted"/],
  ]
  for (const [key, regex] of cmdKeys) {
    if (dict[key] && regex.test(content)) {
      content = content.replace(regex, `description: t("${key}")`)
      modified = true
    }
  }

  if (modified) {
    if (!content.includes('import { t } from "@/i18n"')) {
      content = content.replace(/(import .+\n)/, `$1import { t } from "@/i18n"\n`)
    }
    await Bun.file(filePath).write(content)
    process.stdout.write(`  CMD: command/index.ts\n`)
  }
}

// ========== Utilities ==========

async function patchFile(root: string, relPath: string, patcher: (content: string) => string | null) {
  const full = path.join(root, relPath)
  if (!fs.existsSync(full)) return
  const content = await Bun.file(full).text()
  const result = patcher(content)
  if (result !== null && result !== content) {
    await Bun.file(full).write(result)
    process.stdout.write(`  PATCH: ${relPath}\n`)
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function walkDir(dir: string, acc: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") walkDir(full, acc)
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      acc.push(full)
    }
  }
}

void main()
