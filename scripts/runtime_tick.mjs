#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, writeJson } from './lib.mjs'

function defaultOutputDir() {
  return path.resolve(process.cwd(), '.kaigongba/runtime')
}

export async function runRuntimeTick(args = {}) {
  const config = await readConnectionConfig()
  const connectionId = arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId)
  if (!connectionId) throw new Error('No connectionId found. Run install_and_connect.mjs or pass --connection-id.')
  const result = await apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/runs`)
  const workItemsResult = await apiRequest(`/api/agent/work-items?connectionId=${encodeURIComponent(connectionId)}`)
  const pendingRuns = Array.isArray(result.runs) ? result.runs : []
  const pendingWorkItems = Array.isArray(workItemsResult.workItems) ? workItemsResult.workItems : []
  const outputDir = path.resolve(String(arg(args, ['output-dir', 'outputDir'], defaultOutputDir())))
  await writeJson(path.join(outputDir, 'pending-runs.json'), pendingRuns)
  await writeJson(path.join(outputDir, 'pending-work-items.json'), pendingWorkItems)
  await writeJson(path.join(outputDir, 'latest-state.json'), {
    connectionId,
    serviceSopId: result.serviceSop?.id || config.serviceSopId || null,
    pendingRunCount: pendingRuns.length,
    pendingWorkItemCount: pendingWorkItems.length,
    checkedAt: new Date().toISOString(),
  })
  return { ...result, pendingRuns, pendingWorkItems, workItemConnection: workItemsResult.connection ?? null, outputDir }
}

async function main() {
  const args = parseArgs()
  const result = await runRuntimeTick(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
