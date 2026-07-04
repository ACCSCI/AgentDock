; Custom NSIS uninstaller for AgentDock.
;
; electron-builder's default uninstaller cleans
;   $APPDATA\<APP_FILENAME>   (per-user appData).
; It does NOT clean the perMachine data path:
;   $PROGRAMDATA\AgentDock.
;
; This macro hooks the standard "delete app data" path and additionally
; removes $PROGRAMDATA\AgentDock when it exists.

!macro customUnInstallSection
  ${If} ${FileExists} "$PROGRAMDATA\AgentDock"
    RMDir /r "$PROGRAMDATA\AgentDock"
  ${EndIf}
!macroend
