import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { RotateCw, X } from 'lucide-react'
import { useTabs } from '@/stores/useTabs'
import { useSettings } from '@/stores/useSettings'
import { TERM_THEMES } from '@/lib/termThemes'
import { reconnectTab } from '@/lib/connect'

interface Props {
  termId: string
  active: boolean
  /** 'ssh' — удалённая сессия (по умолчанию); 'pty' — локальный терминал */
  kind?: 'ssh' | 'pty'
  /** Синхронный ввод: писать введённое во все панели `siblings` */
  syncInput?: boolean
  /** Все termId панелей вкладки (для синхронного ввода) */
  siblings?: string[]
}

export function TerminalView({ termId, active, kind = 'ssh', syncInput = false, siblings }: Props) {
  const status = useTabs((s) => s.tabs.find((t) => t.termId === termId)?.status)
  const canReconnect = useTabs((s) => {
    const t = s.tabs.find((x) => x.termId === termId)
    return !!t?.sessionId && kind === 'ssh'
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const syncRef = useRef(syncInput)
  const siblingsRef = useRef<string[] | undefined>(siblings)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const fontSize = useSettings((s) => s.fontSize)
  const termTheme = useSettings((s) => s.termTheme)
  const themeObj = (TERM_THEMES[termTheme] ?? TERM_THEMES['github-dark']).theme

  syncRef.current = syncInput
  siblingsRef.current = siblings

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const io =
      kind === 'pty'
        ? {
            write: window.api.pty.write,
            resize: window.api.pty.resize,
            onData: window.api.pty.onData,
            onExit: (cb: (id: string, msg?: string) => void) =>
              window.api.pty.onExit((id) => cb(id))
          }
        : {
            write: window.api.ssh.write,
            resize: window.api.ssh.resize,
            onData: window.api.term.onData,
            onExit: window.api.term.onExit
          }

    const settings = useSettings.getState()
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace',
      fontSize: settings.fontSize,
      theme: (TERM_THEMES[settings.termTheme] ?? TERM_THEMES['github-dark']).theme,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    fitRef.current = fit
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // Ссылки в терминале открываем в системном браузере (а не во встроенном окне)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.api.openExternal(uri)))
    term.open(el)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* canvas fallback */
    }
    termRef.current = term
    searchRef.current = search

    const copySelection = () => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
    }
    const paste = () => {
      void navigator.clipboard.readText().then((text) => {
        if (text) io.write(termId, text)
      })
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.code === 'KeyC') {
        copySelection()
        return false
      }
      if (mod && e.shiftKey && e.code === 'KeyV') {
        paste()
        return false
      }
      if (mod && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
        copySelection()
        term.clearSelection()
        return false
      }
      if (mod && !e.shiftKey && e.code === 'KeyV') {
        paste()
        return false
      }
      if (mod && e.shiftKey && e.code === 'KeyF') {
        setSearchOpen(true)
        return false
      }
      return true
    })

    // Грубая реконструкция вводимых команд для истории: копим печатные символы,
    // на Enter коммитим строку. ESC/управляющие последовательности (стрелки и т.п.)
    // сбрасывают буфер, чтобы не писать в историю мусор.
    let cmdBuf = ''
    const captureInput = (data: string) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data.charCodeAt(i)
        if (ch === 0x0d || ch === 0x0a) {
          const cmd = cmdBuf.trim()
          if (cmd) window.api.history.add(cmd)
          cmdBuf = ''
        } else if (ch === 0x7f || ch === 0x08) {
          cmdBuf = cmdBuf.slice(0, -1)
        } else if (ch === 0x1b || ch === 0x03 || ch === 0x15) {
          cmdBuf = '' // ESC-последовательность, Ctrl+C, Ctrl+U — считаем строку испорченной
        } else if (ch >= 0x20) {
          cmdBuf += data[i]
        }
      }
    }

    term.onData((data) => {
      if (kind === 'ssh') captureInput(data)
      // синхронный ввод: транслируем во все панели вкладки
      if (syncRef.current && kind === 'ssh' && siblingsRef.current?.length) {
        for (const sib of siblingsRef.current) io.write(sib, data)
      } else {
        io.write(termId, data)
      }
    })
    term.onResize(({ cols, rows }) => io.resize(termId, cols, rows))

    const offData = io.onData((id, data) => {
      if (id === termId) term.write(data)
    })
    const offExit = io.onExit((id, message) => {
      if (id !== termId) return
      const label = kind === 'pty' ? 'Терминал закрыт' : 'Соединение закрыто'
      term.write(`\r\n\x1b[1;31m[${label}${message ? ': ' + message : ''}]\x1b[0m\r\n`)
    })

    const doFit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
    }
    doFit()
    const ro = new ResizeObserver(doFit)
    ro.observe(el)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
    }
  }, [termId, kind])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  // живое применение настроек к открытым терминалам
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.theme = themeObj
    fitRef.current?.fit()
  }, [fontSize, themeObj])

  const findNext = () => {
    if (query) searchRef.current?.findNext(query)
  }

  return (
    <div
      style={{ background: themeObj.background }}
      className={`relative h-full w-full ${active ? '' : 'hidden'}`}
    >
      {searchOpen && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-surface-3 bg-surface-1 px-2 py-1 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') findNext()
              if (e.key === 'Escape') {
                setSearchOpen(false)
                termRef.current?.focus()
              }
            }}
            placeholder="Поиск…"
            className="w-44 bg-transparent text-xs text-content-1 outline-none placeholder:text-content-3"
          />
          <button
            onClick={() => {
              setSearchOpen(false)
              termRef.current?.focus()
            }}
            className="rounded p-0.5 text-content-2 hover:bg-surface-2"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {status === 'disconnected' && canReconnect && (
        <button
          onClick={() => void reconnectTab(termId)}
          className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-accent-hover"
        >
          <RotateCw size={13} /> Переподключить
        </button>
      )}
      <div ref={containerRef} className="h-full w-full p-1" />
    </div>
  )
}
