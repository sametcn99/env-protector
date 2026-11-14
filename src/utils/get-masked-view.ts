import { JSDOM } from 'jsdom'

export type DiffSide = 'original' | 'modified'

export interface DiffUriLike {
  scheme: string
  path?: string
  fsPath?: string
  query?: string
  toString(): string
}

/**
 * Extracts the canonical file basename for an environment URI, stripping
 * temporary `.git` or `.diff` suffixes added by SCM providers.
 */
export function getCanonicalEnvBaseName(uri: DiffUriLike): string {
  const queryStr = decodeQueryIfNeeded(uri.query)
  if (queryStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(queryStr) as { path?: unknown }
      if (typeof parsed.path === 'string' && parsed.path.length > 0) {
        const normalized = parsed.path.replace(/\\/g, '/')
        const lastSlash = normalized.lastIndexOf('/')
        return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
      }
    } catch {
      // Fallback to fsPath/path below
    }
  }
  const rawPath = (uri.fsPath || uri.path || '').replace(/\\/g, '/')
  const lastSlash = rawPath.lastIndexOf('/')
  const base = lastSlash >= 0 ? rawPath.slice(lastSlash + 1) : rawPath
  return base.replace(/\.(git|diff)$/i, '')
}

/**
 * Returns true if the given URI points to an `.env*` file covered by Env Protector.
 */
export function isEnvFileUri(uri: DiffUriLike): boolean {
  const baseName = getCanonicalEnvBaseName(uri).toLowerCase()
  return (
    baseName === '.env' ||
    baseName.startsWith('.env.') ||
    baseName.endsWith('.env') ||
    baseName.includes('.env.')
  )
}

