#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { forbiddenExecutorEnvironmentName, safeEnvironmentAdditions } from './environment_security.mjs'
import { claimWorkItem, resolveLeaseSeconds, resolveWorkerId } from './claim_work_item.mjs'
import { EXECUTOR_PROTOCOL, parseExecutorProtocolLine, sanitizePublicText } from './executor_protocol.mjs'
import { apiRequest, arg, artifactApiRequest, artifactRequestPolicy, defaultStatus, mimeFromName, numberArg, parseArgs, readConnectionConfig, redactLocalResult, uploadFileToUrl, writeJson } from './lib.mjs'
import { cleanupStableArtifactSnapshot, stableArtifactSnapshot, withVerifiedStableArtifact } from './runtime_activity.mjs'

const DEFAULT_EXECUTOR_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_EXECUTOR_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const MAX_EXECUTOR_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000
const MIN_NORMAL_IDLE_TIMEOUT_MS = 30 * 1000
const DEFAULT_EXECUTOR_KILL_GRACE_MS = 5000
const DEFAULT_PROGRESS_HEARTBEAT_INTERVAL_MS = 15 * 1000
const DEFAULT_CALLBACK_RETRY_DELAYS_MS = [100, 300, 900]
const DEFAULT_CALLBACK_REQUEST_TIMEOUT_MS = 15 * 1000
const MAX_EXECUTOR_STDOUT_LINE_BYTES = 128 * 1024
const MAX_EXECUTOR_LEGACY_BYTES = 1024 * 1024
const MAX_EXECUTOR_PROTOCOL_EVENTS = 10_000

function safeCwd(fallback = process.env.HOME || '/tmp') {
  try {
    return process.cwd()
  } catch {
    return fallback
  }
}

function defaultOutputDir() {
  return path.resolve(safeCwd(), '.kaigongba/runtime')
}

function outputDirArg(args = {}) {
  const explicit = arg(args, ['output-dir', 'outputDir'], undefined)
  return path.resolve(String(explicit || defaultOutputDir()))
}

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

function positiveMilliseconds(value, fallback) {
  const parsed = numberArg(value, fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveExecutorTimeouts({ args = {}, workItem = {}, env = process.env } = {}) {
  const execution = workItem?.payload?.execution && typeof workItem.payload.execution === 'object'
    ? workItem.payload.execution
    : {}
  const payloadMax = positiveMilliseconds(execution.maxHardTimeoutMs, MAX_EXECUTOR_HARD_TIMEOUT_MS)
  const maxHardTimeoutMs = Math.min(payloadMax, MAX_EXECUTOR_HARD_TIMEOUT_MS)
  const cliHard = arg(args, ['timeout-ms', 'timeoutMs'], undefined)
  const cliIdle = arg(args, ['idle-timeout-ms', 'idleTimeoutMs'], undefined)
  const envHard = env.KAIGONGBA_EXECUTOR_TIMEOUT_MS
  const envIdle = env.KAIGONGBA_EXECUTOR_IDLE_TIMEOUT_MS
  const hasCli = cliHard !== undefined || cliIdle !== undefined
  const hasEnv = envHard !== undefined || envIdle !== undefined
  const hasWorkItem = (
    execution.hardTimeoutMs !== undefined
    || execution.idleTimeoutMs !== undefined
    || execution.maxHardTimeoutMs !== undefined
  )

  const payloadHard = positiveMilliseconds(execution.hardTimeoutMs, DEFAULT_EXECUTOR_HARD_TIMEOUT_MS)
  const payloadIdle = positiveMilliseconds(execution.idleTimeoutMs, DEFAULT_EXECUTOR_IDLE_TIMEOUT_MS)
  const requestedHard = cliHard !== undefined
    ? positiveMilliseconds(cliHard, payloadHard)
    : envHard !== undefined
      ? positiveMilliseconds(envHard, payloadHard)
      : payloadHard
  const requestedIdle = cliIdle !== undefined
    ? positiveMilliseconds(cliIdle, payloadIdle)
    : envIdle !== undefined
      ? positiveMilliseconds(envIdle, payloadIdle)
      : payloadIdle
  const hardTimeoutMs = Math.max(2, Math.min(requestedHard, maxHardTimeoutMs))
  const idleFloor = cliIdle !== undefined ? 1 : MIN_NORMAL_IDLE_TIMEOUT_MS
  const idleTimeoutMs = Math.min(Math.max(idleFloor, requestedIdle), maxHardTimeoutMs, hardTimeoutMs - 1)

  return {
    hardTimeoutMs,
    idleTimeoutMs,
    maxHardTimeoutMs,
    source: hasCli ? 'cli' : hasEnv ? 'env' : hasWorkItem ? 'work_item' : 'default',
  }
}

function callbackContext(workItem, config = {}) {
  const callback = workItem?.payload?.callback && typeof workItem.payload.callback === 'object' ? workItem.payload.callback : {}
  return {
    runId: callback.runId || workItem.orderId,
    connectionId: callback.connectionId || workItem.connectionId || config.connectionId,
    serviceSopId: callback.serviceSopId || workItem.serviceSopId || config.serviceSopId,
    nodeKey: callback.nodeKey || workItem.nodeKey,
    baseIdempotencyKey: workItem?.payload?.idempotencyKey || workItem.id,
  }
}

function cleanPayload(payload) {
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === true || payload[key] === '') delete payload[key]
  }
  return payload
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function boundedLineStream(onLimit) {
  let currentLineBytes = 0
  let limited = false
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (limited) {
        callback()
        return
      }
      for (const byte of chunk) {
        if (byte === 0x0A) {
          currentLineBytes = 0
          continue
        }
        currentLineBytes += 1
        if (currentLineBytes > MAX_EXECUTOR_STDOUT_LINE_BYTES) {
          limited = true
          onLimit()
          callback()
          return
        }
      }
      callback(null, chunk)
    },
  })
}

