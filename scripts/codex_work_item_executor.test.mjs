import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCodexWorkItemExecutor } from './codex_work_item_executor.mjs'

let tempDir

describe('Codex work item executor', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-codex-executor-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('runs codex exec and returns only real artifact files', async () => {
    const fakeCodex = join(tempDir, 'fake-codex.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nimport fs from 'node:fs'\nimport path from 'node:path'\nconst args = process.argv.slice(2)\nconst outputIndex = args.indexOf('--output-last-message')\nconst resultFile = args[outputIndex + 1]\nconst cdIndex = args.indexOf('--cd')\nconst outputDir = args[cdIndex + 1]\nconst artifactFile = path.join(outputDir, 'nike-product-page.html')\nfs.writeFileSync(artifactFile, '<html><body>Nike product image concept</body></html>')\nfs.writeFileSync(resultFile, JSON.stringify({\n  status: 'completed',\n  progressEvents: [{ progress: 80, message: '已生成真实文件' }],\n  artifacts: [{ name: 'nike-product-page.html', type: 'html', file: artifactFile }],\n  finalMessage: 'Codex 已完成电商图交付文件'\n}))\n`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: {
        id: 'work_codex_1',
        orderId: 'order_1',
        payload: {
          requirement: {
            title: 'Nike球鞋电商图生成',
            goal: '生成高质量、符合品牌调性的Nike球鞋电商展示图',
          },
        },
      },
    })

    expect(result).toMatchObject({
      status: 'completed',
      progressEvents: [{ progress: 80, message: '已生成真实文件' }],
      artifacts: [{ name: 'nike-product-page.html', type: 'html' }],
      finalMessage: 'Codex 已完成电商图交付文件',
    })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toContain('Nike product image concept')
  })
})
