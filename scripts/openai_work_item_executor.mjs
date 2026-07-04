#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { arg, parseArgs } from './lib.mjs'

function compact(value) {
  if (value === undefined || value === null || value === true) return ''
  return String(value).trim()
}

function modelConfig(env = process.env) {
  const apiKey = compact(env.AI_API_KEY || env.OPENAI_API_KEY)
  const baseUrl = compact(env.AI_API_BASE_URL || env.OPENAI_BASE_URL || (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : '')).replace(/\/+$/, '')
  const model = compact(env.KAIGONGBA_EXECUTOR_MODEL || env.AI_MODEL_AGENT || env.AI_MODEL_CHAT || env.OPENAI_MODEL)
  if (!apiKey) throw new Error('AI_API_KEY or OPENAI_API_KEY is required')
  if (!baseUrl) throw new Error('AI_API_BASE_URL or OPENAI_BASE_URL is required')
  if (!model) throw new Error('KAIGONGBA_EXECUTOR_MODEL, AI_MODEL_AGENT, AI_MODEL_CHAT, or OPENAI_MODEL is required')
  return { apiKey, baseUrl, model }
}

function safeFileName(value, fallback = 'agent-result.md') {
  const unsafe = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  const clean = Array.from(compact(value), (character) => (unsafe.has(character) || character.charCodeAt(0) < 32 ? '_' : character)).join('')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim()
  const name = clean || fallback
  return path.extname(name) ? name : `${name}.md`
}

function normalizeMarkdown(value, fallback) {
  const markdown = compact(value) || fallback
  return `${markdown.replace(/\s+$/g, '')}\n`
}

function requirementFromWorkItem(workItem = {}) {
  const payload = workItem.payload && typeof workItem.payload === 'object' ? workItem.payload : {}
  const requirement = payload.requirement && typeof payload.requirement === 'object' ? payload.requirement : {}
  return {
    title: requirement.title ?? workItem.title ?? '',
    goal: requirement.goal ?? requirement.summary ?? workItem.goal ?? '',
    description: requirement.description ?? '',
    deliverables: requirement.deliverables ?? payload.deliverables ?? [],
    acceptanceCriteria: requirement.acceptanceCriteria ?? requirement.acceptance_criteria ?? payload.acceptanceCriteria ?? [],
    inputs: requirement.inputs ?? payload.inputs ?? {},
    attachments: payload.attachments ?? requirement.attachments ?? [],
  }
}

function promptMessages(workItem) {
  const requirement = requirementFromWorkItem(workItem)
  return [
    {
      role: 'system',
      content: [
        'You are the seller-side main Agent executing a paid Kaigongba work item.',
        'Do real task work from the provided requirement. Do not claim external actions, uploads, or customer approvals that you did not perform.',
        'Return strict JSON only with this shape:',
        '{"progressEvents":[{"progress":number,"message":string}],"artifactName":string,"markdown":string,"imagePrompt":string,"finalMessage":string}',
        'The markdown must be a concrete deliverable the buyer can review. If the task asks for an image, storyboard, poster, scene visual, or illustration, also provide imagePrompt for image generation. Use Chinese unless the requirement asks otherwise.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        workItem: {
          id: workItem.id,
          orderId: workItem.orderId,
          serviceSopId: workItem.serviceSopId,
          nodeKey: workItem.nodeKey,
          status: workItem.status,
        },
        requirement,
      }),
    },
  ]
}

async function callModel({ workItem, env, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')
  const { apiKey, baseUrl, model } = modelConfig(env)
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: promptMessages(workItem),
      response_format: { type: 'json_object' },
      temperature: 0.35,
    }),
  })
  if (!response.ok) {
    const raw = typeof response.text === 'function' ? await response.text() : ''
    throw new Error(`model_http_${response.status}${raw ? `: ${raw}` : ''}`)
  }
  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content
  if (!compact(content)) throw new Error('empty_model_content')
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`invalid_model_json: ${error instanceof Error ? error.message : 'parse failed'}`)
  }
}

