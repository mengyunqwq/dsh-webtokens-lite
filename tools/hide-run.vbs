' tools/hide-run.vbs — 用隐藏窗口运行一条命令（不弹控制台）
'
' 用法：
'   wscript.exe hide-run.vbs "cmd.exe /c ""node start.mjs 1>> out.log 2>> err.log"""
'
' 为什么需要它：
'   - 直接 Start-Process 一个控制台程序会留下一个黑窗口（-WindowStyle Minimized 只是最小化）；
'   - WScript.Shell.Run 的窗口样式 0(SW_HIDE) 会给子进程一个属于自己的「隐藏控制台」：
'     既看不见窗口，也不挂在调用者的终端上（关掉终端服务也不受影响）。
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then WScript.Quit 1
sh.Run WScript.Arguments(0), 0, False
