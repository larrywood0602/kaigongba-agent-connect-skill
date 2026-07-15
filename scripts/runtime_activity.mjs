import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_MESSAGE_CHARACTERS = 2_000
const MAX_PHASE_BYTES = 256
const MAX_UNIT_BYTES = 64
const MAX_PROGRESS_LINE_BYTES = 16 * 1024
const MAX_PROGRESS_SPOOL_BYTES = 8 * 1024 * 1024
const PROGRESS_READ_CHUNK_BYTES = 64 * 1024
const MAX_PROGRESS_ERROR_BACKOFF_MS = 1_000
const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024

function activityError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function assertSecureFilesystemSupport(platformConstants = constants) {
  const required = ['O_RDONLY', 'O_RDWR', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW', 'O_DIRECTORY']
  const missing = required.filter((name) => !Number.isInteger(platformConstants?.[name]))
  const unsafe = ['O_NOFOLLOW', 'O_DIRECTORY'].filter((name) => platformConstants?.[name] === 0)
  if (missing.length > 0 || unsafe.length > 0) {
    throw activityError(
      'artifact_platform_unsupported',
      `secure artifact staging requires POSIX flags: ${[...missing, ...unsafe].join(', ')}`,
    )
  }
  return true
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function parseProgressLine(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_PROGRESS_LINE_BYTES) return null
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const hasRecordId = typeof value.recordId === 'string' && RECORD_ID_PATTERN.test(value.recordId)
  const hasLegacySequence = Number.isInteger(value.sequence) && value.sequence > 0
  if (!hasRecordId && !hasLegacySequence) return null
  if (typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))) return null
  if (
    typeof value.phase !== 'string'
    || !value.phase.trim()
    || Buffer.byteLength(value.phase.trim(), 'utf8') > MAX_PHASE_BYTES
  ) return null
  if (value.current !== undefined && (!Number.isFinite(value.current) || value.current < 0)) return null
  if (value.total !== undefined && (!Number.isFinite(value.total) || value.total < 0)) return null
  if (value.current !== undefined && value.total !== undefined && value.current > value.total) return null
  if (value.unit !== undefined && (
    typeof value.unit !== 'string' || Buffer.byteLength(value.unit.trim(), 'utf8') > MAX_UNIT_BYTES
  )) return null
  if (value.message !== undefined && (
    typeof value.message !== 'string' || [...value.message].length > MAX_MESSAGE_CHARACTERS
  )) return null

  const percent = Number.isFinite(value.current) && Number.isFinite(value.total) && value.total > 0
    ? Math.floor((value.current / value.total) * 100)
    : undefined
  return {
    dedupeKey: hasRecordId ? `record:${value.recordId}` : `legacy:${value.sequence}`,
    value: {
      ...(hasRecordId ? { recordId: value.recordId } : {}),
      occurredAt: value.occurredAt,
      phase: value.phase.trim(),
      ...(value.current === undefined ? {} : { current: value.current }),
      ...(value.total === undefined ? {} : { total: value.total }),
      ...(value.unit ? { unit: value.unit.trim() } : {}),
      ...(value.message ? { message: value.message } : {}),
      ...(percent === undefined ? {} : { percent }),
    },
  }
}

