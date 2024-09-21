import * as vscode from 'vscode'
import { name } from '.././../package.json'
import fs from 'fs'

export const removeEnvVariable = vscode.commands.registerCommand(
  `${name}.remove-env-variable`,
  async () => {
    // Get env files in the workspace using glob pattern
    const envFiles = await vscode.workspace.findFiles('**/*.env*')
    if (!envFiles.length) {
      return vscode.window.showErrorMessage(
        'No .env file found in the workspace',
      )
    }

    // Prompt the user to select an env file
    const quickPick = vscode.window.createQuickPick()
    quickPick.items = envFiles.map((file) => ({ label: file.fsPath }))
    quickPick.title = 'Select an .env file'
    quickPick.placeholder = 'Select an .env file to remove variables'
    quickPick.ignoreFocusOut = true
    quickPick.canSelectMany = false
    quickPick.show()

    quickPick.onDidAccept(async () => {
      const selectedItem = quickPick.selectedItems[0]
      if (!selectedItem) {
        return vscode.window.showErrorMessage('No file selected')
      }
      quickPick.hide()

      // Get the selected file and open it
      const fileUri = vscode.Uri.file(selectedItem.label)

      // Read the file content
      const fileContent = fs.readFileSync(fileUri.fsPath, 'utf-8')
      const lines = fileContent.split('\n')

      // Extract variables from the file
      const variables = lines
        .filter((line) => line.includes('='))
        .map((line) => line.split('=')[0])

      if (!variables.length) {
        return vscode.window.showErrorMessage(
          `No variables found in ${fileUri.fsPath}`,
        )
      }

      // Prompt the user to select variables to remove
      const variableQuickPick = vscode.window.createQuickPick()
      variableQuickPick.items = variables.map((variable) => ({
        label: variable,
      }))
      variableQuickPick.title = 'Select variables to remove'
      variableQuickPick.placeholder = 'Select variables to remove'
      variableQuickPick.ignoreFocusOut = true
      variableQuickPick.canSelectMany = true // Allow multiple selection
      variableQuickPick.show()

      variableQuickPick.onDidAccept(async () => {
        const selectedVariables = variableQuickPick.selectedItems
        if (!selectedVariables.length) {
          return vscode.window.showErrorMessage('No variables selected')
        }
        variableQuickPick.hide()

        // Remove selected variables from the file content
        const selectedVariableNames = selectedVariables.map(
          (item) => item.label,
        )
        const newLines = lines.filter((line) => {
          const variableName = line.split('=')[0]
          return !selectedVariableNames.includes(variableName)
        })

        // Write the updated content back to the file
        fs.writeFileSync(fileUri.fsPath, newLines.join('\n'))
        vscode.window.showInformationMessage(
          `Removed selected variables from ${fileUri.fsPath}`,
        )
      })
    })
  },
)
