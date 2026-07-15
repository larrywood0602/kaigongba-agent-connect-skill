import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readConnectionConfig, writeConnectionConfig } from './lib.mjs'

let tempDir
let previousConfig

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.KAIGONGBA_CONNECTION_CONFIG
  else process.env.KAIGONGBA_CONNECTION_CONFIG = previousConfig
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

it('atomically writes connection credentials with private directory and file modes', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kgb-config-security-'))
  previousConfig = process.env.KAIGONGBA_CONNECTION_CONFIG
  const configFile = join(tempDir, '.kaigongba', 'connection.json')
  process.env.KAIGONGBA_CONNECTION_CONFIG = configFile

  await writeConnectionConfig({ connectionId: 'conn_private', agentToken: 'token_private' })

  expect((await stat(dirname(configFile))).mode & 0o777).toBe(0o700)
  expect((await stat(configFile)).mode & 0o777).toBe(0o600)
  expect(await readConnectionConfig()).toMatchObject({ connectionId: 'conn_private', agentToken: 'token_private' })
  expect(await readdir(dirname(configFile))).toEqual(['connection.json'])
})