export function startProgressSpoolReader({
  spoolFile,
  onRecord,
  pollIntervalMs = 100,
  onError = () => {},
} = {}) {
  if (typeof spoolFile !== 'string' || !spoolFile) {
    throw activityError('progress_spool_invalid', 'spoolFile is required')
  }
  if (typeof onRecord !== 'function') {
    throw activityError('progress_spool_invalid', 'onRecord must be a function')
  }
  assertSecureFilesystemSupport()
  const basePollIntervalMs = Number.isFinite(pollIntervalMs) ? Math.max(1, pollIntervalMs) : 100

  let stopped = false
  let timer = null
  let offset = 0
  let remainder = Buffer.alloc(0)
  let discardingOversizedLine = false
  let fileIdentity = null
  let pending = Promise.resolve()
  let nextSequence = 1
  let nextPollDelayMs = basePollIntervalMs
  let lastReportedError = null
  const seenRecords = new Set()

  const resetReadPosition = ({ resetLegacyDedupe = false } = {}) => {
    offset = 0
    remainder = Buffer.alloc(0)
    discardingOversizedLine = false
    if (resetLegacyDedupe) {
      for (const key of seenRecords) {
        if (key.startsWith('legacy:')) seenRecords.delete(key)
      }
    }
  }

  const emitLine = async (lineBytes) => {
    const line = lineBytes.toString('utf8').replace(/\r$/, '')
    if (!line.trim()) return
    const parsed = parseProgressLine(line)
    if (!parsed || seenRecords.has(parsed.dedupeKey)) return
    seenRecords.add(parsed.dedupeKey)
    await onRecord({ ...parsed.value, sequence: nextSequence })
    nextSequence += 1
  }

  const consumeBytes = async (bytes) => {
    let cursor = 0
    while (cursor < bytes.length) {
      const newlineAt = bytes.indexOf(0x0A, cursor)
      const segmentEnd = newlineAt === -1 ? bytes.length : newlineAt

      if (discardingOversizedLine) {
        if (newlineAt === -1) return
        discardingOversizedLine = false
        cursor = newlineAt + 1
        continue
      }

      const segment = bytes.subarray(cursor, segmentEnd)
      if (remainder.length + segment.length > MAX_PROGRESS_LINE_BYTES) {
        remainder = Buffer.alloc(0)
        if (newlineAt === -1) {
          discardingOversizedLine = true
          return
        }
        cursor = newlineAt + 1
        continue
      }

      if (segment.length > 0) remainder = Buffer.concat([remainder, segment])
      if (newlineAt === -1) return

      const completeLine = remainder
      remainder = Buffer.alloc(0)
      await emitLine(completeLine)
      cursor = newlineAt + 1
    }
  }

  const poll = async () => {
    let handle
    try {
      handle = await open(spoolFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileStat = await handle.stat()
      if (!fileStat.isFile() || fileStat.nlink !== 1) {
        throw activityError('progress_spool_invalid', 'progress spool must be a regular file with one link')
      }
      if (fileStat.size > MAX_PROGRESS_SPOOL_BYTES) {
        throw activityError(
          'progress_spool_full',
          `progress spool cannot exceed ${MAX_PROGRESS_SPOOL_BYTES} bytes`,
        )
      }
      const nextIdentity = `${fileStat.dev}:${fileStat.ino}`
      if ((fileIdentity && fileIdentity !== nextIdentity) || fileStat.size < offset) {
        resetReadPosition({ resetLegacyDedupe: true })
      }
      fileIdentity = nextIdentity

      let available = fileStat.size - offset
      while (available > 0) {
        const readLength = Math.min(available, PROGRESS_READ_CHUNK_BYTES)
        const bytes = Buffer.allocUnsafe(readLength)
        const { bytesRead } = await handle.read(bytes, 0, readLength, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        available -= bytesRead
        await consumeBytes(bytes.subarray(0, bytesRead))
      }
      lastReportedError = null
      nextPollDelayMs = basePollIntervalMs
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fileIdentity = null
        resetReadPosition({ resetLegacyDedupe: true })
        lastReportedError = null
        nextPollDelayMs = basePollIntervalMs
      } else {
        const errorKey = `${error?.code || error?.name || 'Error'}:${error?.message || String(error)}`
        if (errorKey !== lastReportedError) {
          lastReportedError = errorKey
          await onError(error)
        }
        nextPollDelayMs = Math.min(
          MAX_PROGRESS_ERROR_BACKOFF_MS,
          Math.max(basePollIntervalMs, nextPollDelayMs * 2),
        )
      }
    } finally {
      await handle?.close()
    }
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      pending = poll().finally(schedule)
    }, nextPollDelayMs)
    timer.unref?.()
  }
  schedule()

  return async function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
    await pending
    await poll()
  }
}

function assertInside(root, candidate) {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw activityError('artifact_path_outside_output', 'artifact path is outside the output directory')
  }
}

