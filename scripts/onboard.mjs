#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { arg, parseArgs, writeJson } from './lib.mjs'
import { discoverCapabilities } from './discover_capabilities.mjs'
import { manifestFromDiscovery } from './manifest_from_discovery.mjs'
import { startReviewServer } from './review_manifest_server.mjs'
import { uploadManifest } from './upload_manifest.mjs'
import { validateManifest } from './validate_manifest.mjs'

export async function runOnboard(args = {}) {
  const discoveryFile = String(arg(args, ['discovery-file', 'discoveryFile'], 'discovery.json'))
  const manifestFile = String(arg(args, ['manifest-file', 'manifestFile'], 'manifest.json'))
  const discovery = await discoverCapabilities({
    sourceDirs: arg(args, ['source-dir', 'sourceDir'], process.env.KAIGONGBA_DISCOVERY_DIRS),
    maxDepth: arg(args, 'max-depth', 4),
    maxFiles: arg(args, 'max-files', 300),
    mainAgentId: arg(args, ['main-agent-id', 'mainAgentId']),
    mainAgentName: arg(args, ['main-agent-name', 'mainAgentName']),
  })
  await writeJson(discoveryFile, discovery)

  const manifest = manifestFromDiscovery(discovery, {
    skills: arg(args, 'skills'),
    workflows: arg(args, 'workflows'),
    cases: arg(args, 'cases'),
    serviceName: arg(args, ['service-name', 'serviceName']),
    tagline: arg(args, ['summary', 'tagline']),
    category: arg(args, 'category'),
    deliverables: arg(args, 'deliverables'),
    requiredInputs: arg(args, ['required-inputs', 'requiredInputs']),
    targetCustomers: arg(args, ['target-customers', 'targetCustomers']),
    riskBoundaries: arg(args, ['risk-boundaries', 'riskBoundaries']),
    acceptanceCriteria: arg(args, ['acceptance-criteria', 'acceptanceCriteria']),
    humanName: arg(args, ['human-name', 'humanName']),
    humanRole: arg(args, ['human-role', 'humanRole']),
    humanBio: arg(args, ['human-bio', 'humanBio']),
    mainAgentId: arg(args, ['main-agent-id', 'mainAgentId']),
    mainAgentName: arg(args, ['main-agent-name', 'mainAgentName']),
    endpoint: arg(args, 'endpoint'),
  })
  await writeJson(manifestFile, manifest)

  const validation = validateManifest(manifest)
  if (!validation.ok && arg(args, ['yes', 'upload']) === true) {
    return { ok: false, discoveryFile, manifestFile, discovery, validation }
  }

  if (arg(args, ['yes', 'upload']) === true) {
    const uploaded = await uploadManifest(manifest, args)
    return { ok: true, uploaded: true, discoveryFile, manifestFile, discovery, validation, ...uploaded }
  }

  const { url } = await startReviewServer({
    manifestFile,
    port: Number(arg(args, 'port', 5678)),
    host: String(arg(args, 'host', '127.0.0.1')),
  })
  return { ok: validation.ok, uploaded: false, discoveryFile, manifestFile, discovery, validation, reviewUrl: url }
}

async function main() {
  const args = parseArgs()
  const result = await runOnboard(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok && !result.reviewUrl) process.exit(1)
  if (result.reviewUrl) {
    process.stdout.write(`\nOpen ${result.reviewUrl} to confirm and upload this Agent service.\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
