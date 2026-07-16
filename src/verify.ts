#!/usr/bin/env bun
import fs from "fs"
import path from "path"

const DICT = path.resolve(import.meta.dirname, "zh-CN.json")
const ENZH = path.resolve(import.meta.dirname, "en-zh-map.json")

const SKIP_DIRS = ["node_modules", "dist", ".git", "i18n"]
const SCAN_DIRS = [
  "packages/tui/src",
  "packages/opencode/src/cli",
  "packages/opencode/src/command",
  "packages/opencode/src/agent",
  "packages/opencode/src/i18n",
]

type StringEntry = {
  file: string
  line: number
  text: string
  context: string
  status: "covered" | "missing" | "partial"
  matchKey?: string
  matchType?: string
}

function walkDir(dir: string, acc: string[]) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDir(full, acc)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full)
  }
}

function scanFile(file: string, root: string): StringEntry[] {
  const content = fs.readFileSync(file, "utf8")
  const lines = content.split("\n")
  const relPath = path.relative(root, file).replaceAll("\\", "/")
  const results: StringEntry[] = []

  // Don't scan files that already use our i18n
  if (content.includes("from \"@/i18n\"") || content.includes("from '@/i18n'")) return results

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const patterns: [RegExp, string][] = [
      [/\bdescribe:\s*"(.*?)"(?=\s*[,;)\]])/g, "describe"],
      [/\bdescription:\s*"(.*?)"(?=\s*[,;)\]])/g, "description"],
      [/\btitle:\s*"(.*?)"(?=\s*[,;)\]])/g, "title"],
      [/\blabel:\s*"(.*?)"(?=\s*[,;)\]])/g, "label"],
      [/\bplaceholder:\s*"(.*?)"(?=\s*[,;)\]])/g, "placeholder"],
      [/\bmessage:\s*"(.*?)"(?=\s*[,;)\]])/g, "message"],
      [/\bsummary:\s*"(.*?)"(?=\s*[,;)\]])/g, "summary"],
      [/\bcategory:\s*"(.*?)"(?=\s*[,;)\]])/g, "category"],
      [/\bcontent:\s*"(.*?)"(?=\s*[,;)\]])/g, "content"],
      [/\bwarning:\s*"(.*?)"(?=\s*[,;)\]])/g, "warning"],
      [/UI\.println\(\s*"(.*?)"/g, "println"],
      [/UI\.error\(\s*"(.*?)"/g, "error"],
    ]

    for (const [regex, ctx] of patterns) {
      for (const match of line.matchAll(regex)) {
        const text = match[1].trim()
        if (text.length < 2) continue
        if (/^[a-z0-9_\/.]+$/.test(text) && !text.includes(" ")) continue
        if (/^https?:\/\//.test(text)) continue
        if (/^[,.!?;:\-]$/.test(text)) continue
        results.push({ file: relPath, line: i + 1, text, context: ctx, status: "missing" })
      }
    }
  }
  return results
}

function checkCoverage(
  dict: Record<string, string>,
  enzh: Record<string, string>,
  entries: StringEntry[],
): StringEntry[] {
  // Build lookup maps
  const dictTextToKey: Record<string, string> = {}
  for (const [key, zh] of Object.entries(dict)) {
    const last = key.split(".").pop()?.replace(/_/g, " ").toLowerCase() || ""
    dictTextToKey[last] = key
    dictTextToKey[zh.toLowerCase()] = key
  }

  const enzhTexts = new Set(Object.keys(enzh).map((k) => k.toLowerCase().trim()))

  for (const entry of entries) {
    const lower = entry.text.toLowerCase().trim()
    const snaked = lower.replace(/\s+/g, "_").replace(/[^\w]/g, "")

    // Check en-zh-map first
    if (enzhTexts.has(lower)) {
      entry.status = "covered"
      entry.matchType = "en-zh-map"
      continue
    }

    // Check dict by key last segment
    if (dictTextToKey[lower]) {
      entry.status = "covered"
      entry.matchKey = dictTextToKey[lower]
      entry.matchType = "dict-key"
      continue
    }

    // Check dict by snaked form
    if (dictTextToKey[snaked]) {
      entry.status = "covered"
      entry.matchKey = dictTextToKey[snaked]
      entry.matchType = "dict-snaked"
      continue
    }

    // Check dict by value (Chinese text)
    const zhMatch = Object.entries(dict).find(([, zh]) => zh.toLowerCase() === lower)
    if (zhMatch) {
      entry.status = "covered"
      entry.matchKey = zhMatch[0]
      entry.matchType = "dict-value"
      continue
    }

    entry.status = "missing"
  }
  return entries
}

