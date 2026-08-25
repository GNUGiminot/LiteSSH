import { create } from 'zustand'

// Нативный window.confirm() в Electron показывает блокирующее модальное окно ОС,
// после закрытия которого webContents теряет клавиатурный фокус: поля ввода
// перестают принимать текст до перезапуска приложения. Поэтому подтверждения
// делаем своим диалогом (по образцу useTextPrompt).

interface ConfirmState {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  danger: boolean
  _resolve: ((value: boolean) => void) | null
  ask: (
    message: string,
    opts?: { title?: string; confirmLabel?: string; danger?: boolean }
  ) => Promise<boolean>
  close: (value: boolean) => void
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  open: false,
  title: '',
  message: '',
  confirmLabel: 'Удалить',
  danger: true,
  _resolve: null,
  ask: (message, opts) =>
    new Promise<boolean>((resolve) => {
      get()._resolve?.(false)
      set({
        open: true,
        message,
        title: opts?.title ?? 'Подтверждение',
        confirmLabel: opts?.confirmLabel ?? 'Удалить',
        danger: opts?.danger ?? true,
        _resolve: resolve
      })
    }),
  close: (value) => {
    get()._resolve?.(value)
    set({ open: false, _resolve: null })
  }
}))

/** Короткий хелпер для обработчиков: `if (await confirmAsync('Удалить X?')) …` */
export const confirmAsync = (
  message: string,
  opts?: { title?: string; confirmLabel?: string; danger?: boolean }
): Promise<boolean> => useConfirm.getState().ask(message, opts)
