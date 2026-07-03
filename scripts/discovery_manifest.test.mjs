import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCapabilities } from './discover_capabilities.mjs'
import { manifestFromDiscovery } from './manifest_from_discovery.mjs'
import { resolveMainAgent } from './lib.mjs'

let tempDir
let previousCwd

beforeEach(async () => {
  previousCwd = process.cwd()
  tempDir = await mkdtemp(join(tmpdir(), 'kgb-agent-discovery-'))
  process.chdir(tempDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await rm(tempDir, { recursive: true, force: true })
})

async function writeSkill(dirName, name, description) {
  const skillDir = join(tempDir, dirName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  )
}

describe('kaigongba agent capability discovery', () => {
  it('defaults to the current agent project and does not scan global Codex skill libraries', async () => {
    await writeSkill('seller-agent', 'seller-agent', '真实卖方 Agent 技能')
    const cwd = process.cwd()

    const discovery = await discoverCapabilities({ maxDepth: 3, maxFiles: 30 })

    expect(discovery.sourceDirs).toEqual([cwd])
    expect(discovery.skills.map((skill) => skill.name)).toEqual(['seller-agent'])
    expect(discovery.skills.some((skill) => String(skill.name).includes('imagegen'))).toBe(false)
  })

  it('keeps multiple discovered skills as service capabilities instead of expanding each skill into a SOP node', async () => {
    const discovery = {
      schemaVersion: '1.0',
      sourceDirs: [tempDir],
      warnings: [],
      agents: [{ provider: 'custom', externalAgentId: 'seller_orchestrator', name: 'Seller Orchestrator', endpoint: 'seller://agent' }],
      skills: [
        { id: 'skill_design', name: 'design', title: 'Design Skill', description: '生成视觉方案', sourcePath: join(tempDir, 'design/SKILL.md') },
        { id: 'skill_copy', name: 'copy', title: 'Copy Skill', description: '生成文案', sourcePath: join(tempDir, 'copy/SKILL.md') },
      ],
      workflows: [],
      cases: [],
    }

    const manifest = manifestFromDiscovery(discovery, { serviceName: '营销物料 Agent' })

    expect(manifest.serviceCard.tags).toEqual(['design', 'copy'])
    expect(manifest.capabilities.map((capability) => capability.name)).toEqual(['Design Skill', 'Copy Skill'])
    expect(manifest.discoverySummary.skillCount).toBe(2)
    expect(manifest.workflow.nodes).toEqual([])
  })

  it('names capability-only manifests as an inventory when no workflow is selected', async () => {
    const discovery = {
      schemaVersion: '1.0',
      sourceDirs: [tempDir],
      warnings: [],
      agents: [{ provider: 'custom', externalAgentId: 'seller_orchestrator', name: 'Seller Orchestrator', endpoint: 'seller://agent' }],
      skills: [
        { id: 'skill_design', name: 'design', title: 'Design Skill', description: '生成视觉方案', sourcePath: join(tempDir, 'design/SKILL.md') },
        { id: 'skill_copy', name: 'copy', title: 'Copy Skill', description: '生成文案', sourcePath: join(tempDir, 'copy/SKILL.md') },
      ],
      workflows: [],
      cases: [],
    }

    const manifest = manifestFromDiscovery(discovery)

    expect(manifest.serviceCard.name).toBe('Seller Orchestrator 能力清单')
    expect(manifest.serviceCard.tagline).toBe('同步外部 Agent 技能为平台能力，等待选择后创建可接单服务 SOP')
    expect(manifest.workflow.nodes).toEqual([])
  })

  it('does not silently default an unknown connection to OpenClaw or Codex', async () => {
    expect(() => resolveMainAgent({}, {})).toThrow(/Unable to determine external Agent identity/)

    const codexAgent = resolveMainAgent({ provider: 'codex' }, {})
    expect(codexAgent).toMatchObject({
      provider: 'codex',
      externalAgentId: 'codex_orchestrator',
      name: 'Codex Agent',
      endpoint: 'codex://agent',
    })

    const discovery = await discoverCapabilities({ maxDepth: 1, maxFiles: 5 })
    expect(discovery.agents).toEqual([])
    expect(discovery.warnings.join('\n')).toContain('未识别外部 Agent 身份')
  })
})
