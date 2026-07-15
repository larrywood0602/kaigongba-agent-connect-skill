import { isAbsolute, basename, relative, resolve, sep } from 'node:path'

export const EXECUTOR_PROTOCOL = 'kaigongba.executor.v1'

const MAX_MESSAGE_BYTES = 64 * 1024
const PUBLIC_TEXT_LIMITS = Object.freeze({
  message: MAX_MESSAGE_BYTES,
  phase: 256,
  unit: 64,
  name: 1024,
  code: 128,
  state: 64,
  status: 64,
})

function protocolError(message) {
  const error = new Error(message)
  error.code = 'executor_protocol_error'
  return error
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value

  let end = maxBytes
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export function sanitizePublicText(value) {
  if (value === undefined || value === null) return ''

  const sanitized = String(value)
    .replace(/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:kgb_agent_|kgbc_)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/([?&][^?&#=\s]*(?:token|code|key|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/var\/folders|\/tmp)(?:\/[^\s"'`<>]*)?/g, '[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:\\[^\s"'`<>]*/g, '[REDACTED_PATH]')

  return truncateUtf8(sanitized, MAX_MESSAGE_BYTES)
}

export function createExecutorEventFactory({ runId, now = () => new Date() } = {}) {
  if (typeof runId !== 'string' || !runId.trim()) {
    throw protocolError('runId is required')
  }
  if (typeof now !== 'function') throw protocolError('now must be a function')

  let sequence = 0
  return (input = {}) => {
    if (!input || typeof input !== 'object' || typeof input.type !== 'string' || !input.type.trim()) {
      throw protocolError('event type is required')
    }

    const {
      protocol: _protocol,
      sequence: _sequence,
      eventId: _eventId,
      occurredAt: _occurredAt,
      ...payload
    } = input
    sequence += 1
    for (const [field, maxBytes] of Object.entries(PUBLIC_TEXT_LIMITS)) {
      if (typeof payload[field] === 'string') {
        payload[field] = truncateUtf8(sanitizePublicText(payload[field]), maxBytes)
      }
    }

    return {
      protocol: EXECUTOR_PROTOCOL,
      ...payload,
      sequence,
      eventId: `${runId}:${sequence}`,
      occurredAt: now().toISOString(),
    }
  }
}

export function parseExecutorProtocolLine(line) {
  if (typeof line !== 'string' || !line.trim()) throw protocolError('protocol line is empty')

  let value
  try {
    value = JSON.parse(line)
  } catch {
    throw protocolError('protocol line is not valid JSON')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('protocol line must contain an object')
  }
  if (value.protocol !== EXECUTOR_PROTOCOL) throw protocolError('unsupported executor protocol')
  if (typeof value.type !== 'string' || !value.type.trim()) throw protocolError('event type is required')
  if (!Number.isInteger(value.sequence) || value.sequence <= 0) {
    throw protocolError('event sequence must be a positive integer')
  }
  if (typeof value.eventId !== 'string' || !value.eventId.trim()) {
    throw protocolError('eventId is required')
  }

  return value
}

function relativeOutputPath(file, outputDir) {
  if (typeof file !== 'string' || !file.trim() || typeof outputDir !== 'string' || !outputDir.trim()) {
    return null
  }

  const root = resolve(outputDir)
  const candidate = isAbsolute(file) ? resolve(file) : resolve(root, file)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) return null

  const result = relative(root, candidate)
  if (!result || isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`)) return null
  return result.split(sep).join('/')
}

export function mapCodexEvent(event, { outputDir } = {}) {
  if (!event || typeof event !== 'object') return []

  const lifecycle = {
    'thread.started': ['started', 'Codex execution started'],
    'turn.started': ['working', 'Codex turn started'],
    'turn.completed': ['finalizing', 'Codex turn completed'],
  }[event.type]
  if (lifecycle) {
    return [{ type: 'lifecycle', state: lifecycle[0], message: lifecycle[1] }]
  }

  if (event.type === 'turn.failed') {
    return [{ type: 'error', code: 'codex_turn_failed', message: 'Codex turn failed', retryable: true }]
  }

  if (event.type !== 'item.completed' || event.item?.type !== 'file_change') return []
  const changes = Array.isArray(event.item.changes) ? event.item.changes : []
  return changes.flatMap((change) => {
    const relativePath = relativeOutputPath(change?.path, outputDir)
    if (!relativePath) return []
    return [{
      type: 'file',
      status: 'observed',
      name: basename(relativePath),
      relativePath,
    }]
  })
}
