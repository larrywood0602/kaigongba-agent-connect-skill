import fs from 'node:fs/promises'
import path from 'node:path'

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
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return filePath
}

export async function writeJson(filePath, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`
  if (!filePath || filePath === '-') {
    process.stdout.write(serialized)
    return
  }
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  await fs.writeFile(filePath, serialized, 'utf8')
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
  const payload = raw ? JSON.parse(raw) : {}
  if (!response.ok) {
    const code = payload.code || response.statusText || 'request_failed'
    const message = payload.message || raw || `HTTP ${response.status}`
    throw new Error(`${response.status} ${code}: ${message}`)
  }
  return payload
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
