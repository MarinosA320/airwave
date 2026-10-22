; Airwave Pilot setup (Inno Setup 6). Built by .github/workflows/pilot-installer.yml from installer\stage:
;   stage\node\node.exe                     Node.js, so nothing else needs installing
;   stage\app\pilot-client, node_modules    Airwave Pilot
;   stage\app\sim-addons\msfs\...           MSFS toolbar panel package
;   stage\app\sim-addons\xplane\Airwave     X-Plane plugin (traffic and ATC window)
; Installs for the current user only, so no administrator rights are needed.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{A8171557-309F-43C3-9909-E429B71F3E40}
AppName=Airwave Pilot
AppVersion={#AppVersion}
AppVerName=Airwave Pilot {#AppVersion}
AppPublisher=Airwave
AppPublisherURL=https://github.com/MarinosA320/airwave
AppSupportURL=https://github.com/MarinosA320/airwave/issues
DefaultDirName={localappdata}\Programs\Airwave Pilot
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=AirwavePilotSetup
SetupIconFile=airwave.ico
UninstallDisplayIcon={app}\airwave.ico
UninstallDisplayName=Airwave Pilot
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "simpanels"; Description: "Install the in-sim panels: MSFS 2020/2024 toolbar panel and the X-Plane 12 plugin"
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Airwave Pilot"; Filename: "{app}\Airwave Pilot.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\airwave.ico"; Flags: runminimized
Name: "{autodesktop}\Airwave Pilot"; Filename: "{app}\Airwave Pilot.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\airwave.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\pilot-client\install-addons.js"""; StatusMsg: "Installing the panels into MSFS and X-Plane..."; Flags: runhidden; Tasks: simpanels
Filename: "{app}\Airwave Pilot.cmd"; WorkingDir: "{app}"; Description: "Start Airwave Pilot"; Flags: postinstall nowait skipifsilent shellexec runminimized

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\pilot-client\install-addons.js"" --uninstall"; Flags: runhidden; RunOnceId: "RemoveSimPanels"
