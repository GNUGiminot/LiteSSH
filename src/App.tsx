import { useEffect, useState } from 'react'
import {
  Activity,
  ArrowRightLeft,
  Columns2,
  FileTerminal,
  FileText,
  FolderTree,
  MonitorUp,
  KeyRound,
  Link2,
  Moon,
  PanelLeft,
  Rows2,
  Settings2,
  ShieldCheck,
  SplitSquareHorizontal,
  SquarePlus,
  SquareTerminal,
  Sun,
  TerminalSquare,
  Unlink,
  X
} from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TabsBar } from '@/components/TabsBar'
import { TerminalView } from '@/components/TerminalView'
import { FileManager } from '@/components/FileManager'
import { QuickConnect } from '@/components/QuickConnect'
import { StatusBar } from '@/components/StatusBar'
import { Toasts } from '@/components/Toasts'
import { SessionDialog } from '@/components/SessionDialog'
import { HostKeyDialog } from '@/components/HostKeyDialog'
import { PasswordPromptDialog } from '@/components/PasswordPromptDialog'
import { TextPromptDialog } from '@/components/TextPromptDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ContextMenu } from '@/components/ContextMenu'
import { KeysDialog } from '@/components/KeysDialog'
import { PreviewDialog } from '@/components/PreviewDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { SnippetsPalette } from '@/components/SnippetsPalette'
import { TunnelsDialog } from '@/components/TunnelsDialog'
import { KnownHostsDialog } from '@/components/KnownHostsDialog'
import { MetricsDialog } from '@/components/MetricsDialog'
import { ScriptsDialog } from '@/components/ScriptsDialog'
import { LocalShellMenu } from '@/components/LocalShellMenu'
import { LockScreen } from '@/components/LockScreen'
import { ConnectProgress } from '@/components/ConnectProgress'
import { useConnectProgress } from '@/stores/useConnectProgress'
import { splitActivePane, openLocalTerminal } from '@/lib/connect'
import { comboFromEvent } from '@/lib/keys'
import { useKeybindings, type ActionId } from '@/stores/useKeybindings'
import { useSessions } from '@/stores/useSessions'
import { useSettings } from '@/stores/useSettings'
import { useTabs } from '@/stores/useTabs'
import { useTransfers } from '@/stores/useTransfers'
import { useToasts } from '@/stores/useToasts'
import { useVault } from '@/stores/useVault'
import type { SessionProfile } from '@shared/types'

function hexToRgb(hex: string): string {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

function darken(hex: string, factor = 0.82): string {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16)
  const r = Math.round(((n >> 16) & 255) * factor)
  const g = Math.round(((n >> 8) & 255) * factor)
  const b = Math.round((n & 255) * factor)
  return `${r} ${g} ${b}`
}

