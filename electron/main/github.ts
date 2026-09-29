import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { posix } from 'path'
import type { BrowserWindow } from 'electron'
import type {
  GitHubChange,
  GitHubProgress,
  GitHubPublishRequest,
  GitHubRepoState,
  GitHubSource,
  GitIgnorePreset,
  GitRemoteCheck,
  GitRemoteStatus
} from '@shared/types'
import { parseRepositoryUrl, repositoryIdentity, type ParsedRepositoryUrl } from '@shared/gitUrl'
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
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1200)
}

/** Классификация ответа git при обращении к удалённому репозиторию (вывод в LC_ALL=C). */
function remoteFailure(result: CommandResult): GitRemoteStatus {
  if (result.code === 124) return 'network'
  const lower = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.code === 127 || lower.includes('git: command not found') || lower.includes('git: not found')) return 'no-git'
  if (
    lower.includes('repository not found') ||
    lower.includes('does not appear to be a git repository') ||
    lower.includes('could not be found') ||
    lower.includes('not found') ||
    lower.includes('error: 404')
  ) return 'not-found'
  if (lower.includes('host key verification failed')) return 'host-key'
  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('could not read password') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('permission denied') ||
    lower.includes('access denied') ||
    lower.includes('invalid username or password') ||
    lower.includes('error: 401') ||
    lower.includes('error: 403')
  ) return 'auth'
  if (
    lower.includes('could not resolve host') ||
    lower.includes('could not resolve hostname') ||
    lower.includes('connection timed out') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect') ||
    lower.includes('network is unreachable') ||
    lower.includes('no route to host') ||
    lower.includes('ssl') ||
    lower.includes('certificate')
  ) return 'network'
  return 'error'
}

function remoteFailureMessage(
  status: GitRemoteStatus,
  repository: ParsedRepositoryUrl,
  kind: GitHubSource['kind'],
  raw: string
): string {
  const where = kind === 'remote' ? 'с сервера' : 'с этого компьютера'
  const isGitHubHttps = repository.host === 'github.com' && /^https?:/i.test(repository.gitUrl)
  switch (status) {
    case 'not-found':
      return `Репозиторий ${repository.path} на ${repository.host} не найден. Создайте его на сайте${repository.createUrl ? ' (кнопка «Создать репозиторий»)' : ''} или проверьте ссылку и права доступа.`
    case 'auth':
      if (isGitHubHttps) {
        return 'GitHub не отдал репозиторий: он ещё не создан или приватный. Если он приватный — нажмите «Войти через GitHub»; если не создан — создайте его на GitHub.'
      }
      return /^https?:/i.test(repository.gitUrl)
        ? `${repository.host} требует вход: репозиторий ещё не создан или приватный. Если не создан — создайте его на сайте; если приватный — войдите через Git Credential Manager или используйте SSH-ссылку.`
        : `Нет доступа по SSH к ${repository.host} ${where}: ключ не принят (Permission denied). Добавьте публичный ключ в аккаунт или используйте https-ссылку.`
    case 'host-key':
      return `Ключ хоста ${repository.host} неизвестен ${where}. Один раз выполните «ssh -T git@${repository.host}» в терминале и подтвердите отпечаток.`
    case 'network':
      return `Не удалось подключиться к ${repository.host} ${where}: нет сети, неверный адрес или истёк таймаут.`
    default:
      return raw || 'Не удалось проверить удалённый репозиторий'
  }
}

