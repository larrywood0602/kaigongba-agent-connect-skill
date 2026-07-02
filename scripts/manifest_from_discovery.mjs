#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { arg, listArg, parseArgs, readJson, stableKey, writeJson } from './lib.mjs'

function normalizeList(value, fallback = []) {
  const items = listArg(value)
  return items.length ? items : fallback
}

function selectedItems(items, selectedIds) {
  if (!selectedIds.length) return items
  const selected = new Set(selectedIds)
  return items.filter((item) => selected.has(item.id) || selected.has(item.name) || selected.has(item.title))
}

function nodeFromDiscoveredNode(node, index, workerId) {
  const ownerKind = node.ownerKind === 'human' ? 'human' : 'external_agent'
  return {
    key: stableKey(node.key || node.name, `node_${index + 1}`),
    name: node.name || `节点 ${index + 1}`,
    ownerKind,
    sourceAgentId: ownerKind === 'human' ? 'human_owner' : node.sourceAgentId || workerId,
    isAuto: ownerKind !== 'human' && node.isAuto !== false,
    requiresHuman: ownerKind === 'human' || Boolean(node.requiresHuman),
    artifactTypes: Array.isArray(node.artifactTypes) && node.artifactTypes.length ? node.artifactTypes : ownerKind === 'human' ? [] : ['file'],
  }
}

function uniqueNodeKey(baseKey, usedKeys) {
  let key = stableKey(baseKey, 'node')
  let index = 2
  while (usedKeys.has(key)) {
    key = `${stableKey(baseKey, 'node')}_${index}`
    index += 1
  }
  usedKeys.add(key)
  return key
}

function normalizeNodes(nodes) {
  const usedKeys = new Set()
  return nodes.map((node, index) => ({
    ...node,
    key: uniqueNodeKey(node.key || node.name || `node_${index + 1}`, usedKeys),
  }))
}

