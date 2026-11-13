# Read-only Docker Desktop / WSL2 candidate host inspection for Phase 2 Gate A.
# Does not create containers, images, networks, files, volumes, or change Docker settings.
# Output is informational and DOES NOT authorize execution.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Inspect-Command {
    param([string]$Label, [string]$Executable, [string[]]$Arguments)
    Write-Output ("### " + $Label)
    try {
        $result = & $Executable @Arguments 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Output ("UNVERIFIED: command exited " + $exit)
            return
        }
        foreach ($entry in @($result)) { Write-Output ($entry.ToString()) }
    } catch {
        Write-Output ("UNVERIFIED: command unavailable or failed")
    }
}

Write-Output "MISSION CONTROL PHASE 2: READ-ONLY HOST CANDIDATE"
Write-Output "GATE A: NO-GO. This is NOT a security review or runtime authorization."
Inspect-Command -Label "Docker CLI/client-server versions" -Executable "docker" -Arguments @("version", "--format", "Client={{.Client.Version}} Server={{.Server.Version}}")
Inspect-Command -Label "Docker context name only" -Executable "docker" -Arguments @("context", "show")
Inspect-Command -Label "Docker engine operating system" -Executable "docker" -Arguments @("info", "--format", "{{.OperatingSystem}}")
Inspect-Command -Label "Docker engine OS type" -Executable "docker" -Arguments @("info", "--format", "{{.OSType}}")
Inspect-Command -Label "Docker cgroup version" -Executable "docker" -Arguments @("info", "--format", "{{.CgroupVersion}}")
Inspect-Command -Label "Docker security options (claims, not verified isolation)" -Executable "docker" -Arguments @("info", "--format", "{{json .SecurityOptions}}")
Inspect-Command -Label "WSL status" -Executable "wsl.exe" -Arguments @("--status")
Write-Output "No container was started. No isolation has been proven."
Write-Output "Next gate: independent host/root, privilege, filesystem, network and process-observer review."