function friendlyError(result: CommandResult, fallback: string): Error {
  const raw = cleanError(result.stderr || result.stdout || fallback)
  const lower = raw.toLowerCase()
  if (lower.includes('not a git repository')) return new Error('В выбранной папке ещё нет Git-репозитория')
  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled')
  ) {
    return new Error('Нет авторизации в удалённом репозитории. Для GitHub нажмите «Войти через GitHub» и повторите операцию.')
  }
  if (lower.includes('permission denied (publickey')) {
    return new Error('SSH-ключ не принят удалённым репозиторием. Добавьте публичный ключ в аккаунт или используйте https-ссылку.')
  }
  if (lower.includes('repository not found') || lower.includes('does not appear to be a git repository')) {
    return new Error('Репозиторий не найден или у текущего аккаунта нет к нему доступа.')
  }
  if (lower.includes('non-fast-forward') || lower.includes('not possible to fast-forward')) {
    return new Error('История в удалённом репозитории разошлась с локальной. LiteSSH не выполняет force push; сначала разрешите конфликт.')
  }
  if (lower.includes('please tell me who you are') || lower.includes('author identity unknown')) {
    return new Error('Укажите имя и email автора коммита.')
  }
  return new Error(raw || fallback)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Окружение git без интерактивных запросов: иначе при недоступном репозитории git/GCM
 * ждёт ввода логина (или скрытого окна) до таймаута, и интерфейс «молчит».
 * Интерактивным остаётся только явный вход через кнопку.
 */
function localGitEnv(interactive: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  if (!interactive) {
    env.GIT_TERMINAL_PROMPT = '0'
    env.GCM_INTERACTIVE = 'never'
    env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes -o ConnectTimeout=15'
  }
  return env
}

const REMOTE_GIT_ENV =
  'export LC_ALL=C LANG=C GIT_TERMINAL_PROMPT=0; ' +
  'export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15}";'

function runLocalGit(cwd: string, args: string[], timeoutMs = 60_000, interactive = false): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: localGitEnv(interactive)
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

