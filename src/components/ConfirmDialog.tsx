import * as Dialog from '@radix-ui/react-dialog'
import { useConfirm } from '@/stores/useConfirm'

export function ConfirmDialog() {
  const { open, title, message, confirmLabel, danger, close } = useConfirm()

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && close(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl"
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(true)
          }}
        >
          <Dialog.Title className="mb-2 text-sm font-semibold text-content-1">{title}</Dialog.Title>
          <p className="whitespace-pre-line text-xs leading-relaxed text-content-2">{message}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => close(false)}
              className="rounded-md px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
            >
              Отмена
            </button>
            <button
              autoFocus
              onClick={() => close(true)}
              className={`rounded-md px-4 py-1.5 text-xs font-medium text-white ${
                danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:bg-accent-hover'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