function callbackRetryDelays(args = {}) {
  const value = arg(args, ['callback-retry-delays-ms', 'callbackRetryDelaysMs'], undefined)
  if (value === undefined) return DEFAULT_CALLBACK_RETRY_DELAYS_MS
  const values = Array.isArray(value) ? value : String(value).split(',')
  return values.map((item) => Math.max(0, numberArg(item, 0)))
}

function callbackRequestTimeoutMs(args = {}) {
  return Math.max(1, numberArg(
    arg(args, ['callback-request-timeout-ms', 'callbackRequestTimeoutMs'], process.env.KAIGONGBA_CALLBACK_REQUEST_TIMEOUT_MS),
    DEFAULT_CALLBACK_REQUEST_TIMEOUT_MS,
  ))
}

function pendingEventFile(outputDir, payload) {
  const sequence = Math.max(0, Math.floor(numberArg(payload.sequence, 0)))
  const digest = createHash('sha256')
    .update(`${payload.idempotencyKey || ''}:${sequence}`)
    .digest('hex')
    .slice(0, 24)
  return path.join(outputDir, 'pending-events', `${String(sequence).padStart(12, '0')}-${digest}.json`)
}

async function writePendingEventAtomically(file, record) {
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryFile = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temporaryFile, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryFile, file)
    await fs.chmod(file, 0o600)
    let directoryHandle
    try {
      directoryHandle = await fs.open(directory, 'r')
      await directoryHandle.sync()
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error
    } finally {
      await directoryHandle?.close().catch(() => undefined)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporaryFile).catch(() => undefined)
    throw error
  }
}

function isPermanentCallbackError(error) {
  return error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
}

async function movePendingToDeadLetter(file, outputDir) {
  const deadLetterDir = path.join(outputDir, 'dead-letter-events')
  await fs.mkdir(deadLetterDir, { recursive: true, mode: 0o700 })
  const destination = path.join(deadLetterDir, path.basename(file))
  await fs.rename(file, destination)
  await fs.chmod(destination, 0o600)
  return destination
}

async function callbackApiRequest(apiPath, body, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await apiRequest(apiPath, { method: 'POST', body, signal: controller.signal })
  } catch (error) {
    if (!timedOut) throw error
    const timeoutError = new Error(`Platform callback exceeded ${timeoutMs}ms`)
    timeoutError.code = 'callback_request_timeout'
    throw timeoutError
  } finally {
    clearTimeout(timer)
  }
}

async function sendPendingEvent(record, file, options) {
  const body = JSON.stringify(record.payload)
  let lastError
  for (let attempt = 0; attempt <= options.retryDelays.length; attempt += 1) {
    if (attempt > 0) await delay(options.retryDelays[attempt - 1])
    options.metrics.callbackAttempts += 1
    try {
      const response = await callbackApiRequest(record.apiPath, body, options.requestTimeoutMs)
      await fs.unlink(file).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
      return response
    } catch (error) {
      lastError = error
      if (isPermanentCallbackError(error)) {
        await movePendingToDeadLetter(file, options.outputDir)
        error.callbackPermanent = true
        throw error
      }
    }
  }
  if (lastError && typeof lastError === 'object') lastError.callbackPending = true
  throw lastError
}

async function replayPendingEvents({ outputDir, args, metrics, config }) {
  const pendingDir = path.join(outputDir, 'pending-events')
  let names
  try {
    names = await fs.readdir(pendingDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const records = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const file = path.join(pendingDir, name)
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!isTrustedPendingRecord(record, config)) {
        await movePendingToDeadLetter(file, outputDir)
        continue
      }
      records.push({ file, record })
    } catch {
      await movePendingToDeadLetter(file, outputDir)
    }
  }
  records.sort((left, right) => Number(left.record.payload.sequence) - Number(right.record.payload.sequence))
  for (const { file, record } of records) {
    await sendPendingEvent(record, file, {
      outputDir,
      metrics,
      retryDelays: callbackRetryDelays(args),
      requestTimeoutMs: callbackRequestTimeoutMs(args),
    })
  }
}

