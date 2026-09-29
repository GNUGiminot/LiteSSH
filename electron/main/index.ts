import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { registerIpc } from './ipc'
import { closeAll } from './ssh/connection-manager'
import { closeAllPtys, availableShells } from './pty-manager'
import { listSessions, getVaultMeta, closeDb } from './db'
import { loadVaultMeta } from './vault'
import { closeMcpBridge, smokeMcpParallel, smokeMcpProtocol } from './mcp-bridge'
import { flushMcpActivity } from './mcp-activity'

let tray: Tray | null = null
let isQuitting = false
const isSmoke = process.argv.includes('--smoke')

// Smoke не должен использовать рабочую БД или зависеть от GPU/папки профиля пользователя.
if (isSmoke) {
  const smokeData = join(process.cwd(), '.tmp', 'smoke-user-data', String(process.pid))
  mkdirSync(smokeData, { recursive: true })
  app.setPath('userData', smokeData)
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

/** Путь к иконке: dev — build/, prod — распакованный ресурс. */
function iconPath(ext: 'ico' | 'png'): string | undefined {
  const dev = join(__dirname, `../../build/icon.${ext}`)
  if (existsSync(dev)) return dev
  const prod = join(process.resourcesPath, 'icon.png') // в прод кладём только png
  return existsSync(prod) ? prod : undefined
}

// Тёмный титлбар по умолчанию; renderer уточнит цвет под тему через IPC
const DARK_OVERLAY = { color: '#161b22', symbolColor: '#8b949e', height: 44 }

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'LiteSSH',
    icon: iconPath('ico') ?? iconPath('png'),
    // Кастомный титлбар: системные кнопки рисует ОС (overlay), контент занимает всю высоту
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: DARK_OVERLAY }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Ссылки из терминала (xterm web-links) и любые window.open открываем в системном
  // браузере, а НЕ в «голом» Electron-окне (иначе внешние SPA ломаются, да и небезопасно).
  const openExternal = (url: string): boolean => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url)
      return true
    }
    return false
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // Никогда не даём главному окну уйти со своей страницы на внешний адрес
  win.webContents.on('will-navigate', (e, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const isApp =
      (rendererUrl ? url.startsWith(rendererUrl) : false) ||
      url.startsWith('file://')
    if (!isApp) {
      e.preventDefault()
      openExternal(url)
    }
  })

  // Закрытие окна прячет его в трей; реальный выход — только через меню трея
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function showAllWindows(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    createWindow()
    return
  }
  for (const w of windows) {
    w.show()
    if (w.isMinimized()) w.restore()
  }
  windows[windows.length - 1].focus()
}

function createTray(): void {
  const p = iconPath('png') ?? iconPath('ico')
  const image = p ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
  tray = new Tray(process.platform === 'win32' && p ? image.resize({ width: 16, height: 16 }) : image)
  tray.setToolTip('LiteSSH')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать LiteSSH', click: showAllWindows },
      { label: 'Новое окно', click: () => createWindow() },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showAllWindows)
  // одиночный клик по трею на Windows тоже показывает окно
  tray.on('click', showAllWindows)
}

// Single-instance: повторный запуск не плодит новый процесс, а показывает уже открытое
// окно (иначе в трее оставался старый экземпляр со устаревшим списком сессий).
// Изолированный smoke должен запускаться рядом с установленным экземпляром и не перехватывать его окно.
const gotLock = isSmoke || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showAllWindows())
}

app.whenReady().then(() => {
  if (!gotLock) return
  loadVaultMeta(getVaultMeta())
  registerIpc()
  ipcMain.on('window:new', () => createWindow())
  // Открытие ссылок (из терминала и т.п.) в системном браузере
  ipcMain.on('open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  // Смена цвета системных кнопок титлбара под тему (Windows/Linux)
  ipcMain.on('window:overlay', (e, dark: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || process.platform === 'darwin') return
    try {
      w.setTitleBarOverlay(
        dark
          ? DARK_OVERLAY
          : { color: '#ffffff', symbolColor: '#4b5563', height: 44 }
      )
    } catch {
      /* overlay недоступен на этой платформе */
    }
  })
  const win = createWindow()

  if (isSmoke) {
    const shotArg = process.argv.find((a) => a.startsWith('--shot='))
    // Проверяем, что нативные модули поднимаются в упакованном виде (asar.unpacked)
    try {
      listSessions()
      console.log('NATIVE_OK sqlite+shells=' + availableShells().length)
    } catch (e) {
      console.log('NATIVE_FAIL', (e as Error).message)
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        console.log('MCP_OK tools=' + await smokeMcpProtocol())
        console.log('MCP_PARALLEL_OK bridges=' + await smokeMcpParallel())
      } catch (e) {
        console.log('MCP_FAIL', (e as Error).message)
        isQuitting = true
        app.exit(1)
        return
      }
      console.log('SMOKE_OK')
      if (shotArg) {
        if (process.argv.includes('--activity-shot')) {
          await win.webContents.executeJavaScript(
            `document.querySelector('button[title="Активность и журнал MCP"]')?.click()`
          )
        }
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage()
            require('fs').writeFileSync(shotArg.slice('--shot='.length), img.toPNG())
            console.log('SHOT_OK')
          } catch (e) {
            console.log('SHOT_FAIL', (e as Error).message)
          }
          isQuitting = true
          app.exit(0)
        }, 1200)
      } else {
        isQuitting = true
        setTimeout(() => app.exit(0), 500)
      }
    })
    setTimeout(() => {
      console.log('SMOKE_TIMEOUT')
      app.exit(1)
    }, 20_000)
    return
  }

  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showAllWindows()
  })
})

// Окна прячутся в трей, поэтому обычное закрытие окон не завершает приложение.
// Выход только через меню трея (isQuitting=true) — там уже вызывается app.quit().
let shutdownStarted = false
let activityFlushed = false
app.on('before-quit', (event) => {
  if (!activityFlushed) {
    event.preventDefault()
    if (!shutdownStarted) {
      shutdownStarted = true
      isQuitting = true
      closeMcpBridge()
      closeAll()
      closeAllPtys()
      closeDb()
      void flushMcpActivity().finally(() => {
        activityFlushed = true
        app.quit()
      })
    }
    return
  }
  isQuitting = true
})
