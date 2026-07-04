; Custom NSIS uninstaller for AgentDock.
;
; Hook: customUnInstall — called inside Section "Uninstall" body
; (valid for runtime NSIS commands).
;
; electron-builder's default uninstaller cleans $APPDATA\<APP_FILENAME>
; (per-user appData). This macro additionally cleans
; $PROGRAMDATA\AgentDock (perMachine shared data path) when it exists.

!macro customUnInstall
  StrCpy $0 "$PROGRAMDATA"
  StrCpy $0 "$0\AgentDock"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
!macroend