function isTrustedPendingRecord(record, config = {}) {
  if (!record?.payload || !Number.isFinite(Number(record.payload.sequence))) return false
  if (!record.payload.connectionId || record.payload.connectionId !== config.connectionId) return false
  if (typeof record.apiPath !== 'string') return false
  const match = record.apiPath.match(/^\/api\/workflow-runs\/([^/?#]+)\/events$/)
  if (!match) return false
  try {
    const runId = decodeURIComponent(match[1])
    return Boolean(runId)
      && runId !== '.'
      && runId !== '..'
      && !runId.includes('/')
      && !runId.includes('\\')
      && encodeURIComponent(runId) === match[1]
  } catch {
    return false
  }
}

async function postEvent(workItem, config, eventInput = {}, index = 0, options = {}) {
  const ctx = callbackContext(workItem, config)
  if (!ctx.runId) throw new Error('Work item payload is missing callback.runId/orderId')
  const eventType = compact(eventInput.event || eventInput.eventType) || 'node.progress'
  const payload = cleanPayload({
    connectionId: ctx.connectionId,
    serviceSopId: ctx.serviceSopId,
    nodeKey: compact(eventInput.nodeKey) || ctx.nodeKey,
    event: eventType,
    status: compact(eventInput.status) || defaultStatus(eventType),
    progress: eventInput.progress === undefined ? undefined : numberArg(eventInput.progress, 0),
    message: eventInput.message,
    sequence: eventInput.sequence === undefined ? undefined : numberArg(eventInput.sequence, index),
    idempotencyKey: eventInput.idempotencyKey || `${ctx.baseIdempotencyKey}-${eventType}-${index}`,
    sourceAgent: eventInput.sourceAgent,
    reportedByAgent: eventInput.reportedByAgent,
    artifact: eventInput.artifact,
    activity: eventInput.activity,
  })
  const apiPath = `/api/workflow-runs/${encodeURIComponent(ctx.runId)}/events`
  const file = pendingEventFile(options.outputDir, payload)
  const record = { apiPath, payload, createdAt: new Date().toISOString() }
  await writePendingEventAtomically(file, record)
  return sendPendingEvent(record, file, {
    outputDir: options.outputDir,
    metrics: options.metrics,
    retryDelays: options.retryDelays ?? DEFAULT_CALLBACK_RETRY_DELAYS_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_CALLBACK_REQUEST_TIMEOUT_MS,
  })
}

function attemptCount(workItem) {
  return Math.max(1, Math.floor(numberArg(workItem?.attemptCount ?? workItem?.attempt_count, 1)))
}

function createEventDispatcher({ workItem, config, outputDir, args, metrics }) {
  let nextSequence = 1
  let queue = Promise.resolve()
  const retryDelays = callbackRetryDelays(args)
  const requestTimeoutMs = callbackRequestTimeoutMs(args)

  const post = (eventInput = {}) => {
    const sequence = nextSequence
    nextSequence += 1
    const operation = queue.then(() => postEvent(workItem, config, {
      ...eventInput,
      sequence,
    }, sequence, {
      outputDir,
      retryDelays,
      requestTimeoutMs,
      metrics,
    }))
    queue = operation.catch(() => undefined)
    return operation
  }

  return {
    post,
    drain: () => queue,
    nextSequence: () => nextSequence,
  }
}

function leaseRenewIntervalMs(args = {}, leaseSeconds = 0) {
  const explicit = numberArg(
    arg(args, ['lease-renew-interval-ms', 'leaseRenewIntervalMs'], process.env.KAIGONGBA_WORK_ITEM_LEASE_RENEW_INTERVAL_MS),
    undefined,
  )
  if (Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit))
  return Math.max(5000, Math.floor((leaseSeconds * 1000) / 3))
}

async function renewWorkItemLease(workItem, { workerId, leaseSeconds }) {
  return apiRequest(`/api/agent/work-items/${encodeURIComponent(workItem.id)}/lease`, {
    method: 'POST',
    body: JSON.stringify({ workerId, leaseSeconds }),
  })
}

function startLeaseRenewal(workItem, options = {}) {
  const intervalMs = leaseRenewIntervalMs(options.args, options.leaseSeconds)
  const state = {
    intervalMs,
    renewals: 0,
    lastError: '',
    timer: null,
  }
  const tick = async () => {
    try {
      await renewWorkItemLease(workItem, options)
      state.renewals += 1
      state.lastError = ''
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
    }
  }
  state.timer = setInterval(() => {
    void tick()
  }, intervalMs)
  return state
}

function stopLeaseRenewal(state) {
  if (state?.timer) clearInterval(state.timer)
}

function leaseRenewalSnapshot(state) {
  return {
    renewals: state?.renewals ?? 0,
    intervalMs: state?.intervalMs ?? null,
    lastError: state?.lastError || null,
  }
}

function startProgressHeartbeat(workItem, dispatcher, { args = {}, events = [] } = {}) {
  const intervalMs = Math.max(0, numberArg(
    arg(args, ['progress-heartbeat-interval-ms', 'progressHeartbeatIntervalMs'], process.env.KAIGONGBA_PROGRESS_HEARTBEAT_INTERVAL_MS),
    DEFAULT_PROGRESS_HEARTBEAT_INTERVAL_MS,
  ))
  const state = {
    intervalMs,
    startedAt: Date.now(),
    ticks: 0,
    lastError: '',
    stopped: intervalMs === 0,
    timer: null,
    inFlight: null,
  }
  const schedule = () => {
    if (state.stopped) return
    state.timer = setTimeout(async () => {
      if (state.stopped) return
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - state.startedAt) / 1000))
      const attempt = attemptCount(workItem)
      const eventId = `${workItem.id}:heartbeat:${state.ticks + 1}:attempt:${attempt}`
      state.inFlight = dispatcher.post({
        event: 'node.progress',
        message: `Agent 持续执行中 · 已运行 ${elapsedSeconds} 秒`,
        idempotencyKey: eventId,
        activity: {
          kind: 'heartbeat',
          eventId,
          attemptCount: attempt,
        },
      })
      try {
        events.push(await state.inFlight)
        state.ticks += 1
        state.lastError = ''
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
      } finally {
        state.inFlight = null
        schedule()
      }
    }, intervalMs)
  }
  schedule()
  return state
}

async function stopProgressHeartbeat(state) {
  if (!state) return
  state.stopped = true
  if (state.timer) clearTimeout(state.timer)
  if (state.inFlight) await state.inFlight.catch(() => undefined)
}

function progressHeartbeatSnapshot(state) {
  return {
    ticks: state?.ticks ?? 0,
    intervalMs: state?.intervalMs ?? null,
    lastError: state?.lastError || null,
  }
}

