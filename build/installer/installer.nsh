; preInit: clear legacy InstallLocation cache so the next install falls
; back to the perUser default path. Only clean on fresh installs.
!macro preInit
  !ifdef BUILD_UNINSTALLER
    !macroend
  !endif
  !ifndef UNINSTALLER_OUT_FILE
    ${IfNot} ${isUpdated}
      DeleteRegValue HKLM "Software\AgentDock" "InstallLocation"
      DeleteRegValue HKCU "Software\AgentDock" "InstallLocation"
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
  !endif
!macroend

; customInstall: force the default install path to the perUser
; convention ($LOCALAPPDATA\Programs\AgentDock). Skipped on upgrade
; and skipped on the uninstaller build.
!macro customInstall
  !ifdef BUILD_UNINSTALLER
    !macroend
  !endif
  !ifndef UNINSTALLER_OUT_FILE
    ${IfNot} ${isUpdated}
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
  !endif
!macroend

; customUnInstall: runs inside Section "Uninstall". Removes data from
; every location AgentDock may have written to. IMPORTANT: $USERPROFILE
; is NOT a valid NSIS built-in variable — it's a Windows env var that
; NSIS doesn't inherit in uninstaller context. We derive the user's
; home directory from $DESKTOP by stripping the trailing "Desktop" (8
; chars + trailing backslash = 8 chars from the end).
!macro customUnInstall
  ; 1. Install dir (Local\Programs\AgentDock)
  StrCpy $0 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
  ; 2. Roaming userData (electron default $APPDATA\AgentDock)
  StrCpy $0 "$APPDATA\${APP_FILENAME}"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
  ; 3. PerMachine data (C:\ProgramData\AgentDock)
  StrCpy $0 "C:\ProgramData\AgentDock"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
  ; 4. Legacy homedir global DB (pre-v0.3 fallback)
  ;    $DESKTOP = C:\Users\<u>\Desktop; strip last 8 chars ("Desktop")
  ;    gives C:\Users\<u>\, then append ".agentdock"
  StrCpy $0 "$DESKTOP"
  StrCpy $0 $0 -8
  StrCpy $0 "$0.agentdock"
  ${If} ${FileExists} "$0"
    RMDir /r "$0"
  ${EndIf}
!macroend

; customUnInstallSection: Section-level fallback for homedir cleanup.
; Runs AFTER customUnInstall, inside Section "Uninstall".
!macro customUnInstallSection
  Section "-un.AgentDockLegacyCleanup"
    ; Derive homedir from $DESKTOP (NSIS built-in, reliable in Section context)
    StrCpy $0 "$DESKTOP"
    StrCpy $0 $0 -8
    StrCpy $0 "$0.agentdock"
    ${If} ${FileExists} "$0"
      RMDir /r "$0"
    ${EndIf}
    ; Also remove Roaming and Local paths as defense-in-depth
    StrCpy $1 "$APPDATA\${APP_FILENAME}"
    ${If} ${FileExists} "$1"
      RMDir /r "$1"
    ${EndIf}
    StrCpy $2 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${If} ${FileExists} "$2"
      RMDir /r "$2"
    ${EndIf}
  SectionEnd
!macroend
