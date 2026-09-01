// Acceptance for the package users actually install, not this worktree.
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-browser-pack-'))
const packs = join(scratch, 'packs')
const install = join(scratch, 'install')
const npmCache = join(scratch, 'npm-cache')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`)))
  })
}

try {
  await Promise.all([mkdir(packs, { recursive: true }), mkdir(install, { recursive: true }), mkdir(npmCache, { recursive: true })])
  const npmCli = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null
  if (npmCli) await access(npmCli)
  const runNpm = (args, options = {}) => run(
    npmCli ? process.execPath : 'npm',
    npmCli ? [npmCli, ...args] : args,
    options,
  )
  const env = { ...process.env, npm_config_cache: npmCache }
  await runNpm(['pack', '--json', '--pack-destination', packs], { env })
  const archive = (await readdir(packs)).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('npm pack produced no archive')
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n')
  await runNpm(['install', '--no-audit', '--no-fund', join(packs, archive)], { cwd: install, env })

  try {
    await access(join(install, 'node_modules', '@deepseek-ai'))
    throw new Error('packed install unexpectedly pulled @deepseek-ai/* packages')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const installedRoot = join(install, 'node_modules', '@zseven-w', 'dsh-browser')
  for (const relative of [
    'lib/index.js', 'lib/index.d.ts', 'lib/driver-contract.d.ts',
    'cordis.patch.yml', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md',
  ]) {
    await access(join(installedRoot, relative))
  }
  const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith('@deepseek-ai/')) throw new Error(`${field} unexpectedly contains ${name}`)
    }
  }

  const probe = [
    "import { BrowserManager, BROWSER_DRIVER_CONTRACT_VERSION, BROWSER_DRIVER_SERVICE } from '@zseven-w/dsh-browser';",
    "if (BROWSER_DRIVER_SERVICE !== 'zsevenBrowserDriver') throw new Error('service contract mismatch');",
    "if (BROWSER_DRIVER_CONTRACT_VERSION !== 5) throw new Error('driver contract version mismatch');",
    "const manager = new BrowserManager({ allowedOrigins: [] });",
    "if (manager.kind !== 'browser' || manager.contractVersion !== 5) throw new Error('driver identity mismatch');",
    "try {",
    "  const started = await manager.start('packed-smoke');",
    "  if (started.isolation !== 'ephemeral-user-data') throw new Error('isolation mismatch');",
    "  const observed = await manager.observe('packed-smoke');",
    "  if (!Array.isArray(observed.nodes)) throw new Error('observation missing nodes');",
    "  const capture = await manager.visualObserve('packed-smoke');",
    "  if (!Array.isArray(capture.marks) || !Array.isArray(capture.omitted)) throw new Error('visual capture missing marks/omissions');",
    "  if (capture.capture.artifact.format !== 'png' || typeof capture.capture.artifact.path !== 'string') throw new Error('visual capture artifact mismatch');",
    "  await manager.disposeScope('packed-smoke');",
    "  if (manager.activeOwners().length !== 0) throw new Error('disposeScope did not close session');",
    "} finally { await manager.dispose(); }",
  ].join('\n')
  await run(process.execPath, ['--input-type=module', '-e', probe], { cwd: install, env })
  console.log(`packed install smoke passed with real managed browser: ${archive}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