function normalizeProgressEvents(value) {
  const events = Array.isArray(value) ? value : []
  const normalized = events
    .map((event) => {
      const progress = Number(event?.progress)
      const message = compact(event?.message)
      if (!Number.isFinite(progress) || !message) return null
      return {
        progress: Math.max(1, Math.min(99, Math.round(progress))),
        message,
        sourceAgent: { id: 'openai_work_item_executor', name: 'OpenAI-compatible Work Item Executor' },
      }
    })
    .filter(Boolean)
  return normalized.length ? normalized : [{ progress: 80, message: 'Agent 已生成可交付成果草稿' }]
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase())
}

function imageTaskText(requirement = {}) {
  return [
    requirement.title,
    requirement.goal,
    requirement.description,
    ...(Array.isArray(requirement.deliverables) ? requirement.deliverables.map((item) => (typeof item === 'string' ? item : item?.title || item?.description)) : []),
  ]
    .map(compact)
    .filter(Boolean)
    .join(' ')
}

function shouldGenerateImage({ requirement, result, env }) {
  const mode = compact(env.KAIGONGBA_EXECUTOR_IMAGE_MODE).toLowerCase()
  if (['off', 'false', 'none'].includes(mode)) return false
  if (['always', 'true', 'on'].includes(mode)) return true
  if (compact(result.imagePrompt || result.image_prompt || result.prompt)) return true
  return /(图像|图片|配图|插画|海报|场景图|分镜|视觉|封面|image|poster|storyboard|illustration)/i.test(imageTaskText(requirement))
}

function qwenImageConfig(env = process.env) {
  if (!boolEnv(env.QWEN_IMAGE_ENABLED, false)) return null
  const apiKey = compact(env.QWEN_IMAGE_API_KEY)
  const baseUrl = compact(env.QWEN_IMAGE_BASE_URL).replace(/\/+$/, '')
  const model = compact(env.QWEN_IMAGE_MODEL) || 'qwen-image-2.0-pro'
  if (!apiKey || !baseUrl || !model) throw new Error('Qwen image generation is enabled but QWEN_IMAGE_API_KEY, QWEN_IMAGE_BASE_URL, or QWEN_IMAGE_MODEL is missing')
  return {
    apiKey,
    baseUrl,
    model,
    size: compact(env.QWEN_IMAGE_SIZE || env.QWEN_IMAGE_SIZE_XHS) || '2048*2048',
    n: Number.isFinite(Number(env.QWEN_IMAGE_N)) ? Number(env.QWEN_IMAGE_N) : 1,
    promptExtend: boolEnv(env.QWEN_IMAGE_PROMPT_EXTEND, false),
    watermark: boolEnv(env.QWEN_IMAGE_WATERMARK, false),
    negativePrompt:
      compact(env.QWEN_IMAGE_NEGATIVE_PROMPT) ||
      '低分辨率，低画质，肢体畸形，手指畸形，文字模糊，扭曲，构图混乱，过度锐化，过度光滑，画面具有AI感。',
  }
}

function imageUrlsFromQwenPayload(payload) {
  const content = payload?.output?.choices?.[0]?.message?.content
  if (!Array.isArray(content)) return []
  return content.map((item) => compact(item?.image || item?.url)).filter(Boolean)
}

