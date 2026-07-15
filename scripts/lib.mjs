import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    const value = !next || next.startsWith('--') ? true : next
    if (value !== true) index += 1
    if (args[key] === undefined) args[key] = value
    else if (Array.isArray(args[key])) args[key].push(value)
    else args[key] = [args[key], value]
  }
  return args
}

export function arg(args, names, fallback = undefined) {
  const keys = Array.isArray(names) ? names : [names]
  for (const key of keys) {
    if (args[key] !== undefined) return args[key]
  }
  return fallback
}

export function listArg(value, fallback = []) {
  if (value === undefined || value === true || value === '') return fallback
  const values = Array.isArray(value) ? value : [value]
  const items = values.flatMap((item) => String(item).split(/[,\n，、]/))
  return items.map((item) => item.trim()).filter(Boolean)
}

export function numberArg(value, fallback = undefined) {
  if (value === undefined || value === true || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function required(value, name) {
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new Error(`${name} is required`)
  }
  return String(value).trim()
}

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

const PROVIDER_AGENT_PRESETS = {
  codex: {
    externalAgentId: 'codex_orchestrator',
    name: 'Codex Agent',
    endpoint: 'codex://agent',
  },
  openclaw: {
    externalAgentId: 'openclaw_orchestrator',
    name: 'OpenClaw Orchestrator',
    endpoint: 'openclaw://agent',
  },
}

function providerFromEndpoint(endpoint) {
  const value = compact(endpoint).toLowerCase()
  if (!value.includes('://')) return ''
  return value.split('://')[0]
}

export function detectAgentProviderFromEnvironment(env = process.env) {
  if (compact(env.KAIGONGBA_AGENT_PROVIDER)) return compact(env.KAIGONGBA_AGENT_PROVIDER)
  if (compact(env.CODEX_HOME) || compact(env.CODEX_SESSION_ID) || compact(env.CODEX_ENV_PWD)) return 'codex'
  return ''
}

export function resolveMainAgent(args = {}, existingConfig = {}, env = process.env) {
  const existingAgent = existingConfig.mainAgent && typeof existingConfig.mainAgent === 'object' ? existingConfig.mainAgent : {}
  const explicitProvider = compact(arg(args, 'provider', env.KAIGONGBA_AGENT_PROVIDER))
  const existingProvider = compact(existingAgent.provider)
  const endpointProvider = providerFromEndpoint(arg(args, 'endpoint', existingAgent.endpoint))
  const detectedProvider = detectAgentProviderFromEnvironment(env)
  const provider = explicitProvider || existingProvider || endpointProvider || detectedProvider

  if (!provider) {
    throw new Error(
      'Unable to determine external Agent identity. Pass --provider plus Agent identity flags, reuse an existing .kaigongba/connection.json, or run inside a detectable Agent runtime.',
    )
  }

  const preset = PROVIDER_AGENT_PRESETS[provider.toLowerCase()] ?? {}
  const externalAgentId = compact(arg(args, ['main-agent-id', 'mainAgentId'], existingAgent.externalAgentId || env.KAIGONGBA_AGENT_ID || preset.externalAgentId))
  const name = compact(arg(args, ['main-agent-name', 'mainAgentName'], existingAgent.name || env.KAIGONGBA_AGENT_NAME || preset.name))
  const endpoint = compact(arg(args, 'endpoint', existingAgent.endpoint || env.KAIGONGBA_AGENT_ENDPOINT || preset.endpoint))
  const version = compact(arg(args, ['main-agent-version', 'mainAgentVersion'], existingAgent.version || env.KAIGONGBA_AGENT_VERSION || '1.0.0'))
  const environment = normalizeAgentEnvironment(arg(args, 'environment', existingAgent.environment || env.KAIGONGBA_AGENT_ENVIRONMENT || 'production'))

  if (!externalAgentId || !name || !endpoint) {
    throw new Error(
      'External Agent identity is incomplete. Provide --main-agent-id, --main-agent-name, and --endpoint, or use a known --provider preset.',
    )
  }

  return {
    provider,
    externalAgentId,
    name,
    version,
    endpoint,
    environment,
  }
}

export function normalizeAgentEnvironment(value, fallback = 'production') {
  const raw = compact(value).toLowerCase().replace(/\s+/g, '_')
  if (!raw) return fallback
  if (['prod', 'production', '正式', '正式环境'].includes(raw)) return 'production'
  if (['validation', 'staging', 'test', 'testing', 'e2e', 'acceptance', '验收', '测试', '验收环境', '测试环境'].includes(raw)) return 'validation'
  return raw
}

export function tryResolveMainAgent(args = {}, existingConfig = {}, env = process.env) {
  try {
    return resolveMainAgent(args, existingConfig, env)
  } catch {
    return null
  }
}

export function stableKey(input, fallback = 'node') {
  const normalized = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

export function connectionConfigPath() {
  return process.env.KAIGONGBA_CONNECTION_CONFIG || path.resolve(process.cwd(), '.kaigongba/connection.json')
}

export async function readConnectionConfig() {
  try {
    return await readJson(connectionConfigPath())
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

export async function writeConnectionConfig(config) {
  const filePath = connectionConfigPath()
  const directory = path.dirname(path.resolve(filePath))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const temporaryFile = path.join(directory, `.connection.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temporaryFile, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryFile, filePath)
    await fs.chmod(filePath, 0o600)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporaryFile).catch(() => undefined)
    throw error
  }
  return filePath
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function writeJson(filePath, payload, options = {}) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`
  if (!filePath || filePath === '-') {
    process.stdout.write(serialized)
    return
  }
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  await fs.writeFile(filePath, serialized, { encoding: 'utf8', mode: options.mode })
  if (options.mode !== undefined) await fs.chmod(filePath, options.mode)
}

export function apiBase(config = {}) {
  return (process.env.KAIGONGBA_API_BASE_URL || config.apiBaseUrl || 'http://127.0.0.1:3100').replace(/\/+$/, '')
}

export async function apiRequest(apiPath, options = {}) {
  const config = await readConnectionConfig()
  const url = apiPath.startsWith('http') ? apiPath : `${apiBase(config)}${apiPath}`
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }
  const agentToken = process.env.KAIGONGBA_AGENT_TOKEN || config.agentToken
  if (agentToken) {
    headers.Authorization = `Bearer ${agentToken}`
  }
  if (process.env.KAIGONGBA_USER_ID) {
    headers['X-User-Id'] = process.env.KAIGONGBA_USER_ID
  }
  if (process.env.KAIGONGBA_USER_NAME) {
    headers['X-User-Name'] = process.env.KAIGONGBA_USER_NAME
  }

  const response = await fetch(url, { ...options, headers })
  const raw = await response.text()
  let payload = {}
  let parseError = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      parseError = error
    }
  }
  if (!response.ok) {
    const code = payload?.code || 'request_failed'
    const message = payload?.message || raw || `HTTP ${response.status}`
    const error = new Error(`${response.status} ${code}: ${message}`)
    error.status = response.status
    error.code = code
    throw error
  }
  if (parseError) throw parseError
  return payload
}

const DEFAULT_ARTIFACT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_ARTIFACT_RETRY_DELAYS_MS = [100, 300, 900]

export function artifactRequestPolicy(args = {}, env = process.env) {
  const timeoutValue = arg(
    args,
    ['artifact-request-timeout-ms', 'artifactRequestTimeoutMs'],
    env.KAIGONGBA_ARTIFACT_REQUEST_TIMEOUT_MS,
  )
  const retryValue = arg(
    args,
    ['artifact-retry-delays-ms', 'artifactRetryDelaysMs'],
    env.KAIGONGBA_ARTIFACT_RETRY_DELAYS_MS,
  )
  const values = retryValue === undefined
    ? DEFAULT_ARTIFACT_RETRY_DELAYS_MS
    : (Array.isArray(retryValue) ? retryValue : String(retryValue).split(','))
  return {
    timeoutMs: Math.max(1, numberArg(timeoutValue, DEFAULT_ARTIFACT_REQUEST_TIMEOUT_MS)),
    retryDelaysMs: values.map((value) => Math.max(0, numberArg(value, 0))),
  }
}

function transientArtifactRequestError(error) {
  if (error?.code === 'artifact_request_timeout') return true
  if (Number.isFinite(error?.status)) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return true
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function withArtifactRequestRetry(operation, policy = {}, phase = 'artifact_request') {
  const timeoutMs = Math.max(1, numberArg(policy.timeoutMs, DEFAULT_ARTIFACT_REQUEST_TIMEOUT_MS))
  const retryDelaysMs = Array.isArray(policy.retryDelaysMs)
    ? policy.retryDelaysMs
    : DEFAULT_ARTIFACT_RETRY_DELAYS_MS
  let lastError
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) await wait(Math.max(0, numberArg(retryDelaysMs[attempt - 1], 0)))
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (timedOut) {
        lastError = new Error(`Artifact request ${phase} exceeded ${timeoutMs}ms`)
        lastError.code = 'artifact_request_timeout'
        lastError.details = { phase, timeoutMs }
      } else {
        lastError = error
      }
      if (!transientArtifactRequestError(lastError)) throw lastError
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

export async function artifactApiRequest(apiPath, options = {}, policy = {}, phase = 'artifact_api') {
  return withArtifactRequestRetry(
    (signal) => apiRequest(apiPath, { ...options, signal }),
    policy,
    phase,
  )
}

export async function uploadFileToUrl({ bytes, uploadUrl, mimeType, policy = {} }) {
  if (bytes === undefined || bytes === null) return { uploaded: false, skippedReason: 'no_file' }
  if (!uploadUrl || !String(uploadUrl).startsWith('http')) {
    return { uploaded: false, skippedReason: 'non_http_upload_url' }
  }
  return withArtifactRequestRetry(async (signal) => {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: mimeType ? { 'Content-Type': mimeType } : {},
      body: bytes,
      signal,
    })
    if (!response.ok) {
      const raw = await response.text()
      const error = new Error(`Artifact upload failed: HTTP ${response.status} ${raw || response.statusText}`)
      error.status = response.status
      error.code = 'artifact_upload_failed'
      throw error
    }
    return { uploaded: true, status: response.status }
  }, policy, 'artifact_upload_put')
}

export function redactLocalResult(value, key = '') {
  if (/(?:url|uri)$/i.test(key)) return undefined
  if (Array.isArray(value)) return value.map((item) => redactLocalResult(item)).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = redactLocalResult(childValue, childKey)
      if (redacted !== undefined) output[childKey] = redacted
    }
    return output
  }
  if (typeof value !== 'string') return value
  return value
    .replace(/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:kgb_agent_|kgbc_)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/([?&][^?&#=\s]*(?:token|code|key|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
}

export function defaultStatus(eventType) {
  if (eventType === 'node.completed') return 'completed'
  if (eventType === 'node.failed') return 'failed'
  if (eventType === 'artifact.created' || eventType === 'node.needs_approval') return 'submitted'
  if (eventType === 'node.started' || eventType === 'node.progress' || eventType === 'node.log') return 'running'
  return undefined
}

export function mimeFromName(name, explicitType) {
  const extension = String(explicitType || path.extname(name).slice(1)).toLowerCase()
  const map = {
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    json: 'application/json',
    md: 'text/markdown',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  }
  return map[extension] || 'application/octet-stream'
}
