# Архитектура LiteSSH

## Технологический стек (уточнённый)

| Слой | Технология | Зачем |
|---|---|---|
| Оболочка | Electron 33+ (electron-vite, electron-builder) | Кроссплатформенность Win/Linux/macOS |
| UI | React 18 + TypeScript (strict) | |
| Стили | Tailwind CSS 4 + Radix UI + Lucide | Тёмная/светлая тема через CSS-переменные |
| Терминал | **xterm.js** + addons: fit, search, webgl, unicode11, web-links | Эмуляция, 256/truecolor, поиск |
| SSH/SFTP | **ssh2** (main-процесс) | Exec, shell, sftp, туннели, agent |
| Локальный терминал | node-pty | PowerShell/bash-вкладки как в MobaXterm |
| БД | better-sqlite3 (main-процесс) | Сессии, папки, сниппеты, история |
| Секреты | Electron safeStorage → OS keychain; опц. AES-256-GCM vault | |
| Состояние | Zustand | |
| Списки | TanStack Virtual | 10 000+ файлов без лагов |
| Редактор | Monaco (lazy chunk) | Предпросмотр/правка текстов |
| Валидация | zod | IPC-граница и импорт конфигов |

## Процессная модель

Главный принцип: **весь SSH и все секреты живут только в main-процессе**. Renderer — чистый UI, не имеет доступа к Node API (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).

```
┌───────────────────────── Main process ─────────────────────────┐
│  ssh-core: ConnectionManager (пул ssh2-клиентов)               │
│    ├─ ShellSession   (данные → renderer потоком по IPC)        │
│    ├─ SftpSession    (list/get/put/stat, очередь трансферов)   │
│    ├─ TunnelManager  (local/remote forward, статистика)        │
│    └─ HostKeyStore   (known_hosts, TOFU + предупреждение MITM) │
│  vault: keychain (safeStorage) | file-vault (AES-256-GCM)      │
│  db: better-sqlite3 (сессии, папки, сниппеты, история)         │
│  keygen: генерация RSA/Ed25519/ECDSA (ssh2/crypto)             │
└──────────────── typed IPC (zod-схемы, invoke/stream) ──────────┘
┌──────────────────────── Renderer (React) ──────────────────────┐
│  Sidebar (дерево сессий) │ TabsArea (терминалы, split view)    │
│  SFTP two-pane │ Preview (Monaco/img/hex — lazy) │ StatusBar   │
└────────────────────────────────────────────────────────────────┘
```

Поток данных терминала — самое горячее место: `ssh2 stream → IPC (batched, Uint8Array) → xterm.write()`. Батчинг ~5–10мс, чтобы не захлебнуться на `cat bigfile`.

## Структура проекта

```
litessh/
├─ electron/
│  ├─ main/
│  │  ├─ index.ts              # bootstrap, окна, меню
│  │  ├─ ipc/                  # typed-обработчики (zod)
│  │  ├─ ssh/
│  │  │  ├─ connection-manager.ts
│  │  │  ├─ shell-session.ts
│  │  │  ├─ sftp-session.ts
│  │  │  ├─ tunnel-manager.ts
│  │  │  ├─ host-keys.ts
│  │  │  └─ agent.ts           # Pageant / ssh-agent / OpenSSH agent
│  │  ├─ vault/                # keychain + file-vault (AES-256-GCM)
│  │  ├─ keygen/
│  │  ├─ db/                   # схема, миграции, репозитории
│  │  └─ pty/                  # локальные терминалы
│  └─ preload/index.ts         # contextBridge: window.api.*
├─ src/                        # renderer
│  ├─ app/                     # layout, роутинг табов, темы
│  ├─ features/
│  │  ├─ connections/          # сайдбар, формы, quick-connect
│  │  ├─ terminal/             # xterm-обёртка, split, поиск, сниппеты
│  │  ├─ sftp/                 # две панели, DnD, очередь трансферов
│  │  ├─ preview/              # lazy: monaco / image / hex
│  │  ├─ keys/                 # генератор, менеджер, deploy на сервер
│  │  ├─ tunnels/              # визуальный редактор, мониторинг
│  │  └─ settings/
│  ├─ shared/                  # ui-kit, hooks, ipc-клиент
│  └─ stores/                  # zustand
├─ shared/                     # типы и zod-схемы, общие для main/renderer
├─ resources/                  # иконки, шрифты (Inter, JetBrains Mono)
└─ docs/
```

## Ключевые решения

### Безопасность
- **Host key verification обязательна**: TOFU-диалог с отпечатком (SHA256, ASCII-art), красный алерт при смене ключа. Хранение в своей таблице + экспорт в формат known_hosts.
- **Секреты**: по умолчанию keychain ОС; file-vault (argon2id → ключ → AES-256-GCM) — опция для переносимости. Приватные ключи и пароли никогда не проходят через renderer.
- Автоблокировка vault по таймеру неактивности; очистка буфера обмена после копирования пароля (опция).

### SFTP и трансферы
- Очередь трансферов в main-процессе: параллелизм 3–4 потока, resume для больших файлов, рекурсивные папки через walk с прогрессом «файлов/байт».
- DnD из ОС: `webUtils.getPathForFile()`; DnD «удалённое → ОС» — через drag-out с временным файлом (v1.0 — кнопка Download, drag-out позже).
- Листинги кэшируются per-session, инвалидация по операциям.

### Терминал
- Одна xterm-инстанция на вкладку, WebGL-рендерер с fallback на canvas.
- Split view: layout-дерево (h/v-сплиты) в zustand, каждая панель — отдельный ShellSession.
- Сниппеты и история — SQLite, поиск по Ctrl+R-подобной палитре.

### Производительность
- Monaco, pdf.js, hex-viewer — динамические import(), не входят в стартовый бандл.
- Файловые списки и дерево сессий — виртуализированы.
- V8 snapshot / lazy require в main для быстрого старта.

## Схема БД (основное)

```sql
folders(id, name, parent_id, sort)
sessions(id, folder_id, name, host, port, username, auth_type,
         key_id, use_agent, options_json, template_id, created, last_used)
keys(id, name, algo, public_key, private_ref /* keychain-ссылка или vault */)
known_hosts(host, port, key_type, fingerprint, added_at)
snippets(id, name, command, tags)
tunnels(id, session_id, type /*local|remote|dynamic*/, src, dst, autostart)
history(id, session_id, command, ts)
```
