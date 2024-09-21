import * as vscode from 'vscode'
import { name } from '.././../package.json'
import { getMaskedView } from '../utils/get-masked-view'

/**
 * masks the values in the .env file and open in a new webview
 */
export const maskEnvValues = vscode.commands.registerCommand(
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