function generateReport(entries: StringEntry[]) {
  const byStatus = { covered: 0, missing: 0, partial: 0 }
  const byFile: Record<string, { covered: number; missing: number; items: StringEntry[] }> = {}

  for (const e of entries) {
    byStatus[e.status]++
    if (!byFile[e.file]) byFile[e.file] = { covered: 0, missing: 0, items: [] }
    byFile[e.file][e.status]++
    byFile[e.file].items.push(e)
  }

  console.log("=".repeat(60))
  console.log("Translation Coverage Report")
  console.log("=".repeat(60))
  console.log(`Total strings found: ${entries.length}`)
  console.log(`  Covered: ${byStatus.covered}`)
  console.log(`  Missing: ${byStatus.missing}`)
  console.log(`  Coverage: ${Math.round((byStatus.covered / entries.length) * 100)}%`)
  console.log()

  if (byStatus.missing > 0) {
    console.log("-".repeat(60))
    console.log("MISSING TRANSLATIONS (by file)")
    console.log("-".repeat(60))

    const sorted = Object.entries(byFile)
      .filter(([, v]) => v.missing > 0)
      .sort((a, b) => b[1].missing - a[1].missing)

    for (const [file, info] of sorted) {
      console.log(`\n${file} (${info.missing} missing of ${info.missing + info.covered})`)
      for (const item of info.items) {
        if (item.status === "missing") {
          const suggestedKey = `tui.${item.text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/_+/g, "_")}`
          console.log(`  L${item.line} [${item.context}] "${item.text}"`)
          console.log(`    → 建议键: ${suggestedKey}`)
        }
      }
    }
  }
}

async function main() {
  const upstreamDir = process.argv[2]
  if (!upstreamDir) {
    console.error("Usage: bun src/verify.ts <path-to-upstream-opencode-source>")
    process.exit(1)
  }
  const root = path.resolve(upstreamDir)

  // Verify upstream dir exists
  if (!fs.existsSync(path.join(root, "packages/opencode"))) {
    console.error("Error: directory does not contain packages/opencode")
    process.exit(1)
  }

  const dict: Record<string, string> = JSON.parse(await Bun.file(DICT).text())
  const enzh: Record<string, string> = JSON.parse(await Bun.file(ENZH).text())

  console.log(`Dictionary: ${Object.keys(dict).length} keys`)
  console.log(`CLI EN→ZH map: ${Object.keys(enzh).length} entries`)
  console.log(`Scanning: ${SCAN_DIRS.join(", ")}`)
  console.log()

  const allEntries: StringEntry[] = []
  for (const scanDir of SCAN_DIRS) {
    const fullDir = path.join(root, scanDir.replace(/\//g, path.sep))
    if (!fs.existsSync(fullDir)) {
      console.log(`  [SKIP] ${scanDir} - not found`)
      continue
    }
    const files: string[] = []
    walkDir(fullDir, files)
    console.log(`  Scanning ${files.length} files in ${scanDir}...`)
    for (const file of files) {
      const entries = scanFile(file, root)
      allEntries.push(...entries)
    }
  }

  const result = checkCoverage(dict, enzh, allEntries)
  generateReport(result)

  // Save detailed report
  const reportPath = path.resolve(import.meta.dirname, "..", "coverage-report.json")
  await Bun.file(reportPath).write(
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        total: result.length,
        covered: result.filter((e) => e.status === "covered").length,
        missing: result.filter((e) => e.status === "missing").length,
        details: result,
      },
      null,
      2,
    ),
  )
  console.log(`\nDetailed report saved to: ${reportPath}`)
}

main()
