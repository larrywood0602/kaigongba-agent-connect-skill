#!/usr/bin/env node
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { arg, parseArgs, readJson } from './lib.mjs'
import { uploadManifest, uploadManifestFile } from './upload_manifest.mjs'
import { validateManifest } from './validate_manifest.mjs'

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function readRequestJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

function reviewHtml({ manifest, validation }) {
  const manifestText = JSON.stringify(manifest, null, 2)
  const sourcePaths = Array.isArray(manifest.discoverySummary?.selectedSourcePaths) ? manifest.discoverySummary.selectedSourcePaths : []
  const sourceWarnings = Array.isArray(manifest.discoverySummary?.warnings) ? manifest.discoverySummary.warnings : []
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>开工吧 Agent 服务确认</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fb; color: #1f2937; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    p { color: #667085; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; }
    .panel { background: white; border: 1px solid #d9dee8; border-radius: 8px; padding: 16px; }
    .metric { display: grid; grid-template-columns: 92px 1fr; gap: 8px; padding: 8px 0; border-bottom: 1px solid #eef1f6; }
    .metric:last-child { border-bottom: 0; }
    .metric span { color: #667085; }
    textarea { width: 100%; min-height: 620px; box-sizing: border-box; border: 1px solid #d9dee8; border-radius: 8px; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5; resize: vertical; }
    button { appearance: none; border: 0; background: #2563eb; color: white; padding: 10px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #eef2ff; color: #1d4ed8; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .ok { color: #047857; }
    .warn { color: #b45309; }
    .err { color: #b91c1c; }
    .sources { margin: 10px 0 0; padding-left: 18px; color: #475467; font-size: 12px; line-height: 1.5; }
    pre { white-space: pre-wrap; background: #111827; color: #f9fafb; border-radius: 8px; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>确认要上传到开工吧的 Agent 服务</h1>
      <p>请检查技能名称、SOP 节点、交付物、所需输入、风险边界和真人负责人。确认后会上传为平台服务草稿，不会自动发布市场。</p>
    </div>
    <button id="upload" ${validation.ok ? '' : 'disabled'}>${validation.ok ? '确认上传' : '无法上传'}</button>
  </header>
  <div class="grid">
    <section class="panel">
      <div class="metric"><span>服务名称</span><b>${htmlEscape(manifest.serviceCard?.name || '未填写')}</b></div>
      <div class="metric"><span>SOP 节点</span><b>${manifest.workflow?.nodes?.length || 0}</b></div>
      <div class="metric"><span>交付物</span><b>${htmlEscape((manifest.serviceCard?.deliverables || []).join('、') || '未填写')}</b></div>
      <div class="metric"><span>输入材料</span><b>${htmlEscape((manifest.serviceCard?.requiredInputs || []).join('、') || '未填写')}</b></div>
      <div class="metric"><span>真实来源</span><b>${sourcePaths.length ? `${sourcePaths.length} 个文件` : '未发现'}</b></div>
      <div class="metric"><span>校验</span><b class="${validation.ok ? 'ok' : 'err'}">${validation.ok ? '可上传' : '需要修正'}</b></div>
      ${sourcePaths.length ? `<ul class="sources">${sourcePaths.slice(0, 8).map((item) => `<li>${htmlEscape(item)}</li>`).join('')}${sourcePaths.length > 8 ? `<li>还有 ${sourcePaths.length - 8} 个来源...</li>` : ''}</ul>` : ''}
      ${sourceWarnings.length ? `<p class="warn">${htmlEscape(sourceWarnings.join('；'))}</p>` : ''}
      ${validation.warnings.length ? `<p class="warn">${htmlEscape(validation.warnings.join('；'))}</p>` : ''}
      ${validation.errors.length ? `<p class="err">${htmlEscape(validation.errors.join('；'))}</p>` : ''}
      <div class="actions">
        <button class="secondary" id="validate">重新校验</button>
      </div>
      <pre id="result">${validation.ok ? '等待确认上传。' : '没有真实 Agent 技能/SOP 来源时不会上传。请从你的 Agent 项目目录重新运行命令，或传入 --source-dir /path/to/your-agent-project。'}</pre>
    </section>
    <section class="panel">
      <textarea id="manifest">${htmlEscape(manifestText)}</textarea>
    </section>
  </div>
</main>
<script>
const textarea = document.getElementById('manifest')
const result = document.getElementById('result')
const upload = document.getElementById('upload')
async function post(path) {
  const payload = JSON.parse(textarea.value)
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const json = await res.json()
  result.textContent = JSON.stringify(json, null, 2)
  if (path === '/validate') upload.disabled = !json.ok
  if (!res.ok) throw new Error(json.message || 'request failed')
  return json
}
document.getElementById('validate').onclick = () => post('/validate').catch(() => {})
upload.onclick = async () => {
  upload.disabled = true
  try { await post('/upload') } finally { upload.disabled = false }
}
</script>
</body>
</html>`
}

export async function startReviewServer({ manifestFile = 'manifest.json', port = 5678, host = '127.0.0.1' } = {}) {
  let manifest = await readJson(String(manifestFile))
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        const validation = validateManifest(manifest)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(reviewHtml({ manifest, validation }))
        return
      }
      if (req.method === 'GET' && req.url === '/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest, null, 2))
        return
      }
      if (req.method === 'POST' && req.url === '/validate') {
        manifest = await readRequestJson(req)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(validateManifest(manifest), null, 2))
        return
      }
      if (req.method === 'POST' && req.url === '/upload') {
        manifest = await readRequestJson(req)
        const result = await uploadManifest(manifest)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }, null, 2))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: 'not found' }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error), validation: error.validation }, null, 2))
    }
  })
  await new Promise((resolve) => server.listen(port, host, resolve))
  return { server, url: `http://${host}:${port}/` }
}

async function main() {
  const args = parseArgs()
  const manifestFile = String(arg(args, 'file', 'manifest.json'))
  if (arg(args, 'upload')) {
    const result = await uploadManifestFile(manifestFile, args)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  const { url } = await startReviewServer({
    manifestFile,
    port: Number(arg(args, 'port', 5678)),
    host: String(arg(args, 'host', '127.0.0.1')),
  })
  process.stdout.write(`Open this local review page to confirm upload:\n${url}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
