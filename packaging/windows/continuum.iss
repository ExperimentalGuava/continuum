; Continuum — Windows installer (Inno Setup 6)
;
; Produces a single Continuum-Setup.exe that installs the app, a bundled Node
; runtime, and the prebuilt capture engine — so the user never touches Node, Rust,
; or Python. Build via packaging/windows/README.md or the windows-installer workflow.
;
; SrcDir  = staged payload (bin, daemon, node\node.exe, continuum.ico, …)
; OutDir  = where Continuum-Setup.exe is written
; AppVer  = version string (defaults to the package version)

#ifndef SrcDir
  #define SrcDir "dist\continuum"
#endif
#ifndef OutDir
  #define OutDir "dist"
#endif
#ifndef AppVer
  #define AppVer "0.6.0"
#endif
#define AppName "Continuum"
#define NodeExe "{app}\node\node.exe"
#define Entry "{app}\bin\continuum.mjs"

[Setup]
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Continuum
DefaultDirName={autopf}\Continuum
DefaultGroupName=Continuum
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\continuum.ico
SetupIconFile=continuum.ico
OutputBaseFilename=Continuum-Setup
OutputDir={#OutDir}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Continuum"; Filename: "{#NodeExe}"; Parameters: """{#Entry}"" app"; WorkingDir: "{app}"; IconFilename: "{app}\continuum.ico"
Name: "{userdesktop}\Continuum"; Filename: "{#NodeExe}"; Parameters: """{#Entry}"" app"; WorkingDir: "{app}"; IconFilename: "{app}\continuum.ico"; Tasks: desktopicon
Name: "{group}\Uninstall Continuum"; Filename: "{uninstallexe}"

[Run]
; Configure Continuum to whatever AI is already installed (auto-detect, non-interactive).
Filename: "{#NodeExe}"; Parameters: """{#Entry}"" setup --yes"; WorkingDir: "{app}"; Flags: runhidden; StatusMsg: "Detecting your AI and configuring Continuum…"
; Offer to launch on the final page.
Filename: "{#NodeExe}"; Parameters: """{#Entry}"" app"; WorkingDir: "{app}"; Description: "Launch Continuum now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; The user's captured data lives in %USERPROFILE%\.continuum and is intentionally
; left in place on uninstall. Remove it by hand if you want a clean slate.
Type: dirifempty; Name: "{app}"
