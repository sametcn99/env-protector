import * as vscode from 'vscode'
import { getMaskedView } from './utils/get-masked-view'
import { name } from '.././package.json'
import fs from 'fs'
import { addEnvVariable } from './commands/add-env-variable'
import { maskEnvValues } from './commands/mask-env-values'
import { showEnvFiles } from './commands/show-env-files'
import { hideEnvFiles } from './commands/hide-env-files'
import { removeEnvVariable } from './commands/remove-env-variable'

/**
 * This method is called when your extension is activated
 * Your extension is activated the very first time the command is executed
 */
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(`${name} is now active!`)

  // Register the custom editor provider for the .env files
  vscode.window.registerCustomEditorProvider(`${name}.envFileEditor`, {
    async resolveCustomTextEditor(document, webviewPanel) {
      /**
       * Selection options for the user to choose from
       */
      const options: vscode.QuickPickItem[] = [
        {
          label: 'Open with masked',
          description: 'Mask environment values before opening the file',
        },
        {
          label: 'Open Anyway',
          description: 'Open file with built in editor',
        },
      ]

      const quickPick = vscode.window.createQuickPick()
      quickPick.items = options.map((option) => ({
        label: option.label,
        description: option.description,
      }))
      quickPick.title = 'Before opening .env file'
      quickPick.placeholder = 'Choose an action to perform:'
      quickPick.ignoreFocusOut = true
      quickPick.canSelectMany = false

      const disposables: vscode.Disposable[] = []

      // Close quick pick if the opened another file
      disposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
          quickPick.hide()
        }),
      )

      quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0]
        if (selectedItem?.label === 'Open Anyway') {
          // Reopen the document in the default text editor without asking
          await vscode.commands.executeCommand(
            'vscode.openWith',
            document.uri,
            'default',
          )
          webviewPanel.dispose()
        } else {
          const text = document.getText()
          webviewPanel.webview.html = getMaskedView(text, name)
        }
        quickPick.hide()
        disposables.forEach((disposable) => disposable.dispose())
      })

      quickPick.onDidHide(() => {
        disposables.forEach((disposable) => disposable.dispose())
        quickPick.dispose()
      })

      quickPick.show()
    },
  })

  // This line of code will only be executed once when your extension is activated
  context.subscriptions.push(
    showEnvFiles,
    maskEnvValues,
    hideEnvFiles,
    addEnvVariable,
    removeEnvVariable,
  )
}

/**
 * This method is called when your extension is deactivated
 */
export function deactivate() {
  console.log('Deactivated')
}
