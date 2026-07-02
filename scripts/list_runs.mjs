#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig } from './lib.mjs'

export async function listRuns(args = {}) {
  const config = await readConnectionConfig()
  const connectionId = arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId)
  if (!connectionId) throw new Error('No connectionId found. Run install_and_connect.mjs or pass --connection-id.')
  return apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/runs`)
}

function printSummary(result) {
  const runs = Array.isArray(result.runs) ? result.runs : []
  process.stdout.write(`connectionId: ${result.connection?.id ?? 'unknown'}\n`)
  process.stdout.write(`serviceSopId: ${result.serviceSop?.id ?? 'none'}\n`)
  process.stdout.write(`runs: ${runs.length}\n`)
  for (const run of runs) {
    process.stdout.write('\n')
    process.stdout.write(`runId: ${run.runId}\n`)
    process.stdout.write(`order: ${run.order?.orderNo ?? run.order?.id ?? 'unknown'} · ${run.order?.status ?? 'unknown'}\n`)
    process.stdout.write(`title: ${run.order?.title ?? run.requirement?.title ?? 'untitled'}\n`)
    process.stdout.write(`currentNode: ${run.currentNode?.name ?? 'not_started'}\n`)
    process.stdout.write(`requirement: ${run.requirement?.goal ?? 'none'}\n`)
  }
}

async function main() {
  const args = parseArgs()
  const result = await listRuns(args)
  if (arg(args, 'summary') === true) printSummary(result)
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
