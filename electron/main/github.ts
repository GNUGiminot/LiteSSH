import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { posix } from 'path'
import type { BrowserWindow } from 'electron'
import type {
  GitHubChange,
  GitHubProgress,
  GitHubPublishRequest,
  GitHubRepoState,
  GitHubSource,
  GitIgnorePreset
} from '@shared/types'
import { execOnClientLimited } from './ssh/connection-manager'
import { sftpReadFile, sftpWriteFile } from './ssh/sftp-manager'

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const MAX_OUTPUT = 8 * 1024 * 1024
const activePublishes = new Set<string>()

const IGNORE_PRESETS: Record<Exclude<GitIgnorePreset, 'none'>, string> = {
  electron: `node_modules/
out/
dist/
release/
.tmp/
*.log
.env
.env.*
!.env.example
.DS_Store
Thumbs.db
`,
  node: `node_modules/
dist/
coverage/
*.log
.env
.env.*
!.env.example
.DS_Store
Thumbs.db
`,
  python: `__pycache__/
*.py[cod]
.venv/
venv/
dist/
build/
*.egg-info/
.env
.DS_Store
`,
  visualstudio: `.vs/
bin/
obj/
Debug/
Release/
*.user
*.suo
*.cache
*.log
`
}

function sourceKey(source: GitHubSource): string {
  return `${source.kind}:${source.termId ?? ''}:${source.path}`
}

function cleanError(value: string): string {
  return value
    .replace(/https:\/\/[^\s/@:]+:[^\s/@]+@github\.com/gi, 'https://github.com')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1200)
}

function friendlyError(result: CommandResult, fallback: string): Error {
  const raw = cleanError(result.stderr || result.stdout || fallback)
  const lower = raw.toLowerCase()
  if (lower.includes('not a git repository')) return new Error('В выбранной папке ещё нет Git-репозитория')
  if (lower.includes('authentication failed') || lower.includes('could not read username')) {
    return new Error('GitHub не авторизован. Нажмите «Войти через GitHub» и повторите операцию.')
  }
  if (lower.includes('repository not found')) {
    return new Error('Репозиторий не найден или у текущего аккаунта нет к нему доступа.')
  }
  if (lower.includes('non-fast-forward') || lower.includes('not possible to fast-forward')) {
    return new Error('История на GitHub разошлась с локальной. LiteSSH не выполняет force push; сначала разрешите конфликт.')
  }
  if (lower.includes('please tell me who you are') || lower.includes('author identity unknown')) {
    return new Error('Укажите имя и email автора коммита.')
  }
  return new Error(raw || fallback)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function runLocalGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveCommand(result)
    }
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= MAX_OUTPUT) return current
      return (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT)
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error.code === 'ENOENT') reject(new Error('Git не установлен или не найден в PATH'))
      else reject(error)
    })
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }))
    const timer = setTimeout(() => {
      if (settled) return
      child.kill()
      finish({ code: 124, stdout, stderr: `${stderr}\nКоманда Git превысила таймаут` })
    }, timeoutMs)
  })
}

