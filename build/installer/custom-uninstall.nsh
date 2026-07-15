; Custom NSIS uninstaller for AgentDock.
;
; electron-builder's default uninstaller cleans $APPDATA\<APP_FILENAME>
; (per-user data). This macro additionally cleans $PROGRAMDATA\AgentDock
; (perMachine shared data path) when it exists.
;
; Note: NSIS's $PROGRAMDATA variable is only available via NsisMultiUser
; in certain NSIS versions. We hardcode the standard ProgramData path
; since Windows uses "ProgramData" in English regardless of locale.

!macro customUnInstall
  StrCpy $0 "C:\ProgramData\AgentDock"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
!macroend