export function manifestFromDiscovery(discovery, options = {}) {
  const selectedSkillIds = normalizeList(options.skills)
  const selectedWorkflowIds = normalizeList(options.workflows)
  const selectedCaseIds = normalizeList(options.cases)
  const skills = selectedItems(Array.isArray(discovery.skills) ? discovery.skills : [], selectedSkillIds)
  const workflows = selectedItems(Array.isArray(discovery.workflows) ? discovery.workflows : [], selectedWorkflowIds)
  const cases = selectedItems(Array.isArray(discovery.cases) ? discovery.cases : [], selectedCaseIds).slice(0, 12)

  const primarySkill = skills[0]
  const primaryWorkflow = workflows[0]
  const hasRealSource = skills.length + workflows.length + cases.length > 0
  const serviceName = String(options.serviceName || primaryWorkflow?.name || primarySkill?.title || primarySkill?.name || (hasRealSource ? '外部 Agent 服务 SOP' : '待选择真实 Agent 技能来源'))
  const serviceKey = stableKey(serviceName, 'external_agent_service')
  const workerId = String(options.workerId || `${serviceKey}_worker`)
  const mainAgent = Array.isArray(discovery.agents) && discovery.agents[0] ? discovery.agents[0] : {}

  const discoveredNodes = workflows.length
    ? workflows.flatMap((workflow) => workflow.nodes || []).map((node, index) => nodeFromDiscoveredNode(node, index, workerId))
    : skills.map((skill, index) => ({
        key: stableKey(skill.name || skill.title, `external_skill_${index + 1}`),
        name: skill.title || skill.name || `外部技能 ${index + 1}`,
        ownerKind: 'external_agent',
        sourceAgentId: workerId,
        isAuto: true,
        requiresHuman: false,
        artifactTypes: ['file'],
      }))

  const hasOpeningHuman = discoveredNodes.some((node, index) => index < 2 && node.ownerKind === 'human')
  const hasClosingHuman = discoveredNodes.some((node, index) => index >= discoveredNodes.length - 2 && node.ownerKind === 'human')
  const workflowNodes = normalizeNodes([
    ...(hasOpeningHuman ? [] : [{
      key: 'brief',
      name: '需求确认',
      ownerKind: 'human',
      sourceAgentId: 'human_owner',
      isAuto: false,
      requiresHuman: true,
      artifactTypes: [],
    }]),
    ...discoveredNodes,
    ...(hasClosingHuman ? [] : [{
      key: 'delivery',
      name: '交付验收',
      ownerKind: 'human',
      sourceAgentId: 'human_owner',
      isAuto: false,
      requiresHuman: true,
      artifactTypes: [],
    }]),
  ])

  const workerIds = [...new Set(workflowNodes.filter((node) => node.ownerKind !== 'human').map((node) => node.sourceAgentId || workerId))]

  const deliverables = normalizeList(options.deliverables, ['阶段结果文件', '最终交付物', '交付说明'])
  const requiredInputs = normalizeList(options.requiredInputs, ['客户需求说明', '参考资料', '验收标准'])
  const targetCustomers = normalizeList(options.targetCustomers, ['需要可托管交付的客户', '已有明确结果需求的买服务用户'])

  return {
    schemaVersion: '1.0',
    mainAgent: {
      externalAgentId: String(options.mainAgentId || mainAgent.externalAgentId || 'openclaw_orchestrator'),
      name: String(options.mainAgentName || mainAgent.name || 'OpenClaw Orchestrator'),
      version: String(options.mainAgentVersion || '1.0.0'),
      endpoint: String(options.endpoint || 'openclaw://agent'),
    },
    workerAgents: [
      ...workerIds.map((id, index) => ({
        externalAgentId: id,
        name: index === 0 ? String(options.workerName || 'External Production Agent') : id,
        role: 'worker',
      })),
      {
        externalAgentId: 'human_owner',
        name: String(options.humanName || '服务负责人'),
        role: 'human_owner',
      },
    ],
    serviceCard: {
      name: serviceName,
      tagline: String(options.tagline || primarySkill?.description || primaryWorkflow?.summary || '把外部 Agent 能力变成可接单、可跟踪、可验收的服务 SOP'),
      category: String(options.category || '外部 Agent 服务'),
      targetCustomers,
      deliverables,
      requiredInputs,
      automationLevel: String(options.automationLevel || 'semi_auto'),
      humanProfile: {
        name: String(options.humanName || '服务负责人'),
        role: String(options.humanRole || '报价与终审负责人'),
        bio: String(options.humanBio || '负责确认客户需求、报价边界、交付验收和长期规则写入。'),
        responsibleNodes: ['需求确认', '交付验收'],
      },
      riskBoundaries: normalizeList(options.riskBoundaries, ['不承诺超出服务范围的业务结果', '不上传未授权的客户隐私资料']),
      acceptanceCriteria: normalizeList(options.acceptanceCriteria, ['阶段文件可查看', '交付内容符合需求卡', '人工确认节点已完成']),
      tags: skills.slice(0, 8).map((skill) => skill.name || skill.title),
      cases: cases.map((item) => ({
        title: item.title,
        type: item.type,
      })),
    },
    workflow: {
      nodes: hasRealSource ? workflowNodes : [],
    },
    discoverySummary: {
      skillCount: skills.length,
      workflowCount: workflows.length,
      caseCount: cases.length,
      requiresSourceSelection: !hasRealSource,
      sourceDirs: Array.isArray(discovery.sourceDirs) ? discovery.sourceDirs : [],
      warnings: Array.isArray(discovery.warnings) ? discovery.warnings : [],
      selectedSkillIds: skills.map((item) => item.id),
      selectedWorkflowIds: workflows.map((item) => item.id),
      selectedCaseIds: cases.map((item) => item.id),
      selectedSourcePaths: [
        ...skills.map((item) => item.sourcePath).filter(Boolean),
        ...workflows.map((item) => item.sourcePath).filter(Boolean),
        ...cases.map((item) => item.sourcePath).filter(Boolean),
      ],
    },
  }
}

async function main() {
  const args = parseArgs()
  const discovery = await readJson(String(arg(args, 'file', 'discovery.json')))
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
  await writeJson(String(arg(args, 'out', 'manifest.json')), manifest)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
