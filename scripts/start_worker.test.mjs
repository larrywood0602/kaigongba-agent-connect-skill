import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProcessRunning, startWorker, stopExisting, workerDaemonArgs, workerProcessEnvironment } from './start_worker.mjs'
import { runWorkerDaemon } from './worker_daemon.mjs'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

vi.mock('./worker_daemon.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, runWorkerDaemon: vi.fn(actual.runWorkerDaemon) }
})

let tempDir
let previousConfig

describe('start worker', () => {
  beforeEach(async () => {
    spawn.mockClear()
    runWorkerDaemon.mockClear()
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

  it('starts the detached worker with only required and explicitly allowed environment values', async () => {
    const names = [
      'KAIGONGBA_CONNECT_CODE',
      'KAIGONGBA_AGENT_TOKEN',
      'THIRD_PARTY_API_KEY',
      'DATABASE_PASSWORD',
      'RANDOM_SECRET',
      'SERVICE_TOKEN',
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'CODEX_HOME',
      'LANG',
      'LC_ALL',
      'KAIGONGBA_EXECUTOR_ENV_ALLOWLIST',
      'KAIGONGBA_EXECUTOR_TIMEOUT_MS',
      'KAIGONGBA_EXECUTOR_JSONL',
      'AI_API_KEY',
      'KAIGONGBA_CONNECTION_ID',
      'KAIGONGBA_API_BASE_URL',
    ]
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    Object.assign(process.env, {
      KAIGONGBA_CONNECT_CODE: 'kgbc_consumed',
      KAIGONGBA_AGENT_TOKEN: 'platform-agent-token',
      THIRD_PARTY_API_KEY: 'unrequested-key',
      DATABASE_PASSWORD: 'database-password',
      RANDOM_SECRET: 'random-secret',
      SERVICE_TOKEN: 'service-token',
      NODE_OPTIONS: '--require /tmp/injected.cjs',
      NODE_PATH: '/tmp/injected-modules',
      LD_PRELOAD: '/tmp/injected.so',
      DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
      BASH_ENV: '/tmp/injected-bash-env',
      ENV: '/tmp/injected-shell-env',
      CODEX_HOME: '/tmp/codex-home',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      KAIGONGBA_EXECUTOR_ENV_ALLOWLIST: 'AI_API_KEY,NODE_OPTIONS,NODE_PATH,LD_PRELOAD,DYLD_INSERT_LIBRARIES,BASH_ENV,ENV,KAIGONGBA_CONNECT_CODE,KAIGONGBA_AGENT_TOKEN',
      KAIGONGBA_EXECUTOR_TIMEOUT_MS: '7200000',
      KAIGONGBA_EXECUTOR_JSONL: '1',
      AI_API_KEY: 'explicit-model-key',
      KAIGONGBA_CONNECTION_ID: 'stale-connection-id',
      KAIGONGBA_API_BASE_URL: 'https://stale.example',
    })

    try {
      await startWorker({
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: 'node external-agent-runner.mjs',
        maxIterations: 0,
      })

      const detachedCall = spawn.mock.calls.find(([, , options]) => options?.detached)
      const workerEnv = detachedCall?.[2]?.env
      expect(workerEnv).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CODEX_HOME: '/tmp/codex-home',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        KAIGONGBA_CONNECTION_CONFIG: process.env.KAIGONGBA_CONNECTION_CONFIG,
        KAIGONGBA_EXECUTOR_COMMAND: 'node external-agent-runner.mjs',
        KAIGONGBA_EXECUTOR_ENV_ALLOWLIST: 'AI_API_KEY,NODE_OPTIONS,NODE_PATH,LD_PRELOAD,DYLD_INSERT_LIBRARIES,BASH_ENV,ENV,KAIGONGBA_CONNECT_CODE,KAIGONGBA_AGENT_TOKEN',
        KAIGONGBA_EXECUTOR_TIMEOUT_MS: '7200000',
        KAIGONGBA_EXECUTOR_JSONL: '1',
        AI_API_KEY: 'explicit-model-key',
      })
      expect(workerEnv).not.toHaveProperty('KAIGONGBA_CONNECT_CODE')
      expect(workerEnv).not.toHaveProperty('KAIGONGBA_AGENT_TOKEN')
      expect(workerEnv).not.toHaveProperty('THIRD_PARTY_API_KEY')
      expect(workerEnv).not.toHaveProperty('DATABASE_PASSWORD')
      expect(workerEnv).not.toHaveProperty('RANDOM_SECRET')
      expect(workerEnv).not.toHaveProperty('SERVICE_TOKEN')
      expect(workerEnv).not.toHaveProperty('NODE_OPTIONS')
      expect(workerEnv).not.toHaveProperty('NODE_PATH')
      expect(workerEnv).not.toHaveProperty('LD_PRELOAD')
      expect(workerEnv).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
      expect(workerEnv).not.toHaveProperty('BASH_ENV')
      expect(workerEnv).not.toHaveProperty('ENV')
      expect(workerEnv).not.toHaveProperty('KAIGONGBA_CONNECTION_ID')
      expect(workerEnv).not.toHaveProperty('KAIGONGBA_API_BASE_URL')
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('filters forbidden values added after the worker allowlist is built', () => {
    expect(workerProcessEnvironment({}, {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/injected.cjs',
      KAIGONGBA_CONNECT_CODE: 'kgbc_readded',
      KAIGONGBA_AGENT_TOKEN: 'token_readded',
    })).toEqual({ PATH: '/usr/bin' })
  })

  it('clears stale platform environment during foreground execution and restores it on failure', async () => {
    const values = {
      KAIGONGBA_CONNECT_CODE: 'kgbc_consumed',
      KAIGONGBA_AGENT_TOKEN: 'stale-agent-token',
      KAIGONGBA_VENDOR_API_KEY: 'stale-platform-api-key',
      KAIGONGBA_DATABASE_PASSWORD: 'stale-platform-password',
      KAIGONGBA_CONNECTION_ID: 'stale-connection-id',
      KAIGONGBA_API_BASE_URL: 'https://stale.example',
    }
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
    Object.assign(process.env, values)
    runWorkerDaemon.mockImplementationOnce(async () => {
      for (const name of Object.keys(values)) expect(process.env[name]).toBeUndefined()
      throw new Error('foreground failed')
    })

    try {
      await expect(startWorker({
        foreground: true,
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: 'node external-agent-runner.mjs',
      })).rejects.toThrow('foreground failed')
      for (const [name, value] of Object.entries(values)) expect(process.env[name]).toBe(value)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('clears stale platform environment during foreground execution and restores it on success', async () => {
    const values = {
      KAIGONGBA_CONNECT_CODE: 'kgbc_consumed',
      KAIGONGBA_AGENT_TOKEN: 'stale-agent-token',
      KAIGONGBA_VENDOR_SECRET: 'stale-platform-secret',
      KAIGONGBA_CONNECTION_ID: 'stale-connection-id',
      KAIGONGBA_API_BASE_URL: 'https://stale.example',
    }
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
    Object.assign(process.env, values)
    runWorkerDaemon.mockImplementationOnce(async () => {
      for (const name of Object.keys(values)) expect(process.env[name]).toBeUndefined()
      return { ok: true, connectionId: 'conn_start', iterations: 0, runs: 0 }
    })

    try {
      await expect(startWorker({
        foreground: true,
        outputDir: join(tempDir, '.kaigongba/runtime'),
        executorCommand: 'node external-agent-runner.mjs',
      })).resolves.toMatchObject({ foreground: true, connectionId: 'conn_start' })
      for (const [name, value] of Object.entries(values)) expect(process.env[name]).toBe(value)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
