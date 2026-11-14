import path from 'path'
import * as vscode from 'vscode'
import { name } from '.././package.json'
import { addEnvVariable } from './commands/add-env-variable'
import { editEnvVariable } from './commands/edit-env-variable'
import { hideEnvFiles } from './commands/hide-env-files'
import { maskEnvValues } from './commands/mask-env-values'
import { removeEnvVariable } from './commands/remove-env-variable'
import { showEnvFiles } from './commands/show-env-files'
import {
  getCanonicalEnvBaseName,
  getMaskedDiffView,
  getMaskedView,
  isEnvFileUri,
  orderDiffUris,
  parseGitRef,
} from './utils/get-masked-view'

interface PendingEditor {
  document: vscode.TextDocument
  webviewPanel: vscode.WebviewPanel
}

interface RecentResolution {
  baseName: string
  firstUri: string
  firstEditor: PendingEditor
  action: 'masked' | 'default'
  timestamp: number
}

const DIFF_PAIR_WINDOW_MS = 1500
const STARTUP_RESTORE_GUARD_MS = 3000

const authorizedDefaultUris = new Set<string>()
const panelSubscriptions = new Map<vscode.WebviewPanel, vscode.Disposable>()
const panelRenderGeneration = new Map<vscode.WebviewPanel, number>()
let isProtectingTabs = false

function nextPanelGeneration(panel: vscode.WebviewPanel): number {
  const prevSub = panelSubscriptions.get(panel)
  if (prevSub) {
    prevSub.dispose()
    panelSubscriptions.delete(panel)
  }
  const nextGen = (panelRenderGeneration.get(panel) ?? 0) + 1
  panelRenderGeneration.set(panel, nextGen)
  return nextGen
}

/**
 * Protects `.env*` tabs that VS Code restored from a previous session in the
 * built-in text or diff editor before/during startup without user confirmation
 * (Issue #7).
 */
export async function protectRestoredEnvTabs(): Promise<void> {
  if (isProtectingTabs) {
    return
  }
  isProtectingTabs = true
  try {
    const tabsToProtect: Array<{
      tab: vscode.Tab
      viewColumn: vscode.ViewColumn
    }> = []

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          isEnvFileUri(tab.input.uri) &&
          !authorizedDefaultUris.has(tab.input.uri.toString())
        ) {
          tabsToProtect.push({ tab, viewColumn: group.viewColumn })
        } else if (
          tab.input instanceof vscode.TabInputTextDiff &&
          (isEnvFileUri(tab.input.original) ||
            isEnvFileUri(tab.input.modified)) &&
          !authorizedDefaultUris.has(tab.input.original.toString()) &&
          !authorizedDefaultUris.has(tab.input.modified.toString())
        ) {
          tabsToProtect.push({ tab, viewColumn: group.viewColumn })
        }
      }
    }

    for (const { tab, viewColumn } of tabsToProtect) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri
        await vscode.window.tabGroups.close(tab)
        await vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          `${name}.envFileEditor`,
          viewColumn,
        )
      } else if (tab.input instanceof vscode.TabInputTextDiff) {
        const { original, modified } = tab.input
        const label = tab.label
        await vscode.window.tabGroups.close(tab)
        await vscode.commands.executeCommand(
          'vscode.diff',
          original,
          modified,
          label,
        )
      }
    }
  } finally {
    isProtectingTabs = false
  }
}

function getWebviewCustomClasses(
  panel: vscode.WebviewPanel,
): string | undefined {
  const opts = panel.options as { customClasses?: string } | undefined
  return typeof opts?.customClasses === 'string'
    ? opts.customClasses
    : undefined
}

function orderDiffEditors(
  first: PendingEditor,
  second: PendingEditor,
): { original: PendingEditor; modified: PendingEditor } {
  const firstClass = getWebviewCustomClasses(first.webviewPanel)
  const secondClass = getWebviewCustomClasses(second.webviewPanel)
  if (firstClass === 'original' && secondClass === 'modified') {
    return { original: first, modified: second }
  }
  if (firstClass === 'modified' && secondClass === 'original') {
    return { original: second, modified: first }
  }

  const tabLabel = vscode.window.tabGroups.activeTabGroup.activeTab?.label
  const orderedUris = orderDiffUris(
    first.document.uri,
    second.document.uri,
    tabLabel,
  )
  return orderedUris.original.toString() === first.document.uri.toString()
    ? { original: first, modified: second }
    : { original: second, modified: first }
}

