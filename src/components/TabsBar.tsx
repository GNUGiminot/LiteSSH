import { X } from 'lucide-react'
import { useTabs } from '@/stores/useTabs'

export function TabsBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()

  if (!tabs.length) return null

  const close = (termId: string) => {
    const tab = tabs.find((t) => t.termId === termId)
    if (!tab) return
    // закрываем все панели вкладки (split view), иначе shell-каналы осиротеют
    for (const paneId of tab.panes) {
      if (tab.kind === 'pty') window.api.pty.close(paneId)
      else window.api.ssh.close(paneId)
    }
    closeTab(termId)
  }

  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-surface-3 bg-surface-1 px-1.5">
      {tabs.map((tab) => (
        <div
          key={tab.termId}
          onClick={() => setActive(tab.termId)}
          onAuxClick={(e) => {
            if (e.button === 1) close(tab.termId)
          }}
          className={`group flex h-8 max-w-52 cursor-pointer items-center gap-2 rounded-t-md border-x border-t px-3 text-xs transition-colors ${
            tab.termId === activeId
              ? 'border-surface-3 bg-[#0d1117] text-content-1'
              : 'border-transparent bg-transparent text-content-2 hover:bg-surface-2'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              tab.status === 'connected' ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          />
          <span className="truncate">{tab.title}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              close(tab.termId)
            }}
            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
