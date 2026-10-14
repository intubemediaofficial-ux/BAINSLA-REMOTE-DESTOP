!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var BainslaRemoteServiceCheckbox
Var BainslaRemoteServicePage
Var BainslaRemoteInstallService
Var BainslaRemoteServiceWasInstalled

!macro ExecChecked step command
  nsExec::ExecToLog '${command}'
  Pop $1
  ${If} $1 != 0
    MessageBox MB_ICONSTOP|MB_OK "${step} failed. Windows returned exit code $1."
    Abort
  ${EndIf}
!macroend

; FileWriteUTF16LE/FileWriteWord write nothing in installers built by the Linux makensis
; bundled with electron-builder; kernel32 WriteFile works with every compiler.
!macro WriteTaskXml text
  StrCpy $2 "${text}"
  StrLen $1 $2
  IntOp $1 $1 * 2
  System::Call 'kernel32::WriteFile(p r0, w r2, i r1, *i .r1, p 0) i .r2'
  StrCmp $2 0 installServiceXmlWriteError
!macroend

!macro customInit
  Push $0
  Push $1
  Push $2
  Push $R0
  Push $R1

  StrCpy $BainslaRemoteServiceWasInstalled 0
  ReadEnvStr $R0 "ProgramData"
  ${If} $R0 == ""
    StrCpy $R0 "$WINDIR\..\ProgramData"
  ${EndIf}
  IfFileExists "$R0\Bainsla Remote\service-installed" 0 +2
  StrCpy $BainslaRemoteServiceWasInstalled 1

  nsExec::ExecToLog '"$SYSDIR\sc.exe" query BainslaRemoteService'
  Pop $0
  ${If} $0 == 0
    StrCpy $BainslaRemoteServiceWasInstalled 1
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop BainslaRemoteService'
    Pop $1
    Sleep 2000
    nsExec::ExecToLog '"$SYSDIR\sc.exe" delete BainslaRemoteService'
    Pop $1
    ${If} $1 != 0
      MessageBox MB_ICONSTOP|MB_OK "Upgrade: remove the existing Bainsla Remote Service failed. Windows returned exit code $1."
      Abort
    ${EndIf}

    StrCpy $R1 0
  kvDeskUpgradeWaitForService:
    nsExec::ExecToLog '"$SYSDIR\sc.exe" query BainslaRemoteService'
    Pop $0
    ${If} $0 != 0
      Goto kvDeskUpgradeServiceRemoved
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 60
      MessageBox MB_ICONSTOP|MB_OK "Upgrade: waiting for the existing Bainsla Remote Service to stop timed out. Windows returned exit code $0."
      Abort
    ${EndIf}
    Sleep 500
    Goto kvDeskUpgradeWaitForService
  kvDeskUpgradeServiceRemoved:
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /query /tn "Bainsla Remote Agent"'
  Pop $0
  ${If} $0 == 0
    StrCpy $BainslaRemoteServiceWasInstalled 1
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /end /tn "Bainsla Remote Agent"'
    Pop $1
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /delete /tn "Bainsla Remote Agent" /f'
    Pop $1
    ${If} $1 != 0
      MessageBox MB_ICONSTOP|MB_OK "Upgrade: delete the Bainsla Remote Agent scheduled task failed. Windows returned exit code $1."
      Abort
    ${EndIf}
  ${EndIf}

  Pop $R1
  Pop $R0
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customPageAfterChangeDir
  Page custom BainslaRemoteServicePageCreate BainslaRemoteServicePageLeave
!macroend

Function BainslaRemoteServicePageCreate
  nsDialogs::Create 1018
  Pop $BainslaRemoteServicePage
  ${If} $BainslaRemoteServicePage == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 14u "Install service for 24x7 unattended access (recommended)"
  Pop $BainslaRemoteServiceCheckbox
  SendMessage $BainslaRemoteServiceCheckbox ${BM_SETCHECK} ${BST_CHECKED} 0
  nsDialogs::Show
FunctionEnd

Function BainslaRemoteServicePageLeave
  ${NSD_GetState} $BainslaRemoteServiceCheckbox $BainslaRemoteInstallService
FunctionEnd

Function InstallBainslaRemoteService
  Push $0
  Push $1
  Push $2
  Push $R0

  ReadEnvStr $R0 "ProgramData"
  ${If} $R0 == ""
    StrCpy $R0 "$WINDIR\..\ProgramData"
  ${EndIf}
  ClearErrors
  CreateDirectory "$R0\Bainsla Remote"
  IfErrors installServiceDirectoryError

  IfFileExists "$R0\Bainsla Remote\config.json" installServiceConfigReady
  FileOpen $0 "$R0\Bainsla Remote\config.json" w
  IfErrors installServiceConfigError
  FileWrite $0 "{}"
  IfErrors installServiceConfigWriteError
  FileClose $0