async function tryReadHeadText(uri: vscode.Uri): Promise<string | undefined> {
  if (!uri.query) {
    return undefined
  }
  try {
    const parsed = JSON.parse(uri.query) as {
      path?: string
      ref?: string
      submoduleOf?: string
    }
    if (typeof parsed.path !== 'string') {
      return undefined
    }
    const headUri = uri.with({
      query: JSON.stringify({ ...parsed, ref: 'HEAD' }),
    })
    const bytes = await vscode.workspace.fs.readFile(headUri)
    return Buffer.from(bytes).toString('utf-8')
  } catch {
    return undefined
  }
}

function renderDiffPair(first: PendingEditor, second: PendingEditor): void {
  const { original, modified } = orderDiffEditors(first, second)
  const origGen = nextPanelGeneration(original.webviewPanel)
  const modGen = nextPanelGeneration(modified.webviewPanel)

  const isTildeWorkingTreeDiff =
    parseGitRef(original.document.uri) === '~' &&
    modified.document.uri.scheme === 'file'

  let cachedOriginalText = original.document.getText()

  const applyHtml = (origText: string, modText: string) => {
    if (
      panelRenderGeneration.get(original.webviewPanel) !== origGen ||
      panelRenderGeneration.get(modified.webviewPanel) !== modGen
    ) {
      return
    }
    original.webviewPanel.webview.html = getMaskedDiffView(
      origText,
      modText,
      'original',
      name,
    )
    modified.webviewPanel.webview.html = getMaskedDiffView(
      origText,
      modText,
      'modified',
      name,
    )
  }

  const updateViews = async () => {
    let origText = original.document.getText()
    const modText = modified.document.getText()

    // When a file is staged while its Working Tree (`ref: "~"`) diff tab is open,
    // VS Code's GitFileSystemProvider switches `ref: "~"` from HEAD to the staged index,
    // which would otherwise overwrite Original (Before) with Modified (After).
    if (isTildeWorkingTreeDiff) {
      if (origText !== modText && origText.length > 0) {
        cachedOriginalText = origText
      } else if (origText === modText) {
        const headText = await tryReadHeadText(original.document.uri)
        if (headText !== undefined && headText !== modText) {
          origText = headText
          cachedOriginalText = headText
        } else if (
          cachedOriginalText.length > 0 &&
          cachedOriginalText !== modText
        ) {
          origText = cachedOriginalText
        }
      }
    }

    applyHtml(origText, modText)
  }

  // Render synchronously first for instant responsiveness, then resolve async fallback if needed
  applyHtml(cachedOriginalText, modified.document.getText())
  void updateViews()

  const docChangeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (
      event.document.uri.toString() === original.document.uri.toString() ||
      event.document.uri.toString() === modified.document.uri.toString()
    ) {
      void updateViews()
    }
  })

  const combinedDisposable = new vscode.Disposable(() => {
    docChangeSub.dispose()
  })
  panelSubscriptions.set(original.webviewPanel, combinedDisposable)
  panelSubscriptions.set(modified.webviewPanel, combinedDisposable)

  original.webviewPanel.onDidDispose(() => {
    combinedDisposable.dispose()
    panelSubscriptions.delete(original.webviewPanel)
    panelRenderGeneration.delete(original.webviewPanel)
  })
  modified.webviewPanel.onDidDispose(() => {
    combinedDisposable.dispose()
    panelSubscriptions.delete(modified.webviewPanel)
    panelRenderGeneration.delete(modified.webviewPanel)
  })
}

