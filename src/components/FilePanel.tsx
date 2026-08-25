import { useState, type DragEvent } from 'react'
import { ArrowUp, FolderPlus, RefreshCw } from 'lucide-react'
import { fileIcon } from '@/lib/fileIcons'
import type { FileEntry } from '@shared/types'
import type { ReactNode } from 'react'

export interface PanelState {
  path: string
  entries: FileEntry[]
  selection: Set<string>
  error?: string
}

interface Props {
  title: string
  state: PanelState
  showPerms?: boolean
  extraActions?: ReactNode
  onNavigate: (path: string) => void
  onUp: () => void
  onRefresh: () => void
  onMkdir: () => void
  onOpen: (entry: FileEntry) => void
  onSelectionChange: (selection: Set<string>) => void
  onEntryContextMenu: (entry: FileEntry, x: number, y: number) => void
  onDropFiles?: (files: FileList) => void
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function FilePanel({
  title,
  state,
  showPerms,
  extraActions,
  onNavigate,
  onUp,
  onRefresh,
  onMkdir,
  onOpen,
  onSelectionChange,
  onEntryContextMenu,
  onDropFiles
}: Props) {
  const [pathInput, setPathInput] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const sorted = [...state.entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const clickEntry = (e: React.MouseEvent, entry: FileEntry) => {
    const next = new Set(e.ctrlKey || e.metaKey ? state.selection : [])
    if (next.has(entry.name)) next.delete(entry.name)
    else next.add(entry.name)
    onSelectionChange(next)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (onDropFiles && e.dataTransfer.files.length) onDropFiles(e.dataTransfer.files)
  }

  const btn =
    'rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1'

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col border-surface-3 ${
        dragOver ? 'ring-2 ring-inset ring-accent' : ''
      }`}
      onDragOver={
        onDropFiles
          ? (e) => {
              e.preventDefault()
              setDragOver(true)
            }
          : undefined
      }
      onDragLeave={onDropFiles ? () => setDragOver(false) : undefined}
      onDrop={onDropFiles ? handleDrop : undefined}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-surface-3 bg-surface-1 px-2">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-content-3">
          {title}
        </span>
        <button className={btn} title="Вверх" onClick={onUp}>
          <ArrowUp size={13} />
        </button>
        <button className={btn} title="Обновить" onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>
        <button className={btn} title="Новая папка" onClick={onMkdir}>
          <FolderPlus size={13} />
        </button>
        {extraActions}
        {pathInput === null ? (
          <button
            onClick={() => setPathInput(state.path)}
            className="ml-1 min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-content-2 hover:bg-surface-2"
            title={state.path || 'Диски'}
          >
            {state.path || 'Диски'}
          </button>
        ) : (
          <input
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onBlur={() => setPathInput(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onNavigate(pathInput)
                setPathInput(null)
              }
              if (e.key === 'Escape') setPathInput(null)
            }}
            spellCheck={false}
            className="ml-1 min-w-0 flex-1 rounded border border-accent bg-surface-0 px-1.5 py-0.5 font-mono text-[11px] text-content-1 outline-none"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" onClick={() => onSelectionChange(new Set())}>
        {state.error && (
          <p className="px-3 py-2 text-xs text-red-400">{state.error}</p>
        )}
        <table className="w-full border-collapse text-xs">
          <tbody>
            {sorted.map((entry) => (
              <tr
                key={entry.name}
                onClick={(e) => {
                  e.stopPropagation()
                  clickEntry(e, entry)
                }}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!state.selection.has(entry.name)) onSelectionChange(new Set([entry.name]))
                  onEntryContextMenu(entry, e.clientX, e.clientY)
                }}
                className={`cursor-default select-none ${
                  state.selection.has(entry.name)
                    ? 'bg-accent/20'
                    : 'odd:bg-surface-0 even:bg-surface-1/40 hover:bg-surface-2'
                }`}
              >
                <td className="w-6 py-1 pl-2">{fileIcon(entry)}</td>
                <td className="max-w-0 truncate py-1 pr-2 text-content-1" title={entry.name}>
                  {entry.name}
                </td>
                {showPerms && (
                  <td className="w-20 py-1 pr-2 text-right font-mono text-[10px] text-content-3">
                    {entry.perms}
                  </td>
                )}
                <td className="w-20 py-1 pr-2 text-right text-content-2">
                  {entry.isDir ? '' : humanSize(entry.size)}
                </td>
                <td className="w-28 whitespace-nowrap py-1 pr-2 text-right text-content-3">
                  {fmtDate(entry.mtime)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state.error && sorted.length === 0 && (
          <p className="px-3 py-3 text-xs text-content-3">Пустая директория</p>
        )}
      </div>
    </div>
  )
}
