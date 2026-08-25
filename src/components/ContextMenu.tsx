import { useContextMenu } from '@/stores/useContextMenu'

export function ContextMenu() {
  const { x, y, items, hide } = useContextMenu()
  if (!items) return null

  const menuW = 190
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16)

  return (
    <div className="fixed inset-0 z-50" onMouseDown={hide} onContextMenu={(e) => e.preventDefault()}>
      <div
        style={{ left, top, width: menuW }}
        className="absolute rounded-lg border border-surface-3 bg-surface-1 py-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <button
            key={i}
            onClick={() => {
              hide()
              item.action()
            }}
            className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
              item.danger ? 'text-red-400' : 'text-content-1'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
