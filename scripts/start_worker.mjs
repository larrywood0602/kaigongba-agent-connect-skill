#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { forbiddenExecutorEnvironmentName, forbiddenPlatformCredentialEnvironmentName, safeEnvironmentAdditions } from './environment_security.mjs'
import { arg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'
import { runWorkerDaemon } from './worker_daemon.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')
const BASE_WORKER_ENV_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'CODEX_HOME', 'CODEX_EXECUTABLE', 'CODEX_MODEL', 'CODEX_EXEC_ARGS', 'INIT_CWD',
  'KAIGONGBA_EXECUTOR_ENV_ALLOWLIST',
  'KAIGONGBA_WORKER_POLL_INTERVAL_MS', 'KAIGONGBA_WORKER_ERROR_INTERVAL_MS',
  'KAIGONGBA_EXECUTOR_TIMEOUT_MS', 'KAIGONGBA_EXECUTOR_IDLE_TIMEOUT_MS',
  'KAIGONGBA_EXECUTOR_KILL_GRACE_MS', 'KAIGONGBA_EXECUTOR_JSONL',
  'KAIGONGBA_CALLBACK_REQUEST_TIMEOUT_MS', 'KAIGONGBA_WORK_ITEM_LEASE_RENEW_INTERVAL_MS',
  'KAIGONGBA_PROGRESS_HEARTBEAT_INTERVAL_MS', 'KAIGONGBA_CODEX_OUTPUT_DIR',
  'KAIGONGBA_ACTIVITY_POLL_INTERVAL_MS', 'KAIGONGBA_ARTIFACT_STABLE_WINDOW_MS',
  'KAIGONGBA_ARTIFACT_STABLE_POLL_INTERVAL_MS', 'KAIGONGBA_AGENT_SOURCE_DIR',
  'KAIGONGBA_ARTIFACT_REQUEST_TIMEOUT_MS', 'KAIGONGBA_ARTIFACT_RETRY_DELAYS_MS',
]
const FOREGROUND_STALE_CONNECTION_NAMES = ['KAIGONGBA_CONNECTION_ID', 'KAIGONGBA_API_BASE_URL']

function defaultOutputDir() {
  return path.resolve(SKILL_DIR, '.kaigongba/runtime')
}

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true) return true
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase())
}

export function workerProcessEnvironment(source = process.env, additions = {}) {
  const names = new Set(BASE_WORKER_ENV_NAMES)
  for (const name of Object.keys(source)) {
    if (/^LC_[A-Za-z0-9_]+$/.test(name)) names.add(name)
  }
  for (const name of String(source.KAIGONGBA_EXECUTOR_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !forbiddenExecutorEnvironmentName(name)) names.add(name)
  }
  const env = {}
  for (const name of names) {
    if (source[name] !== undefined && !forbiddenExecutorEnvironmentName(name)) env[name] = source[name]
  }
  return { ...env, ...safeEnvironmentAdditions(additions) }
}

async function withoutForegroundPlatformCredentials(callback) {
  const names = new Set([
    ...Object.keys(process.env).filter(forbiddenPlatformCredentialEnvironmentName),
    ...FOREGROUND_STALE_CONNECTION_NAMES,
  ])
  const previous = new Map(
    [...names].map((name) => [name, {
      existed: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    }]),
  )
  for (const name of names) delete process.env[name]
  try {
    return await callback()
  } finally {
    for (const [name, state] of previous) {
      if (state.existed) process.env[name] = state.value
      else delete process.env[name]
    }
  }
}

