#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { arg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'
import { runWorkerDaemon } from './worker_daemon.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

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

function isProcessRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopExisting(pidFile) {
  const pid = await readPid(pidFile)
  if (!pid || !isProcessRunning(pid)) return { stopped: false, pid }
  process.kill(pid, 'SIGTERM')
  return { stopped: true, pid }
}

export async function startWorker(args = {}) {
  const config = await readConnectionConfig()
  const executorCommand = compact(arg(args, ['executor-command', 'executorCommand'], process.env.KAIGONGBA_EXECUTOR_COMMAND))
  if (!executorCommand) throw new Error('Pass --executor-command or set KAIGONGBA_EXECUTOR_COMMAND to the external Agent runner')
  if (!compact(config.connectionId)) throw new Error('No connectionId found. Run install_and_connect.mjs or bootstrap_connection.mjs first.')

  const outputDir = path.resolve(String(arg(args, ['output-dir', 'outputDir'], process.env.KAIGONGBA_WORKER_OUTPUT_DIR || defaultOutputDir())))
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
    const result = await runWorkerDaemon({ ...args, outputDir, statusFile, executorCommand })
    return { ...result, foreground: true, pidFile, statusFile }
  }

  const workerScript = path.join(SCRIPT_DIR, 'worker_daemon.mjs')
  const child = spawn(process.execPath, [workerScript, '--output-dir', outputDir, '--status-file', statusFile], {
    cwd: SKILL_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      KAIGONGBA_EXECUTOR_COMMAND: executorCommand,
      KAIGONGBA_CONNECTION_CONFIG: process.env.KAIGONGBA_CONNECTION_CONFIG || path.join(SKILL_DIR, '.kaigongba/connection.json'),
    },
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