function extensionFromMime(mimeType) {
  const type = compact(mimeType).toLowerCase()
  if (type.includes('jpeg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  return 'png'
}

function artifactImageName(artifactName) {
  const parsed = path.parse(safeFileName(artifactName || 'agent-result.png'))
  return safeFileName(`${parsed.name || 'agent-result'}.png`)
}

function imagePromptFromResult({ requirement, result }) {
  return (
    compact(result.imagePrompt || result.image_prompt || result.prompt) ||
    [
      compact(requirement.goal) || compact(requirement.title),
      compact(requirement.description),
      '生成一张可直接作为交付成果查看的高清图片，画面完整，主体清晰，风格符合需求。',
    ]
      .filter(Boolean)
      .join('。')
  )
}

async function generateQwenImageArtifact({ requirement, result, artifactDir, env, fetchImpl }) {
  const config = qwenImageConfig(env)
  if (!config) return null
  const prompt = imagePromptFromResult({ requirement, result })
  const response = await fetchImpl(`${config.baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      input: {
        messages: [{ role: 'user', content: [{ text: prompt }] }],
      },
      parameters: {
        negative_prompt: config.negativePrompt,
        size: config.size,
        n: config.n,
        prompt_extend: config.promptExtend,
        watermark: config.watermark,
      },
    }),
  })
  if (!response.ok) {
    const raw = typeof response.text === 'function' ? await response.text() : ''
    throw new Error(`qwen_image_http_${response.status}${raw ? `: ${raw}` : ''}`)
  }
  const payload = await response.json()
  const imageUrl = imageUrlsFromQwenPayload(payload)[0]
  if (!imageUrl) throw new Error('empty_qwen_image_result')
  const imageResponse = await fetchImpl(imageUrl)
  if (!imageResponse.ok) {
    const raw = typeof imageResponse.text === 'function' ? await imageResponse.text() : ''
    throw new Error(`image_download_http_${imageResponse.status}${raw ? `: ${raw}` : ''}`)
  }
  const mimeType = imageResponse.headers?.get?.('content-type') || 'image/png'
  const bytes = Buffer.from(await imageResponse.arrayBuffer())
  const extension = extensionFromMime(mimeType)
  const name = artifactImageName(result.artifactName || result.name || `${compact(requirement.title) || 'agent-result'}.${extension}`)
  const normalizedName = name.endsWith(`.${extension}`) ? name : `${path.parse(name).name}.${extension}`
  const file = path.join(artifactDir, safeFileName(`${Date.now()}-${normalizedName}`))
  await fs.writeFile(file, bytes)
  return { name: normalizedName, type: extension, file, mimeType, sourceUrl: imageUrl, prompt }
}

export async function runOpenAiWorkItemExecutor({ workItem, outputDir, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!workItem || typeof workItem !== 'object') throw new Error('workItem is required')
  const result = await callModel({ workItem, env, fetchImpl })
  const requirement = requirementFromWorkItem(workItem)
  const fallbackMarkdown = [
    `# ${compact(requirement.title) || compact(requirement.goal) || 'Agent 执行成果'}`,
    '',
    compact(result.finalMessage || result.summary) || 'Agent 已完成本阶段任务。',
  ].join('\n')
  const artifactName = safeFileName(result.artifactName || result.name || `${workItem.id || 'work-item'}-result.md`)
  const artifactDir = path.resolve(outputDir || env.KAIGONGBA_EXECUTOR_OUTPUT_DIR || path.join(process.cwd(), '.kaigongba/runtime/artifacts'))
  await fs.mkdir(artifactDir, { recursive: true })
  const artifactFile = path.join(artifactDir, safeFileName(`${workItem.id || Date.now()}-${artifactName}`))
  await fs.writeFile(artifactFile, normalizeMarkdown(result.markdown ?? result.content, fallbackMarkdown), 'utf8')
  const imageArtifact = shouldGenerateImage({ requirement, result, env })
    ? await generateQwenImageArtifact({ requirement, result, artifactDir, env, fetchImpl })
    : null
  const includeMarkdown = imageArtifact ? boolEnv(env.KAIGONGBA_EXECUTOR_INCLUDE_MARKDOWN, false) : true
  const artifacts = [
    ...(imageArtifact ? [imageArtifact] : []),
    ...(includeMarkdown ? [{ name: artifactName, type: 'md', file: artifactFile }] : []),
  ]
  return {
    progressEvents: normalizeProgressEvents(result.progressEvents),
    artifacts,
    finalMessage: compact(result.finalMessage || result.message) || 'Agent 执行完成，已提交阶段成果。',
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!compact(raw)) throw new Error('work item JSON is required on stdin')
  return JSON.parse(raw)
}

async function main() {
  const args = parseArgs()
  const workItem = await readStdin()
  const outputDir = arg(args, ['output-dir', 'outputDir'], process.env.KAIGONGBA_EXECUTOR_OUTPUT_DIR)
  const result = await runOpenAiWorkItemExecutor({ workItem, outputDir })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