async function runRemoteGit(
  source: GitHubSource,
  args: string[],
  timeoutMs = 60_000,
  inProjectDir = true
): Promise<CommandResult> {
  if (!source.termId) throw new Error('SSH-сессия не выбрана')
  const cd = inProjectDir ? `cd -- ${shellQuote(source.path)} && ` : ''
  const command = `${REMOTE_GIT_ENV} ${cd}git ${args.map(shellQuote).join(' ')}`
  try {
    const result = await execOnClientLimited(source.termId, command, {
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    // execOnClientLimited сообщает таймаут исключением — приводим к коду как у локального git
    if ((error as Error).message.includes('таймаут')) return { code: 124, stdout: '', stderr: (error as Error).message }
    throw error
  }
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

const MAX_LISTED_BRANCHES = 100

/**
 * Проверка ссылки на удалённый репозиторий до каких-либо изменений в папке проекта:
 * существует ли он, есть ли доступ, пустой ли, какие ветки. Выполняется оттуда же,
 * откуда потом будет push (компьютер или сервер SSH-сессии), без запросов пароля.
 */
async function probeRemote(source: GitHubSource, repository: ParsedRepositoryUrl): Promise<GitRemoteCheck> {
  const base = {
    host: repository.host,
    webUrl: repository.webUrl,
    createUrl: repository.createUrl,
    branches: [] as string[],
    checkedFrom: source.kind
  }
  // Папка может быть ещё не выбрана или не существовать — ls-remote она не нужна
  const run = (args: string[]): Promise<CommandResult> => {
    if (source.kind === 'remote') return runRemoteGit(source, args, 30_000, false)
    const cwd = source.path && existsSync(source.path) && statSync(source.path).isDirectory() ? source.path : homedir()
    return runLocalGit(cwd, args, 30_000)
  }

  let head: CommandResult
  try {
    head = await run(['ls-remote', '--symref', repository.gitUrl, 'HEAD'])
  } catch (error) {
    if ((error as Error).message.includes('Git не установлен')) {
      return { ...base, status: 'no-git', message: 'Git не установлен или не найден в PATH на этом компьютере.' }
    }
    throw error
  }
  if (head.code !== 0) {
    const status = remoteFailure(head)
    const message = status === 'no-git'
      ? 'На сервере не установлен Git.'
      : remoteFailureMessage(status, repository, source.kind, cleanError(head.stderr || head.stdout))
    return { ...base, status, message }
  }

  const heads = await run(['ls-remote', '--heads', repository.gitUrl])
  if (heads.code !== 0) {
    const status = remoteFailure(heads)
    return { ...base, status, message: remoteFailureMessage(status, repository, source.kind, cleanError(heads.stderr)) }
  }
  const allBranches = heads.stdout
    .split('\n')
    .map((line) => /\trefs\/heads\/(.+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => !!name)
  const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.stdout)?.[1]

  if (!allBranches.length) {
    return {
      ...base,
      status: 'empty',
      message: 'Репозиторий найден и пустой — первая публикация создаст ветку.'
    }
  }
  return {
    ...base,
    status: 'ok',
    message: `Репозиторий доступен: веток ${allBranches.length}${defaultBranch ? `, основная — ${defaultBranch}` : ''}.`,
    defaultBranch,
    branches: allBranches.slice(0, MAX_LISTED_BRANCHES),
    branchesTruncated: allBranches.length > MAX_LISTED_BRANCHES
  }
}

export async function checkRemoteRepository(rawSource: GitHubSource, repositoryUrl: string): Promise<GitRemoteCheck> {
  const repository = parseRepositoryUrl(repositoryUrl)
  const path = String(rawSource.path ?? '').trim()
  if (rawSource.kind === 'remote') {
    if (!rawSource.termId) throw new Error('Откройте SSH-сессию для серверного проекта')
    return probeRemote({ kind: 'remote', path: path || '.', termId: String(rawSource.termId) }, repository)
  }
  return probeRemote({ kind: 'local', path: path ? resolve(path) : '' }, repository)
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
  const result = await runLocalGit(homedir(), ['credential-manager', 'github', 'login'], 5 * 60_000, true)
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
    const repository = parseRepositoryUrl(request.repositoryUrl)

    progress('prepare', 'Проверяю Git и папку проекта…')
    await required(source, ['--version'], 'Git недоступен', 15_000)

    // До init/commit: если репозитория нет или нет доступа, папку проекта не трогаем
    progress('prepare', `Проверяю доступ к ${repository.webUrl}…`)
    const remoteCheck = await probeRemote(source, repository)
    if (remoteCheck.status !== 'ok' && remoteCheck.status !== 'empty') throw new Error(remoteCheck.message)
    progress('prepare', remoteCheck.message)
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
      const sameRepository = repositoryIdentity(remote.stdout.trim()) === repositoryIdentity(repository.gitUrl)
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

    progress('sync', `Проверяю ветку ${branch} на ${repository.host}…`)
    const remoteBranch = await runGit(source, ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], 90_000)
    if (remoteBranch.code === 0) {
      await required(source, ['fetch', 'origin', branch], 'Не удалось получить изменения из удалённого репозитория', 5 * 60_000)
      const remoteIsAncestor = await runGit(source, ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], 30_000)
      if (remoteIsAncestor.code !== 0) {
        const localIsAncestor = await runGit(source, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`], 30_000)
        if (localIsAncestor.code === 0) {
          await required(source, ['merge', '--ff-only', `origin/${branch}`], 'Не удалось безопасно обновить локальную ветку', 60_000)
          progress('sync', 'Локальная ветка обновлена без конфликтов.')
        } else {
          throw new Error('Локальная история и удалённый репозиторий разошлись. Публикация остановлена без force push.')
        }
      }
    } else if (remoteBranch.code !== 2) {
      throw friendlyError(remoteBranch, 'Не удалось проверить ветку в удалённом репозитории')
    }

    progress('push', `Отправляю изменения на ${repository.host}…`)
    await required(source, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], 'Не удалось отправить изменения', 10 * 60_000)
    progress('done', `Проект опубликован: ${repository.webUrl}`)
    return { url: repository.webUrl, log }
  } finally {
    activePublishes.delete(key)
  }
}
