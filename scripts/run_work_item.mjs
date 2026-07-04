#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { claimWorkItem, resolveLeaseSeconds, resolveWorkerId } from './claim_work_item.mjs'
import { apiRequest, arg, defaultStatus, mimeFromName, numberArg, parseArgs, readConnectionConfig, uploadFileToUrl, writeJson } from './lib.mjs'

const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_EXECUTOR_KILL_GRACE_MS = 5000

function defaultOutputDir() {
  return path.resolve(process.cwd(), '.kaigongba/runtime')
}

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
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

async function postEvent(workItem, config, eventInput = {}, index = 0) {
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
  })
  return apiRequest(`/api/workflow-runs/${encodeURIComponent(ctx.runId)}/events`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
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
    externalUrl: input.externalUrl || input.external_url,
    uploadId: input.uploadId || input.upload_id,
  }
}

async function postArtifact(workItem, config, artifactInput = {}, index = 0) {
  const ctx = callbackContext(workItem, config)
  const filePath = compact(artifactInput.file || artifactInput.filePath)
  const artifact = await artifactPayload(artifactInput)
  if (!artifact.externalArtifactId) artifact.externalArtifactId = `${ctx.runId}-${ctx.nodeKey}-${artifact.name}`
  const shouldRequestUpload = Boolean(!artifact.externalUrl && !artifact.uploadId)
  if (shouldRequestUpload) {
    const upload = await apiRequest('/api/artifacts/upload-url', {
      method: 'POST',
      body: JSON.stringify(cleanPayload({
        connectionId: ctx.connectionId,
        runId: ctx.runId,
        nodeKey: ctx.nodeKey,
        name: artifact.name,
        type: artifact.type,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      })),
    })
    const uploadUrl = upload.uploadUrl
    artifact.externalUrl = upload.externalUrl || upload.downloadUrl || upload.uploadUrl
    artifact.uploadId = upload.uploadId
    artifact.uploadUrl = uploadUrl
  }
  const uploadResult = shouldRequestUpload
    ? await uploadFileToUrl({ filePath, uploadUrl: artifact.uploadUrl || artifact.externalUrl, mimeType: artifact.mimeType })
    : { uploaded: false, skippedReason: filePath ? 'external_artifact_url_provided' : 'no_file' }
  delete artifact.uploadUrl
  cleanPayload(artifact)
  const eventResult = await postEvent(workItem, config, {
    event: 'artifact.created',
    status: 'submitted',
    message: artifactInput.message,
    idempotencyKey: artifactInput.idempotencyKey || `${ctx.baseIdempotencyKey}-artifact-${index}`,
    artifact,
    sourceAgent: artifactInput.sourceAgent,
    reportedByAgent: artifactInput.reportedByAgent,
  }, index)
  let completed = null
  if (uploadResult.uploaded && eventResult.artifact?.id) {
    completed = await apiRequest(`/api/artifacts/${encodeURIComponent(eventResult.artifact.id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ uploadId: artifact.uploadId, uploaded: true, uploadStatus: uploadResult.status }),
    })
  }
  return { ...eventResult, upload: uploadResult, completed }
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

async function executeCommand(command, workItem, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const killGraceMs = Math.max(0, numberArg(options.killGraceMs, DEFAULT_EXECUTOR_KILL_GRACE_MS))
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let settled = false
    let timedOut = false
    let killTimer = null
    let abandonTimer = null
    const timeoutError = new Error(`Executor timed out after ${timeoutMs}ms`)
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (abandonTimer) clearTimeout(abandonTimer)
      callback(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        terminateProcessGroup(child, 'SIGKILL')
      }, killGraceMs)
      abandonTimer = setTimeout(() => {
        settle(reject, timeoutError)
      }, killGraceMs + 2000)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      settle(reject, error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (abandonTimer) clearTimeout(abandonTimer)
      if (timedOut) {
        settle(reject, timeoutError)
        return
      }
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        settle(reject, new Error(err || `Executor exited with code ${code}`))
        return
      }
      try {
        settle(resolve, out ? JSON.parse(out) : {})
      } catch (error) {
        settle(reject, new Error(`Executor returned invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`))
      }
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
  const outputDir = path.resolve(String(arg(args, ['output-dir', 'outputDir'], defaultOutputDir())))
  const timeoutMs = numberArg(arg(args, ['timeout-ms', 'timeoutMs'], process.env.KAIGONGBA_EXECUTOR_TIMEOUT_MS), DEFAULT_EXECUTOR_TIMEOUT_MS)
  const executorKillGraceMs = numberArg(
    arg(args, ['executor-kill-grace-ms', 'executorKillGraceMs'], process.env.KAIGONGBA_EXECUTOR_KILL_GRACE_MS),
    DEFAULT_EXECUTOR_KILL_GRACE_MS,
  )
  const workerId = resolveWorkerId(args, config)
  const leaseSeconds = resolveLeaseSeconds(args)
  const claimed = await claimWorkItem({ ...args, outputDir, workerId, leaseSeconds })
  const workItem = claimed.workItem
  const events = []
  const artifacts = []
  const leaseRenewal = startLeaseRenewal(workItem, { args, workerId, leaseSeconds })

  try {
    events.push(await postEvent(workItem, config, { event: 'node.started', message: 'Agent 已领取任务并开始执行' }, 1))
    const executorResult = normalizeExecutorResult(await executeCommand(executorCommand, workItem, timeoutMs, { killGraceMs: executorKillGraceMs }))
    let index = 10
    for (const event of executorResult.progressEvents) {
      events.push(await postEvent(workItem, config, event, index))
      index += 1
    }
    let artifactIndex = 100
    for (const artifact of executorResult.artifacts) {
      artifacts.push(await postArtifact(workItem, config, artifact, artifactIndex))
      artifactIndex += 1
    }
    const terminalEvent = executorResult.finalEvent || (executorResult.status === 'failed' ? 'node.failed' : 'node.completed')
    events.push(await postEvent(workItem, config, {
      event: terminalEvent,
      message: executorResult.finalMessage || (terminalEvent === 'node.failed' ? 'Agent 执行失败' : 'Agent 执行完成'),
    }, 900))
    const result = { ok: terminalEvent !== 'node.failed', workItem, events, artifacts, executorResult: executorResult.raw, outputDir, leaseRenewal: leaseRenewalSnapshot(leaseRenewal) }
    await writeJson(path.join(outputDir, 'last-run-result.json'), result)
    return result
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : 'Agent 执行失败'
    events.push(await postEvent(workItem, config, { event: 'node.failed', message: failureMessage }, 999).catch((postError) => ({
      error: postError instanceof Error ? postError.message : 'failed to report node.failed',
    })))
    const result = { ok: false, workItem, events, artifacts, error: failureMessage, outputDir, leaseRenewal: leaseRenewalSnapshot(leaseRenewal) }
    await writeJson(path.join(outputDir, 'last-run-result.json'), result)
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
