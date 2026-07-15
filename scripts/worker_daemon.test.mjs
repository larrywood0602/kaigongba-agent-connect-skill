import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWorkerDaemon } from './worker_daemon.mjs'

let tempDir
let previousCwd
let previousConfig
let server
let baseUrl
let requests
let workItemQueueReads

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

function queuedWorkItem() {
  return {
    id: 'work_daemon_1',
    connectionId: 'conn_daemon',
    orderId: 'order_daemon_1',
    serviceSopId: 'sop_daemon',
    nodeKey: 'external_agent_execution',
    status: 'queued',
    payload: {
      requirement: { goal: '生成一份任务成果' },
      execution: {
        hardTimeoutMs: 3 * 60 * 60 * 1000,
        idleTimeoutMs: 15 * 60 * 1000,
        maxHardTimeoutMs: 6 * 60 * 60 * 1000,
      },
      callback: {
        runId: 'order_daemon_1',
        connectionId: 'conn_daemon',
        serviceSopId: 'sop_daemon',
        nodeKey: 'external_agent_execution',
      },
      idempotencyKey: 'order_daemon_1-external_agent_execution-initial',
    },
  }
}

async function startMockServer() {
  requests = []
  workItemQueueReads = 0
  server = createServer(async (req, res) => {
    const body = await readBody(req)
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })

    if (req.url === '/api/agent-connections/conn_daemon/runs' && req.method === 'GET') {
      jsonResponse(res, { connection: { id: 'conn_daemon' }, serviceSop: { id: 'sop_daemon' }, runs: [] })
      return
    }
    if (req.url === '/api/agent/work-items?connectionId=conn_daemon' && req.method === 'GET') {
      workItemQueueReads += 1
      jsonResponse(res, {
        connection: { id: 'conn_daemon' },
        workItems: workItemQueueReads === 1 ? [] : [queuedWorkItem()],
      })
      return
    }
    if (req.url === '/api/agent/work-items/work_daemon_1/claim' && req.method === 'POST') {
      jsonResponse(res, { workItem: { ...queuedWorkItem(), status: 'claimed' } })
      return
    }
    if (req.url === '/api/workflow-runs/order_daemon_1/events' && req.method === 'POST') {
      jsonResponse(res, { event: { id: `event_${requests.length}`, ...body }, duplicate: false })
      return
    }

    jsonResponse(res, { code: 'not_found', message: `${req.method} ${req.url}` }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
}

describe('worker daemon', () => {
  beforeEach(async () => {
    previousCwd = process.cwd()
    previousConfig = process.env.KAIGONGBA_CONNECTION_CONFIG
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-worker-daemon-'))
    process.chdir(tempDir)
    await mkdir(join(tempDir, '.kaigongba'), { recursive: true })
    process.env.KAIGONGBA_CONNECTION_CONFIG = join(tempDir, '.kaigongba/connection.json')
    await startMockServer()
    await writeFile(
      process.env.KAIGONGBA_CONNECTION_CONFIG,
      `${JSON.stringify({ apiBaseUrl: baseUrl, connectionId: 'conn_daemon', agentToken: 'token_daemon', serviceSopId: 'sop_daemon' }, null, 2)}\n`,
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

  it('polls until a work item appears, executes it, and records worker status', async () => {
    const executorFile = join(tempDir, 'executor.mjs')
    await writeFile(
      executorFile,
      `let raw = ''\nprocess.stdin.on('data', (chunk) => { raw += chunk })\nprocess.stdin.on('end', () => {\n  const workItem = JSON.parse(raw)\n  console.log(JSON.stringify({\n    progressEvents: [{ progress: 45, message: 'executor handled ' + workItem.id }],\n    finalMessage: 'daemon executor completed'\n  }))\n})\n`,
      'utf8',
    )

    const result = await runWorkerDaemon({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      pollIntervalMs: 1,
      maxIterations: 2,
    })

    expect(result).toMatchObject({ ok: true, iterations: 2, runs: 1, idlePolls: 1, failures: 0 })
    expect(requests.filter((request) => request.url === '/api/agent/work-items?connectionId=conn_daemon')).toHaveLength(3)
    expect(requests.some((request) => request.url === '/api/agent/work-items/work_daemon_1/claim')).toBe(true)
    expect(requests.filter((request) => request.url === '/api/workflow-runs/order_daemon_1/events').map((request) => request.body.event)).toEqual([
      'node.started',
      'node.progress',
      'node.completed',
    ])
    expect(requests.every((request) => request.headers.authorization === 'Bearer token_daemon')).toBe(true)

    const status = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/worker-status.json'), 'utf8'))
    expect(status).toMatchObject({
      ok: true,
      connectionId: 'conn_daemon',
      iterations: 2,
      runs: 1,
      lastRun: { ok: true, workItemId: 'work_daemon_1' },
    })
    const lastRun = JSON.parse(await readFile(join(tempDir, '.kaigongba/runtime/last-run-result.json'), 'utf8'))
    expect(lastRun.executionMetrics.timeoutSource).toBe('work_item')
  })

  it('reloads connection config between polls so relinked agents bind without restart', async () => {
    let reloaded = false
    requests = []
    workItemQueueReads = 0
    await new Promise((resolve) => server.close(resolve))
    server = createServer(async (req, res) => {
      const body = await readBody(req)
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })

      if (req.url === '/api/agent-connections/conn_old/runs' && req.method === 'GET') {
        jsonResponse(res, { connection: { id: 'conn_old' }, serviceSop: { id: 'sop_old' }, runs: [] })
        return
      }
      if (req.url === '/api/agent/work-items?connectionId=conn_old' && req.method === 'GET') {
        jsonResponse(res, { connection: { id: 'conn_old' }, workItems: [] })
        return
      }
      if (req.url === '/api/agent-connections/conn_new/runs' && req.method === 'GET') {
        jsonResponse(res, { connection: { id: 'conn_new' }, serviceSop: { id: 'sop_daemon' }, runs: [] })
        return
      }
      if (req.url === '/api/agent/work-items?connectionId=conn_new' && req.method === 'GET') {
        workItemQueueReads += 1
        jsonResponse(res, { connection: { id: 'conn_new' }, workItems: [queuedWorkItem()] })
        return
      }
      if (req.url === '/api/agent/work-items/work_daemon_1/claim' && req.method === 'POST') {
        jsonResponse(res, { workItem: { ...queuedWorkItem(), connectionId: 'conn_new', status: 'claimed' } })
        return
      }
      if (req.url === '/api/workflow-runs/order_daemon_1/events' && req.method === 'POST') {
        jsonResponse(res, { event: { id: `event_${requests.length}`, ...body }, duplicate: false })
        return
      }
      jsonResponse(res, { code: 'not_found', message: `${req.method} ${req.url}` }, 404)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
    await writeFile(
      process.env.KAIGONGBA_CONNECTION_CONFIG,
      `${JSON.stringify({ apiBaseUrl: baseUrl, connectionId: 'conn_old', agentToken: 'token_old', serviceSopId: 'sop_old' }, null, 2)}\n`,
      'utf8',
    )

    const executorFile = join(tempDir, 'executor-reload.mjs')
    await writeFile(
      executorFile,
      `process.stdin.resume()\nprocess.stdin.on('end', () => console.log(JSON.stringify({ finalMessage: 'new connection handled' })))\n`,
      'utf8',
    )

    const result = await runWorkerDaemon({
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: `node "${executorFile}"`,
      pollIntervalMs: 1,
      maxIterations: 2,
    }, {
      sleep: async () => {
        if (reloaded) return
        reloaded = true
        await writeFile(
          process.env.KAIGONGBA_CONNECTION_CONFIG,
          `${JSON.stringify({ apiBaseUrl: baseUrl, connectionId: 'conn_new', agentToken: 'token_new', serviceSopId: 'sop_daemon' }, null, 2)}\n`,
          'utf8',
        )
      },
    })

    expect(result).toMatchObject({ ok: true, connectionId: 'conn_new', runs: 1, idlePolls: 1 })
    expect(requests.map((request) => request.url)).toEqual(expect.arrayContaining([
      '/api/agent/work-items?connectionId=conn_old',
      '/api/agent/work-items?connectionId=conn_new',
      '/api/agent/work-items/work_daemon_1/claim',
    ]))
  })

  it('runs the executor from the runtime directory when the daemon cwd was replaced', async () => {
    const outputDir = join(tempDir, '.kaigongba/runtime')
    const staleCwd = join(tempDir, 'stale-cwd')
    await mkdir(staleCwd, { recursive: true })
    process.chdir(staleCwd)
    await rm(staleCwd, { recursive: true, force: true })

    const executorFile = join(tempDir, 'executor-cwd.mjs')
    await writeFile(
      executorFile,
      `process.stdin.resume()\nprocess.stdin.on('end', () => {\n  console.log(JSON.stringify({\n    progressEvents: [{ progress: 5, message: process.cwd() }],\n    finalMessage: process.env.KAIGONGBA_CODEX_OUTPUT_DIR\n  }))\n})\n`,
      'utf8',
    )

    const result = await runWorkerDaemon({
      outputDir,
      executorCommand: `node "${executorFile}"`,
      pollIntervalMs: 1,
      maxIterations: 2,
    })

    expect(result).toMatchObject({ ok: true, runs: 1, failures: 0 })
    const lastRun = JSON.parse(await readFile(join(outputDir, 'last-run-result.json'), 'utf8'))
    expect(await realpath(lastRun.executorResult.progressEvents[0].message)).toBe(await realpath(outputDir))
    expect(lastRun.executorResult.finalMessage).toBe(await realpath(join(outputDir, 'codex-artifacts')))
  })
})
