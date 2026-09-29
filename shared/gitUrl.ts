/**
 * Разбор ссылки на Git-репозиторий: GitHub, GitLab, Gitea, Bitbucket, собственный сервер.
 * Принимаются только https/http, ssh:// и scp-подобная форма user@host:path — никаких
 * `ext::`, `file://` и локальных путей (git умеет выполнять команды через транспорт ext::).
 */
export interface ParsedRepositoryUrl {
  /** Ссылка для git (origin / ls-remote) */
  gitUrl: string
  /** Адрес страницы проекта в браузере */
  webUrl: string
  host: string
  /** Путь проекта без .git: owner/name или group/subgroup/name */
  path: string
  /** Ссылка на создание репозитория у известных хостингов */
  createUrl?: string
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const SEGMENT_RE = /^[A-Za-z0-9_.~-]+$/
const SCP_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/

export const REPOSITORY_URL_HINT =
  'Укажите ссылку вида https://github.com/user/project, https://gitlab.com/group/project или git@host:user/project.git'

function cleanPath(raw: string): string {
  const path = raw.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const segments = path.split('/')
  if (!path || segments.some((segment) => !SEGMENT_RE.test(segment) || segment === '.' || segment === '..')) {
    throw new Error(REPOSITORY_URL_HINT)
  }
  return path
}

function createUrlFor(host: string, path: string): string | undefined {
  const segments = path.split('/')
  const name = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  if (host === 'github.com' && segments.length === 2) {
    return `https://github.com/new?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`
  }
  if (host === 'gitlab.com') return 'https://gitlab.com/projects/new#blank_project'
  if (host === 'bitbucket.org') return 'https://bitbucket.org/repo/create'
  return undefined
}

export function parseRepositoryUrl(value: string): ParsedRepositoryUrl {
  const raw = String(value ?? '').trim()
  if (!raw || /[\s\0]/.test(raw)) throw new Error(REPOSITORY_URL_HINT)

  const scp = SCP_RE.exec(raw)
  if (scp) {
    const host = scp[2].toLowerCase()
    if (!HOST_RE.test(host)) throw new Error(REPOSITORY_URL_HINT)
    const path = cleanPath(scp[3])
    return { gitUrl: raw, webUrl: `https://${host}/${path}`, host, path, createUrl: createUrlFor(host, path) }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(REPOSITORY_URL_HINT)
  }
  const protocol = parsed.protocol
  if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'ssh:') throw new Error(REPOSITORY_URL_HINT)
  if (parsed.password) {
    throw new Error('Не вставляйте пароль или токен в ссылку — используйте вход через Git Credential Manager или SSH-ключ')
  }
  if (parsed.search || parsed.hash) throw new Error(REPOSITORY_URL_HINT)
  const host = parsed.hostname.toLowerCase()
  if (!HOST_RE.test(host)) throw new Error(REPOSITORY_URL_HINT)
  const path = cleanPath(decodeURIComponent(parsed.pathname))

  if (protocol === 'ssh:') {
    return { gitUrl: raw.replace(/\/+$/, ''), webUrl: `https://${host}/${path}`, host, path, createUrl: createUrlFor(host, path) }
  }
  const origin = `${protocol}//${parsed.host.toLowerCase()}`
  // GitHub принимает ссылку и без .git, но с ним однозначнее; для остальных хостов сохраняем как ввели
  const gitUrl = host === 'github.com' ? `${origin}/${path}.git` : raw.replace(/\/+$/, '')
  return { gitUrl, webUrl: `${origin}/${path}`, host, path, createUrl: createUrlFor(host, path) }
}

/** Ключ для сравнения ссылок: https и ssh-формы одного проекта считаются одинаковыми. */
export function repositoryIdentity(value: string): string {
  try {
    const parsed = parseRepositoryUrl(value)
    return `${parsed.host}/${parsed.path}`.toLowerCase()
  } catch {
    return String(value ?? '').trim().toLowerCase()
  }
}
