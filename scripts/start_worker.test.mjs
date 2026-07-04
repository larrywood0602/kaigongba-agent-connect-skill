import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProcessRunning, startWorker, stopExisting, workerDaemonArgs } from './start_worker.mjs'

let tempDir
let previousConfig

describe('start worker', () => {
  beforeEach(async () => {
    previousConfig = process.env.KAIGONGBA_CONNECTION_CONFIG
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-start-worker-'))
    await mkdir(join(tempDir, '.kaigongba'), { recursive: true })
    process.env.KAIGONGBA_CONNECTION_CONFIG = join(tempDir, '.kaigongba/connection.json')
    await writeFile(
      process.env.KAIGONGBA_CONNECTION_CONFIG,
      `${JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:3100', connectionId: 'conn_start', agentToken: 'token_start' }, null, 2)}\n`,
      'utf8',
    )
  })

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.KAIGONGBA_CONNECTION_CONFIG
    else process.env.KAIGONGBA_CONNECTION_CONFIG = previousConfig
    await rm(tempDir, { recursive: true, force: true })
  })

  it('requires an external Agent runner command', async () => {
    await expect(startWorker({ foreground: true, maxIterations: 0 })).rejects.toThrow('KAIGONGBA_EXECUTOR_COMMAND')
  })

  it('can start in foreground using the current connection config', async () => {
    const result = await startWorker({
      foreground: true,
      maxIterations: 0,
      outputDir: join(tempDir, '.kaigongba/runtime'),
      executorCommand: 'node external-agent-runner.mjs',
    })

    expect(result).toMatchObject({
      foreground: true,
      connectionId: 'conn_start',
      iterations: 0,
      runs: 0,
    })
  })

  it('waits for the existing worker process to exit before restart continues', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const pidFile = join(tempDir, '.kaigongba/runtime/worker.pid')
    await mkdir(join(tempDir, '.kaigongba/runtime'), { recursive: true })
    await writeFile(pidFile, `${child.pid}\n`, 'utf8')

    const result = await stopExisting(pidFile, { timeoutMs: 200 })

    expect(result).toMatchObject({ stopped: true, pid: child.pid, exited: true })
    expect(isProcessRunning(child.pid)).toBe(false)
  })

  it('passes execution lifecycle options to the background daemon', () => {
    const argv = workerDaemonArgs({
      timeoutMs: 1800000,
      pollIntervalMs: 2000,
      errorIntervalMs: 3000,
      leaseSeconds: 120,
      leaseRenewIntervalMs: 40000,
      maxIterations: 1,
      once: true,
    }, {
      outputDir: '/tmp/kgb-runtime',
      statusFile: '/tmp/kgb-runtime/worker-status.json',
    })

    expect(argv).toEqual(expect.arrayContaining([
      '--timeout-ms',
      '1800000',
      '--poll-interval-ms',
      '2000',
      '--error-interval-ms',
      '3000',
      '--lease-seconds',
      '120',
      '--lease-renew-interval-ms',
      '40000',
      '--max-iterations',
      '1',
      '--once',
    ]))
  })
})
