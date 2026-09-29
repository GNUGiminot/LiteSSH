import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Plus,
  ExternalLink,
  FolderOpen,
  Github,
  LogIn,
  RefreshCw,
  UploadCloud,
  X
} from 'lucide-react'
import type {
  GitHubProgress,
  GitHubRepoState,
  GitHubSourceKind,
  GitIgnorePreset,
  GitRemoteCheck
} from '@shared/types'
import { repositoryIdentity } from '@shared/gitUrl'

export interface GitHubDialogInitial {
  kind: GitHubSourceKind
  path?: string
  termId?: string
}

interface Props {
  open: boolean
  initial?: GitHubDialogInitial
  activeTermId?: string
  onClose: () => void
}

const field =
  'w-full rounded border border-surface-3 bg-surface-0 px-2.5 py-2 text-xs text-content-1 outline-none focus:border-accent'
const button =
  'inline-flex items-center justify-center gap-1.5 rounded px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'

function statusLabel(status: string): string {
  const code = status.trim()
  if (code === '??') return 'новый'
  if (code.includes('M')) return 'изменён'
  if (code.includes('D')) return 'удалён'
  if (code.includes('R')) return 'переименован'
  if (code.includes('A')) return 'добавлен'
  return code || 'изменён'
}

function hasSensitiveName(path: string): boolean {
  return /(^|\/)(\.env($|\.)|id_(rsa|dsa|ecdsa|ed25519)$|credentials?|secrets?($|\.)|[^/]+\.(pem|key|pfx|p12|kdbx|sqlite|db))$/i.test(path.replace(/\\/g, '/'))
}

const REMOTE_STATUS_STYLE: Record<GitRemoteCheck['status'], string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  empty: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  'not-found': 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  auth: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  'host-key': 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  network: 'border-red-500/40 bg-red-500/10 text-red-500',
  'no-git': 'border-red-500/40 bg-red-500/10 text-red-500',
  error: 'border-red-500/40 bg-red-500/10 text-red-500'
}

