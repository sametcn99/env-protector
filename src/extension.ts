// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { readFileSync } from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { getMaskedView } from './utils/get-masked-view'

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const packageJson = JSON.parse(
    readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8'),
  )
  const extensionName = packageJson.name

  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(`${extensionName} is now active!`)

  // Register the custom editor provider for the .env files
  vscode.window.registerCustomEditorProvider(`${extensionName}.envFileEditor`, {
    async resolveCustomTextEditor(document, webviewPanel) {
      const selection = await vscode.window.showQuickPick(['Yes', 'No'], {
        title: 'View .env file',
        placeHolder: 'Do you really want to open the .env file?',
      })

      if (selection === 'Yes') {
        // Reopen the document in the default text editor without asking
        await vscode.commands.executeCommand(
          'vscode.openWith',
          document.uri,
          'default',
        )
        webviewPanel.dispose()
        return
      }
      const text = document.getText()
      webviewPanel.webview.html = getMaskedView(text, extensionName)
    },
  })

  /**
   * COMMANDS
   * commands has been defined in the package.json file
   * Now provide the implementation of the command with registerCommand
   * The commandId parameter must match the command field in package.json
   */

  // hides the .env files in the workspace using files.exclude setting
  const hideEnvFiles = vscode.commands.registerCommand(
    `${extensionName}.hide-env-files`,
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

  // shows the .env files in the workspace using files.exclude setting
  const showEnvFiles = vscode.commands.registerCommand(
    `${extensionName}.show-env-files`,
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

  // masks the values in the .env file and open in a new webview
  const maskEnvValues = vscode.commands.registerCommand(
    `${extensionName}.mask-env-values`,
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
        `${extensionName}.maskedEnvValues`,
        'Masked .env Values',
        vscode.ViewColumn.One,
      ).webview.html = getMaskedView(text, extensionName)
    },
  )

  // This line of code will only be executed once when your extension is activated
  context.subscriptions.push(showEnvFiles)
  context.subscriptions.push(hideEnvFiles)
  context.subscriptions.push(maskEnvValues)
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('Deactivated')
}
