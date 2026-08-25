import { useTabs } from '@/stores/useTabs'
import { useSessions } from '@/stores/useSessions'

export function StatusBar() {
  const { tabs, activeId } = useTabs()
  const sessions = useSessions((s) => s.sessions)
  const active = tabs.find((t) => t.termId === activeId)
  const connected = tabs.filter((t) => t.status === 'connected').length

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-surface-3 bg-surface-1 px-3 text-[11px] text-content-2">
      <div className="flex items-center gap-3">
        {active ? (
          <>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                active.status === 'connected' ? 'bg-emerald-500' : 'bg-red-500'
              }`}
            />
            <span>{active.title}</span>
            <span className="text-content-3">
              {active.status === 'connected' ? 'подключено' : 'отключено'}
            </span>
          </>
        ) : (
          <span className="text-content-3">нет активных подключений</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-content-3">
        <span>сессий: {sessions.length}</span>
        <span>активных: {connected}</span>
        <span>LiteSSH 1.0.1</span>
      </div>
    </footer>
  )
}
