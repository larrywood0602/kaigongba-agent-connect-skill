import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordAction } from './action_record.mjs'
import { createServiceFromCapability } from './create_service_from_capability.mjs'
import { publishService } from './publish_service.mjs'
import { getServiceReadiness } from './readiness.mjs'
import { runRuntimeTick } from './runtime_tick.mjs'
import { syncCapabilitiesFromFile } from './sync_capabilities.mjs'

let tempDir
let previousCwd
let previousConfig
let server
let baseUrl
let requests

function jsonResponse(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function startMockServer() {
  requests = []
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })

    if (req.url === '/api/agent-connections/conn_mock/capabilities/sync' && req.method === 'POST') {
      jsonResponse(res, { connection: { id: 'conn_mock' }, capabilities: body.capabilities })
      return
    }
    if (req.url === '/api/agent-capabilities/cap_html/create-service' && req.method === 'POST') {
      jsonResponse(res, { capability: { id: 'cap_html', serviceSopId: 'sop_html' }, serviceSop: { id: 'sop_html' } })
      return
    }
    if (req.url === '/api/service-sops/sop_html/readiness' && req.method === 'GET') {
      jsonResponse(res, { status: 'production_ready', canPublish: true, reasons: [] })
      return
    }
    if (req.url === '/api/service-sops/sop_html/publish' && req.method === 'POST') {
      jsonResponse(res, { serviceSop: { id: 'sop_html', status: 'published' }, team: { id: 'team_html' } })
      return
    }
    if (req.url === '/api/agent-connections/conn_mock/runs' && req.method === 'GET') {
      jsonResponse(res, {
        connection: { id: 'conn_mock' },
        serviceSop: { id: 'sop_html' },
        runs: [
          { runId: 'order_mock_1', order: { id: 'order_mock_1', status: 'escrow_held' }, currentNode: { name: '外部 Agent 执行' } },
        ],
      })
      return
    }
    if (req.url === '/api/agent/work-items?connectionId=conn_mock' && req.method === 'GET') {
      jsonResponse(res, {
        connection: { id: 'conn_mock' },
        workItems: [
          {
            id: 'work_mock_1',
            orderId: 'order_mock_1',
            serviceSopId: 'sop_html',
            nodeKey: 'external_agent_execution',
            status: 'queued',
            payload: { requirement: { goal: '生成 HTML 报告' } },
          },
        ],
      })
      return
    }

    jsonResponse(res, { code: 'not_found', message: `${req.method} ${req.url}` }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
}

describe('kaigongba connector capability-first scripts', () => {
  beforeEach(async () => {
    previousCwd = process.cwd()
    previousConfig = process.env.KAIGONGBA_CONNECTION_CONFIG
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-connector-flow-'))
    process.chdir(tempDir)
    await mkdir(join(tempDir, '.kaigongba'), { recursive: true })
    process.env.KAIGONGBA_CONNECTION_CONFIG = join(tempDir, '.kaigongba/connection.json')
    await startMockServer()
    await writeFile(
      process.env.KAIGONGBA_CONNECTION_CONFIG,
      `${JSON.stringify({ apiBaseUrl: baseUrl, connectionId: 'conn_mock', agentToken: 'token_mock', serviceSopId: 'sop_html' }, null, 2)}\n`,
      'utf8',
    )
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    process.chdir(previousCwd)
    if (previousConfig === undefined) delete process.env.KAIGONGBA_CONNECTION_CONFIG
    else process.env.KAIGONGBA_CONNECTION_CONFIG = previousConfig
    await rm(tempDir, { recursive: true, force: true })
  })

  it('syncs capabilities from a local manifest without creating a service SOP', async () => {
    const manifestFile = join(tempDir, 'capabilities-manifest.json')
    await writeFile(
      manifestFile,
      JSON.stringify({
        schemaVersion: '1.0',
        capabilities: [
          {
            externalId: 'html_report',
            name: 'HTML 可视化报告生成',
            description: '将资料整理为单文件 HTML 报告。',
            capabilityType: 'skill',
            sourceKind: 'skill',
            sourceFingerprint: 'skill-html-report-v1',
            deliverables: ['单文件 HTML 报告'],
            requiredInputs: ['Markdown 文档'],
          },
        ],
        workflow: { nodes: [] },
      }),
      'utf8',
    )

    const result = await syncCapabilitiesFromFile(manifestFile, { replace: true })

    expect(result.capabilities).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/agent-connections/conn_mock/capabilities/sync',
      body: {
        replace: true,
        capabilities: [
          expect.objectContaining({
            name: 'HTML 可视化报告生成',
            sourceFingerprint: 'skill-html-report-v1',
          }),
        ],
      },
    })
    expect(requests[0].headers.authorization).toBe('Bearer token_mock')
  })

  it('creates, checks, publishes, ticks, and records actions using mock state only', async () => {
    const created = await createServiceFromCapability('cap_html', {
      serviceName: 'HTML 可视化报告服务',
      priceCents: 180000,
      cycleDays: 2,
      revisionsIncluded: 1,
    })
    const readiness = await getServiceReadiness('sop_html')
    const published = await publishService('sop_html')
    const tick = await runRuntimeTick({ outputDir: join(tempDir, '.kaigongba/runtime') })
    const action = await recordAction({
      action: 'deliver_run',
      targetId: 'order_mock_1',
      actionKey: 'deliver-order_mock_1',
      idempotencyKey: 'deliver-order_mock_1',
      status: 'done',
      resultSummary: 'mock deliverable submitted',
      stateFile: join(tempDir, '.kaigongba/runtime/actions.json'),
    })

    expect(created.serviceSop.id).toBe('sop_html')
    expect(readiness.canPublish).toBe(true)
    expect(published.serviceSop.status).toBe('published')
    expect(tick.pendingRuns).toHaveLength(1)
    expect(tick.pendingWorkItems).toHaveLength(1)
    expect(action.status).toBe('done')

    const pending = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/pending-runs.json'), 'utf8'))
    const pendingWorkItems = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/pending-work-items.json'), 'utf8'))
    const actions = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/actions.json'), 'utf8'))
    expect(pending[0].runId).toBe('order_mock_1')
    expect(pendingWorkItems[0]).toMatchObject({ id: 'work_mock_1', orderId: 'order_mock_1', payload: { requirement: { goal: '生成 HTML 报告' } } })
    expect(actions.actions['deliver-order_mock_1']).toMatchObject({ status: 'done', idempotency_key: 'deliver-order_mock_1' })
  })
})
