#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, parseArgs, readConnectionConfig, readJson, required, stableKey } from './lib.mjs'

function normalizeCapability(item = {}, index = 0) {
  const name = String(item.name || item.title || '').trim()
  if (!name) return null
  const externalId = String(item.externalId || item.external_id || item.id || stableKey(name, `capability_${index + 1}`))
  const sourceKind = String(item.sourceKind || item.source_kind || item.capabilityType || item.capability_type || 'skill')
  const capabilityType = String(item.capabilityType || item.capability_type || 'skill')
  const sourcePath = String(item.sourcePath || item.source_path || '')
  return {
    ...item,
    externalId,
    name,
    description: String(item.description || item.summary || item.tagline || ''),
    capabilityType,
    status: String(item.status || 'active'),
    listingStatus: String(item.listingStatus || item.listing_status || 'not_listed'),
    sourceKind,
    sourcePath,
    sourceFingerprint: String(
      item.sourceFingerprint
        || item.source_fingerprint
        || stableKey([sourceKind, capabilityType, externalId, name, sourcePath].filter(Boolean).join('|'), `capability_${index + 1}`),
    ),
    tags: Array.isArray(item.tags) && item.tags.length ? item.tags : [name],
    targetCustomers: Array.isArray(item.targetCustomers) && item.targetCustomers.length ? item.targetCustomers : [`需要${name}能力交付的客户`],
    deliverables: Array.isArray(item.deliverables) && item.deliverables.length ? item.deliverables : [`${name}执行结果`],
    requiredInputs: Array.isArray(item.requiredInputs) && item.requiredInputs.length ? item.requiredInputs : ['任务目标与业务上下文', '明确的验收标准'],
    riskBoundaries: Array.isArray(item.riskBoundaries) && item.riskBoundaries.length ? item.riskBoundaries : ['不处理未授权的隐私资料、密钥或受限数据'],
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria) && item.acceptanceCriteria.length ? item.acceptanceCriteria : ['交付物可查看', '结果满足用户提供的验收标准'],
    metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
  }
}

function capabilitiesFromDiscovery(discovery = {}) {
  const skills = Array.isArray(discovery.skills) ? discovery.skills : []
  return skills.map((skill, index) => normalizeCapability({
    externalId: skill.id,
    name: skill.title || skill.name,
    description: skill.description,
    capabilityType: 'skill',
    sourceKind: skill.sourceKind || 'skill',
    sourcePath: skill.sourcePath || '',
    tags: [skill.name || skill.title].filter(Boolean),
  }, index)).filter(Boolean)
}

export function capabilitiesFromPayload(payload = {}) {
  if (Array.isArray(payload.capabilities)) return payload.capabilities.map(normalizeCapability).filter(Boolean)
  if (payload.discovery && typeof payload.discovery === 'object') return capabilitiesFromDiscovery(payload.discovery)
  if (Array.isArray(payload.skills)) return capabilitiesFromDiscovery({ skills: payload.skills })
  return capabilitiesFromDiscovery(payload)
}

export async function syncCapabilities(capabilities, args = {}) {
  const config = await readConnectionConfig()
  const connectionId = required(arg(args, ['connection-id', 'connectionId'], process.env.KAIGONGBA_CONNECTION_ID || config.connectionId), '--connection-id')
  const payload = {
    capabilities,
    replace: arg(args, 'replace') === true || arg(args, 'replace') === 'true',
  }
  return apiRequest(`/api/agent-connections/${encodeURIComponent(connectionId)}/capabilities/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function syncCapabilitiesFromFile(file, args = {}) {
  const payload = await readJson(String(file))
  const capabilities = capabilitiesFromPayload(payload)
  if (!capabilities.length) throw new Error('No capabilities found in file')
  return syncCapabilities(capabilities, args)
}

async function main() {
  const args = parseArgs()
  const file = arg(args, 'file')
  if (!file) throw new Error('Use --file manifest.json or discovery.json')
  const result = await syncCapabilitiesFromFile(file, args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
