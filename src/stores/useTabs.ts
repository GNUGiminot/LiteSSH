import { create } from 'zustand'

export type TabStatus = 'connected' | 'disconnected'
export type TabView = 'term' | 'files'
export type TabKind = 'ssh' | 'pty'
export type SplitDir = 'row' | 'col'

export interface TermTab {
  termId: string
  title: string
  status: TabStatus
  view: TabView
  kind: TabKind
  /** id сессии, к которой относится вкладка (для туннелей); undefined для quick-connect/pty */
  sessionId?: string
  /** SFTP-панель монтируется лениво при первом открытии и остаётся жить. */
  filesOpened: boolean
  /** Панели split view; panes[0] всегда === termId (главная панель). */
  panes: string[]
  splitDir: SplitDir
  /** Синхронный ввод во все панели */
  syncInput: boolean
}

interface TabsState {
  tabs: TermTab[]
  activeId: string | null
  addTab: (tab: Pick<TermTab, 'termId' | 'title' | 'status'> & Partial<Pick<TermTab, 'kind' | 'sessionId'>>) => void
  closeTab: (termId: string) => void
  setActive: (termId: string) => void
  setStatus: (termId: string, status: TabStatus) => void
  setView: (termId: string, view: TabView) => void
  replaceTermId: (oldId: string, newId: string, title?: string) => void
  addPane: (tabId: string, paneId: string) => void
  /** Панель завершилась: в мультипанельной вкладке — убрать (с продвижением главной). */
  paneExited: (paneId: string) => void
  setSplitDir: (tabId: string, dir: SplitDir) => void
  toggleSync: (tabId: string) => void
}

export const useTabs = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,
  addTab: (tab) =>
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          kind: 'ssh',
          ...tab,
          view: 'term',
          filesOpened: false,
          panes: [tab.termId],
          splitDir: 'row',
          syncInput: false
        }
      ],
      activeId: tab.termId
    })),
  closeTab: (termId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.termId !== termId)
      const activeId =
        s.activeId === termId ? (tabs.length ? tabs[tabs.length - 1].termId : null) : s.activeId
      return { tabs, activeId }
    }),
  setActive: (termId) => set({ activeId: termId }),
  setStatus: (termId, status) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.termId === termId ? { ...t, status } : t))
    })),
  setView: (termId, view) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.termId === termId
          ? { ...t, view, filesOpened: t.filesOpened || view === 'files' }
          : t
      )
    })),
  replaceTermId: (oldId, newId, title) =>
    set((s) => ({
      activeId: s.activeId === oldId ? newId : s.activeId,
      tabs: s.tabs.map((t) =>
        t.termId === oldId
          ? {
              ...t,
              termId: newId,
              title: title ?? t.title,
              status: 'connected',
              view: 'term',
              filesOpened: false,
              panes: [newId],
              syncInput: false
            }
          : t
      )
    })),
  addPane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.termId === tabId ? { ...t, panes: [...t.panes, paneId] } : t
      )
    })),
  paneExited: (paneId) =>
    set((s) => {
      let activeId = s.activeId
      const tabs: TermTab[] = []
      for (const t of s.tabs) {
        if (!t.panes.includes(paneId)) {
          tabs.push(t)
          continue
        }
        const panes = t.panes.filter((p) => p !== paneId)
        // одиночная панель отвалилась — оставляем вкладку (покажем «переподключить»)
        if (panes.length === 0) {
          tabs.push(t)
          continue
        }
        // если ушла главная панель — новой главной становится первая оставшаяся
        const termId = panes[0]
        if (activeId === t.termId) activeId = termId
        tabs.push({ ...t, termId, panes })
      }
      return { tabs, activeId }
    }),
  setSplitDir: (tabId, dir) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.termId === tabId ? { ...t, splitDir: dir } : t))
    })),
  toggleSync: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.termId === tabId ? { ...t, syncInput: !t.syncInput } : t))
    }))
}))
