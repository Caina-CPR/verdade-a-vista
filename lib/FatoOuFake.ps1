# Funções de varredura do "Fato ou Fake" (g1). Carregado com dot-source pelo server.ps1.
#
# Fluxo: Get-Html -> Convert-FatoOuFake -> Add-ClaimIds -> ConvertTo-Scan / Write-Markdown
#
# Uma mesma fala pode ter mais de um veredito (ex.: Lula sobre a fome). Cada veredito vira
# uma "alegação" própria (IDs lula-02a, lula-02b) e é a unidade de contagem dos gráficos.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$VerdictLabels = [ordered]@{
    FATO            = 'FATO'
    NAO_E_BEM_ASSIM = 'NÃO É BEM ASSIM'
    FAKE            = 'FAKE'
}
# Aceita "#FATO", "#/FATO", "#NÃOÉBEMASSIM", "#NÃO É BEM ASSIM", etc.
$TagRegex = [regex]'#\W{0,2}(FATO|FAKE|N[ÃA]O\s*[ÉE]\s*BEM\s*ASSIM)'

function Get-Html([string]$u) {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [System.Text.Encoding]::UTF8
    $wc.Headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
    $wc.DownloadString($u)
}

function ConvertTo-PlainText([string]$html) {
    $t = $html -replace '(?i)<li[^>]*>', "`n- " `
               -replace '(?i)<br\s*/?>', "`n" `
               -replace '(?i)</(p|ul|ol|h\d)>', "`n" `
               -replace '<[^>]+>', ''
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $lines = $t -split "`n" | ForEach-Object { ($_ -replace '[\s ]+', ' ').Trim() } | Where-Object { $_ -and $_ -ne '-' }
    ($lines -join "`n").Trim()
}

function Get-Verdict([string]$tag) {
    $n = ($tag -replace '\s', '').ToUpperInvariant()
    switch -Regex ($n) {
        '^FATO$' { 'FATO' }
        '^FAKE$' { 'FAKE' }
        '^N.OEBEMASSIM$|^N.O.BEMASSIM$' { 'NAO_E_BEM_ASSIM' }
        default { $n }
    }
}

# Lê o parágrafo de veredito. Com 1 tag: só o veredito. Com várias: cada tag recebe
# como descrição o trecho de texto que vem antes dela.
function Get-Verdicts([string]$text) {
    $ms = $TagRegex.Matches($text)
    $out = @()
    $prevEnd = 0
    foreach ($m in $ms) {
        $desc = $text.Substring($prevEnd, $m.Index - $prevEnd)
        $desc = ($desc -replace '^[\s.:;,-]+', '' -replace '\s+(é|e)\s*$', '' -replace '[\s:]+$', '').Trim()
        $out += [pscustomobject]@{ Verdict = Get-Verdict $m.Groups[1].Value; Description = $desc }
        $prevEnd = $m.Index + $m.Length
    }
    if ($out.Count -eq 1) { $out[0].Description = $null }
    , $out
}

function Test-Quote([string]$t) { $t -match '^[“”"«]' }

