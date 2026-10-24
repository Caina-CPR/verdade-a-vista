<#
.SYNOPSIS
  Varre os debates de data/debates.json e atualiza o histórico. É o que o GitHub Actions
  roda a cada 10 minutos.

.EXAMPLE
  .\scripts\varrer.ps1 -Publico                  # atualiza data/ (versão pública, vai para o GitHub)
  .\scripts\varrer.ps1 -DataDir data-local       # versão completa, só no seu computador
  .\scripts\varrer.ps1 -Url "https://g1.globo.com/fato-ou-fake/..." -Publico
#>
[CmdletBinding()]
param(
    [string]$DataDir,
    [string[]]$Url,
    [switch]$Publico
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'lib\FatoOuFake.ps1')
. (Join-Path $root 'lib\Historico.ps1')

if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
if (-not $Url) { $Url = @(Read-JsonFile (Join-Path $root 'data\debates.json') | ForEach-Object { $_.url }) }

$falhas = 0
foreach ($u in $Url) {
    try {
        $r = Invoke-Varredura -Url $u -DataDir $DataDir -Publico:$Publico
        $acao = if ($r.Salvo) { 'nova varredura salva' } else { 'sem mudanças' }
        Write-Host ('{0}: {1} falas, {2} vereditos - {3}' -f $r.Scan.debate, $r.Scan.totais.falas, $r.Scan.totais.vereditos, $acao)
    }
    catch {
        $falhas++
        Write-Warning "Falhou ($u): $($_.Exception.Message)"
    }
}
# Código de saída 1 deixa a execução vermelha no GitHub; o status.json com o erro é salvo mesmo assim.
if ($falhas) { exit 1 }
