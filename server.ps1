<#
.SYNOPSIS
  Servidor local do Verdade à Vista. Abre http://localhost:8765/ no navegador.

.DESCRIPTION
  Usa a mesma página do site publicado, com dois extras: os botões de varredura e a versão
  completa dos dados (com as explicações do g1), gravada em data-local\ e nunca enviada ao GitHub.

  Rotas:
    GET  /                    página (pasta web\)
    GET  /data/...            arquivos de dados (data-local\; debates.json vem de data\)
    GET  /api/config          debates cadastrados; também indica que é o modo local
    POST /api/varrer          { "url": "..." } -> varre, salva se mudou, devolve o resultado

.EXAMPLE
  .\server.ps1
  .\server.ps1 -Port 9000 -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$NoBrowser,
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\FatoOuFake.ps1')
. (Join-Path $PSScriptRoot 'lib\Historico.ps1')

$WebDir = Join-Path $PSScriptRoot 'web'
$DebatesFile = Join-Path $PSScriptRoot 'data\debates.json'
if (-not $DataDir) { $DataDir = Join-Path $PSScriptRoot 'data-local' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$MimeTypes = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.svg' = 'image/svg+xml'; '.jpg' = 'image/jpeg'; '.png' = 'image/png'; '.webp' = 'image/webp'; '.json' = 'application/json; charset=utf-8'; '.md' = 'text/markdown; charset=utf-8'
}

function Send-Bytes($ctx, [int]$status, [string]$type, [byte[]]$bytes) {
    $r = $ctx.Response
    $r.StatusCode = $status
    $r.ContentType = $type
    $r.Headers['Cache-Control'] = 'no-store'
    $r.ContentLength64 = $bytes.Length
    $r.OutputStream.Write($bytes, 0, $bytes.Length)
    $r.Close()
}

function Send-Json($ctx, $obj, [int]$status = 200) {
    Send-Bytes $ctx $status 'application/json; charset=utf-8' $Utf8NoBom.GetBytes((ConvertTo-Json -InputObject $obj -Depth 12 -Compress))
}

function Send-File($ctx, [string]$file) {
    if (-not (Test-Path $file -PathType Leaf)) { return Send-Json $ctx @{ erro = 'Não encontrado' } 404 }
    $type = $MimeTypes[[IO.Path]::GetExtension($file)]
    if (-not $type) { $type = 'application/octet-stream' }
    Send-Bytes $ctx 200 $type ([IO.File]::ReadAllBytes($file))
}

function Invoke-Request($ctx) {
    $req = $ctx.Request
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod

    if ($method -eq 'GET' -and $path -eq '/') { return Send-File $ctx (Join-Path $WebDir 'index.html') }
    if ($method -eq 'GET' -and $path -match '^/((?:img/)?[\w.-]+\.(html|js|css|svg|jpg|png|webp))$') { return Send-File $ctx (Join-Path $WebDir ($Matches[1] -replace '/', '\')) }
    if ($method -eq 'GET' -and $path -match '^/data/((?:[\w-]+/)?[\w.-]+\.(json|md))$') {
        $rel = $Matches[1]
        # Cadastros vêm sempre de data\ (versionados); o resto, da pasta de dados em uso.
        if ($rel -in 'debates.json', 'candidatos.json') { return Send-File $ctx (Join-Path $PSScriptRoot "data\$rel") }
        return Send-File $ctx (Join-Path $DataDir ($rel -replace '/', '\'))
    }
    if ($method -eq 'GET' -and $path -eq '/api/config') {
        return Send-Json $ctx ([ordered]@{ modo = 'local'; debates = @(Read-JsonFile $DebatesFile) })
    }
    if ($method -eq 'POST' -and $path -eq '/api/varrer') {
        $body = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
        $url = if ($body) { (ConvertFrom-Json $body).url } else { $null }
        if (-not $url) { throw 'Informe a URL da página do Fato ou Fake.' }
        Write-Host "[$(Get-Date -Format HH:mm:ss)] Varrendo $url"
        $r = Invoke-Varredura -Url $url -DataDir $DataDir
        Write-Host "[$(Get-Date -Format HH:mm:ss)] OK: $($r.Scan.totais.vereditos) vereditos, $(if ($r.Salvo) { 'nova varredura salva' } else { 'sem mudanças' })"
        return Send-Json $ctx ([ordered]@{ salvo = $r.Salvo; scan = $r.Scan; mudancas = $r.Mudancas; historico = @($r.Historico) })
    }
    Send-Json $ctx @{ erro = 'Rota não encontrada' } 404
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch { Write-Host "Não consegui abrir a porta $Port (já está em uso?). Tente: .\server.ps1 -Port 9000" -ForegroundColor Red; exit 1 }

$address = "http://localhost:$Port/"
Write-Host ''
Write-Host "  Verdade a Vista rodando em $address" -ForegroundColor Green
Write-Host "  Dados completos em $DataDir  -  Ctrl+C para encerrar"
Write-Host ''
if (-not $NoBrowser) { Start-Process $address }

try {
    while ($listener.IsListening) {
        $task = $listener.GetContextAsync()
        # Espera em fatias curtas para o Ctrl+C conseguir interromper.
        while (-not $task.AsyncWaitHandle.WaitOne(300)) { }
        $ctx = $task.GetAwaiter().GetResult()
        try { Invoke-Request $ctx }
        catch {
            $msg = $_.Exception.Message
            if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
            Write-Warning $msg
            try { Send-Json $ctx @{ erro = $msg } 500 } catch { }
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}
