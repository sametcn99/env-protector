const fs = require('fs')
const os = require('os')
const path = require('path')
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron')

const repoRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-protector-assets-'))
const demoDir = path.join(tempRoot, 'my-app')
const framesRoot = path.join(tempRoot, 'frames')

function prepareDemoWorkspace() {
  fs.rmSync(demoDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(demoDir, 'src', 'app'), { recursive: true })
  fs.mkdirSync(path.join(demoDir, 'src', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(demoDir, '.vscode'), { recursive: true })

  fs.writeFileSync(
    path.join(demoDir, '.vscode', 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'window.commandCenter': true,
        'editor.minimap.enabled': false,
        'breadcrumbs.enabled': false,
        'workbench.tips.enabled': false,
        'security.workspace.trust.enabled': false,
      },
      null,
      2,
    ),
  )

  const initialEnv = [
    '# Production Environment Configuration',
    'DATABASE_URL=postgres://admin:secret@db.local:5432/app # Primary DB',
    'JWT_SECRET=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_secret',
    'REDIS_PASSWORD=redis_prod_99481a8f2c',
    'LEGACY_API_TOKEN=tok_old_deprecated_key_12345',
  ].join('\n')

  fs.writeFileSync(path.join(demoDir, '.env'), `${initialEnv}\n`)
  fs.writeFileSync(
    path.join(demoDir, 'src', 'app', 'page.tsx'),
    'export default function Page() { return null }\n',
  )
  fs.writeFileSync(
    path.join(demoDir, 'src', 'app', 'layout.tsx'),
    'export default function Layout() { return null }\n',
  )
  fs.writeFileSync(
    path.join(demoDir, 'src', 'lib', 'auth.ts'),
    'export const auth = {}\n',
  )
  fs.writeFileSync(path.join(demoDir, '.gitignore'), 'node_modules\n.env\n')
  fs.writeFileSync(
    path.join(demoDir, 'package.json'),
    JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2),
  )
  fs.writeFileSync(path.join(demoDir, 'README.md'), '# My App\n')
  fs.writeFileSync(path.join(demoDir, 'tsconfig.json'), '{}\n')
}

async function resolveVSCodeExecutable() {
  const cachedDir = path.join(repoRoot, '.vscode-test')
  if (fs.existsSync(cachedDir)) {
    const entries = fs.readdirSync(cachedDir)
    for (const entry of entries) {
      const candidate = path.join(cachedDir, entry, 'Code.exe')
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }
  return downloadAndUnzipVSCode('stable')
}

async function main() {
  prepareDemoWorkspace()
  const vscodeExecutablePath = await resolveVSCodeExecutable()

  process.env.ENV_PROTECTOR_DEMO_DIR = demoDir
  process.env.ENV_PROTECTOR_FRAMES_DIR = framesRoot

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'capture-runner.js'),
      launchArgs: [
        demoDir,
        '--remote-debugging-port=9229',
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
    })
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors on locked temp files
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
