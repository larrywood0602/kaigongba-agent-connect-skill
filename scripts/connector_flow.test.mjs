import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordAction } from './action_record.mjs'
import { createServiceFromCapability } from './create_service_from_capability.mjs'
import { publishService } from './publish_service.mjs'
import { getServiceReadiness } from './readiness.mjs'
import { runWorkItem } from './run_work_item.mjs'
import { runRuntimeTick } from './runtime_tick.mjs'
import { syncCapabilitiesFromFile } from './sync_capabilities.mjs'

let tempDir
let previousCwd
let previousConfig
let server
let baseUrl
let requests

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPidFile(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function waitForProcessExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(25)
  }
  return true
}

function killProcess(pid) {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Best-effort cleanup for regression tests that intentionally create stubborn child processes.
  }
}

function jsonResponse(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
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
            payload: {
              requirement: { goal: '生成 HTML 报告' },
              callback: {
                runId: 'order_mock_1',
                connectionId: 'conn_mock',
                serviceSopId: 'sop_html',
                nodeKey: 'external_agent_execution',
              },
              idempotencyKey: 'order_mock_1-external_agent_execution-initial',
            },
          },
        ],
      })
      return
    }
    if (req.url === '/api/agent/work-items/work_mock_1/claim' && req.method === 'POST') {
      jsonResponse(res, {
        workItem: {
          id: 'work_mock_1',
          connectionId: 'conn_mock',
          orderId: 'order_mock_1',
          serviceSopId: 'sop_html',
          nodeKey: 'external_agent_execution',
          status: 'claimed',
          payload: {
            requirement: { goal: '生成 HTML 报告' },
            callback: {
              runId: 'order_mock_1',
              connectionId: 'conn_mock',
              serviceSopId: 'sop_html',
              nodeKey: 'external_agent_execution',
            },
            idempotencyKey: 'order_mock_1-external_agent_execution-initial',
          },
        },
      })
      return
    }
    if (req.url === '/api/agent/work-items/work_mock_1/lease' && req.method === 'POST') {
      jsonResponse(res, {
        workItem: {
          id: 'work_mock_1',
          connectionId: 'conn_mock',
          orderId: 'order_mock_1',
          serviceSopId: 'sop_html',
          nodeKey: 'external_agent_execution',
          status: 'running',
          claimedBy: body.workerId,
          leaseExpiresAt: new Date(Date.now() + Number(body.leaseSeconds || 900) * 1000).toISOString(),
          payload: {
            requirement: { goal: '生成 HTML 报告' },
            callback: {
              runId: 'order_mock_1',
              connectionId: 'conn_mock',
              serviceSopId: 'sop_html',
              nodeKey: 'external_agent_execution',
            },
            idempotencyKey: 'order_mock_1-external_agent_execution-initial',
          },
        },
      })
      return
    }
    if (req.url === '/api/workflow-runs/order_mock_1/events' && req.method === 'POST') {
      jsonResponse(res, {
        event: { id: `event_${requests.length}`, ...body },
        artifact: body.event === 'artifact.created' ? { id: 'art_mock_1', ...body.artifact } : null,
        duplicate: false,
      })
      return
    }
    if (req.url === '/api/artifacts/upload-url' && req.method === 'POST') {
      jsonResponse(res, {
        uploadId: 'upload_mock_1',
        uploadUrl: `http://${req.headers.host}/upload/report.md`,
        externalUrl: `http://${req.headers.host}/download/report.md`,
        expiresInSeconds: 900,
      })
      return
    }
    if (req.url === '/upload/report.md' && req.method === 'PUT') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.url === '/api/artifacts/art_mock_1/complete' && req.method === 'POST') {
      jsonResponse(res, { artifact: { id: 'art_mock_1', status: 'uploaded' } })
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
    const executorFile = join(tempDir, 'executor.mjs')
    const outputFile = join(tempDir, 'report.md')
    await writeFile(outputFile, '# Mock report\n', 'utf8')
    await writeFile(
      executorFile,
      `let raw = ''\nprocess.stdin.on('data', (chunk) => { raw += chunk })\nprocess.stdin.on('end', () => {\n  console.log(JSON.stringify({\n    progressEvents: [{ progress: 72, message: 'mock executor progressing' }],\n    artifacts: [{ name: 'report.md', type: 'md', file: ${JSON.stringify(outputFile)} }],\n    finalMessage: 'mock executor completed'\n  }))\n})\n`,
      'utf8',
    )
    const created = await createServiceFromCapability('cap_html', {
      serviceName: 'HTML 可视化报告服务',
      priceCents: 180000,
      cycleDays: 2,
      revisionsIncluded: 1,
    })
    const readiness = await getServiceReadiness('sop_html')
    const published = await publishService('sop_html')
    const tick = await runRuntimeTick({ outputDir: join(tempDir, '.kaigongba/runtime') })
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_flow',
      leaseSeconds: 300,
    })
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
    expect(run.ok).toBe(true)
    expect(requests.find((request) => request.url === '/api/agent/work-items/work_mock_1/claim')?.body).toMatchObject({
      workerId: 'worker_flow',
      leaseSeconds: 300,
    })
    expect(requests.filter((request) => request.url === '/api/workflow-runs/order_mock_1/events').map((request) => request.body.event)).toEqual([
      'node.started',
      'node.progress',
      'artifact.created',
      'node.completed',
    ])
    expect(requests.find((request) => request.body?.event === 'artifact.created')?.body.artifact).toMatchObject({
      externalUrl: expect.stringContaining('/download/report.md'),
      uploadId: 'upload_mock_1',
    })
    expect(requests.some((request) => request.method === 'PUT' && request.url === '/upload/report.md' && request.body === '# Mock report\n')).toBe(true)
    expect(requests.some((request) => request.method === 'POST' && request.url === '/api/artifacts/art_mock_1/complete')).toBe(true)
    expect(action.status).toBe('done')

    const pending = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/pending-runs.json'), 'utf8'))
    const pendingWorkItems = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/pending-work-items.json'), 'utf8'))
    const actions = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/actions.json'), 'utf8'))
    const runResult = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/last-run-result.json'), 'utf8'))
    expect(pending[0].runId).toBe('order_mock_1')
    expect(pendingWorkItems[0]).toMatchObject({ id: 'work_mock_1', orderId: 'order_mock_1', payload: { requirement: { goal: '生成 HTML 报告' } } })
    expect(runResult.ok).toBe(true)
    expect(runResult.artifacts[0]).toMatchObject({ upload: { uploaded: true }, completed: { artifact: { status: 'uploaded' } } })
    expect(actions.actions['deliver-order_mock_1']).toMatchObject({ status: 'done', idempotency_key: 'deliver-order_mock_1' })
  })

  it('renews the claimed work item lease while the external executor is running', async () => {
    const executorFile = join(tempDir, 'slow-executor.mjs')
    await writeFile(
      executorFile,
      `setTimeout(() => {\n  console.log(JSON.stringify({\n    progressEvents: [],\n    artifacts: [],\n    finalMessage: 'slow executor completed'\n  }))\n}, 40)\nprocess.stdin.resume()\n`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_lease',
      leaseSeconds: 30,
      leaseRenewIntervalMs: 1,
    })

    expect(run.ok).toBe(true)
    const leaseRequests = requests.filter((request) => request.url === '/api/agent/work-items/work_mock_1/lease')
    expect(leaseRequests.length).toBeGreaterThan(0)
    expect(leaseRequests[0].body).toMatchObject({
      workerId: 'worker_lease',
      leaseSeconds: 30,
    })
  })

  it('terminates the external executor process tree when execution times out', async () => {
    const executorFile = join(tempDir, 'stubborn-executor.mjs')
    const parentPidFile = join(tempDir, 'stubborn-parent.pid')
    const childPidFile = join(tempDir, 'stubborn-child.pid')
    await writeFile(
      executorFile,
      `import { spawn } from 'node:child_process'\nimport fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))\nprocess.on('SIGTERM', () => {})\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)") }], { stdio: 'ignore' })\nfs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))\nprocess.stdin.resume()\nsetInterval(() => {}, 1000)\n`,
      'utf8',
    )

    let parentPid = null
    let childPid = null
    try {
      const run = await runWorkItem({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: `node "${executorFile}"`,
        workerId: 'worker_timeout',
        leaseSeconds: 30,
        timeoutMs: 80,
        executorKillGraceMs: 50,
      })
      parentPid = await readPidFile(parentPidFile)
      childPid = await readPidFile(childPidFile)

      expect(run.ok).toBe(false)
      expect(run.error).toContain('Executor timed out after 80ms')
      expect(parentPid).toBeGreaterThan(0)
      expect(childPid).toBeGreaterThan(0)
      expect(await waitForProcessExit(parentPid, 1500)).toBe(true)
      expect(await waitForProcessExit(childPid, 1500)).toBe(true)
    } finally {
      killProcess(parentPid)
      killProcess(childPid)
    }
  })
})
