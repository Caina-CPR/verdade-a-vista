# Varredura com histórico em arquivos JSON. Usado pelo server.ps1 (local) e pelo
# scripts/varrer.ps1 (GitHub Actions, a cada 10 minutos). Depende de lib/FatoOuFake.ps1.
#
# Estrutura de <DataDir>:
#   historico.json      resumo de cada varredura salva (ordem cronológica)
#   status.json         última verificação de cada página: quando, se deu certo, erro
#   scans/<id>.json     varredura completa
#   md/<id>.md          mesma varredura em Markdown
#
# Uma varredura só vira arquivo novo quando algo mudou em relação à última salva da mesma
# página. Se nada mudou, só o "verificadoEm" da última entrada do histórico é atualizado.

function Read-JsonFile([string]$path) { ConvertFrom-Json ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)) }
function Write-JsonFile([string]$path, $obj) { [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $obj -Depth 12), $Utf8NoBom) }

function Get-Historico([string]$dataDir) {
    $list = New-Object System.Collections.ArrayList
    $file = Join-Path $dataDir 'historico.json'
    if (Test-Path $file) { foreach ($h in (Read-JsonFile $file)) { [void]$list.Add($h) } }
    , $list
}

# Texto completo: alegações de uma mesma fala costumam começar igual ("A declaração de X sobre...").
function Get-ClaimKey($c) { '{0}|{1}' -f $c.candidato, ($c.alegacao -replace '\W+', ' ').Trim().ToLowerInvariant() }

# O que mudou em relação à varredura anterior da mesma página.
function Compare-Scans($old, $new) {
    $oldMap = @{}; foreach ($c in $old.alegacoes) { $oldMap[(Get-ClaimKey $c)] = $c }
    $newMap = @{}; foreach ($c in $new.alegacoes) { $newMap[(Get-ClaimKey $c)] = $c }
    $pick = { param($c) [ordered]@{ id = $c.id; candidato = $c.candidato; veredito = $c.veredito; alegacao = $c.alegacao } }
    [ordered]@{
        anterior  = $old.id
        novas     = @($new.alegacoes | Where-Object { -not $oldMap.ContainsKey((Get-ClaimKey $_)) } | ForEach-Object { & $pick $_ })
        removidas = @($old.alegacoes | Where-Object { -not $newMap.ContainsKey((Get-ClaimKey $_)) } | ForEach-Object { & $pick $_ })
        alteradas = @($new.alegacoes | Where-Object { $o = $oldMap[(Get-ClaimKey $_)]; $o -and $o.veredito -ne $_.veredito } | ForEach-Object {
            $r = & $pick $_; $r.vereditoAnterior = $oldMap[(Get-ClaimKey $_)].veredito; $r })
    }
}

function Test-HasChanges($m) { (@($m.novas).Count + @($m.removidas).Count + @($m.alteradas).Count) -gt 0 }

function Update-Status([string]$dataDir, [string]$url, $info) {
    $file = Join-Path $dataDir 'status.json'
    $status = [ordered]@{}
    if (Test-Path $file) { foreach ($p in (Read-JsonFile $file).PSObject.Properties) { $status[$p.Name] = $p.Value } }
    $status[$url] = $info
    Write-JsonFile $file $status
}

function Get-Sha256([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    (($sha.ComputeHash($Utf8NoBom.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Varre uma página, compara com a última varredura salva e grava o que for preciso.
# Devolve Salvo (houve mudança e um arquivo novo foi gravado), Scan (o novo, ou o último
# salvo quando nada mudou), Mudancas e Historico.
function Invoke-Varredura {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$DataDir,
        [switch]$Publico
    )
    if ($Url -notmatch '^https://g1\.globo\.com/') { throw 'Use um endereço do g1 (https://g1.globo.com/...).' }
    $scansDir = Join-Path $DataDir 'scans'
    $mdDir = Join-Path $DataDir 'md'
    New-Item -ItemType Directory -Force -Path $scansDir, $mdDir | Out-Null
    $agora = Get-Agora

    try {
        $html = Get-Html $Url
        $doc = Convert-FatoOuFake $html $Url
        if (-not $doc.Checagens) { throw 'Nenhuma checagem encontrada. A página pode não ser do Fato ou Fake ou o layout do g1 mudou.' }
    }
    catch {
        $msg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
        Update-Status $DataDir $Url ([ordered]@{ verificadoEm = $agora; ok = $false; erro = $msg })
        throw $msg
    }

    $fonte = [ordered]@{ url = $Url; baixadoEm = $agora; bytes = $Utf8NoBom.GetByteCount($html); sha256 = Get-Sha256 $html }
    $claims = Add-ClaimIds $doc
    # Data/hora + debate, para duas páginas varridas no mesmo segundo não se sobrescreverem.
    $id = '{0}-{1}' -f (Get-Agora 'yyyyMMdd-HHmmss'), (ConvertTo-Slug (Get-DebateName $doc.Titulo))
    $scan = ConvertTo-Scan $doc $claims $id $fonte -Publico:$Publico

    $historico = Get-Historico $DataDir
    $prev = $historico | Where-Object { $_.url -eq $Url } | Select-Object -Last 1
    $prevScan = $null
    if ($prev -and (Test-Path (Join-Path $scansDir "$($prev.id).json"))) {
        $prevScan = Read-JsonFile (Join-Path $scansDir "$($prev.id).json")
        $scan.mudancas = Compare-Scans $prevScan $scan
    }
    $mudou = (-not $prevScan) -or (Test-HasChanges $scan.mudancas) -or ([bool]$prevScan.emAndamento -ne [bool]$scan.emAndamento)

    if ($mudou) {
        Write-JsonFile (Join-Path $scansDir "$id.json") $scan
        Write-Markdown $doc $claims (Join-Path $mdDir "$id.md") $fonte -Publico:$Publico
        [void]$historico.Add([ordered]@{
            id           = $scan.id
            extraidoEm   = $scan.extraidoEm
            verificadoEm = $agora
            url          = $scan.url
            debate       = $scan.debate
            titulo       = $scan.titulo
            publicadoEm  = $scan.publicadoEm
            emAndamento  = $scan.emAndamento
            totais       = $scan.totais
            candidatos   = @($scan.candidatos | ForEach-Object { [ordered]@{ nome = $_.nome; partido = $_.partido; totalVereditos = $_.totalVereditos; vereditos = $_.vereditos } })
            novas        = if ($scan.mudancas) { @($scan.mudancas.novas).Count + @($scan.mudancas.alteradas).Count + @($scan.mudancas.removidas).Count } else { $null }
        })
    }
    else {
        $prev | Add-Member -NotePropertyName verificadoEm -NotePropertyValue $agora -Force
    }
    Write-JsonFile (Join-Path $DataDir 'historico.json') @($historico)
    Update-Status $DataDir $Url ([ordered]@{ verificadoEm = $agora; ok = $true; erro = $null; salvouNova = $mudou })

    [pscustomobject]@{
        Salvo     = $mudou
        Scan      = if ($mudou) { $scan } else { $prevScan }
        Mudancas  = $scan.mudancas
        Historico = $historico
    }
}
