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

  // 1. Clone upstream tag
  process.stdout.write(`Cloning ${REPO} at ${TAG}...\n`)
  await $`git clone --depth 1 --branch ${TAG} ${REPO} ${src}`

  // 2. Generate i18n infrastructure
  process.stdout.write("Generating i18n files...\n")
  await setupI18n(src, dict, now)

  // 3. Apply patches to source files
  process.stdout.write("Applying translation patches...\n")
  await applyPatches(src, dict, enzh)

  // 4. Install dependencies
  process.stdout.write("Installing dependencies...\n")
  const opencodeDir = path.join(src, "packages/opencode")
  await $`bun install --cwd ${src}`

  // 5. Build CLI binary (skip web UI, single platform)
  process.stdout.write("Building 68oc binary...\n")
  await buildBinary(opencodeDir)

  // 6. Rename and package
  const distDir = path.join(opencodeDir, "dist")
  const builtBinaries = fs.readdirSync(distDir).filter((d) => d.startsWith("opencode-"))
  for (const binDir of builtBinaries) {
    const binFolder = path.join(distDir, binDir, "bin")
    for (const file of fs.readdirSync(binFolder)) {
      const old = path.join(binFolder, file)
      const newPath = path.join(binFolder, file.replace("opencode", BINARY_NAME))
      if (old !== newPath) fs.renameSync(old, newPath)
    }
  }

  // 7. Copy result to output
  const out = path.resolve(import.meta.dirname, "..", "out")
  await $`mkdir -p ${out}`
  for (const binDir of builtBinaries) {
    const binPath = path.join(distDir, binDir, "bin")
    for (const file of fs.readdirSync(binPath)) {
      await $`cp ${path.join(binPath, file)} ${out}/`
    }
  }

  process.stdout.write(`\nDone! Binary in: ${out}\\${BINARY_NAME}.exe\n`)
}