async function runRemoteGit(source: GitHubSource, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  if (!source.termId) throw new Error('SSH-сессия не выбрана')
  const command = `export LC_ALL=C LANG=C GIT_TERMINAL_PROMPT=0; cd -- ${shellQuote(source.path)} && git ${args.map(shellQuote).join(' ')}`
  const result = await execOnClientLimited(source.termId, command, {
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

function runGit(source: GitHubSource, args: string[], timeoutMs?: number): Promise<CommandResult> {
  return source.kind === 'local'
    ? runLocalGit(source.path, args, timeoutMs)
    : runRemoteGit(source, args, timeoutMs)
}

async function required(source: GitHubSource, args: string[], fallback: string, timeoutMs?: number): Promise<CommandResult> {
  const result = await runGit(source, args, timeoutMs)
  if (result.code !== 0) throw friendlyError(result, fallback)
  return result
}

function validateSource(source: GitHubSource): GitHubSource {
  const path = String(source.path ?? '').trim()
  if (!path || path.includes('\0')) throw new Error('Не выбрана папка проекта')
  if (source.kind === 'local') {
    const full = resolve(path)
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error('Локальная папка не найдена')
    return { kind: 'local', path: full }
  }
  if (!source.termId) throw new Error('Откройте SSH-сессию для серверного проекта')
  return { kind: 'remote', path, termId: String(source.termId) }
}

function validateBranch(value: string): string {
  const branch = value.trim()
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
    branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')
  ) throw new Error('Некорректное имя ветки')
  return branch
}

function browserUrl(repositoryUrl: string): string {
  const value = repositoryUrl.trim()
  let match = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value)
  if (match) return `https://github.com/${match[1]}/${match[2]}`
  match = /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value)
  if (match) return `https://github.com/${match[1]}/${match[2]}`
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') throw new Error()
    if (parsed.username || parsed.password) throw new Error()
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) throw new Error()
    return `https://github.com/${path}`
  } catch {
    throw new Error('Укажите ссылку вида https://github.com/user/repository или git@github.com:user/repository.git')
  }
}

function validateRepositoryUrl(value: string): { gitUrl: string; webUrl: string } {
  const webUrl = browserUrl(value)
  const gitUrl = value.trim().startsWith('https://') ? `${webUrl}.git` : value.trim()
  return { gitUrl, webUrl }
}

function parseChanges(raw: string): { changes: GitHubChange[]; truncated: boolean } {
  const parts = raw.split('\0').filter(Boolean)
  const changes: GitHubChange[] = []
  for (let i = 0; i < parts.length && changes.length < 500; i += 1) {
    const item = parts[i]
    const status = item.slice(0, 2)
    changes.push({ status, path: item.slice(3) })
    if (status[0] === 'R' || status[0] === 'C') i += 1
  }
  return { changes, truncated: parts.length > 500 }
}

async function hasIgnore(source: GitHubSource): Promise<boolean> {
  if (source.kind === 'local') return existsSync(join(source.path, '.gitignore'))
  if (!source.termId) return false
  const result = await execOnClientLimited(
    source.termId,
    `cd -- ${shellQuote(source.path)} && test -f .gitignore`,
    { timeoutMs: 10_000, maxOutputBytes: 1024 }
  )
  return result.code === 0
}

export async function inspectGitHubProject(rawSource: GitHubSource): Promise<GitHubRepoState> {
  const source = validateSource(rawSource)
  let version: CommandResult
  try {
    version = await runGit(source, ['--version'], 15_000)
  } catch (error) {
    if ((error as Error).message.includes('Git не установлен')) {
      return {
        gitAvailable: false, initialized: false, branch: '', remoteUrl: '', hasGitignore: false,
        clean: true, ahead: 0, behind: 0, authorName: '', authorEmail: '', changes: []
      }
    }
    throw error
  }
  if (version.code !== 0) throw friendlyError(version, 'Git недоступен')

  const repo = await runGit(source, ['rev-parse', '--is-inside-work-tree'], 15_000)
  const initialized = repo.code === 0 && repo.stdout.trim() === 'true'
  const name = await runGit(source, ['config', '--get', 'user.name'], 15_000)
  const email = await runGit(source, ['config', '--get', 'user.email'], 15_000)
  if (!initialized) {
    return {
      gitAvailable: true, initialized: false, branch: 'main', remoteUrl: '',
      hasGitignore: await hasIgnore(source), clean: true, ahead: 0, behind: 0,
      authorName: name.code === 0 ? name.stdout.trim() : '',
      authorEmail: email.code === 0 ? email.stdout.trim() : '', changes: []
    }
  }

  const [branch, remote, status, counts] = await Promise.all([
    runGit(source, ['branch', '--show-current'], 15_000),
    runGit(source, ['remote', 'get-url', 'origin'], 15_000),
    runGit(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 30_000),
    runGit(source, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], 15_000)
  ])
  const parsed = parseChanges(status.stdout)
  const pair = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0]
  return {
    gitAvailable: true,
    initialized: true,
    branch: branch.code === 0 ? branch.stdout.trim() : '',
    remoteUrl: remote.code === 0 ? remote.stdout.trim() : '',
    hasGitignore: await hasIgnore(source),
    clean: parsed.changes.length === 0,
    ahead: Number.isFinite(pair[0]) ? pair[0] : 0,
    behind: Number.isFinite(pair[1]) ? pair[1] : 0,
    authorName: name.code === 0 ? name.stdout.trim() : '',
    authorEmail: email.code === 0 ? email.stdout.trim() : '',
    changes: parsed.changes,
    truncated: parsed.truncated
  }
}

