import { useState } from 'react'
import { Keyboard, RotateCcw } from 'lucide-react'
import { useKeybindings, ACTION_LABELS, type ActionId } from '@/stores/useKeybindings'
import { comboFromEvent, prettyCombo } from '@/lib/keys'

export function KeybindingsSection() {
  const { bindings, setBinding, resetBindings } = useKeybindings()
  const [capturing, setCapturing] = useState<ActionId | null>(null)

  const onCapture = (e: React.KeyboardEvent, action: ActionId) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setCapturing(null)
      return
    }
    const combo = comboFromEvent(e.nativeEvent)
    if (combo) {
      setBinding(action, combo)
      setCapturing(null)
    }
  }

  return (
    <div className="border-t border-surface-3 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-content-1">
          <Keyboard size={13} className="text-accent" /> Горячие клавиши
        </div>
        <button
          onClick={resetBindings}
          title="Сбросить к значениям по умолчанию"
          className="flex items-center gap-1 rounded p-1 text-[10px] text-content-2 hover:bg-surface-2 hover:text-content-1"
        >
          <RotateCcw size={11} /> Сбросить
        </button>
      </div>
      <div className="space-y-1">
        {(Object.keys(ACTION_LABELS) as ActionId[]).map((action) => (
          <div key={action} className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-content-2">{ACTION_LABELS[action]}</span>
            <button
              onClick={() => setCapturing(action)}
              onKeyDown={capturing === action ? (e) => onCapture(e, action) : undefined}
              className={`min-w-28 rounded-md border px-2 py-1 text-center font-mono text-[11px] ${
                capturing === action
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-surface-3 bg-surface-0 text-content-1 hover:border-accent'
              }`}
            >
              {capturing === action
                ? 'Нажмите клавиши…'
                : bindings[action]
                  ? prettyCombo(bindings[action])
                  : '—'}
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-content-3">
        Кликните по сочетанию и нажмите новую комбинацию (Esc — отмена). Комбо с Ctrl+Shift выбраны,
        чтобы не конфликтовать с редактированием строки в шелле.
      </p>
    </div>
  )
}