async function sha256Handle(handle, maximumBytes) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < maximumBytes) {
    const length = Math.min(buffer.length, maximumBytes - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return { sha256: hash.digest('hex'), sizeBytes: position }
}

async function readHandleBytes(handle, maximumBytes) {
  const bytes = Buffer.allocUnsafe(maximumBytes)
  let position = 0
  while (position < maximumBytes) {
    const { bytesRead } = await handle.read(bytes, position, maximumBytes - position, position)
    if (bytesRead === 0) break
    position += bytesRead
  }
  if (position !== maximumBytes) {
    throw activityError('artifact_snapshot_changed', 'staged artifact ended before its verified size')
  }
  return bytes
}

function assertSingleLink(version) {
  if (version.nlink !== 1) {
    throw activityError('artifact_hardlink_unsupported', 'artifact must not have multiple hard links')
  }
}

function normalizeMaxArtifactBytes(value = DEFAULT_MAX_ARTIFACT_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw activityError('artifact_limit_invalid', 'maxArtifactBytes must be a positive safe integer')
  }
  return value
}

function assertArtifactSize(version, maxArtifactBytes) {
  if (version.size > maxArtifactBytes) {
    throw activityError(
      'artifact_too_large',
      `artifact exceeds the ${maxArtifactBytes} byte limit`,
    )
  }
}

function sameVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function resolveRegularFile(root, lexicalCandidate, { maxArtifactBytes } = {}) {
  const candidate = await realpath(lexicalCandidate)
  assertInside(root, candidate)
  const version = await stat(candidate)
  if (!version.isFile()) throw activityError('artifact_not_file', 'artifact must be a regular file')
  assertSingleLink(version)
  if (maxArtifactBytes !== undefined) assertArtifactSize(version, maxArtifactBytes)
  return { candidate, version }
}

async function openVerifiedFile(root, lexicalCandidate, { maxArtifactBytes } = {}) {
  assertSecureFilesystemSupport()
  const resolved = await resolveRegularFile(root, lexicalCandidate, { maxArtifactBytes })
  let handle
  try {
    handle = await open(resolved.candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedVersion = await handle.stat()
    assertSingleLink(openedVersion)
    if (maxArtifactBytes !== undefined) assertArtifactSize(openedVersion, maxArtifactBytes)
    const current = await resolveRegularFile(root, lexicalCandidate, { maxArtifactBytes })
    if (!sameVersion(openedVersion, current.version)) {
      throw activityError('artifact_changed', 'artifact changed while it was being opened')
    }
    return { ...current, handle, version: openedVersion }
  } catch (error) {
    await handle?.close()
    if (error?.code === 'ELOOP') {
      throw activityError('artifact_path_outside_output', 'artifact path cannot be a symbolic link')
    }
    throw error
  }
}

async function ensurePrivateStageRoot(root, stableRoot) {
  assertSecureFilesystemSupport()
  await mkdir(stableRoot, { recursive: true, mode: 0o700 })
  let stageHandle
  try {
    const stageStat = await lstat(stableRoot)
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
      throw activityError('artifact_stage_invalid', 'artifact staging directory must be a real directory')
    }
    stageHandle = await open(
      stableRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const openedStageStat = await stageHandle.stat()
    const currentStageStat = await lstat(stableRoot)
    const actualStageRoot = await realpath(stableRoot)
    assertInside(root, actualStageRoot)
    if (
      actualStageRoot !== stableRoot
      || !currentStageStat.isDirectory()
      || currentStageStat.isSymbolicLink()
      || openedStageStat.dev !== currentStageStat.dev
      || openedStageStat.ino !== currentStageStat.ino
    ) {
      throw activityError('artifact_stage_invalid', 'artifact staging directory cannot be redirected')
    }
    await stageHandle.chmod(0o700)
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw activityError('artifact_stage_invalid', 'artifact staging directory cannot be a symbolic link')
    }
    throw error
  } finally {
    await stageHandle?.close().catch(() => {})
  }
}

