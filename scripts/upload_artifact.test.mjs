import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scriptFile = join(dirname(fileURLToPath(import.meta.url)), 'upload_artifact.mjs')
let tempDir
let server
let requests

async function requestBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function runScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptFile, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

describe('upload artifact CLI', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-upload-artifact-'))
    requests = []
    server = createServer(async (req, res) => {
      const bytes = await requestBody(req)
      let body = bytes.toString('utf8')
      try {
        body = body ? JSON.parse(body) : {}
      } catch {
        // Keep upload bytes as text for exact assertions.
      }
      requests.push({ method: req.method, url: req.url, body })
      if (req.url === '/api/artifacts/upload-url') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          uploadId: 'upload_cli_1',
          uploadUrl: `http://${req.headers.host}/upload/report.md`,
          externalUrl: `http://${req.headers.host}/download/report.md`,
        }))
        return
      }
      if (req.url === '/upload/report.md' && req.method === 'PUT') {
        res.writeHead(200)
        res.end('ok')
        return
      }
      if (req.url === '/api/workflow-runs/run_cli_1/events') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ artifact: { id: 'artifact_cli_1', ...body.artifact } }))
        return
      }
      if (req.url === '/api/artifacts/artifact_cli_1/complete') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ artifact: { id: 'artifact_cli_1', status: 'uploaded' } }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'not_found' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(tempDir, { recursive: true, force: true })
  })

  it('uploads bytes from a verified stable snapshot and reports its digest', async () => {
    const file = join(tempDir, 'report.md')
    const bytes = Buffer.from('# verified CLI artifact\n', 'utf8')
    const configFile = join(tempDir, 'connection.json')
    const { port } = server.address()
    await writeFile(file, bytes)
    await writeFile(configFile, JSON.stringify({
      apiBaseUrl: `http://127.0.0.1:${port}`,
      connectionId: 'conn_cli',
      agentToken: 'token_cli',
      serviceSopId: 'sop_cli',
    }))

    const result = await runScript([
      '--run-id', 'run_cli_1',
      '--node-key', 'external_agent_execution',
      '--sequence', '4',
      '--file', file,
    ], {
      ...process.env,
      KAIGONGBA_CONNECTION_CONFIG: configFile,
      KAIGONGBA_ARTIFACT_STABLE_WINDOW_MS: '5',
      KAIGONGBA_ARTIFACT_STABLE_POLL_INTERVAL_MS: '1',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/(?:upload|external|download)Url/i)
    expect(requests.find((request) => request.url === '/upload/report.md')?.body).toBe(bytes.toString('utf8'))
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex')
    expect(requests.find((request) => request.url === '/api/artifacts/upload-url')?.body).toMatchObject({
      sizeBytes: bytes.length,
      sha256: expectedSha256,
    })
    expect(requests.find((request) => request.url === '/api/workflow-runs/run_cli_1/events')?.body.artifact)
      .toMatchObject({ sizeBytes: bytes.length, sha256: expectedSha256 })
    const stageEntries = await readFile(file, 'utf8')
    expect(stageEntries).toBe(bytes.toString('utf8'))
    expect(await readdir(join(tempDir, '.kaigongba-stable'))).toEqual([])
  })
})