function decodeQueryIfNeeded(rawQuery?: string): string {
  if (!rawQuery) {
    return ''
  }
  const trimmed = rawQuery.trim()
  if (trimmed.startsWith('%7B') || trimmed.startsWith('%7b')) {
    try {
      return decodeURIComponent(trimmed).trim()
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/**
 * Extracts the git reference (`ref`) from a VS Code git URI query if present.
 * VS Code's built-in git extension encodes query as JSON: `{"path":"...","ref":"HEAD"}`
 * (where `ref` is `""` for the staged index, `"~"` for timeline index, `"HEAD"` for HEAD, etc.).
 */
export function parseGitRef(uri: DiffUriLike): string | undefined {
  const trimmed = decodeQueryIfNeeded(uri.query)
  if (!trimmed) {
    return undefined
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { ref?: unknown }
      if (typeof parsed.ref === 'string') {
        return parsed.ref
      }
    } catch {
      // Fallback to URLSearchParams below
    }
  }
  const params = new URLSearchParams(trimmed)
  if (params.has('ref')) {
    return params.get('ref') ?? undefined
  }
  return undefined
}

function getGitRefRecency(ref: string): number {
  const normalized = ref.trim()
  // Working tree virtual refs (e.g. submodule wt or GitLens working tree)
  if (
    normalized === 'wt' ||
    normalized === 'working' ||
    normalized === 'WORKTREE' ||
    normalized === 'WORKING'
  ) {
    return 50
  }
  // Staged changes in SCM view use ref: "" (or "index" / "staged" / ":0") for the modified (right) index resource
  if (
    normalized === '' ||
    normalized === 'index' ||
    normalized === 'staged' ||
    normalized === 'INDEX' ||
    normalized === 'STAGED' ||
    normalized === ':' ||
    normalized === ':0' ||
    normalized === '~0'
  ) {
    return 40
  }
  // Timeline staged view or unstaged base uses ref: "~" for the index resource
  if (normalized === '~') {
    return 30
  }
  // Merge conflict stages: :2 / ~2 (ours) and :3 / ~3 (theirs) are modified; :1 / ~1 (base) is original
  if (
    normalized === ':2' ||
    normalized === ':3' ||
    normalized === '~2' ||
    normalized === '~3'
  ) {
    return 26
  }
  if (normalized === ':1' || normalized === '~1') {
    return 24
  }
  // HEAD is the committed state (original when compared against staged "" or "~")
  if (normalized === 'HEAD' || normalized === 'HEAD~0' || normalized === '@') {
    return 20
  }
  // Direct parent of HEAD (e.g. HEAD^ or HEAD~1)
  if (normalized === 'HEAD^' || /^HEAD~\d*$/.test(normalized)) {
    return 10
  }
  // Specific commit SHA, tag, or branch ref (older than HEAD / staged / working tree)
  return 15
}

function isParentRefOf(
  candidateParent: string,
  candidateChild: string,
): boolean {
  if (!candidateParent || !candidateChild) {
    return false
  }
  if (candidateParent === `${candidateChild}^`) {
    return true
  }
  if (candidateParent.startsWith(`${candidateChild}~`)) {
    const suffix = candidateParent.slice(candidateChild.length + 1)
    return /^\d*$/.test(suffix)
  }
  return false
}

/**
 * Determines which of two diff URIs is `original` (Before / left pane) and
 * which is `modified` (After / right pane), handling:
 * - Unstaged working tree diffs (`git:` vs `file:`)
 * - Staged index diffs (`git:?ref=HEAD` vs `git:?ref=""` or `git:?ref="~"`)
 * - Index vs Working Tree (`git:?ref="~"` vs `git:?ref=""`)
 * - Parent commit diffs (`<ref>^` / `<ref>~N` vs `<ref>`)
 * - Commit SHA vs HEAD / Staged / Working Tree
 * - Merge conflict stage diffs (`~1` / `:1` vs `~2` / `~3` / `:2` / `:3`)
 * - Commit-to-commit or file-to-file diffs with `↔` in the tab title
 */
export function orderDiffUris<T extends DiffUriLike>(
  first: T,
  second: T,
  tabLabel?: string,
): { original: T; modified: T } {
  // 1. Unstaged working tree diff: virtual scheme (e.g. 'git') is original, 'file' is modified
  if (first.scheme === 'file' && second.scheme !== 'file') {
    return { original: second, modified: first }
  }
  if (first.scheme !== 'file' && second.scheme === 'file') {
    return { original: first, modified: second }
  }

  // 2. Both URIs carry git refs (e.g. Staged Index diff: ref="HEAD" vs ref="")
  const ref1 = parseGitRef(first)
  const ref2 = parseGitRef(second)

  if (ref1 !== undefined && ref2 !== undefined && ref1 !== ref2) {
    // Check explicit parent relationship: e.g. "abc~1" or "abc^" vs "abc"
    if (isParentRefOf(ref1, ref2)) {
      return { original: first, modified: second }
    }
    if (isParentRefOf(ref2, ref1)) {
      return { original: second, modified: first }
    }

    // Compare recency in git workflow (parent < commit < HEAD < "~" < "")
    const recency1 = getGitRefRecency(ref1)
    const recency2 = getGitRefRecency(ref2)
    if (recency1 !== recency2) {
      return recency1 < recency2
        ? { original: first, modified: second }
        : { original: second, modified: first }
    }

    // Both are arbitrary commit SHAs/refs: check tab label "left ↔ right" if available
    if (tabLabel && tabLabel.includes('\u2194')) {
      const [leftTitle, rightTitle] = tabLabel.split('\u2194')
      const short1 = ref1.slice(0, 7)
      const short2 = ref2.slice(0, 7)
      if (short1 && short2 && short1 !== short2) {
        if (leftTitle.includes(short1) || rightTitle.includes(short2)) {
          return { original: first, modified: second }
        }
        if (leftTitle.includes(short2) || rightTitle.includes(short1)) {
          return { original: second, modified: first }
        }
      }
    }
  }

  // 3. Check tab label "left ↔ right" for file-to-file comparisons
  if (tabLabel && tabLabel.includes('\u2194')) {
    const [leftTitle, rightTitle] = tabLabel
      .split('\u2194')
      .map((s) => s.trim())
    const path1 = first.fsPath ?? first.path ?? first.toString()
    const path2 = second.fsPath ?? second.path ?? second.toString()
    if (path1 !== path2) {
      if (
        (leftTitle && path1.endsWith(leftTitle)) ||
        (rightTitle && path2.endsWith(rightTitle))
      ) {
        return { original: first, modified: second }
      }
      if (
        (leftTitle && path2.endsWith(leftTitle)) ||
        (rightTitle && path1.endsWith(rightTitle))
      ) {
        return { original: second, modified: first }
      }
    }
  }

  return { original: first, modified: second }
}

interface ParsedEnvLine {
  kind: 'empty' | 'comment' | 'kv'
  raw: string
  key: string
  value: string
  hasEquals: boolean
  comment?: string
}

export interface AlignedDiffRow {
  type: 'unchanged' | 'modified' | 'removed' | 'added'
  origLine?: string
  origLineNo?: number
  modLine?: string
  modLineNo?: number
}

function parseEnvLine(line: string): ParsedEnvLine {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return {
      kind: 'empty',
      raw: line,
      key: '',
      value: '',
      hasEquals: false,
    }
  }
  if (trimmed.startsWith('#')) {
    return {
      kind: 'comment',
      raw: line,
      key: '',
      value: '',
      hasEquals: false,
      comment: line,
    }
  }

  const hashIndex = line.indexOf('#')
  const keyValuePart = hashIndex >= 0 ? line.slice(0, hashIndex) : line
  const commentPart = hashIndex >= 0 ? line.slice(hashIndex + 1) : undefined

  const eqIndex = keyValuePart.indexOf('=')
  const key = eqIndex >= 0 ? keyValuePart.slice(0, eqIndex) : keyValuePart
  const value = eqIndex >= 0 ? keyValuePart.slice(eqIndex + 1) : ''

  return {
    kind: 'kv',
    raw: line,
    key,
    value,
    hasEquals: eqIndex >= 0,
    comment: commentPart,
  }
}

function maskValue(value: string): string {
  return value.replace(/./g, '*')
}

/**
 * Checks whether two environment variable keys represent an in-place edit of
 * the same key (e.g. `ANOTHER_ULTRA_SECRET_TOKEN` -> `ANOTHER_ULTRA_SEasdsadCRET_TOKEN`)
 * rather than two unrelated keys (e.g. `REMOVED_KEY` vs `ADDED_KEY`).
 */
function areEnvKeysSimilar(rawKeyA: string, rawKeyB: string): boolean {
  const a = rawKeyA.trim()
  const b = rawKeyB.trim()
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  // Strip generic env suffixes so `OLD_KEY` and `NEW_KEY` don't match on `_KEY` alone
  const stemRegex = /_(KEY|TOKEN|SECRET|URL|PASSWORD|ID|HOST|PORT)$/i
  const stemA = a.replace(stemRegex, '')
  const stemB = b.replace(stemRegex, '')
  if (!stemA || !stemB) {
    return false
  }

  let prefix = 0
  const minLen = Math.min(stemA.length, stemB.length)
  while (prefix < minLen && stemA[prefix] === stemB[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < minLen - prefix &&
    stemA[stemA.length - 1 - suffix] === stemB[stemB.length - 1 - suffix]
  ) {
    suffix++
  }

  const maxLen = Math.max(stemA.length, stemB.length)
  return (prefix + suffix) / maxLen >= 0.65 && prefix + suffix >= 4
}

/**
 * Computes aligned side-by-side diff rows for two .env texts using LCS
 * for exact matches and key-aware pairing within changed hunks.
 */
export function computeAlignedDiffRows(
  originalText: string,
  modifiedText: string,
): AlignedDiffRow[] {
  const normalizedOrig = originalText.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const normalizedMod = modifiedText.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const origLines =
    normalizedOrig.length === 0 ? [] : normalizedOrig.split('\n')
  const modLines = normalizedMod.length === 0 ? [] : normalizedMod.split('\n')

  const n = origLines.length
  const m = modLines.length

  // LCS dynamic programming table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (origLines[i] === modLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1]
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const anchors: Array<{ origIdx: number; modIdx: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (origLines[i] === modLines[j]) {
      anchors.push({ origIdx: i, modIdx: j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  anchors.push({ origIdx: n, modIdx: m })

  const rows: AlignedDiffRow[] = []
  let prevOrig = 0
  let prevMod = 0

  for (const anchor of anchors) {
    const remSlice: Array<{ line: string; lineNo: number }> = []
    for (let idx = prevOrig; idx < anchor.origIdx; idx++) {
      remSlice.push({ line: origLines[idx], lineNo: idx + 1 })
    }

    const addSlice: Array<{ line: string; lineNo: number }> = []
    for (let idx = prevMod; idx < anchor.modIdx; idx++) {
      addSlice.push({ line: modLines[idx], lineNo: idx + 1 })
    }

    alignHunk(remSlice, addSlice, rows)

    if (anchor.origIdx < n && anchor.modIdx < m) {
      rows.push({
        type: 'unchanged',
        origLine: origLines[anchor.origIdx],
        origLineNo: anchor.origIdx + 1,
        modLine: modLines[anchor.modIdx],
        modLineNo: anchor.modIdx + 1,
      })
    }

    prevOrig = anchor.origIdx + 1
    prevMod = anchor.modIdx + 1
  }

  return rows
}

function alignHunk(
  remSlice: Array<{ line: string; lineNo: number }>,
  addSlice: Array<{ line: string; lineNo: number }>,
  rows: AlignedDiffRow[],
): void {
  let rIdx = 0
  let aIdx = 0

  while (rIdx < remSlice.length || aIdx < addSlice.length) {
    if (rIdx >= remSlice.length) {
      const add = addSlice[aIdx++]
      rows.push({
        type: 'added',
        modLine: add.line,
        modLineNo: add.lineNo,
      })
      continue
    }

    if (aIdx >= addSlice.length) {
      const rem = remSlice[rIdx++]
      rows.push({
        type: 'removed',
        origLine: rem.line,
        origLineNo: rem.lineNo,
      })
      continue
    }

    const rem = remSlice[rIdx]
    const add = addSlice[aIdx]
    const parsedRem = parseEnvLine(rem.line)
    const parsedAdd = parseEnvLine(add.line)

    // Same key modified in place, or both are comments modified in place
    if (
      (parsedRem.kind === 'kv' &&
        parsedAdd.kind === 'kv' &&
        parsedRem.key.trim() === parsedAdd.key.trim()) ||
      (parsedRem.kind === 'comment' && parsedAdd.kind === 'comment')
    ) {
      rows.push({
        type: 'modified',
        origLine: rem.line,
        origLineNo: rem.lineNo,
        modLine: add.line,
        modLineNo: add.lineNo,
      })
      rIdx++
      aIdx++
      continue
    }

    // Look ahead in addSlice to see if rem's key appears soon
    const matchingAddIdx =
      parsedRem.kind === 'kv'
        ? addSlice.findIndex(
            (candidate, idx) =>
              idx > aIdx &&
              parseEnvLine(candidate.line).kind === 'kv' &&
              parseEnvLine(candidate.line).key.trim() === parsedRem.key.trim(),
          )
        : -1

    // Look ahead in remSlice to see if add's key appears soon
    const matchingRemIdx =
      parsedAdd.kind === 'kv'
        ? remSlice.findIndex(
            (candidate, idx) =>
              idx > rIdx &&
              parseEnvLine(candidate.line).kind === 'kv' &&
              parseEnvLine(candidate.line).key.trim() === parsedAdd.key.trim(),
          )
        : -1

    if (
      matchingRemIdx !== -1 &&
      (matchingAddIdx === -1 || matchingRemIdx - rIdx <= matchingAddIdx - aIdx)
    ) {
      // Lines before matchingRemIdx were removed
      rows.push({
        type: 'removed',
        origLine: rem.line,
        origLineNo: rem.lineNo,
      })
      rIdx++
    } else if (matchingAddIdx !== -1) {
      // Lines before matchingAddIdx were added
      rows.push({
        type: 'added',
        modLine: add.line,
        modLineNo: add.lineNo,
      })
      aIdx++
    } else if (
      parsedRem.kind === 'kv' &&
      parsedAdd.kind === 'kv' &&
      areEnvKeysSimilar(parsedRem.key, parsedAdd.key)
    ) {
      // In-place edit of a key (e.g. typo or characters inserted into the key name)
      rows.push({
        type: 'modified',
        origLine: rem.line,
        origLineNo: rem.lineNo,
        modLine: add.line,
        modLineNo: add.lineNo,
      })
      rIdx++
      aIdx++
    } else {
      // Unrelated keys: emit removed first, then added
      rows.push({
        type: 'removed',
        origLine: rem.line,
        origLineNo: rem.lineNo,
      })
      rIdx++
    }
  }
}

/**
 * Generates a VS Code built-in style masked diff view for either the 'original'
 * (left) or 'modified' (right) pane of a .env diff comparison.
 */
export function getMaskedDiffView(
  originalText: string,
  modifiedText: string,
  side: DiffSide,
  name: string,
): string {
  const dom = new JSDOM()
  const doc = dom.window.document

  const style = doc.createElement('style')
  style.textContent = `
    * {
      box-sizing: border-box;
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', Consolas, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-editor-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      overflow: hidden;
    }
    .editor-shell {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100%;
    }
    .diff-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      height: 29px;
      min-height: 29px;
      padding: 0 12px;
      border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, rgba(128, 128, 128, 0.2));
      background-color: var(--vscode-editorWidget-background, #252526);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #9d9d9d);
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
      overflow: hidden;
    }
    .header-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground, #8b949e);
      font-size: 11px;
    }
    .diff-badges {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .diff-header a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      font-weight: 600;
    }
    .diff-header a:hover {
      text-decoration: underline;
    }
    .sr-text {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      gap: 4px;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10.5px;
      font-weight: 600;
      line-height: 16px;
      letter-spacing: 0.01em;
    }
    .badge-side-orig {
      background-color: rgba(248, 81, 73, 0.14);
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      border: 1px solid rgba(248, 81, 73, 0.28);
    }
    .badge-side-mod {
      background-color: rgba(46, 160, 67, 0.14);
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
      border: 1px solid rgba(46, 160, 67, 0.28);
    }
    .badge-added {
      background-color: rgba(46, 160, 67, 0.16);
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }
    .badge-removed {
      background-color: rgba(248, 81, 73, 0.16);
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }
    .badge-modified {
      background-color: rgba(210, 153, 34, 0.16);
      color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
    }
    .key-count-pill {
      color: var(--vscode-descriptionForeground, #8b949e);
      font-size: 11px;
      margin-left: 2px;
    }
    .diff-container {
      flex: 1;
      padding: 4px 0 16px 0;
      overflow: auto;
    }
    .diff-row {
      display: flex;
      align-items: stretch;
      min-height: 21px;
      line-height: 21px;
      white-space: pre;
      min-width: max-content;
      border-left: 3px solid transparent;
    }
    .diff-row:hover:not(.diff-row-filler) {
      filter: brightness(1.06);
    }
    .diff-row-added {
      background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.15));
      border-left-color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
    }
    .diff-row-removed {
      background-color: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.15));
      border-left-color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }
    .diff-row-modified-orig {
      background-color: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.14));
      border-left-color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }
    .diff-row-modified-mod {
      background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.14));
      border-left-color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
    }
    .diff-row-filler {
      background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 5px,
        var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, 0.13)) 5px,
        var(--vscode-diffEditor-diagonalFill, rgba(128, 128, 128, 0.13)) 6px
      );
      user-select: none;
    }
    .gutter-lineno {
      width: 40px;
      min-width: 40px;
      text-align: right;
      padding-right: 10px;
      color: var(--vscode-editorLineNumber-foreground, #6e7681);
      user-select: none;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .gutter-sign {
      width: 18px;
      min-width: 18px;
      text-align: center;
      font-weight: 600;
      user-select: none;
      font-size: 12px;
    }
    .sign-added {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }
    .sign-removed {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }
    .code-cell {
      flex: 1;
      padding: 0 14px 0 6px;
    }
    .env-key {
      color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      font-weight: 600;
    }
    .env-eq {
      color: var(--vscode-editor-foreground, #d4d4d4);
      opacity: 0.85;
    }
    .env-value {
      color: var(--vscode-debugTokenExpression-string, #ce9178);
    }
    .env-comment {
      color: var(--vscode-editorCodeLens-foreground, #6a9955);
      font-style: italic;
    }
    .token-changed-orig {
      background-color: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.38));
      border-radius: 2px;
    }
    .token-changed-mod {
      background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.38));
      border-radius: 2px;
    }
    .empty-state {
      margin: 16px;
      color: var(--vscode-descriptionForeground, #8b949e);
    }
  `
  doc.head.appendChild(style)

  const rows = computeAlignedDiffRows(originalText, modifiedText)
  const addedCount = rows.filter((r) => r.type === 'added').length
  const removedCount = rows.filter((r) => r.type === 'removed').length
  const modifiedCount = rows.filter((r) => r.type === 'modified').length

  const sideText = (side === 'original' ? originalText : modifiedText)
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
  const sideLines = sideText.length === 0 ? [] : sideText.split('\n')
  const keyCount = sideLines.filter((l) => parseEnvLine(l).kind === 'kv').length

  const shell = doc.createElement('div')
  shell.className = 'editor-shell'

  // Compact VS Code Editor Header Bar
  const header = doc.createElement('div')
  header.className = 'diff-header'

  const headerLeft = doc.createElement('div')
  headerLeft.className = 'header-left'

  const sideBadge = doc.createElement('span')
  sideBadge.className =
    side === 'original' ? 'badge badge-side-orig' : 'badge badge-side-mod'
  sideBadge.textContent =
    side === 'original' ? 'Original (Before)' : 'Modified (After)'
  headerLeft.appendChild(sideBadge)

  const headerMeta = doc.createElement('span')
  headerMeta.className = 'header-meta'
  headerMeta.textContent = `${keyCount} keys masked`

  const srMeta = doc.createElement('span')
  srMeta.className = 'sr-text'
  const a = doc.createElement('a')
  a.textContent = name
  a.href = 'https://sametcc.me/env-protector'
  srMeta.appendChild(doc.createTextNode('Values masked by '))
  srMeta.appendChild(a)
  srMeta.appendChild(
    doc.createTextNode(
      `. Here are the masked values in the .env file. ${keyCount} masked key-value pairs in the .env file`,
    ),
  )
  headerMeta.appendChild(srMeta)
  headerLeft.appendChild(headerMeta)

  header.appendChild(headerLeft)

  const badges = doc.createElement('div')
  badges.className = 'diff-badges'

  if (addedCount > 0) {
    const b = doc.createElement('span')
    b.className = 'badge badge-added'
    b.textContent = `+${addedCount} added`
    badges.appendChild(b)
  }
  if (modifiedCount > 0) {
    const b = doc.createElement('span')
    b.className = 'badge badge-modified'
    b.textContent = `~${modifiedCount} modified`
    badges.appendChild(b)
  }
  if (removedCount > 0) {
    const b = doc.createElement('span')
    b.className = 'badge badge-removed'
    b.textContent = `-${removedCount} removed`
    badges.appendChild(b)
  }

  header.appendChild(badges)
  shell.appendChild(header)

  const container = doc.createElement('div')
  container.className = 'diff-container'

  if (originalText.length === 0 && modifiedText.length === 0) {
    const emptyPre = doc.createElement('pre')
    emptyPre.className = 'empty-state'
    const code = doc.createElement('code')
    code.textContent = 'No content found in the .env file'
    emptyPre.appendChild(code)
    container.appendChild(emptyPre)
    shell.appendChild(container)
    doc.body.appendChild(shell)
    return doc.documentElement.outerHTML
  }

  for (const row of rows) {
    const rowEl = doc.createElement('div')
    const lineNoEl = doc.createElement('span')
    lineNoEl.className = 'gutter-lineno'
    const signEl = doc.createElement('span')
    signEl.className = 'gutter-sign'
    const codeEl = doc.createElement('div')
    codeEl.className = 'code-cell'

    const isFiller =
      (side === 'original' && row.type === 'added') ||
      (side === 'modified' && row.type === 'removed')

    if (isFiller) {
      rowEl.className = 'diff-row diff-row-filler'
      lineNoEl.textContent = ''
      signEl.textContent = ''
      codeEl.textContent = ' '
      rowEl.appendChild(lineNoEl)
      rowEl.appendChild(signEl)
      rowEl.appendChild(codeEl)
      container.appendChild(rowEl)
      continue
    }

    const activeLine =
      side === 'original' ? (row.origLine ?? '') : (row.modLine ?? '')
    const activeLineNo = side === 'original' ? row.origLineNo : row.modLineNo
    lineNoEl.textContent =
      activeLineNo !== undefined ? String(activeLineNo) : ''

    if (row.type === 'unchanged') {
      rowEl.className = 'diff-row'
      signEl.textContent = ' '
      renderMaskedLineContent(doc, codeEl, activeLine)
    } else if (row.type === 'added') {
      rowEl.className = 'diff-row diff-row-added'
      signEl.className = 'gutter-sign sign-added'
      signEl.textContent = '+'
      renderMaskedLineContent(doc, codeEl, activeLine)
    } else if (row.type === 'removed') {
      rowEl.className = 'diff-row diff-row-removed'
      signEl.className = 'gutter-sign sign-removed'
      signEl.textContent = '-'
      renderMaskedLineContent(doc, codeEl, activeLine)
    } else if (row.type === 'modified') {
      const origParsed = parseEnvLine(row.origLine ?? '')
      const modParsed = parseEnvLine(row.modLine ?? '')
      const tokenClass =
        side === 'original' ? 'token-changed-orig' : 'token-changed-mod'

      rowEl.className =
        side === 'original'
          ? 'diff-row diff-row-modified-orig'
          : 'diff-row diff-row-modified-mod'
      signEl.className =
        side === 'original'
          ? 'gutter-sign sign-removed'
          : 'gutter-sign sign-added'
      signEl.textContent = side === 'original' ? '-' : '+'

      renderMaskedLineContent(doc, codeEl, activeLine, {
        keyChanged: origParsed.key !== modParsed.key,
        oppositeKey: side === 'original' ? modParsed.key : origParsed.key,
        valueChanged: origParsed.value !== modParsed.value,
        commentChanged: origParsed.comment !== modParsed.comment,
        tokenClass,
      })
    }

    rowEl.appendChild(lineNoEl)
    rowEl.appendChild(signEl)
    rowEl.appendChild(codeEl)
    container.appendChild(rowEl)
  }

  shell.appendChild(container)
  doc.body.appendChild(shell)
  return doc.documentElement.outerHTML
}

function appendInlineDiffText(
  doc: Document,
  parent: HTMLElement,
  activeStr: string,
  oppositeStr: string,
  tokenClass: string,
): void {
  let prefix = 0
  const minLen = Math.min(activeStr.length, oppositeStr.length)
  while (prefix < minLen && activeStr[prefix] === oppositeStr[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < minLen - prefix &&
    activeStr[activeStr.length - 1 - suffix] ===
      oppositeStr[oppositeStr.length - 1 - suffix]
  ) {
    suffix++
  }

  const changedMiddle = activeStr.slice(prefix, activeStr.length - suffix)
  if (changedMiddle.length === 0 || (prefix === 0 && suffix === 0)) {
    parent.classList.add(tokenClass)
    parent.textContent = activeStr
    return
  }

  if (prefix > 0) {
    parent.appendChild(doc.createTextNode(activeStr.slice(0, prefix)))
  }
  const midSpan = doc.createElement('span')
  midSpan.className = tokenClass
  midSpan.textContent = changedMiddle
  parent.appendChild(midSpan)
  if (suffix > 0) {
    parent.appendChild(
      doc.createTextNode(activeStr.slice(activeStr.length - suffix)),
    )
  }
}

function renderMaskedLineContent(
  doc: Document,
  container: HTMLElement,
  line: string,
  diffOpts?: {
    highlightAllTokenClass?: string
    keyChanged?: boolean
    oppositeKey?: string
    valueChanged?: boolean
    commentChanged?: boolean
    tokenClass?: string
  },
): void {
  const parsed = parseEnvLine(line)

  if (parsed.kind === 'empty' || parsed.kind === 'comment') {
    const commentSpan = doc.createElement('span')
    commentSpan.className = 'env-comment'
    if (diffOpts?.highlightAllTokenClass || diffOpts?.commentChanged) {
      commentSpan.classList.add(
        diffOpts.highlightAllTokenClass ?? diffOpts.tokenClass ?? '',
      )
    }
    commentSpan.textContent = line
    container.appendChild(commentSpan)
    return
  }

  const tClass = diffOpts?.highlightAllTokenClass ?? diffOpts?.tokenClass

  const keySpan = doc.createElement('span')
  keySpan.className = 'env-key'
  if (diffOpts?.keyChanged && tClass) {
    if (diffOpts.oppositeKey !== undefined) {
      appendInlineDiffText(
        doc,
        keySpan,
        parsed.key,
        diffOpts.oppositeKey,
        tClass,
      )
    } else {
      keySpan.classList.add(tClass)
      keySpan.textContent = parsed.key
    }
  } else {
    keySpan.textContent = parsed.key
  }
  container.appendChild(keySpan)

  if (parsed.hasEquals) {
    const equalSignSpan = doc.createElement('span')
    equalSignSpan.className = 'env-eq'
    equalSignSpan.textContent = '='
    container.appendChild(equalSignSpan)

    const valueSpan = doc.createElement('span')
    valueSpan.className = 'env-value'
    valueSpan.textContent = maskValue(parsed.value)
    if (
      (diffOpts?.highlightAllTokenClass || diffOpts?.valueChanged) &&
      tClass
    ) {
      valueSpan.classList.add(tClass)
    }
    container.appendChild(valueSpan)
  }

  if (parsed.comment !== undefined) {
    const commentSpan = doc.createElement('span')
    commentSpan.className = 'env-comment'
    if (
      (diffOpts?.highlightAllTokenClass || diffOpts?.commentChanged) &&
      tClass
    ) {
      commentSpan.classList.add(tClass)
    }
    commentSpan.textContent = ` #${parsed.comment}`
    container.appendChild(commentSpan)
  }
}

/**
 * Generates an HTML view with masked values from a given text and a name.
 *
 * @param text - The input text containing key-value pairs, typically from a .env file.
 * @param name - The name to be displayed in the generated HTML.
 * @returns The generated HTML string with masked values.
 */
export function getMaskedView(text: string, name: string): string {
  const dom = new JSDOM()
  const htmlDocument = dom.window.document

  const style = htmlDocument.createElement('style')
  style.textContent = `
    * {
      box-sizing: border-box;
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', Consolas, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-editor-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
    }
    p.masked-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      height: 29px;
      padding: 0 12px;
      border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, rgba(128, 128, 128, 0.2));
      background-color: var(--vscode-editorWidget-background, #252526);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #9d9d9d);
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
    }
    p.masked-header a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      font-weight: 600;
    }
    p.masked-header br {
      display: none;
    }
    p.masked-header i {
      color: var(--vscode-descriptionForeground, #8b949e);
      font-style: normal !important;
      margin-left: auto;
    }
    .sr-text {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    pre.masked-editor {
      margin: 0;
      padding: 6px 0 16px 0;
      font-family: inherit;
      font-size: inherit;
      line-height: 21px;
      overflow: auto;
    }
    .editor-line {
      display: flex;
      align-items: baseline;
      min-height: 21px;
      padding-right: 14px;
    }
    .editor-line:hover {
      background-color: var(--vscode-editor-lineHighlightBackground, rgba(255, 255, 255, 0.04));
    }
    .editor-line::before {
      content: attr(data-line);
      width: 42px;
      min-width: 42px;
      padding-right: 14px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #6e7681);
      user-select: none;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .env-key {
      color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      font-weight: 600;
    }
    .env-eq {
      color: var(--vscode-editor-foreground, #d4d4d4);
      opacity: 0.85;
    }
    .env-value {
      color: var(--vscode-debugTokenExpression-string, #ce9178);
    }
    .env-comment {
      color: var(--vscode-editorCodeLens-foreground, #6a9955);
      font-style: italic;
    }
  `
  htmlDocument.head.appendChild(style)

  const p = htmlDocument.createElement('p')
  p.className = 'masked-header'

  const a = htmlDocument.createElement('a')
  a.textContent = name
  a.href = 'https://sametcc.me/env-protector'

  p.appendChild(htmlDocument.createTextNode('Values masked by '))
  p.appendChild(a)
  const srSuffix = htmlDocument.createElement('span')
  srSuffix.className = 'sr-text'
  srSuffix.textContent = '. Here are the masked values in the .env file'
  p.appendChild(srSuffix)

  const pre = htmlDocument.createElement('pre')
  pre.className = 'masked-editor'

  if (text.length === 0) {
    const code = htmlDocument.createElement('code')
    code.textContent = 'No content found in the .env file'
    pre.appendChild(code)
    htmlDocument.body.appendChild(p)
    htmlDocument.body.appendChild(pre)
    return htmlDocument.documentElement.outerHTML
  }

  let keyCount: number = 0

  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  lines.forEach((line, idx) => {
    const parsed = parseEnvLine(line)
    const lineDiv = htmlDocument.createElement('div')
    lineDiv.className = 'editor-line'
    lineDiv.setAttribute('data-line', String(idx + 1))

    if (parsed.kind === 'comment' || parsed.kind === 'empty') {
      const singleLineComment = htmlDocument.createElement('span')
      singleLineComment.className = 'env-comment'
      singleLineComment.textContent = line
      lineDiv.appendChild(singleLineComment)
      pre.appendChild(lineDiv)
    } else {
      const keySpan = htmlDocument.createElement('span')
      keySpan.className = 'env-key'
      keySpan.textContent = parsed.key
      lineDiv.appendChild(keySpan)

      if (parsed.hasEquals) {
        const equalSignSpan = htmlDocument.createElement('span')
        equalSignSpan.className = 'env-eq'
        equalSignSpan.textContent = '='
        lineDiv.appendChild(equalSignSpan)

        const valueSpan = htmlDocument.createElement('span')
        valueSpan.className = 'env-value'
        valueSpan.textContent = maskValue(parsed.value)
        lineDiv.appendChild(valueSpan)
      }

      if (parsed.comment !== undefined) {
        const commentSpan = htmlDocument.createElement('span')
        commentSpan.className = 'env-comment'
        commentSpan.textContent = ` #${parsed.comment}`
        lineDiv.appendChild(commentSpan)
      }

      pre.appendChild(lineDiv)
      keyCount++
    }
  })

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
