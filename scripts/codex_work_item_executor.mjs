#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { arg, parseArgs, writeJson } from './lib.mjs'

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

function defaultOutputDir() {
  return path.resolve(process.cwd(), '.kaigongba/runtime/codex-artifacts')
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

async function materializeAttachments(workItem, outputDir) {
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
    const bytes = decodeAttachmentBytes(attachment)
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
      delete next.contentBase64
      delete next.dataUrl
      delete next.base64
      delete next.bytesBase64
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

function promptForWorkItem(workItem, outputDir) {
  const requirement = requirementFromWorkItem(workItem)
  return [
    '你是通过开工吧外接的 Codex Agent，正在执行一个真实客户 work item。',
    '你必须实际创建可交付成果文件，不能只描述计划或生成说明文本来冒充成果。',
    `所有成果文件必须写入这个目录：${outputDir}`,
    '完成后只返回符合 JSON Schema 的 JSON，不要返回 Markdown 包裹。',
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

async function runCodex({ prompt, outputDir, schemaFile, resultFile, env = process.env }) {
  const executable = compact(env.CODEX_EXECUTABLE) || 'codex'
  const extraArgs = compact(env.CODEX_EXEC_ARGS).split(/\s+/).filter(Boolean)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, codexArgs({ outputDir, schemaFile, resultFile, extraArgs }), {
      cwd: outputDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) {
        reject(new Error(err || out || `codex exec exited with code ${code}`))
        return
      }
      resolve({ stdout: out, stderr: err })
    })
    child.stdin.end(prompt)
  })
}

export async function runCodexWorkItemExecutor({ workItem, outputDir, env = process.env } = {}) {
  if (!workItem || typeof workItem !== 'object') throw new Error('workItem is required')
  const artifactDir = path.resolve(outputDir || env.KAIGONGBA_CODEX_OUTPUT_DIR || defaultOutputDir(), compact(workItem.id) || `${Date.now()}`)
  await fs.mkdir(artifactDir, { recursive: true })
  const schemaFile = path.join(artifactDir, 'codex-result.schema.json')
  const resultFile = path.join(artifactDir, 'codex-result.json')
  await writeJson(schemaFile, resultSchema())
  const executableWorkItem = await materializeAttachments(workItem, artifactDir)
  await runCodex({ prompt: promptForWorkItem(executableWorkItem, artifactDir), outputDir: artifactDir, schemaFile, resultFile, env })
  const result = parseJsonOutput(await fs.readFile(resultFile, 'utf8').catch(() => ''))
  const artifacts = await assertArtifactFiles(Array.isArray(result.artifacts) ? result.artifacts : [], artifactDir)
  if (result.status !== 'failed' && artifacts.length === 0) throw new Error('Codex completed without creating artifact files')
  return {
    status: result.status === 'failed' ? 'failed' : 'completed',
    progressEvents: Array.isArray(result.progressEvents) ? result.progressEvents : [],
    artifacts,
    finalMessage: compact(result.finalMessage) || (result.status === 'failed' ? 'Codex Agent 执行失败' : 'Codex Agent 已完成执行'),
  }
}

async function main() {
  const args = parseArgs()
  const workItem = await readStdin()
  const result = await runCodexWorkItemExecutor({
    workItem,
    outputDir: arg(args, ['output-dir', 'outputDir'], process.env.KAIGONGBA_CODEX_OUTPUT_DIR),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
