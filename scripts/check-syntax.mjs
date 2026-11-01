#!/usr/bin/env node
// Validate all shipped JavaScript without importing modules or contacting providers.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['.git', '.runtime', 'data', 'data-share', 'node_modules', 'artifacts'])
async function walk(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(filename))
    else if (entry.isFile() && /\.(m?js)$/.test(entry.name)) files.push(filename)
  }
  return files
}
const files = (await walk(root)).sort()
let failures = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    failures++
    console.error(path.relative(root, file), result.stderr || result.error?.message)
  }
}
console.log(`JavaScript syntax: ${files.length - failures}/${files.length} passed`)
process.exitCode = failures ? 1 : 0
