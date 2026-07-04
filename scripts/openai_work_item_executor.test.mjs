import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOpenAiWorkItemExecutor } from './openai_work_item_executor.mjs'

let tempDir

describe('OpenAI-compatible work item executor', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-openai-executor-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('calls an OpenAI-compatible model and writes a markdown artifact', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                progressEvents: [{ progress: 70, message: '已完成分镜结构' }],
                artifactName: '小狗追蝴蝶分镜.md',
                markdown: '# 小狗追蝴蝶分镜\n\n1. 小狗进入花园。',
                finalMessage: '分镜草稿已生成',
              }),
            },
          },
        ],
      }),
    }))
    const workItem = {
      id: 'work_1',
      orderId: 'order_1',
      payload: {
        requirement: {
          title: '小狗追蝴蝶',
          goal: '生成一个关于小狗在花园里追蝴蝶的分镜图',
          deliverables: ['分镜图'],
          acceptanceCriteria: ['可用于广告沟通'],
        },
      },
    }

    const result = await runOpenAiWorkItemExecutor({
      workItem,
      outputDir: tempDir,
      env: {
        AI_API_KEY: 'test-key',
        AI_API_BASE_URL: 'https://model.example/v1',
        AI_MODEL_AGENT: 'agent-model',
      },
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://model.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    )
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({ model: 'agent-model', response_format: { type: 'json_object' } })
    expect(JSON.stringify(requestBody.messages)).toContain('生成一个关于小狗在花园里追蝴蝶的分镜图')
    expect(result).toMatchObject({
      progressEvents: [{ progress: 70, message: '已完成分镜结构' }],
      artifacts: [{ name: '小狗追蝴蝶分镜.md', type: 'md' }],
      finalMessage: '分镜草稿已生成',
    })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toBe('# 小狗追蝴蝶分镜\n\n1. 小狗进入花园。\n')
  })

  it('generates a png artifact for image work items when Qwen image is enabled', async () => {
    const pngBytes = Buffer.from('fake-png')
    const fetchImpl = vi.fn(async (url) => {
      if (url === 'https://model.example/v1/chat/completions') {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    progressEvents: [{ progress: 55, message: '已生成图像提示词' }],
                    artifactName: '小狗追蝴蝶分镜图.md',
                    imagePrompt: '可爱卡通风格，六格分镜，小狗在花园里追蝴蝶',
                    markdown: '# 分镜说明',
                    finalMessage: '分镜图已生成',
                  }),
                },
              },
            ],
          }),
        }
      }
      if (url === 'https://qwen.example/api/v1/services/aigc/multimodal-generation/generation') {
        return {
          ok: true,
          json: async () => ({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://assets.example/storyboard.png' }],
                  },
                },
              ],
            },
            usage: { width: 2048, height: 2048, image_count: 1 },
          }),
        }
      }
      if (url === 'https://assets.example/storyboard.png') {
        return {
          ok: true,
          headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : '') },
          arrayBuffer: async () => pngBytes,
        }
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const result = await runOpenAiWorkItemExecutor({
      workItem: {
        id: 'work_image_1',
        orderId: 'order_1',
        payload: {
          requirement: {
            title: '小狗追蝴蝶',
            goal: '生成一个关于小狗在花园里追蝴蝶的分镜图',
          },
        },
      },
      outputDir: tempDir,
      env: {
        AI_API_KEY: 'test-key',
        AI_API_BASE_URL: 'https://model.example/v1',
        AI_MODEL_AGENT: 'agent-model',
        QWEN_IMAGE_ENABLED: 'true',
        QWEN_IMAGE_API_KEY: 'qwen-key',
        QWEN_IMAGE_BASE_URL: 'https://qwen.example/api/v1',
        QWEN_IMAGE_MODEL: 'qwen-image-2.0-pro',
      },
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://qwen.example/api/v1/services/aigc/multimodal-generation/generation',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer qwen-key' }),
      }),
    )
    expect(result).toMatchObject({
      artifacts: [{ name: '小狗追蝴蝶分镜图.png', type: 'png' }],
      finalMessage: '分镜图已生成',
    })
    expect(await readFile(result.artifacts[0].file)).toEqual(pngBytes)
  })
})
