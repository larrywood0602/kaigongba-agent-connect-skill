#!/usr/bin/env node
import path from 'node:path'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, numberArg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'

export const DEFAULT_WORK_ITEM_LEASE_SECONDS = 15 * 60

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

function attemptsRemaining(workItem = {}) {
  const attemptCount = Number(workItem.attemptCount ?? workItem.attempt_count ?? 0)
  const maxAttempts = Number(workItem.maxAttempts ?? workItem.max_attempts ?? Number.POSITIVE_INFINITY)
  if (!Number.isFinite(maxAttempts)) return true
  return (Number.isFinite(attemptCount) ? attemptCount : 0) < maxAttempts
}

function leaseExpired(workItem = {}, now = Date.now()) {
  const raw = compact(workItem.leaseExpiresAt ?? workItem.lease_expires_at)
  if (!raw) return true
  const expiresAt = Date.parse(raw)
  return !Number.isFinite(expiresAt) || expiresAt < now
}

export function isClaimableCandidate(workItem = {}, now = Date.now()) {
  if (!attemptsRemaining(workItem)) return false
  if (['queued', 'revision_requested', 'revising'].includes(compact(workItem.status))) return true
  if (['claimed', 'running'].includes(compact(workItem.status))) return leaseExpired(workItem, now)
  return false
}

export function selectWorkItem(workItems = [], explicitId = '', now = Date.now()) {
  if (explicitId) {
    const selected = workItems.find((item) => item.id === explicitId)
    if (!selected) throw new Error(`Work item ${explicitId} was not found in the current queue`)
    return selected
  }
  return (
    workItems.find((item) => item.status === 'queued' && isClaimableCandidate(item, now))
    ?? workItems.find((item) => item.status === 'revision_requested' && isClaimableCandidate(item, now))
    ?? workItems.find((item) => item.status === 'revising' && isClaimableCandidate(item, now))
    ?? workItems.find((item) => item.status === 'claimed' && isClaimableCandidate(item, now))
    ?? workItems.find((item) => item.status === 'running' && isClaimableCandidate(item, now))
    ?? null
  )
}

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

export function resolveWorkerId(args = {}, config = {}, env = process.env) {
  const explicit = compact(arg(args, ['worker-id', 'workerId'], env.KAIGONGBA_WORKER_ID || config.workerId))
  if (explicit) return explicit
  const mainAgent = config.mainAgent && typeof config.mainAgent === 'object' ? config.mainAgent : {}
  const agentId = compact(mainAgent.externalAgentId || config.externalAgentId || config.connectionId || 'agent')
  return `${agentId}@${hostname()}:${process.pid}`
}

export function resolveLeaseSeconds(args = {}, env = process.env) {
  const leaseSeconds = numberArg(
    arg(args, ['lease-seconds', 'leaseSeconds'], env.KAIGONGBA_WORK_ITEM_LEASE_SECONDS),
    DEFAULT_WORK_ITEM_LEASE_SECONDS,
  )
  return Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? Math.floor(leaseSeconds) : DEFAULT_WORK_ITEM_LEASE_SECONDS
}

export async function claimWorkItem(args = {}) {
  const config = await readConnectionConfig()
  const connectionId = arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId)
  const explicitWorkItemId = arg(args, ['work-item-id', 'workItemId'], process.env.KAIGONGBA_WORK_ITEM_ID)
  const workerId = resolveWorkerId(args, config)
  const leaseSeconds = resolveLeaseSeconds(args)
  if (!connectionId && !explicitWorkItemId) throw new Error('Pass --connection-id or --work-item-id, or run after install_and_connect.mjs')

  const queue = connectionId
    ? await apiRequest(`/api/agent/work-items?connectionId=${encodeURIComponent(connectionId)}`)
    : { workItems: [] }
  const selected = explicitWorkItemId
    ? (queue.workItems || []).find((item) => item.id === explicitWorkItemId) || { id: explicitWorkItemId }
    : selectWorkItem(queue.workItems || [])

  if (!selected?.id) {
    throw new Error('No claimable work item found. Run runtime_tick.mjs to inspect the current queue.')
  }

  const result = await apiRequest(`/api/agent/work-items/${encodeURIComponent(selected.id)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ workerId, leaseSeconds }),
  })
  const outputDir = outputDirArg(args)
  await writeJson(path.join(outputDir, 'claimed-work-item.json'), result.workItem)
  await writeJson(path.join(outputDir, 'current-work-item.json'), result.workItem)
  return {
    connection: queue.connection ?? null,
    workItem: result.workItem,
    outputDir,
  }
}

async function main() {
  const args = parseArgs()
  const result = await claimWorkItem(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
