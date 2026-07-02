#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, readJson, required } from './lib.mjs'
import { capabilitiesFromPayload, syncCapabilities } from './sync_capabilities.mjs'
import { createServiceFromCapability } from './create_service_from_capability.mjs'
import { getServiceReadiness } from './readiness.mjs'

function assertCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details })
}

function findCapability(capabilities, args = {}) {
  const capabilityId = arg(args, ['capability-id', 'capabilityId'])
  const externalId = arg(args, ['external-id', 'externalId'])
  if (capabilityId) return capabilities.find((item) => item.id === capabilityId)
  if (externalId) return capabilities.find((item) => item.externalId === externalId)
  return capabilities[0]
}

async function listCapabilities(connectionId) {
  return apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/capabilities`)
}

export async function verifyRealPlatform(args = {}) {
  const checks = []
  const config = await readConnectionConfig()
  const connectionId = required(arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId), '--connection-id')

  const schema = await apiRequest('/api/agent-schemas/manifest')
  assertCheck(checks, 'manifest_schema_available', schema.schemaVersion === '1.0', { schemaVersion: schema.schemaVersion })
  assertCheck(checks, 'schema_supports_capability_inventory', Array.isArray(schema.modes) && schema.modes.includes('capability_inventory'), {
    modes: schema.modes || [],
  })
  assertCheck(checks, 'schema_lists_capability_fields', Array.isArray(schema.capabilityFields) && schema.capabilityFields.includes('acceptanceCriteria'), {
    capabilityFields: schema.capabilityFields || [],
  })

  const detail = await apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}`)
  assertCheck(checks, 'connection_connected', detail.connection?.status === 'connected', { status: detail.connection?.status })
  assertCheck(checks, 'connection_has_required_scopes', ['workflows.write', 'run_events.write'].every((scope) => detail.connection?.scopes?.includes(scope)), {
    scopes: detail.connection?.scopes || [],
  })

  let synced = null
  const manifestFile = arg(args, ['manifest-file', 'manifestFile', 'file'])
  if (manifestFile && (arg(args, 'sync') === true || arg(args, 'sync') === 'true')) {
    const manifest = await readJson(String(manifestFile))
    const capabilities = capabilitiesFromPayload(manifest)
    synced = await syncCapabilities(capabilities, { ...args, connectionId })
    assertCheck(checks, 'capabilities_synced_real_platform', Array.isArray(synced.capabilities) && synced.capabilities.length === capabilities.length, {
      requestedCount: capabilities.length,
      syncedCount: synced.capabilities?.length || 0,
    })
  }

  const listed = await listCapabilities(connectionId)
  const capabilities = listed.capabilities || []
  assertCheck(checks, 'capabilities_readback_available', capabilities.length > 0, { count: capabilities.length })
  assertCheck(checks, 'capabilities_have_platform_ids', capabilities.every((item) => item.id && item.connectionId === connectionId), {
    count: capabilities.length,
  })

  let service = null
  let readiness = null
  if (arg(args, ['create-draft', 'createDraft']) === true || arg(args, ['create-draft', 'createDraft']) === 'true') {
    const capability = findCapability(capabilities, args)
    if (!capability?.id) throw new Error('No capability available for draft service creation')
    service = await createServiceFromCapability(capability.id, args)
    const serviceSopId = service.serviceSop?.id || service.serviceSopId
    assertCheck(checks, 'draft_service_created_from_capability', Boolean(serviceSopId), {
      capabilityId: capability.id,
      externalId: capability.externalId,
      serviceSopId,
    })
    readiness = await getServiceReadiness(serviceSopId)
    assertCheck(checks, 'readiness_checked_for_draft_service', Boolean(readiness.status), {
      serviceSopId,
      status: readiness.status,
      canPublish: readiness.canPublish,
      reasons: readiness.reasons || [],
    })
  }

  const runs = await apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/runs`)
  assertCheck(checks, 'runs_endpoint_available', Array.isArray(runs.runs), { runCount: runs.runs?.length || 0 })

  const ok = checks.every((check) => check.passed)
  return {
    ok,
    connectionId,
    apiBaseUrl: config.apiBaseUrl,
    checks,
    synced,
    service,
    readiness,
    runs: {
      runCount: runs.runs?.length || 0,
      serviceSopId: runs.serviceSop?.id || null,
    },
  }
}

async function main() {
  const args = parseArgs()
  const result = await verifyRealPlatform(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
