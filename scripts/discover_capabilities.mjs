#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { arg, listArg, parseArgs, stableKey, writeJson } from './lib.mjs'

const SKIP_DIRS = new Set(['.git', '.kaigongba', 'node_modules', 'dist', 'build', '.next', '.cache'])
const CASE_EXTENSIONS = new Set(['.pdf', '.pptx', '.docx', '.xlsx', '.png', '.jpg', '.jpeg', '.md', '.txt'])

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readText(filePath, maxBytes = 20000) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function parseSkillMarkdown(raw, fallbackName) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)
  const yaml = frontmatter?.[1] ?? ''
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || stableKey(fallbackName, 'external_skill')
  const description = yaml.match(/^description:\s*([\s\S]*?)(?:\n[a-zA-Z_-]+:|\n---|$)/m)?.[1]?.replace(/\n\s+/g, ' ').trim() || ''
  const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return { name, description, title: heading || name }
}

async function walk(rootDir, { maxDepth = 4, maxFiles = 300 } = {}) {
  const root = path.resolve(rootDir)
  const results = []
  async function visit(dir, depth) {
    if (depth > maxDepth || results.length >= maxFiles) return
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        results.push(path.join(dir, entry.name))
      }
    }
  }
  await visit(root, 0)
  return results
}

function uniquePaths(paths) {
  return [...new Set(paths.map((item) => path.resolve(item)).filter(Boolean))]
}

function defaultSourceDirs() {
  return [
    process.cwd(),
    path.join(os.homedir(), '.codex/skills'),
    path.join(os.homedir(), '.agents/skills'),
  ]
}

function workflowFromManifest(payload, filePath) {
  const nodes = Array.isArray(payload?.workflow?.nodes) ? payload.workflow.nodes : []
  if (!nodes.length) return null
  return {
    id: stableKey(payload?.serviceCard?.name || path.basename(filePath), 'workflow'),
    name: payload?.serviceCard?.name || payload?.workflow?.name || path.basename(filePath),
    sourcePath: filePath,
    summary: payload?.serviceCard?.tagline || payload?.description || '',
    nodes: nodes.map((node, index) => ({
      key: node.key || `node_${index + 1}`,
      name: node.name || `节点 ${index + 1}`,
      ownerKind: node.ownerKind || (node.requiresHuman ? 'human' : 'external_agent'),
      sourceAgentId: node.sourceAgentId || '',
      requiresHuman: Boolean(node.requiresHuman),
      isAuto: node.isAuto !== false,
      artifactTypes: Array.isArray(node.artifactTypes) ? node.artifactTypes : [],
    })),
  }
}

export async function discoverCapabilities(options = {}) {
  const explicitSources = listArg(options.sourceDirs ?? options.sourceDir)
  const sourceDirs = uniquePaths(explicitSources.length ? explicitSources : defaultSourceDirs())
  const skills = []
  const workflows = []
  const cases = []
  const seenSkills = new Set()
  const seenWorkflows = new Set()
  const seenCases = new Set()

  for (const sourceDir of sourceDirs) {
    if (!(await exists(sourceDir))) continue
    const files = await walk(sourceDir, { maxDepth: Number(options.maxDepth ?? 4), maxFiles: Number(options.maxFiles ?? 300) })
    for (const filePath of files) {
      const basename = path.basename(filePath)
      const ext = path.extname(filePath).toLowerCase()

      if (basename === 'SKILL.md') {
        const raw = await readText(filePath)
        const parsed = parseSkillMarkdown(raw, path.basename(path.dirname(filePath)))
        const id = stableKey(parsed.name, 'skill')
        if (!seenSkills.has(id)) {
          seenSkills.add(id)
          skills.push({
            id,
            name: parsed.name,
            title: parsed.title,
            description: parsed.description,
            sourcePath: filePath,
          })
        }
      }

      if (ext === '.json' && !filePath.includes(`${path.sep}.kaigongba${path.sep}`)) {
        try {
          const payload = JSON.parse(await readText(filePath))
          const workflow = workflowFromManifest(payload, filePath)
          if (workflow && !seenWorkflows.has(workflow.id)) {
            seenWorkflows.add(workflow.id)
            workflows.push(workflow)
          }
        } catch {
          // Ignore non-manifest JSON files.
        }
      }

      const caseLikePath = filePath.split(path.sep).some((segment) => ['case', 'cases', 'example', 'examples', 'assets'].includes(segment.toLowerCase()))
      if (caseLikePath && CASE_EXTENSIONS.has(ext)) {
        const id = stableKey(path.basename(filePath, ext), 'case')
        if (!seenCases.has(id)) {
          seenCases.add(id)
          cases.push({
            id,
            title: path.basename(filePath, ext),
            type: ext.slice(1) || 'file',
            sourcePath: filePath,
          })
        }
      }
    }
  }

  return {
    schemaVersion: '1.0',
    discoveredAt: new Date().toISOString(),
    sourceDirs,
    skills,
    workflows,
    cases,
    agents: [
      {
        externalAgentId: String(options.mainAgentId || 'openclaw_orchestrator'),
        name: String(options.mainAgentName || 'OpenClaw Orchestrator'),
        role: 'orchestrator',
      },
    ],
  }
}

async function main() {
  const args = parseArgs()
  const discovery = await discoverCapabilities({
    sourceDirs: arg(args, ['source-dir', 'sourceDir'], process.env.KAIGONGBA_DISCOVERY_DIRS),
    maxDepth: arg(args, 'max-depth', 4),
    maxFiles: arg(args, 'max-files', 300),
    mainAgentId: arg(args, ['main-agent-id', 'mainAgentId']),
    mainAgentName: arg(args, ['main-agent-name', 'mainAgentName']),
  })
  await writeJson(String(arg(args, 'out', 'discovery.json')), discovery)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
