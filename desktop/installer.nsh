; Existing-install upgrades retire detached helpers after the desktop closes.
; Ordinary application shutdown still retains its remote-availability listener.
!macro customInit
  IfFileExists "$INSTDIR\BLACKICE.exe" 0 blackiceUpgradeReady
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\blackice-upgrade-preflight.ps1 "${BUILD_RESOURCES_DIR}\upgrade-preflight.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\blackice-upgrade-preflight.ps1" -InstallRoot "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "BLACKICE could not close for this update. Close it normally and retry." /SD IDOK
    Abort
  ${EndIf}
  Pop $1
  Pop $0
  blackiceUpgradeReady:
!macroend
