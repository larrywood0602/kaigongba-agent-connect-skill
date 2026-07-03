#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'

function defaultOutputDir() {
  return path.resolve(process.cwd(), '.kaigongba/runtime')
}

export function selectWorkItem(workItems = [], explicitId = '') {
  if (explicitId) {
    const selected = workItems.find((item) => item.id === explicitId)
    if (!selected) throw new Error(`Work item ${explicitId} was not found in the current queue`)
    return selected
  }
  return (
    workItems.find((item) => item.status === 'queued')
    ?? workItems.find((item) => item.status === 'revision_requested')
    ?? workItems.find((item) => item.status === 'revising')
    ?? workItems.find((item) => item.status === 'claimed')
    ?? workItems.find((item) => item.status === 'running')
    ?? null
  )
}

export async function claimWorkItem(args = {}) {
  const config = await readConnectionConfig()
  const connectionId = arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId)
  const explicitWorkItemId = arg(args, ['work-item-id', 'workItemId'], process.env.KAIGONGBA_WORK_ITEM_ID)
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

  const result = await apiRequest(`/api/agent/work-items/${encodeURIComponent(selected.id)}/claim`, { method: 'POST' })
  const outputDir = path.resolve(String(arg(args, ['output-dir', 'outputDir'], defaultOutputDir())))
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
