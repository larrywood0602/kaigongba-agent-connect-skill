import { copyFile, link, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendProgressRecord } from './report_progress.mjs'

const sourceHelper = join(dirname(fileURLToPath(import.meta.url)), 'report_progress.mjs')
const execFileAsync = promisify(execFile)
let tempDir
let helperFile
let spoolFile

describe('report progress helper', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-report-progress-'))
    helperFile = join(tempDir, 'report_progress.mjs')
    spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    await copyFile(sourceHelper, helperFile)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes one exact semantic progress record beside the copied helper', async () => {
    const result = spawnSync(process.execPath, [
      helperFile,
      '--phase', 'PPT 生成',
      '--current', '6',
      '--total', '12',
      '--unit', 'page',
      '--message', '已完成第 6 页',
    ], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    const records = (await readFile(spoolFile, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      phase: 'PPT 生成',
      current: 6,
      total: 12,
      unit: 'page',
      message: '已完成第 6 页',
    })
    expect(records[0].recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(records[0]).not.toHaveProperty('sequence')
    expect(new Date(records[0].occurredAt).toISOString()).toBe(records[0].occurredAt)
    expect(Buffer.byteLength(JSON.stringify(records[0]), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it.each([
    ['negative current', ['--phase', '生成', '--current', '-1', '--total', '12']],
    ['current above total', ['--phase', '生成', '--current', '13', '--total', '12']],
    ['phase above 256 bytes', ['--phase', 'x'.repeat(257)]],
    ['unit above 64 bytes', ['--phase', '生成', '--unit', 'x'.repeat(65)]],
    ['message above 2000 characters', ['--phase', '生成', '--message', 'x'.repeat(2_001)]],
  ])('rejects %s without appending a record', async (_name, args) => {
    await writeFile(spoolFile, `${JSON.stringify({ sequence: 4, phase: '原记录' })}\n`, 'utf8')

    const result = spawnSync(process.execPath, [helperFile, ...args], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect((await readFile(spoolFile, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('accepts exact field limits while keeping one record below the line cap', async () => {
    await appendProgressRecord({
      phase: 'p'.repeat(256),
      unit: 'u'.repeat(64),
      message: '页'.repeat(2_000),
    }, { spoolFile })

    const line = (await readFile(spoolFile, 'utf8')).trim()
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.parse(line)).toMatchObject({
      phase: 'p'.repeat(256),
      unit: 'u'.repeat(64),
      message: '页'.repeat(2_000),
    })
  })

  it('ignores an obsolete stale lock file instead of waiting for or deleting it', async () => {
    const lockFile = `${spoolFile}.lock`
    await writeFile(lockFile, 'obsolete-lock-format', { mode: 0o600 })
    const staleAt = new Date(Date.now() - 60_000)
    await utimes(lockFile, staleAt, staleAt)

    const record = await appendProgressRecord({ phase: '继续执行', message: '处理中' }, { spoolFile })

    expect(record.recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await readFile(lockFile, 'utf8')).toBe('obsolete-lock-format')
    expect(JSON.parse((await readFile(spoolFile, 'utf8')).trim().split('\n').at(-1))).toMatchObject({
      phase: '继续执行',
      message: '处理中',
    })
  })

  it('appends 50 concurrent process records without sequence RMW or JSONL corruption', async () => {
    const processCount = 50

    await Promise.all(Array.from({ length: processCount }, (_unused, index) => execFileAsync(process.execPath, [
      helperFile,
      '--phase', '并发生成',
      '--current', String(index + 1),
      '--total', String(processCount),
      '--message', `worker-${index + 1}`,
    ])))

    const lines = (await readFile(spoolFile, 'utf8')).trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(processCount)
    const records = lines.map(JSON.parse)
    expect(new Set(records.map((record) => record.recordId)).size).toBe(processCount)
    expect(records.every((record) => !Object.hasOwn(record, 'sequence'))).toBe(true)
    expect(new Set(records.map((record) => record.message)).size).toBe(processCount)
    expect(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 16 * 1024)).toBe(true)
  })

  it('rejects a spool path that is a symbolic link', async () => {
    const outsideFile = join(tempDir, 'outside.jsonl')
    await writeFile(outsideFile, 'outside-safe\n', 'utf8')
    await symlink(outsideFile, spoolFile)

    const result = spawnSync(process.execPath, [helperFile, '--phase', '不应写入'], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('progress_spool_symlink')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-safe\n')
  })

  it('fails quickly when the spool has reached its total size cap', async () => {
    await writeFile(spoolFile, Buffer.alloc(8 * 1024 * 1024, 0x20), { mode: 0o600 })
    const startedAt = Date.now()

    await expect(appendProgressRecord({ phase: '容量检查' }, { spoolFile })).rejects.toMatchObject({
      code: 'progress_spool_full',
    })
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect((await stat(spoolFile)).size).toBe(8 * 1024 * 1024)
  })

  it('rejects a FIFO without blocking the helper process', async () => {
    const fifoResult = spawnSync('mkfifo', [spoolFile], { encoding: 'utf8' })
    expect(fifoResult.status).toBe(0)

    const result = spawnSync(process.execPath, [helperFile, '--phase', '不应阻塞'], {
      encoding: 'utf8',
      timeout: 500,
    })

    expect(result.status).not.toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('progress_spool_invalid')
  })

  it('rejects a hard-linked spool without modifying the linked file', async () => {
    const linkedFile = join(tempDir, 'linked.jsonl')
    await writeFile(linkedFile, 'linked-safe\n', 'utf8')
    await link(linkedFile, spoolFile)

    const result = spawnSync(process.execPath, [helperFile, '--phase', '不应写入'], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('progress_spool_hardlink')
    expect(await readFile(linkedFile, 'utf8')).toBe('linked-safe\n')
  })
})
