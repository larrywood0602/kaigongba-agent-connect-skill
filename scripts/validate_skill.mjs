#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_FILES = [
  'SKILL.md',
  'README.md',
  'manifest.json',
  'package.json',
  'references/api.md',
  'references/manifest-schema.md',
  'references/event-schema.md',
  'scripts/claim_work_item.mjs',
  'scripts/discover_capabilities.mjs',
  'scripts/manifest_from_discovery.mjs',
  'scripts/sync_capabilities.mjs',
  'scripts/create_service_from_capability.mjs',
  'scripts/readiness.mjs',
  'scripts/publish_service.mjs',
  'scripts/runtime_tick.mjs',
  'scripts/action_record.mjs',
  'scripts/update_skill.mjs',
  'scripts/refresh_manifest.mjs',
  'scripts/verify_real_platform.mjs',
  'scripts/sync_event.mjs',
  'scripts/upload_artifact.mjs',
]

const PRESERVED_PATHS = ['.kaigongba/', 'discovery.json', 'capabilities-manifest.json']

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function manifestFiles(manifest) {
  if (Array.isArray(manifest.files)) {
    return Object.fromEntries(manifest.files.map((file) => [file, { required: true }]))
  }
  return manifest.files || {}
}

export async function validateSkill() {
  const errors = []
  const warnings = []
  for (const file of REQUIRED_FILES) {
    if (!(await exists(path.join(SKILL_DIR, file)))) errors.push(`missing required file: ${file}`)
  }
  const pkg = JSON.parse(await fs.readFile(path.join(SKILL_DIR, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await fs.readFile(path.join(SKILL_DIR, 'manifest.json'), 'utf8'))
  if (!pkg.bin?.['kaigongba-agent-connect-skill']) errors.push('package.json bin kaigongba-agent-connect-skill is required')
  if (pkg.version !== manifest.version) errors.push(`version mismatch: package.json=${pkg.version} manifest.json=${manifest.version}`)
  if (manifest.kind !== 'skill_package') errors.push('manifest.json kind must be skill_package')
  for (const preserved of PRESERVED_PATHS) {
    if (!manifest.distribution?.preserve?.includes(preserved)) warnings.push(`manifest distribution.preserve should include ${preserved}`)
  }

  const files = manifestFiles(manifest)
  for (const file of REQUIRED_FILES) {
    if (!files[file]) errors.push(`manifest missing required package file entry: ${file}`)
  }
  for (const [file, meta] of Object.entries(files)) {
    if (file.includes('.kaigongba') || file === 'discovery.json' || file === 'capabilities-manifest.json') {
      errors.push(`manifest must not distribute runtime/generated file: ${file}`)
      continue
    }
    const fullPath = path.join(SKILL_DIR, file)
    if (!(await exists(fullPath))) {
      if (meta?.required !== false) errors.push(`manifest file missing: ${file}`)
      continue
    }
    if (meta?.sha256) {
      const actual = await sha256File(fullPath)
      if (actual !== meta.sha256) errors.push(`sha256 mismatch for ${file}: expected=${meta.sha256} actual=${actual}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checked: { requiredFiles: REQUIRED_FILES.length, manifestFiles: Object.keys(files).length, skillDir: SKILL_DIR },
  }
}

async function main() {
  const result = await validateSkill()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
