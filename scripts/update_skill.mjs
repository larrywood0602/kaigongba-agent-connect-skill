#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { arg, parseArgs } from './lib.mjs'

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RAW_BASE_URL = 'https://raw.githubusercontent.com/larrywood0602/kaigongba-agent-connect-skill/main/'
const PRESERVED_PREFIXES = ['.kaigongba/', 'discovery.json', 'capabilities-manifest.json']

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function rawBase(args, localManifest = {}) {
  return String(arg(args, ['base-url', 'baseUrl'], localManifest.distribution?.rawBaseUrl || DEFAULT_RAW_BASE_URL)).replace(/\/?$/, '/')
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  return response.json()
}

async function fetchBytes(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function compareVersion(a, b) {
  const left = String(a || '0').split('.').map((item) => Number(item) || 0)
  const right = String(b || '0').split('.').map((item) => Number(item) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function shouldPreserve(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  return PRESERVED_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix))
}

async function writeRemoteFile(relativePath, bytes, expectedHash) {
  if (shouldPreserve(relativePath)) throw new Error(`refuse to overwrite preserved file: ${relativePath}`)
  const actualHash = sha256(bytes)
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`sha256 mismatch for ${relativePath}: expected=${expectedHash} actual=${actualHash}`)
  }
  const destination = path.join(SKILL_DIR, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const tmp = `${destination}.tmp`
  await fs.writeFile(tmp, bytes)
  await fs.rename(tmp, destination)
}

async function remoteManifest(args, localManifest) {
  const manifestUrl = String(arg(args, ['manifest-url', 'manifestUrl'], new URL('manifest.json', rawBase(args, localManifest)).toString()))
  return fetchJson(manifestUrl)
}

async function check(args) {
  const localManifest = await readJsonIfExists(path.join(SKILL_DIR, 'manifest.json')) || {}
  const remote = await remoteManifest(args, localManifest)
  const status = compareVersion(remote.version, localManifest.version) > 0 ? 'update_available' : 'up_to_date'
  return { ok: true, status, localVersion: localManifest.version || null, remoteVersion: remote.version || null }
}

async function update(args, { fillMissingOnly = false } = {}) {
  const localManifest = await readJsonIfExists(path.join(SKILL_DIR, 'manifest.json')) || {}
  const remote = await remoteManifest(args, localManifest)
  const baseUrl = rawBase(args, localManifest)
  const updated = []
  const skipped = []
  const failed = []

  for (const [relativePath, meta] of Object.entries(remote.files || {})) {
    try {
      if (shouldPreserve(relativePath)) {
        skipped.push({ file: relativePath, reason: 'preserved' })
        continue
      }
      const destination = path.join(SKILL_DIR, relativePath)
      if (fillMissingOnly) {
        try {
          await fs.access(destination)
          skipped.push({ file: relativePath, reason: 'exists' })
          continue
        } catch {
          // Fill missing file below.
        }
      }
      const bytes = await fetchBytes(new URL(relativePath, baseUrl).toString())
      await writeRemoteFile(relativePath, bytes, meta?.sha256)
      updated.push(relativePath)
    } catch (error) {
      failed.push({ file: relativePath, error: error.message })
    }
  }

  if (!fillMissingOnly) {
    await writeRemoteFile('manifest.json', Buffer.from(`${JSON.stringify(remote, null, 2)}\n`, 'utf8'), null)
    updated.push('manifest.json')
  }

  return {
    ok: failed.length === 0,
    status: failed.length === 0 ? (fillMissingOnly ? 'filled_missing' : 'updated') : 'partial_failure',
    localVersion: localManifest.version || null,
    remoteVersion: remote.version || null,
    updated,
    skipped,
    failed,
    preserved: PRESERVED_PREFIXES,
  }
}

async function main() {
  const args = parseArgs()
  let result
  if (arg(args, 'check') === true) result = await check(args)
  else if (arg(args, 'fill-missing') === true || arg(args, 'fillMissing') === true) result = await update(args, { fillMissingOnly: true })
  else if (arg(args, 'update') === true) result = await update(args)
  else result = { ok: false, status: 'usage', message: 'Use --check, --update, or --fill-missing.' }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
