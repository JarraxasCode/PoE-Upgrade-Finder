# Builds luahost.exe with the C# compiler that ships with Windows (.NET Framework 4.x). No download.
# Usage: powershell -File engine\host\build.ps1 [-OutDir <folder>]
param([string]$OutDir = "$PSScriptRoot\bin")
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    throw "csc.exe not found at $csc"
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
& $csc /nologo /optimize+ /platform:x64 /target:exe "/out:$OutDir\luahost.exe" "$PSScriptRoot\LuaHost.cs"
if ($LASTEXITCODE -ne 0) {
    throw "csc failed ($LASTEXITCODE)"
}
