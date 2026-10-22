; Inno Setup script. Build with scripts\build-package.ps1 (it publishes first, then runs ISCC),
; or by hand:  ISCC /DAppVersion=0.1.0 installer\HyperFetchPro.iss   (needs dist\HyperFetchPro to exist)
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{6F1C2B8E-5D0A-4C7B-9E43-1A2D7C9B5F10}
AppName=HyperFetch Pro
AppVersion={#AppVersion}
AppPublisher=HyperFetch Pro
DefaultDirName={autopf}\HyperFetch Pro
DefaultGroupName=HyperFetch Pro
; Installs for the current user by default (no administrator needed); the user may choose all users.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=HyperFetchPro-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=HyperFetch Pro
UninstallDisplayIcon={app}\DownloadManager.exe
CloseApplications=yes
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked
Name: "browser"; Description: "Set up browser integration for Chrome, Edge and Brave (current user)"

[Files]
Source: "..\dist\HyperFetchPro\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\HyperFetch Pro"; Filename: "{app}\DownloadManager.exe"
Name: "{autodesktop}\HyperFetch Pro"; Filename: "{app}\DownloadManager.exe"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\integration\install-native-host.ps1"""; \
  Flags: runhidden; Tasks: browser; StatusMsg: "Registering browser integration..."
Filename: "{app}\DownloadManager.exe"; Description: "Start HyperFetch Pro"; Flags: nowait postinstall skipifsilent
Filename: "{app}\integration\extension"; Description: "Open the browser extension folder (load it as an unpacked extension)"; \
  Flags: shellexec postinstall skipifsilent unchecked

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\integration\install-native-host.ps1"" -Uninstall"; \
  Flags: runhidden; RunOnceId: "UnregisterBrowserHost"

; Downloads, the download list and settings live in %APPDATA%\DownloadManager and are kept on uninstall.
