import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ActionId =
  | 'toggleView'
  | 'nextTab'
  | 'prevTab'
  | 'closeTab'
  | 'newLocalTerminal'
  | 'splitPane'
  | 'commandPalette'
  | 'toggleSidebar'
  | 'settings'

export const ACTION_LABELS: Record<ActionId, string> = {
  toggleView: 'Терминал ↔ Файлы',
  nextTab: 'Следующая вкладка',
  prevTab: 'Предыдущая вкладка',
  closeTab: 'Закрыть вкладку',
  newLocalTerminal: 'Новый локальный терминал',
  splitPane: 'Разделить панель (split)',
  commandPalette: 'Палитра команд (сниппеты/история)',
  toggleSidebar: 'Показать/скрыть панель сессий',
  settings: 'Открыть настройки'
}

// Дефолты подобраны так, чтобы НЕ конфликтовать с readline в шелле
// (Ctrl+A/E/B/F/W/K/U/R/L заняты редактированием строки) — используем Ctrl+Shift+… и PageUp/Down.
export const DEFAULT_BINDINGS: Record<ActionId, string> = {
  toggleView: 'Ctrl+Shift+E',
  nextTab: 'Ctrl+PageDown',
  prevTab: 'Ctrl+PageUp',
  closeTab: 'Ctrl+Shift+W',
  newLocalTerminal: 'Ctrl+Shift+T',
  splitPane: 'Ctrl+Shift+D',
  commandPalette: 'Ctrl+Shift+P',
  toggleSidebar: 'Ctrl+Shift+B',
  settings: 'Ctrl+,'
}

interface KeybindingsState {
  bindings: Record<ActionId, string>
  setBinding: (action: ActionId, combo: string) => void
  resetBindings: () => void
}

export const useKeybindings = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: { ...DEFAULT_BINDINGS },
      setBinding: (action, combo) =>
        set((s) => {
          // снимаем комбо с других действий, чтобы не было двух одинаковых
          const bindings = { ...s.bindings }
          for (const k of Object.keys(bindings) as ActionId[]) {
            if (bindings[k] === combo) bindings[k] = ''
          }
          bindings[action] = combo
          return { bindings }
        }),
      resetBindings: () => set({ bindings: { ...DEFAULT_BINDINGS } })
    }),
    {
      name: 'litessh-keybindings',
      // при добавлении новых действий подмешиваем дефолты
      merge: (persisted, current) => {
        const p = persisted as Partial<KeybindingsState> | undefined
        return {
          ...current,
          bindings: { ...DEFAULT_BINDINGS, ...(p?.bindings ?? {}) }
        }
      }
    }
  )
)
