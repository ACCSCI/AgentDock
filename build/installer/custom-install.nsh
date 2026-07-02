; AgentDock custom NSIS install script.
;
; Hooks into electron-builder's NSIS template via the `nsis.include` field
; in electron-builder.yml. The macros we define here are CALLED from
; electron-builder's auto-generated installer; defining them with the
; !macro / !macroend syntax makes them inject at the right phase.
;
; Why we need this:
; When AgentDock is upgraded in place, electron-builder's default NSIS
; flow only updates the .exe — it leaves existing .lnk shortcuts in
; place. The .lnk's icon reference is cached in the Windows shell icon
; cache, so even though the new .exe has a different .ico, the desktop
; / Start Menu shortcuts keep showing the OLD icon.
;
; Fix: at install time (customInstall phase), if a previous .lnk exists
; for this app, delete it before electron-builder recreates it. This
; forces explorer to read the new icon from the freshly-installed .exe
; when the .lnk is recreated.

!macro customInstall
  ; Detect upgrade vs fresh install by checking if the EXE already
  ; exists. On upgrade the old .exe is still present (we are about to
  ; overwrite it). On fresh install, the EXE doesn't exist yet.
  ; We use $INSTDIR which electron-builder has already set.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}.exe"
    ; Upgrade path: nuke existing shortcuts so the freshly-created
    ; ones below pick up the new icon.
    ; Delete "$DESKTOP\<shortcutName>.lnk" and the Start Menu copy.
    SetShellVarContext current
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${EndIf}
    ${If} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
