const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const vscode = require('vscode')

const repoRoot = path.resolve(__dirname, '..')
const assetsDir = path.join(repoRoot, 'assets')
const demoDir =
  process.env.ENV_PROTECTOR_DEMO_DIR || path.join(os.tmpdir(), 'my-app')
const framesRoot =
  process.env.ENV_PROTECTOR_FRAMES_DIR ||
  path.join(os.tmpdir(), 'env-protector-frames')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) {
          reject(new Error(msg.error.message))
        } else {
          resolve(msg.result)
        }
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async screenshot(filePath) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
    })
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
  }

  async insertText(text) {
    await this.send('Input.insertText', { text })
  }

  async pressKey(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    })
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  close() {
    if (this.ws) {
      this.ws.close()
    }
  }
}

class GifRecorder {
  constructor(cdp, name) {
    this.cdp = cdp
    this.name = name
    this.dir = path.join(framesRoot, name)
    this.frameIdx = 0
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
  }

  async snap(repeat = 1) {
    const { data } = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
    })
    const buf = Buffer.from(data, 'base64')
    for (let i = 0; i < repeat; i++) {
      const file = path.join(
        this.dir,
        `frame_${String(this.frameIdx++).padStart(4, '0')}.png`,
      )
      fs.writeFileSync(file, buf)
    }
  }

  async typeWithFrames(text, charDelayMs = 45) {
    for (const ch of text) {
      await this.cdp.insertText(ch)
      await delay(charDelayMs)
      await this.snap(1)
    }
  }

  encodeGif(outputPath, fps = 12) {
    const palettePath = path.join(this.dir, 'palette.png')
    const inputPattern = path.join(this.dir, 'frame_%04d.png')
    execFileSync('ffmpeg', [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      inputPattern,
      '-vf',
      'palettegen=stats_mode=diff',
      '-update',
      '1',
      palettePath,
    ])
    execFileSync('ffmpeg', [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      inputPattern,
      '-i',
      palettePath,
      '-lavfi',
      'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      outputPath,
    ])
  }
}

