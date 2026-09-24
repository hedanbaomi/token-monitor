' launch-background.vbs
' ---------------------------------------------------------------------------
' Silently launches Token Monitor in the background — no console window pops up.
' Double-click this file (or a shortcut to it) to start the app hidden.
'
' Why VBScript? A plain .bat would flash a cmd.exe window every launch and
' keep it open while the app runs. wscript.exe runs this script with NO window,
' and WshShell.Run with 0 as the window-state detaches electron immediately —
' so you can close Explorer / log off the launcher and the app keeps running
' in the tray (Token Monitor already minimizes to the system tray on close).
'
' To start on login: create a shortcut to THIS .vbs file and place it in the
' Startup folder (Win+R  ->  shell:startup).
' ---------------------------------------------------------------------------

Set shell = CreateObject("WScript.Shell")

' Resolve the repo root from this script's own location, so it works no matter
' where you launch it from (double-click, shortcut, Task Scheduler, Startup).
repoRoot = shell.CurrentDirectory
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = WScript.ScriptFullName
scriptDir  = fso.GetParentFolderName(scriptPath)
If fso.FileExists(fso.BuildPath(scriptDir, "package.json")) Then
  repoRoot = scriptDir
End If

' Prefer the local electron from node_modules (same one `npm run dev` uses).
electronExe = fso.BuildPath(repoRoot, "node_modules\.bin\electron.cmd")
If Not fso.FileExists(electronExe) Then
  ' Fallback: npm/node on PATH, running the Electron main entry directly.
  electronExe = "npm.cmd"
End If

' Run detached (0 = hidden window), don't wait for it to finish (False).
' Working directory = repoRoot so electron finds package.json + assets.
shell.CurrentDirectory = repoRoot
If InStrRev(electronExe, "electron.cmd") > 0 Then
  shell.Run """" & electronExe & """ .", 0, False
Else
  shell.Run "cmd /c npm run dev", 0, False
End If