export function platformEventFromExecutor(event, workItem) {
  if (!event || event.internal === true) return null
  const eventType = {
    lifecycle: 'node.log',
    progress: 'node.progress',
    file: 'node.log',
    log: 'node.log',
  }[event.type]
  if (!eventType) return null

  const attempt = attemptCount(workItem)
  const eventId = `${event.eventId}:attempt:${attempt}`
  const activity = cleanPayload({
    protocol: event.protocol,
    kind: event.type === 'progress'
      ? 'real_progress'
      : event.type === 'file'
        ? `file_${event.status}`
        : 'lifecycle',
    eventId,
    occurredAt: event.occurredAt,
    phase: event.phase,
    current: event.current,
    total: event.total,
    unit: event.unit,
    attemptCount: attempt,
  })
  return {
    event: eventType,
    progress: event.type === 'progress' ? event.percent : undefined,
    message: sanitizePublicText(event.message || (
      event.type === 'file' ? `Agent 文件${event.status === 'stable' ? '已稳定' : '生成中'}：${event.name || ''}` : ''
    )),
    idempotencyKey: eventId,
    activity,
  }
}

async function artifactPayload(input = {}) {
  const filePath = compact(input.file || input.filePath)
  let fileStats = null
  if (filePath) fileStats = await fs.stat(filePath)
  const name = compact(input.name) || (filePath ? path.basename(filePath) : '阶段结果文件')
  const type = compact(input.type) || path.extname(name).slice(1) || 'file'
  return {
    externalArtifactId: input.externalArtifactId || input.external_artifact_id,
    name,
    type,
    mimeType: input.mimeType || input.mime_type || mimeFromName(name, type),
    sizeBytes: input.sizeBytes ?? input.size_bytes ?? fileStats?.size ?? 0,
    sha256: input.sha256,
    externalUrl: input.externalUrl || input.external_url,
    uploadId: input.uploadId || input.upload_id,
  }
}

function artifactPathError(message) {
  const error = new Error(message)
  error.code = 'artifact_path_outside_output'
  return error
}

