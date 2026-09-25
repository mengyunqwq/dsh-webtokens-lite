' tools/autostart.vbs - start the local web bridge with NO visible window.
'
' Why this file exists (instead of passing a command line to hide-run.vbs):
'   A shortcut would have to hand wscript the whole "cmd /c ..." line as an argument, which
'   means nested quoting (cmd needs its own outer "" pair, wscript needs escaping). Observed:
'   the quotes got collapsed and the shortcut silently started nothing.
'   This script derives everything from its own location, so the shortcut needs exactly one
'   argument-free target:  wscript.exe "<install>\tools\autostart.vbs"
'
' Quoting note (this bit is easy to get wrong):
'   cmd.exe /c strips the first and last quote of its command string when that string starts
'   with a quote and carries further quoted arguments, which silently truncates the command.
'   The fix is the extra outer pair:   cmd.exe /c ""<start.cmd>" 1>> "<out>" 2>> "<err>""
'   Built with Chr(34) below so the number of quotes stays readable.
'
' Keep this file ASCII-only and CRLF-terminated (VBScript reads it with the ANSI code page).

Option Explicit
Dim fso, sh, q, here, root, startCmd, outLog, errLog, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = Chr(34)

' C:\...\tools\autostart.vbs -> C:\...\tools -> C:\...
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
startCmd = fso.BuildPath(root, "start.cmd")
outLog = fso.BuildPath(root, "bridge.out.log")
errLog = fso.BuildPath(root, "bridge.err.log")

If Not fso.FileExists(startCmd) Then WScript.Quit 1

sh.CurrentDirectory = root
' Tell start.cmd not to "pause" on exit: in a hidden window nobody can press a key, and the
' stuck process would keep bridge.out.log open so the next autostart could not log anything.
sh.Environment("PROCESS")("DSH_WEB_BRIDGE_NO_PAUSE") = "1"
cmd = "cmd.exe /c " & q & q & startCmd & q & " 1>> " & q & outLog & q & " 2>> " & q & errLog & q & q

' 0 = SW_HIDE (no window, no taskbar button), False = do not wait for it
sh.Run cmd, 0, False
