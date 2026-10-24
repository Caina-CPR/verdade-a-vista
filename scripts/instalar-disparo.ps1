<#
.SYNOPSIS
  Cria (ou remove) a tarefa do Windows que dispara a varredura a cada 10 minutos.

.DESCRIPTION
  A tarefa roda scripts\disparar.ps1 escondido (sem abrir janela), enquanto você estiver
  logado no Windows; com o computador desligado ou em suspensão, ela não roda. Não precisa
  ser administrador.

.EXAMPLE
  .\scripts\instalar-disparo.ps1              # instala (ou atualiza) a tarefa
  .\scripts\instalar-disparo.ps1 -Minutos 15  # outro intervalo
  .\scripts\instalar-disparo.ps1 -Remover     # remove a tarefa
#>
[CmdletBinding()]
param(
    [int]$Minutos = 10,
    [switch]$Remover
)

$ErrorActionPreference = 'Stop'
$nome = 'Verdade a Vista - disparo da varredura'

if ($Remover) {
    Unregister-ScheduledTask -TaskName $nome -Confirm:$false
    Write-Host "Tarefa removida: $nome"
    exit 0
}

$script = Join-Path $PSScriptRoot 'disparar.ps1'
# conhost --headless roda o PowerShell sem piscar janela na tela.
$acao = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutos)
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$quem = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config -Principal $quem `
    -Description "Dispara a varredura do Verdade à Vista no GitHub Actions a cada $Minutos minutos." -Force | Out-Null

Write-Host "Tarefa instalada: $nome (a cada $Minutos minutos)"
Write-Host "Log: $(Join-Path $env:LOCALAPPDATA 'VerdadeAVista\disparo.log')"
