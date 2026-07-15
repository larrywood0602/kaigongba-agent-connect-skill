#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function integrityFilesFromPackage(pkg = {}) {
  const explicitFiles = Array.isArray(pkg.files) ? pkg.files : []
  return [...new Set([
    'package.json',
    ...explicitFiles.filter((file) => (
      typeof file === 'string'
      && file.length > 0
      && file !== 'manifest.json'
      && !file.endsWith('/')
    )),
  ])]
}

async function sha256File(relativePath) {
  const bytes = await fs.readFile(path.join(SKILL_DIR, relativePath))
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export async function buildManifest() {
  const pkg = JSON.parse(await fs.readFile(path.join(SKILL_DIR, 'package.json'), 'utf8'))
  const files = {}
  files['manifest.json'] = { required: true }
  for (const file of integrityFilesFromPackage(pkg)) {
    files[file] = {
      required: true,
      sha256: await sha256File(file),
    }
  }
  return {
    name: 'kaigongba-agent-connect',
    version: pkg.version,
    kind: 'skill_package',
    distribution: {
      preferred: 'github_npx',
      installEntrypoint: 'node scripts/install_and_connect.mjs',
      updateCheck: 'node scripts/update_skill.mjs --check',
      update: 'node scripts/update_skill.mjs --update',
      repair: 'node scripts/update_skill.mjs --fill-missing',
      verify: 'node scripts/validate_skill.mjs',
      generatedCapabilityManifest: 'capabilities-manifest.json',
      generatedDiscovery: 'discovery.json',
      preserve: [
        '.kaigongba/',
        'discovery.json',
        'capabilities-manifest.json',
      ],
      github: 'https://github.com/larrywood0602/kaigongba-agent-connect-skill',
      rawBaseUrl: 'https://raw.githubusercontent.com/larrywood0602/kaigongba-agent-connect-skill/main/',
    },
    runtime: {
      node: '>=20',
    },
    files,
  }
}

export async function refreshManifest() {
  const manifest = await buildManifest()
  const manifestPath = path.join(SKILL_DIR, 'manifest.json')
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function main() {
  const manifest = await refreshManifest()
  process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, files: Object.keys(manifest.files).length }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
