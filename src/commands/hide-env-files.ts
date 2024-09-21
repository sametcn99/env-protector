import * as vscode from 'vscode'
import { name } from '.././../package.json'
/**
 * hides the .env files in the workspace using files.exclude setting
 */
export const hideEnvFiles = vscode.commands.registerCommand(
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
