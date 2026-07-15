import { createHash } from 'node:crypto'
import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertSecureFilesystemSupport,
  cleanupStableArtifactSnapshot,
  DEFAULT_MAX_ARTIFACT_BYTES,
  stableArtifactSnapshot,
  startProgressSpoolReader,
  verifyStableArtifactSnapshot,
  withVerifiedStableArtifact,
} from './runtime_activity.mjs'
import { appendProgressRecord } from './report_progress.mjs'

let tempDir
let outsideDir

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await delay(5)
  }
}

describe('runtime activity', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-runtime-activity-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'kgb-runtime-outside-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('waits for a newline across chunks and deduplicates local sequences', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const records = []
    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: async (record) => records.push(record),
    })
    const record = {
      sequence: 1,
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase: 'PPT 生成',
      current: 6,
      total: 12,
      unit: 'page',
      message: '已完成第 6 页',
    }
    const line = JSON.stringify(record)
    const splitAt = Math.floor(line.length / 2)

    await appendFile(spoolFile, line.slice(0, splitAt), 'utf8')
    await delay(25)
    expect(records).toEqual([])
    await appendFile(spoolFile, `${line.slice(splitAt)}\n${line}\n`, 'utf8')
    await waitFor(() => records.length === 1)
    await stop()

    expect(records).toEqual([expect.objectContaining({
      sequence: 1,
      phase: 'PPT 生成',
      percent: 50,
    })])
  })

  it('deduplicates UUID records while assigning reader-local sequences', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const records = []
    const record = {
      recordId: '550e8400-e29b-41d4-a716-446655440000',
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase: '文件生成',
      message: '稳定写入',
    }
    await writeFile(spoolFile, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`, 'utf8')

    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: (next) => records.push(next),
    })
    await waitFor(() => records.length === 1)
    await delay(20)
    await stop()

    expect(records).toEqual([expect.objectContaining({
      recordId: record.recordId,
      sequence: 1,
      phase: '文件生成',
    })])
  })

  it('ignores malformed progress lines instead of emitting them', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const records = []
    await writeFile(spoolFile, [
      'not-json',
      JSON.stringify({ sequence: 0, occurredAt: 'bad', phase: '无效' }),
      JSON.stringify({
        sequence: 1,
        occurredAt: '2026-07-15T03:00:00.000Z',
        phase: '有效',
        message: '处理中',
      }),
      '',
    ].join('\n'), 'utf8')
    const stop = startProgressSpoolReader({ spoolFile, pollIntervalMs: 5, onRecord: (record) => records.push(record) })

    await waitFor(() => records.length === 1)
    await stop()

    expect(records).toEqual([expect.objectContaining({ sequence: 1, phase: '有效' })])
  })

  it('emits every concurrent record in physical JSONL order with reader-local sequences', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const records = []
    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: (record) => records.push(record),
    })

    const written = await Promise.all(Array.from({ length: 20 }, (_unused, index) => appendProgressRecord({
      phase: '并发生成',
      current: index + 1,
      total: 20,
      message: `record-${index + 1}`,
    }, { spoolFile })))

    expect(new Set(written.map((record) => record.recordId)).size).toBe(20)
    await waitFor(() => records.length === 20)
    await stop()
    const physicalRecordIds = (await readFile(spoolFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).recordId)
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index + 1),
    )
    expect(records.map((record) => record.recordId)).toEqual(physicalRecordIds)
  })

  it('resynchronizes after a partial JSON write before the next helper record', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    await writeFile(spoolFile, '{"recordId":"partial', 'utf8')
    const written = await appendProgressRecord({ phase: '恢复解析', message: '完整记录' }, { spoolFile })
    const records = []
    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: (record) => records.push(record),
    })

    await waitFor(() => records.length === 1)
    await stop()

    expect(records).toEqual([expect.objectContaining({
      recordId: written.recordId,
      sequence: 1,
      phase: '恢复解析',
    })])
  })

  it('drops an oversized unterminated line and resumes at the next newline', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const record = {
      recordId: '550e8400-e29b-41d4-a716-446655440001',
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase: '恢复读取',
    }
    await writeFile(spoolFile, `${'x'.repeat(80 * 1024)}\n${JSON.stringify(record)}\n`, 'utf8')
    const records = []
    const stop = startProgressSpoolReader({ spoolFile, pollIntervalMs: 5, onRecord: (next) => records.push(next) })

    await waitFor(() => records.length === 1)
    await stop()

    expect(records).toEqual([expect.objectContaining({ recordId: record.recordId, sequence: 1 })])
  })

  it('detects an equal-size file replacement and keeps sequence monotonic', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const replacementFile = join(tempDir, 'replacement.jsonl')
    const first = {
      recordId: '550e8400-e29b-41d4-a716-446655440002',
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase: '阶段甲',
    }
    const second = { ...first, recordId: '550e8400-e29b-41d4-a716-446655440003', phase: '阶段乙' }
    await writeFile(spoolFile, `${JSON.stringify(first)}\n`, 'utf8')
    await writeFile(replacementFile, `${JSON.stringify(second)}\n`, 'utf8')
    expect((await stat(spoolFile)).size).toBe((await stat(replacementFile)).size)
    const records = []
    const stop = startProgressSpoolReader({ spoolFile, pollIntervalMs: 5, onRecord: (next) => records.push(next) })
    await waitFor(() => records.length === 1)

    await rename(replacementFile, spoolFile)
    await waitFor(() => records.length === 2)
    await stop()

    expect(records.map(({ sequence, phase }) => ({ sequence, phase }))).toEqual([
      { sequence: 1, phase: '阶段甲' },
      { sequence: 2, phase: '阶段乙' },
    ])
  })

  it('keeps sequence monotonic after the same file is truncated', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const first = {
      recordId: '550e8400-e29b-41d4-a716-446655440004',
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase: '截断前的较长阶段',
    }
    const second = {
      recordId: '550e8400-e29b-41d4-a716-446655440005',
      occurredAt: '2026-07-15T03:00:01.000Z',
      phase: '截断后',
    }
    await writeFile(spoolFile, `${JSON.stringify(first)}\n`, 'utf8')
    const records = []
    const stop = startProgressSpoolReader({ spoolFile, pollIntervalMs: 5, onRecord: (next) => records.push(next) })
    await waitFor(() => records.length === 1)

    await writeFile(spoolFile, `${JSON.stringify(second)}\n`, 'utf8')
    await waitFor(() => records.length === 2)
    await stop()

    expect(records.map((record) => record.sequence)).toEqual([1, 2])
  })

  it('accepts a restarted legacy sequence after truncation without resetting reader sequence', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const legacy = (phase) => ({
      sequence: 1,
      occurredAt: '2026-07-15T03:00:00.000Z',
      phase,
    })
    await writeFile(spoolFile, `${JSON.stringify(legacy('旧文件记录较长'))}\n`, 'utf8')
    const records = []
    const stop = startProgressSpoolReader({ spoolFile, pollIntervalMs: 5, onRecord: (next) => records.push(next) })
    await waitFor(() => records.length === 1)

    await writeFile(spoolFile, `${JSON.stringify(legacy('新记录'))}\n`, 'utf8')
    await waitFor(() => records.length === 2)
    await stop()

    expect(records.map(({ sequence, phase }) => ({ sequence, phase }))).toEqual([
      { sequence: 1, phase: '旧文件记录较长' },
      { sequence: 2, phase: '新记录' },
    ])
  })

  it('backs off and reports a permanent spool symlink error only once', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    const target = join(outsideDir, 'outside.jsonl')
    await writeFile(target, 'outside\n', 'utf8')
    await symlink(target, spoolFile)
    const errors = []
    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: () => {},
      onError: (error) => errors.push(error),
    })

    await waitFor(() => errors.length === 1)
    await delay(80)
    await stop()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'ELOOP' })
  })

  it('rejects an oversized sparse spool before scanning any records', async () => {
    const spoolFile = join(tempDir, '.kaigongba-progress.jsonl')
    await writeFile(spoolFile, '', { mode: 0o600 })
    await truncate(spoolFile, (8 * 1024 * 1024) + 1)
    const errors = []
    const records = []
    const stop = startProgressSpoolReader({
      spoolFile,
      pollIntervalMs: 5,
      onRecord: (record) => records.push(record),
      onError: (error) => errors.push(error),
    })

    await waitFor(() => errors.length === 1)
    await delay(50)
    await stop()

    expect(records).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'progress_spool_full' })
  })

  it('waits through a file change and returns the stable final snapshot', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'draft', 'utf8')
    const snapshotPromise = stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 80,
      pollIntervalMs: 10,
    })
    await delay(30)
    await writeFile(file, 'final artifact bytes', 'utf8')

    const snapshot = await snapshotPromise

    expect(snapshot).toEqual(expect.objectContaining({
      relativePath: 'report.pptx',
      sizeBytes: Buffer.byteLength('final artifact bytes'),
      sha256: createHash('sha256').update('final artifact bytes').digest('hex'),
      status: 'stable',
    }))
    expect(snapshot.stableFile).toContain(`${join(tempDir, '.kaigongba-stable')}/`)
    expect(await readFile(snapshot.stableFile, 'utf8')).toBe('final artifact bytes')
    expect((await stat(join(tempDir, '.kaigongba-stable'))).mode & 0o777).toBe(0o700)
    expect((await stat(snapshot.stableFile)).mode & 0o777).toBe(0o400)
  })

  it('rejects a source replaced by an outside symlink during the stability window', async () => {
    const file = join(tempDir, 'report.pptx')
    const secret = join(outsideDir, 'secret.txt')
    await writeFile(file, 'safe draft', 'utf8')
    await writeFile(secret, 'outside secret bytes', 'utf8')

    const snapshotPromise = stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 80,
      pollIntervalMs: 10,
    })
    const rejection = expect(snapshotPromise).rejects.toMatchObject({ code: 'artifact_path_outside_output' })
    await delay(30)
    const replacement = join(tempDir, 'replacement-link')
    await symlink(secret, replacement)
    await rename(replacement, file)

    await rejection
  })

  it('rejects a source hard-linked to an outside secret', async () => {
    const file = join(tempDir, 'report.pptx')
    const secret = join(outsideDir, 'secret.txt')
    await writeFile(secret, 'outside secret bytes', 'utf8')
    await link(secret, file)

    await expect(stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })).rejects.toMatchObject({ code: 'artifact_hardlink_unsupported' })
  })

  it('rejects an oversized sparse artifact before staging it', async () => {
    const file = join(tempDir, 'oversized.pptx')
    await writeFile(file, '')
    await truncate(file, DEFAULT_MAX_ARTIFACT_BYTES + 1)

    await expect(stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 0,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ code: 'artifact_too_large' })
  })

  it('rejects a file that grows beyond its configured limit during the stability window', async () => {
    const file = join(tempDir, 'growing.pptx')
    await writeFile(file, 'small', 'utf8')
    const snapshotPromise = stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      maxArtifactBytes: 1_024,
      stableWindowMs: 80,
      pollIntervalMs: 10,
    })
    const rejection = expect(snapshotPromise).rejects.toMatchObject({ code: 'artifact_too_large' })
    await delay(30)
    await truncate(file, 1_025)

    await rejection
  })

  it('re-reads the staged destination fd and rejects bytes changed before return', async () => {
    const file = join(tempDir, 'large-report.pptx')
    await writeFile(file, Buffer.alloc(1024 * 1024, 0x61))

    await expect(stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
      onStageWriteComplete: async ({ stableFile }) => {
        await chmod(stableFile, 0o600)
        await writeFile(stableFile, Buffer.alloc(1024 * 1024, 0x62))
      },
    })).rejects.toMatchObject({ code: 'artifact_stage_changed' })
  })

  it('binds the snapshot to a staged copy even if the original path is replaced later', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'verified artifact bytes', 'utf8')

    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })

    await rm(file)
    await writeFile(file, 'different bytes after snapshot', 'utf8')

    expect(await readFile(snapshot.stableFile, 'utf8')).toBe('verified artifact bytes')
    expect(snapshot.sha256).toBe(
      createHash('sha256').update(await readFile(snapshot.stableFile)).digest('hex'),
    )
    await expect(verifyStableArtifactSnapshot({ outputDir: tempDir, ...snapshot })).resolves.toBe(true)
  })

  it('rejects a staged copy replaced by an outside symlink before upload', async () => {
    const file = join(tempDir, 'report.pptx')
    const secret = join(outsideDir, 'secret.txt')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    await writeFile(secret, 'outside secret bytes', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })

    await rm(snapshot.stableFile)
    await symlink(secret, snapshot.stableFile)

    await expect(verifyStableArtifactSnapshot({
      outputDir: tempDir,
      ...snapshot,
    })).rejects.toMatchObject({ code: 'artifact_path_outside_output' })
  })

  it('provides verified bytes from the still-open fd for the complete callback', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })

    const callbackResult = await withVerifiedStableArtifact({ outputDir: tempDir, ...snapshot }, async ({ bytes }) => {
      expect(bytes.toString('utf8')).toBe('verified artifact bytes')
      expect((await stat(snapshot.stableFile)).isFile()).toBe(true)
      return { uploaded: true, byteLength: bytes.length }
    })

    expect(callbackResult).toEqual({ uploaded: true, byteLength: Buffer.byteLength('verified artifact bytes') })
  })

  it('rejects withVerified before allocating bytes when the snapshot exceeds its cap', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      maxArtifactBytes: 1_024,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })

    await expect(withVerifiedStableArtifact({
      outputDir: tempDir,
      ...snapshot,
      maxArtifactBytes: snapshot.sizeBytes - 1,
    }, async () => true)).rejects.toMatchObject({ code: 'artifact_too_large' })
  })

  it('keeps callback bytes bound to the open fd when the staged path is replaced', async () => {
    const file = join(tempDir, 'report.pptx')
    const secret = join(outsideDir, 'secret.txt')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    await writeFile(secret, 'outside secret bytes', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })
    let callbackBytes

    await expect(withVerifiedStableArtifact({ outputDir: tempDir, ...snapshot }, async ({ bytes }) => {
      callbackBytes = Buffer.from(bytes)
      await rm(snapshot.stableFile)
      await symlink(secret, snapshot.stableFile)
    })).rejects.toMatchObject({ code: 'artifact_path_outside_output' })

    expect(callbackBytes.toString('utf8')).toBe('verified artifact bytes')
  })

  it('cleans up a staged artifact idempotently', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    const snapshot = await stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })

    await expect(cleanupStableArtifactSnapshot({ outputDir: tempDir, ...snapshot })).resolves.toBe(true)
    await expect(stat(snapshot.stableFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(cleanupStableArtifactSnapshot({ outputDir: tempDir, ...snapshot })).resolves.toBe(false)
  })

  it('fails closed when required POSIX no-follow flags are unavailable', () => {
    expect(() => assertSecureFilesystemSupport({
      O_RDONLY: 0,
      O_RDWR: 2,
      O_CREAT: 0x0200,
      O_EXCL: 0x0800,
      O_NOFOLLOW: 0,
      O_DIRECTORY: 0,
    })).toThrow(expect.objectContaining({ code: 'artifact_platform_unsupported' }))
  })

  it('refuses a staged directory redirected outside the output directory', async () => {
    const file = join(tempDir, 'report.pptx')
    await writeFile(file, 'verified artifact bytes', 'utf8')
    await symlink(outsideDir, join(tempDir, '.kaigongba-stable'))

    await expect(stableArtifactSnapshot({
      outputDir: tempDir,
      file,
      stableWindowMs: 10,
      pollIntervalMs: 2,
    })).rejects.toMatchObject({ code: 'artifact_stage_invalid' })

    expect(await stat(outsideDir)).toBeDefined()
  })

  it('rejects artifact path traversal outside the output directory', async () => {
    await expect(stableArtifactSnapshot({
      outputDir: tempDir,
      file: '../secret.txt',
      stableWindowMs: 5,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ code: 'artifact_path_outside_output' })
  })
})
