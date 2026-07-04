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

  it('materializes base64 work item attachments before running codex', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-attachments.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nimport fs from 'node:fs'\nimport path from 'node:path'\nlet prompt = ''\nprocess.stdin.on('data', (chunk) => { prompt += chunk })\nprocess.stdin.on('end', () => {\n  const args = process.argv.slice(2)\n  const outputIndex = args.indexOf('--output-last-message')\n  const resultFile = args[outputIndex + 1]\n  const cdIndex = args.indexOf('--cd')\n  const outputDir = args[cdIndex + 1]\n  const marker = 'input-attachments/shoe.jpg'\n  if (!prompt.includes(marker)) throw new Error('attachment local path missing from prompt')\n  const localFile = path.join(outputDir, marker)\n  const bytes = fs.readFileSync(localFile)\n  if (bytes.toString('utf8') !== 'fake image bytes') throw new Error('attachment bytes not materialized')\n  const artifactFile = path.join(outputDir, 'result.md')\n  fs.writeFileSync(artifactFile, 'used ' + marker)\n  fs.writeFileSync(resultFile, JSON.stringify({\n    status: 'completed',\n    progressEvents: [],\n    artifacts: [{ name: 'result.md', type: 'md', file: artifactFile }],\n    finalMessage: 'attachment handled'\n  }))\n})\n`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: {
        id: 'work_codex_attachment',
        orderId: 'order_1',
        payload: {
          requirement: { title: '鞋子场景图生成', goal: '为上传鞋图生成场景图' },
          attachments: [{
            name: 'shoe.jpg',
            type: 'image/jpeg',
            contentBase64: Buffer.from('fake image bytes', 'utf8').toString('base64'),
          }],
        },
      },
    })

    expect(result).toMatchObject({ status: 'completed', finalMessage: 'attachment handled' })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toContain('input-attachments')
  })
})