exports.run = async () => {
  await delay(1800)

  const res = await fetch('http://127.0.0.1:9229/json')
  const targets = await res.json()
  const pageTarget = targets.find((t) => t.type === 'page')
  if (!pageTarget) {
    throw new Error('Could not find VS Code renderer page target')
  }

  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Page.enable')

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1120,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  })

  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
  } catch {}
  try {
    await vscode.commands.executeCommand('workbench.action.closePanel')
  } catch {}
  try {
    await vscode.commands.executeCommand('workbench.view.explorer')
  } catch {}
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')

  const ext = vscode.extensions.getExtension('sametcn99.env-protector')
  if (ext && !ext.isActive) {
    await ext.activate()
  }
  await delay(600)

  try {
    await vscode.commands.executeCommand('notifications.clearAll')
    await vscode.commands.executeCommand('workbench.action.closeMessages')
  } catch {}
  await delay(400)

  const envPath = path.join(demoDir, '.env')
  const envUri = vscode.Uri.file(envPath)

  // 1. Capture assets/commands.png
  console.log('Capturing assets/commands.png...')
  await vscode.commands.executeCommand(
    'workbench.action.quickOpen',
    '>env-protector: ',
  )
  await delay(600)
  await cdp.screenshot(path.join(assetsDir, 'commands.png'))
  await cdp.pressKey('Escape', 'Escape', 27)
  await delay(400)

  // 2. Capture assets/dialog.png & assets/masked.png
  console.log('Capturing assets/dialog.png & assets/masked.png...')
  vscode.commands.executeCommand('vscode.open', envUri)
  await delay(800)
  await cdp.screenshot(path.join(assetsDir, 'dialog.png'))

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(1200)
  await cdp.screenshot(path.join(assetsDir, 'masked.png'))

  // 3. Record assets/add.gif
  console.log('Recording assets/add.gif...')
  const addRec = new GifRecorder(cdp, 'add')
  await addRec.snap(6)

  await vscode.commands.executeCommand(
    'workbench.action.quickOpen',
    '>env-protector: Add Environment Variable',
  )
  await delay(450)
  await addRec.snap(8)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(500)
  await addRec.snap(7)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(450)
  await addRec.snap(5)

  await addRec.typeWithFrames('STRIPE_SECRET_KEY', 40)
  await addRec.snap(6)
  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(450)
  await addRec.snap(5)

  await addRec.typeWithFrames('sk_live_51N9xSecret9988', 35)
  await addRec.snap(6)
  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(450)
  await addRec.snap(5)

  await addRec.typeWithFrames('Stripe API key', 40)
  await addRec.snap(6)
  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(900)
  await addRec.snap(18)
  addRec.encodeGif(path.join(assetsDir, 'add.gif'), 12)

  try {
    await vscode.commands.executeCommand('notifications.clearAll')
  } catch {}
  await delay(300)

  // 4. Record assets/edit.gif
  console.log('Recording assets/edit.gif...')
  const editRec = new GifRecorder(cdp, 'edit')
  await editRec.snap(6)

  await vscode.commands.executeCommand(
    'workbench.action.quickOpen',
    '>env-protector: Edit Environment Variable',
  )
  await delay(450)
  await editRec.snap(8)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(500)
  await editRec.snap(7)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(500)
  await editRec.snap(6)

  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext')
  await delay(300)
  await editRec.snap(7)
  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(450)
  await editRec.snap(5)

  await editRec.typeWithFrames('new_rotated_jwt_secret_2026_v2', 35)
  await editRec.snap(6)
  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(900)
  await editRec.snap(18)
  editRec.encodeGif(path.join(assetsDir, 'edit.gif'), 12)

  try {
    await vscode.commands.executeCommand('notifications.clearAll')
  } catch {}
  await delay(300)

  // 5. Record assets/remove.gif
  console.log('Recording assets/remove.gif...')
  const remRec = new GifRecorder(cdp, 'remove')
  await remRec.snap(6)

  await vscode.commands.executeCommand(
    'workbench.action.quickOpen',
    '>env-protector: Remove Environment Variable',
  )
  await delay(450)
  await remRec.snap(8)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(500)
  await remRec.snap(7)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(500)
  await remRec.snap(6)

  for (let i = 0; i < 3; i++) {
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext')
    await delay(220)
    await remRec.snap(3)
  }

  const coordsResult = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row'));
      const targetRow = rows.find(r => r.textContent && r.textContent.includes('LEGACY_API_TOKEN'));
      const cb = targetRow ? (targetRow.querySelector('input[type="checkbox"], .quick-input-list-checkbox') || targetRow) : null;
      const okBtn = document.querySelector('.quick-input-action .monaco-button');
      const cbRect = cb ? cb.getBoundingClientRect() : null;
      const okRect = okBtn ? okBtn.getBoundingClientRect() : null;
      return JSON.stringify({
        cb: cbRect ? { x: Math.round(cbRect.left + cbRect.width / 2), y: Math.round(cbRect.top + cbRect.height / 2) } : null,
        ok: okRect ? { x: Math.round(okRect.left + okRect.width / 2), y: Math.round(okRect.top + okRect.height / 2) } : null,
      });
    })()`,
    returnByValue: true,
  })
  const coords = JSON.parse(coordsResult.result.value)

  if (coords.cb) {
    await cdp.click(coords.cb.x, coords.cb.y)
  }
  await delay(400)
  await remRec.snap(8)

  if (coords.ok) {
    await cdp.click(coords.ok.x, coords.ok.y)
  } else {
    await vscode.commands.executeCommand(
      'workbench.action.acceptSelectedQuickOpenItem',
    )
  }
  await delay(900)
  await remRec.snap(18)
  remRec.encodeGif(path.join(assetsDir, 'remove.gif'), 12)

  try {
    await vscode.commands.executeCommand('notifications.clearAll')
  } catch {}
  await delay(300)

  // 6. Capture assets/diff-masked.png
  console.log('Capturing assets/diff-masked.png...')
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await delay(300)

  const diffDir = path.join(framesRoot, 'diff-demo')
  const origDir = path.join(diffDir, 'orig')
  const modDir = path.join(diffDir, 'mod')
  fs.mkdirSync(origDir, { recursive: true })
  fs.mkdirSync(modDir, { recursive: true })

  const origEnvPath = path.join(origDir, '.env')
  const modEnvPath = path.join(modDir, '.env')

  fs.writeFileSync(
    origEnvPath,
    `${[
      '# Production Environment Configuration',
      'DATABASE_URL=postgres://admin:secret@db.local/app # DB',
      'JWT_SECRET=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_old',
      'REDIS_PASSWORD=redis_prod_99481a8f2c',
      'LEGACY_API_TOKEN=tok_old_deprecated_key_12345',
    ].join('\n')}\n`,
  )

  fs.writeFileSync(
    modEnvPath,
    `${[
      '# Production Environment Configuration',
      'DATABASE_URL=postgres://admin:secret@db.local/app # DB',
      'JWT_SECRET=new_rotated_jwt_secret_2026_v2 # Rotated',
      'REDIS_PASSWORD=redis_prod_99481a8f2c',
      'STRIPE_SECRET_KEY=sk_live_51N9xSecret9988 # Stripe',
    ].join('\n')}\n`,
  )

  try {
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
  } catch {}
  await delay(300)

  vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(origEnvPath),
    vscode.Uri.file(modEnvPath),
    '.env (Working Tree)',
  )
  await delay(800)

  await vscode.commands.executeCommand(
    'workbench.action.acceptSelectedQuickOpenItem',
  )
  await delay(1400)
  await cdp.screenshot(path.join(assetsDir, 'diff-masked.png'))

  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()
  console.log('ALL_ASSETS_CAPTURED_SUCCESSFULLY')
}
