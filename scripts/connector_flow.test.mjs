import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordAction } from './action_record.mjs'
import { createServiceFromCapability } from './create_service_from_capability.mjs'
import { publishService } from './publish_service.mjs'
import { getServiceReadiness } from './readiness.mjs'
import { executorEnvironment, resolveExecutorTimeouts, runWorkItem } from './run_work_item.mjs'
import { runRuntimeTick } from './runtime_tick.mjs'
import { stableArtifactSnapshot } from './runtime_activity.mjs'
import { syncCapabilitiesFromFile } from './sync_capabilities.mjs'

let tempDir
let previousCwd
let previousConfig
let server
let baseUrl
let requests
let claimedAttemptCount
let eventFailurePredicate
let eventFailuresRemaining
let eventFailureStatus
let uploadRequestHook
let eventHangPredicate
let uploadFailuresRemaining
let uploadRequestHang
let serverSockets
let uploadFailureStatus
let uploadFailureNonJson
let uploadUrlFailuresRemaining
let uploadUrlFailureStatus

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fsEntries(directory) {
  try {
    return await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
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
  serverSockets = new Set()
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    requests.push({ method: req.method, url: req.url, headers: req.headers, body, receivedAt: Date.now() })

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
          attemptCount: claimedAttemptCount,
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
      if (eventHangPredicate?.(body)) return
      if (eventFailuresRemaining > 0 && eventFailurePredicate?.(body)) {
        eventFailuresRemaining -= 1
        jsonResponse(res, { code: 'temporarily_unavailable', message: 'retry this callback' }, eventFailureStatus)
        return
      }
      jsonResponse(res, {
        event: { id: `event_${requests.length}`, ...body },
        artifact: body.event === 'artifact.created' ? { id: 'art_mock_1', ...body.artifact } : null,
        duplicate: false,
      })
      return
    }
    if (req.url === '/api/artifacts/upload-url' && req.method === 'POST') {
      if (uploadRequestHang) return
      if (uploadUrlFailuresRemaining > 0) {
        uploadUrlFailuresRemaining -= 1
        res.writeHead(uploadUrlFailureStatus, { 'Content-Type': 'text/plain' })
        res.end('permanent upload-url rejection')
        return
      }
      await uploadRequestHook?.(body)
      jsonResponse(res, {
        uploadId: 'upload_mock_1',
        uploadUrl: `http://${req.headers.host}/upload/report.md`,
        externalUrl: `http://${req.headers.host}/download/report.md`,
        expiresInSeconds: 900,
      })
      return
    }
    if (req.url === '/upload/report.md' && req.method === 'PUT') {
      if (uploadFailuresRemaining > 0) {
        uploadFailuresRemaining -= 1
        if (uploadFailureNonJson) {
          res.writeHead(uploadFailureStatus, { 'Content-Type': 'text/plain' })
          res.end('permanent upload rejection')
        } else {
          jsonResponse(res, { code: 'upload_unavailable' }, uploadFailureStatus)
        }
        return
      }
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
  server.on('connection', (socket) => {
    serverSockets.add(socket)
    socket.on('close', () => serverSockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
}

describe('kaigongba connector capability-first scripts', () => {
  beforeEach(async () => {
    previousCwd = process.cwd()
    previousConfig = process.env.KAIGONGBA_CONNECTION_CONFIG
    claimedAttemptCount = 1
    eventFailurePredicate = null
    eventFailuresRemaining = 0
    eventFailureStatus = 503
    uploadRequestHook = null
    eventHangPredicate = null
    uploadFailuresRemaining = 0
    uploadFailureStatus = 503
    uploadFailureNonJson = false
    uploadUrlFailuresRemaining = 0
    uploadUrlFailureStatus = 400
    uploadRequestHang = false
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
    for (const socket of serverSockets) socket.destroy()
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
    await writeFile(
      executorFile,
      `import fs from 'node:fs'\nimport path from 'node:path'\nlet raw = ''\nprocess.stdin.on('data', (chunk) => { raw += chunk })\nprocess.stdin.on('end', () => {\n  const artifactFile = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')\n  fs.writeFileSync(artifactFile, '# Mock report\\n')\n  console.log(JSON.stringify({\n    progressEvents: [{ progress: 72, message: 'mock executor progressing' }],\n    artifacts: [{ name: 'report.md', type: 'md', file: artifactFile }],\n    finalMessage: 'mock executor completed'\n  }, null, 2))\n})\n`,
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
    expect(run.ok, `${run.errorCode || ''}: ${run.error || ''}`).toBe(true)
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
    expect(JSON.stringify(run.artifacts)).not.toMatch(/(?:upload|external|download)Url/i)
    expect(JSON.stringify(runResult)).not.toMatch(/(?:upload|external|download)Url/i)
    expect((await stat(join(tempDir, '.kaigongba/runtime/last-run-result.json'))).mode & 0o777).toBe(0o600)
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
      progressHeartbeatIntervalMs: 5,
    })

    expect(run.ok).toBe(true)
    const leaseRequests = requests.filter((request) => request.url === '/api/agent/work-items/work_mock_1/lease')
    expect(leaseRequests.length).toBeGreaterThan(0)
    expect(leaseRequests[0].body).toMatchObject({
      workerId: 'worker_lease',
      leaseSeconds: 30,
    })
    const progressHeartbeats = requests.filter((request) => (
      request.url === '/api/workflow-runs/order_mock_1/events'
      && request.body.event === 'node.progress'
      && String(request.body.message).includes('持续执行')
    ))
    expect(progressHeartbeats.length).toBeGreaterThan(0)
    expect(progressHeartbeats.every((request) => request.body.progress === undefined)).toBe(true)
    expect(progressHeartbeats.every((request) => request.body.activity?.kind === 'heartbeat')).toBe(true)
    const eventSequences = requests
      .filter((request) => request.url === '/api/workflow-runs/order_mock_1/events')
      .map((request) => request.body.sequence)
    expect(eventSequences).toEqual([...eventSequences].sort((left, right) => left - right))
  })

  it('rejects a legacy executor artifact outside the trusted work item directory', async () => {
    const executorFile = join(tempDir, 'outside-artifact-executor.mjs')
    const secretFile = join(tempDir, 'secret.txt')
    await writeFile(secretFile, 'must never upload', 'utf8')
    await writeFile(
      executorFile,
      `process.stdout.write(JSON.stringify({
  artifacts: [{ name: 'secret.txt', type: 'txt', file: ${JSON.stringify(secretFile)} }],
  finalMessage: 'outside artifact',
}) + '\\n')
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_outside_artifact',
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_path_outside_output')
    expect(requests.some((request) => request.url === '/api/artifacts/upload-url')).toBe(false)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('rejects a pre-created work item artifact directory symlink', async () => {
    const outputDir = join(tempDir, '.kaigongba/runtime')
    const artifactRoot = join(outputDir, 'codex-artifacts')
    const outsideDir = join(tempDir, 'outside-task')
    const secretFile = join(outsideDir, 'id_rsa')
    const executorFile = join(tempDir, 'symlink-artifact-executor.mjs')
    await mkdir(artifactRoot, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(secretFile, 'must never upload', 'utf8')
    await symlink(outsideDir, join(artifactRoot, 'work_mock_1'))
    await writeFile(
      executorFile,
      `process.stdout.write(JSON.stringify({ artifacts: [{ name: 'id_rsa', file: ${JSON.stringify(secretFile)} }] }) + '\\n')\n`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir,
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_symlink_artifact',
      progressHeartbeatIntervalMs: 0,
    })
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_path_outside_output')
    expect(requests.some((request) => request.body?.event === 'node.failed')).toBe(true)
    expect((await stat(join(outputDir, 'last-run-result.json'))).mode & 0o777).toBe(0o600)
    expect(requests.some((request) => request.url === '/api/artifacts/upload-url')).toBe(false)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('rejects an artifact that combines a local file and an external URL', async () => {
    const executorFile = join(tempDir, 'conflicting-artifact-executor.mjs')
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')
fs.writeFileSync(file, 'report')
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'report.md', file, externalUrl: 'https://example.invalid/report.md' }] }) + '\\n')
`,
      'utf8',
    )
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_conflicting_artifact',
      progressHeartbeatIntervalMs: 0,
    })
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_input_conflict')
    expect(requests.some((request) => request.url === '/api/artifacts/upload-url')).toBe(false)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('rejects a work item directory replaced by a symlink during execution', async () => {
    const outsideDir = join(tempDir, 'outside-after-start')
    const secretFile = join(outsideDir, 'secret.txt')
    const executorFile = join(tempDir, 'replace-task-dir-executor.mjs')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(secretFile, 'must never upload after replacement', 'utf8')
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
fs.rmSync(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, { recursive: true })
fs.symlinkSync(${JSON.stringify(outsideDir)}, process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR)
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'secret.txt', file: ${JSON.stringify(secretFile)} }] }) + '\\n')
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_replaced_task_dir',
      progressHeartbeatIntervalMs: 0,
    })
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_path_outside_output')
    expect(requests.some((request) => request.url === '/api/artifacts/upload-url')).toBe(false)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('does not expose platform secrets to a custom executor process', async () => {
    const executorFile = join(tempDir, 'executor-env-check.mjs')
    await writeFile(
      executorFile,
      `const keys = ['KAIGONGBA_AGENT_TOKEN', 'KAIGONGBA_CONNECT_CODE', 'THIRD_PARTY_API_KEY', 'OPENAI_API_KEY', 'DATABASE_PASSWORD']
const exposed = keys.filter((key) => process.env[key])
process.stdout.write(JSON.stringify({ finalMessage: exposed.join(',') || 'clean executor env' }) + '\\n')
`,
      'utf8',
    )
    const previous = {
      token: process.env.KAIGONGBA_AGENT_TOKEN,
      connectCode: process.env.KAIGONGBA_CONNECT_CODE,
      apiKey: process.env.THIRD_PARTY_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      password: process.env.DATABASE_PASSWORD,
    }
    process.env.KAIGONGBA_AGENT_TOKEN = 'secret-agent-token'
    process.env.KAIGONGBA_CONNECT_CODE = 'secret-connect-code'
    process.env.THIRD_PARTY_API_KEY = 'secret-api-key'
    process.env.OPENAI_API_KEY = 'secret-openai-key'
    process.env.DATABASE_PASSWORD = 'secret-password'
    try {
      const run = await runWorkItem({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: `node "${executorFile}"`,
        workerId: 'worker_executor_env',
        progressHeartbeatIntervalMs: 0,
      })
      expect(run.ok).toBe(true)
      expect(run.executorResult.finalMessage).toBe('clean executor env')
    } finally {
      if (previous.token === undefined) delete process.env.KAIGONGBA_AGENT_TOKEN
      else process.env.KAIGONGBA_AGENT_TOKEN = previous.token
      if (previous.connectCode === undefined) delete process.env.KAIGONGBA_CONNECT_CODE
      else process.env.KAIGONGBA_CONNECT_CODE = previous.connectCode
      if (previous.apiKey === undefined) delete process.env.THIRD_PARTY_API_KEY
      else process.env.THIRD_PARTY_API_KEY = previous.apiKey
      if (previous.openaiApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous.openaiApiKey
      if (previous.password === undefined) delete process.env.DATABASE_PASSWORD
      else process.env.DATABASE_PASSWORD = previous.password
    }
  })

  it('inherits an explicitly allowlisted executor API key but never a platform token', async () => {
    const executorFile = join(tempDir, 'executor-env-allowlist.mjs')
    await writeFile(
      executorFile,
      `process.stdout.write(JSON.stringify({ finalMessage: JSON.stringify({ ai: process.env.AI_API_KEY || '', platform: process.env.KAIGONGBA_AGENT_TOKEN || '', codexArgs: process.env.CODEX_EXEC_ARGS || '' }) }) + '\\n')\n`,
      'utf8',
    )
    const previousAiKey = process.env.AI_API_KEY
    const previousToken = process.env.KAIGONGBA_AGENT_TOKEN
    const previousCodexArgs = process.env.CODEX_EXEC_ARGS
    process.env.AI_API_KEY = 'explicit-ai-key'
    process.env.KAIGONGBA_AGENT_TOKEN = 'never-inherit-platform-token'
    process.env.CODEX_EXEC_ARGS = '--model configured-model'
    try {
      const run = await runWorkItem({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: `node "${executorFile}"`,
        executorEnvAllowlist: 'AI_API_KEY,KAIGONGBA_AGENT_TOKEN',
        workerId: 'worker_executor_env_allowlist',
        progressHeartbeatIntervalMs: 0,
      })
      expect(JSON.parse(run.executorResult.finalMessage)).toEqual({
        ai: 'explicit-ai-key', platform: '', codexArgs: '--model configured-model',
      })
    } finally {
      if (previousAiKey === undefined) delete process.env.AI_API_KEY
      else process.env.AI_API_KEY = previousAiKey
      if (previousToken === undefined) delete process.env.KAIGONGBA_AGENT_TOKEN
      else process.env.KAIGONGBA_AGENT_TOKEN = previousToken
      if (previousCodexArgs === undefined) delete process.env.CODEX_EXEC_ARGS
      else process.env.CODEX_EXEC_ARGS = previousCodexArgs
    }
  })

  it('filters forbidden executor values from the final environment additions merge', () => {
    const env = executorEnvironment({}, {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/injected.cjs',
      KAIGONGBA_CONNECT_CODE: 'kgbc_readded',
      KAIGONGBA_AGENT_TOKEN: 'token_readded',
      KAIGONGBA_VENDOR_API_KEY: 'platform-api-key',
    }, {})
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('posts streamed executor progress before completion and retries the same callback', async () => {
    const executorFile = join(tempDir, 'streaming-executor.mjs')
    const processCompletedFile = join(tempDir, 'executor-completed-at.txt')
    claimedAttemptCount = 2
    eventFailuresRemaining = 1
    eventFailurePredicate = (body) => body.activity?.kind === 'real_progress'
    await writeFile(
      executorFile,
      `const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
emit({
  protocol: 'kaigongba.executor.v1',
  type: 'progress',
  sequence: 1,
  eventId: 'work_mock_1:1',
  occurredAt: new Date().toISOString(),
  phase: 'PPT 生成',
  current: 6,
  total: 12,
  unit: 'page',
  percent: 50,
  message: '已完成第 6 页',
})
emit({
  protocol: 'kaigongba.executor.v1',
  type: 'log',
  sequence: 2,
  eventId: 'work_mock_1:2',
  occurredAt: new Date().toISOString(),
  internal: true,
  message: 'internal executor activity',
})
setTimeout(async () => {
  const fs = await import('node:fs/promises')
  await fs.writeFile(${JSON.stringify(processCompletedFile)}, String(Date.now()))
  emit({
    protocol: 'kaigongba.executor.v1',
    type: 'result',
    sequence: 3,
    eventId: 'work_mock_1:3',
    occurredAt: new Date().toISOString(),
    status: 'completed',
    result: { status: 'completed', artifacts: [], progressEvents: [], finalMessage: 'done' },
  })
}, 80)
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_stream',
      leaseSeconds: 30,
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(true)
    const processCompletedAt = Number(await readFile(processCompletedFile, 'utf8'))
    const eventRequests = requests.filter((request) => request.url === '/api/workflow-runs/order_mock_1/events')
    const progressRequests = eventRequests.filter((request) => request.body.activity?.kind === 'real_progress')
    expect(progressRequests).toHaveLength(2)
    expect(progressRequests[0].receivedAt).toBeLessThan(processCompletedAt)
    expect(progressRequests[0].body).toEqual(progressRequests[1].body)
    expect(progressRequests[0].body).toMatchObject({
      event: 'node.progress',
      progress: 50,
      idempotencyKey: 'work_mock_1:1:attempt:2',
      activity: {
        protocol: 'kaigongba.executor.v1',
        kind: 'real_progress',
        eventId: 'work_mock_1:1:attempt:2',
        phase: 'PPT 生成',
        current: 6,
        total: 12,
        unit: 'page',
        attemptCount: 2,
      },
    })
    expect(eventRequests.some((request) => request.body.message === 'internal executor activity')).toBe(false)
    expect(eventRequests.map((request) => request.body.sequence)).toEqual(
      [...eventRequests.map((request) => request.body.sequence)].sort((left, right) => left - right),
    )
    expect(new Set(eventRequests.map((request) => request.body.sequence)).size).toBe(eventRequests.length - 1)
    expect(run.executionMetrics).toMatchObject({
      validProtocolEvents: 3,
      invalidProtocolEvents: 0,
      duplicateProtocolEvents: 0,
      callbackAttempts: 4,
      timeoutSource: 'default',
    })
    expect(run.executionMetrics.firstProtocolEventAt).toBeTruthy()
    expect(run.executionMetrics.firstRealProgressAt).toBeTruthy()
    expect(run.executionMetrics.lastValidActivityAt).toBeTruthy()
    const storedRun = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/last-run-result.json'), 'utf8'))
    expect(storedRun.executionMetrics).toEqual(run.executionMetrics)
    expect(JSON.stringify(storedRun.executionMetrics)).not.toContain(tempDir)
    expect(JSON.stringify(storedRun.executionMetrics)).not.toContain('token_mock')
    expect(await fsEntries(join(tempDir, '.kaigongba/runtime/pending-events'))).toEqual([])
  })

  it('does not retry a permanent 4xx callback response', async () => {
    const executorFile = join(tempDir, 'unused-executor.mjs')
    await writeFile(executorFile, `process.stdout.write('{}\\n')\n`, 'utf8')
    eventFailuresRemaining = 1
    eventFailureStatus = 400
    eventFailurePredicate = (body) => body.event === 'node.started'

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_permanent_callback',
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(false)
    expect(requests.filter((request) => request.body?.event === 'node.started')).toHaveLength(1)
    expect(await fsEntries(join(tempDir, '.kaigongba/runtime/pending-events'))).toEqual([])
    const deadLetters = await fsEntries(join(tempDir, '.kaigongba/runtime/dead-letter-events'))
    expect(deadLetters).toHaveLength(1)
    const deadLetter = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/dead-letter-events', deadLetters[0]), 'utf8'))
    expect(deadLetter.payload.event).toBe('node.started')
  })

  it('resolves executor hard and idle timeouts by precedence with a six hour cap', () => {
    expect(resolveExecutorTimeouts({
      args: {},
      env: {},
      workItem: {
        payload: {
          execution: {
            hardTimeoutMs: 10_800_000,
            idleTimeoutMs: 1_200_000,
            maxHardTimeoutMs: 21_600_000,
          },
        },
      },
    })).toEqual({
      hardTimeoutMs: 10_800_000,
      idleTimeoutMs: 1_200_000,
      maxHardTimeoutMs: 21_600_000,
      source: 'work_item',
    })

    expect(resolveExecutorTimeouts({
      args: { timeoutMs: 80, idleTimeoutMs: 40 },
      env: {},
      workItem: { payload: { execution: { hardTimeoutMs: 9_000_000, idleTimeoutMs: 900_000 } } },
    })).toEqual({
      hardTimeoutMs: 80,
      idleTimeoutMs: 40,
      maxHardTimeoutMs: 21_600_000,
      source: 'cli',
    })

    expect(resolveExecutorTimeouts({ args: {}, env: {}, workItem: {} })).toEqual({
      hardTimeoutMs: 7_200_000,
      idleTimeoutMs: 900_000,
      maxHardTimeoutMs: 21_600_000,
      source: 'default',
    })

    expect(resolveExecutorTimeouts({
      args: {},
      env: {
        KAIGONGBA_EXECUTOR_TIMEOUT_MS: '99999999',
        KAIGONGBA_EXECUTOR_IDLE_TIMEOUT_MS: '120000',
      },
      workItem: {},
    })).toMatchObject({
      hardTimeoutMs: 21_600_000,
      idleTimeoutMs: 120_000,
      source: 'env',
    })

    expect(resolveExecutorTimeouts({
      args: { timeoutMs: 100_000 },
      env: { KAIGONGBA_EXECUTOR_IDLE_TIMEOUT_MS: '40000' },
      workItem: { payload: { execution: { hardTimeoutMs: 200_000, idleTimeoutMs: 120_000 } } },
    })).toMatchObject({
      hardTimeoutMs: 100_000,
      idleTimeoutMs: 40_000,
      source: 'cli',
    })

    expect(resolveExecutorTimeouts({
      args: {}, env: {},
      workItem: { payload: { execution: { hardTimeoutMs: 60_000, idleTimeoutMs: 999_999 } } },
    })).toMatchObject({ hardTimeoutMs: 60_000, idleTimeoutMs: 59_999, source: 'work_item' })
  })

  it('rejects oversized executor output without retaining it as legacy JSON', async () => {
    const executorFile = join(tempDir, 'oversized-executor.mjs')
    await writeFile(
      executorFile,
      `process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n')
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_output_limit',
      timeoutMs: 500,
      idleTimeoutMs: 200,
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('executor_output_limit')
    expect(run.error).toBe('Executor stdout line exceeded the allowed byte limit')
    expect(JSON.stringify(run.executionMetrics).length).toBeLessThan(1_000)
  })

  it('does not let duplicate protocol event ids keep the executor alive', async () => {
    const executorFile = join(tempDir, 'duplicate-activity-executor.mjs')
    await writeFile(
      executorFile,
      `let sequence = 0
const emit = () => {
  sequence += 1
  process.stdout.write(JSON.stringify({
    protocol: 'kaigongba.executor.v1', type: 'lifecycle', sequence,
    eventId: 'duplicate:1', occurredAt: new Date().toISOString(), state: 'working', message: 'duplicate',
  }) + '\\n')
}
emit()
setInterval(emit, 20)
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_duplicate_idle',
      timeoutMs: 250,
      idleTimeoutMs: 60,
      executorKillGraceMs: 20,
      progressHeartbeatIntervalMs: 0,
    })

    expect(run.errorCode).toBe('executor_idle_timeout')
    expect(run.executionMetrics.duplicateProtocolEvents).toBeGreaterThan(0)
  })

  it('rejects a second executor result event', async () => {
    const executorFile = join(tempDir, 'double-result-executor.mjs')
    await writeFile(
      executorFile,
      `const emit = (sequence) => process.stdout.write(JSON.stringify({
  protocol: 'kaigongba.executor.v1', type: 'result', sequence,
  eventId: 'result:' + sequence, occurredAt: new Date().toISOString(), status: 'completed',
  result: { status: 'completed', artifacts: [], progressEvents: [], finalMessage: 'result ' + sequence },
}) + '\\n')
emit(1)
emit(2)
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_double_result',
      progressHeartbeatIntervalMs: 0,
    })

    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('executor_protocol_error')
  })

  it('ignores an identical duplicate result event id', async () => {
    const executorFile = join(tempDir, 'duplicate-result-executor.mjs')
    await writeFile(
      executorFile,
      `const event = { protocol: 'kaigongba.executor.v1', type: 'result', sequence: 1, eventId: 'result:same', occurredAt: new Date().toISOString(), result: { status: 'completed', artifacts: [], progressEvents: [], finalMessage: 'one result' } }
process.stdout.write(JSON.stringify(event) + '\\n' + JSON.stringify(event) + '\\n')
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_duplicate_result',
      progressHeartbeatIntervalMs: 0,
    })

    expect(run.ok).toBe(true)
    expect(run.executionMetrics).toMatchObject({ validProtocolEvents: 1, duplicateProtocolEvents: 1 })
  })

  it('rejects a protocol event emitted after the result event', async () => {
    const executorFile = join(tempDir, 'after-result-executor.mjs')
    await writeFile(
      executorFile,
      `const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
emit({ protocol: 'kaigongba.executor.v1', type: 'result', sequence: 1, eventId: 'after:1', occurredAt: new Date().toISOString(), result: { status: 'completed', artifacts: [], progressEvents: [] } })
emit({ protocol: 'kaigongba.executor.v1', type: 'lifecycle', sequence: 2, eventId: 'after:2', occurredAt: new Date().toISOString(), state: 'working' })
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_after_result',
      progressHeartbeatIntervalMs: 0,
    })
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('executor_protocol_error')
  })

  it('replays multiple pending callback files in sequence before starting a new run', async () => {
    const outputDir = join(tempDir, '.kaigongba/runtime')
    const pendingDir = join(outputDir, 'pending-events')
    await mkdir(pendingDir, { recursive: true })
    for (const [name, sequence] of [['later.json', 8], ['earlier.json', 7]]) {
      await writeFile(join(pendingDir, name), JSON.stringify({
        apiPath: '/api/workflow-runs/order_mock_1/events',
        payload: {
          connectionId: 'conn_mock',
          event: 'node.log', status: 'running', sequence,
          idempotencyKey: `pending-${sequence}`, message: `pending ${sequence}`,
        },
      }))
    }
    await writeFile(join(pendingDir, '.interrupted-write.tmp'), '{"truncated":', 'utf8')
    const executorFile = join(tempDir, 'replay-executor.mjs')
    await writeFile(executorFile, `process.stdout.write(JSON.stringify({ finalMessage: 'done' }) + '\\n')\n`, 'utf8')

    const run = await runWorkItem({
      outputDir,
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_replay',
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(true)
    const callbackMessages = requests
      .filter((request) => request.url === '/api/workflow-runs/order_mock_1/events')
      .map((request) => request.body.message)
    expect(callbackMessages.slice(0, 2)).toEqual(['pending 7', 'pending 8'])
    expect(await fsEntries(pendingDir)).toEqual(['.interrupted-write.tmp'])
  })

  it('dead-letters an untrusted pending callback URL without requesting it', async () => {
    const outputDir = join(tempDir, '.kaigongba/runtime')
    const pendingDir = join(outputDir, 'pending-events')
    await mkdir(pendingDir, { recursive: true })
    await writeFile(join(pendingDir, 'evil.json'), JSON.stringify({
      apiPath: `${baseUrl}/evil-callback`,
      payload: {
        connectionId: 'conn_mock', event: 'node.log', status: 'running', sequence: 1,
        idempotencyKey: 'evil-pending-1', message: 'do not send bearer token',
      },
    }))
    const executorFile = join(tempDir, 'safe-after-replay-executor.mjs')
    await writeFile(executorFile, `process.stdout.write(JSON.stringify({ finalMessage: 'done' }) + '\\n')\n`, 'utf8')

    const run = await runWorkItem({
      outputDir,
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_untrusted_replay',
      progressHeartbeatIntervalMs: 0,
    })

    expect(run.ok).toBe(true)
    expect(requests.some((request) => request.url === '/evil-callback')).toBe(false)
    expect(await fsEntries(pendingDir)).toEqual([])
    expect(await fsEntries(join(outputDir, 'dead-letter-events'))).toHaveLength(1)
  })

  it('times out a hung platform callback instead of hanging after executor close', async () => {
    const executorFile = join(tempDir, 'hung-callback-executor.mjs')
    eventHangPredicate = (body) => body.activity?.kind === 'real_progress'
    await writeFile(
      executorFile,
      `const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
emit({ protocol: 'kaigongba.executor.v1', type: 'progress', sequence: 1, eventId: 'hung:1', occurredAt: new Date().toISOString(), percent: 10, message: 'hang callback' })
emit({ protocol: 'kaigongba.executor.v1', type: 'result', sequence: 2, eventId: 'hung:2', occurredAt: new Date().toISOString(), result: { status: 'completed', artifacts: [], progressEvents: [], finalMessage: 'done' } })
process.stdin.resume()
`,
      'utf8',
    )
    const startedAt = Date.now()
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_callback_timeout',
      progressHeartbeatIntervalMs: 0,
      callbackRequestTimeoutMs: 25,
      callbackRetryDelaysMs: [1],
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('callback_request_timeout')
    const pendingFiles = await fsEntries(join(tempDir, '.kaigongba/runtime/pending-events'))
    expect(pendingFiles).toHaveLength(1)
    const pendingFile = join(tempDir, '.kaigongba/runtime/pending-events', pendingFiles[0])
    expect((await stat(pendingFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(pendingFile, 'utf8')).not.toContain('token_mock')
  })

  it('fails a silent executor on idle timeout and terminates its process group', async () => {
    const executorFile = join(tempDir, 'idle-executor.mjs')
    const parentPidFile = join(tempDir, 'idle-parent.pid')
    const childPidFile = join(tempDir, 'idle-child.pid')
    const childReadyFile = join(tempDir, 'idle-child.ready')
    await writeFile(
      executorFile,
      `import { spawn } from 'node:child_process'
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(childReadyFile)}, 'ready'); setInterval(() => {}, 1000)`)}], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
while (!fs.existsSync(${JSON.stringify(childReadyFile)})) {}
process.stdin.resume()
setInterval(() => {}, 1000)
`,
      'utf8',
    )

    let parentPid = null
    let childPid = null
    try {
      const run = await runWorkItem({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: `node "${executorFile}"`,
        workerId: 'worker_idle_timeout',
        leaseSeconds: 30,
        timeoutMs: 250,
        idleTimeoutMs: 60,
        executorKillGraceMs: 30,
        progressHeartbeatIntervalMs: 5,
        callbackRetryDelaysMs: [1, 1, 1],
      })
      parentPid = await readPidFile(parentPidFile)
      childPid = await readPidFile(childPidFile)

      expect(run.ok).toBe(false)
      expect(run.errorCode).toBe('executor_idle_timeout')
      expect(run.error).toBe('Executor had no valid activity for 60ms')
      expect(parentPid).toBeGreaterThan(0)
      expect(childPid).toBeGreaterThan(0)
      expect(await waitForProcessExit(parentPid, 1500)).toBe(true)
      expect(await waitForProcessExit(childPid, 1500)).toBe(true)
      const failure = requests.find((request) => request.body?.event === 'node.failed')
      expect(failure.body.activity).toMatchObject({
        code: 'executor_idle_timeout',
        hardTimeoutMs: 250,
        idleTimeoutMs: 60,
        attemptCount: 1,
      })
      expect(failure.body.activity.lastActivityAt).toBeTruthy()
      expect(requests.filter((request) => request.body?.activity?.kind === 'heartbeat').length).toBeGreaterThan(0)
    } finally {
      killProcess(parentPid)
      killProcess(childPid)
    }
  })

  it('keeps an executor alive only from valid v1 protocol activity', async () => {
    const executorFile = join(tempDir, 'active-executor.mjs')
    await writeFile(
      executorFile,
      `let sequence = 0
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const lifecycle = () => {
  sequence += 1
  emit({ protocol: 'kaigongba.executor.v1', type: 'lifecycle', sequence, eventId: 'active:' + sequence, occurredAt: new Date().toISOString(), state: 'working', message: 'working' })
}
lifecycle()
const activity = setInterval(lifecycle, 20)
setTimeout(() => {
  clearInterval(activity)
  sequence += 1
  emit({
    protocol: 'kaigongba.executor.v1', type: 'result', sequence,
    eventId: 'active:' + sequence, occurredAt: new Date().toISOString(), status: 'completed',
    result: { status: 'completed', artifacts: [], progressEvents: [], finalMessage: 'active done' },
  })
}, 120)
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_active',
      leaseSeconds: 30,
      timeoutMs: 300,
      idleTimeoutMs: 60,
      progressHeartbeatIntervalMs: 0,
    })

    expect(run.ok).toBe(true)
    expect(run.executorResult.finalMessage).toBe('active done')
    expect(run.executionMetrics.validProtocolEvents).toBeGreaterThanOrEqual(6)
  })

  it('uploads only verified stable bytes when the stable path is replaced during callbacks', async () => {
    const outputDir = join(tempDir, '.kaigongba/runtime')
    const artifactOutputDir = join(outputDir, 'codex-artifacts')
    const taskArtifactDir = join(artifactOutputDir, 'work_mock_1')
    const executorFile = join(tempDir, 'stable-artifact-executor.mjs')
    const artifactFile = join(taskArtifactDir, 'report.md')
    const secondArtifactFile = join(taskArtifactDir, 'second.md')
    const originalBytes = Buffer.from('# verified report\n', 'utf8')
    const replacementBytes = Buffer.from('# attacker replacement\n', 'utf8')
    await mkdir(taskArtifactDir, { recursive: true })
    await writeFile(artifactFile, originalBytes)
    await writeFile(secondArtifactFile, '# second artifact\n', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: taskArtifactDir,
      file: artifactFile,
      stableWindowMs: 5,
      pollIntervalMs: 1,
    })
    const secondSnapshot = await stableArtifactSnapshot({
      outputDir: taskArtifactDir,
      file: secondArtifactFile,
      stableWindowMs: 5,
      pollIntervalMs: 1,
    })
    uploadRequestHook = async () => {
      await rm(snapshot.stableFile)
      await writeFile(snapshot.stableFile, replacementBytes)
    }
    await writeFile(
      executorFile,
      `const event = {
  protocol: 'kaigongba.executor.v1', type: 'result', sequence: 1,
  eventId: 'stable:1', occurredAt: new Date().toISOString(), status: 'completed',
  result: {
    status: 'completed', progressEvents: [], finalMessage: 'artifact ready',
    artifacts: [{
      name: 'report.md', type: 'md', file: ${JSON.stringify(snapshot.stableFile)},
      relativePath: 'report.md', sizeBytes: ${snapshot.sizeBytes}, sha256: ${JSON.stringify(snapshot.sha256)},
    }, {
      name: 'second.md', type: 'md', file: ${JSON.stringify(secondSnapshot.stableFile)},
      relativePath: 'second.md', sizeBytes: ${secondSnapshot.sizeBytes}, sha256: ${JSON.stringify(secondSnapshot.sha256)},
    }],
  },
}
process.stdout.write(JSON.stringify(event) + '\\n')
process.stdin.resume()
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir,
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_stable_artifact',
      leaseSeconds: 30,
      progressHeartbeatIntervalMs: 0,
      callbackRetryDelaysMs: [1, 1, 1],
    })

    const uploadUrlRequest = requests.find((request) => request.url === '/api/artifacts/upload-url')
    expect(uploadUrlRequest, JSON.stringify({ error: run.error, errorCode: run.errorCode })).toBeTruthy()
    expect(uploadUrlRequest.body).toMatchObject({
      sizeBytes: originalBytes.length,
      sha256: createHash('sha256').update(originalBytes).digest('hex'),
    })
    const upload = requests.find((request) => request.method === 'PUT' && request.url === '/upload/report.md')
    expect(upload.body).toBe(originalBytes.toString('utf8'))
    expect(run.ok).toBe(false)
    expect(run.errorCode).toMatch(/^artifact_(?:snapshot_changed|hardlink_unsupported)$/)
    await expect(stat(snapshot.stableFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(secondSnapshot.stableFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries an artifact PUT with the same verified bytes after a transient 503', async () => {
    const executorFile = join(tempDir, 'retry-upload-executor.mjs')
    uploadFailuresRemaining = 1
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')
fs.writeFileSync(file, '# retry exactly these bytes\\n')
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'report.md', type: 'md', file }] }) + '\\n')
`,
      'utf8',
    )

    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_upload_retry',
      progressHeartbeatIntervalMs: 0,
      artifactRetryDelaysMs: [1, 1],
    })

    expect(run.ok).toBe(true)
    const uploads = requests.filter((request) => request.method === 'PUT' && request.url === '/upload/report.md')
    expect(uploads).toHaveLength(2)
    expect(uploads[0].body).toBe('# retry exactly these bytes\n')
    expect(uploads[1].body).toBe(uploads[0].body)
  })

  it('times out and retries a half-open artifact upload-url request without hanging the worker', async () => {
    const executorFile = join(tempDir, 'hung-upload-url-executor.mjs')
    uploadRequestHang = true
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')
fs.writeFileSync(file, 'artifact bytes')
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'report.md', file }] }) + '\\n')
`,
      'utf8',
    )
    const startedAt = Date.now()
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_upload_timeout',
      progressHeartbeatIntervalMs: 0,
      artifactRequestTimeoutMs: 25,
      artifactRetryDelaysMs: [1],
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_request_timeout')
    expect(requests.filter((request) => request.url === '/api/artifacts/upload-url')).toHaveLength(2)
  })

  it('does not retry an artifact PUT after a permanent 4xx response', async () => {
    const executorFile = join(tempDir, 'permanent-upload-error-executor.mjs')
    uploadFailuresRemaining = 1
    uploadFailureStatus = 400
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')
fs.writeFileSync(file, 'invalid upload')
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'report.md', file }] }) + '\\n')
`,
      'utf8',
    )
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_permanent_upload_error',
      progressHeartbeatIntervalMs: 0,
      artifactRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('artifact_upload_failed')
    expect(requests.filter((request) => request.method === 'PUT' && request.url === '/upload/report.md')).toHaveLength(1)
  })

  it('does not retry a non-JSON permanent 4xx artifact response', async () => {
    const executorFile = join(tempDir, 'non-json-upload-error-executor.mjs')
    uploadUrlFailuresRemaining = 1
    uploadUrlFailureStatus = 400
    await writeFile(
      executorFile,
      `import fs from 'node:fs'
import path from 'node:path'
const file = path.join(process.env.KAIGONGBA_WORK_ITEM_OUTPUT_DIR, 'report.md')
fs.writeFileSync(file, 'invalid upload')
process.stdout.write(JSON.stringify({ artifacts: [{ name: 'report.md', file }] }) + '\\n')
`,
      'utf8',
    )
    const run = await runWorkItem({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      workerId: 'worker_non_json_upload_error',
      progressHeartbeatIntervalMs: 0,
      artifactRetryDelaysMs: [1, 1, 1],
    })

    expect(run.ok).toBe(false)
    expect(run.errorCode).toBe('request_failed')
    expect(requests.filter((request) => request.url === '/api/artifacts/upload-url')).toHaveLength(1)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('terminates the external executor process tree when execution times out', async () => {
    const executorFile = join(tempDir, 'stubborn-executor.mjs')
    const parentPidFile = join(tempDir, 'stubborn-parent.pid')
    const childPidFile = join(tempDir, 'stubborn-child.pid')
    await writeFile(
      executorFile,
      `import { spawn } from 'node:child_process'\nimport fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))\nprocess.on('SIGTERM', () => {})\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)") }], { stdio: 'ignore' })\nfs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))\nlet sequence = 0\nsetInterval(() => { sequence += 1; process.stdout.write(JSON.stringify({ protocol: 'kaigongba.executor.v1', type: 'lifecycle', sequence, eventId: 'hard:' + sequence, occurredAt: new Date().toISOString(), state: 'working', message: 'working' }) + '\\n') }, 20)\nprocess.stdin.resume()\nsetInterval(() => {}, 1000)\n`,
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
      expect(run.errorCode).toBe('executor_hard_timeout')
      expect(run.error).toBe('Executor exceeded hard timeout of 80ms')
      expect(parentPid).toBeGreaterThan(0)
      expect(childPid).toBeGreaterThan(0)
      expect(await waitForProcessExit(parentPid, 1500)).toBe(true)
      expect(await waitForProcessExit(childPid, 1500)).toBe(true)
    } finally {
      killProcess(parentPid)
      killProcess(childPid)
    }
  })

  it('terminates the executor process tree when a protocol error aborts the stream', async () => {
    const executorFile = join(tempDir, 'protocol-abort-executor.mjs')
    const parentPidFile = join(tempDir, 'protocol-abort-parent.pid')
    const childPidFile = join(tempDir, 'protocol-abort-child.pid')
    const childReadyFile = join(tempDir, 'protocol-abort-child.ready')
    await writeFile(
      executorFile,
      `import { spawn } from 'node:child_process'
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid))
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(childReadyFile)}, 'ready'); setInterval(() => {}, 1000)`)}], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
while (!fs.existsSync(${JSON.stringify(childReadyFile)})) {}
for (let index = 0; index < 4; index += 1) process.stdout.write('{"protocol":"kaigongba.executor.v1"\\n')
process.stdin.resume()
setInterval(() => {}, 1000)
`,
      'utf8',
    )

    let parentPid = null
    let childPid = null
    try {
      const run = await runWorkItem({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: `node "${executorFile}"`,
        workerId: 'worker_protocol_abort',
        executorKillGraceMs: 30,
        progressHeartbeatIntervalMs: 0,
      })
      parentPid = await readPidFile(parentPidFile)
      childPid = await readPidFile(childPidFile)

      expect(run.ok).toBe(false)
      expect(run.errorCode).toBe('executor_protocol_error')
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
