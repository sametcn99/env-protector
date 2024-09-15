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

  const lines = text.split('\n')
  for (const line of lines) {
    const trimmedLine = line.trim()
    if (trimmedLine.startsWith('#') || trimmedLine.length === 0) {
      const p = htmlDocument.createElement('p')
      p.textContent = line
      pre.appendChild(p)
    } else {
      // Yorum varsa, ayırmak için # işaretini kullan
      const [keyValuePart, commentPart] = line.split('#')
      // Key ve value'yu ayırmak için = işaretini kullan
      const [key, value] = keyValuePart.split('=')
      const code = htmlDocument.createElement('code')
      // Key ve value'yu maskeli olarak ekle
      code.textContent = `${key}=${value.replace(/./g, '*')}`
      // Comment varsa, comment kısmını ekle
      if (commentPart) {
        const span = htmlDocument.createElement('span')
        span.textContent = ` #${commentPart}`
        code.appendChild(span)
      }
      pre.appendChild(code)
    }
  }
  htmlDocument.body.appendChild(p)
  htmlDocument.body.appendChild(pre)
  return htmlDocument.documentElement.outerHTML
}
