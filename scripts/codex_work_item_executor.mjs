#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { arg, parseArgs, writeJson } from './lib.mjs'
import { createExecutorEventFactory, mapCodexEvent, sanitizePublicText } from './executor_protocol.mjs'
import { stableArtifactSnapshot, startProgressSpoolReader } from './runtime_activity.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

const CODEX_CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
])

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

function codexChildEnv(env = process.env) {
  return Object.fromEntries(
    CODEX_CHILD_ENV_ALLOWLIST
      .filter((key) => typeof env[key] === 'string' && env[key])
      .map((key) => [key, env[key]]),
  )
}

function safeCwd(fallback = SKILL_DIR) {
  try {
    return process.cwd()
  } catch {
    return fallback
  }
}

function defaultOutputDir() {
  return path.resolve(safeCwd(), '.kaigongba/runtime/codex-artifacts')
}

function safeFileName(value, fallback) {
  const name = compact(value)
    .replace(/[\\/]+/g, '-')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .trim()
  return name || fallback
}

function decodeAttachmentBytes(attachment = {}) {
  const metadata = attachment.metadata && typeof attachment.metadata === 'object' ? attachment.metadata : {}
  const raw = compact(
    attachment.contentBase64
      || attachment.base64
      || attachment.bytesBase64
      || attachment.dataUrl
      || attachment.data_url
      || metadata.contentBase64
      || metadata.base64
      || metadata.bytesBase64
      || metadata.dataUrl,
  )
  if (!raw) return null
  const base64 = raw.startsWith('data:') && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length ? bytes : null
}

function resolveAttachmentDownloadUrl(attachment = {}, env = process.env) {
  const metadata = attachment.metadata && typeof attachment.metadata === 'object' ? attachment.metadata : {}
  const raw = compact(
    attachment.downloadUrl
      || attachment.download_url
      || attachment.url
      || metadata.downloadUrl
      || metadata.download_url
      || metadata.url,
  )
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('/')) {
    const apiBaseUrl = compact(env.KAIGONGBA_API_BASE_URL)
    if (!apiBaseUrl) return ''
    return new URL(raw, apiBaseUrl.replace(/\/+$/, '')).toString()
  }
  return ''
}