async function readPid(pidFile) {
  try {
    const raw = await fs.readFile(pidFile, 'utf8')
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function isProcessRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

export async function stopExisting(pidFile, options = {}) {
  const pid = await readPid(pidFile)
  if (!pid || !isProcessRunning(pid)) return { stopped: false, pid }
  process.kill(pid, 'SIGTERM')
  if (await waitForExit(pid, options.timeoutMs ?? 5000)) return { stopped: true, pid, exited: true, signal: 'SIGTERM' }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return { stopped: true, pid, exited: true, signal: 'SIGTERM' }
  }
  return { stopped: true, pid, exited: await waitForExit(pid, options.killTimeoutMs ?? 2000), signal: 'SIGKILL', forced: true }
}

function appendOption(argv, args, names, flagName) {
  const value = arg(args, names, undefined)
  if (value === undefined || value === null || value === '' || value === false) return
  argv.push(`--${flagName}`)
  if (value !== true) argv.push(String(value))
}

export function workerDaemonArgs(args = {}, paths = {}) {
  const workerScript = path.join(SCRIPT_DIR, 'worker_daemon.mjs')
  const explicitOutputDir = paths.outputDir || arg(args, ['output-dir', 'outputDir'], undefined)
  const outputDir = path.resolve(String(explicitOutputDir || defaultOutputDir()))
  const statusFile = path.resolve(String(paths.statusFile || arg(args, ['status-file', 'statusFile'], path.join(outputDir, 'worker-status.json'))))
  const argv = [workerScript, '--output-dir', outputDir, '--status-file', statusFile]
  appendOption(argv, args, ['connection-id', 'connectionId'], 'connection-id')
  appendOption(argv, args, ['worker-id', 'workerId'], 'worker-id')
  appendOption(argv, args, ['timeout-ms', 'timeoutMs'], 'timeout-ms')
  appendOption(argv, args, ['executor-kill-grace-ms', 'executorKillGraceMs'], 'executor-kill-grace-ms')
  appendOption(argv, args, ['poll-interval-ms', 'pollIntervalMs'], 'poll-interval-ms')
  appendOption(argv, args, ['error-interval-ms', 'errorIntervalMs'], 'error-interval-ms')
  appendOption(argv, args, ['lease-seconds', 'leaseSeconds'], 'lease-seconds')
  appendOption(argv, args, ['lease-renew-interval-ms', 'leaseRenewIntervalMs'], 'lease-renew-interval-ms')
  appendOption(argv, args, ['max-iterations', 'maxIterations'], 'max-iterations')
  appendOption(argv, args, ['max-runs', 'maxRuns'], 'max-runs')
  appendOption(argv, args, 'once', 'once')
  return argv
}

export async function startWorker(args = {}) {
  const config = await readConnectionConfig()
  const executorCommand = compact(arg(args, ['executor-command', 'executorCommand'], process.env.KAIGONGBA_EXECUTOR_COMMAND))
  if (!executorCommand) throw new Error('Pass --executor-command or set KAIGONGBA_EXECUTOR_COMMAND to the external Agent runner')
  if (!compact(config.connectionId)) throw new Error('No connectionId found. Run install_and_connect.mjs or bootstrap_connection.mjs first.')

  const explicitOutputDir = arg(args, ['output-dir', 'outputDir'], process.env.KAIGONGBA_WORKER_OUTPUT_DIR)
  const outputDir = path.resolve(String(explicitOutputDir || defaultOutputDir()))
  const pidFile = path.resolve(String(arg(args, ['pid-file', 'pidFile'], path.join(outputDir, 'worker.pid'))))
  const statusFile = path.resolve(String(arg(args, ['status-file', 'statusFile'], path.join(outputDir, 'worker-status.json'))))
  const foreground = boolArg(arg(args, 'foreground', false), false)
  const restart = boolArg(arg(args, 'restart', false), false)
  await fs.mkdir(outputDir, { recursive: true })

  if (restart) await stopExisting(pidFile)
  const existingPid = await readPid(pidFile)
  if (existingPid && isProcessRunning(existingPid)) {
    return {
      ok: true,
      alreadyRunning: true,
      pid: existingPid,
      connectionId: config.connectionId,
      outputDir,
      pidFile,
      statusFile,
    }
  }

  if (foreground) {
    const result = await withoutForegroundPlatformCredentials(
      () => runWorkerDaemon({ ...args, outputDir, statusFile, executorCommand }),
    )
    return { ...result, foreground: true, pidFile, statusFile }
  }

  const daemonArgs = workerDaemonArgs(args, { outputDir, statusFile })
  const child = spawn(process.execPath, daemonArgs, {
    cwd: SKILL_DIR,
    detached: true,
    stdio: 'ignore',
    env: workerProcessEnvironment(process.env, {
      KAIGONGBA_EXECUTOR_COMMAND: executorCommand,
      KAIGONGBA_CONNECTION_CONFIG: process.env.KAIGONGBA_CONNECTION_CONFIG || path.join(SKILL_DIR, '.kaigongba/connection.json'),
    }),
  })
  child.unref()
  await fs.writeFile(pidFile, `${child.pid}\n`, 'utf8')
  const result = {
    ok: true,
    started: true,
    pid: child.pid,
    connectionId: config.connectionId,
    outputDir,
    pidFile,
    statusFile,
    executorCommand,
    daemonArgs,
  }
  await writeJson(path.join(outputDir, 'worker-start.json'), result)
  return result
}

async function main() {
  const result = await startWorker(parseArgs())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
