# Verdade à Vista

Placar aberto das checagens do [Fato ou Fake (g1)](https://g1.globo.com/fato-ou-fake/) nos debates:
quantas falas de cada candidato foram **Fato**, **Não é bem assim** ou **Fake**, em gráficos, com histórico
e com os dados brutos para qualquer pessoa conferir.

Projeto independente, sem vínculo com o Grupo Globo. As checagens são do Fato ou Fake; aqui só
contamos os vereditos. As explicações devem ser lidas na página original do g1.

## Situação

As checagens dos dois debates do 2º turno terminaram (Band em 22/10, Globo em 24/10/2026) e a
varredura automática foi desligada: o site mostra o resultado final. Os debates encerrados têm o
campo `encerrado` em `data/debates.json`. Para acompanhar um novo debate, cadastre-o e religue o
`schedule` em [`varredura.yml`](.github/workflows/varredura.yml) e/ou a tarefa local
(`scripts/instalar-disparo.ps1`).

## Como funciona

```
GitHub Actions (a cada 10 min)              Vercel (site estático)
  scripts/varrer.ps1 -Publico
  ├─ checagem mudou → commit na main  ──►   redeploy: web/ + data/
  └─ sempre → status.json no branch status  (lido ao vivo pela página, sem deploy)
```

- A cada 10 minutos o workflow [`varredura.yml`](.github/workflows/varredura.yml) varre os debates de
  [`data/debates.json`](data/debates.json).
- Uma varredura nova só é salva (commit na `main`, que publica o site) quando algo mudou na checagem
  do g1. Cada commit do bot fica no histórico do Git como registro.
- O horário da última verificação, e o erro se ela falhou, vai para o branch `status`: um único commit,
  sobrescrito a cada vez. Esse branch não gera deploy (`vercel.json`), o que mantém o site dentro do
  limite de deploys diários da Vercel. A página lê esse arquivo direto do GitHub e se atualiza sozinha.
- O site na Vercel só lê arquivos. Não há servidor nem banco de dados.
- O GitHub pode atrasar ou pular execuções agendadas quando está sobrecarregado. Por isso há
  também um disparo pelo seu computador (abaixo).

### Disparo pelo seu computador

`scripts/instalar-disparo.ps1` cria uma tarefa do Windows que, a cada 10 minutos, dispara o
workflow com o GitHub CLI (`gh`, precisa de `gh auth login` feito uma vez). Se o GitHub já rodou a
varredura há menos de 8 minutos, a tarefa pula a vez. Ela só roda com o computador ligado e você
logado; o agendamento do GitHub continua valendo como reserva.

```powershell
.\scripts\instalar-disparo.ps1              # instala ou atualiza (a cada 10 minutos)
.\scripts\instalar-disparo.ps1 -Minutos 15  # outro intervalo
.\scripts\instalar-disparo.ps1 -Remover     # remove
```

Log: `%LOCALAPPDATA%\VerdadeAVista\disparo.log`.

## Conferir a varredura (auditoria)

No painel, cada item do histórico tem os links **Markdown** e **JSON**. Os mesmos arquivos ficam no
repositório:

```
data/
  debates.json          debates acompanhados
  historico.json        resumo de cada varredura salva
  status.json           última verificação de cada debate (e o erro, se falhou)
  scans/<id>.json       varredura completa: candidatos, alegações, checagens, mudanças
  md/<id>.md            mesma varredura em Markdown, para leitura
```

Cada checagem traz a fala, o veredito e a frase de veredito exatamente como aparecem no g1
(ex.: `A declaração é #FAKE. Veja por quê:`). O campo `fonte_sha256` identifica a versão da página
que foi baixada. Para conferir, abra a página do g1 e compare fala por fala.

Cada veredito conta uma vez: uma fala com dois vereditos vira duas alegações (`lula-02a`, `lula-02b`).

## Candidatos

`data/candidatos.json` define o nome curto, o partido e a foto de cada candidato (em `web/img/`).
As fotos são oficiais, com licença de uso livre e crédito exibido no rodapé:

- Flávio Bolsonaro: Agência Senado, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Foto_oficial_do_senador_Fl%C3%A1vio_Bolsonaro_(v._AgSen)_(3x4).jpg)
- Lula: Ricardo Stuckert/PR (CC BY 2.0), via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Foto_oficial_de_Luiz_In%C3%A1cio_Lula_da_Silva_(ombros)_denoise.jpg)

Candidato sem foto cadastrada aparece com as iniciais.

## Adicionar um debate

Inclua o debate em `data/debates.json` (nome, título, turno, data e URL do Fato ou Fake) e faça commit. Ele entra
na próxima varredura. Para não esperar, rode o workflow na aba **Actions › Varredura › Run workflow**.

## Rodar no seu computador

Dê dois cliques em `iniciar.bat` (abre <http://localhost:8765/>). A versão local tem os botões
**Varrer agora** / **Varrer todos**, aceita qualquer URL do Fato ou Fake e guarda a versão
**completa** (com as explicações do g1) em `data-local/`, que não vai para o GitHub.

Também dá para varrer pela linha de comando:

```powershell
.\scripts\varrer.ps1 -Publico                # atualiza data/ (o que vai para o site)
.\scripts\varrer.ps1 -DataDir data-local     # versão completa, só local
```

Não precisa instalar nada: tudo roda no Windows PowerShell. Os gráficos usam Chart.js via CDN.

## Publicar

1. Crie o repositório no GitHub e envie esta pasta.
2. Na Vercel: **Add New › Project**, importe o repositório e confirme (o `vercel.json` já define o build).
3. No GitHub, aba **Actions**: habilite os workflows, se pedir, e rode **Varredura** uma vez.

O GitHub pausa agendamentos em repositórios sem atividade por 60 dias. Os commits do próprio bot
contam como atividade enquanto ele estiver rodando.

## Arquivos

- `lib/FatoOuFake.ps1`: lê a página do g1 e gera JSON/Markdown
- `lib/Historico.ps1`: compara com a varredura anterior e grava o histórico
- `scripts/varrer.ps1`: varredura de todos os debates (usado pelo GitHub Actions)
- `server.ps1` + `iniciar.bat`: versão local com botões de varredura
- `web/`: o site (`index.html`, `style.css`, `app.js`)
