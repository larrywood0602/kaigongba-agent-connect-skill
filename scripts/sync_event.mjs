#!/usr/bin/env node
import { apiRequest, arg, defaultStatus, numberArg, parseArgs, readConnectionConfig, required } from './lib.mjs'

const args = parseArgs()
const config = await readConnectionConfig()
const runId = required(arg(args, ['run-id', 'runId']), '--run-id')
const eventType = required(arg(args, ['event', 'event-type', 'eventType']), '--event')
const nodeKey = arg(args, ['node-key', 'nodeKey'])
const sequence = numberArg(arg(args, 'sequence'))
const idempotencyKey = arg(args, ['idempotency-key', 'idempotencyKey'])

if (!idempotencyKey && sequence === undefined) {
  throw new Error('Use --sequence or --idempotency-key so retries stay idempotent')
}

const payload = {
  connectionId: arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId),
  serviceSopId: arg(args, ['service-sop-id', 'serviceSopId'], process.env.KAIGONGBA_SERVICE_SOP_ID || config.serviceSopId),
  nodeKey,
  event: eventType,
  status: arg(args, 'status', defaultStatus(eventType)),
  progress: numberArg(arg(args, 'progress')),
  message: arg(args, 'message'),
  sequence,
  idempotencyKey: idempotencyKey || `${runId}-${nodeKey || 'run'}-${eventType}-${sequence}`,
}

const sourceAgentId = arg(args, ['source-agent-id', 'sourceAgentId'])
const sourceAgentName = arg(args, ['source-agent-name', 'sourceAgentName'])
if (sourceAgentId || sourceAgentName) {
  payload.sourceAgent = { id: sourceAgentId, name: sourceAgentName }
}

const reporterId = arg(args, ['reported-by-agent-id', 'reportedByAgentId'], process.env.KAIGONGBA_MAIN_AGENT_ID || config.mainAgent?.externalAgentId)
const reporterName = arg(args, ['reported-by-agent-name', 'reportedByAgentName'], process.env.KAIGONGBA_MAIN_AGENT_NAME || config.mainAgent?.name)
if (reporterId || reporterName) {
  payload.reportedByAgent = { id: reporterId, name: reporterName }
}

for (const key of Object.keys(payload)) {
  if (payload[key] === undefined || payload[key] === true || payload[key] === '') delete payload[key]
}

const result = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}/events`, {
  method: 'POST',
  body: JSON.stringify(payload),
})

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
