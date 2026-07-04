; Custom NSIS uninstaller for AgentDock.
;
; Hook: customUnInstall — called inside Section "Uninstall" body
; (valid for runtime NSIS commands). NOT customUnInstallSection
; which is expanded at script top-level where runtime commands are
; forbidden by the NSIS compiler.
;
; electron-builder's default uninstaller already cleans
;   $APPDATA\<APP_FILENAME> (per-user appData).
; This macro additionally cleans
;   $PROGRAMDATA\AgentDock  (perMachine shared data path)
; when it exists, so uninstall fully cleans up regardless of which
; install mode the user originally picked.

!macro customUnInstall
  ${If} ${FileExists} "$PROGRAMDATA\AgentDock"
    RMDir /r "$PROGRAMDATA\AgentDock"
  ${EndIf}
!macroend
