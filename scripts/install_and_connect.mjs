#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, required, resolveMainAgent, writeConnectionConfig } from './lib.mjs'
import { runOnboard } from './onboard.mjs'

const args = parseArgs()
const connectCode = required(arg(args, ['connect-code', 'connectCode'], process.env.KAIGONGBA_CONNECT_CODE), '--connect-code')
const apiBaseUrl = String(arg(args, ['api-base-url', 'apiBaseUrl'], process.env.KAIGONGBA_API_BASE_URL || 'http://127.0.0.1:3100')).replace(/\/+$/, '')

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const installDir = path.resolve(String(arg(args, ['install-dir', 'installDir'], path.join(codexHome, 'skills', 'kaigongba-agent-connect'))))

async function installSkill(sourceDir, targetDir) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return
  const preservedRuntimeDir = path.join(os.tmpdir(), `kaigongba-agent-connect-runtime-${process.pid}`)
  const runtimeDir = path.join(targetDir, '.kaigongba')
  let preservedRuntime = false
  try {
    await fs.rm(preservedRuntimeDir, { recursive: true, force: true })
    await fs.cp(runtimeDir, preservedRuntimeDir, { recursive: true })
    preservedRuntime = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true })
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (sourcePath) => {
      const name = path.basename(sourcePath)
      return !['.git', '.kaigongba', 'node_modules'].includes(name)
    },
  })
  if (preservedRuntime) {
    await fs.cp(preservedRuntimeDir, runtimeDir, { recursive: true, force: true })
    await fs.rm(preservedRuntimeDir, { recursive: true, force: true })
  }
}

await installSkill(packageRoot, installDir)

process.env.KAIGONGBA_CONNECTION_CONFIG = path.join(installDir, '.kaigongba/connection.json')
const agent = resolveMainAgent(args, await readConnectionConfig())

const connectResult = await apiRequest(`${apiBaseUrl}/api/agent-connect/token`, {
  method: 'POST',
  body: JSON.stringify({ connectCode, agent }),
})

const config = {
  apiBaseUrl: connectResult.apiBaseUrl || apiBaseUrl,
  connectionId: connectResult.connectionId,
  agentToken: connectResult.agentToken,
  scopes: connectResult.scopes || [],
  expiresAt: connectResult.expiresAt,
  mainAgent: agent,
}
const configPath = await writeConnectionConfig(config)
const shouldOnboard = arg(args, 'onboard') === true

const result = {
  ok: true,
  installed: true,
  installDir,
  configPath,
  apiBaseUrl: config.apiBaseUrl,
  connectionId: config.connectionId,
  scopes: config.scopes,
  expiresAt: config.expiresAt,
}

if (shouldOnboard) {
  const onboardResult = await runOnboard({
    ...args,
    'manifest-file': path.join(installDir, 'capabilities-manifest.json'),
    'discovery-file': path.join(installDir, 'discovery.json'),
  })
  process.stdout.write(`${JSON.stringify({ ...result, onboard: onboardResult }, null, 2)}\n`)
  if (onboardResult.reviewUrl) {
    process.stdout.write(`\nOpen ${onboardResult.reviewUrl} to review and upload this Agent service.\n`)
  }
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        ...result,
        nextCommand: `cd ${installDir} && node scripts/onboard.mjs`,
      },
      null,
      2,
    )}\n`,
  )
}
