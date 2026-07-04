; Custom NSIS uninstaller for AgentDock.
;
; electron-builder's default uninstaller only cleans
;   $APPDATA\<APP_FILENAME>     (per-user appData)
; It does NOT clean the perMachine data path:
;   $PROGRAMDATA\AgentDock
; which we now write to when installed perMachine.
;
; This script hooks the standard "delete app data" path and additionally
; removes $PROGRAMDATA\AgentDock if it exists, so uninstall fully
; cleans up regardless of which install mode the user picked.

!macro customUnInstallSection
  ; electron-builder's standard delete-data path runs at
  ; un.onInit, before customUnInstallSection. By the time we get here,
  ; $APPDATA\AgentDock is already gone if DELETE_APP_DATA_ON_UNINSTALL
  ; was set. We just need to nuke the ProgramData location too.
  ${If} ${Silent}
    ${If} ${RunningX64}
      StrCpy $0 "$PROGRAMFILES64"
    ${Else}
      StrCpy $0 "$PROGRAMFILES"
    ${EndIf}
    StrCpy $0 "$0\${APP_FILENAME}"

    ; Detect whether we were installed perMachine by checking if the
    ; uninstaller was registered under HKLM (perMachine) vs HKCU (perUser).
    ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayName
    ${If} $1 != ""
      ; PerMachine install — also nuke $PROGRAMDATA\AgentDock
      ${If} ${FileExists} "$PROGRAMDATA\AgentDock"
        RMDir /r "$PROGRAMDATA\AgentDock"
      ${EndIf}
    ${EndIf}
  ${Else}
    ; GUI uninstall — also clear perMachine data so the user doesn't
    ; leave behind a shared project DB after they think they've cleaned
    ; everything up. PerUser-only installs won't have PROGRA~1\AgentDock.
    ${If} ${FileExists} "$PROGRAMDATA\AgentDock"
      RMDir /r "$PROGRAMDATA\AgentDock"
    ${EndIf}
  ${EndIf}
!macroend