async function renderSingleEditor(target: PendingEditor): Promise<void> {
  const gen = nextPanelGeneration(target.webviewPanel)

  const renderSingle = async () => {
    let text = target.document.getText()
    if (text.length === 0) {
      try {
        const raw = await vscode.workspace.fs.readFile(target.document.uri)
        text = Buffer.from(raw).toString('utf-8')
      } catch {
        text = target.document.getText()
      }
    }
    if (panelRenderGeneration.get(target.webviewPanel) !== gen) {
      return
    }
    target.webviewPanel.webview.html = getMaskedView(text, name)
  }

  await renderSingle()
  if (panelRenderGeneration.get(target.webviewPanel) !== gen) {
    return
  }

  const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (
      panelRenderGeneration.get(target.webviewPanel) === gen &&
      e.document.uri.toString() === target.document.uri.toString()
    ) {
      target.webviewPanel.webview.html = getMaskedView(
        e.document.getText(),
        name,
      )
    }
  })

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      path.dirname(target.document.uri.fsPath),
      path.basename(target.document.uri.fsPath),
    ),
  )
  watcher.onDidChange(() => {
    if (panelRenderGeneration.get(target.webviewPanel) === gen) {
      void renderSingle()
    }
  })

  const sub = new vscode.Disposable(() => {
    docSub.dispose()
    watcher.dispose()
  })
  panelSubscriptions.set(target.webviewPanel, sub)

  target.webviewPanel.onDidDispose(() => {
    sub.dispose()
    panelSubscriptions.delete(target.webviewPanel)
    panelRenderGeneration.delete(target.webviewPanel)
  })
}

/**
 * This method is called when your extension is activated
 * Your extension is activated the very first time the command is executed
 */
