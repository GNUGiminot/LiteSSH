import { promises as fsp, existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { shell } from 'electron'
import type { FileEntry } from '@shared/types'

export function home(): string {
  return homedir()
}

/** Пустой путь на Windows = список дисков. */
export async function listLocal(path: string): Promise<{ path: string; entries: FileEntry[] }> {
  if (!path && process.platform === 'win32') {
    const entries: FileEntry[] = []
    for (let c = 65; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ':\\'
      if (existsSync(drive)) {
        entries.push({ name: drive, path: drive, isDir: true, size: 0, mtime: 0 })
      }
    }
    return { path: '', entries }
  }
  const dir = path || homedir()
  const dirents = await fsp.readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry | null> => {
      const full = join(dir, d.name)
      try {
        const st = await fsp.stat(full)
        return {
          name: d.name,
          path: full,
          isDir: st.isDirectory(),
          isLink: d.isSymbolicLink(),
          size: st.size,
          mtime: st.mtimeMs
        }
      } catch {
        // битые симлинки, отказ в доступе — показываем без метаданных
        return { name: d.name, path: full, isDir: d.isDirectory(), size: 0, mtime: 0 }
      }
    })
  )
  return { path: dir, entries: entries.filter((e): e is FileEntry => e !== null) }
}

export function parentLocal(path: string): string {
  if (process.platform === 'win32' && /^[A-Za-z]:\\?$/.test(path)) return ''
  return dirname(path)
}

export async function mkdirLocal(path: string): Promise<void> {
  await fsp.mkdir(path)
}

export async function renameLocal(from: string, to: string): Promise<void> {
  await fsp.rename(from, to)
}

export async function removeLocal(path: string): Promise<void> {
  await fsp.rm(path, { recursive: true, force: true })
}

export function reveal(path: string): void {
  shell.showItemInFolder(path)
}
