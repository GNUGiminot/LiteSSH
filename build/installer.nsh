; Кастомизация установщика LiteSSH.
; Настройки/история/сессии/ключи хранятся в %APPDATA%\LiteSSH (userData), отдельно от папки
; установки, поэтому установщик их не трогает. Здесь мы дополнительно:
;  - обнаруживаем ранее установленную версию и показываем уведомление;
;  - явно НЕ удаляем пользовательские данные (deleteAppDataOnUninstall=false в конфиге).

!macro customInit
  ; Ищем ранее установленную версию (per-user, затем per-machine)
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}

  ${If} $0 != ""
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
      "Обнаружена ранее установленная версия LiteSSH ($0).$\n$\n\
Ваши настройки, история команд, сохранённые сессии и ключи будут СОХРАНЕНЫ.$\n\
Будет выполнено обновление до версии ${VERSION}.$\n$\n\
Продолжить?" \
      IDOK continueInstall
    Abort
    continueInstall:
  ${EndIf}
!macroend

; При деинсталляции в рамках обновления электрон-билдер сам сохраняет данные.
; На всякий случай ничего дополнительно не удаляем в customUnInstall.
!macro customUnInstall
!macroend
