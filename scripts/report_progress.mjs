#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_SPOOL_FILE = join(dirname(fileURLToPath(import.meta.url)), '.kaigongba-progress.jsonl')
const MAX_MESSAGE_CHARACTERS = 2_000
const MAX_PHASE_BYTES = 256
const MAX_UNIT_BYTES = 64
const MAX_LINE_BYTES = 16 * 1024
const MAX_SPOOL_BYTES = 8 * 1024 * 1024

function progressError(message) {
  const error = new Error(message)
  error.code = 'progress_record_invalid'
  return error
}

function optionalNumber(value, name) {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw progressError(`${name} must be a non-negative number`)
  }
  return parsed
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function validateProgressInput(input = {}) {
  const phase = typeof input.phase === 'string' ? input.phase.trim() : ''
  if (!phase) throw progressError('phase is required')

  const current = optionalNumber(input.current, 'current')
  const total = optionalNumber(input.total, 'total')
  if (current !== null && total !== null && current > total) {
    throw progressError('current cannot exceed total')
  }

  const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (utf8Bytes(phase) > MAX_PHASE_BYTES) {
    throw progressError(`phase cannot exceed ${MAX_PHASE_BYTES} bytes`)
  }
  if (utf8Bytes(unit) > MAX_UNIT_BYTES) {
    throw progressError(`unit cannot exceed ${MAX_UNIT_BYTES} bytes`)
  }
  if ([...message].length > MAX_MESSAGE_CHARACTERS) {
    throw progressError(`message cannot exceed ${MAX_MESSAGE_CHARACTERS} characters`)
  }

  return { phase, current, total, unit, message }
}

async function appendLineWithoutFollowingSymlinks(spoolFile, line) {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    const error = new Error('this platform cannot safely open the progress spool')
    error.code = 'progress_spool_unsupported'
    throw error
  }

  const absoluteSpool = resolve(spoolFile)
  const controlledDirectory = await realpath(dirname(absoluteSpool))
  const controlledSpool = join(controlledDirectory, basename(absoluteSpool))
  let handle
  try {
    handle = await open(
      controlledSpool,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_APPEND
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600,
    )
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      const error = new Error('progress spool must be a regular file')
      error.code = 'progress_spool_invalid'
      throw error
    }
    if (fileStat.nlink !== 1) {
      const error = new Error('progress spool cannot be hard-linked')
      error.code = 'progress_spool_hardlink'
      throw error
    }
    await handle.chmod(0o600)
    const bytes = Buffer.from(line, 'utf8')
    if (fileStat.size + bytes.length > MAX_SPOOL_BYTES) {
      const error = new Error(`progress spool cannot exceed ${MAX_SPOOL_BYTES} bytes`)
      error.code = 'progress_spool_full'
      throw error
    }
    const { bytesWritten } = await handle.writev([bytes], null)
    if (bytesWritten !== bytes.length) {
      const error = new Error('could not append one complete progress record')
      error.code = 'progress_spool_write_incomplete'
      throw error
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      const symlinkError = new Error('progress spool cannot be a symbolic link')
      symlinkError.code = 'progress_spool_symlink'
      throw symlinkError
    }
    if (error?.code === 'ENXIO') {
      const invalidError = new Error('progress spool must be a writable regular file')
      invalidError.code = 'progress_spool_invalid'
      throw invalidError
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function appendProgressRecord(input, { spoolFile = DEFAULT_SPOOL_FILE, now = () => new Date() } = {}) {
  const { phase, current, total, unit, message } = validateProgressInput(input)
  const record = {
    recordId: randomUUID(),
    occurredAt: now().toISOString(),
    phase,
    ...(current === null ? {} : { current }),
    ...(total === null ? {} : { total }),
    ...(unit ? { unit } : {}),
    ...(message ? { message } : {}),
  }
  const line = `\n${JSON.stringify(record)}\n`
  if (utf8Bytes(line) > MAX_LINE_BYTES) {
    throw progressError(`progress record cannot exceed ${MAX_LINE_BYTES} bytes`)
  }

  await appendLineWithoutFollowingSymlinks(spoolFile, line)
  return record
}

function parseCliArguments(args) {
  const values = {}
  const allowed = new Set(['phase', 'current', 'total', 'unit', 'message'])
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw progressError('arguments must be --name value pairs')
    const name = flag.slice(2)
    if (!allowed.has(name)) throw progressError(`unknown argument: --${name}`)
    values[name] = value
  }
  return values
}

async function main() {
  await appendProgressRecord(parseCliArguments(process.argv.slice(2)))
}

const isMain = process.argv[1]
  && pathToFileURL(realpathSync(process.argv[1])).href
    === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'progress_record_error'}: ${error?.message || String(error)}\n`)
    process.exitCode = 1
  })
}
