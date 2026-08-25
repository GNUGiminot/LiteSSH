// Ленивый чанк: CodeMirror загружается только при первом открытии предпросмотра
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { langs } from '@uiw/codemirror-extensions-langs'
import type { Extension } from '@codemirror/state'

// langs из @uiw/codemirror-extensions-langs ключуется расширениями файлов;
// здесь только алиасы, остальное берётся по расширению напрямую
const EXT_ALIAS: Record<string, string> = {
  mjs: 'js',
  cjs: 'js',
  bash: 'sh',
  zsh: 'sh',
  htm: 'html',
  h: 'c',
  hpp: 'cpp',
  cxx: 'cpp',
  conf: 'ini',
  dockerfile: 'sh',
  service: 'ini'
}

interface Props {
  value: string
  filename: string
  onChange: (value: string) => void
}

export default function CodeEditor({ value, filename, onChange }: Props) {
  const base = filename.toLowerCase()
  const rawExt = base === 'dockerfile' ? 'dockerfile' : (base.split('.').pop() ?? '')
  const ext = EXT_ALIAS[rawExt] ?? rawExt
  const langFactory = (langs as Record<string, (() => Extension) | undefined>)[ext]
  const extensions: Extension[] = []
  if (langFactory) {
    try {
      extensions.push(langFactory())
    } catch {
      /* язык не загрузился — редактируем без подсветки */
    }
  }
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={vscodeDark}
      extensions={extensions}
      height="100%"
      style={{ height: '100%', fontSize: 12 }}
      basicSetup={{ foldGutter: true, highlightActiveLine: true }}
    />
  )
}
