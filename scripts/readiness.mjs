#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, required } from './lib.mjs'

export async function getServiceReadiness(serviceSopId) {
  return apiRequest(`/api/service-sops/${encodeURIComponent(serviceSopId)}/readiness`)
}

async function main() {
  const args = parseArgs()
  const config = await readConnectionConfig()
  const serviceSopId = required(arg(args, ['service-sop-id', 'serviceSopId'], process.env.KAIGONGBA_SERVICE_SOP_ID || config.serviceSopId), '--service-sop-id')
  const result = await getServiceReadiness(serviceSopId)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
