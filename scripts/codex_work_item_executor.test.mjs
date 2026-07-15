import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCodexWorkItemExecutor } from './codex_work_item_executor.mjs'

let tempDir
let server

describe('Codex work item executor', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kgb-codex-executor-'))
  })

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    server = null
    await rm(tempDir, { recursive: true, force: true })
  })

  it('streams native Codex and semantic progress before returning the final result', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-stream.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
if (!args.includes('--json')) throw new Error('missing --json')
const outputIndex = args.indexOf('--output-last-message')
const resultFile = args[outputIndex + 1]
const cdIndex = args.indexOf('--cd')
const outputDir = args[cdIndex + 1]
const helperFile = path.join(outputDir, 'report_progress.mjs')
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread_stream' }) + '\\n')
setTimeout(() => {
  execFileSync(process.execPath, [helperFile, '--phase', 'PPT 生成', '--current', '6', '--total', '12', '--unit', 'page', '--message', '已完成第 6 页'])
  const artifactFile = path.join(outputDir, 'stream-result.pptx')
  fs.writeFileSync(artifactFile, 'streamed deck bytes')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: artifactFile }] } }) + '\\n')
  setTimeout(() => {
    fs.writeFileSync(resultFile, JSON.stringify({
      status: 'completed',
      progressEvents: [],
      artifacts: [{ name: 'stream-result.pptx', type: 'pptx', file: artifactFile }],
      finalMessage: 'stream completed'
    }))
  }, 30)
}, 20)
process.stdin.resume()
`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const streamed = []
    let resolved = false
    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: {
        ...process.env,
        CODEX_EXECUTABLE: fakeCodex,
        KAIGONGBA_ACTIVITY_POLL_INTERVAL_MS: '5',
        KAIGONGBA_ARTIFACT_STABLE_WINDOW_MS: '10',
        KAIGONGBA_ARTIFACT_STABLE_POLL_INTERVAL_MS: '2',
      },
      workItem: {
        id: 'work_codex_stream',
        orderId: 'order_stream',
        payload: { requirement: { title: '流式 PPT', goal: '生成 12 页演示文稿' } },
      },
      onEvent: async (event) => streamed.push({ event, resolved }),
    })
    resolved = true

    expect(streamed.some(({ event, resolved: wasResolved }) => event.type === 'lifecycle' && wasResolved === false)).toBe(true)
    expect(streamed.some(({ event, resolved: wasResolved }) => event.type === 'progress' && event.percent === 50 && wasResolved === false)).toBe(true)
    expect(streamed.some(({ event }) => event.type === 'file' && event.status === 'observed')).toBe(true)
    expect(streamed.some(({ event }) => event.type === 'file' && event.status === 'stable' && event.sha256)).toBe(true)
    expect(streamed.at(-1)?.event).toMatchObject({ type: 'result', status: 'completed' })
    expect(result).toMatchObject({ status: 'completed', finalMessage: 'stream completed' })
    expect(result.artifacts[0].file).toContain(`${join(tempDir, 'work_codex_stream', '.kaigongba-stable')}/`)
    expect(result.artifacts[0]).toMatchObject({
      sizeBytes: 19,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      maxArtifactBytes: 256 * 1024 * 1024,
    })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toBe('streamed deck bytes')
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

  it('does not expose connector or API credentials to the Codex child process', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-env.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
for (const key of ['KAIGONGBA_AGENT_TOKEN', 'KAIGONGBA_CONNECT_CODE', 'OPENAI_API_KEY', 'EXAMPLE_API_SECRET']) {
  if (process.env[key]) throw new Error('secret inherited: ' + key)
}
const args = process.argv.slice(2)
const resultFile = args[args.indexOf('--output-last-message') + 1]
const outputDir = args[args.indexOf('--cd') + 1]
const artifactFile = path.join(outputDir, 'safe-env.txt')
fs.writeFileSync(artifactFile, 'safe')
fs.writeFileSync(resultFile, JSON.stringify({
  status: 'completed', progressEvents: [],
  artifacts: [{ name: 'safe-env.txt', type: 'txt', file: artifactFile }],
  finalMessage: 'safe environment'
}))
`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: {
        ...process.env,
        CODEX_EXECUTABLE: fakeCodex,
        KAIGONGBA_AGENT_TOKEN: 'kgb_agent_private',
        KAIGONGBA_CONNECT_CODE: 'kgbc_private',
        OPENAI_API_KEY: 'sk-private',
        EXAMPLE_API_SECRET: 'private',
      },
      workItem: { id: 'work_safe_env', payload: { requirement: { title: 'safe env' } } },
    })

    expect(result).toMatchObject({ status: 'completed', finalMessage: 'safe environment' })
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

  it('materializes selected skill instructions and tells codex to use them', async () => {
    const skillDir = join(tempDir, 'html-report')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: html-report',
        'description: Generate single-file HTML reports.',
        '---',
        '',
        '# HTML Report Skill',
        '',
        'Use this skill to generate a single-file HTML report artifact.',
      ].join('\n'),
      'utf8',
    )
    const fakeCodex = join(tempDir, 'fake-codex-skill.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nimport fs from 'node:fs'\nimport path from 'node:path'\nlet prompt = ''\nprocess.stdin.on('data', (chunk) => { prompt += chunk })\nprocess.stdin.on('end', () => {\n  const args = process.argv.slice(2)\n  const outputIndex = args.indexOf('--output-last-message')\n  const resultFile = args[outputIndex + 1]\n  const cdIndex = args.indexOf('--cd')\n  const outputDir = args[cdIndex + 1]\n  const expectedSkillPath = path.join(outputDir, 'connected-skill', 'SKILL.md')\n  if (!fs.existsSync(expectedSkillPath)) throw new Error('connected skill file was not materialized')\n  if (!prompt.includes('MUST use the connected skill before producing artifacts')) throw new Error('skill usage instruction missing from prompt')\n  if (!prompt.includes(expectedSkillPath)) throw new Error('materialized skill path missing from prompt')\n  if (!prompt.includes('HTML 可视化报告生成')) throw new Error('capability metadata missing from prompt')\n  const artifactFile = path.join(outputDir, 'skill-result.html')\n  fs.writeFileSync(artifactFile, '<html><body>used html report skill</body></html>')\n  fs.writeFileSync(resultFile, JSON.stringify({\n    status: 'completed',\n    progressEvents: [],\n    artifacts: [{ name: 'skill-result.html', type: 'html', file: artifactFile }],\n    finalMessage: 'used selected skill'\n  }))\n})\n`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: {
        id: 'work_codex_skill',
        orderId: 'order_1',
        payload: {
          capability: {
            id: 'cap_html',
            name: 'HTML 可视化报告生成',
            capabilityType: 'skill',
            sourceKind: 'skill',
            sourcePath: join(skillDir, 'SKILL.md'),
            sourceFingerprint: 'html-report-v1',
          },
          requirement: { title: 'HTML报告', goal: '生成单文件 HTML 报告' },
        },
      },
    })

    expect(result).toMatchObject({ status: 'completed', finalMessage: 'used selected skill' })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toContain('used html report skill')
  })

  it('downloads signed work item attachments before running codex', async () => {
    const attachmentBytes = Buffer.from('downloaded shoe image bytes', 'utf8')
    server = createServer((req, res) => {
      if (req.url === '/download/shoe.jpg?token=signed-token') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(attachmentBytes)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const downloadUrl = `http://127.0.0.1:${port}/download/shoe.jpg?token=signed-token`

    const fakeCodex = join(tempDir, 'fake-codex-download.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nimport fs from 'node:fs'\nimport path from 'node:path'\nlet prompt = ''\nprocess.stdin.on('data', (chunk) => { prompt += chunk })\nprocess.stdin.on('end', () => {\n  const args = process.argv.slice(2)\n  const outputIndex = args.indexOf('--output-last-message')\n  const resultFile = args[outputIndex + 1]\n  const cdIndex = args.indexOf('--cd')\n  const outputDir = args[cdIndex + 1]\n  const marker = 'input-attachments/shoe.jpg'\n  if (!prompt.includes(marker)) throw new Error('downloaded attachment local path missing from prompt')\n  if (prompt.includes('signed-token')) throw new Error('signed download URL leaked into prompt')\n  const localFile = path.join(outputDir, marker)\n  const bytes = fs.readFileSync(localFile)\n  if (bytes.toString('utf8') !== 'downloaded shoe image bytes') throw new Error('downloaded attachment bytes not materialized')\n  const artifactFile = path.join(outputDir, 'download-result.md')\n  fs.writeFileSync(artifactFile, 'used downloaded ' + marker)\n  fs.writeFileSync(resultFile, JSON.stringify({\n    status: 'completed',\n    progressEvents: [],\n    artifacts: [{ name: 'download-result.md', type: 'md', file: artifactFile }],\n    finalMessage: 'download attachment handled'\n  }))\n})\n`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    const result = await runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: {
        id: 'work_codex_download_attachment',
        orderId: 'order_1',
        payload: {
          requirement: {
            title: '鞋子场景图生成',
            goal: '为上传鞋图生成场景图',
            files: [{ id: 'file_shoe', name: 'shoe.jpg' }],
          },
          attachments: [{
            id: 'file_shoe',
            name: 'shoe.jpg',
            type: 'image/jpeg',
            downloadUrl,
            downloadExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            metadata: { inlineBytes: false, inlineOmittedReason: 'file_too_large' },
          }],
        },
      },
    })

    expect(result).toMatchObject({ status: 'completed', finalMessage: 'download attachment handled' })
    expect(await readFile(result.artifacts[0].file, 'utf8')).toContain('input-attachments')
  })

  it('does not treat native turn completion as final authority without a result file', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-no-result.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
process.stdin.resume()
`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    await expect(runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: { id: 'work_no_result', payload: { requirement: { title: 'no result' } } },
    })).rejects.toThrow('without creating artifact files')
  })

  it('rejects a final result that names an artifact file Codex did not create', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-missing-artifact.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const resultFile = args[args.indexOf('--output-last-message') + 1]
const outputDir = args[args.indexOf('--cd') + 1]
fs.writeFileSync(resultFile, JSON.stringify({
  status: 'completed', progressEvents: [],
  artifacts: [{ name: 'missing.pdf', type: 'pdf', file: path.join(outputDir, 'missing.pdf') }],
  finalMessage: 'not actually complete'
}))
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
process.stdin.resume()
`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)

    await expect(runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: { id: 'work_missing_artifact', payload: { requirement: { title: 'missing artifact' } } },
    })).rejects.toThrow('artifact file was not created')
  })

  it('never forwards credentials or absolute paths from Codex stderr to public events', async () => {
    const fakeCodex = join(tempDir, 'fake-codex-secret-stderr.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
process.stderr.write('Bearer kgb_agent_PRIVATE kgbc_PRIVATE /Users/larry/private/result.txt\\n')
process.exitCode = 1
`,
      'utf8',
    )
    await chmod(fakeCodex, 0o755)
    const events = []

    await expect(runCodexWorkItemExecutor({
      outputDir: tempDir,
      env: { ...process.env, CODEX_EXECUTABLE: fakeCodex },
      workItem: { id: 'work_secret_stderr', payload: { requirement: { title: 'secret stderr' } } },
      onEvent: async (event) => events.push(event),
    })).rejects.toThrow()

    expect(events.some((event) => event.type === 'error')).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/kgb_agent_PRIVATE|kgbc_PRIVATE|\/Users\/larry/)
  })
})
