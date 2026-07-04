#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runWorkItem } from './run_work_item.mjs'
import { runRuntimeTick } from './runtime_tick.mjs'
import { apiBase, arg, numberArg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'

const EXECUTABLE_WORK_ITEM_STATUSES = new Set(['queued', 'revision_requested', 'revising', 'claimed', 'running'])
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_EXECUTOR_KILL_GRACE_MS = 5000

function defaultOutputDir() {
  return path.resolve(process.cwd(), '.kaigongba/runtime')
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

function positiveNumberArg(value, fallback) {
  const parsed = numberArg(value, fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionalPositiveNumberArg(value) {
  const parsed = numberArg(value, undefined)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function sleep(ms) {
  if (!ms) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isExecutableWorkItem(workItem = {}) {
  return EXECUTABLE_WORK_ITEM_STATUSES.has(compact(workItem.status))
}

function summarizeTick(tick = {}) {
  const pendingWorkItems = Array.isArray(tick.pendingWorkItems) ? tick.pendingWorkItems : []
  const pendingRuns = Array.isArray(tick.pendingRuns) ? tick.pendingRuns : []
  return {
    pendingRunCount: pendingRuns.length,
    pendingWorkItemCount: pendingWorkItems.length,
    executableWorkItemCount: pendingWorkItems.filter(isExecutableWorkItem).length,
    firstWorkItemId: pendingWorkItems[0]?.id ?? null,
  }
}

function summarizeRun(run = {}) {
  return {
    ok: Boolean(run.ok),
    workItemId: run.workItem?.id ?? null,
    orderId: run.workItem?.orderId ?? null,
    eventCount: Array.isArray(run.events) ? run.events.length : 0,
    artifactCount: Array.isArray(run.artifacts) ? run.artifacts.length : 0,
    error: run.error ?? null,
  }
}

async function writeWorkerStatus(statusFile, state) {
  const snapshot = {
    ok: state.failures === 0,
    pid: process.pid,
    apiBaseUrl: state.apiBaseUrl,
    connectionId: state.connectionId || null,
    outputDir: state.outputDir,
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
    iterations: state.iterations,
    runs: state.runs,
    idlePolls: state.idlePolls,
    failures: state.failures,
    lastTick: state.lastTick,
    lastRun: state.lastRun,
    lastError: state.lastError,
  }
  await writeJson(statusFile, snapshot)
  return snapshot
}

function resolvedArgs(args = {}, config = {}) {
  const outputDir = path.resolve(String(arg(args, ['output-dir', 'outputDir'], defaultOutputDir())))
  const connectionId = compact(arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId))
  const executorCommand = compact(arg(args, ['executor-command', 'executorCommand'], process.env.KAIGONGBA_EXECUTOR_COMMAND))
  return {
    outputDir,
    connectionId,
    executorCommand,
    statusFile: path.resolve(String(arg(args, ['status-file', 'statusFile'], path.join(outputDir, 'worker-status.json')))),
    pollIntervalMs: positiveNumberArg(arg(args, ['poll-interval-ms', 'pollIntervalMs'], process.env.KAIGONGBA_WORKER_POLL_INTERVAL_MS), 5000),
    errorIntervalMs: positiveNumberArg(arg(args, ['error-interval-ms', 'errorIntervalMs'], process.env.KAIGONGBA_WORKER_ERROR_INTERVAL_MS), 15000),
    timeoutMs: positiveNumberArg(arg(args, ['timeout-ms', 'timeoutMs'], process.env.KAIGONGBA_EXECUTOR_TIMEOUT_MS), DEFAULT_EXECUTOR_TIMEOUT_MS),
    executorKillGraceMs: positiveNumberArg(
      arg(args, ['executor-kill-grace-ms', 'executorKillGraceMs'], process.env.KAIGONGBA_EXECUTOR_KILL_GRACE_MS),
      DEFAULT_EXECUTOR_KILL_GRACE_MS,
    ),
    maxIterations: optionalPositiveNumberArg(arg(args, ['max-iterations', 'maxIterations'], undefined)),
    maxRuns: optionalPositiveNumberArg(arg(args, ['max-runs', 'maxRuns'], undefined)),
    once: boolArg(arg(args, 'once', false), false),
  }
}

export async function runWorkerDaemon(args = {}, deps = {}) {
  const config = await readConnectionConfig()
  const options = resolvedArgs(args, config)
  const fixedConnectionId = compact(arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID))
  if (!options.connectionId) throw new Error('Pass --connection-id or configure .kaigongba/connection.json before starting worker_daemon.mjs')
  if (!options.executorCommand) throw new Error('KAIGONGBA_EXECUTOR_COMMAND or --executor-command is required')

  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY
  const maxRuns = options.maxRuns ?? Number.POSITIVE_INFINITY
  const shouldStop = typeof deps.shouldStop === 'function' ? deps.shouldStop : () => false
  const sleepImpl = typeof deps.sleep === 'function' ? deps.sleep : sleep
  const state = {
    apiBaseUrl: apiBase(config),
    connectionId: options.connectionId,
    outputDir: options.outputDir,
    startedAt: new Date().toISOString(),
    iterations: 0,
    runs: 0,
    idlePolls: 0,
    failures: 0,
    lastTick: null,
    lastRun: null,
    lastError: null,
  }
  await writeWorkerStatus(options.statusFile, state)

  while (!shouldStop() && state.iterations < maxIterations && state.runs < maxRuns) {
    state.iterations += 1
    try {
      const loopConfig = fixedConnectionId ? config : await readConnectionConfig()
      const connectionId = fixedConnectionId || compact(loopConfig.connectionId)
      if (!connectionId) throw new Error('No connectionId found in current worker config')
      state.apiBaseUrl = apiBase(loopConfig)
      state.connectionId = connectionId
      const tick = await runRuntimeTick({ ...args, outputDir: options.outputDir, connectionId })
      state.lastTick = summarizeTick(tick)
      state.lastError = null
      if (state.lastTick.executableWorkItemCount === 0) {
        state.idlePolls += 1
        await writeWorkerStatus(options.statusFile, state)
        if (options.once || state.iterations >= maxIterations || state.runs >= maxRuns || shouldStop()) break
        await sleepImpl(options.pollIntervalMs)
        continue
      }

      const run = await runWorkItem({
        ...args,
        outputDir: options.outputDir,
        connectionId,
        executorCommand: options.executorCommand,
        timeoutMs: options.timeoutMs,
        executorKillGraceMs: options.executorKillGraceMs,
      })
      state.runs += 1
      state.lastRun = summarizeRun(run)
      if (!run.ok) {
        state.failures += 1
        state.lastError = run.error || 'work_item_failed'
      }
      await writeWorkerStatus(options.statusFile, state)
      if (options.once || state.iterations >= maxIterations || state.runs >= maxRuns || shouldStop()) break
      await sleepImpl(run.ok ? 0 : options.errorIntervalMs)
    } catch (error) {
      state.failures += 1
      state.lastError = error instanceof Error ? error.message : String(error)
      await writeWorkerStatus(options.statusFile, state)
      if (options.once || state.iterations >= maxIterations || state.runs >= maxRuns || shouldStop()) break
      await sleepImpl(options.errorIntervalMs)
    }
  }

  const finalStatus = await writeWorkerStatus(options.statusFile, state)
  return finalStatus
}

async function main() {
  const args = parseArgs()
  let stopped = false
  process.once('SIGINT', () => {
    stopped = true
  })
  process.once('SIGTERM', () => {
    stopped = true
  })
  const result = await runWorkerDaemon(args, { shouldStop: () => stopped })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.failures > 0 && (args['max-iterations'] || args.maxIterations || args['max-runs'] || args.maxRuns || args.once)) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