async function readIgnore(source: GitHubSource): Promise<string> {
  if (source.kind === 'local') {
    const path = join(source.path, '.gitignore')
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  try {
    const result = await sftpReadFile(source.termId!, posix.join(source.path, '.gitignore'))
    if (result.truncated) throw new Error('.gitignore слишком большой')
    return Buffer.from(result.base64, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

async function writeIgnore(source: GitHubSource, preset: GitIgnorePreset, custom: string): Promise<boolean> {
  const presetBody = preset === 'none' ? '' : IGNORE_PRESETS[preset]
  const customBody = custom.replace(/\0/g, '').trim().slice(0, 10_000)
  if (!presetBody && !customBody) return false
  const current = await readIgnore(source)
  const marker = preset === 'none' ? '' : `# LiteSSH: ${preset}`
  const blocks: string[] = []
  if (presetBody && !current.includes(marker)) blocks.push(`${marker}\n${presetBody.trim()}`)
  if (customBody && !current.includes(customBody)) blocks.push(`# LiteSSH: custom\n${customBody}`)
  if (!blocks.length) return false
  const next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${blocks.join('\n\n')}\n`
  if (source.kind === 'local') writeFileSync(join(source.path, '.gitignore'), next, 'utf8')
  else await sftpWriteFile(source.termId!, posix.join(source.path, '.gitignore'), Buffer.from(next).toString('base64'))
  return true
}

function emit(win: BrowserWindow, progress: GitHubProgress): void {
  if (!win.isDestroyed()) win.webContents.send('github:progress', progress)
}

export async function loginGitHub(): Promise<void> {
  const result = await runLocalGit(process.cwd(), ['credential-manager', 'github', 'login'], 5 * 60_000)
  if (result.code !== 0) {
    const message = cleanError(result.stderr || result.stdout)
    if (message.toLowerCase().includes('not a git command')) {
      throw new Error('Git Credential Manager не установлен. Установите актуальный Git for Windows.')
    }
    throw friendlyError(result, 'Не удалось войти в GitHub')
  }
}

export async function publishGitHubProject(win: BrowserWindow, request: GitHubPublishRequest): Promise<{ url: string; log: string[] }> {
  const source = validateSource(request.source)
  const key = sourceKey(source)
  if (activePublishes.has(key)) throw new Error('Для этой папки уже выполняется публикация')
  activePublishes.add(key)
  const log: string[] = []
  const progress = (phase: GitHubProgress['phase'], message: string) => {
    log.push(message)
    emit(win, { phase, message })
  }
  try {
    const branch = validateBranch(request.branch || 'main')
    const commitMessage = String(request.commitMessage || '').trim().slice(0, 300)
    if (!commitMessage) throw new Error('Введите сообщение коммита')
    const repository = validateRepositoryUrl(request.repositoryUrl)

    progress('prepare', 'Проверяю Git и папку проекта…')
    await required(source, ['--version'], 'Git недоступен', 15_000)
    let repo = await runGit(source, ['rev-parse', '--is-inside-work-tree'], 15_000)
    if (repo.code !== 0) {
      progress('prepare', 'Создаю локальный Git-репозиторий…')
      const initialized = await runGit(source, ['init', '-b', branch], 30_000)
      if (initialized.code !== 0) {
        await required(source, ['init'], 'Не удалось создать Git-репозиторий', 30_000)
        await required(source, ['branch', '-M', branch], 'Не удалось создать основную ветку', 15_000)
      }
      repo = await runGit(source, ['rev-parse', '--is-inside-work-tree'], 15_000)
      if (repo.code !== 0) throw friendlyError(repo, 'Не удалось создать Git-репозиторий')
    }

    const remote = await runGit(source, ['remote', 'get-url', 'origin'], 15_000)
    if (remote.code === 0) {
      const sameRepository = (() => {
        try { return browserUrl(remote.stdout.trim()) === repository.webUrl } catch { return false }
      })()
      if (!sameRepository) {
        if (!request.replaceRemote) {
          throw new Error(`У origin уже другая ссылка: ${remote.stdout.trim()}. Подтвердите её замену.`)
        }
        await required(source, ['remote', 'set-url', 'origin', repository.gitUrl], 'Не удалось изменить origin')
        progress('prepare', 'Ссылка origin обновлена.')
      }
    } else {
      await required(source, ['remote', 'add', 'origin', repository.gitUrl], 'Не удалось добавить origin')
      progress('prepare', 'Ссылка origin добавлена.')
    }

    if (request.authorName?.trim()) {
      await required(source, ['config', 'user.name', request.authorName.trim().slice(0, 200)], 'Не удалось сохранить имя автора')
    }
    if (request.authorEmail?.trim()) {
      await required(source, ['config', 'user.email', request.authorEmail.trim().slice(0, 254)], 'Не удалось сохранить email автора')
    }

    progress('gitignore', 'Применяю правила .gitignore без перезаписи существующих…')
    const ignoreChanged = await writeIgnore(source, request.gitignorePreset, request.customIgnore ?? '')
    if (ignoreChanged) progress('gitignore', '.gitignore обновлён.')

    progress('stage', 'Собираю изменения для коммита…')
    await required(source, ['add', '--all'], 'Не удалось добавить файлы')
    const staged = await runGit(source, ['diff', '--cached', '--quiet'], 30_000)
    if (staged.code === 1) {
      const authorName = await runGit(source, ['config', '--get', 'user.name'], 15_000)
      const authorEmail = await runGit(source, ['config', '--get', 'user.email'], 15_000)
      if (authorName.code !== 0 || authorEmail.code !== 0) throw new Error('Укажите имя и email автора коммита')
      progress('commit', 'Создаю коммит…')
      await required(source, ['commit', '-m', commitMessage], 'Не удалось создать коммит', 60_000)
    } else if (staged.code === 0) {
      progress('commit', 'Новых изменений для коммита нет.')
    } else {
      throw friendlyError(staged, 'Не удалось проверить подготовленные изменения')
    }

    const head = await runGit(source, ['rev-parse', '--verify', 'HEAD'], 15_000)
    if (head.code !== 0) throw new Error('В проекте нет файлов для первого коммита')

    progress('sync', 'Проверяю состояние ветки на GitHub…')
    const remoteBranch = await runGit(source, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], 90_000)
    if (remoteBranch.code === 0) {
      await required(source, ['fetch', 'origin', branch], 'Не удалось получить изменения с GitHub', 5 * 60_000)
      const remoteIsAncestor = await runGit(source, ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], 30_000)
      if (remoteIsAncestor.code !== 0) {
        const localIsAncestor = await runGit(source, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`], 30_000)
        if (localIsAncestor.code === 0) {
          await required(source, ['merge', '--ff-only', `origin/${branch}`], 'Не удалось безопасно обновить локальную ветку', 60_000)
          progress('sync', 'Локальная ветка обновлена без конфликтов.')
        } else {
          throw new Error('Локальная история и GitHub разошлись. Публикация остановлена без force push.')
        }
      }
    } else if (remoteBranch.code !== 2) {
      throw friendlyError(remoteBranch, 'Не удалось проверить ветку на GitHub')
    }

    progress('push', 'Отправляю изменения на GitHub…')
    await required(source, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], 'Не удалось отправить изменения', 10 * 60_000)
    progress('done', 'Проект успешно опубликован на GitHub.')
    return { url: repository.webUrl, log }
  } finally {
    activePublishes.delete(key)
  }
}
