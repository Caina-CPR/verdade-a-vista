<#
.SYNOPSIS
  Dispara a varredura no GitHub Actions (workflow varredura.yml) usando o GitHub CLI.

.DESCRIPTION
  É o que a tarefa agendada do Windows roda a cada 10 minutos (ver instalar-disparo.ps1).
  Se o próprio agendamento do GitHub, ou outro disparo, rodou há poucos minutos, pula a vez
  para não duplicar a varredura. Usa o login já feito com "gh auth login".

  Log: %LOCALAPPDATA%\VerdadeAVista\disparo.log (últimas 500 linhas).
#>
[CmdletBinding()]
param(
    [string]$Repo = 'Caina-CPR/verdade-a-vista',
    [int]$MinutosMinimos = 8
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'VerdadeAVista'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'disparo.log'

function Write-Log([string]$msg) {
    Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" -Encoding UTF8
}

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }

try {
    $ultima = & $gh run list --repo $Repo --workflow varredura.yml --limit 1 --json createdAt,event,status | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "gh run list falhou (código $LASTEXITCODE). O login do GitHub CLI ainda vale? Rode: gh auth status" }
    if ($ultima) {
        $idade = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($ultima[0].createdAt)).TotalMinutes
        if ($idade -lt $MinutosMinimos) {
            Write-Log ("pulado: última execução ({0}, {1}) foi há {2:N0} min" -f $ultima[0].event, $ultima[0].status, $idade)
            exit 0
        }
    }
    & $gh workflow run varredura.yml --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw "gh workflow run falhou (código $LASTEXITCODE)" }
    Write-Log 'disparado'
}
catch {
    Write-Log "ERRO: $($_.Exception.Message)"
    exit 1
}
finally {
    # Mantém o log curto.
    $linhas = @(Get-Content -Path $log -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($linhas.Count -gt 500) { Set-Content -Path $log -Value $linhas[-500..-1] -Encoding UTF8 }
}
