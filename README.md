<div align="center">

# ⚛️ LiteSSH

**Лёгкий, быстрый и красивый SSH-клиент для Windows, Linux и macOS.**

Терминал · SFTP · менеджер ключей · туннели · метрики — вдохновлён MobaXterm,
но минималистичный, современный и без лишнего веса.

`Electron` · `React` · `TypeScript` · `xterm.js` · `ssh2` · `better-sqlite3` · `Tailwind` · `Radix UI`

Версия **1.0.1** · Автор: **Krainevtech and AI Anthropic Claude** · Контакт: [Telegram @giminot](https://t.me/giminot) · Лицензия: **PolyForm Noncommercial 1.0.0**

</div>

---

## Возможности

### Подключение и терминал
- SSH-аутентификация: пароль / приватный ключ / ssh-agent (в т.ч. Windows OpenSSH agent)
- Проверка ключа сервера (TOFU): диалог с SHA256-отпечатком, красное предупреждение при смене ключа — защита от MITM; отдельный экран управления `known_hosts`
- Терминал на xterm.js: 256 цветов, WebGL-рендер, вкладки, поиск (Ctrl+Shift+F), копирование/вставка (Ctrl+C/V, Ctrl+Shift+C/V)
- **Split view**: разделение терминала на панели (горизонтально/вертикально, до 4) на одном соединении, с синхронным вводом во все панели
- Быстрое подключение `user@host:port` (агент → fallback на пароль)
- Локальные терминалы: PowerShell / cmd / WSL / Git Bash в тех же вкладках, что и SSH
- Переподключение отвалившихся сессий, keep-alive, автоблокировка окна в трей

### Сессии
- Сохранённые сессии в SQLite
- **Группы** (LAN / VPN / Работа и любые свои): сворачиваемые заголовки со счётчиком, сессии без группы — отдельно сверху; создание/назначение через форму (автодополнение) или ПКМ по сессии → «переместить в группу»
- **Теги и поиск** по хостам (имя/хост/пользователь/группа/теги)
- **Шаблоны**: новая сессия может скопировать настройки из существующей
- Импорт из `~/.ssh/config`, экспорт/импорт в JSON
- **ProxyJump / цепочки бастионов**: подключение через один или несколько промежуточных хостов
- Проброс SSH-агента (ForwardAgent)

### Файлы (SFTP)
- Двухпанельный менеджер (локально ↔ сервер): навигация, создание папок, rename, chmod, рекурсивное удаление, копирование пути
- Передача файлов: drag & drop из проводника, кнопки «На сервер» / «Скачать», очередь с прогрессом и отменой, рекурсивные папки
- **Докачка (resume)**: прерванную передачу можно продолжить с места остановки
- Предпросмотр и правка: редактор CodeMirror (~40 языков, сохранение по Ctrl+S), просмотрщик изображений, hex-viewer для бинарных

### Ключи и безопасность
- Менеджер ключей: генерация Ed25519 / RSA / ECDSA, импорт (включая passphrase-защищённые), экспорт, деплой в `authorized_keys`
- Секреты по умолчанию — в keychain ОС (DPAPI / Keychain / libsecret), никогда в открытом виде
- **Опциональный мастер-пароль**: режим scrypt + AES-256-GCM, экран блокировки, автоблокировка по неактивности

### Сеть и мониторинг
- **Туннели**: local (`-L`), remote (`-R`), dynamic SOCKS5 (`-D`), автозапуск с сессией, мониторинг соединений и трафика
- **Метрики хоста**: дашборд CPU / RAM / диск / load / аптайм (опрос раз в 2.5 с)
- **Remote Desktop через SSH в один клик** (иконка монитора): поднимает эфемерный туннель на `:3389` сервера и запускает системный RDP-клиент (`mstsc.exe`) — картинку рисует ОС, трафик идёт зашифрованным внутри SSH. Встроенного RDP-рендерера нет намеренно (чтобы не раздувать «lite»-клиент)
- Журналирование сессии в файл (без ANSI-кодов)

### Удобство
- Сниппеты команд + история команд в общей палитре (Ctrl+Shift+P)
- **Библиотека скриптов/пресетов** (иконка терминала-документа): многострочные скрипты с категориями (Provisioning / VPN / свои), редактор с подсветкой; два режима запуска — вставка в терминал и **«загрузить и выполнить»** (скрипт пишется во временный файл на сервере через SFTP и запускается одной командой — надёжно для sudo/heredoc, с живым выводом)
- **Настраиваемые горячие клавиши** (в настройках): переключение терминал/файлы, вкладки, split, новый терминал, палитра и др. — с перепривязкой и сбросом
- **Файловый менеджер в стиле mc**: нижняя панель функциональных клавиш (F3 просмотр, F4 правка, F5 копирование, F7 папка, F8 удаление с подтверждением), действует над активной панелью
- Настройки: 4 темы терминала, размер шрифта, акцентный цвет, горячие клавиши
- Несколько окон (как вкладки в браузере), сворачивание в системный трей
- Тёмная/светлая тема, системные уведомления

### Оформление
- Кастомный титлбар (frameless + системные кнопки через `titleBarOverlay`), цвет — под тему
- Встроенные шрифты: **Inter** для интерфейса, **JetBrains Mono** для терминала (бандлятся, без сети)
- Цветные иконки файлов по типу в SFTP-панелях, плавные появления диалогов и тостов (200 мс)

## Установка и запуск

```powershell
npm install          # при сбое сборки нативных модулей см. примечание ниже
npm run dev          # разработка с HMR
npm run build        # прод-сборка в out/
npx electron .       # запуск собранного приложения
npm run dist         # установщик → release/LiteSSH-<версия>-setup.exe
```

Готовый установщик Windows: **`release/LiteSSH-1.0.1-setup.exe`** (NSIS, x64, с выбором папки установки).
Нативные модули (`better-sqlite3`, `node-pty`) распаковываются из asar (`asarUnpack`); пересборка при
упаковке отключена (`npmRebuild: false`) — используются готовые prebuild-бинарники под ABI Electron.

**Обновление/переустановка без потери данных.** Настройки, история команд, сессии и ключи хранятся в
`%APPDATA%\LiteSSH` (userData) — **отдельно от папки установки**, поэтому переустановка их не затрагивает.
При запуске установщика поверх существующей версии показывается уведомление, что данные будут сохранены,
и выполняется обновление (кастомный `build/installer.nsh`, `deleteAppDataOnUninstall: false`). Дополнительно
при первом запуске новой версии приложение делает резервную копию БД в `%APPDATA%\LiteSSH\backups`
(хранятся 5 последних) — на случай неудачной миграции.

**Примечание (Windows без VS Build Tools):** если `npm install` падает на компиляции `better-sqlite3` —
поставьте зависимости без скриптов и подтяните готовый бинарник:

```powershell
npm install --ignore-scripts --legacy-peer-deps
node node_modules/electron/install.js
cd node_modules/better-sqlite3
npx prebuild-install --runtime=electron --target=<версия electron> --arch=x64
```

## Архитектура (кратко)

Весь SSH и все секреты живут **только в main-процессе**; renderer — чистый UI за typed-IPC (`contextIsolation`
+ `sandbox`, валидация zod). Панели split view делят одно соединение (доп. shell-каналы + рефкаунт клиента).
Тяжёлые модули (CodeMirror, предпросмотры) грузятся лениво. Подробности — в документации ниже.

## Документация

- [/ARCHITECTURE.md](/ARCHITECTURE.md) — архитектура, процессная модель, структура, схема БД


## Иконка

Иконка приложения (атом с орбитами: `build/icon.ico` + `icon.png`) генерируется из `build/icon.html`
через Electron: `npx electron build/make-icon.js`. Применяется к `.exe`, окну, трею и установщику.

## Принципы разработки

1. Весь SSH и секреты — только в main-процессе; renderer — чистый UI.
2. Host key verification — всегда, с первой версии.
3. Секреты — в keychain ОС по умолчанию (или под мастер-паролем), никогда в открытом виде.
4. Тяжёлое (редактор, предпросмотры) — lazy; списки виртуализируются.
5. Каждая фаза заканчивается инструментом, которым пользуемся ежедневно.

## Автор

**Krainevtech and AI Claude** — спроектировано и разработано совместно.
Контакт: [Telegram @giminot](https://t.me/giminot)

## Лицензия

Проект распространяется под лицензией **PolyForm Noncommercial License 1.0.0** — см. [LICENSE](LICENSE).

Это «source-available» лицензия: код **открыт** — его можно свободно смотреть, изучать, изменять и
делиться им — **но только в некоммерческих целях**. Слепо копировать проект и продавать / перепродавать
его (или производные) как платный продукт или сервис **нельзя** без отдельной коммерческой лицензии от
правообладателя. По вопросам коммерческого использования: [Telegram @giminot](https://t.me/giminot).

ENG

<div align="center">

# ⚛️ LiteSSH

**Lightweight, fast, and beautiful SSH client for Windows, Linux, and macOS.**

Terminal · SFTP · Key manager · Tunnels · Metrics — inspired by MobaXterm,
but minimalistic, modern, and without the bloat.

`Electron` · `React` · `TypeScript` · `xterm.js` · `ssh2` · `better-sqlite3` · `Tailwind` · `Radix UI`

Version **1.0.1** · Author: **Krainevtech and AI** · Contact: [Telegram @giminot](https://t.me/giminot) · License: **PolyForm Noncommercial 1.0.0**

</div>

---

## Features

### Connection & Terminal
- SSH authentication: password / private key / ssh-agent (including Windows OpenSSH agent)
- Host key verification (TOFU): dialog with SHA256 fingerprint, red warning on key change — MITM protection; separate `known_hosts` management screen
- xterm.js terminal: 256 colors, WebGL rendering, tabs, search (Ctrl+Shift+F), copy/paste (Ctrl+C/V, Ctrl+Shift+C/V)
- **Split view**: split terminal into panels (horizontal/vertical, up to 4) on a single connection, with synchronized input across all panels
- Quick connect `user@host:port` (agent → fallback to password)
- Local terminals: PowerShell / cmd / WSL / Git Bash in the same tabs as SSH
- Auto-reconnect of dropped sessions, keep-alive, auto-minimize to tray

### Sessions
- Saved sessions in SQLite
- **Groups** (LAN / VPN / Work and custom): collapsible headers with counters, sessions without a group shown separately at the top; create/assign via form (autocomplete) or right-click → "Move to group"
- **Tags and search** by hostname (name/host/user/group/tags)
- **Templates**: new session can copy settings from an existing one
- Import from `~/.ssh/config`, export/import to JSON
- **ProxyJump / bastion chains**: connect through one or multiple intermediate hosts
- SSH agent forwarding (ForwardAgent)

### Files (SFTP)
- Two-panel file manager (local ↔ remote): navigation, create folders, rename, chmod, recursive delete, copy path
- File transfer: drag & drop from Explorer, "Upload" / "Download" buttons, queue with progress and cancellation, recursive folders
- **Resume**: interrupted transfers can be continued from where they stopped
- Preview and edit: CodeMirror editor (~40 languages, save with Ctrl+S), image viewer, hex viewer for binaries

### Keys & Security
- Key manager: generate Ed25519 / RSA / ECDSA, import (including passphrase-protected), export, deploy to `authorized_keys`
- Secrets stored in OS keychain by default (DPAPI / Keychain / libsecret), never in plaintext
- **Optional master password**: scrypt + AES-256-GCM mode, lock screen, auto-lock on inactivity

### Networking & Monitoring
- **Tunnels**: local (`-L`), remote (`-R`), dynamic SOCKS5 (`-D`), auto-start with session, connection and traffic monitoring
- **Host metrics**: dashboard for CPU / RAM / disk / load / uptime (polled every 2.5s)
- **Remote Desktop via SSH in one click** (monitor icon): spawns an ephemeral tunnel to `:3389` on the server and launches the system RDP client (`mstsc.exe`) — rendering is handled by the OS, traffic flows encrypted inside SSH. No built-in RDP renderer by design (to keep the "lite" client lightweight)
- Session logging to file (without ANSI codes)

### Convenience
- Command snippets + command history in the command palette (Ctrl+Shift+P)
- **Script/preset library** (terminal-document icon): multi-line scripts with categories (Provisioning / VPN / custom), editor with syntax highlighting; two execution modes — paste into terminal and **"upload & execute"** (script is written to a temp file on the server via SFTP and executed with a single command — reliable for sudo/heredoc, with live output)
- **Customizable keyboard shortcuts** (in settings): toggle terminal/files, tabs, split, new terminal, palette, etc. — with rebinding and reset
- **mc-style file manager**: bottom function key bar (F3 view, F4 edit, F5 copy, F7 folder, F8 delete with confirmation), acts on the active panel
- Settings: 4 terminal themes, font size, accent color, keyboard shortcuts
- Multiple windows (like browser tabs), minimize to system tray
- Dark/light theme, system notifications

### Visual Design
- Custom title bar (frameless + system buttons via `titleBarOverlay`), color matching the theme
- Bundled fonts: **Inter** for UI, **JetBrains Mono** for terminal (bundled, works offline)
- Color-coded file icons by type in SFTP panels, smooth dialog and toast animations (200ms)

## Installation and Running

```powershell
npm install          # if native module build fails, see note below
npm run dev          # development with HMR
npm run build        # production build to out/
npx electron .       # run the built app
npm run dist         # installer → release/LiteSSH-<version>-setup.exe

Windows installer: release/LiteSSH-1.0.1-setup.exe (NSIS, x64, with installation directory selection).
Native modules (better-sqlite3, node-pty) are unpacked from asar (asarUnpack); rebuild during packaging
is disabled (npmRebuild: false) — using prebuilt binaries for Electron's ABI.

Update/reinstall without data loss. Settings, command history, sessions, and keys are stored in
%APPDATA%\LiteSSH (userData) — separate from the installation folder, so reinstallation does not affect them.
When installing over an existing version, a notification shows that data will be preserved,
and an update is performed (custom build/installer.nsh, deleteAppDataOnUninstall: false). Additionally,
on first launch of a new version, the app creates a database backup in %APPDATA%\LiteSSH\backups
(keeps the last 5) — in case of a failed migration.

Note (Windows without VS Build Tools): if npm install fails on better-sqlite3 compilation —
install dependencies without scripts and pull the prebuilt binary:

powershell
npm install --ignore-scripts --legacy-peer-deps
node node_modules/electron/install.js
cd node_modules/better-sqlite3
npx prebuild-install --runtime=electron --target=<electron version> --arch=x64
Architecture (Brief)
All SSH and secrets live only in the main process; renderer is pure UI over typed IPC (contextIsolation

sandbox, zod validation). Split view panels share a single connection (additional shell channels + client refcounting).
Heavy modules (CodeMirror, previews) are lazy-loaded. Details in the documentation below.

Documentation

/ARCHITECTURE.md — architecture, process model, structure, database schema

Icon
The app icon (atom with orbits: build/icon.ico + icon.png) is generated from build/icon.html
via Electron: npx electron build/make-icon.js. Applied to .exe, window, tray, and installer.

Development Principles
All SSH and secrets — only in the main process; renderer — pure UI.

Host key verification — always, from the very first version.

Secrets — in OS keychain by default (or under master password), never in plaintext.

Heavy features (editor, previews) — lazy-loaded; lists are virtualized.

Each phase ends with a tool we use daily.

Author
Krainevtech and AI — co-designed and developed.
Contact: Telegram @giminot

License
This project is distributed under the PolyForm Noncommercial License 1.0.0 — see LICENSE.

This is a "source-available" license: the code is open — you are free to view, study, modify, and
share it — but only for non-commercial purposes. Blindly copying the project and selling / reselling
it (or derivatives) as a commercial product or service is not allowed without a separate commercial license
from the copyright holder. For commercial use inquiries: Telegram @giminot.
