#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { arg, parseArgs, required, writeJson } from './lib.mjs'

function defaultStateFile() {
  return path.resolve(process.cwd(), '.kaigongba/runtime/actions.json')
}

async function readState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { actions: {} }
    throw error
  }
}

export async function recordAction(args = {}) {
  const action = required(arg(args, 'action'), '--action')
  const targetId = required(arg(args, ['target-id', 'targetId']), '--target-id')
  const actionKey = required(arg(args, ['action-key', 'actionKey']), '--action-key')
  const idempotencyKey = required(arg(args, ['idempotency-key', 'idempotencyKey']), '--idempotency-key')
  const status = String(arg(args, 'status', 'done'))
  if (!['done', 'failed', 'skipped', 'in_progress'].includes(status)) {
    throw new Error('--status must be one of done, failed, skipped, in_progress')
  }
  const retryableValue = arg(args, 'retryable')
  const stateFile = path.resolve(String(arg(args, ['state-file', 'stateFile'], defaultStateFile())))
  const state = await readState(stateFile)
  const now = new Date().toISOString()
  const previous = state.actions?.[actionKey] || {}
  const attemptCount = Number(previous.attempt_count || 0) + 1
  state.actions = state.actions || {}
  state.actions[actionKey] = {
    action,
    target_id: targetId,
    action_key: actionKey,
    idempotency_key: idempotencyKey,
    status,
    retryable: retryableValue === undefined || retryableValue === true ? null : String(retryableValue) === 'true',
    attempt_count: attemptCount,
    first_attempt_at: previous.first_attempt_at || now,
    last_attempt_at: now,
    result_summary: ['done', 'skipped'].includes(status) ? String(arg(args, ['result-summary', 'resultSummary'], '')) : previous.result_summary || '',
    last_error: status === 'failed' ? String(arg(args, ['result-summary', 'resultSummary'], '')) : '',
  }
  state.updated_at = now
  await writeJson(stateFile, state)
  return { ok: true, stateFile, actionKey, status, attemptCount }
}

async function main() {
  const args = parseArgs()
  const result = await recordAction(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
