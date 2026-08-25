import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, Save, X } from 'lucide-react'
import { usePreview } from '@/stores/usePreview'
import { useToasts } from '@/stores/useToasts'

const CodeEditor = lazy(() => import('./CodeEditor'))

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

const TEXT_LIMIT = 2 * 1024 * 1024 // 2 MB — дальше только hex

type Kind = 'loading' | 'text' | 'image' | 'hex' | 'error'

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8192)
  for (const b of probe) if (b === 0) return true
  return false
}

function hexDump(bytes: Uint8Array, maxRows = 512): string {
  const rows: string[] = []
  for (let off = 0; off < bytes.length && rows.length < maxRows; off += 16) {
    const chunk = bytes.subarray(off, off + 16)
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    rows.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return rows.join('\n')
}

export function PreviewDialog() {
  const { open, termId, path, name, close } = usePreview()
  const push = useToasts((s) => s.push)
  const [kind, setKind] = useState<Kind>('loading')
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [hex, setHex] = useState('')
  const [meta, setMeta] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setKind('loading')
    setDirty(false)
    setImageUrl('')
    void window.api.sftp.read(termId, path).then((res) => {
      if (!res.ok || res.base64 === undefined) {
        setKind('error')
        setMeta(res.error ?? 'Не удалось прочитать файл')
        return
      }
      const ext = name.toLowerCase().split('.').pop() ?? ''
      const size = res.size ?? 0
      if (IMAGE_EXT[ext] && !res.truncated) {
        setImageUrl(`data:${IMAGE_EXT[ext]};base64,${res.base64}`)
        setKind('image')
        setMeta(`${(size / 1024).toFixed(1)} KB`)
        return
      }
      const bytes = decodeBase64(res.base64)
      if (res.truncated || size > TEXT_LIMIT || looksBinary(bytes)) {
        setHex(hexDump(bytes))
        setKind('hex')
        setMeta(
          `${(size / 1024).toFixed(1)} KB${res.truncated || bytes.length < size ? ` (показаны первые ${(Math.min(bytes.length, 8192) / 1024).toFixed(0)} KB)` : ''}`
        )
        return
      }
      setText(new TextDecoder().decode(bytes))
      setKind('text')
      setMeta(`${(size / 1024).toFixed(1)} KB`)
    })
  }, [open, termId, path, name])

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const bytes = new TextEncoder().encode(text)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const res = await window.api.sftp.write(termId, path, btoa(bin))
      if (res.ok) {
        setDirty(false)
        push('success', `Сохранено: ${name}`)
      } else {
        push('error', res.error ?? 'Ошибка сохранения')
      }
    } finally {
      setSaving(false)
    }
  }

  const editor = useMemo(
    () =>
      kind === 'text' ? (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-content-3">
              <Loader2 size={20} className="animate-spin" />
            </div>
          }
        >
          <CodeEditor
            value={text}
            filename={name}
            onChange={(v) => {
              setText(v)
              setDirty(true)
            }}
          />
        </Suspense>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, name]
  )

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[80vw] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-surface-3 bg-surface-1 shadow-2xl"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault()
              if (kind === 'text' && dirty) void save()
            }
          }}
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-surface-3 px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate font-mono text-xs text-content-1">
              {path}
              {dirty ? ' •' : ''}
            </Dialog.Title>
            <span className="shrink-0 text-[10px] text-content-3">{meta}</span>
            {kind === 'text' && (
              <button
                onClick={() => void save()}
                disabled={!dirty || saving}
                title="Сохранить (Ctrl+S)"
                className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                <Save size={12} /> Сохранить
              </button>
            )}
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-[#1e1e1e]">
            {kind === 'loading' && (
              <div className="flex h-full items-center justify-center text-content-3">
                <Loader2 size={20} className="animate-spin" />
              </div>
            )}
            {kind === 'error' && (
              <p className="p-4 text-xs text-red-400">{meta}</p>
            )}
            {kind === 'text' && editor}
            {kind === 'image' && (
              <div className="flex h-full items-center justify-center p-4">
                <img src={imageUrl} alt={name} className="max-h-full max-w-full object-contain" />
              </div>
            )}
            {kind === 'hex' && (
              <pre className="p-3 font-mono text-[11px] leading-relaxed text-content-2">{hex}</pre>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