async function copyHandleToPrivateStage({
  handle,
  sizeBytes,
  root,
  stableRoot,
  maxArtifactBytes,
  onStageWriteComplete,
}) {
  assertArtifactSize({ size: sizeBytes }, maxArtifactBytes)
  await ensurePrivateStageRoot(root, stableRoot)
  const stableFile = join(stableRoot, `${randomUUID()}.artifact`)
  let destination
  try {
    destination = await open(
      stableFile,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let sourcePosition = 0
    let destinationPosition = 0

    while (sourcePosition < sizeBytes) {
      const length = Math.min(buffer.length, sizeBytes - sourcePosition)
      const { bytesRead } = await handle.read(buffer, 0, length, sourcePosition)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      let chunkOffset = 0
      while (chunkOffset < bytesRead) {
        const { bytesWritten } = await destination.write(
          chunk,
          chunkOffset,
          bytesRead - chunkOffset,
          destinationPosition,
        )
        if (bytesWritten === 0) throw activityError('artifact_stage_failed', 'could not stage artifact bytes')
        chunkOffset += bytesWritten
        destinationPosition += bytesWritten
      }
      sourcePosition += bytesRead
    }

    if (sourcePosition !== sizeBytes) {
      throw activityError('artifact_changed', 'artifact changed while it was being staged')
    }
    await destination.sync()
    const sourceSha256 = hash.digest('hex')
    await onStageWriteComplete?.({ stableFile, sizeBytes: sourcePosition, sha256: sourceSha256 })
    const stagedVersionBeforeRead = await destination.stat()
    assertSingleLink(stagedVersionBeforeRead)
    const stagedDigest = await sha256Handle(destination, sizeBytes)
    const stagedVersionAfterRead = await destination.stat()
    if (
      stagedVersionBeforeRead.size !== sizeBytes
      || stagedDigest.sizeBytes !== sizeBytes
      || stagedDigest.sha256 !== sourceSha256
      || !sameVersion(stagedVersionBeforeRead, stagedVersionAfterRead)
    ) {
      throw activityError('artifact_stage_changed', 'staged artifact bytes changed before verification')
    }
    await destination.chmod(0o400)
    const stagedVersion = await destination.stat()
    assertSingleLink(stagedVersion)
    const current = await resolveRegularFile(root, stableFile, { maxArtifactBytes })
    if (
      stagedVersion.dev !== current.version.dev
      || stagedVersion.ino !== current.version.ino
      || stagedVersion.size !== current.version.size
    ) {
      throw activityError('artifact_stage_invalid', 'staged artifact path changed while it was being written')
    }
    return { stableFile, sizeBytes: sourcePosition, sha256: sourceSha256 }
  } catch (error) {
    await destination?.close().catch(() => {})
    await unlink(stableFile).catch(() => {})
    throw error
  } finally {
    await destination?.close().catch(() => {})
  }
}

export async function stableArtifactSnapshot({
  outputDir,
  file,
  stableWindowMs = 250,
  pollIntervalMs = 50,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  onStageWriteComplete,
} = {}) {
  if (typeof outputDir !== 'string' || !outputDir || typeof file !== 'string' || !file) {
    throw activityError('artifact_path_invalid', 'outputDir and file are required')
  }
  if (onStageWriteComplete !== undefined && typeof onStageWriteComplete !== 'function') {
    throw activityError('artifact_stage_invalid', 'onStageWriteComplete must be a function')
  }
  assertSecureFilesystemSupport()
  const artifactByteLimit = normalizeMaxArtifactBytes(maxArtifactBytes)

  const lexicalRoot = resolve(outputDir)
  const lexicalCandidate = isAbsolute(file) ? resolve(file) : resolve(lexicalRoot, file)
  assertInside(lexicalRoot, lexicalCandidate)

  const root = await realpath(lexicalRoot)
  let { version } = await resolveRegularFile(root, lexicalCandidate, {
    maxArtifactBytes: artifactByteLimit,
  })
  let stableSince = Date.now()

  while (true) {
    await delay(Math.max(1, pollIntervalMs))
    const next = await resolveRegularFile(root, lexicalCandidate, {
      maxArtifactBytes: artifactByteLimit,
    })
    const nextVersion = next.version
    if (!sameVersion(version, nextVersion)) {
      version = nextVersion
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince < Math.max(0, stableWindowMs)) continue

    let opened
    let staged
    try {
      opened = await openVerifiedFile(root, lexicalCandidate, {
        maxArtifactBytes: artifactByteLimit,
      })
      if (!sameVersion(nextVersion, opened.version)) {
        version = opened.version
        stableSince = Date.now()
        continue
      }
      staged = await copyHandleToPrivateStage({
        handle: opened.handle,
        sizeBytes: opened.version.size,
        root,
        stableRoot: join(root, '.kaigongba-stable'),
        maxArtifactBytes: artifactByteLimit,
        onStageWriteComplete,
      })
      const afterCopy = await opened.handle.stat()
      assertSingleLink(afterCopy)
      assertArtifactSize(afterCopy, artifactByteLimit)
      const current = await resolveRegularFile(root, lexicalCandidate, {
        maxArtifactBytes: artifactByteLimit,
      })
      if (!sameVersion(opened.version, afterCopy) || !sameVersion(opened.version, current.version)) {
        await unlink(staged.stableFile).catch(() => {})
        version = current.version
        stableSince = Date.now()
        continue
      }
    } catch (error) {
      if (staged) await unlink(staged.stableFile).catch(() => {})
      if (error?.code === 'artifact_changed') {
        version = (await resolveRegularFile(root, lexicalCandidate, {
          maxArtifactBytes: artifactByteLimit,
        })).version
        stableSince = Date.now()
        continue
      }
      throw error
    } finally {
      await opened?.handle.close()
    }

    if (!staged) {
      stableSince = Date.now()
      continue
    }

    return {
      relativePath: relative(lexicalRoot, lexicalCandidate).split(sep).join('/'),
      stableFile: staged.stableFile,
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256,
      maxArtifactBytes: artifactByteLimit,
      status: 'stable',
    }
  }
}

// Diagnostic-only path check. Uploads must use withVerifiedStableArtifact so
// verification and byte consumption share one still-open file descriptor.
export async function verifyStableArtifactSnapshot({
  outputDir,
  stableFile,
  sizeBytes,
  sha256,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
} = {}) {
  if (typeof outputDir !== 'string' || !outputDir || typeof stableFile !== 'string' || !stableFile) {
    throw activityError('artifact_path_invalid', 'outputDir and stableFile are required')
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    throw activityError('artifact_snapshot_invalid', 'snapshot size and sha256 are required')
  }
  assertSecureFilesystemSupport()
  const artifactByteLimit = normalizeMaxArtifactBytes(maxArtifactBytes)
  if (sizeBytes > artifactByteLimit) {
    throw activityError('artifact_too_large', `artifact exceeds the ${artifactByteLimit} byte limit`)
  }

  const root = await realpath(resolve(outputDir))
  const stableRoot = resolve(root, '.kaigongba-stable')
  const lexicalStableFile = resolve(stableFile)
  assertInside(stableRoot, lexicalStableFile)
  const opened = await openVerifiedFile(root, lexicalStableFile, {
    maxArtifactBytes: artifactByteLimit,
  })
  try {
    if (opened.version.size !== sizeBytes) {
      throw activityError('artifact_snapshot_changed', 'staged artifact size changed before upload')
    }
    const digest = await sha256Handle(opened.handle, sizeBytes)
    const afterHash = await opened.handle.stat()
    assertSingleLink(afterHash)
    const current = await resolveRegularFile(root, lexicalStableFile, {
      maxArtifactBytes: artifactByteLimit,
    })
    if (!sameVersion(opened.version, afterHash) || !sameVersion(opened.version, current.version)) {
      throw activityError('artifact_snapshot_changed', 'staged artifact changed before upload')
    }
    if (digest.sizeBytes !== sizeBytes || digest.sha256 !== sha256) {
      throw activityError('artifact_snapshot_changed', 'staged artifact digest changed before upload')
    }
    return true
  } finally {
    await opened.handle.close()
  }
}

export async function withVerifiedStableArtifact(snapshot = {}, callback) {
  const {
    outputDir,
    stableFile,
    sizeBytes,
    sha256,
    maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  } = snapshot
  if (typeof callback !== 'function') {
    throw activityError('artifact_snapshot_invalid', 'verified artifact callback is required')
  }
  if (typeof outputDir !== 'string' || !outputDir || typeof stableFile !== 'string' || !stableFile) {
    throw activityError('artifact_path_invalid', 'outputDir and stableFile are required')
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    throw activityError('artifact_snapshot_invalid', 'snapshot size and sha256 are required')
  }
  assertSecureFilesystemSupport()
  const artifactByteLimit = normalizeMaxArtifactBytes(maxArtifactBytes)
  if (sizeBytes > artifactByteLimit) {
    throw activityError('artifact_too_large', `artifact exceeds the ${artifactByteLimit} byte limit`)
  }

  const root = await realpath(resolve(outputDir))
  const stableRoot = resolve(root, '.kaigongba-stable')
  const lexicalStableFile = resolve(stableFile)
  assertInside(stableRoot, lexicalStableFile)
  const opened = await openVerifiedFile(root, lexicalStableFile, {
    maxArtifactBytes: artifactByteLimit,
  })
  let callbackStarted = false
  let callbackResult
  let callbackError
  try {
    if (opened.version.size !== sizeBytes) {
      throw activityError('artifact_snapshot_changed', 'staged artifact size changed before upload')
    }
    const bytes = await readHandleBytes(opened.handle, sizeBytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const beforeCallback = await opened.handle.stat()
    assertSingleLink(beforeCallback)
    const current = await resolveRegularFile(root, lexicalStableFile, {
      maxArtifactBytes: artifactByteLimit,
    })
    if (!sameVersion(opened.version, beforeCallback) || !sameVersion(opened.version, current.version)) {
      throw activityError('artifact_snapshot_changed', 'staged artifact changed before upload')
    }
    if (digest !== sha256) {
      throw activityError('artifact_snapshot_changed', 'staged artifact digest changed before upload')
    }
    callbackStarted = true
    callbackResult = await callback({
      bytes,
      sizeBytes,
      sha256,
      stableFile: lexicalStableFile,
    })
  } catch (error) {
    callbackError = error
  }

  let verificationError
  try {
    if (callbackStarted) {
      const afterCallback = await opened.handle.stat()
      const current = await resolveRegularFile(root, lexicalStableFile, {
        maxArtifactBytes: artifactByteLimit,
      })
      assertSingleLink(afterCallback)
      if (!sameVersion(opened.version, afterCallback) || !sameVersion(opened.version, current.version)) {
        throw activityError('artifact_snapshot_changed', 'staged artifact changed during upload')
      }
    }
  } catch (error) {
    verificationError = error
  } finally {
    await opened.handle.close()
  }

  if (verificationError) throw verificationError
  if (callbackError) throw callbackError
  return callbackResult
}

export async function cleanupStableArtifactSnapshot({ outputDir, stableFile } = {}) {
  if (typeof outputDir !== 'string' || !outputDir || typeof stableFile !== 'string' || !stableFile) {
    throw activityError('artifact_path_invalid', 'outputDir and stableFile are required')
  }
  assertSecureFilesystemSupport()

  const root = await realpath(resolve(outputDir))
  const stableRoot = resolve(root, '.kaigongba-stable')
  const lexicalStableFile = resolve(stableFile)
  assertInside(stableRoot, lexicalStableFile)
  let stageStat
  try {
    stageStat = await lstat(stableRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || await realpath(stableRoot) !== stableRoot) {
    throw activityError('artifact_stage_invalid', 'artifact staging directory cannot be redirected')
  }
  try {
    const entry = await lstat(lexicalStableFile)
    if (entry.isDirectory()) {
      throw activityError('artifact_stage_invalid', 'staged artifact path must not be a directory')
    }
    await unlink(lexicalStableFile)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