export function GitHubDialog({ open, initial, activeTermId, onClose }: Props) {
  const [kind, setKind] = useState<GitHubSourceKind>('local')
  const [localPath, setLocalPath] = useState('')
  const [remotePath, setRemotePath] = useState('.')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [commitMessage, setCommitMessage] = useState('Обновление проекта')
  const [preset, setPreset] = useState<GitIgnorePreset>('electron')
  const [customIgnore, setCustomIgnore] = useState('')
  const [replaceRemote, setReplaceRemote] = useState(false)
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [state, setState] = useState<GitHubRepoState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [successUrl, setSuccessUrl] = useState('')
  const [progress, setProgress] = useState<GitHubProgress[]>([])
  const [confirmSensitive, setConfirmSensitive] = useState(false)
  const [remoteCheck, setRemoteCheck] = useState<(GitRemoteCheck & { url: string }) | null>(null)
  const [checkingRemote, setCheckingRemote] = useState(false)

  const termId = initial?.termId ?? activeTermId
  const path = kind === 'local' ? localPath : remotePath
  const source = useMemo(
    () => ({ kind, path, ...(kind === 'remote' ? { termId } : {}) }),
    [kind, path, termId]
  )

  useEffect(() => {
    if (!open) return
    setKind(initial?.kind ?? 'local')
    if (initial?.kind === 'local' && initial.path) setLocalPath(initial.path)
    if (initial?.kind === 'remote' && initial.path) setRemotePath(initial.path)
    setState(null)
    setError('')
    setSuccessUrl('')
    setProgress([])
    setReplaceRemote(false)
    setConfirmSensitive(false)
    setRemoteCheck(null)
  }, [open, initial])

  useEffect(() => {
    if (!open) return
    return window.api.github.onProgress((item) => {
      setProgress((current) => [...current.slice(-7), item])
    })
  }, [open])

  /** Проверка ссылки: существует ли репозиторий, есть ли доступ, какие ветки. Папка не нужна. */
  const checkRemote = async (url = repositoryUrl) => {
    const value = url.trim()
    if (!value) return
    if (kind === 'remote' && !termId) return setError('Откройте SSH-сессию')
    setCheckingRemote(true)
    setError('')
    const result = await window.api.github.checkRemote(source, value)
    setCheckingRemote(false)
    if (!result.ok || !result.check) {
      setRemoteCheck(null)
      return setError(result.error ?? 'Не удалось проверить ссылку')
    }
    setRemoteCheck({ ...result.check, url: value })
  }

  const inspect = async () => {
    if (!path && !repositoryUrl.trim()) return setError('Выберите папку проекта или вставьте ссылку на репозиторий')
    if (kind === 'remote' && !termId) return setError('Откройте SSH-сессию')
    setError('')
    setSuccessUrl('')
    setConfirmSensitive(false)
    let url = repositoryUrl.trim()
    if (path) {
      setBusy(true)
      const result = await window.api.github.inspect(source)
      setBusy(false)
      if (!result.ok || !result.state) return setError(result.error ?? 'Не удалось проверить проект')
      setState(result.state)
      // Ссылку, которую пользователь уже ввёл, не перетираем значением origin
      if (!url && result.state.remoteUrl) {
        url = result.state.remoteUrl
        setRepositoryUrl(url)
      }
      if (result.state.branch) setBranch(result.state.branch)
      if (result.state.authorName) setAuthorName(result.state.authorName)
      if (result.state.authorEmail) setAuthorEmail(result.state.authorEmail)
    }
    if (url) await checkRemote(url)
  }

  const pickDirectory = async () => {
    const selected = await window.api.github.pickDirectory()
    if (selected) {
      setLocalPath(selected)
      setState(null)
    }
  }

  const login = async () => {
    setBusy(true)
    setError('')
    setProgress([{ phase: 'prepare', message: 'Открываю вход GitHub через Git Credential Manager…' }])
    const result = await window.api.github.login()
    setBusy(false)
    if (!result.ok) setError(result.error ?? 'Не удалось войти в GitHub')
    else {
      setProgress([{ phase: 'done', message: 'Авторизация GitHub завершена.' }])
      if (repositoryUrl.trim()) await checkRemote()
    }
  }

  const publish = async () => {
    if (!path) return setError('Выберите папку проекта')
    if (kind === 'remote' && !termId) return setError('Откройте SSH-сессию')
    setBusy(true)
    setError('')
    setSuccessUrl('')
    setProgress([])
    const result = await window.api.github.publish({
      source,
      repositoryUrl,
      branch,
      commitMessage,
      gitignorePreset: preset,
      customIgnore,
      replaceRemote,
      authorName,
      authorEmail
    })
    setBusy(false)
    if (!result.ok) return setError(result.error ?? 'Публикация не выполнена')
    await inspect()
    const url = typeof result.url === 'string' ? result.url : ''
    setSuccessUrl(url)
  }

  const remoteBlocked =
    !!remoteCheck &&
    remoteCheck.url === repositoryUrl.trim() &&
    remoteCheck.status !== 'ok' &&
    remoteCheck.status !== 'empty'
  const sensitive = state?.changes.filter((item) => hasSensitiveName(item.path)) ?? []
  const remoteMismatch =
    !!state?.remoteUrl &&
    !!repositoryUrl &&
    repositoryIdentity(state.remoteUrl) !== repositoryIdentity(repositoryUrl)

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(760px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-surface-3 bg-surface-1 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-surface-3 px-4 py-3">
            <Github size={18} className="text-content-1" />
            <Dialog.Title className="flex-1 text-sm font-semibold">Опубликовать проект на GitHub</Dialog.Title>
            <Dialog.Close disabled={busy} className="rounded p-1 text-content-3 hover:bg-surface-2 hover:text-content-1 disabled:opacity-40">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="overflow-y-auto p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <section className="space-y-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-content-2">Источник проекта</label>
                  <div className="flex overflow-hidden rounded border border-surface-3">
                    <button
                      onClick={() => { setKind('local'); setState(null) }}
                      className={`flex-1 px-2 py-1.5 text-xs ${kind === 'local' ? 'bg-accent text-white' : 'hover:bg-surface-2'}`}
                    >
                      На компьютере
                    </button>
                    <button
                      disabled={!termId}
                      onClick={() => { setKind('remote'); setState(null) }}
                      className={`flex-1 px-2 py-1.5 text-xs disabled:opacity-40 ${kind === 'remote' ? 'bg-accent text-white' : 'hover:bg-surface-2'}`}
                    >
                      На сервере
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-content-2">Папка проекта</label>
                  <div className="flex gap-1.5">
                    <input
                      className={field}
                      value={path}
                      onChange={(event) => {
                        if (kind === 'local') setLocalPath(event.target.value)
                        else setRemotePath(event.target.value)
                        setState(null)
                      }}
                      placeholder={kind === 'local' ? 'C:\\Projects\\my-app' : '/var/www/my-app'}
                    />
                    {kind === 'local' && (
                      <button title="Выбрать папку" onClick={() => void pickDirectory()} className={`${button} bg-surface-2 hover:bg-surface-3`}>
                        <FolderOpen size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-content-2">Ссылка на репозиторий GitHub</label>
                  <div className="flex gap-1.5">
                    <input
                      className={field}
                      value={repositoryUrl}
                      onChange={(event) => { setRepositoryUrl(event.target.value); setSuccessUrl(''); setRemoteCheck(null) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') void checkRemote() }}
                      placeholder="https://github.com/user/project"
                    />
                    <button
                      title="Проверить ссылку и доступ"
                      disabled={busy || checkingRemote || !repositoryUrl.trim()}
                      onClick={() => void checkRemote()}
                      className={`${button} shrink-0 bg-surface-2 hover:bg-surface-3`}
                    >
                      {checkingRemote ? <RefreshCw size={14} className="animate-spin" /> : <Link2 size={14} />}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-content-3">GitHub, GitLab, Gitea, Bitbucket или свой сервер — https или SSH.</p>
                  {checkingRemote && <p className="mt-1.5 text-[11px] text-content-2">Проверяю ссылку…</p>}
                  {remoteCheck && !checkingRemote && (
                    <div className={`mt-1.5 space-y-1.5 rounded border p-2 text-[11px] ${REMOTE_STATUS_STYLE[remoteCheck.status]}`}>
                      <p className="flex items-start gap-1.5">
                        {remoteCheck.status === 'ok' || remoteCheck.status === 'empty'
                          ? <CheckCircle2 size={13} className="mt-px shrink-0" />
                          : <AlertTriangle size={13} className="mt-px shrink-0" />}
                        <span className="text-content-1">{remoteCheck.message}</span>
                      </p>
                      {remoteCheck.status === 'ok' && (
                        <p className="text-content-2">
                          {remoteCheck.branches.includes(branch.trim())
                            ? <>Ветка <span className="font-mono">{branch.trim()}</span> есть — изменения будут добавлены поверх неё.</>
                            : <>Ветки <span className="font-mono">{branch.trim() || '—'}</span> нет — она будет создана.</>}
                        </p>
                      )}
                      <p className="text-[10px] text-content-3">Проверено {remoteCheck.checkedFrom === 'remote' ? 'с сервера' : 'с этого компьютера'}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {remoteCheck.createUrl && (remoteCheck.status === 'not-found' || remoteCheck.status === 'auth') && (
                          <button onClick={() => window.api.openExternal(remoteCheck.createUrl!)} className={`${button} bg-accent py-1 text-white hover:bg-accent-hover`}>
                            <Plus size={12} /> Создать репозиторий
                          </button>
                        )}
                        {(remoteCheck.status === 'ok' || remoteCheck.status === 'empty') && (
                          <button onClick={() => window.api.openExternal(remoteCheck.webUrl)} className={`${button} bg-surface-2 py-1 text-content-1 hover:bg-surface-3`}>
                            <ExternalLink size={12} /> Открыть
                          </button>
                        )}
                        {remoteCheck.status !== 'ok' && remoteCheck.status !== 'empty' && (
                          <button onClick={() => void checkRemote(remoteCheck.url)} className={`${button} bg-surface-2 py-1 text-content-1 hover:bg-surface-3`}>
                            <RefreshCw size={12} /> Проверить снова
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-content-2">Ветка</label>
                    <input className={field} value={branch} onChange={(event) => setBranch(event.target.value)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-content-2">Сообщение коммита</label>
                    <input className={field} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-content-2">Шаблон .gitignore</label>
                  <select className={field} value={preset} onChange={(event) => setPreset(event.target.value as GitIgnorePreset)}>
                    <option value="electron">Electron / Node.js</option>
                    <option value="node">Node.js</option>
                    <option value="python">Python</option>
                    <option value="visualstudio">Visual Studio / .NET</option>
                    <option value="none">Не изменять</option>
                  </select>
                  <p className="mt-1 text-[10px] text-content-3">Существующий файл не перезаписывается — выбранные правила только дополняются.</p>
                </div>

                <details className="rounded border border-surface-3 bg-surface-0 px-2.5 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold text-content-2">Дополнительные исключения</summary>
                  <textarea
                    className={`${field} mt-2 min-h-20 resize-y font-mono`}
                    value={customIgnore}
                    onChange={(event) => setCustomIgnore(event.target.value)}
                    placeholder="uploads/&#10;*.backup"
                  />
                </details>

                {(!state?.authorName || !state?.authorEmail) && (
                  <div className="grid grid-cols-2 gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5">
                    <p className="col-span-2 text-[10px] text-amber-700 dark:text-amber-300">Для первого коммита нужны имя и email автора.</p>
                    <input className={field} value={authorName} onChange={(event) => setAuthorName(event.target.value)} placeholder="Имя" />
                    <input className={field} value={authorEmail} onChange={(event) => setAuthorEmail(event.target.value)} placeholder="email@example.com" />
                  </div>
                )}

                {remoteMismatch && (
                  <label className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-200">
                    <input type="checkbox" checked={replaceRemote} onChange={(event) => setReplaceRemote(event.target.checked)} />
                    Заменить текущий origin: <span className="break-all font-mono">{state?.remoteUrl}</span>
                  </label>
                )}
              </section>

              <section className="flex min-h-0 flex-col rounded-lg border border-surface-3 bg-surface-0">
                <div className="flex items-center gap-2 border-b border-surface-3 px-3 py-2">
                  <span className="flex-1 text-xs font-semibold">Состояние проекта</span>
                  <button disabled={busy || checkingRemote || (!path && !repositoryUrl.trim())} onClick={() => void inspect()} className={`${button} bg-surface-2 py-1.5 hover:bg-surface-3`}>
                    <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Проверить
                  </button>
                </div>
                <div className="min-h-48 flex-1 overflow-y-auto p-3">
                  {!state && !progress.length && <p className="py-8 text-center text-xs text-content-3">Выберите папку и/или вставьте ссылку и нажмите «Проверить».</p>}
                  {state && (
                    <div className="space-y-2 text-[11px]">
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-content-3">Git</span><span>{state.gitAvailable ? 'доступен' : 'не найден'}</span>
                        <span className="text-content-3">Репозиторий</span><span>{state.initialized ? 'инициализирован' : 'будет создан'}</span>
                        <span className="text-content-3">Ветка</span><span className="font-mono">{state.branch || branch}</span>
                        <span className="text-content-3">Синхронизация</span><span>впереди {state.ahead}, позади {state.behind}</span>
                      </div>
                      {state.remoteUrl && <p className="break-all rounded bg-surface-1 p-2 font-mono text-[10px] text-content-2">origin: {state.remoteUrl}</p>}
                      <div className="border-t border-surface-3 pt-2">
                        <p className="mb-1 font-semibold">Изменения: {state.changes.length}{state.truncated ? '+' : ''}</p>
                        {state.clean ? (
                          <p className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> Рабочая папка чистая</p>
                        ) : (
                          <div className="max-h-44 overflow-y-auto rounded border border-surface-3">
                            {state.changes.map((item, index) => (
                              <div key={`${item.path}-${index}`} className="flex gap-2 border-b border-surface-3/60 px-2 py-1 last:border-0">
                                <span className="w-20 shrink-0 text-content-3">{statusLabel(item.status)}</span>
                                <span className="min-w-0 break-all font-mono text-[10px]">{item.path}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {sensitive.length > 0 && (
                    <div className="mt-3 rounded border border-red-500/40 bg-red-500/5 p-2 text-[10px] text-red-700 dark:text-red-300">
                      <p className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> Возможные секреты или локальные данные</p>
                      {sensitive.slice(0, 8).map((item) => <p key={item.path} className="break-all font-mono">{item.path}</p>)}
                      <p className="mt-1">Выбранный шаблон может исключить часть файлов. Проверьте список перед публикацией.</p>
                      <label className="mt-2 flex items-center gap-1.5 text-content-2">
                        <input type="checkbox" checked={confirmSensitive} onChange={(event) => setConfirmSensitive(event.target.checked)} />
                        Я проверил эти файлы и правила .gitignore
                      </label>
                    </div>
                  )}
                  {progress.length > 0 && (
                    <div className="mt-3 space-y-1 border-t border-surface-3 pt-2">
                      {progress.map((item, index) => (
                        <p key={`${item.phase}-${index}`} className={`text-[10px] ${item.phase === 'done' ? 'text-emerald-400' : 'text-content-2'}`}>{item.message}</p>
                      ))}
                    </div>
                  )}
                  {error && <p className="mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">{error}</p>}
                  {successUrl && (
                    <button onClick={() => window.api.openExternal(successUrl)} className="mt-3 flex w-full items-center justify-center gap-1 rounded bg-emerald-500/15 px-2 py-2 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25">
                      <ExternalLink size={13} /> Открыть репозиторий на GitHub
                    </button>
                  )}
                </div>
              </section>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-surface-3 px-4 py-3">
            {kind === 'local' && (
              <button disabled={busy} onClick={() => void login()} className={`${button} bg-surface-2 text-content-2 hover:bg-surface-3`}>
                <LogIn size={14} /> Войти через GitHub
              </button>
            )}
            <span className="flex-1 text-[10px] text-content-3">Force push не используется. При расхождении историй операция остановится.</span>
            <button
              disabled={busy || checkingRemote || remoteBlocked || !path || !repositoryUrl || (sensitive.length > 0 && !confirmSensitive) || (remoteMismatch && !replaceRemote)}
              onClick={() => void publish()}
              className={`${button} bg-accent text-white hover:bg-accent-hover`}
              title={
                remoteBlocked
                  ? 'Сначала устраните проблему с удалённым репозиторием и проверьте ссылку снова'
                  : sensitive.length > 0 && !confirmSensitive ? 'Подтвердите проверку возможных секретов' : undefined
              }
            >
              <UploadCloud size={14} /> {busy ? 'Выполняется…' : state?.initialized ? 'Обновить GitHub' : 'Опубликовать'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
