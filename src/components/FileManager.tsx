import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { FilePanel, type PanelState } from './FilePanel'
import { TransferQueue } from './TransferQueue'
import { useToasts } from '@/stores/useToasts'
import { useTextPrompt } from '@/stores/useTextPrompt'
import { confirmAsync, useConfirm } from '@/stores/useConfirm'
import { useContextMenu, type MenuItem } from '@/stores/useContextMenu'
import { useTransfers } from '@/stores/useTransfers'
import { usePreview } from '@/stores/usePreview'
import type { FileEntry } from '@shared/types'

interface Props {
  termId: string
  active: boolean
}

function posixParent(p: string): string {
  if (p === '/' || !p) return '/'
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function winJoin(dir: string, name: string): string {
  return dir.endsWith('\\') ? dir + name : `${dir}\\${name}`
}

const EMPTY_PANEL: PanelState = { path: '', entries: [], selection: new Set() }

export function FileManager({ termId, active }: Props) {
  const [local, setLocal] = useState<PanelState>(EMPTY_PANEL)
  const [remote, setRemote] = useState<PanelState>(EMPTY_PANEL)
  const [focused, setFocused] = useState<'local' | 'remote'>('remote')
  const push = useToasts((s) => s.push)
  const ask = useTextPrompt((s) => s.ask)
  const showMenu = useContextMenu((s) => s.show)
  const completedTick = useTransfers((s) => s.completedTick)
  const initedRef = useRef(false)

  const loadLocal = useCallback(async (path: string) => {
    const res = await window.api.fs.list(path)
    setLocal((s) => ({
      ...s,
      path: res.ok ? (res.path ?? path) : s.path,
      entries: res.ok ? (res.entries ?? []) : s.entries,
      selection: new Set(),
      error: res.ok ? undefined : res.error
    }))
  }, [])

  const loadRemote = useCallback(
    async (path: string) => {
      const res = await window.api.sftp.list(termId, path)
      setRemote((s) => ({
        ...s,
        path: res.ok ? (res.path ?? path) : s.path,
        entries: res.ok ? (res.entries ?? []) : s.entries,
        selection: new Set(),
        error: res.ok ? undefined : res.error
      }))
    },
    [termId]
  )

  useEffect(() => {
    if (!active || initedRef.current) return
    initedRef.current = true
    void window.api.fs.home().then((h) => loadLocal(h))
    void window.api.sftp.open(termId).then((res) => {
      if (res.ok) {
        setRemote((s) => ({
          ...s,
          path: res.path ?? '/',
          entries: res.entries ?? [],
          selection: new Set()
        }))
      } else {
        setRemote((s) => ({ ...s, error: res.error }))
      }
    })
  }, [active, termId, loadLocal])

  // авто-обновление панелей после завершения передач
  const lastTick = useRef(completedTick)
  useEffect(() => {
    if (completedTick !== lastTick.current && initedRef.current) {
      lastTick.current = completedTick
      void loadLocal(local.path)
      void loadRemote(remote.path)
    }
  }, [completedTick, loadLocal, loadRemote, local.path, remote.path])

  // ---- операции ----

  const uploadSelected = async () => {
    const paths = [...local.selection].map((name) =>
      local.entries.find((e) => e.name === name)!.path
    )
    if (!paths.length) return push('info', 'Выберите файлы в локальной панели')
    const res = await window.api.sftp.upload(termId, paths, remote.path)
    if (!res.ok) push('error', res.error ?? 'Ошибка загрузки')
  }

  const downloadSelected = async () => {
    const items = [...remote.selection].map((name) => {
      const e = remote.entries.find((x) => x.name === name)!
      return { path: e.path, isDir: e.isDir }
    })
    if (!items.length) return push('info', 'Выберите файлы в удалённой панели')
    if (!local.path) return push('error', 'Откройте локальную директорию')
    const res = await window.api.sftp.download(termId, items, local.path)
    if (!res.ok) push('error', res.error ?? 'Ошибка скачивания')
  }

  const dropUpload = (files: FileList) => {
    const paths: string[] = []
    for (const f of Array.from(files)) {
      const p = window.api.getPathForFile(f)
      if (p) paths.push(p)
    }
    if (paths.length) {
      void window.api.sftp.upload(termId, paths, remote.path).then((res) => {
        if (!res.ok) push('error', res.error ?? 'Ошибка загрузки')
      })
    }
  }

  const opResult = (promise: Promise<{ ok: boolean; error?: string }>, refresh: () => void) => {
    void promise.then((res) => {
      if (res.ok) refresh()
      else push('error', res.error ?? 'Ошибка операции')
    })
  }

  const localMkdir = () =>
    void ask('Имя новой папки').then((name) => {
      if (name) opResult(window.api.fs.mkdir(winJoin(local.path, name)), () => void loadLocal(local.path))
    })
  const remoteMkdir = () =>
    void ask('Имя новой папки').then((name) => {
      if (name)
        opResult(window.api.sftp.mkdir(termId, posixJoin(remote.path, name)), () =>
          void loadRemote(remote.path)
        )
    })

  // ---- действия по F-клавишам (в стиле mc), над активной панелью ----

  const firstSelected = (): FileEntry | undefined => {
    const st = focused === 'local' ? local : remote
    const name = [...st.selection][0]
    return name ? st.entries.find((e) => e.name === name) : undefined
  }

  const fView = () => {
    const e = firstSelected()
    if (!e) return push('info', 'Выберите файл')
    if (focused === 'remote') {
      if (e.isDir || e.isLink) void loadRemote(e.path)
      else usePreview.getState().show(termId, e.path, e.name)
    } else if (e.isDir) void loadLocal(e.path)
    else window.api.fs.reveal(e.path)
  }

  const fCopy = () => (focused === 'local' ? void uploadSelected() : void downloadSelected())

  const fMkdir = () => (focused === 'local' ? localMkdir() : remoteMkdir())

  const fDelete = () => {
    const st = focused === 'local' ? local : remote
    const names = [...st.selection]
    if (!names.length) return push('info', 'Выберите файлы для удаления')
    void confirmAsync(
      `Удалить выбранное (${names.length} шт.)${focused === 'remote' ? ', папки рекурсивно' : ''}?`
    ).then((yes) => {
      if (yes) deleteNames(st, names)
    })
  }

  const deleteNames = (st: PanelState, names: string[]) => {
    for (const name of names) {
      const e = st.entries.find((x) => x.name === name)
      if (!e) continue
      if (focused === 'local') opResult(window.api.fs.remove(e.path), () => void loadLocal(local.path))
      else opResult(window.api.sftp.remove(termId, e.path, e.isDir), () => void loadRemote(remote.path))
    }
  }

  // F-клавиши работают, только когда открыт файловый менеджер этой вкладки
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (usePreview.getState().open || useTextPrompt.getState().open) return
      if (useConfirm.getState().open) return
      const map: Record<string, () => void> = {
        F3: fView,
        F4: fView,
        F5: fCopy,
        F7: fMkdir,
        F8: fDelete,
        Delete: fDelete
      }
      const fn = map[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focused, local, remote])

  // ---- контекстные меню ----

  const localMenu = (entry: FileEntry): MenuItem[] => [
    { label: 'Загрузить на сервер', action: () => void uploadSelected() },
    {
      label: 'Переименовать',
      action: () => {
        void ask('Новое имя', { initial: entry.name }).then((name) => {
          if (name && name !== entry.name)
            opResult(window.api.fs.rename(entry.path, winJoin(local.path, name)), () =>
              void loadLocal(local.path)
            )
        })
      }
    },
    { label: 'Показать в проводнике', action: () => window.api.fs.reveal(entry.path) },
    { label: 'Копировать путь', action: () => void navigator.clipboard.writeText(entry.path) },
    {
      label: 'Удалить',
      danger: true,
      action: () => {
        void confirmAsync(`Удалить «${entry.name}»?`).then((yes) => {
          if (yes) opResult(window.api.fs.remove(entry.path), () => void loadLocal(local.path))
        })
      }
    }
  ]

  const remoteMenu = (entry: FileEntry): MenuItem[] => [
    ...(!entry.isDir
      ? [
          {
            label: 'Открыть / редактировать',
            action: () => usePreview.getState().show(termId, entry.path, entry.name)
          }
        ]
      : []),
    { label: 'Скачать', action: () => void downloadSelected() },
    {
      label: 'Переименовать',
      action: () => {
        void ask('Новое имя', { initial: entry.name }).then((name) => {
          if (name && name !== entry.name)
            opResult(
              window.api.sftp.rename(termId, entry.path, posixJoin(remote.path, name)),
              () => void loadRemote(remote.path)
            )
        })
      }
    },
    {
      label: 'Права (chmod)…',
      action: () => {
        const current = entry.mode !== undefined ? entry.mode.toString(8).padStart(3, '0') : '644'
        void ask(`chmod для ${entry.name}`, { initial: current, placeholder: '644' }).then(
          (mode) => {
            if (mode)
              opResult(window.api.sftp.chmod(termId, entry.path, mode), () =>
                void loadRemote(remote.path)
              )
          }
        )
      }
    },
    { label: 'Копировать путь', action: () => void navigator.clipboard.writeText(entry.path) },
    {
      label: 'Удалить',
      danger: true,
      action: () => {
        void confirmAsync(`Удалить «${entry.name}»${entry.isDir ? ' (рекурсивно)' : ''}?`).then(
          (yes) => {
            if (yes)
              opResult(window.api.sftp.remove(termId, entry.path, entry.isDir), () =>
                void loadRemote(remote.path)
              )
          }
        )
      }
    }
  ]

  const transferBtn =
    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1'

  const fnKeys: { key: string; label: string; action: () => void }[] = [
    { key: 'F3', label: 'Просмотр', action: fView },
    { key: 'F4', label: 'Правка', action: fView },
    { key: 'F5', label: focused === 'local' ? 'Копир →' : 'Копир ←', action: fCopy },
    { key: 'F7', label: 'Папка', action: fMkdir },
    { key: 'F8', label: 'Удалить', action: fDelete }
  ]

  return (
    <div className={`flex h-full flex-col bg-surface-0 ${active ? '' : 'hidden'}`}>
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-w-0 flex-1 ${focused === 'local' ? 'ring-1 ring-inset ring-accent/40' : ''}`}
          onMouseDown={() => setFocused('local')}
        >
          <FilePanel
            title="Локально"
            state={local}
            extraActions={
              <button className={transferBtn} title="Загрузить выбранное на сервер" onClick={() => void uploadSelected()}>
                <Upload size={12} /> На сервер
              </button>
            }
            onNavigate={(p) => void loadLocal(p)}
            onUp={() => {
              if (!local.path) return
              if (/^[A-Za-z]:\\?$/.test(local.path)) return void loadLocal('')
              let parent = local.path.replace(/[\\/][^\\/]+[\\/]?$/, '') || local.path
              if (/^[A-Za-z]:$/.test(parent)) parent += '\\'
              void loadLocal(parent)
            }}
            onRefresh={() => void loadLocal(local.path)}
            onMkdir={localMkdir}
            onOpen={(entry) => {
              if (entry.isDir) void loadLocal(entry.path)
              else window.api.fs.reveal(entry.path)
            }}
            onSelectionChange={(sel) => {
              setFocused('local')
              setLocal((s) => ({ ...s, selection: sel }))
            }}
            onEntryContextMenu={(entry, x, y) => {
              setFocused('local')
              showMenu(x, y, localMenu(entry))
            }}
          />
        </div>
        <div className="w-px shrink-0 bg-surface-3" />
        <div
          className={`flex min-w-0 flex-1 ${focused === 'remote' ? 'ring-1 ring-inset ring-accent/40' : ''}`}
          onMouseDown={() => setFocused('remote')}
        >
          <FilePanel
            title="Сервер"
            state={remote}
            showPerms
            extraActions={
              <button className={transferBtn} title="Скачать выбранное" onClick={() => void downloadSelected()}>
                <Download size={12} /> Скачать
              </button>
            }
            onNavigate={(p) => void loadRemote(p)}
            onUp={() => void loadRemote(posixParent(remote.path))}
            onRefresh={() => void loadRemote(remote.path)}
            onMkdir={remoteMkdir}
            onOpen={(entry) => {
              if (entry.isDir || entry.isLink) void loadRemote(entry.path)
              else usePreview.getState().show(termId, entry.path, entry.name)
            }}
            onSelectionChange={(sel) => {
              setFocused('remote')
              setRemote((s) => ({ ...s, selection: sel }))
            }}
            onEntryContextMenu={(entry, x, y) => {
              setFocused('remote')
              showMenu(x, y, remoteMenu(entry))
            }}
            onDropFiles={dropUpload}
          />
        </div>
      </div>

      {/* mc-стиль: панель функциональных клавиш (действует над активной панелью) */}
      <div className="flex shrink-0 items-stretch gap-px border-t border-surface-3 bg-surface-2 text-[11px]">
        <span className="flex items-center px-2 text-[10px] text-content-3">
          Активна: {focused === 'local' ? 'Локально' : 'Сервер'}
        </span>
        {fnKeys.map((f) => (
          <button
            key={f.key}
            onClick={f.action}
            className="flex flex-1 items-center justify-center gap-1 py-1 text-content-2 transition-colors hover:bg-surface-3 hover:text-content-1"
          >
            <span className="font-mono font-semibold text-accent">{f.key}</span>
            {f.label}
          </button>
        ))}
      </div>

      <TransferQueue />
    </div>
  )
}