function ConvertTo-Slug([string]$s) {
    $norm = $s.Normalize([Text.NormalizationForm]::FormD)
    $ascii = -join ($norm.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' })
    ($ascii.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
}

function Format-Cell([string]$s, [int]$max = 0) {
    $s = ($s -replace '\s+', ' ').Trim()
    if ($max -gt 0 -and $s.Length -gt $max) { $s = $s.Substring(0, $max).TrimEnd() + '…' }
    $s -replace '\|', '\|'
}

function Format-Yaml([string]$s) { '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"' }

# "FATO OU FAKE: Debate Flávio Bolsonaro x Lula na Band na eleição 2026" -> "Band"
function Get-DebateName([string]$title) {
    $m = [regex]::Match($title, '\b(?:na|no|da|do)\s+(\S+(?:\s+\S+)?)\s+n[ao]s?\s+elei', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value }
    ($title -replace '^FATO OU FAKE:\s*', '').Trim()
}

function Get-VerdictKeys($claims) {
    @($VerdictLabels.Keys) + @($claims | ForEach-Object Veredito | Where-Object { -not $VerdictLabels.Contains($_) } | Select-Object -Unique)
}

function Convert-FatoOuFake([string]$html, [string]$sourceUrl) {
    $title = [System.Net.WebUtility]::HtmlDecode([regex]::Match($html, '<title>([^<]*)</title>').Groups[1].Value) -replace '\s*\|\s*G1\s*$', ''
    $published = [regex]::Match($html, 'itemprop="datePublished"\s+datetime="([^"]+)"').Groups[1].Value
    $modified = [regex]::Match($html, 'itemprop="dateModified"\s+datetime="([^"]+)"').Groups[1].Value

    # Cada bloco do corpo da matéria fica num <div id="chunk-...">; pegamos só os de texto.
    $body = $html -replace '(?is)<(script|style|svg|noscript)\b.*?</\1>', ''
    $blocks = @()
    foreach ($chunk in ($body -split '<div id="chunk-' | Select-Object -Skip 1)) {
        if ($chunk -notmatch 'content-text__container') { continue }
        $text = ConvertTo-PlainText ($chunk -replace '^[^>]*>', '')
        if ($text) { $blocks += [pscustomobject]@{ Text = $text } }
    }

    $intro = @(); $checks = @(); $candidate = $null; $current = $null
    $inProgress = $false
    $ti = (Get-Culture).TextInfo

    for ($i = 0; $i -lt $blocks.Count; $i++) {
        $t = $blocks[$i].Text
        if ($t -match '^Esta checagem est. em andamento') { $inProgress = $true; continue }
        if ($t -match '^Veja tamb.m$|^V.DEOS:|^VEJA outras checagens|^- VEJA outras checagens') { break }
        if ($t -match '^Participaram da checagem') { continue }

        # Cabeçalho de candidato, em caixa alta ou não: "FLÁVIO BOLSONARO (PL)" / "Lula (PT)"
        if ($t -cmatch '^([\p{L}][\p{L} .''-]{1,50}?)\s*\(([A-Z]{2,})\)$') {
            $nome = $Matches[1]
            if ($nome -ceq $nome.ToUpper()) { $nome = $ti.ToTitleCase($nome.ToLower()) }
            $candidate = [pscustomobject]@{ Nome = $nome; Partido = $Matches[2] }
            $current = $null
            continue
        }

        # Fala checada: começa com aspas e o próximo bloco que não é aspas traz o veredito.
        if ($candidate -and (Test-Quote $t)) {
            $j = $i + 1
            while ($j -lt $blocks.Count -and (Test-Quote $blocks[$j].Text) -and -not $TagRegex.IsMatch($blocks[$j].Text)) { $j++ }
            if ($j -lt $blocks.Count -and $TagRegex.IsMatch($blocks[$j].Text)) {
                $quote = ($blocks[$i..($j - 1)] | ForEach-Object Text) -join "`n"
                $current = [pscustomobject]@{
                    Candidato   = $candidate.Nome
                    Partido     = $candidate.Partido
                    Fala        = $quote
                    VerdictText = $blocks[$j].Text
                    Vereditos   = Get-Verdicts $blocks[$j].Text
                    Explicacao  = New-Object System.Collections.Generic.List[string]
                }
                $checks += $current
                $i = $j
                continue
            }
        }

        if ($current) {
            # Subtítulos como "Veja por que a primeira delas é #FATO:" viram negrito.
            if ($TagRegex.IsMatch($t)) { $t = '**' + $TagRegex.Replace($t, { param($m) $VerdictLabels[(Get-Verdict $m.Groups[1].Value)] }) + '**' }
            $current.Explicacao.Add($t)
        }
        elseif (-not $candidate) { $intro += $t }
    }

    [pscustomobject]@{
        Titulo = $title; Url = $sourceUrl; Publicado = $published; Modificado = $modified
        EmAndamento = $inProgress; Intro = $intro; Checagens = $checks
    }
}

# Dá IDs às checagens e devolve a lista de alegações (uma por veredito).
function Add-ClaimIds($doc) {
    $claims = @()
    $seq = @{}
    foreach ($c in $doc.Checagens) {
        $slug = ConvertTo-Slug $c.Candidato
        $seq[$slug] = 1 + [int]$seq[$slug]
        $c | Add-Member -NotePropertyName Id -NotePropertyValue ('{0}-{1:D2}' -f $slug, $seq[$slug]) -Force
        $k = 0
        foreach ($v in $c.Vereditos) {
            $suffix = if ($c.Vereditos.Count -gt 1) { [string][char](97 + $k) } else { '' }
            $claims += [pscustomobject]@{
                Id = $c.Id + $suffix; Candidato = $c.Candidato; Partido = $c.Partido; Veredito = $v.Verdict
                Alegacao = if ($v.Description) { $v.Description } else { $c.Fala -replace '^[“”"]+|[“”"]+$', '' }
            }
            $k++
        }
    }
    , $claims
}

# Objeto pronto para virar JSON (scans/<id>.json). Com -Publico, ficam de fora os textos
# de explicação e de contexto do g1: a versão pública só traz falas, vereditos e o link.
function ConvertTo-Scan($doc, $claims, [string]$id, $fonte, [switch]$Publico) {
    $verdictKeys = Get-VerdictKeys $claims
    $candidates = @(foreach ($cand in ($doc.Checagens | Select-Object Candidato, Partido -Unique)) {
        $mine = @($claims | Where-Object Candidato -eq $cand.Candidato)
        $counts = [ordered]@{}
        foreach ($vk in $verdictKeys) { $counts[$vk] = @($mine | Where-Object Veredito -eq $vk).Count }
        [ordered]@{
            nome           = $cand.Candidato
            partido        = $cand.Partido
            falas          = @($doc.Checagens | Where-Object Candidato -eq $cand.Candidato).Count
            totalVereditos = $mine.Count
            vereditos      = $counts
        }
    })
    $checks = @(foreach ($c in $doc.Checagens) {
        $k = 0
        $check = [ordered]@{
            id               = $c.Id
            candidato        = $c.Candidato
            partido          = $c.Partido
            fala             = $c.Fala
            vereditoOriginal = $c.VerdictText
            vereditos        = @(foreach ($v in $c.Vereditos) {
                [ordered]@{
                    id        = if ($c.Vereditos.Count -gt 1) { $c.Id + [char](97 + $k) } else { $c.Id }
                    veredito  = $v.Verdict
                    descricao = $v.Description
                }
                $k++
            })
        }
        if (-not $Publico) { $check.explicacao = @($c.Explicacao) }
        $check
    })
    $scan = [ordered]@{
        id          = $id
        modo        = if ($Publico) { 'publico' } else { 'completo' }
        extraidoEm  = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
        fonte       = $fonte
        url         = $doc.Url
        debate      = Get-DebateName $doc.Titulo
        titulo      = $doc.Titulo
        publicadoEm = $doc.Publicado
        modificadoEm = $doc.Modificado
        emAndamento = $doc.EmAndamento
        rotulos     = $VerdictLabels
        totais      = [ordered]@{ falas = $doc.Checagens.Count; vereditos = $claims.Count }
        candidatos  = $candidates
        alegacoes   = @($claims | ForEach-Object { [ordered]@{ id = $_.Id; candidato = $_.Candidato; partido = $_.Partido; veredito = $_.Veredito; alegacao = $_.Alegacao } })
        checagens   = $checks
        mudancas    = $null
    }
    if (-not $Publico) { $scan.contexto = @($doc.Intro) }
    $scan
}

function Write-Markdown($doc, $claims, [string]$path, $fonte, [switch]$Publico) {
    $candidates = $doc.Checagens | Select-Object Candidato, Partido -Unique
    $verdictKeys = Get-VerdictKeys $claims

    $sb = New-Object System.Text.StringBuilder
    $L = { param($s) [void]$sb.AppendLine($s) }

    & $L '---'
    & $L ('titulo: ' + (Format-Yaml $doc.Titulo))
    & $L ('fonte: ' + (Format-Yaml $doc.Url))
    & $L ('publicado_em: ' + (Format-Yaml $doc.Publicado))
    if ($doc.Modificado) { & $L ('modificado_em: ' + (Format-Yaml $doc.Modificado)) }
    & $L ('extraido_em: ' + (Format-Yaml (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')))
    if ($fonte) {
        & $L ('fonte_baixada_em: ' + (Format-Yaml $fonte.baixadoEm))
        & $L ('fonte_sha256: ' + $fonte.sha256)
    }
    & $L ('versao: ' + $(if ($Publico) { 'publica (sem as explicações do g1)' } else { 'completa' }))
    & $L ('checagem_em_andamento: ' + $doc.EmAndamento.ToString().ToLower())
    & $L ('unidade_de_contagem: "veredito (uma fala pode ter mais de um)"')
    & $L ('total_falas_checadas: ' + $doc.Checagens.Count)
    & $L ('total_vereditos: ' + $claims.Count)
    & $L 'candidatos:'
    foreach ($cand in $candidates) {
        $mine = @($claims | Where-Object Candidato -eq $cand.Candidato)
        & $L ('  - nome: ' + (Format-Yaml $cand.Candidato))
        & $L ('    partido: ' + $cand.Partido)
        & $L ('    falas_checadas: ' + @($doc.Checagens | Where-Object Candidato -eq $cand.Candidato).Count)
        & $L ('    total_vereditos: ' + $mine.Count)
        & $L '    vereditos:'
        foreach ($vk in $verdictKeys) { & $L ('      {0}: {1}' -f $vk, @($mine | Where-Object Veredito -eq $vk).Count) }
    }
    & $L '---'
    & $L ''
    & $L ('# ' + $doc.Titulo)
    & $L ''
    & $L ("Fonte: <$($doc.Url)>")
    if ($doc.EmAndamento) { & $L ''; & $L '> ⚠️ A página indicava "Esta checagem está em andamento" no momento da extração.' }
    & $L ''

    & $L '## Resumo por candidato'
    & $L ''
    & $L ('| Candidato | Partido | ' + (($verdictKeys | ForEach-Object { if ($VerdictLabels.Contains($_)) { $VerdictLabels[$_] } else { $_ } }) -join ' | ') + ' | Total de vereditos | Falas checadas |')
    & $L ('|---|---|' + ('---:|' * ($verdictKeys.Count + 2)))
    foreach ($cand in $candidates) {
        $mine = @($claims | Where-Object Candidato -eq $cand.Candidato)
        $counts = $verdictKeys | ForEach-Object { $vk = $_; @($mine | Where-Object Veredito -eq $vk).Count }
        & $L ("| $($cand.Candidato) | $($cand.Partido) | " + ($counts -join ' | ') + " | $($mine.Count) | $(@($doc.Checagens | Where-Object Candidato -eq $cand.Candidato).Count) |")
    }
    & $L ''

    & $L '## Índice de vereditos'
    & $L ''
    & $L 'Uma linha por veredito. Falas com mais de um veredito aparecem com sufixo (a, b, ...).'
    & $L ''
    & $L '| ID | Candidato | Partido | Veredito | Alegação |'
    & $L '|---|---|---|---|---|'
    foreach ($cl in $claims) {
        $lbl = if ($VerdictLabels.Contains($cl.Veredito)) { $VerdictLabels[$cl.Veredito] } else { $cl.Veredito }
        & $L ("| $($cl.Id) | $($cl.Candidato) | $($cl.Partido) | $lbl | $(Format-Cell $cl.Alegacao 160) |")
    }
    & $L ''

    if ($Publico) {
        & $L '> Versão pública para auditoria: traz cada fala e o veredito exatamente como aparecem no g1.'
        & $L "> As explicações são do Fato ou Fake e devem ser lidas na página original: <$($doc.Url)>"
        & $L ''
    }
    elseif ($doc.Intro) {
        & $L '## Contexto'
        & $L ''
        foreach ($p in $doc.Intro) { & $L $p; & $L '' }
    }

    & $L '## Checagens'
    foreach ($cand in $candidates) {
        & $L ''
        & $L "### $($cand.Candidato) ($($cand.Partido))"
        foreach ($c in ($doc.Checagens | Where-Object Candidato -eq $cand.Candidato)) {
            $labels = ($c.Vereditos | ForEach-Object { if ($VerdictLabels.Contains($_.Verdict)) { $VerdictLabels[$_.Verdict] } else { $_.Verdict } }) -join ' + '
            & $L ''
            & $L "#### $($c.Id) — $labels"
            & $L ''
            & $L "- **id:** ``$($c.Id)``"
            & $L "- **candidato:** $($c.Candidato)"
            & $L "- **partido:** $($c.Partido)"
            if ($c.Vereditos.Count -eq 1) {
                & $L "- **veredito:** $($c.Vereditos[0].Verdict)"
            } else {
                & $L '- **vereditos:**'
                $k = 0
                foreach ($v in $c.Vereditos) {
                    & $L ("  - ``{0}{1}`` **{2}** — {3}" -f $c.Id, [char](97 + $k), $v.Verdict, $v.Description)
                    $k++
                }
            }
            & $L ''
            & $L '**Fala:**'
            & $L ''
            foreach ($line in ($c.Fala -split "`n")) { & $L "> $line" }
            & $L ''
            & $L "**Veredito no texto original:** $($c.VerdictText -replace "`n", ' ')"
            if ($Publico) { continue }
            & $L ''
            & $L '**Explicação:**'
            & $L ''
            foreach ($p in $c.Explicacao) { & $L $p; & $L '' }
        }
    }

    [System.IO.File]::WriteAllText($path, $sb.ToString(), $Utf8NoBom)
}
