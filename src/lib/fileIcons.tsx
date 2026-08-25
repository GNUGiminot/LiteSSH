import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  Link2
} from 'lucide-react'
import type { FileEntry } from '@shared/types'
import type { ReactNode } from 'react'

// Цвет и иконка по расширению — в стиле цветовой раскраски файловых менеджеров
const MAP: Record<string, { Icon: typeof File; color: string }> = {}
const add = (exts: string[], Icon: typeof File, color: string) => {
  for (const e of exts) MAP[e] = { Icon, color }
}

add(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte'], FileCode, 'text-yellow-400')
add(['py', 'rb', 'php', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'lua'], FileCode, 'text-blue-400')
add(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'], FileTerminal, 'text-emerald-400')
add(['json', 'json5'], FileJson, 'text-amber-400')
add(['yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties'], FileCog, 'text-orange-400')
add(['md', 'markdown', 'txt', 'text', 'log', 'rst'], FileText, 'text-content-2')
add(['html', 'htm', 'xml', 'css', 'scss', 'sass', 'less'], FileCode, 'text-pink-400')
add(['csv', 'tsv', 'xls', 'xlsx', 'ods'], FileSpreadsheet, 'text-green-400')
add(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'], FileImage, 'text-purple-400')
add(['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'], FileVideo, 'text-rose-400')
add(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'], FileAudio, 'text-fuchsia-400')
add(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'], FileArchive, 'text-red-400')
add(['pem', 'key', 'crt', 'cer', 'pub', 'ppk'], FileKey, 'text-teal-400')
add(['gpg', 'asc', 'enc', 'lock'], FileLock, 'text-teal-400')
add(['sql', 'db', 'sqlite'], FileCog, 'text-cyan-400')

/** Возвращает раскрашенную иконку для записи файлового списка. */
export function fileIcon(entry: FileEntry, size = 13): ReactNode {
  if (entry.isLink) return <Link2 size={size} className="text-cyan-400" />
  if (entry.isDir) return <Folder size={size} className="text-accent" />
  const name = entry.name.toLowerCase()
  if (name === 'dockerfile' || name.startsWith('.env'))
    return <FileCog size={size} className="text-orange-400" />
  if (name === 'makefile') return <FileTerminal size={size} className="text-emerald-400" />
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const hit = MAP[ext]
  if (hit) {
    const { Icon, color } = hit
    return <Icon size={size} className={color} />
  }
  return <File size={size} className="text-content-3" />
}