function isStrictDescendant(root, candidate) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`)
}

function safeWorkItemDirectoryName(workItem) {
  const value = compact(workItem?.id)
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    const error = new Error('work item id cannot be used as an artifact directory')
    error.code = 'work_item_id_invalid'
    throw error
  }
  return value
}

async function prepareTaskArtifactDirectory(artifactRoot, workItem) {
  const safeId = safeWorkItemDirectoryName(workItem)
  const lexicalRoot = path.resolve(artifactRoot)
  await fs.mkdir(lexicalRoot, { recursive: true, mode: 0o700 })
  const rootStats = await fs.lstat(lexicalRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw artifactPathError('trusted artifact root must be a real directory')
  }
  const realRoot = await fs.realpath(lexicalRoot)
  const lexicalTaskRoot = path.join(lexicalRoot, safeId)
  await fs.mkdir(lexicalTaskRoot, { recursive: true, mode: 0o700 })
  const taskStats = await fs.lstat(lexicalTaskRoot)
  if (!taskStats.isDirectory() || taskStats.isSymbolicLink()) {
    throw artifactPathError('work item artifact directory must be a real directory')
  }
  const realTaskRoot = await fs.realpath(lexicalTaskRoot)
  if (realTaskRoot !== path.join(realRoot, safeId)) {
    throw artifactPathError('work item artifact directory resolves outside its trusted root')
  }
  await Promise.all([fs.chmod(realRoot, 0o700), fs.chmod(realTaskRoot, 0o700)])
  return { artifactRoot: realRoot, taskRoot: realTaskRoot }
}

const BASE_EXECUTOR_ENV_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'CODEX_HOME', 'CODEX_EXECUTABLE', 'CODEX_MODEL', 'CODEX_EXEC_ARGS', 'INIT_CWD',
  'KAIGONGBA_EXECUTOR_JSONL', 'KAIGONGBA_ACTIVITY_POLL_INTERVAL_MS',
  'KAIGONGBA_ARTIFACT_STABLE_WINDOW_MS', 'KAIGONGBA_ARTIFACT_STABLE_POLL_INTERVAL_MS',
  'KAIGONGBA_AGENT_SOURCE_DIR', 'KAIGONGBA_API_BASE_URL',
]

export function executorEnvironment(args, additions = {}, source = process.env) {
  const names = new Set(BASE_EXECUTOR_ENV_NAMES)
  const allowlist = arg(
    args,
    ['executor-env-allowlist', 'executorEnvAllowlist'],
    source.KAIGONGBA_EXECUTOR_ENV_ALLOWLIST,
  )
  for (const name of String(allowlist || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !forbiddenExecutorEnvironmentName(name)) names.add(name)
  }
  const env = {}
  for (const name of names) {
    if (source[name] !== undefined && !forbiddenExecutorEnvironmentName(name)) env[name] = source[name]
  }
  return { ...env, ...safeEnvironmentAdditions(additions) }
}

async function trustedTaskArtifactRoot(stableFile, trustedArtifactRoot, expectedTaskRoot) {
  const { realRoot: verifiedArtifactRoot, realTaskRoot: verifiedTaskRoot } = await verifyCanonicalTaskDirectory(
    trustedArtifactRoot,
    expectedTaskRoot,
  )
  const lexicalStableFile = path.resolve(stableFile)
  const lexicalStableDir = path.dirname(lexicalStableFile)
  if (path.basename(lexicalStableDir) !== '.kaigongba-stable') {
    throw artifactPathError('executor stable artifact must be inside a .kaigongba-stable directory')
  }
  const lexicalTaskRoot = path.dirname(lexicalStableDir)
  const lexicalTrustedRoot = path.resolve(trustedArtifactRoot)

  const [realTrustedRoot, realTaskRoot] = await Promise.all([fs.realpath(lexicalTrustedRoot), fs.realpath(lexicalTaskRoot)])
  if (realTrustedRoot !== verifiedArtifactRoot) {
    throw artifactPathError('trusted artifact root changed during artifact validation')
  }
  if (!isStrictDescendant(realTrustedRoot, realTaskRoot)) {
    throw artifactPathError('executor stable artifact task directory resolves outside the trusted artifact root')
  }
  if (realTaskRoot !== verifiedTaskRoot) {
    throw artifactPathError('executor stable artifact belongs to a different work item directory')
  }
  return realTaskRoot
}

async function verifyCanonicalTaskDirectory(trustedArtifactRoot, expectedTaskRoot) {
  const [rootStats, taskStats] = await Promise.all([
    fs.lstat(trustedArtifactRoot),
    fs.lstat(expectedTaskRoot),
  ])
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !taskStats.isDirectory() || taskStats.isSymbolicLink()) {
    throw artifactPathError('trusted artifact directories must remain real directories')
  }
  const [realRoot, realTaskRoot] = await Promise.all([
    fs.realpath(trustedArtifactRoot),
    fs.realpath(expectedTaskRoot),
  ])
  if (realTaskRoot !== path.join(realRoot, path.basename(expectedTaskRoot))) {
    throw artifactPathError('work item artifact directory changed or resolves outside its trusted root')
  }
  return { realRoot, realTaskRoot }
}

async function trustedLocalArtifact(filePath, trustedArtifactRoot, expectedTaskRoot) {
  const { realTaskRoot } = await verifyCanonicalTaskDirectory(trustedArtifactRoot, expectedTaskRoot)
  const realFile = await fs.realpath(filePath)
  if (!isStrictDescendant(realTaskRoot, realFile)) {
    throw artifactPathError('local artifact is outside the trusted work item directory')
  }
  return { realTaskRoot, realFile }
}

async function postArtifact(workItem, config, artifactInput = {}, index = 0, options = {}) {
  const ctx = callbackContext(workItem, config)
  const filePath = compact(artifactInput.file || artifactInput.filePath)
  if (filePath && (artifactInput.externalUrl || artifactInput.external_url || artifactInput.uploadId || artifactInput.upload_id)) {
    const error = new Error('artifact cannot combine a local file with an external URL or upload id')
    error.code = 'artifact_input_conflict'
    throw error
  }
  const artifact = await artifactPayload(artifactInput)
  if (!artifact.externalArtifactId) artifact.externalArtifactId = `${ctx.runId}-${ctx.nodeKey}-${artifact.name}`
  const shouldRequestUpload = Boolean(!artifact.externalUrl && !artifact.uploadId)
  let snapshot = null
  const submit = async (bytes) => {
    if (shouldRequestUpload) {
      const upload = await artifactApiRequest('/api/artifacts/upload-url', {
        method: 'POST',
        body: JSON.stringify(cleanPayload({
          connectionId: ctx.connectionId,
          runId: ctx.runId,
          nodeKey: ctx.nodeKey,
          name: artifact.name,
          type: artifact.type,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
        })),
      }, options.artifactRequestPolicy, 'artifact_upload_url')
      artifact.externalUrl = upload.externalUrl || upload.downloadUrl || upload.uploadUrl
      artifact.uploadId = upload.uploadId
      artifact.uploadUrl = upload.uploadUrl
    }
    const uploadResult = shouldRequestUpload
      ? await uploadFileToUrl({ bytes, uploadUrl: artifact.uploadUrl || artifact.externalUrl, mimeType: artifact.mimeType, policy: options.artifactRequestPolicy })
      : { uploaded: false, skippedReason: filePath ? 'external_artifact_url_provided' : 'no_file' }
    delete artifact.uploadUrl
    cleanPayload(artifact)
    const eventResult = await options.dispatcher.post({
      event: 'artifact.created',
      status: 'submitted',
      message: artifactInput.message,
      idempotencyKey: artifactInput.idempotencyKey
        || `${ctx.baseIdempotencyKey}-artifact-${index}-attempt:${attemptCount(workItem)}`,
      artifact,
      sourceAgent: artifactInput.sourceAgent,
      reportedByAgent: artifactInput.reportedByAgent,
    })
    let completed = null
    if (uploadResult.uploaded && eventResult.artifact?.id) {
      completed = await artifactApiRequest(`/api/artifacts/${encodeURIComponent(eventResult.artifact.id)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ uploadId: artifact.uploadId, uploaded: true, uploadStatus: uploadResult.status }),
      }, options.artifactRequestPolicy, 'artifact_complete')
    }
    return redactLocalResult({ ...eventResult, upload: uploadResult, completed })
  }

  if (!shouldRequestUpload || !filePath) return submit(undefined)
  const hasExecutorSnapshot = Number.isInteger(artifact.sizeBytes)
    && artifact.sizeBytes >= 0
    && /^[a-f0-9]{64}$/.test(artifact.sha256 || '')
  const trustedLegacy = hasExecutorSnapshot
    ? null
    : await trustedLocalArtifact(filePath, options.artifactOutputDir, options.taskArtifactDir)
  const snapshotOutputDir = hasExecutorSnapshot
    ? await trustedTaskArtifactRoot(filePath, options.artifactOutputDir, options.taskArtifactDir)
    : trustedLegacy.realTaskRoot
  snapshot = hasExecutorSnapshot
    ? { outputDir: snapshotOutputDir, stableFile: filePath, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 }
    : {
        outputDir: snapshotOutputDir,
        ...await stableArtifactSnapshot({ outputDir: snapshotOutputDir, file: trustedLegacy.realFile }),
      }
  if (!hasExecutorSnapshot) {
    snapshot.outputDir = await trustedTaskArtifactRoot(
      snapshot.stableFile,
      options.artifactOutputDir,
      options.taskArtifactDir,
    )
  }
  artifact.sizeBytes = snapshot.sizeBytes
  artifact.sha256 = snapshot.sha256
  try {
    return await withVerifiedStableArtifact(snapshot, ({ bytes }) => submit(bytes))
  } finally {
    await cleanupStableArtifactSnapshot(snapshot)
  }
}

