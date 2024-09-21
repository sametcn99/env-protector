import * as vscode from 'vscode'
import { name } from '.././../package.json'
import fs from 'fs'

export const addEnvVariable = vscode.commands.registerCommand(
  `${name}.add-env-variable`,
  async () => {
    // Get env files in the workspace using glob pattern
    const envFiles = await vscode.workspace.findFiles('**/*.env*')
    if (!envFiles.length) {
      // If no env files found, show a dialog to create a new env file
      const createEnvFile = await vscode.window.showInformationMessage(
        'No .env file found in the workspace. Do you want to create a new one?',
        'Yes',
        'No',
      )
      if (createEnvFile === 'Yes') {
        // Create a new env file
        const newEnvFile = vscode.Uri.file('.env')
        fs.writeFileSync(newEnvFile.fsPath, '')
        return vscode.window.showInformationMessage('Created a new .env file')
      }
      return vscode.window.showErrorMessage(
        'No .env file found in the workspace',
      )
    }

    // Prompt the user to select an env file
    const quickPick = vscode.window.createQuickPick()
    quickPick.items = envFiles.map((file) => ({ label: file.fsPath }))
    quickPick.title = 'Select an .env file'
    quickPick.placeholder = 'Select an .env file to add a variable'
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

      // Prompt user to enter the variable name
      const variableName = await vscode.window.showInputBox({
        prompt: 'Enter the variable name',
        ignoreFocusOut: true,
      })
      if (!variableName) {
        return vscode.window.showErrorMessage('No variable name entered')
      }

      // Prompt user to enter the variable value
      const variableValue = await vscode.window.showInputBox({
        prompt: 'Enter the variable value',
        ignoreFocusOut: true,
        password: true, // Mask the input
      })
      if (!variableValue) {
        return vscode.window.showErrorMessage('No variable value entered')
      }

      // Prompt user to add a comment line for the variable
      const comment = await vscode.window.showInputBox({
        prompt: 'Enter a comment for the variable',
        ignoreFocusOut: true,
        placeHolder: "Leave empty if you don't want to add comment.",
      })

      // Write the variable to the file
      const text = `${variableName}=${variableValue} ${comment ? `# ${comment}` : ''}\n`
      const fileContent = fs.readFileSync(fileUri.fsPath, 'utf-8')

      fileContent.split('\n').forEach((line) => {
        if (line.trim().startsWith(variableName)) {
          return vscode.window.showErrorMessage(
            `Variable ${variableName} already exists in ${fileUri.fsPath}`,
          )
        }
      })

      // If the content's last line is not empty, add a new line
      if (fileContent.trim().slice(-1) !== '') {
        fs.appendFileSync(fileUri.fsPath, '\n')
      }

      // Write the variable to the file
      fs.appendFileSync(fileUri.fsPath, text)
      vscode.window.showInformationMessage(
        `Added ${variableName} to ${fileUri.fsPath}`,
      )
    })
  },
)