async function setupI18n(src: string, dict: Record<string, string>, now: string) {
  const i18nDir = path.join(src, "packages/opencode/src/i18n")
  await $`mkdir -p ${i18nDir}`

  // Generate zh-cn.ts from flat dot-notation dictionary
  const tree = buildNestedTree(dict)
  const code = `export const zh = ${dumpTree(tree)} as const\n`
  await Bun.file(path.join(i18nDir, "zh-cn.ts")).write(code)

  // Generate index.ts with t() function
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

async function applyPatches(src: string, dict: Record<string, string>, enzh: Record<string, string>) {
  const ROOT = src
  const OPTS: PatchOptions = { ROOT, dict }

  // === Step 0: Direct English→Chinese replacement in CLI files ===
  process.stdout.write("Applying CLI description translations...\n")
  const cliDirs = [
    path.join(ROOT, "packages/opencode/src/cli"),
    path.join(ROOT, "packages/opencode/src/command"),
  ]
  const cliFiles: string[] = []
  for (const dir of cliDirs) walkDir(dir, cliFiles)
  const sortedEntries = Object.entries(enzh).sort((a, b) => b[0].length - a[0].length)
  for (const file of cliFiles) {
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts") || file.includes("node_modules")) continue
    let content = await Bun.file(file).text()
    const orig = content
    for (const [en, zh] of sortedEntries) {
      if (en.length < 4) continue
      const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      content = content.replace(new RegExp(escaped, "g"), zh)
    }
    if (content !== orig) {
      await Bun.file(file).write(content)
      process.stdout.write(`  CLI: ${path.relative(ROOT, file)}\n`)
    }
  }

  // === Special patches (known file paths, adapted from opencode-zh) ===

  // TUI app.tsx: command palette titles + categories
  await patchFile(path.join(ROOT, "packages/tui/src/app.tsx"), (content) => {
    let c = content
    // Replace category strings
    c = c.replaceAll(/\bcategory:\s*"(System|Session|Workspace|Agent|Provider)"/g, (_, cat) => {
      const key = `tui.cat.${cat.toLowerCase()}`
      return dict[key] ? `category: t("${key}")` : `category: "${cat}"`
    })

    // Replace title strings for command palette items
    const titleReplacements: [RegExp, string][] = [
      [/title:\s*"Show command palette"/g, 'title: t("tui.cmd.commands")'],
      [/title:\s*"Switch session"/g, 'title: t("tui.cmd.cycle_recent_next")'],
      [/title:\s*"New session"/g, 'title: t("tui.cmd.default")'],
      [/title:\s*"Copy worktree path"/g, 'title: t("tui.cmd.copy_worktree_path")'],
      [/title:\s*"Manage workspaces"/g, 'title: t("tui.cmd.workspaces")'],
      [/title:\s*"Switch model"/g, 'title: t("tui.cmd.model_cycle")'],
      [/title:\s*"Model cycle"/g, 'title: t("tui.cmd.default")'],
      [/title:\s*"Favorite cycle"/g, 'title: t("tui.cmd.favorite_cycle")'],
      [/title:\s*"Switch agent"/g, 'title: t("tui.cmd.agent_cycle")'],
      [/title:\s*"Toggle MCPs"/g, 'title: t("tui.cmd.toggle_mcp")'],
      [/title:\s*"Agent cycle"/g, 'title: t("tui.cmd.agent_cycle")'],
      [/title:\s*"Variant cycle"/g, 'title: t("tui.cmd.variant_cycle")'],
      [/title:\s*"Switch model variant"/g, 'title: t("tui.cmd.variant_list")'],
      [/title:\s*"Connect provider"/g, 'title: t("tui.cmd.connect_provider")'],
      [/title:\s*"View status"/g, 'title: t("tui.cmd.status")'],
      [/title:\s*"View debug info"/g, 'title: t("tui.cmd.debug_info")'],
      [/title:\s*"Switch theme"/g, 'title: t("tui.cmd.theme_list")'],
      [/title:\s*"Help"/g, 'title: t("tui.cmd.help")'],
      [/title:\s*"Open docs"/g, 'title: t("tui.cmd.open_docs")'],
      [/title:\s*"Exit the app"/g, 'title: t("tui.cmd.exit_app")'],
      [/title:\s*"Toggle debug panel"/g, 'title: t("tui.cmd.toggle_debug")'],
      [/title:\s*"Toggle console"/g, 'title: t("tui.cmd.toggle_console")'],
      [/title:\s*"Write heap snapshot"/g, 'title: t("tui.cmd.heap_snapshot")'],
      [/title:\s*"Suspend terminal"/g, 'title: t("tui.cmd.suspend_terminal")'],
    ]
    for (const [regex, replacement] of titleReplacements) {
      c = c.replace(regex, replacement)
    }

    // Add t() import if needed
    if (c !== content && !c.includes("import { t }")) {
      c = `import { t } from "@/i18n"\n${c}`
    }
    return c === content ? null : c
  })

  // TUI keybind.ts: replace all description strings with t() calls
  await patchFile(path.join(ROOT, "packages/tui/src/config/keybind.ts"), (content) => {
    let c = content
    const keybindKeys: Record<string, string> = {
      "Export session to editor": "tui.export.to_editor",
      "Copy session transcript": "tui.session.copy_transcript",
      "Create a new session": "tui.session.create",
      "List all sessions": "tui.session.list",
      "Show session timeline": "tui.session.timeline",
      "Fork session from message": "tui.session.fork",
      "Rename session": "tui.session.rename",
      "Delete session": "tui.session.delete",
      "Share current session": "tui.session.share",
      "Unshare current session": "tui.session.unshare",
      "Interrupt current session": "tui.session.interrupt",
      "Compact the session": "tui.session.compact",
      "Toggle message timestamps": "tui.session.toggle_timestamps",
      "Go to first child session": "tui.session.child_first",
      "Go to next child session": "tui.session.child_next",
      "Go to previous child session": "tui.session.child_previous",
      "Go to parent session": "tui.session.parent",
      "Pin or unpin session in the session list": "tui.session.pin_unpin",
    }
    for (const [text, key] of Object.entries(keybindKeys)) {
      if (dict[key]) {
        c = c.replaceAll(text, dict[key])
      }
    }
    return c === content ? null : c
  })

  // TUI tips-view.tsx: replace tips directly and inject t() function usage
  await patchFile(path.join(ROOT, "packages/tui/src/feature-plugins/home/tips-view.tsx"), (content) => {
    let c = content
    let modified = false

    // Replace NO_MODELS_TIP
    const noModelsKey = "tui.home.tips.no_models"
    if (dict[noModelsKey] && c.includes('const NO_MODELS_TIP = "Run {highlight}/connect{/highlight}')) {
      c = c.replace(
        /const NO_MODELS_TIP = "Run \{highlight\}\/connect\{\/highlight\} to add an AI provider and start coding"/,
        `const NO_MODELS_TIP = t("${noModelsKey}")`,
      )
      modified = true
    }

    // Replace all tip strings in the TIPS array
    const tipReplacements: [string, string][] = [
      ['"Type {highlight}@{/highlight} followed by a filename to fuzzy search and attach files"', "tui.home.tips.0"],
      ['"Start a message with {highlight}!{/highlight} to run shell commands directly', "tui.home.tips.1"],
      ['"Use {highlight}/undo{/highlight} to revert the last message and file changes"', "tui.home.tips.3"],
      ['"Use {highlight}/redo{/highlight} to restore previously undone messages and file changes"', "tui.home.tips.4"],
      ['"Run {highlight}/share{/highlight} to create a public link to your conversation at opencode.ai"', "tui.home.tips.5"],
      ['"Drag and drop images or PDFs into the terminal to add them as context"', "tui.home.tips.6"],
      ['"Use /editor to compose messages in your external editor"', "tui.home.tips.8"],
      ['"Run {highlight}/init{/highlight} to auto-generate project rules based on your codebase"', "tui.home.tips.9"],
      ['"Run {highlight}/compact{/highlight} to summarize long sessions near context limits"', "tui.home.tips.13"],
      ['"Run {highlight}/connect{/highlight} to add API keys for 75+ supported LLM providers"', "tui.home.tips.19"],
    ]
    for (const [search, key] of tipReplacements) {
      if (dict[key] && c.includes(search)) {
        c = c.replace(search, `t("${key}")`)
        modified = true
      }
    }

    if (modified && !c.includes('import { t } from')) {
      c = `import { t } from "@/i18n"\n${c}`
    }
    return c === content ? null : c
  })

  // TUI dialog-session-list.tsx
  await patchFile(path.join(ROOT, "packages/tui/src/component/dialog-session-list.tsx"), (content) => {
    let c = content
    let modified = false

    const replacements: [RegExp, string][] = [
      [/title:\s*"switch"/g, 'title: t("tui.common.switch")'],
      [/title:\s*"pin\/unpin"/g, 'title: t("tui.session.pin_unpin")'],
    ]
    for (const [regex, replacement] of replacements) {
      if (regex.test(c)) {
        c = c.replace(regex, replacement)
        modified = true
      }
    }

    if (modified && !c.includes('import { t }')) {
      c = `import { t } from "@/i18n"\n${c}`
    }
    return c === content ? null : c
  })

  // TUI home.tsx: placeholder examples
  await patchFile(path.join(ROOT, "packages/tui/src/routes/home.tsx"), (content) => {
    let c = content
    const homeKeys = ["tui.home.placeholder_1", "tui.home.placeholder_2", "tui.home.placeholder_3"]
    const hasDict = homeKeys.every((k) => dict[k])
    if (hasDict && c.includes("normal: [\"Fix a TODO")) {
      c = c.replace(
        /normal:\s*\["Fix a TODO in the codebase",\s*"What is the tech stack of this project\?",\s*"Fix broken tests"\]/,
        `normal: [\n    t("${homeKeys[0]}"),\n    t("${homeKeys[1]}"),\n    t("${homeKeys[2]}"),\n  ]`,
      )
      if (!c.includes('import { t }')) {
        c = `import { t } from "@/i18n"\n${c}`
      }
      return c
    }
    return null
  })

  // TUI session/index.tsx: "Thinking" spinner label
  await patchFile(path.join(ROOT, "packages/tui/src/routes/session/index.tsx"), (content) => {
    let c = content
    if (c.includes('"Thinking: "') || c.includes('"Thinking"')) {
      c = c.replace(/"Thinking: "/g, 't("tui.thinking_label") + ')
        .replace(/"Thinking"/g, 't("tui.thinking")')
      if (c !== content && !c.includes('import { t } from "@/i18n"')) {
        c = `import { t } from "@/i18n"\n${c}`
      }
      return c === content ? null : c
    }
    return null
  })

  // TUI prompt/index.tsx: "Interrupt session" title
  await patchFile(path.join(ROOT, "packages/tui/src/component/prompt/index.tsx"), (content) => {
    let c = content
    if (c.includes('"Interrupt session"')) {
      c = c.replace(/"Interrupt session"/g, 't("tui.prompt.interrupt_session")')
      if (c !== content && !c.includes('import { t } from "@/i18n"')) {
        c = `import { t } from "@/i18n"\n${c}`
      }
      return c === content ? null : c
    }
    return null
  })

  // CLI command: slash command descriptions
  await patchFile(path.join(ROOT, "packages/opencode/src/command/index.ts"), (content) => {
    let c = content
    let modified = false
    const cmdKeys: [string, RegExp][] = [
      ["tui.command.init_description", /description:\s*"guided AGENTS\.md setup"/],
      ["tui.command.review_description", /description:\s*"review changes \[commit\|branch\|pr\], defaults to uncommitted"/],
    ]
    for (const [key, regex] of cmdKeys) {
      if (dict[key] && regex.test(c)) {
        c = c.replace(regex, `description: t("${key}")`)
        modified = true
      }
    }
    if (modified && !c.includes('import { t }')) {
      c = c.replace(
        /(import .+\n)/,
        `$1import { t } from "@/i18n"\n`,
      )
    }
    return c === content ? null : c
  })

  // === Auto-patch for remaining hardcoded strings ===
  await autoPatchTuiFiles(src, dict, enzh)
}

async function buildBinary(opencodeDir: string) {
  const result = await $`bun run --cwd ${opencodeDir} build -- --skip-embed-web-ui --single --skip-install`.nothrow()
  if (result.exitCode !== 0) {
    process.stderr.write(`Build failed (attempt 1), retrying with install...\n`)
    await $`bun run --cwd ${opencodeDir} build -- --skip-embed-web-ui --single`
  }
}

async function autoPatchTuiFiles(src: string, dict: Record<string, string>, enzh: Record<string, string>) {
  // For TUI files, use direct English→Chinese replacement as fallback
  const sortedEnZh = Object.entries(enzh).sort((a, b) => b[0].length - a[0].length)

  const dirs = [
    "packages/tui/src",
    "packages/opencode/src/cli",
  ]

  const textToKey: Record<string, string> = {}
  for (const key of Object.keys(dict)) {
    const parts = key.split(".")
    const last = parts[parts.length - 1]
    textToKey[last.replace(/_/g, " ").toLowerCase()] = key
    textToKey[dict[key].toLowerCase()] = key
  }

  for (const dir of dirs) {
    const fullDir = path.join(src, dir)
    if (!fs.existsSync(fullDir)) continue

    const files: string[] = []
    walkDir(fullDir, files)

    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts") || file.includes("node_modules") || file.includes("i18n"))
        continue

      let content = await Bun.file(file).text()
      const relPath = path.relative(src, file)
      let modified = false

      // Skip files that already extensively use i18n
      if (content.includes('t("tui.') || content.includes("t('tui.")) continue

      const originalContent = content

      // Pattern 1: Direct English→Chinese replacement for known TUI strings
      for (const [en, zh] of sortedEnZh) {
        if (en.length < 6) continue
        const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const regex = new RegExp(`"${escaped}"|'${escaped}'|\`${escaped}\``, "g")
        content = content.replace(regex, (match) => {
          modified = true
          const quote = match[0]
          return `${quote}${zh}${quote}`
        })
      }

      // Pattern 2: JSX attribute placeholder/label/title/message="Text"
      const attrRegex = /\b(placeholder|label|title|message)\s*=\s*"([^"]{3,})"/g
      content = content.replace(attrRegex, (match, attr, text) => {
        const key = findKey(text, textToKey)
        if (key) { modified = true; return `${attr}={t("${key}")}` }
        return match
      })

      // Pattern 3: Object property title/label/message: "Text"
      const objRegex = /\b(title|label|message|description|category)\s*:\s*"([^"]{2,}?)"(?=\s*[,;\])]|$)/g
      content = content.replace(objRegex, (match, prop, text) => {
        if (prop === "category") return match
        const key = findKey(text, textToKey)
        if (key) { modified = true; return `${prop}: t("${key}")` }
        return match
      })

      if (modified) {
        if (!content.includes('import { t } from "@/i18n"')) {
          content = `import { t } from "@/i18n"\n${content}`
        }
        await Bun.file(file).write(content)
        process.stdout.write(`Auto-patched: ${relPath}\n`)
      }
    }
  }
}

function findKey(text: string, map: Record<string, string>): string | undefined {
  const lower = text.toLowerCase().trim()
  if (map[lower]) return map[lower]

  const snaked = lower.replace(/\s+/g, "_").replace(/[^\w]/g, "")
  if (map[snaked]) return map[snaked]

  return undefined
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

type PatchOptions = {
  ROOT: string
  dict: Record<string, string>
}

async function patchFile(filePath: string, patcher: (content: string) => string | null) {
  if (!fs.existsSync(filePath)) {
    process.stdout.write(`Skipping (not found): ${path.relative(WORK, filePath)}\n`)
    return
  }
  const content = await Bun.file(filePath).text()
  const result = patcher(content)
  if (result !== null && result !== content) {
    await Bun.file(filePath).write(result)
    process.stdout.write(`Patched: ${path.relative(path.join(WORK, "source"), filePath)}\n`)
  }
}

void main()
