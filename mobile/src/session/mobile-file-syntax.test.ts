import { describe, expect, it } from 'vitest'
import { detectMobileFileLanguage } from './mobile-file-language'
import {
  buildPlainMobileDiffSyntaxLines,
  highlightMobileCode,
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from './mobile-file-syntax'
import type { MobileDiffLine } from './mobile-diff-lines'

describe('mobile file syntax highlighting', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'renders a prototype-named file as plain text: %s',
    (filePath) => {
      expect(detectMobileFileLanguage(filePath)).toBe('plaintext')
      const language = resolveMobileSyntaxLanguage(filePath)
      expect(language).toBe('plaintext')
      expect(
        highlightMobileDiffLines([{ kind: 'add', text: 'content', newLineNumber: 1 }], language)
      ).toEqual([
        {
          kind: 'add',
          text: 'content',
          newLineNumber: 1,
          highlighted: false,
          segments: [{ text: 'content', kind: 'plain' }]
        }
      ])
    }
  )

  it('retains makefile detection when mobile shares the desktop detector', () => {
    expect(detectMobileFileLanguage('build.make')).toBe('makefile')
  })

  it.each(['justfile', 'Justfile', '.justfile', 'tasks.just', 'C:\\repo\\TASKS.JUST'])(
    'highlights shell recipes in %s',
    (filePath) => {
      const source = '# Build recipe\nbuild:\n  echo "ready"\n'
      const result = highlightMobileCode(source, resolveMobileSyntaxLanguage(filePath))
      expect(result.highlighted).toBe(true)
      expect(result.segments.map((segment) => segment.text).join('')).toBe(source)
      expect(result.segments).toEqual(
        expect.arrayContaining([
          { text: '# Build recipe', kind: 'comment' },
          { text: '"ready"', kind: 'string' }
        ])
      )
    }
  )

  it.each(['terraform.tfvars', 'C:\\repo\\PROD.TFVARS', 'main.tf', 'config.hcl'])(
    'highlights HCL assignments in %s',
    (filePath) => {
      const source = '# Deployment\nregion = "us-west-2"\ncount = 3\n'
      const language = resolveMobileSyntaxLanguage(filePath)
      const result = highlightMobileCode(source, language)
      expect(result.highlighted).toBe(true)
      expect(result.segments.map((segment) => segment.text).join('')).toBe(source)
      expect(result.segments).toEqual(
        expect.arrayContaining([
          { text: '# Deployment', kind: 'comment' },
          { text: 'region', kind: 'variable' },
          { text: '"us-west-2"', kind: 'string' }
        ])
      )
      const [line] = highlightMobileDiffLines([{ text: 'region = "us-west-2"' }], language)
      expect(line?.highlighted).toBe(true)
      expect(line?.segments).toContainEqual({ text: '"us-west-2"', kind: 'string' })
    }
  )

  it.each([
    ['.env', 'ini'],
    ['.env.local', 'ini'],
    ['.env.development', 'ini'],
    ['.env.production', 'ini'],
    ['.env.functions.local', 'ini'],
    ['.env.staging', 'ini'],
    ['.env.test.example', 'ini'],
    ['config/.env.development.local', 'ini'],
    ['.ENV', 'ini'],
    ['.ENV.STAGING', 'ini'],
    ['C:\\repo\\.EnV.FUNCTIONS.LOCAL', 'ini'],
    ['\\\\server\\share\\.env.test.example', 'ini'],
    ['.env.sh', 'shell'],
    ['.ENV.SH', 'shell'],
    ['.env.json', 'json'],
    ['.env.local.ts', 'typescript'],
    ['.env/CMakeLists.txt', 'cmake'],
    ['C:\\repo\\.env.local\\Dockerfile', 'dockerfile'],
    ['.envrc', 'plaintext'],
    ['.environment', 'plaintext'],
    ['env.staging', 'plaintext'],
    ['dev.env', 'plaintext'],
    ['other.env.local', 'plaintext'],
    ['..env.local', 'plaintext'],
    ['.env.staging/readme', 'plaintext'],
    ['C:\\repo\\.env.local\\notes', 'plaintext'],
    ['', 'plaintext']
  ])('detects dotenv names without overriding specific mappings: %s', (filePath, expected) => {
    expect(detectMobileFileLanguage(filePath)).toBe(expected)
  })

  it('keeps a mobile language preference ahead of the dotenv fallback', () => {
    expect(detectMobileFileLanguage('.env.staging', ' JSON ')).toBe('json')
    expect(detectMobileFileLanguage('.env.staging', ' plaintext ')).toBe('ini')
  })

  it('highlights dotenv file and diff contents with the bundled ini grammar', () => {
    const language = resolveMobileSyntaxLanguage('.env.functions.local', 'plaintext')
    const content = '# Local settings\nAPI_URL="https://example.test"\nPORT=54321'
    expect(language).toBe('ini')
    const file = highlightMobileCode(content, language)
    expect(file.highlighted).toBe(true)
    expect(file.segments.map((segment) => segment.text).join('')).toBe(content)
    expect(file.segments).toEqual(
      expect.arrayContaining([
        { text: '# Local settings', kind: 'comment' },
        { text: 'API_URL', kind: 'variable' },
        { text: '"https://example.test"', kind: 'string' }
      ])
    )
    const [line] = highlightMobileDiffLines(
      [{ kind: 'add', text: 'PORT=54321', newLineNumber: 3 }],
      language
    )
    expect(line).toMatchObject({ kind: 'add', newLineNumber: 3, highlighted: true })
    expect(line?.segments).toContainEqual({ text: 'PORT', kind: 'variable' })
  })

  it('detects common source languages from file paths', () => {
    expect(detectMobileFileLanguage('src/App.tsx')).toBe('typescript')
    expect(detectMobileFileLanguage('config/vitest.config.mts')).toBe('typescript')
    expect(detectMobileFileLanguage('C:\\repo\\scripts\\postinstall.CTS')).toBe('typescript')
    expect(detectMobileFileLanguage('scripts/deploy.sh')).toBe('shell')
    expect(detectMobileFileLanguage('Dockerfile')).toBe('dockerfile')
    expect(resolveMobileSyntaxLanguage('src/App.tsx')).toBe('typescript')
    expect(resolveMobileSyntaxLanguage('worktrees/feature/build.cts')).toBe('typescript')
    expect(resolveMobileSyntaxLanguage('Dockerfile')).toBe('plaintext')
  })

  it('emits semantic syntax segments for highlighted code', () => {
    const result = highlightMobileCode('const label: string = "Orca"', 'typescript')

    expect(result.highlighted).toBe(true)
    expect(result.segments).toEqual(
      expect.arrayContaining([
        { text: 'const', kind: 'keyword' },
        { text: 'string', kind: 'type' },
        { text: '"Orca"', kind: 'string' }
      ])
    )
  })

  it('preserves diff line state while highlighting code inside the line', () => {
    const lines: MobileDiffLine[] = [
      { kind: 'delete', text: 'const oldLabel = "Old"', oldLineNumber: 4 },
      { kind: 'add', text: 'const newLabel = "New"', newLineNumber: 4 }
    ]

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted[0]?.kind).toBe('delete')
    expect(highlighted[0]?.oldLineNumber).toBe(4)
    expect(highlighted[0]?.segments).toContainEqual({ text: 'const', kind: 'keyword' })
    expect(highlighted[1]?.kind).toBe('add')
    expect(highlighted[1]?.newLineNumber).toBe(4)
    expect(highlighted[1]?.segments).toContainEqual({ text: '"New"', kind: 'string' })
  })

  it('continues highlighting after blank diff lines', () => {
    const lines: MobileDiffLine[] = [
      { kind: 'context', text: "import { readFileSync } from 'node:fs'", newLineNumber: 1 },
      { kind: 'context', text: '', newLineNumber: 2 },
      { kind: 'context', text: 'const projectDir = dirname(import.meta.url)', newLineNumber: 3 }
    ]

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted[1]).toMatchObject({
      highlighted: false,
      segments: [{ text: '', kind: 'plain' }]
    })
    expect(highlighted[2]?.segments).toContainEqual({ text: 'const', kind: 'keyword' })
  })

  it('falls back to plain text when segment caps would create too many React Native nodes', () => {
    const result = highlightMobileCode('const label: string = "Orca"', 'typescript', 1_000, 1)

    expect(result.highlighted).toBe(false)
    expect(result.segments).toEqual([{ text: 'const label: string = "Orca"', kind: 'plain' }])
  })

  it('caps highlighted diff lines and keeps later rows renderable as plain text', () => {
    const lines: MobileDiffLine[] = Array.from({ length: 520 }, (_, index) => ({
      kind: 'add',
      text: `const value${index} = "mobile"`,
      newLineNumber: index + 1
    }))

    const highlighted = highlightMobileDiffLines(lines, 'typescript')

    expect(highlighted).toHaveLength(520)
    expect(highlighted.filter((line) => line.highlighted)).toHaveLength(500)
    expect(highlighted[519]).toEqual({
      ...lines[519],
      highlighted: false,
      segments: [{ text: lines[519]!.text, kind: 'plain' }]
    })
  })

  it('stops attempting diff highlighting after a token-dense line exceeds the segment cap', () => {
    const denseLine = Array.from(
      { length: 120 },
      (_, index) => `const value${index}: string = "${index}"`
    ).join('; ')
    const highlighted = highlightMobileDiffLines(
      [
        { kind: 'add', text: denseLine, newLineNumber: 1 },
        { kind: 'add', text: 'const later = "plain"', newLineNumber: 2 }
      ] satisfies MobileDiffLine[],
      'typescript'
    )

    expect(highlighted[0]?.highlighted).toBe(false)
    expect(highlighted[1]).toMatchObject({
      highlighted: false,
      segments: [{ text: 'const later = "plain"', kind: 'plain' }]
    })
  })

  it('builds plain diff syntax rows without changing diff metadata', () => {
    const lines: MobileDiffLine[] = [{ kind: 'delete', text: 'plain', oldLineNumber: 9 }]

    expect(buildPlainMobileDiffSyntaxLines(lines)).toEqual([
      {
        ...lines[0],
        highlighted: false,
        segments: [{ text: 'plain', kind: 'plain' }]
      }
    ])
  })
})