async function cleanupExecutorStableArtifacts(artifactInputs, options) {
  for (const input of artifactInputs) {
    const stableFile = compact(input?.file || input?.filePath)
    const sizeBytes = input?.sizeBytes ?? input?.size_bytes
    const sha256 = input?.sha256
    if (!stableFile || !Number.isInteger(sizeBytes) || !/^[a-f0-9]{64}$/.test(sha256 || '')) continue
    try {
      const outputDir = await trustedTaskArtifactRoot(
        stableFile,
        options.artifactOutputDir,
        options.taskArtifactDir,
      )
      await cleanupStableArtifactSnapshot({ outputDir, stableFile })
    } catch {
      // Best-effort cleanup only after the path has passed the same trust checks used for upload.
    }
  }
}

function terminateProcessGroup(child, signal) {
  if (!child?.pid) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      try {
        child.kill(signal)
        return true
      } catch {
        return false
      }
    }
  }
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

async function executeCommand(command, workItem, timeouts, options = {}) {
  return new Promise((resolve, reject) => {
    const { hardTimeoutMs, idleTimeoutMs } = timeouts
    const killGraceMs = Math.max(0, numberArg(options.killGraceMs, DEFAULT_EXECUTOR_KILL_GRACE_MS))
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || process.env,
    })
    const legacyLines = []
    const seenEventIds = new Set()
    let settled = false
    let timedOut = false
    let protocolSeen = false
    let resultSeen = false
    let protocolResult = null
    let consecutiveMalformed = 0
    let streamError = null
    let killTimer = null
    let abandonTimer = null
    let hardTimer = null
    let idleTimer = null
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    let timeoutError = null
    let legacyBytes = 0
    let protocolEvents = 0
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (killTimer) clearTimeout(killTimer)
      if (abandonTimer) clearTimeout(abandonTimer)
      callback(value)
    }
    const triggerTimeout = (code) => {
      if (timedOut || settled) return
      timedOut = true
      timeoutError = new Error(code === 'executor_idle_timeout'
        ? `Executor had no valid activity for ${idleTimeoutMs}ms`
        : `Executor exceeded hard timeout of ${hardTimeoutMs}ms`)
      timeoutError.code = code
      timeoutError.details = {
        hardTimeoutMs,
        idleTimeoutMs,
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        elapsedMs: Date.now() - startedAt,
      }
      terminateProcessGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        terminateProcessGroup(child, 'SIGKILL')
      }, killGraceMs)
      abandonTimer = setTimeout(() => {
        settle(reject, timeoutError)
      }, killGraceMs + 2000)
    }
    const resetIdleTimer = () => {
      lastActivityAt = Date.now()
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => triggerTimeout('executor_idle_timeout'), idleTimeoutMs)
    }
    hardTimer = setTimeout(() => triggerTimeout('executor_hard_timeout'), hardTimeoutMs)
    idleTimer = setTimeout(() => triggerTimeout('executor_idle_timeout'), idleTimeoutMs)

    const abortExecutorStream = (error) => {
      if (streamError || settled) return
      streamError = error
      terminateProcessGroup(child, 'SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), killGraceMs)
    }
    const boundedStdout = boundedLineStream(() => {
      const error = new Error('Executor stdout line exceeded the allowed byte limit')
      error.code = 'executor_output_limit'
      abortExecutorStream(error)
    })
    child.stdout.pipe(boundedStdout)
    const reader = createInterface({ input: boundedStdout, crlfDelay: Infinity })

    const recordValidProtocol = () => {
      const occurredAt = new Date().toISOString()
      options.metrics.validProtocolEvents += 1
      options.metrics.firstProtocolEventAt ||= occurredAt
      return occurredAt
    }

    const recordValidActivity = (event, occurredAt) => {
      options.metrics.lastValidActivityAt = occurredAt
      if (event.type === 'progress') options.metrics.firstRealProgressAt ||= occurredAt
      resetIdleTimer()
    }

    const protocolCandidate = (line) => {
      try {
        const value = JSON.parse(line)
        return value && typeof value === 'object' && Object.hasOwn(value, 'protocol')
      } catch {
        return line.includes(EXECUTOR_PROTOCOL)
      }
    }

    const consumeLine = async (line) => {
      if (streamError) return
      if (!protocolSeen && !protocolCandidate(line)) {
        legacyBytes += Buffer.byteLength(line, 'utf8') + 1
        if (legacyBytes > MAX_EXECUTOR_LEGACY_BYTES) {
          const error = new Error('Executor legacy output exceeded the allowed byte limit')
          error.code = 'executor_output_limit'
          abortExecutorStream(error)
          return
        }
        legacyLines.push(line)
        return
      }

      let event
      try {
        event = parseExecutorProtocolLine(line)
      } catch (error) {
        options.metrics.invalidProtocolEvents += 1
        consecutiveMalformed += 1
        if (consecutiveMalformed > 3) {
          abortExecutorStream(error)
        }
        return
      }

      protocolSeen = true
      protocolEvents += 1
      if (protocolEvents > MAX_EXECUTOR_PROTOCOL_EVENTS) {
        const error = new Error('Executor protocol event limit exceeded')
        error.code = 'executor_output_limit'
        abortExecutorStream(error)
        return
      }
      consecutiveMalformed = 0
      if (seenEventIds.has(event.eventId)) {
        options.metrics.duplicateProtocolEvents += 1
        return
      }
      if (event.type === 'result') {
        if (resultSeen) {
          const error = new Error('Executor emitted more than one result event')
          error.code = 'executor_protocol_error'
          abortExecutorStream(error)
          return
        }
        resultSeen = true
      } else if (resultSeen) {
        const error = new Error('Executor emitted an event after its result event')
        error.code = 'executor_protocol_error'
        abortExecutorStream(error)
        return
      }
      seenEventIds.add(event.eventId)
      const occurredAt = recordValidProtocol()
      recordValidActivity(event, occurredAt)
      if (event.type === 'result') {
        if (!event.result || typeof event.result !== 'object' || Array.isArray(event.result)) {
          streamError = new Error('Executor result event is missing its authoritative result')
          streamError.code = 'executor_protocol_error'
          return
        }
        protocolResult = event.result
      }
      if (typeof options.onEvent === 'function') {
        await options.onEvent(event)
      }
    }
    const lineConsumer = (async () => {
      for await (const line of reader) {
        boundedStdout.pause()
        try {
          await consumeLine(line)
        } finally {
          if (!streamError) boundedStdout.resume()
        }
        if (streamError) break
      }
    })().catch((error) => abortExecutorStream(error))
    child.stderr.resume()
    child.on('error', (error) => {
      settle(reject, error)
    })
    child.on('close', (code) => {
      void (async () => {
      if (hardTimer) clearTimeout(hardTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (timedOut) {
        terminateProcessGroup(child, 'SIGKILL')
        settle(reject, timeoutError)
        return
      }
      await lineConsumer
      if (streamError) {
        terminateProcessGroup(child, 'SIGKILL')
        settle(reject, streamError)
        return
      }
      if (code !== 0) {
        settle(reject, new Error(`Executor exited with code ${code}`))
        return
      }
      try {
        if (protocolSeen) {
          if (!protocolResult) {
            const error = new Error('Executor stream ended without a result event')
            error.code = 'executor_protocol_error'
            throw error
          }
          settle(resolve, protocolResult)
          return
        }
        const legacyText = legacyLines.join('\n').trim()
        const legacyResult = legacyText ? JSON.parse(legacyText) : {}
        resetIdleTimer()
        options.metrics.lastValidActivityAt = new Date().toISOString()
        settle(resolve, legacyResult)
      } catch (error) {
        settle(reject, error?.code === 'executor_protocol_error'
          ? error
          : new Error(`Executor returned invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`))
      }
      })()
    })
    child.stdin.end(`${JSON.stringify(workItem)}\n`)
  })
}