export default function App() {
  const loadSessions = useSessions((s) => s.load)
  const { tabs, activeId, setView } = useTabs()
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tunnelsOpen, setTunnelsOpen] = useState(false)
  const [knownHostsOpen, setKnownHostsOpen] = useState(false)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [scriptsOpen, setScriptsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editing, setEditing] = useState<SessionProfile | null>(null)
  const [logging, setLogging] = useState(false)
  const accent = useSettings((s) => s.accent)

  const activeTab = tabs.find((t) => t.termId === activeId)

  useEffect(() => {
    if (activeTab?.kind === 'ssh') {
      void window.api.ssh.isLogging(activeTab.termId).then(setLogging)
    } else {
      setLogging(false)
    }
  }, [activeId, activeTab?.kind, activeTab?.termId])

  const toggleLog = async () => {
    if (!activeTab) return
    const res = await window.api.ssh.toggleLog(activeTab.termId)
    if (res.ok) setLogging(!!res.logging)
  }

  const openRdp = async () => {
    if (activeTab?.kind !== 'ssh') return
    const res = await window.api.rdp.open(activeTab.termId)
    if (!res.ok) {
      useToasts.getState().push('error', res.error ?? 'Не удалось открыть RDP')
    } else if (res.manual) {
      useToasts
        .getState()
        .push('info', `Туннель поднят: 127.0.0.1:${res.port} → :3389. Подключитесь своим RDP-клиентом.`)
    } else {
      useToasts.getState().push('success', `RDP-туннель 127.0.0.1:${res.port} → :3389, запускаю mstsc…`)
    }
  }

  useEffect(() => {
    void loadSessions()
    void useVault.getState().refresh()
  }, [loadSessions])

  // Перечитываем список сессий при возврате фокуса окну (актуально после сворачивания
  // в трей или правок в другом окне) — чтобы UI не показывал устаревший кэш.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadSessions()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadSessions])

  // Автоблокировка хранилища по неактивности (только в режиме мастер-пароля)
  const autoLockMinutes = useSettings((st) => st.autoLockMinutes)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      const v = useVault.getState()
      if (v.mode !== 'master' || v.locked || autoLockMinutes <= 0) return
      timer = setTimeout(
        () => {
          void window.api.vault.lock().then(() => useVault.getState().setLocked(true))
        },
        autoLockMinutes * 60_000
      )
    }
    const onActivity = () => arm()
    window.addEventListener('mousemove', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('mousedown', onActivity)
    arm()
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('mousedown', onActivity)
    }
  }, [autoLockMinutes])

  useEffect(() => {
    return window.api.transfer.onUpdate((info) => {
      useTransfers.getState().update(info)
      if ((info.status === 'done' || info.status === 'error') && !document.hasFocus()) {
        new Notification('LiteSSH', {
          body:
            info.status === 'done'
              ? `${info.direction === 'upload' ? 'Загружено' : 'Скачано'}: ${info.name}`
              : `Ошибка передачи ${info.name}: ${info.error ?? ''}`
        })
      }
    })
  }, [])

  useEffect(() => {
    const handlePaneExit = (paneId: string) => {
      const tab = useTabs.getState().tabs.find((t) => t.panes.includes(paneId))
      if (!tab) return
      if (tab.panes.length > 1) {
        // одна из панелей split view закрылась — убираем её из раскладки
        useTabs.getState().paneExited(paneId)
      } else {
        // отвалилась единственная панель — оставляем вкладку с кнопкой «переподключить»
        useTabs.getState().setStatus(tab.termId, 'disconnected')
        if (!document.hasFocus())
          new Notification('LiteSSH', { body: `Сессия «${tab.title}» завершена` })
      }
    }
    const offSsh = window.api.term.onExit(handlePaneExit)
    const offPty = window.api.pty.onExit(handlePaneExit)
    return () => {
      offSsh()
      offPty()
    }
  }, [])

  // Анимация стадий подключения
  useEffect(() => {
    return window.api.term.onProgress((p) => {
      useConnectProgress.getState().setStage(p.attemptId, p.stage, p.status, p.error)
    })
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--accent', hexToRgb(accent))
    root.style.setProperty('--accent-hover', darken(accent))
  }, [accent])

  useEffect(() => {
    const runAction = (action: ActionId) => {
      const { tabs, activeId, setView, setActive } = useTabs.getState()
      const tab = tabs.find((t) => t.termId === activeId)
      switch (action) {
        case 'toggleView':
          if (tab?.kind === 'ssh') setView(tab.termId, tab.view === 'term' ? 'files' : 'term')
          break
        case 'nextTab':
        case 'prevTab': {
          if (tabs.length < 2) break
          const i = tabs.findIndex((t) => t.termId === activeId)
          const d = action === 'nextTab' ? 1 : -1
          setActive(tabs[(i + d + tabs.length) % tabs.length].termId)
          break
        }
        case 'closeTab':
          if (tab) {
            for (const p of tab.panes) {
              if (tab.kind === 'pty') window.api.pty.close(p)
              else window.api.ssh.close(p)
            }
            useTabs.getState().closeTab(tab.termId)
          }
          break
        case 'newLocalTerminal':
          void window.api.pty.shells().then((sh) => {
            if (sh[0]) void openLocalTerminal(sh[0].cmd)
          })
          break
        case 'splitPane':
          void splitActivePane()
          break
        case 'commandPalette':
          setPaletteOpen((v) => !v)
          break
        case 'toggleSidebar':
          setSidebarVisible((v) => !v)
          break
        case 'settings':
          setSettingsOpen(true)
          break
      }
    }

    const onKey = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e)
      if (!combo) return
      const { bindings } = useKeybindings.getState()
      const entry = (Object.keys(bindings) as ActionId[]).find((a) => bindings[a] === combo)
      if (entry) {
        e.preventDefault()
        e.stopImmediatePropagation()
        runAction(entry)
      }
    }
    const onPalette = () => setPaletteOpen((v) => !v)
    // capture-фаза: перехватываем до того, как событие уйдёт в xterm
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('litessh:palette', onPalette)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('litessh:palette', onPalette)
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
    window.api.setTitlebarTheme(dark)
  }, [dark])

  const openEditor = (session: SessionProfile | null) => {
    setEditing(session)
    setDialogOpen(true)
  }

  const headerBtn =
    'rounded-md p-1.5 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1'

  return (
    <div className="flex h-full flex-col">
      <header
        className="app-drag flex h-11 shrink-0 items-center gap-2 border-b border-surface-3 bg-surface-1 px-2.5"
        style={
          window.api.platform === 'win32'
            ? { paddingRight: 140 }
            : window.api.platform === 'darwin'
              ? { paddingLeft: 78 }
              : undefined
        }
      >
        <button
          title="Показать/скрыть панель сессий"
          onClick={() => setSidebarVisible((v) => !v)}
          className={headerBtn}
        >
          <PanelLeft size={16} />
        </button>
        <div className="flex items-center gap-1.5 pr-2">
          <TerminalSquare size={17} className="text-accent" />
          <span className="text-sm font-semibold tracking-tight">LiteSSH</span>
        </div>
        <QuickConnect />
        {activeTab?.kind === 'ssh' && (
          <div className="ml-1 flex overflow-hidden rounded-md border border-surface-3">
            <button
              title="Терминал"
              onClick={() => setView(activeTab.termId, 'term')}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${
                activeTab.view === 'term'
                  ? 'bg-accent text-white'
                  : 'text-content-2 hover:bg-surface-2'
              }`}
            >
              <SquareTerminal size={13} /> Терминал
            </button>
            <button
              title="Файловый менеджер (SFTP)"
              onClick={() => setView(activeTab.termId, 'files')}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors ${
                activeTab.view === 'files'
                  ? 'bg-accent text-white'
                  : 'text-content-2 hover:bg-surface-2'
              }`}
            >
              <FolderTree size={13} /> Файлы
            </button>
          </div>
        )}
        <div className="flex-1" />
        <button title="Новое окно" onClick={() => window.api.newWindow()} className={headerBtn}>
          <SquarePlus size={16} />
        </button>
        <LocalShellMenu />
        {activeTab?.kind === 'ssh' && (
          <>
            <button
              title={logging ? 'Остановить журналирование сессии' : 'Записывать сессию в файл'}
              onClick={() => void toggleLog()}
              className={`rounded-md p-1.5 transition-colors hover:bg-surface-2 ${
                logging ? 'text-red-400' : 'text-content-2 hover:text-content-1'
              }`}
            >
              <FileText size={16} />
            </button>
            <button
              title="Метрики хоста (CPU/RAM/диск)"
              onClick={() => setMetricsOpen(true)}
              className={headerBtn}
            >
              <Activity size={16} />
            </button>
            <button title="Туннели" onClick={() => setTunnelsOpen(true)} className={headerBtn}>
              <ArrowRightLeft size={16} />
            </button>
            <button
              title="Открыть удалённый рабочий стол (RDP через SSH)"
              onClick={() => void openRdp()}
              className={headerBtn}
            >
              <MonitorUp size={16} />
            </button>
            <div className="mx-0.5 h-5 w-px bg-surface-3" />
            <button
              title="Разделить панель (ещё один shell на этом соединении)"
              onClick={() => void splitActivePane()}
              className={headerBtn}
            >
              <SplitSquareHorizontal size={16} />
            </button>
            {activeTab.panes.length > 1 && (
              <>
                <button
                  title={activeTab.splitDir === 'row' ? 'Расположить вертикально' : 'Расположить горизонтально'}
                  onClick={() =>
                    useTabs
                      .getState()
                      .setSplitDir(activeTab.termId, activeTab.splitDir === 'row' ? 'col' : 'row')
                  }
                  className={headerBtn}
                >
                  {activeTab.splitDir === 'row' ? <Rows2 size={16} /> : <Columns2 size={16} />}
                </button>
                <button
                  title={activeTab.syncInput ? 'Синхронный ввод включён' : 'Синхронный ввод во все панели'}
                  onClick={() => useTabs.getState().toggleSync(activeTab.termId)}
                  className={`rounded-md p-1.5 transition-colors hover:bg-surface-2 ${
                    activeTab.syncInput ? 'text-accent' : 'text-content-2 hover:text-content-1'
                  }`}
                >
                  {activeTab.syncInput ? <Link2 size={16} /> : <Unlink size={16} />}
                </button>
              </>
            )}
          </>
        )}
        <button
          title="Скрипты / пресеты"
          onClick={() => setScriptsOpen(true)}
          className={headerBtn}
        >
          <FileTerminal size={16} />
        </button>
        <button title="SSH-ключи" onClick={() => setKeysOpen(true)} className={headerBtn}>
          <KeyRound size={16} />
        </button>
        <button
          title="Ключи серверов (known_hosts)"
          onClick={() => setKnownHostsOpen(true)}
          className={headerBtn}
        >
          <ShieldCheck size={16} />
        </button>
        <button title="Настройки" onClick={() => setSettingsOpen(true)} className={headerBtn}>
          <Settings2 size={16} />
        </button>
        <button title="Переключить тему" onClick={() => setDark((d) => !d)} className={headerBtn}>
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar visible={sidebarVisible} onEdit={openEditor} />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabsBar />
          <div className="relative min-h-0 flex-1">
            {tabs.map((tab) => {
              const showTerm = tab.termId === activeId && tab.view === 'term'
              return (
                <div
                  key={tab.termId}
                  className={`absolute inset-0 flex gap-px ${
                    tab.splitDir === 'col' ? 'flex-col' : 'flex-row'
                  } ${showTerm ? '' : 'hidden'}`}
                >
                  {tab.panes.map((paneId) => (
                    <div key={paneId} className="relative min-h-0 min-w-0 flex-1 bg-surface-3">
                      <TerminalView
                        termId={paneId}
                        kind={tab.kind}
                        active={showTerm}
                        syncInput={tab.syncInput}
                        siblings={tab.panes}
                      />
                      {tab.panes.length > 1 && (
                        <button
                          title="Закрыть панель"
                          onClick={() => window.api.ssh.close(paneId)}
                          className="absolute right-1.5 top-1.5 z-10 rounded bg-surface-1/80 p-1 text-content-2 hover:bg-surface-2 hover:text-red-400"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )
            })}
            {tabs
              .filter((t) => t.filesOpened && t.kind === 'ssh')
              .map((tab) => (
                <FileManager
                  key={tab.termId}
                  termId={tab.termId}
                  active={tab.termId === activeId && tab.view === 'files'}
                />
              ))}
            {!tabs.length && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-content-3">
                <TerminalSquare size={44} strokeWidth={1.2} />
                <p className="text-sm">Нет открытых подключений</p>
                <p className="max-w-72 text-center text-xs leading-relaxed">
                  Дважды кликните по сессии слева или введите{' '}
                  <span className="font-mono text-content-2">user@host</span> в строке быстрого
                  подключения
                </p>
              </div>
            )}
          </div>
        </main>
      </div>

      <StatusBar />
      <Toasts />
      <SessionDialog
        open={dialogOpen}
        session={editing}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null) // не держим ссылку на профиль (мог быть удалён из списка)
        }}
      />
      <KeysDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TunnelsDialog open={tunnelsOpen} onClose={() => setTunnelsOpen(false)} />
      <KnownHostsDialog open={knownHostsOpen} onClose={() => setKnownHostsOpen(false)} />
      <ScriptsDialog open={scriptsOpen} onClose={() => setScriptsOpen(false)} />
      <MetricsDialog
        open={metricsOpen}
        termId={activeTab?.kind === 'ssh' ? activeTab.termId : null}
        title={activeTab?.title ?? ''}
        onClose={() => setMetricsOpen(false)}
      />
      <SnippetsPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <PreviewDialog />
      <ConnectProgress />
      <LockScreen />
      <HostKeyDialog />
      <PasswordPromptDialog />
      <TextPromptDialog />
      <ConfirmDialog />
      <ContextMenu />
    </div>
  )
}
