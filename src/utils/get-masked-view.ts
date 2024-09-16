import { JSDOM } from 'jsdom'

/**
 * Generates an HTML view with masked values from a given text and a name.
 *
 * @param text - The input text containing key-value pairs, typically from a .env file.
 * @param name - The name to be displayed in the generated HTML.
 * @returns The generated HTML string with masked values.
 *
 * The function creates an HTML document with a paragraph indicating the values are masked,
 * followed by a preformatted block containing the masked key-value pairs. If the input text
 * is empty, it indicates that no content was found in the .env file.
 */
export function getMaskedView(text: string, name: string): string {
  const dom = new JSDOM()
  const htmlDocument = dom.window.document
  const p = htmlDocument.createElement('p')

  const a = htmlDocument.createElement('a')
  a.textContent = name
  a.href = 'https://sametcc.me/env-protector'

  p.appendChild(htmlDocument.createTextNode('Values masked by '))
  p.appendChild(a)
  p.appendChild(
    htmlDocument.createTextNode(
      '. Here are the masked values in the .env file',
    ),
  )

  const pre = htmlDocument.createElement('pre')

  if (text.length === 0) {
    const code = htmlDocument.createElement('code')
    code.textContent = 'No content found in the .env file'
    pre.appendChild(code)
    htmlDocument.body.appendChild(p)
    htmlDocument.body.appendChild(pre)
    return htmlDocument.documentElement.outerHTML
  }

  let keyCount: number = 0

  const lines = text.split('\n')
  for (const line of lines) {
    const trimmedLine = line.trim()
    const singleLineComment = htmlDocument.createElement('span')
    if (trimmedLine.startsWith('#') || trimmedLine.length === 0) {
      singleLineComment.textContent = line
      singleLineComment.style.color = 'gray'
      pre.appendChild(singleLineComment)
    } else {
      const [keyValuePart, commentPart] = line.split('#')
      const [key, value] = keyValuePart.split('=')

      const keySpan = htmlDocument.createElement('span')
      keySpan.style.fontWeight = 'bold'
      keySpan.textContent = key

      const equalSignSpan = htmlDocument.createElement('span')
      equalSignSpan.textContent = '='

      const valueSpan = htmlDocument.createElement('span')
      valueSpan.textContent = value.replace(/./g, '*')
      valueSpan.textContent = ' ' + valueSpan.textContent

      const lineDiv = htmlDocument.createElement('div')
      lineDiv.appendChild(keySpan)
      lineDiv.appendChild(equalSignSpan)
      lineDiv.appendChild(valueSpan)
      
      if (commentPart) {
        const commentSpan = htmlDocument.createElement('span')
        commentSpan.textContent = ` #${commentPart}`
        commentSpan.style.color = 'gray'
        lineDiv.appendChild(commentSpan)
      }

      pre.appendChild(lineDiv)
      keyCount++
    }
  }
  const br = htmlDocument.createElement('br')
  p.appendChild(br)
  const span = htmlDocument.createElement('i')
  span.style.fontStyle = 'italic'
  span.textContent = `${keyCount} masked key-value pairs in the .env file`
  p.appendChild(span)
  htmlDocument.body.appendChild(p)
  htmlDocument.body.appendChild(pre)
  return htmlDocument.documentElement.outerHTML
}
