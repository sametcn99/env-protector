import { JSDOM } from 'jsdom'

export function getMaskedView(text: string, extensionName: string) {
  const dom = new JSDOM()
  const htmlDocument = dom.window.document
  const p = htmlDocument.createElement('p')

  const a = htmlDocument.createElement('a')
  a.textContent = extensionName
  a.href = 'https://sametcc.me/env-protector'

  p.appendChild(htmlDocument.createTextNode('Values masked by '))
  p.appendChild(a)
  p.appendChild(
    htmlDocument.createTextNode(
      '. Here are the masked values in the .env file',
    ),
  )

  // Her anahtar-değer çiftini ayrı bir code elementinde göstermek için
  const pre = htmlDocument.createElement('pre')

  if (text.length > 0) {
    text.split('\n').forEach((line) => {
      const code = htmlDocument.createElement('code')
      const [key, value] = line.split('=')
      code.textContent = value ? `${key}=${'*'.repeat(value.length)}` : line
      pre.appendChild(code)
      pre.appendChild(htmlDocument.createElement('br')) // Satır sonu için <br> etiketi ekleyin
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