function normalizeExecutorResult(result = {}) {
  const progressEvents = Array.isArray(result.progressEvents) ? result.progressEvents : []
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : []
  return {
    status: compact(result.status) || 'completed',
    finalEvent: compact(result.finalEvent),
    finalMessage: compact(result.finalMessage || result.message),
    progressEvents,
    artifacts,
    raw: result,
  }
}

export async function runWorkItem(args = {}) {
  const config = await readConnectionConfig()
  const executorCommand = compact(arg(args, ['executor-command', 'executorCommand'], process.env.KAIGONGBA_EXECUTOR_COMMAND))
  if (!executorCommand) throw new Error('KAIGONGBA_EXECUTOR_COMMAND or --executor-command is required')
  const outputDir = outputDirArg(args)
  const replayMetrics = { callbackAttempts: 0 }
  await replayPendingEvents({ outputDir, args, metrics: replayMetrics, config })
  const executorKillGraceMs = numberArg(
    arg(args, ['executor-kill-grace-ms', 'executorKillGraceMs'], process.env.KAIGONGBA_EXECUTOR_KILL_GRACE_MS),
    DEFAULT_EXECUTOR_KILL_GRACE_MS,
  )
  const workerId = resolveWorkerId(args, config)
  const leaseSeconds = resolveLeaseSeconds(args)
  const claimed = await claimWorkItem({ ...args, outputDir, workerId, leaseSeconds })
  const workItem = claimed.workItem
  const executorTimeouts = resolveExecutorTimeouts({ args, workItem, env: process.env })
  const configuredArtifactOutputDir = process.env.KAIGONGBA_CODEX_OUTPUT_DIR || path.join(outputDir, 'codex-artifacts')
  const events = []
  const artifacts = []
  const executionMetrics = {
    firstProtocolEventAt: null,
    firstRealProgressAt: null,
    lastValidActivityAt: null,
    validProtocolEvents: 0,
    invalidProtocolEvents: 0,
    duplicateProtocolEvents: 0,
    callbackAttempts: replayMetrics.callbackAttempts,
    timeoutSource: executorTimeouts.source,
  }
  const dispatcher = createEventDispatcher({ workItem, config, outputDir, args, metrics: executionMetrics })
  const leaseRenewal = startLeaseRenewal(workItem, { args, workerId, leaseSeconds })
  let progressHeartbeat = null

  try {
    const preparedArtifactDirectories = await prepareTaskArtifactDirectory(configuredArtifactOutputDir, workItem)
    const artifactOutputDir = preparedArtifactDirectories.artifactRoot
    const taskArtifactDir = preparedArtifactDirectories.taskRoot
    const attempt = attemptCount(workItem)
    const startedEventId = `${workItem.id}:started:attempt:${attempt}`
    events.push(await dispatcher.post({
      event: 'node.started',
      message: 'Agent 已领取任务并开始执行',
      idempotencyKey: startedEventId,
      activity: { kind: 'lifecycle', eventId: startedEventId, attemptCount: attempt },
    }))
    progressHeartbeat = startProgressHeartbeat(workItem, dispatcher, { args, events })
    const executorEnv = executorEnvironment(args, {
      KAIGONGBA_CODEX_OUTPUT_DIR: artifactOutputDir,
      KAIGONGBA_WORK_ITEM_OUTPUT_DIR: taskArtifactDir,
    })
    const executorResult = normalizeExecutorResult(await executeCommand(executorCommand, workItem, executorTimeouts, {
      cwd: outputDir,
      env: executorEnv,
      killGraceMs: executorKillGraceMs,
      metrics: executionMetrics,
      onEvent: async (executorEvent) => {
        const platformEvent = platformEventFromExecutor(executorEvent, workItem)
        if (!platformEvent) return
        events.push(await dispatcher.post(platformEvent))
      },
    }))
    await stopProgressHeartbeat(progressHeartbeat)
    await dispatcher.drain()
    const heartbeat = progressHeartbeatSnapshot(progressHeartbeat)
    let legacyIndex = 0
    for (const event of executorResult.progressEvents) {
      const eventId = `${workItem.id}:legacy-progress:${legacyIndex}:attempt:${attempt}`
      events.push(await dispatcher.post({
        ...event,
        idempotencyKey: event.idempotencyKey || eventId,
        activity: event.activity || { kind: 'real_progress', eventId, attemptCount: attempt },
      }))
      legacyIndex += 1
    }
    const artifactOptions = {
      dispatcher,
      artifactOutputDir,
      taskArtifactDir,
      artifactRequestPolicy: artifactRequestPolicy(args),
    }
    try {
      let artifactIndex = 0
      for (const artifact of executorResult.artifacts) {
        artifacts.push(await postArtifact(workItem, config, artifact, artifactIndex, artifactOptions))
        artifactIndex += 1
      }
    } finally {
      await cleanupExecutorStableArtifacts(executorResult.artifacts, artifactOptions)
    }
    const terminalEvent = executorResult.finalEvent || (executorResult.status === 'failed' ? 'node.failed' : 'node.completed')
    const terminalEventId = `${workItem.id}:${terminalEvent}:attempt:${attempt}`
    events.push(await dispatcher.post({
      event: terminalEvent,
      message: sanitizePublicText(executorResult.finalMessage || (terminalEvent === 'node.failed' ? 'Agent 执行失败' : 'Agent 执行完成')),
      idempotencyKey: terminalEventId,
      activity: { kind: 'lifecycle', eventId: terminalEventId, attemptCount: attempt },
    }))
    const result = redactLocalResult({ ok: terminalEvent !== 'node.failed', workItem, events, artifacts, executorResult: executorResult.raw, outputDir, leaseRenewal: leaseRenewalSnapshot(leaseRenewal), progressHeartbeat: heartbeat, executionMetrics })
    await writeJson(path.join(outputDir, 'last-run-result.json'), result, { mode: 0o600 })
    return result
  } catch (error) {
    await stopProgressHeartbeat(progressHeartbeat)
    const failureMessage = error instanceof Error ? error.message : 'Agent 执行失败'
    const heartbeat = progressHeartbeatSnapshot(progressHeartbeat)
    const attempt = attemptCount(workItem)
    const failureEventId = `${workItem.id}:node.failed:attempt:${attempt}`
    if (!error?.callbackPending) {
      events.push(await dispatcher.post({
        event: 'node.failed',
        message: sanitizePublicText(failureMessage),
        idempotencyKey: failureEventId,
        activity: cleanPayload({
          kind: 'lifecycle',
          eventId: failureEventId,
          attemptCount: attempt,
          code: error?.code,
          hardTimeoutMs: error?.details?.hardTimeoutMs,
          idleTimeoutMs: error?.details?.idleTimeoutMs,
          lastActivityAt: error?.details?.lastActivityAt,
          elapsedMs: error?.details?.elapsedMs,
        }),
      }).catch((postError) => ({
        error: postError instanceof Error ? postError.message : 'failed to report node.failed',
      })))
    }
    const result = redactLocalResult({
      ok: false,
      workItem,
      events,
      artifacts,
      error: sanitizePublicText(failureMessage),
      errorCode: error?.code || null,
      errorDetails: error?.details || null,
      outputDir,
      leaseRenewal: leaseRenewalSnapshot(leaseRenewal),
      progressHeartbeat: heartbeat,
      executionMetrics,
    })
    await writeJson(path.join(outputDir, 'last-run-result.json'), result, { mode: 0o600 })
    return result
  } finally {
    stopLeaseRenewal(leaseRenewal)
  }
}

async function main() {
  const args = parseArgs()
  const result = await runWorkItem(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
