#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { apiRequest, arg, listArg, parseArgs, readJson } from './lib.mjs'

export function validateManifest(manifest) {
  const errors = []
  const warnings = []

  if (!manifest || typeof manifest !== 'object') errors.push('manifest must be a JSON object')
  if (manifest?.schemaVersion !== '1.0') warnings.push('schemaVersion should be "1.0"')
  if (!manifest?.mainAgent?.externalAgentId) errors.push('mainAgent.externalAgentId is required')
  if (!manifest?.mainAgent?.name) errors.push('mainAgent.name is required')
  if (!manifest?.serviceCard?.name) errors.push('serviceCard.name is required')
  if (!manifest?.serviceCard?.tagline) warnings.push('serviceCard.tagline is recommended for the service card cover')

  const nodes = Array.isArray(manifest?.workflow?.nodes) ? manifest.workflow.nodes : []
  if (!nodes.length) errors.push('workflow.nodes must contain at least one node')

  const keys = new Set()
  const workerIds = new Set([
    manifest?.mainAgent?.externalAgentId,
    ...(Array.isArray(manifest?.workerAgents) ? manifest.workerAgents.map((worker) => worker.externalAgentId || worker.id) : []),
  ].filter(Boolean))

  nodes.forEach((node, index) => {
    if (!node.key) errors.push(`workflow.nodes[${index}].key is required`)
    if (!node.name) errors.push(`workflow.nodes[${index}].name is required`)
    if (node.key && keys.has(node.key)) errors.push(`workflow.nodes[${index}].key duplicates "${node.key}"`)
    if (node.key) keys.add(node.key)
    if (node.ownerKind === 'external_agent' && node.sourceAgentId && !workerIds.has(node.sourceAgentId)) {
      warnings.push(`workflow.nodes[${index}].sourceAgentId "${node.sourceAgentId}" is not declared in workerAgents`)
    }
  })

  const deliverables = listArg(manifest?.serviceCard?.deliverables)
  const inputs = listArg(manifest?.serviceCard?.requiredInputs)
  if (!deliverables.length) warnings.push('serviceCard.deliverables is recommended')
  if (!inputs.length) warnings.push('serviceCard.requiredInputs is recommended')

  return { ok: errors.length === 0, errors, warnings }
}

async function main() {
  const args = parseArgs()

  if (args.schema) {
    const schema = await apiRequest('/api/agent-schemas/manifest')
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`)
    return
  }

  const file = arg(args, 'file')
  if (!file) {
    throw new Error('Use --file manifest.json or --schema')
  }

  const manifest = await readJson(String(file))
  const result = validateManifest(manifest)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
