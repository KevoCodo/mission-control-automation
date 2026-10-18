# Build only. This script never runs either executable.
param([switch]$EnableRuntimeExperiment)
$ErrorActionPreference = 'Stop'
$native = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $native '..\..\..')).Path
$expected = Join-Path $root 'tools\mission-control\native'
if ($native -ne $expected) { throw 'Unexpected native source location' }
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC x64 environment is unavailable' }
$output = Join-Path $native 'build'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$fixture = Join-Path $native 'disposable_fixture.cpp'
$harness = Join-Path $native 'disposable_job_harness.cpp'
$fixtureExe = Join-Path $output 'disposable_fixture.exe'
$harnessExe = Join-Path $output 'disposable_job_harness.exe'
$experimentDefine = if ($EnableRuntimeExperiment) { ' /DS2B2B2_RUNTIME_EXPERIMENT_ENABLED' } else { '' }
$command = 'call "' + $vcvars + '" >nul && cl /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE /Fe:"' + $fixtureExe + '" "' + $fixture + '" /link /SUBSYSTEM:CONSOLE && cl /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE' + $experimentDefine + ' /Fe:"' + $harnessExe + '" "' + $harness + '" /link /SUBSYSTEM:CONSOLE'
Push-Location $output
try {
  & cmd.exe /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw "Native build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
Get-Item -LiteralPath $fixtureExe, $harnessExe | Select-Object FullName, Length