export function activate(context: vscode.ExtensionContext) {
  console.log(`${name} is now active!`)

  let pendingEditors: PendingEditor[] = []
  let activeQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined
  let quickPickDisposables: vscode.Disposable[] = []
  let recentResolution: RecentResolution | undefined

  // Register the custom editor provider for the .env files
  const customEditorProvider = vscode.window.registerCustomEditorProvider(
    `${name}.envFileEditor`,
    {
      async resolveCustomTextEditor(document, webviewPanel) {
        const baseName = getCanonicalEnvBaseName(document.uri)
        const now = Date.now()

        // If the second side of a diff editor resolves shortly after the user
        // already answered the QuickPick for the first side, apply the same choice.
        if (
          recentResolution &&
          now - recentResolution.timestamp < DIFF_PAIR_WINDOW_MS &&
          recentResolution.baseName === baseName &&
          recentResolution.firstUri !== document.uri.toString()
        ) {
          const { action, firstEditor } = recentResolution
          recentResolution = undefined
          if (action === 'masked') {
            renderDiffPair(firstEditor, { document, webviewPanel })
          } else {
            authorizedDefaultUris.add(document.uri.toString())
          }
          return
        }

        const entry: PendingEditor = { document, webviewPanel }
        pendingEditors.push(entry)

        quickPickDisposables.push(
          webviewPanel.onDidDispose(() => {
            pendingEditors = pendingEditors.filter((item) => item !== entry)
            if (pendingEditors.length === 0 && activeQuickPick) {
              activeQuickPick.hide()
            }
          }),
        )

        // When opening a diff view, VS Code resolves both the modified and
        // original documents in quick succession. Reuse the active QuickPick
        // instead of opening a second one that overwrites the first.
        if (activeQuickPick) {
          return
        }

        const options: vscode.QuickPickItem[] = [
          {
            label: 'Open with masked',
            description: 'Mask environment values before opening the file',
          },
          {
            label: 'Open with Default Editor',
            description: 'Open file with built in editor',
          },
        ]

        const quickPick = vscode.window.createQuickPick()
        activeQuickPick = quickPick
        quickPick.items = options.map((option) => ({
          label: option.label,
          description: option.description,
        }))
        quickPick.title = 'Before opening .env file'
        quickPick.placeholder = 'Choose an action to perform:'
        quickPick.ignoreFocusOut = true
        quickPick.canSelectMany = false

        // Close quick pick if the user switched to another text editor
        quickPickDisposables.push(
          vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
              quickPick.hide()
            }
          }),
        )

        quickPick.onDidAccept(async () => {
          const selectedItem = quickPick.selectedItems[0]
          const editorsToResolve = [...pendingEditors]
          pendingEditors = []

          const isDefault = selectedItem?.label === 'Open with Default Editor'

          if (editorsToResolve.length === 1) {
            recentResolution = {
              baseName: getCanonicalEnvBaseName(
                editorsToResolve[0].document.uri,
              ),
              firstUri: editorsToResolve[0].document.uri.toString(),
              firstEditor: editorsToResolve[0],
              action: isDefault ? 'default' : 'masked',
              timestamp: Date.now(),
            }
          } else {
            recentResolution = undefined
          }

          quickPick.hide()

          if (isDefault) {
            for (const target of editorsToResolve) {
              authorizedDefaultUris.add(target.document.uri.toString())
            }

            // Reopen the active editor (works for both single custom editors and diff editors)
            await vscode.commands.executeCommand(
              'workbench.action.reopenTextEditor',
            )

            // Fallback if a single custom editor tab was not replaced by reopenTextEditor
            const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
            if (
              editorsToResolve.length === 1 &&
              activeTab?.input instanceof vscode.TabInputCustom
            ) {
              const target = editorsToResolve[0]
              await vscode.commands.executeCommand(
                'vscode.openWith',
                target.document.uri,
                'default',
              )
              target.webviewPanel.dispose()
            }
          } else if (editorsToResolve.length === 2) {
            renderDiffPair(editorsToResolve[0], editorsToResolve[1])
          } else {
            // Pair any diff editors sharing the same canonical baseName from newest to oldest
            const used = new Set<number>()
            for (let i = editorsToResolve.length - 1; i >= 1; i--) {
              if (used.has(i)) {
                continue
              }
              const e1 = editorsToResolve[i]
              const b1 = getCanonicalEnvBaseName(e1.document.uri)
              for (let j = i - 1; j >= 0; j--) {
                if (used.has(j)) {
                  continue
                }
                const e2 = editorsToResolve[j]
                if (
                  getCanonicalEnvBaseName(e2.document.uri) === b1 &&
                  e1.document.uri.toString() !== e2.document.uri.toString()
                ) {
                  used.add(i)
                  used.add(j)
                  renderDiffPair(e2, e1)
                  break
                }
              }
            }
            for (let idx = 0; idx < editorsToResolve.length; idx++) {
              if (!used.has(idx)) {
                await renderSingleEditor(editorsToResolve[idx])
              }
            }
          }
        })

        quickPick.onDidHide(() => {
          if (activeQuickPick === quickPick) {
            activeQuickPick = undefined
          }
          pendingEditors = []
          const toDispose = quickPickDisposables
          quickPickDisposables = []
          toDispose.forEach((disposable) => disposable.dispose())
          quickPick.dispose()
        })

        quickPick.show()
      },
    },
  )

  // When an authorized default-editor tab is closed, remove its authorization
  // so reopening it later requires confirmation again.
  const tabCloseSubscription = vscode.window.tabGroups.onDidChangeTabs(
    (event) => {
      for (const closedTab of event.closed) {
        if (closedTab.input instanceof vscode.TabInputText) {
          authorizedDefaultUris.delete(closedTab.input.uri.toString())
        } else if (closedTab.input instanceof vscode.TabInputTextDiff) {
          authorizedDefaultUris.delete(closedTab.input.original.toString())
          authorizedDefaultUris.delete(closedTab.input.modified.toString())
        }
      }
    },
  )

  // Issue #7: Protect any .env tabs restored by VS Code from a previous session
  const activationTime = Date.now()
  void protectRestoredEnvTabs()
  const startupTabRestoreGuard = vscode.window.tabGroups.onDidChangeTabs(
    (event) => {
      if (Date.now() - activationTime > STARTUP_RESTORE_GUARD_MS) {
        startupTabRestoreGuard.dispose()
        return
      }
      if (event.opened.length > 0) {
        void protectRestoredEnvTabs()
      }
    },
  )

  context.subscriptions.push(
    customEditorProvider,
    tabCloseSubscription,
    startupTabRestoreGuard,
    showEnvFiles,
    maskEnvValues,
    hideEnvFiles,
    addEnvVariable,
    editEnvVariable,
    removeEnvVariable,
  )

  return {
    protectRestoredEnvTabs,
  }
}

/**
 * This method is called when your extension is deactivated
 */
export function deactivate() {
  console.log('Deactivated')
}
