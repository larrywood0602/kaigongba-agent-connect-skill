#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, numberArg, parseArgs, required } from './lib.mjs'

export async function createServiceFromCapability(capabilityId, args = {}) {
  const payload = {
    serviceName: arg(args, ['service-name', 'serviceName']),
    priceCents: numberArg(arg(args, ['price-cents', 'priceCents'])),
    cycleDays: numberArg(arg(args, ['cycle-days', 'cycleDays'])),
    revisionsIncluded: numberArg(arg(args, ['revisions-included', 'revisionsIncluded'])),
  }
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === true || payload[key] === '') delete payload[key]
  }
  return apiRequest(`/api/agent-capabilities/${encodeURIComponent(capabilityId)}/create-service`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

async function main() {
  const args = parseArgs()
  const capabilityId = required(arg(args, ['capability-id', 'capabilityId']), '--capability-id')
  const result = await createServiceFromCapability(capabilityId, args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