installServiceConfigReady:

  !insertmacro ExecChecked "Grant ProgramData access" '"$SYSDIR\icacls.exe" "$R0\Bainsla Remote" /grant "*S-1-5-32-545:(OI)(CI)M" /T'

  FileOpen $0 "$PLUGINSDIR\kvdesk-task.xml" w
  IfErrors installServiceXmlError
  FileWriteByte $0 255
  FileWriteByte $0 254
  !insertmacro WriteTaskXml "<?xml version=$\"1.0$\" encoding=$\"UTF-16$\"?>$\r$\n"
  !insertmacro WriteTaskXml "<Task version=$\"1.4$\" xmlns=$\"http://schemas.microsoft.com/windows/2004/02/mit/task$\">$\r$\n"
  !insertmacro WriteTaskXml "  <RegistrationInfo><Description>Bainsla Remote interactive session agent</Description></RegistrationInfo>$\r$\n"
  !insertmacro WriteTaskXml "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>$\r$\n"
  !insertmacro WriteTaskXml "  <Principals><Principal id=$\"UsersPrincipal$\"><GroupId>S-1-5-32-545</GroupId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>$\r$\n"
  !insertmacro WriteTaskXml "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>$\r$\n"
  !insertmacro WriteTaskXml "  <Actions Context=$\"UsersPrincipal$\"><Exec><Command>$INSTDIR\BainslaRemote.exe</Command><Arguments>--host</Arguments></Exec></Actions>$\r$\n"
  !insertmacro WriteTaskXml "</Task>$\r$\n"
  IfErrors installServiceXmlWriteError
  FileClose $0

  !insertmacro ExecChecked "Restrict install folder to administrators" '"$SYSDIR\icacls.exe" "$INSTDIR" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" "*S-1-15-2-1:(OI)(CI)RX" "*S-1-15-2-2:(OI)(CI)RX"'
  !insertmacro ExecChecked "Create Bainsla Remote Agent scheduled task" '"$SYSDIR\schtasks.exe" /create /tn "Bainsla Remote Agent" /xml "$PLUGINSDIR\kvdesk-task.xml" /f'
  !insertmacro ExecChecked "Install Bainsla Remote Service" '"$INSTDIR\resources\BainslaRemoteService.exe" install'
  !insertmacro ExecChecked "Start Bainsla Remote Service" '"$INSTDIR\resources\BainslaRemoteService.exe" start'

  FileOpen $0 "$R0\Bainsla Remote\service-installed" w
  IfErrors installServiceMarkerError
  FileWrite $0 "installed"
  IfErrors installServiceMarkerWriteError
  FileClose $0
  Goto installServiceDone

installServiceDirectoryError:
  MessageBox MB_ICONSTOP|MB_OK "Create ProgramData directory failed (NSIS file error)."
  Abort
installServiceConfigError:
  MessageBox MB_ICONSTOP|MB_OK "Create ProgramData config file failed (NSIS file error)."
  Abort
installServiceConfigWriteError:
  FileClose $0
  MessageBox MB_ICONSTOP|MB_OK "Write ProgramData config file failed (NSIS file error)."
  Abort
installServiceXmlError:
  MessageBox MB_ICONSTOP|MB_OK "Prepare scheduled-task XML failed (NSIS file error)."
  Abort
installServiceXmlWriteError:
  FileClose $0
  MessageBox MB_ICONSTOP|MB_OK "Write scheduled-task XML failed (NSIS file error)."
  Abort
installServiceMarkerError:
  MessageBox MB_ICONSTOP|MB_OK "Create service-installed marker failed (NSIS file error)."
  Abort
installServiceMarkerWriteError:
  FileClose $0
  MessageBox MB_ICONSTOP|MB_OK "Write service-installed marker failed (NSIS file error)."
  Abort
installServiceDone:
  Pop $R0
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro customInstall
  ${If} $BainslaRemoteInstallService == ${BST_CHECKED}
    Call InstallBainslaRemoteService
  ${Else}
    ${If} $BainslaRemoteServiceWasInstalled == 1
      Call InstallBainslaRemoteService
    ${EndIf}
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Function un.UninstallBainslaRemoteService
  Push $0
  Push $1
  Push $2
  Push $R0

  ReadEnvStr $R0 "ProgramData"
  ${If} $R0 == ""
    StrCpy $R0 "$WINDIR\..\ProgramData"
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /query /tn "Bainsla Remote Agent"'
  Pop $0
  ${If} $0 == 0
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /end /tn "Bainsla Remote Agent"'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /delete /tn "Bainsla Remote Agent" /f'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Delete Bainsla Remote Agent scheduled task failed. Windows returned exit code $0."
      Abort
    ${EndIf}
  ${EndIf}

  nsExec::ExecToLog '"$INSTDIR\resources\BainslaRemoteService.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" query BainslaRemoteService'
  Pop $1
  nsExec::ExecToLog '"$INSTDIR\resources\BainslaRemoteService.exe" uninstall'
  Pop $2
  ${If} $2 != 0
    ${If} $1 == 0
      MessageBox MB_ICONSTOP|MB_OK "Uninstall Bainsla Remote Service failed while the service still exists. Windows returned exit code $2."
      Abort
    ${EndIf}
  ${EndIf}

  Delete "$R0\Bainsla Remote\service-installed"
  Pop $R0
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro customRemoveFiles
  Call un.UninstallBainslaRemoteService
  RMDir /r $INSTDIR
!macroend
!endif
