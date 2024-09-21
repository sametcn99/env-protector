import * as vscode from 'vscode'
import { name } from '.././../package.json'

/**
 * shows the .env files in the workspace using files.exclude setting
 */
export const showEnvFiles = vscode.commands.registerCommand(
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
