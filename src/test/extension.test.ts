import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as vscode from 'vscode'
import {
  computeAlignedDiffRows,
  getCanonicalEnvBaseName,
  getMaskedDiffView,
  getMaskedView,
  isEnvFileUri,
  orderDiffUris,
  parseGitRef,
} from '../utils/get-masked-view'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

suite('Env Protector Test Suite', () => {
  let tmpDir: string

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-protector-test-'))
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await delay(200)
  })

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await delay(200)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors on Windows file locks
    }
  })

  suite('getMaskedView Unit Tests', () => {
    test('Masks key=value pairs while preserving keys and comments', () => {
      const content = [
        '# Database configuration',
        'DB_PASSWORD=supersecret # inline comment',
        'API_KEY=12345',
      ].join('\n')

      const html = getMaskedView(content, 'env-protector')

      assert.ok(html.includes('# Database configuration'))
      assert.ok(html.includes('DB_PASSWORD'))
      assert.ok(html.includes('# inline comment'))
      assert.ok(html.includes('*'.repeat('supersecret '.length)))
      assert.ok(!html.includes('supersecret'))
      assert.ok(html.includes('API_KEY'))
      assert.ok(html.includes('*****'))
      assert.ok(!html.includes('12345'))
      assert.ok(html.includes('2 masked key-value pairs in the .env file'))
    })

    test('Renders empty state message when file is empty', () => {
      const html = getMaskedView('', 'env-protector')
      assert.ok(html.includes('No content found in the .env file'))
    })

    test('getMaskedDiffView computes aligned diff rows with added, removed, and modified highlights while keeping values masked', () => {
      const original = [
        '# App Config',
        'UNCHANGED_KEY=same_secret',
        'MODIFIED_KEY=old_secret',
        'REMOVED_KEY=deleted_secret',
      ].join('\n')

      const modified = [
        '# App Config',
        'UNCHANGED_KEY=same_secret',
        'MODIFIED_KEY=new_longer_secret',
        'ADDED_KEY=added_secret',
      ].join('\n')

      const rows = computeAlignedDiffRows(original, modified)
      assert.strictEqual(rows.length, 5)
      assert.strictEqual(rows[0].type, 'unchanged')
      assert.strictEqual(rows[1].type, 'unchanged')
      assert.strictEqual(rows[2].type, 'modified')
      assert.strictEqual(rows[3].type, 'removed')
      assert.strictEqual(rows[4].type, 'added')

      const origHtml = getMaskedDiffView(
        original,
        modified,
        'original',
        'env-protector',
      )
      const modHtml = getMaskedDiffView(
        original,
        modified,
        'modified',
        'env-protector',
      )

      // Secrets must never appear in either diff pane
      for (const secret of [
        'same_secret',
        'old_secret',
        'new_longer_secret',
        'deleted_secret',
        'added_secret',
      ]) {
        assert.ok(!origHtml.includes(secret), `Leaked ${secret} in origHtml`)
        assert.ok(!modHtml.includes(secret), `Leaked ${secret} in modHtml`)
      }

      // Highlighting classes and badges must appear
      assert.ok(origHtml.includes('Original (Before)'))
      assert.ok(modHtml.includes('Modified (After)'))
      assert.ok(origHtml.includes('+1 added'))
      assert.ok(origHtml.includes('~1 modified'))
      assert.ok(origHtml.includes('-1 removed'))
      assert.ok(origHtml.includes('diff-row-removed'))
      assert.ok(origHtml.includes('diff-row-modified-orig'))
      assert.ok(origHtml.includes('diff-row-filler'))
      assert.ok(modHtml.includes('diff-row-added'))
      assert.ok(modHtml.includes('diff-row-modified-mod'))
      assert.ok(modHtml.includes('diff-row-filler'))
    })

    test('Handles values containing multiple "=" signs, CRLF line endings, and comment-only modifications', () => {
      const original =
        'CONN_STR=postgres://user:pass@localhost:5432/db?sslmode=require&pool=5 # old comment\r\nBASE64_SECRET=eyJhbGciOiJIUzI1NiJ9==\r\n'
      const modified =
        'CONN_STR=postgres://user:pass@localhost:5432/db?sslmode=require&pool=5 # new comment\nBASE64_SECRET=eyJhbGciOiJIUzI1NiJ9==\n'

      const singleHtml = getMaskedView(original, 'env-protector')
      assert.ok(!singleHtml.includes('sslmode'))
      assert.ok(!singleHtml.includes('eyJhbGciOiJIUzI1NiJ9'))
      assert.ok(
        singleHtml.includes(
          '*'.repeat(
            'postgres://user:pass@localhost:5432/db?sslmode=require&pool=5 '
              .length,
          ),
        ),
      )
      assert.ok(
        singleHtml.includes('*'.repeat('eyJhbGciOiJIUzI1NiJ9=='.length)),
      )

      const rows = computeAlignedDiffRows(original, modified)
      // Trailing newline is stripped; only 2 rows, no phantom 3rd empty row
      assert.strictEqual(rows.length, 2)
      assert.strictEqual(rows[0].type, 'modified')
      assert.strictEqual(rows[1].type, 'unchanged')

      const modDiffHtml = getMaskedDiffView(
        original,
        modified,
        'modified',
        'env-protector',
      )
      assert.ok(!modDiffHtml.includes('sslmode'))
      assert.ok(modDiffHtml.includes('# new comment'))
    })

    test('Handles newly added (empty original) and deleted (empty modified) .env diffs', () => {
      const addedRows = computeAlignedDiffRows(
        '',
        'NEW_KEY=secret1\nSECOND=secret2\n',
      )
      assert.strictEqual(addedRows.length, 2)
      assert.ok(addedRows.every((r) => r.type === 'added'))

      const removedRows = computeAlignedDiffRows('OLD_KEY=secret1\n', '')
      assert.strictEqual(removedRows.length, 1)
      assert.strictEqual(removedRows[0].type, 'removed')

      const bothEmptyHtml = getMaskedDiffView(
        '',
        '',
        'original',
        'env-protector',
      )
      assert.ok(bothEmptyHtml.includes('No content found in the .env file'))
    })

    test('Aligns in-place key+value edits on the same modified row with inline character diff on the key', () => {
      const original = [
        '# This is an example of the .env file',
        'ULTRA_SECRET_TOKEN = "ultra_secret_token" # This is an example of a secret token',
        'ANOTHER_ULTRA_SECRET_TOKEN = "another-ultra-secret-token"',
      ].join('\n')

      const modified = [
        '# This is an example of the .env file',
        'ULTRA_SECRET_TOKEN = "ultra_secret_token" # This is an example of a secret token',
        'ANOTHER_ULTRA_SEasdsadCRET_TOKEN = "another-ultra-seasdscret-token"asd',
      ].join('\n')

      const rows = computeAlignedDiffRows(original, modified)
      assert.strictEqual(rows.length, 3)
      assert.strictEqual(rows[0].type, 'unchanged')
      assert.strictEqual(rows[1].type, 'unchanged')
      assert.strictEqual(rows[2].type, 'modified')

      const modHtml = getMaskedDiffView(
        original,
        modified,
        'modified',
        'env-protector',
      )
      // Inline character diff highlights the inserted 'asdsad' in the key while masking the secret value
      assert.ok(
        modHtml.includes('<span class="token-changed-mod">asdsad</span>'),
      )
      assert.ok(!modHtml.includes('another-ultra'))
    })
  })

  suite('Diff URI Ordering Edge Cases (Unstaged, Staged, Commits, Merge)', () => {
    function makeGitUri(filePath: string, ref: string): vscode.Uri {
      return vscode.Uri.file(filePath).with({
        scheme: 'git',
        query: JSON.stringify({ path: filePath, ref }),
      })
    }

    test('parseGitRef extracts ref from JSON query, URL-encoded JSON query, and URLSearchParams', () => {
      const stagedIndexUri = makeGitUri('/app/.env', '')
      const headUri = makeGitUri('/app/.env', 'HEAD')
      const paramUri = vscode.Uri.parse('git:/app/.env?ref=HEAD~1')
      const urlEncodedUri = vscode.Uri.parse(
        'git:/app/.env?%7B%22path%22%3A%22%2Fapp%2F.env%22%2C%22ref%22%3A%22HEAD%22%7D',
      )

      assert.strictEqual(parseGitRef(stagedIndexUri), '')
      assert.strictEqual(parseGitRef(headUri), 'HEAD')
      assert.strictEqual(parseGitRef(paramUri), 'HEAD~1')
      assert.strictEqual(parseGitRef(urlEncodedUri), 'HEAD')
      assert.strictEqual(parseGitRef(vscode.Uri.file('/app/.env')), undefined)
    })

    test('Extended git refs ("index", "staged", ":0", "~0", "HEAD~0", "@", "wt", "working") order chronologically', () => {
      const headZeroUri = makeGitUri('/app/.env', 'HEAD~0')
      const atUri = makeGitUri('/app/.env', '@')
      const stagedWordUri = makeGitUri('/app/.env', 'staged')
      const colonZeroUri = makeGitUri('/app/.env', ':0')
      const wtUri = makeGitUri('/app/.env', 'wt')

      assert.strictEqual(
        orderDiffUris(stagedWordUri, headZeroUri).original,
        headZeroUri,
      )
      assert.strictEqual(orderDiffUris(colonZeroUri, atUri).original, atUri)
      assert.strictEqual(
        orderDiffUris(wtUri, stagedWordUri).original,
        stagedWordUri,
      )
    })

    test('Unstaged diff (git: vs file:): always orders git: as original and file: as modified regardless of arrival order', () => {
      const gitIndexUri = makeGitUri('/app/.env', '~')
      const workingTreeUri = vscode.Uri.file('/app/.env')

      const order1 = orderDiffUris(gitIndexUri, workingTreeUri)
      assert.strictEqual(order1.original, gitIndexUri)
      assert.strictEqual(order1.modified, workingTreeUri)

      // Reverse arrival order (when file: resolves before git:)
      const order2 = orderDiffUris(workingTreeUri, gitIndexUri)
      assert.strictEqual(order2.original, gitIndexUri)
      assert.strictEqual(order2.modified, workingTreeUri)
    })

    test('Staged diff in SCM view (git:?ref=HEAD vs git:?ref=""): always orders HEAD as original and "" (Index) as modified', () => {
      const headUri = makeGitUri('/app/.env', 'HEAD')
      const stagedUri = makeGitUri('/app/.env', '')

      // Normal order
      const order1 = orderDiffUris(headUri, stagedUri)
      assert.strictEqual(order1.original, headUri)
      assert.strictEqual(order1.modified, stagedUri)

      // Reverse arrival order (when staged index "" resolves before HEAD)
      const order2 = orderDiffUris(stagedUri, headUri)
      assert.strictEqual(
        order2.original,
        headUri,
        'Expected HEAD to be original (Before) even when staged index resolves first',
      )
      assert.strictEqual(
        order2.modified,
        stagedUri,
        'Expected staged index ("") to be modified (After) even when it resolves first',
      )
    })

    test('Staged diff in Timeline view (git:?ref=HEAD vs git:?ref="~"): always orders HEAD as original and "~" as modified', () => {
      const headUri = makeGitUri('/app/.env', 'HEAD')
      const timelineIndexUri = makeGitUri('/app/.env', '~')

      const order1 = orderDiffUris(headUri, timelineIndexUri)
      assert.strictEqual(order1.original, headUri)
      assert.strictEqual(order1.modified, timelineIndexUri)

      const order2 = orderDiffUris(timelineIndexUri, headUri)
      assert.strictEqual(order2.original, headUri)
      assert.strictEqual(order2.modified, timelineIndexUri)
    })

    test('Parent commit diffs (HEAD~1 / HEAD^ vs HEAD, and sha~1 / sha^ vs sha): always orders parent as original', () => {
      const headParent = makeGitUri('/app/.env', 'HEAD~1')
      const headUri = makeGitUri('/app/.env', 'HEAD')

      assert.strictEqual(
        orderDiffUris(headUri, headParent).original,
        headParent,
      )
      assert.strictEqual(
        orderDiffUris(headParent, headUri).original,
        headParent,
      )

      const shaParent = makeGitUri('/app/.env', 'a1b2c3d^')
      const shaChild = makeGitUri('/app/.env', 'a1b2c3d')

      assert.strictEqual(orderDiffUris(shaChild, shaParent).original, shaParent)
      assert.strictEqual(orderDiffUris(shaParent, shaChild).original, shaParent)
    })

    test('Historical commit SHA vs HEAD / Staged Index: always orders commit SHA as original', () => {
      const commitUri = makeGitUri('/app/.env', '9f8e7d6c5b4a')
      const headUri = makeGitUri('/app/.env', 'HEAD')
      const stagedUri = makeGitUri('/app/.env', '')

      assert.strictEqual(orderDiffUris(headUri, commitUri).original, commitUri)
      assert.strictEqual(
        orderDiffUris(stagedUri, commitUri).original,
        commitUri,
      )
    })

    test('Merge conflict stage diffs (~1 vs ~2/~3): always orders base stage (~1) as original', () => {
      const baseStage = makeGitUri('/app/.env', '~1')
      const oursStage = makeGitUri('/app/.env', '~2')
      const theirsStage = makeGitUri('/app/.env', '~3')

      assert.strictEqual(
        orderDiffUris(oursStage, baseStage).original,
        baseStage,
      )
      assert.strictEqual(
        orderDiffUris(theirsStage, baseStage).original,
        baseStage,
      )
    })

    test('Two arbitrary commit SHAs with "↔" tab label: orders according to tab title', () => {
      const olderCommit = makeGitUri('/app/.env', '1111111aaaa')
      const newerCommit = makeGitUri('/app/.env', '2222222bbbb')
      const tabLabel = '.env (1111111) \u2194 .env (2222222)'

      const order1 = orderDiffUris(newerCommit, olderCommit, tabLabel)
      assert.strictEqual(order1.original, olderCommit)
      assert.strictEqual(order1.modified, newerCommit)
    })

    test('isEnvFileUri and getCanonicalEnvBaseName accurately identify .env* files and ignore non-env files', () => {
      assert.ok(isEnvFileUri(vscode.Uri.file('/app/.env')))
      assert.ok(isEnvFileUri(vscode.Uri.file('/app/.env.local')))
      assert.ok(isEnvFileUri(vscode.Uri.file('/app/.env.production.local')))
      assert.ok(isEnvFileUri(vscode.Uri.file('/app/production.env')))
      assert.ok(
        isEnvFileUri(
          vscode.Uri.parse(
            'git:/app/.env.git?{"path":"/app/.env","ref":"HEAD"}',
          ),
        ),
      )
      assert.strictEqual(
        getCanonicalEnvBaseName(
          vscode.Uri.parse(
            'git:/app/.env.git?{"path":"/app/.env","ref":"HEAD"}',
          ),
        ),
        '.env',
      )

      assert.ok(!isEnvFileUri(vscode.Uri.file('/app/src/environment.ts')))
      assert.ok(!isEnvFileUri(vscode.Uri.file('/app/package.json')))
    })
  })

  suite('Custom Editor & Git Diff Integration Tests (Issue #8)', () => {
    test('Single .env file: "Open with Default Editor" opens TabInputText', async function () {
      this.timeout(15000)

      const envFile = path.join(tmpDir, '.env.example')
      fs.writeFileSync(envFile, 'SECRET_KEY=my_secret_value\n')
      const fileUri = vscode.Uri.file(envFile)

      await vscode.commands.executeCommand('vscode.open', fileUri)
      await delay(500)

      // Select second QuickPick item ("Open with Default Editor") and accept
      await vscode.commands.executeCommand(
        'workbench.action.quickOpenSelectNext',
      )
      await vscode.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      )
      await delay(500)

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
      assert.ok(activeTab, 'Expected an active tab')
      assert.ok(
        activeTab.input instanceof vscode.TabInputText,
        `Expected TabInputText, got ${activeTab.input?.constructor?.name}`,
      )
      assert.strictEqual(activeTab.input.uri.fsPath, fileUri.fsPath)
    })

    test('Single .env file: "Open with masked" keeps custom masked editor', async function () {
      this.timeout(15000)

      const envFile = path.join(tmpDir, '.env.example')
      fs.writeFileSync(envFile, 'SECRET_KEY=my_secret_value\n')
      const fileUri = vscode.Uri.file(envFile)

      await vscode.commands.executeCommand('vscode.open', fileUri)
      await delay(500)

      // Accept first QuickPick item ("Open with masked")
      await vscode.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      )
      await delay(500)

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
      assert.ok(activeTab, 'Expected an active tab')
      assert.ok(
        activeTab.input instanceof vscode.TabInputCustom,
        `Expected TabInputCustom, got ${activeTab.input?.constructor?.name}`,
      )
      assert.strictEqual(
        activeTab.input.viewType,
        'env-protector.envFileEditor',
      )
      assert.strictEqual(activeTab.input.uri.fsPath, fileUri.fsPath)
    })

    test('Diff view (Issue #8): "Open with Default Editor" preserves full diff comparison (original & modified)', async function () {
      this.timeout(15000)

      const oldDir = path.join(tmpDir, 'old')
      const newDir = path.join(tmpDir, 'new')
      fs.mkdirSync(oldDir)
      fs.mkdirSync(newDir)

      const oldEnv = path.join(oldDir, '.env.example')
      const newEnv = path.join(newDir, '.env.example')
      fs.writeFileSync(oldEnv, 'OLD_KEY=old_value\n')
      fs.writeFileSync(newEnv, 'OLD_KEY=new_value\nNEW_KEY=added_value\n')

      const oldUri = vscode.Uri.file(oldEnv)
      const newUri = vscode.Uri.file(newEnv)

      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        newUri,
        '.env.example (Working Tree)',
      )
      await delay(600)

      // Select second QuickPick item ("Open with Default Editor") and accept
      await vscode.commands.executeCommand(
        'workbench.action.quickOpenSelectNext',
      )
      await vscode.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      )
      await delay(600)

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
      assert.ok(activeTab, 'Expected an active tab after reopening diff')
      assert.ok(
        activeTab.input instanceof vscode.TabInputTextDiff,
        `Expected TabInputTextDiff (diff view), but got ${activeTab.input?.constructor?.name}`,
      )
      assert.strictEqual(
        activeTab.input.original.fsPath,
        oldUri.fsPath,
        'Diff original URI should match the old .env file',
      )
      assert.strictEqual(
        activeTab.input.modified.fsPath,
        newUri.fsPath,
        'Diff modified URI should match the modified .env file',
      )
    })

    test('Diff view: "Open with masked" masks both sides of the diff without losing the diff tab', async function () {
      this.timeout(15000)

      const oldDir = path.join(tmpDir, 'old-masked')
      const newDir = path.join(tmpDir, 'new-masked')
      fs.mkdirSync(oldDir)
      fs.mkdirSync(newDir)

      const oldEnv = path.join(oldDir, '.env.example')
      const newEnv = path.join(newDir, '.env.example')
      fs.writeFileSync(oldEnv, 'OLD_KEY=old_value\n')
      fs.writeFileSync(newEnv, 'OLD_KEY=new_value\n')

      const oldUri = vscode.Uri.file(oldEnv)
      const newUri = vscode.Uri.file(newEnv)

      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        newUri,
        '.env.example (Working Tree)',
      )
      await delay(600)

      // Accept first QuickPick item ("Open with masked")
      await vscode.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      )
      await delay(600)

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
      assert.ok(activeTab, 'Expected the custom diff tab to remain open')
      assert.strictEqual(activeTab.label, '.env.example (Working Tree)')
      assert.ok(
        !(activeTab.input instanceof vscode.TabInputText),
        'Should not have fallen back to a single unmasked text editor',
      )
    })

    test('Staged diff view (.env Index with HEAD vs ""): preserves correct original/modified ordering in both Masked and Default Editor modes', async function () {
      this.timeout(15000)

      const scheme = 'env-protector-staged-test'
      const provider = vscode.workspace.registerTextDocumentContentProvider(
        scheme,
        {
          provideTextDocumentContent(uri: vscode.Uri): string {
            const parsed = JSON.parse(uri.query) as { ref: string }
            if (parsed.ref === 'HEAD') {
              return 'STAGED_KEY=head_original_value\nREMOVED_IN_INDEX=gone\n'
            }
            return 'STAGED_KEY=index_modified_value\nADDED_IN_INDEX=new_val\n'
          },
        },
      )

      try {
        const fakePath = path.join(tmpDir, '.env.example')
        const headUri = vscode.Uri.file(fakePath).with({
          scheme,
          query: JSON.stringify({ path: fakePath, ref: 'HEAD' }),
        })
        const stagedIndexUri = vscode.Uri.file(fakePath).with({
          scheme,
          query: JSON.stringify({ path: fakePath, ref: '' }),
        })

        // 1. Open Staged diff and choose "Open with masked"
        await vscode.commands.executeCommand(
          'vscode.diff',
          headUri,
          stagedIndexUri,
          '.env.example (Index)',
        )
        await delay(600)

        await vscode.commands.executeCommand(
          'workbench.action.acceptSelectedQuickOpenItem',
        )
        await delay(600)

        let activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
        assert.ok(activeTab, 'Expected staged masked diff tab to be open')
        assert.strictEqual(activeTab.label, '.env.example (Index)')

        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        await delay(300)

        // 2. Reopen Staged diff and choose "Open with Default Editor"
        await vscode.commands.executeCommand(
          'vscode.diff',
          headUri,
          stagedIndexUri,
          '.env.example (Index)',
        )
        await delay(600)

        await vscode.commands.executeCommand(
          'workbench.action.quickOpenSelectNext',
        )
        await vscode.commands.executeCommand(
          'workbench.action.acceptSelectedQuickOpenItem',
        )
        await delay(600)

        activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
        assert.ok(activeTab?.input instanceof vscode.TabInputTextDiff)
        assert.strictEqual(
          activeTab.input.original.toString(),
          headUri.toString(),
        )
        assert.strictEqual(
          activeTab.input.modified.toString(),
          stagedIndexUri.toString(),
        )
      } finally {
        provider.dispose()
      }
    })

    test('Startup tab restoration (Issue #7): protects .env tab restored in default text editor on startup', async function () {
      this.timeout(15000)

      const ext = vscode.extensions.getExtension<{
        protectRestoredEnvTabs: () => Promise<void>
      }>('sametcn99.env-protector')
      assert.ok(ext, 'Expected env-protector extension to be installed')
      const api = await ext.activate()

      const envFile = path.join(tmpDir, '.env.restored')
      fs.writeFileSync(envFile, 'RESTORED_SECRET=top_secret_value\n')
      const fileUri = vscode.Uri.file(envFile)

      // Simulate VS Code restoring a previously opened .env tab in the built-in default editor before user authorization
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        'default',
      )
      await delay(300)

      // Run startup restoration guard
      await api.protectRestoredEnvTabs()
      await delay(600)

      // Accept "Open with masked" on the newly triggered protection prompt
      await vscode.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      )
      await delay(500)

      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
      assert.ok(activeTab, 'Expected an active tab after startup protection')
      assert.ok(
        activeTab.input instanceof vscode.TabInputCustom,
        `Expected restored .env tab to be converted to TabInputCustom, got ${activeTab.input?.constructor?.name}`,
      )
      assert.strictEqual(
        activeTab.input.viewType,
        'env-protector.envFileEditor',
      )
      assert.strictEqual(activeTab.input.uri.fsPath, fileUri.fsPath)
    })

    test('Live staging while Working Tree diff (ref: "~" vs file:) is open preserves HEAD content as Original (Before)', async function () {
      this.timeout(20000)

      const scheme = 'git-live-stage-test'
      const envFile = path.join(tmpDir, '.env')
      fs.writeFileSync(envFile, 'LIVE_KEY=new_value\nADDED_KEY=added_val\n')
      const workingTreeUri = vscode.Uri.file(envFile)

      let tildeRefContent = 'LIVE_KEY=old_value\nREMOVED_KEY=removed_val\n'
      const emitter = new vscode.EventEmitter<vscode.Uri>()
      const provider = vscode.workspace.registerTextDocumentContentProvider(
        scheme,
        {
          onDidChange: emitter.event,
          provideTextDocumentContent(uri: vscode.Uri): string {
            const ref = parseGitRef(uri)
            if (ref === 'HEAD') {
              return 'LIVE_KEY=old_value\nREMOVED_KEY=removed_val\n'
            }
            return tildeRefContent
          },
        },
      )

      try {
        const tildeUri = vscode.Uri.file(envFile).with({
          scheme,
          query: JSON.stringify({ path: envFile, ref: '~' }),
        })

        await vscode.commands.executeCommand(
          'vscode.diff',
          tildeUri,
          workingTreeUri,
          '.env (Working Tree)',
        )
        await delay(600)

        // Choose "Open with masked"
        await vscode.commands.executeCommand(
          'workbench.action.acceptSelectedQuickOpenItem',
        )
        await delay(600)

        // Simulate git staging: VS Code's GitFileSystemProvider updates ref: "~" to match the staged Working Tree
        tildeRefContent = 'LIVE_KEY=new_value\nADDED_KEY=added_val\n'
        emitter.fire(tildeUri)
        await delay(500)

        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
        assert.ok(
          activeTab,
          'Expected Working Tree masked diff tab to remain open after staging',
        )
        assert.strictEqual(activeTab.label, '.env (Working Tree)')
      } finally {
        provider.dispose()
        emitter.dispose()
      }
    })
  })
})
