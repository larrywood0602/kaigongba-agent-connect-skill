import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { buildManifest, integrityFilesFromPackage } from './refresh_manifest.mjs'
import { validatePackageManifestParity } from './validate_skill.mjs'

const SKILL_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..')

it('keeps every explicit npm runtime file in the integrity manifest', async () => {
  const pkg = JSON.parse(await readFile(join(SKILL_DIR, 'package.json'), 'utf8'))
  const manifest = await buildManifest()
  const expected = integrityFilesFromPackage(pkg)

  expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(expected))
  expect(expected).toEqual(expect.arrayContaining([
    'references/connection-rotation.md',
    'scripts/executor_protocol.mjs',
    'scripts/report_progress.mjs',
    'scripts/runtime_activity.mjs',
  ]))
})

it('reports a packaged runtime dependency omitted from manifest integrity checks', () => {
  const errors = validatePackageManifestParity(
    ['manifest.json', 'scripts/run_work_item.mjs', 'scripts/runtime_activity.mjs'],
    { 'manifest.json': {}, 'package.json': {}, 'scripts/run_work_item.mjs': {} },
  )

  expect(errors).toContain('manifest missing packaged file entry: scripts/runtime_activity.mjs')
})