async function downloadAttachmentBytes(attachment = {}, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = resolveAttachmentDownloadUrl(attachment, env)
  if (!url) return null
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required to download work item attachments')
  const response = await fetchImpl(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Failed to download attachment ${attachment.name || attachment.id || ''}: HTTP ${response.status} ${text || response.statusText}`.trim())
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  return bytes.length ? bytes : null
}

function removeInlineAndDownloadSecrets(attachment = {}) {
  delete attachment.contentBase64
  delete attachment.dataUrl
  delete attachment.data_url
  delete attachment.base64
  delete attachment.bytesBase64
  delete attachment.downloadUrl
  delete attachment.download_url
  delete attachment.downloadExpiresAt
  delete attachment.download_expires_at
  delete attachment.url
  if (attachment.metadata && typeof attachment.metadata === 'object') {
    delete attachment.metadata.contentBase64
    delete attachment.metadata.dataUrl
    delete attachment.metadata.data_url
    delete attachment.metadata.base64
    delete attachment.metadata.bytesBase64
    delete attachment.metadata.downloadUrl
    delete attachment.metadata.download_url
    delete attachment.metadata.url
  }
}

async function materializeAttachments(workItem, outputDir, env = process.env) {
  const cloned = JSON.parse(JSON.stringify(workItem))
  const payload = cloned.payload && typeof cloned.payload === 'object' ? cloned.payload : {}
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
  if (attachments.length === 0) return cloned

  const attachmentDir = path.join(outputDir, 'input-attachments')
  await fs.mkdir(attachmentDir, { recursive: true })
  const usedNames = new Set()
  const materialized = []
  for (const [index, attachment] of attachments.entries()) {
    const next = { ...attachment }
    const bytes = decodeAttachmentBytes(attachment) || await downloadAttachmentBytes(attachment, { env })
    if (bytes) {
      const preferredName = safeFileName(next.name, `attachment-${index + 1}`)
      const parsed = path.parse(preferredName)
      let fileName = preferredName
      let suffix = 1
      while (usedNames.has(fileName)) {
        fileName = `${parsed.name || 'attachment'}-${suffix}${parsed.ext}`
        suffix += 1
      }
      usedNames.add(fileName)
      const filePath = path.join(attachmentDir, fileName)
      await fs.writeFile(filePath, bytes)
      next.localPath = filePath
      next.relativePath = path.posix.join('input-attachments', fileName)
      next.availableToAgent = true
      removeInlineAndDownloadSecrets(next)
    }
    materialized.push(next)
  }
  payload.attachments = materialized
  if (payload.requirement && typeof payload.requirement === 'object' && Array.isArray(payload.requirement.files)) {
    payload.requirement.files = payload.requirement.files.map((file) => {
      const match = materialized.find((attachment) =>
        compact(attachment.id) && compact(attachment.id) === compact(file.id)
        || compact(attachment.fileObjectId) && compact(attachment.fileObjectId) === compact(file.fileObjectId)
        || compact(attachment.name) && compact(attachment.name) === compact(file.name))
      return match ? { ...file, localPath: match.localPath, relativePath: match.relativePath, availableToAgent: match.availableToAgent } : file
    })
  }
  cloned.payload = payload
  return cloned
}

function requirementFromWorkItem(workItem = {}) {
  const payload = workItem.payload && typeof workItem.payload === 'object' ? workItem.payload : {}
  const requirement = payload.requirement && typeof payload.requirement === 'object' ? payload.requirement : {}
  return {
    title: requirement.title ?? '',
    goal: requirement.goal ?? requirement.summary ?? '',
    rawInput: requirement.rawInput ?? requirement.raw_input ?? '',
    category: requirement.category ?? '',
    deliverables: requirement.deliverables ?? requirement.deliver ?? payload.deliverables ?? [],
    acceptanceCriteria: requirement.acceptanceCriteria ?? requirement.acceptance_criteria ?? requirement.accept ?? payload.acceptanceCriteria ?? [],
    constraints: requirement.constraints ?? {},
    attachments: payload.attachments ?? requirement.attachments ?? [],
  }
}

function capabilityFromWorkItem(workItem = {}) {
  const payload = workItem.payload && typeof workItem.payload === 'object' ? workItem.payload : {}
  const capability = payload.capability && typeof payload.capability === 'object'
    ? payload.capability
    : workItem.capability && typeof workItem.capability === 'object'
      ? workItem.capability
      : null
  if (!capability) return null
  return {
    id: compact(capability.id),
    externalId: compact(capability.externalId ?? capability.external_id),
    name: compact(capability.name),
    description: compact(capability.description),
    capabilityType: compact(capability.capabilityType ?? capability.capability_type),
    sourceKind: compact(capability.sourceKind ?? capability.source_kind),
    sourcePath: compact(capability.sourcePath ?? capability.source_path),
    sourceFingerprint: compact(capability.sourceFingerprint ?? capability.source_fingerprint),
  }
}

async function existingSkillFile(sourcePath, env = process.env) {
  const raw = compact(sourcePath)
  if (!raw) return ''
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
        compact(env.KAIGONGBA_AGENT_SOURCE_DIR) ? path.resolve(compact(env.KAIGONGBA_AGENT_SOURCE_DIR), raw) : '',
        compact(env.INIT_CWD) ? path.resolve(compact(env.INIT_CWD), raw) : '',
        path.resolve(safeCwd(), raw),
        path.resolve(SKILL_DIR, raw),
      ].filter(Boolean)
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat?.isFile()) return candidate
    if (stat?.isDirectory()) {
      const skillFile = path.join(candidate, 'SKILL.md')
      const skillStat = await fs.stat(skillFile).catch(() => null)
      if (skillStat?.isFile()) return skillFile
    }
  }
  return ''
}

async function materializeConnectedSkill(workItem, outputDir, env = process.env) {
  const capability = capabilityFromWorkItem(workItem)
  if (!capability) return null
  const sourceFile = await existingSkillFile(capability.sourcePath, env)
  if (!sourceFile) return { capability, sourceFile: '', materializedSkillPath: '' }
  const targetDir = path.join(outputDir, 'connected-skill')
  const targetFile = path.join(targetDir, 'SKILL.md')
  await fs.mkdir(targetDir, { recursive: true })
  await fs.copyFile(sourceFile, targetFile)
  return { capability, sourceFile, materializedSkillPath: targetFile }
}

function resultSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'finalMessage', 'progressEvents', 'artifacts'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed'] },
      finalMessage: { type: 'string' },
      progressEvents: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['progress', 'message'],
          properties: {
            progress: { type: 'integer', minimum: 1, maximum: 99 },
            message: { type: 'string' },
          },
        },
      },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type', 'file'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            file: { type: 'string' },
          },
        },
      },
    },
  }
}

function connectedSkillPrompt(skillContext) {
  if (!skillContext?.capability) return ''
  const capability = skillContext.capability
  const lines = [
    'Connected capability:',
    JSON.stringify({
      id: capability.id,
      externalId: capability.externalId,
      name: capability.name,
      description: capability.description,
      capabilityType: capability.capabilityType,
      sourceKind: capability.sourceKind,
      sourcePath: capability.sourcePath,
      sourceFingerprint: capability.sourceFingerprint,
      materializedSkillPath: skillContext.materializedSkillPath || '',
    }, null, 2),
  ]
  if (skillContext.materializedSkillPath) {
    lines.push(
      '',
      'MUST use the connected skill before producing artifacts.',
      `First read and follow this skill file: ${skillContext.materializedSkillPath}`,
      'If the skill file references relative instructions, resolve them from the connected-skill directory when available.',
    )
  } else if (capability.sourcePath) {
    lines.push(
      '',
      'A connected skill source path was provided but could not be materialized in this runtime.',
      `Use the connected capability metadata as the execution contract and mention the missing skill file in finalMessage if it blocks faithful execution: ${capability.sourcePath}`,
    )
  }
  return lines.join('\n')
}

function promptForWorkItem(workItem, outputDir, skillContext = null, progressHelperFile = '') {
  const requirement = requirementFromWorkItem(workItem)
  return [
    '你是通过开工吧外接的 Codex Agent，正在执行一个真实客户 work item。',
    '你必须实际创建可交付成果文件，不能只描述计划或生成说明文本来冒充成果。',
    `所有成果文件必须写入这个目录：${outputDir}`,
    progressHelperFile
      ? `当且仅当你掌握真实数量时，使用 node ${progressHelperFile} --phase "阶段名" --current 1 --total 10 --unit item --message "真实进度" 上报；不知道总量时省略 current 和 total，禁止猜测百分比。`
      : '',
    '完成后只返回符合 JSON Schema 的 JSON，不要返回 Markdown 包裹。',
    connectedSkillPrompt(skillContext),
    '',
    'Work item:',
    JSON.stringify(
      {
        id: workItem.id,
        orderId: workItem.orderId,
        serviceSopId: workItem.serviceSopId,
        nodeKey: workItem.nodeKey,
        requirement,
      },
      null,
      2,
    ),
    '',
    '返回 JSON 规则：',
    '- artifacts 必须列出你实际创建的文件。',
    '- artifacts[].file 必须是绝对路径。',
    '- type 使用文件扩展名，例如 png、jpg、html、pptx、pdf、md、zip。',
    '- 如果任务无法完成，status 返回 failed，并说明原因；不要伪造成果。',
  ].join('\n')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!compact(raw)) throw new Error('work item JSON is required on stdin')
  return JSON.parse(raw)
}

function parseJsonOutput(raw) {
  const text = compact(raw)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}$/)
    if (!match) throw new Error('Codex returned no JSON result')
    return JSON.parse(match[0])
  }
}

async function assertArtifactFiles(artifacts = [], outputDir) {
  const normalized = []
  for (const artifact of artifacts) {
    const file = path.resolve(outputDir, compact(artifact.file))
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) throw new Error(`Codex artifact file was not created: ${file}`)
    normalized.push({
      name: compact(artifact.name) || path.basename(file),
      type: compact(artifact.type) || path.extname(file).slice(1) || 'file',
      file,
    })
  }
  return normalized
}

function codexArgs({ outputDir, schemaFile, resultFile, extraArgs = [] }) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--cd',
    outputDir,
    '--output-schema',
    schemaFile,
    '--output-last-message',
    resultFile,
    ...extraArgs,
    '-',
  ]
}

async function runCodex({ prompt, outputDir, schemaFile, resultFile, onJsonEvent = async () => {}, env = process.env }) {
  const executable = compact(env.CODEX_EXECUTABLE) || 'codex'
  const extraArgs = compact(env.CODEX_EXEC_ARGS).split(/\s+/).filter(Boolean)
  const child = spawn(executable, codexArgs({ outputDir, schemaFile, resultFile, extraArgs }), {
    cwd: outputDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: codexChildEnv(env),
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const readEvents = (async () => {
    for await (const line of lines) {
      if (!compact(line)) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        const error = new Error('Codex returned an invalid JSONL event')
        error.code = 'codex_jsonl_invalid'
        throw error
      }
      await onJsonEvent(event)
    }
  })()
  const exitCode = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  child.stdin.end(prompt)
  const code = await exitCode
  await readEvents
  const err = Buffer.concat(stderr).toString('utf8')
  if (code !== 0) {
    const error = new Error(sanitizePublicText(err) || `codex exec exited with code ${code}`)
    error.code = 'codex_exec_failed'
    throw error
  }
  return { stderr: err }
}

function positiveMilliseconds(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export async function runCodexWorkItemExecutor({ workItem, outputDir, onEvent = async () => {}, env = process.env } = {}) {
  if (!workItem || typeof workItem !== 'object') throw new Error('workItem is required')
  const artifactDir = path.resolve(outputDir || env.KAIGONGBA_CODEX_OUTPUT_DIR || defaultOutputDir(), compact(workItem.id) || `${Date.now()}`)
  await fs.mkdir(artifactDir, { recursive: true })
  const schemaFile = path.join(artifactDir, 'codex-result.schema.json')
  const resultFile = path.join(artifactDir, 'codex-result.json')
  const progressHelperFile = path.join(artifactDir, 'report_progress.mjs')
  const progressSpoolFile = path.join(artifactDir, '.kaigongba-progress.jsonl')
  await writeJson(schemaFile, resultSchema())
  await fs.copyFile(path.join(SCRIPT_DIR, 'report_progress.mjs'), progressHelperFile)
  const executableWorkItem = await materializeAttachments(workItem, artifactDir, env)
  const skillContext = await materializeConnectedSkill(executableWorkItem, artifactDir, env)
  const createEvent = createExecutorEventFactory({ runId: compact(workItem.id) || 'codex-work-item' })
  let eventQueue = Promise.resolve()
  const emitEvent = (input) => {
    const event = createEvent(input)
    eventQueue = eventQueue.then(() => onEvent(event))
    return eventQueue
  }
  const stopProgressReader = startProgressSpoolReader({
    spoolFile: progressSpoolFile,
    pollIntervalMs: positiveMilliseconds(env.KAIGONGBA_ACTIVITY_POLL_INTERVAL_MS, 100),
    onRecord: (record) => emitEvent({ type: 'progress', ...record }),
  })
  try {
    await runCodex({
      prompt: promptForWorkItem(executableWorkItem, artifactDir, skillContext, progressHelperFile),
      outputDir: artifactDir,
      schemaFile,
      resultFile,
      env,
      onJsonEvent: async (event) => {
        const mapped = mapCodexEvent(event, { outputDir: artifactDir })
        if (mapped.length === 0) {
          await emitEvent({ type: 'log', internal: true, message: 'Codex 正在执行' })
          return
        }
        for (const next of mapped) await emitEvent(next)
      },
    })
    await stopProgressReader()
    await eventQueue
    const result = parseJsonOutput(await fs.readFile(resultFile, 'utf8').catch(() => ''))
    const artifacts = await assertArtifactFiles(Array.isArray(result.artifacts) ? result.artifacts : [], artifactDir)
    if (result.status !== 'failed' && artifacts.length === 0) throw new Error('Codex completed without creating artifact files')
    const stableArtifacts = []
    for (const artifact of artifacts) {
      const snapshot = await stableArtifactSnapshot({
        outputDir: artifactDir,
        file: artifact.file,
        stableWindowMs: positiveMilliseconds(env.KAIGONGBA_ARTIFACT_STABLE_WINDOW_MS, 250),
        pollIntervalMs: positiveMilliseconds(env.KAIGONGBA_ARTIFACT_STABLE_POLL_INTERVAL_MS, 50),
      })
      const { stableFile, ...publicSnapshot } = snapshot
      stableArtifacts.push({
        ...artifact,
        file: stableFile,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
        relativePath: snapshot.relativePath,
        maxArtifactBytes: snapshot.maxArtifactBytes,
      })
      await emitEvent({ type: 'file', name: artifact.name, ...publicSnapshot })
    }
    const normalized = {
      status: result.status === 'failed' ? 'failed' : 'completed',
      progressEvents: Array.isArray(result.progressEvents) ? result.progressEvents : [],
      artifacts: stableArtifacts,
      finalMessage: compact(result.finalMessage) || (result.status === 'failed' ? 'Codex Agent 执行失败' : 'Codex Agent 已完成执行'),
    }
    await emitEvent({
      type: 'result',
      status: normalized.status,
      resultFile: path.relative(artifactDir, resultFile),
      result: normalized,
    })
    await eventQueue
    return normalized
  } catch (error) {
    await emitEvent({
      type: 'error',
      code: compact(error?.code) || 'codex_executor_failed',
      message: sanitizePublicText(error instanceof Error ? error.message : String(error)),
      retryable: true,
    }).catch(() => undefined)
    throw error
  } finally {
    await stopProgressReader().catch(() => undefined)
  }
}

async function main() {
  const args = parseArgs()
  const workItem = await readStdin()
  const executorOptions = {
    workItem,
    outputDir: arg(args, ['output-dir', 'outputDir'], process.env.KAIGONGBA_CODEX_OUTPUT_DIR),
  }
  if (process.env.KAIGONGBA_EXECUTOR_JSONL === '0') {
    const result = await runCodexWorkItemExecutor(executorOptions)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  let output = Promise.resolve()
  const writeEvent = (event) => {
    output = output.then(() => new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(event)}\n`, (error) => error ? reject(error) : resolve())
    }))
    return output
  }
  await runCodexWorkItemExecutor({ ...executorOptions, onEvent: writeEvent })
  await output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
