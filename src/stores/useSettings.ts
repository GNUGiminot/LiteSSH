import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SettingsState {
  fontSize: number
  termTheme: string
  accent: string
  /** Палитра интерфейса из UI_THEMES; 'default' — штатная светлая/тёмная */
  uiTheme: string
  /** Автоблокировка хранилища через N минут неактивности; 0 = выключено */
  autoLockMinutes: number
  setFontSize: (v: number) => void
  setTermTheme: (v: string) => void
  setAccent: (v: string) => void
  setUiTheme: (v: string) => void
  setAutoLockMinutes: (v: number) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      fontSize: 13,
      termTheme: 'github-dark',
      accent: '#3B82F6',
      uiTheme: 'default',
      autoLockMinutes: 15,
      setFontSize: (fontSize) => set({ fontSize }),
      setTermTheme: (termTheme) => set({ termTheme }),
      setAccent: (accent) => set({ accent }),
      setUiTheme: (uiTheme) => set({ uiTheme }),
      setAutoLockMinutes: (autoLockMinutes) => set({ autoLockMinutes })
    }),
    { name: 'litessh-settings' }
  )
)
