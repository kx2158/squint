@echo off
rem Puts Windows' proxy setting back to "off". Run this if the internet stops working after Squint closed unexpectedly
rem while "Send the whole PC through Tor" was on.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f
powershell -NoProfile -Command "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);' -Name W -Namespace N; [void][N.W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][N.W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)"
echo Done. Windows no longer uses a proxy.
pause
