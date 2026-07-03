#!/usr/bin/env node
import { arg, listArg, normalizeAgentEnvironment, parseArgs, readConnectionConfig, resolveMainAgent, stableKey, writeJson } from './lib.mjs'

const args = parseArgs()

const serviceName = String(arg(args, ['service-name', 'serviceName'], '外部 Agent 服务 SOP'))
const serviceKey = stableKey(serviceName, 'external_agent_service')
const resolvedMainAgent = resolveMainAgent(args, await readConnectionConfig())
const workerId = String(arg(args, ['worker-id', 'workerId'], `${serviceKey}_worker`))
const workerName = String(arg(args, ['worker-name', 'workerName'], 'Production Worker Agent'))
const externalNodeKey = String(arg(args, ['node-key', 'nodeKey'], 'external_agent_execution'))

const deliverables = listArg(arg(args, 'deliverables'), ['阶段结果文件', '交付说明'])
const requiredInputs = listArg(arg(args, ['required-inputs', 'requiredInputs']), ['客户需求说明', '参考资料'])
const targetCustomers = listArg(arg(args, ['target-customers', 'targetCustomers']), ['需要外包执行的客户'])
const riskBoundaries = listArg(arg(args, ['risk-boundaries', 'riskBoundaries']), ['不承诺超出服务范围的业务结果'])
const acceptanceCriteria = listArg(arg(args, ['acceptance-criteria', 'acceptanceCriteria']), ['交付物可打开', '内容符合已确认需求'])
const artifactTypes = listArg(arg(args, ['artifact-types', 'artifactTypes']), ['file'])

const manifest = {
  schemaVersion: '1.0',
  mainAgent: {
    provider: resolvedMainAgent.provider,
    externalAgentId: resolvedMainAgent.externalAgentId,
    name: resolvedMainAgent.name,
    version: resolvedMainAgent.version,
    endpoint: resolvedMainAgent.endpoint,
    environment: normalizeAgentEnvironment(arg(args, 'environment', 'production')),
  },
  workerAgents: [
    {
      externalAgentId: workerId,
      name: workerName,
      role: String(arg(args, ['worker-role', 'workerRole'], 'worker')),
    },
  ],
  serviceCard: {
    name: serviceName,
    tagline: String(arg(args, ['summary', 'tagline'], '把客户需求转成可跟踪、可验收的 Agent 工作流')),
    category: String(arg(args, 'category', '外部 Agent 服务')),
    targetCustomers,
    deliverables,
    requiredInputs,
    automationLevel: String(arg(args, ['automation-level', 'automationLevel'], 'semi_auto')),
    humanProfile: {
      name: String(arg(args, ['human-name', 'humanName'], '乙方负责人')),
      role: String(arg(args, ['human-role', 'humanRole'], '报价与终审负责人')),
      bio: String(arg(args, ['human-bio', 'humanBio'], '负责确认需求、报价边界、风险说明和最终交付质量。')),
      responsibleNodes: listArg(arg(args, ['human-nodes', 'humanNodes']), ['需求确认', '交付验收']),
    },
    riskBoundaries,
    acceptanceCriteria,
  },
  workflow: {
    nodes: [
      {
        key: String(arg(args, ['brief-node-key', 'briefNodeKey'], 'brief')),
        name: String(arg(args, ['brief-node-name', 'briefNodeName'], '需求确认')),
        ownerKind: 'human',
        requiresHuman: true,
      },
      {
        key: externalNodeKey,
        name: String(arg(args, ['node-name', 'nodeName'], '外部 Agent 执行')),
        ownerKind: 'external_agent',
        sourceAgentId: workerId,
        isAuto: true,
        artifactTypes,
      },
      {
        key: String(arg(args, ['delivery-node-key', 'deliveryNodeKey'], 'delivery')),
        name: String(arg(args, ['delivery-node-name', 'deliveryNodeName'], '交付验收')),
        ownerKind: 'human',
        requiresHuman: true,
      },
    ],
  },
}

await writeJson(String(arg(args, 'out', '-')), manifest)
