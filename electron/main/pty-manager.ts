import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync } from 'fs'
import type { IPty } from 'node-pty'

// node-pty подгружаем лениво: если нативный модуль не собран, локальные терминалы
// просто недоступны, но остальное приложение работает.
let ptyLib: typeof import('node-pty') | null | undefined

function getPty(): typeof import('node-pty') | null {
  if (ptyLib === undefined) {
    try {
      ptyLib = require('node-pty') as typeof import('node-pty')
    } catch {
      ptyLib = null
    }
  }
  return ptyLib
}

interface ActivePty {
  pty: IPty
  win: BrowserWindow
}

const ptys = new Map<string, ActivePty>()

export function availableShells(): { label: string; cmd: string }[] {
  if (process.platform === 'win32') {
    const list: { label: string; cmd: string }[] = []
    const pwsh = `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`
    if (existsSync(pwsh)) list.push({ label: 'PowerShell 7', cmd: pwsh })
    list.push({ label: 'Windows PowerShell', cmd: 'powershell.exe' })
    list.push({ label: 'Command Prompt', cmd: 'cmd.exe' })
    if (existsSync('C:\\Windows\\System32\\wsl.exe'))
      list.push({ label: 'WSL', cmd: 'wsl.exe' })
    if (existsSync('C:\\Program Files\\Git\\bin\\bash.exe'))
      list.push({ label: 'Git Bash', cmd: 'C:\\Program Files\\Git\\bin\\bash.exe' })
    return list
  }
  const shells = [
    { label: 'bash', cmd: '/bin/bash' },
    { label: 'zsh', cmd: '/bin/zsh' },
    { label: 'sh', cmd: '/bin/sh' }
  ].filter((s) => existsSync(s.cmd))
  return shells.length ? shells : [{ label: 'shell', cmd: process.env.SHELL || '/bin/sh' }]
}

export function spawnPty(
  win: BrowserWindow,
  shell: string,
  size: { cols: number; rows: number }
): { ptyId: string } {
  const lib = getPty()
  if (!lib) throw new Error('Локальный терминал недоступен: модуль node-pty не собран')
  const ptyId = randomUUID()
  const proc = lib.spawn(shell, [], {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: homedir(),
    env: process.env as Record<string, string>
  })
  proc.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('pty:data', ptyId, data)
  })
  proc.onExit(() => {
    ptys.delete(ptyId)
    if (!win.isDestroyed()) win.webContents.send('pty:exit', ptyId)
  })
  ptys.set(ptyId, { pty: proc, win })
  return { ptyId }
}

export function writePty(ptyId: string, data: string): void {
  ptys.get(ptyId)?.pty.write(data)
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  try {
    ptys.get(ptyId)?.pty.resize(cols, rows)
  } catch {
    /* окно могло схлопнуться до 0 */
  }
}

export function closePty(ptyId: string): void {
  const p = ptys.get(ptyId)
  if (!p) return
  ptys.delete(ptyId)
  try {
    p.pty.kill()
  } catch {
    /* ignore */
  }
}

export function closeAllPtys(): void {
  for (const [id] of ptys) closePty(id)
}
