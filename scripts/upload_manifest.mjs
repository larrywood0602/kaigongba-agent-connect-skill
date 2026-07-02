#!/usr/bin/env node
import { apiRequest, arg, listArg, parseArgs, readConnectionConfig, readJson, writeConnectionConfig } from './lib.mjs'
import { validateManifest } from './validate_manifest.mjs'

const args = parseArgs()
const file = arg(args, 'file')
if (!file) throw new Error('Use --file manifest.json')

const manifest = await readJson(String(file))
const config = await readConnectionConfig()
const validation = validateManifest(manifest)
if (!validation.ok) {
  process.stderr.write(`${JSON.stringify(validation, null, 2)}\n`)
  process.exit(1)
}

let connectionId = arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId)
let connection = null

if (!connectionId) {
  const created = await apiRequest('/api/agent-connections', {
    method: 'POST',
    body: JSON.stringify({ mainAgent: manifest.mainAgent }),
  })
  connection = created.connection
  connectionId = connection.id
}

const scopes = listArg(arg(args, 'scopes', process.env.KAIGONGBA_SCOPES), config.scopes || ['workflows.write', 'run_events.write', 'artifacts.write'])
if (scopes.length && !config.agentToken) {
  const authorized = await apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/scopes`, {
    method: 'PATCH',
    body: JSON.stringify({ scopes }),
  })
  connection = authorized.connection
}

const uploaded = await apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/manifest`, {
  method: 'POST',
  body: JSON.stringify(manifest),
})

if (config.agentToken || config.connectionId) {
  await writeConnectionConfig({
    ...config,
    connectionId,
    serviceSopId: uploaded.serviceSop?.id,
    serviceCardId: uploaded.serviceCard?.id,
    nodeMappings: uploaded.nodeMappings,
  })
}

process.stdout.write(
  `${JSON.stringify(
    {
      connectionId,
      connection: uploaded.connection || connection,
      serviceSopId: uploaded.serviceSop?.id,
      serviceCardId: uploaded.serviceCard?.id,
      detailPath: `/app/agent-connections/${connectionId}`,
      nodeMappings: uploaded.nodeMappings,
      validation,
    },
    null,
    2,
  )}\n`,
)
