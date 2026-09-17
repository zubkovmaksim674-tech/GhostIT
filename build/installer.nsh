; customInstall — вызывается electron-builder в конце установки
; Удаляет старые версии и следы апдейтера (только пользовательские пути,
; распакованные копии в системном Temp чистит sweep при старте приложения).
!macro customInstall
  ; старые каталоги установки (до ребрендинга GhostQA -> GhostIT)
  RMDir /r "$LOCALAPPDATA\Programs\GhostQA"
  RMDir /r "$LOCALAPPDATA\Programs\ghost-qa"
  ; остатки апдейтера в temp текущего пользователя
  Delete "$TEMP\GhostIT-new.exe"
  Delete "$TEMP\GhostIT-new.exe.part"
  Delete "$TEMP\GhostQA-new.exe"
  Delete "$TEMP\GhostQA-new.exe.part"
  Delete "$TEMP\ghostit-update-helper.js"
  Delete "$TEMP\ghostit-update-helper.vbs"
  Delete "$TEMP\ghostit-update.cmd"
  Delete "$TEMP\ghostit-update.log"
  Delete "$TEMP\ghostqa-update-helper.js"
  Delete "$TEMP\ghostqa-update.log"
!macroend
