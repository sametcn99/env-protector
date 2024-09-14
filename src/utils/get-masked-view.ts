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
export function getMaskedView(text: string, name: string) {
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

  if (text.length > 0) {
    const keys = text.split('\n')
    const p = htmlDocument.createElement('p')
    p.textContent = `${keys.length} key${keys.length > 0 ? 's' : ''} found in the .env file`
    pre.appendChild(p)
    keys.forEach((line) => {
      const code = htmlDocument.createElement('code')
      const [key, value] = line.split('=')
      code.textContent = value ? `${key}=${'*'.repeat(value.length)}` : line
      pre.appendChild(code)
      pre.appendChild(htmlDocument.createElement('br'))
    })
  } else {
    const code = htmlDocument.createElement('code')
    code.textContent = 'No content found in the .env file'
    pre.appendChild(code)
  }

  htmlDocument.body.appendChild(p)
  htmlDocument.body.appendChild(pre)

  return htmlDocument.documentElement.outerHTML
}
