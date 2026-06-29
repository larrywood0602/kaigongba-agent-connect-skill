#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { apiRequest, arg, mimeFromName, numberArg, parseArgs, required } from './lib.mjs'

const args = parseArgs()
const runId = required(arg(args, ['run-id', 'runId']), '--run-id')
const nodeKey = required(arg(args, ['node-key', 'nodeKey']), '--node-key')
const sequence = numberArg(arg(args, 'sequence'))
const idempotencyKey = arg(args, ['idempotency-key', 'idempotencyKey'])

if (!idempotencyKey && sequence === undefined) {
  throw new Error('Use --sequence or --idempotency-key so retries stay idempotent')
}

const filePath = arg(args, 'file')
let fileStats = null
if (filePath) {
  fileStats = await fs.stat(String(filePath))
}

const name = String(arg(args, 'name', filePath ? path.basename(String(filePath)) : '阶段结果文件'))
const type = String(arg(args, 'type', path.extname(name).slice(1) || 'file'))
const mimeType = String(arg(args, ['mime-type', 'mimeType'], mimeFromName(name, type)))
const sizeBytes = numberArg(arg(args, ['size-bytes', 'sizeBytes']), fileStats?.size || 0)
const externalArtifactId = String(arg(args, ['external-artifact-id', 'externalArtifactId'], `${runId}-${nodeKey}-${name}`))

let externalUrl = arg(args, ['external-url', 'externalUrl'])
let uploadId = arg(args, ['upload-id', 'uploadId'])
if (!externalUrl && !uploadId) {
  const upload = await apiRequest('/api/artifacts/upload-url', {
    method: 'POST',
    body: JSON.stringify({
      connectionId: arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID),
      runId,
      nodeKey,
      name,
      type,
      mimeType,
      sizeBytes,
    }),
  })
  externalUrl = upload.uploadUrl
  uploadId = upload.uploadId
}

const payload = {
  connectionId: arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID),
  serviceSopId: arg(args, ['service-sop-id', 'serviceSopId'], process.env.KAIGONGBA_SERVICE_SOP_ID),
  nodeKey,
  event: 'artifact.created',
  status: 'submitted',
  sequence,
  idempotencyKey: idempotencyKey || `${runId}-${nodeKey}-artifact-${sequence}`,
  artifact: {
    externalArtifactId,
    name,
    type,
    mimeType,
    sizeBytes,
    externalUrl,
    uploadId,
  },
}

const sourceAgentId = arg(args, ['source-agent-id', 'sourceAgentId'])
const sourceAgentName = arg(args, ['source-agent-name', 'sourceAgentName'])
if (sourceAgentId || sourceAgentName) payload.sourceAgent = { id: sourceAgentId, name: sourceAgentName }

const reporterId = arg(args, ['reported-by-agent-id', 'reportedByAgentId'], process.env.KAIGONGBA_MAIN_AGENT_ID)
const reporterName = arg(args, ['reported-by-agent-name', 'reportedByAgentName'], process.env.KAIGONGBA_MAIN_AGENT_NAME)
if (reporterId || reporterName) payload.reportedByAgent = { id: reporterId, name: reporterName }

for (const key of Object.keys(payload)) {
  if (payload[key] === undefined || payload[key] === true || payload[key] === '') delete payload[key]
}
for (const key of Object.keys(payload.artifact)) {
  if (payload.artifact[key] === undefined || payload.artifact[key] === true || payload.artifact[key] === '') delete payload.artifact[key]
}

const result = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}/events`, {
  method: 'POST',
  body: JSON.stringify(payload),
})

process.stdout.write(`${JSON.stringify({ ...result, artifact: payload.artifact }, null, 2)}\n`)
