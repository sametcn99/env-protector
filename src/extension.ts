import * as vscode from 'vscode'
import { getMaskedView } from './utils/get-masked-view'
import { name } from '.././package.json'

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

      // Close quick pick if the user opens another file
      disposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
          vscode.window.showInformationMessage(
            'Action cancelled because opened another file',
          )
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

  /**
   * COMMANDS
   * commands has been defined in the package.json file
   * Now provide the implementation of the command with registerCommand
   * The commandId parameter must match the command field in package.json
   */

  /**
   * hides the .env files in the workspace using files.exclude setting
   */
  const hideEnvFiles = vscode.commands.registerCommand(
    `${name}.hide-env-files`,
    () => {
      // get the workspace path
      const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath
      if (!workspacePath) {
        return vscode.window.showErrorMessage('No workspace found')
      }

      // hide the .env files using files.exclude
      const filesConfig = vscode.workspace.getConfiguration('files')
      const exclude = filesConfig.get('exclude') as Record<string, boolean>
      const newExclude = {
        ...exclude,
        '**/.env*': true,
      }
      filesConfig.update('exclude', newExclude)

      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage('Hidden environment files')
    },
  )

  /**
   * shows the .env files in the workspace using files.exclude setting
   */
  const showEnvFiles = vscode.commands.registerCommand(
    `${name}.show-env-files`,
    () => {
      // get the workspace path
      const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath
      if (!workspacePath) {
        return vscode.window.showErrorMessage('No workspace found')
      }

      // hide the .env files using files.exclude
      const filesConfig = vscode.workspace.getConfiguration('files')
      const exclude = filesConfig.get('exclude') as Record<string, boolean>
      // remove **/.env* from the exclude object
      const newExclude = { ...exclude }
      delete newExclude['**/.env*']

      filesConfig.update('exclude', newExclude)

      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage('Shown environment files')
    },
  )

  /**
   * masks the values in the .env file and open in a new webview
   */
  const maskEnvValues = vscode.commands.registerCommand(
    `${name}.mask-env-values`,
    () => {
      // Get the active text editor
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        return vscode.window.showErrorMessage('No active editor found')
      }

      // Get the document and its content
      const document = editor.document
      if (document.languageId !== 'dotenv') {
        return vscode.window.showErrorMessage('Not a .env file')
      }
      const text = document.getText()

      vscode.window.createWebviewPanel(
        `${name}.maskedEnvValues`,
        'Masked .env Values',
        vscode.ViewColumn.One,
      ).webview.html = getMaskedView(text, name)
    },
  )

  // This line of code will only be executed once when your extension is activated
  context.subscriptions.push(showEnvFiles, maskEnvValues, hideEnvFiles)
}

/**
 * This method is called when your extension is deactivated
 */
export function deactivate() {
  console.log('Deactivated')
}
