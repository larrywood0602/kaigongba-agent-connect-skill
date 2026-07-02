#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, required } from './lib.mjs'
import { getServiceReadiness } from './readiness.mjs'

export async function publishService(serviceSopId, args = {}) {
  const force = arg(args, 'force') === true || arg(args, 'force') === 'true'
  const readiness = await getServiceReadiness(serviceSopId)
  if (!force && readiness.canPublish === false) {
    const error = new Error(`Service SOP is not ready to publish: ${(readiness.reasons || []).join('; ')}`)
    error.readiness = readiness
    throw error
  }
  const result = await apiRequest(`/api/service-sops/${encodeURIComponent(serviceSopId)}/publish`, { method: 'POST' })
  return { ...result, readiness }
}

async function main() {
  const args = parseArgs()
  const config = await readConnectionConfig()
  const serviceSopId = required(arg(args, ['service-sop-id', 'serviceSopId'], process.env.KAIGONGBA_SERVICE_SOP_ID || config.serviceSopId), '--service-sop-id')
  try {
    const result = await publishService(serviceSopId, args)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    if (error.readiness) {
      process.stderr.write(`${JSON.stringify(error.readiness, null, 2)}\n`)
      process.exit(1)
    }
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
