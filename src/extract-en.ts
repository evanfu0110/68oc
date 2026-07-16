#!/usr/bin/env bun
import fs from "fs"
import path from "path"

const DIRS = ["packages/tui/src", "packages/opencode/src/cli", "packages/opencode/src/command"]

const SKIP_PATTERNS = [
  /node_modules/, /\.test\./, /\.spec\./, /i18n/,
  /^\d/, /^[a-z][a-z0-9]*$/, /^https?:\/\//, /^[,.!?;:\-]$/,
  /^[<>\[\]{}()]$/, /^(ctrl|alt|shift|meta)\+/, /^\\/,
]

function walkDir(dir: string, acc: string[]) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") walkDir(full, acc)
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      acc.push(full)
    }
  }
}

function isSkip(text: string): boolean {
  if (text.length < 3) return true
  if (/[^\x20-\x7E]/.test(text)) return true
  if (SKIP_PATTERNS.some((p) => p.test(text))) return true
  return false
}

function extractStrings() {
  const cwd = process.argv[2] || "."
  const sourceDir = path.resolve(cwd)
  const files: string[] = []

  for (const dir of DIRS) {
    walkDir(path.join(sourceDir, dir.replace(/\//g, path.sep)), files)
  }

  const results: { file: string; line: number; text: string }[] = []

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8")
    const lines = content.split("\n")
    const relPath = path.relative(sourceDir, file).replaceAll("\\", "/")

    if (content.includes('t("tui.') || content.includes("t('tui.")) continue

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      const patterns = [
        /describe:\s*"([^"]+)"(?!=)/g,
        /title:\s*"([^"]+)"(?!=)/g,
        /label:\s*"([^"]+)"(?!=)/g,
        /placeholder:\s*"([^"]+)"(?!=)/g,
        /message:\s*"([^"]+)"(?!=)/g,
        /category:\s*"([^"]+)"(?=\s*[,)\]])/g,
      ]

      for (const regex of patterns) {
        for (const match of line.matchAll(regex)) {
          const text = match[1].trim()
          if (!isSkip(text)) {
            results.push({ file: relPath, line: i + 1, text })
          }
        }
      }
    }
  }

  return results
}

function main() {
  const results = extractStrings()
  const dictPath = path.resolve(import.meta.dirname, "zh-CN.json")
  const dict: Record<string, string> = fs.existsSync(dictPath)
    ? JSON.parse(fs.readFileSync(dictPath, "utf8"))
    : {}

  // Build key -> English reverse map
  const keyToEn: Record<string, string> = {}
  for (const key of Object.keys(dict)) {
    const parts = key.split(".")
    const last = parts[parts.length - 1]
    keyToEn[key] = last.replace(/_/g, " ")
  }

  // Find untranslated strings
  const translated = new Set(Object.values(keyToEn).map((s) => s.toLowerCase()))
  const untranslated = results.filter((r) => !translated.has(r.text.toLowerCase()))

  process.stdout.write(`\n=== Scan Report ===\n`)
  process.stdout.write(`Total hardcoded strings found: ${results.length}\n`)
  process.stdout.write(`Already translated: ${results.length - untranslated.length}\n`)
  process.stdout.write(`Untranslated: ${untranslated.length}\n\n`)

  if (untranslated.length > 0) {
    process.stdout.write(`--- Untranslated strings ---\n`)
    for (const r of untranslated) {
      const suggestedKey = `tui.${r.text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`
      process.stdout.write(`  ${r.file}:${r.line}  "${r.text}"\n    → suggested key: ${suggestedKey}\n\n`)
    }
  }

  process.stdout.write(`\nAdd these to zh-CN.json and re-run.\n`)
}

main()
