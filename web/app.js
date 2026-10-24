// Verdade à Vista: lê os arquivos de data/, desenha o placar, os gráficos e o histórico.
//
// Dois modos:
//  - publicado (Vercel): só leitura. O GitHub Actions verifica o g1 a cada 10 minutos;
//    quando a checagem muda, data/ é atualizado e o site é publicado de novo. O horário da
//    última verificação vem ao vivo do branch "status" do GitHub (STATUS_URL).
//  - local (server.ps1): /api/config responde, e aparecem os botões de varredura.

const STATUS_URL = 'https://raw.githubusercontent.com/Caina-CPR/verdade-a-vista/status/status.json';
const REFRESH_MS = 5 * 60 * 1000;

const VERDICTS = [
  { key: 'FATO', label: 'Fato', plural: 'Fatos', color: '--v-fato' },
  { key: 'NAO_E_BEM_ASSIM', label: 'Não é bem assim', plural: 'Não é bem assim', color: '--v-nebm' },
  { key: 'FAKE', label: 'Fake', plural: 'Fakes', color: '--v-fake' },
];
// No placar o Fake vem primeiro: é o que o leitor procura.
const SCORE_ORDER = ['FAKE', 'NAO_E_BEM_ASSIM', 'FATO'];
const CAND_COLORS = ['--c1', '--c2', '--c3', '--c4'];

const CHART_TYPES = [
  { key: 'agrupado', label: 'Lado a lado' },
  { key: 'porVeredito', label: 'Por veredito' },
  { key: 'empilhado', label: 'Empilhado' },
  { key: 'percentual', label: '100%' },
  { key: 'horizontal', label: 'Horizontal' },
  { key: 'rosca', label: 'Rosca' },
  { key: 'debates', label: 'Entre debates' },
  { key: 'evolucao', label: 'Evolução' },
];

const state = {
  local: false,
  debates: [],
  candidatos: [],
  status: {},
  flash: null,
  url: loadPref('url', ''),
  history: [],
  scan: null,
  chartType: loadPref('chartType', 'agrupado'),
  evoMetric: loadPref('evoMetric', 'FAKE'),
  charts: [],
};

const $ = (id) => document.getElementById(id);

function loadPref(k, def) { try { return localStorage.getItem('fof.' + k) || def; } catch { return def; } }
function savePref(k, v) { try { localStorage.setItem('fof.' + k, v); } catch { /* sem storage */ } }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function verdictInfo(key) { return VERDICTS.find((v) => v.key === key) || { key, label: key, plural: key, color: '--muted' }; }
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ymd, opts = { day: '2-digit', month: '2-digit' }) {
  const d = new Date(ymd + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', opts);
}
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const plural = (n, um, varios) => (n === 1 ? um : varios);
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n).trimEnd() + '…' : s; }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `Erro ${res.status}`);
  return data;
}

// Arquivo de dados que pode ainda não existir (ex.: antes da primeira varredura).
async function readData(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    return res.ok ? await res.json() : fallback;
  } catch { return fallback; }
}

function showError(msg, warn = false) {
  const a = $('alert');
  a.textContent = msg || '';
  a.hidden = !msg;
  a.classList.toggle('alert--warn', !!warn);
}

// ---------- Tema ----------

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function updateThemeButton() {
  $('theme-toggle').setAttribute('aria-label', currentTheme() === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro');
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  savePref('theme', next);
  updateThemeButton();
  if (state.scan) renderChart();
}

// ---------- Candidatos ----------

function candidate(nome) {
  return state.candidatos.find((c) => c.nome === nome) || { nome, curto: nome.split(' ')[0], partido: '' };
}
// A cor segue o candidato (ordem de data/candidatos.json), não a posição no gráfico.
function candIndex(nome) {
  const i = state.candidatos.findIndex((c) => c.nome === nome);
  if (i >= 0) return i;
  const extra = [...new Set(state.history.flatMap((h) => h.candidatos.map((c) => c.nome)))].filter((n) => !state.candidatos.some((c) => c.nome === n));
  return state.candidatos.length + Math.max(0, extra.indexOf(nome));
}
function candColor(nome) { return cssVar(CAND_COLORS[candIndex(nome) % CAND_COLORS.length]); }
function initials(nome) { return nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase(); }

function avatar(nome, size = '') {
  const c = candidate(nome);
  const cls = 'avatar' + (size ? ` avatar--${size}` : '');
  const style = `--ring:var(${CAND_COLORS[candIndex(nome) % CAND_COLORS.length]})`;
  if (c.foto) return el('img', { class: cls, src: c.foto, alt: `Foto de ${nome}`, style, loading: 'lazy', width: 52, height: 52 });
  return el('span', { class: cls, style, 'aria-hidden': 'true' }, initials(nome));
}

// ---------- Debates ----------

// "FATO OU FAKE: Debate Flávio Bolsonaro x Lula na Band na eleição 2026" -> "Band"
function debateName(h) {
  if (h.debate) return h.debate;
  const m = /\b(?:na|no|da|do)\s+(\S+(?:\s+\S+)?)\s+n[ao]s?\s+elei/i.exec(h.titulo || '');
  return m ? m[1] : (h.titulo || h.url);
}

// Debates cadastrados em data/debates.json + qualquer outra URL que já tenha sido varrida.
function debateList() {
  const list = state.debates.map((d) => ({ ...d }));
  for (const h of state.history) if (!list.some((d) => d.url === h.url)) list.push({ url: h.url, nome: debateName(h) });
  return list;
}
const currentDebate = () => debateList().find((d) => d.url === state.url) || { url: state.url, nome: '' };
const runsOf = (url) => state.history.filter((h) => h.url === url);
const latestRun = (url) => runsOf(url).at(-1);

async function selectDebate(url) {
  state.url = url;
  savePref('url', url);
  showError('');
  state.flash = null;
  const last = latestRun(url);
  if (last) await loadScan(last.id);
  else { state.scan = null; render(); }
}

// ---------- Ações ----------

async function init() {
  buildChartTypeButtons();
  updateThemeButton();
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('btn-scan').addEventListener('click', runScan);
  $('btn-scan-all').addEventListener('click', runScanAll);
  $('evo-metric').value = state.evoMetric;
  $('evo-metric').addEventListener('change', (e) => { state.evoMetric = e.target.value; savePref('evoMetric', state.evoMetric); renderChart(); });
  $('f-cand').addEventListener('change', renderChecks);
  $('f-ver').addEventListener('change', renderChecks);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    updateThemeButton();
    if (state.scan && !document.documentElement.dataset.theme) renderChart();
  });

  // O servidor local só existe em localhost; no site publicado nem tentamos.
  const isLocalHost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const config = isLocalHost ? await readData('/api/config', null) : null;
  state.local = config?.modo === 'local';
  $('actions').hidden = !state.local;

  const [debates, candidatos, history, status] = await Promise.all([
    state.local ? config.debates : readData('data/debates.json', []),
    readData('data/candidatos.json', []),
    readData('data/historico.json', []),
    readStatus(),
  ]);
  state.debates = debates || [];
  state.candidatos = candidatos || [];
  state.history = history || [];
  state.status = status || {};
  renderPhotoCredits();

  const urls = debateList().map((d) => d.url);
  if (!urls.length) return showError('Nenhum debate cadastrado em data/debates.json.');
  // Sem preferência salva, abre o debate mais recente.
  await selectDebate(urls.includes(state.url) ? state.url : urls.at(-1));
  // Com todas as checagens encerradas não há o que buscar de novo.
  if (!state.local && !state.debates.every((d) => d.encerrado)) setInterval(refresh, REFRESH_MS);
}

// Status ao vivo do GitHub; se não der, o que veio junto com o site.
async function readStatus() {
  const local = await readData('data/status.json', {});
  if (state.local) return local;
  const live = await readData(`${STATUS_URL}?t=${Date.now()}`, null);
  if (!live) return local;
  // Fica com a verificação mais recente de cada debate.
  for (const [url, s] of Object.entries(local)) {
    if (!live[url] || new Date(live[url].verificadoEm) < new Date(s.verificadoEm)) live[url] = s;
  }
  return live;
}

// Site publicado: busca status e histórico de novo; se saiu varredura nova, mostra ela.
async function refresh() {
  if (document.hidden) return;
  const [history, status] = await Promise.all([readData('data/historico.json', null), readStatus()]);
  if (status) state.status = status;
  if (history) state.history = history;
  const last = latestRun(state.url);
  const showingLatest = !state.scan || state.scan.id === runsOf(state.url).at(-2)?.id || state.scan.id === last?.id;
  if (last && state.scan?.id !== last.id && showingLatest) await loadScan(last.id);
  else { renderDebateTabs(); renderDebateHead(); renderHistory(); }
}

async function scanUrl(url) {
  const res = await api('/api/varrer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  state.history = res.historico;
  state.status[res.scan.url] = { verificadoEm: new Date().toISOString(), ok: true };
  return res;
}

const BUTTON_LABELS = { 'btn-scan': 'Varrer agora', 'btn-scan-all': 'Varrer todos' };
function setBusy(activeId, label) {
  for (const [id, idle] of Object.entries(BUTTON_LABELS)) {
    const b = $(id);
    b.disabled = !!label;
    b.classList.toggle('is-loading', !!label && id === activeId);
    b.querySelector('.btn__label').textContent = label && id === activeId ? label : idle;
  }
}

async function runScan() {
  setBusy('btn-scan', 'Varrendo…');
  showError('');
  try {
    const res = await scanUrl(state.url);
    state.scan = res.scan;
    state.flash = res.salvo ? null : 'Nada mudou desde a última varredura salva. Verificado agora.';
    render();
  } catch (e) {
    showError('A varredura falhou: ' + e.message);
  } finally {
    setBusy(null);
  }
}

async function runScanAll() {
  const list = debateList();
  const errors = [];
  showError('');
  for (let i = 0; i < list.length; i++) {
    setBusy('btn-scan-all', `Varrendo ${i + 1}/${list.length}…`);
    try {
      const res = await scanUrl(list[i].url);
      if (res.scan.url === state.url) {
        state.scan = res.scan;
        state.flash = res.salvo ? null : 'Nada mudou desde a última varredura salva. Verificado agora.';
      }
    } catch (e) {
      errors.push(`${list[i].nome}: ${e.message}`);
    }
    renderDebateTabs();
  }
  setBusy(null);
  if (!state.scan && latestRun(state.url)) await loadScan(latestRun(state.url).id);
  else render();
  if (errors.length) showError('Alguns debates falharam: ' + errors.join(' · '));
}

async function loadScan(id) {
  try {
    state.scan = await api(`data/scans/${id}.json`);
    state.url = state.scan.url;
    render();
  } catch (e) {
    showError('Não consegui abrir essa varredura: ' + e.message);
  }
}

// ---------- Render ----------

function render() {
  const has = !!state.scan;
  renderDebateTabs();
  renderDebateHead();
  updateSiteIcon();
  $('empty').hidden = has;
  $('content').hidden = !has;
  renderHistory();
  if (!has) return;
  renderSummary();
  renderScoreboard();
  renderFilters();
  renderChart();
  renderChecks();
}

function renderDebateTabs() {
  $('debate-tabs').replaceChildren(...debateList().map((d) => {
    const last = latestRun(d.url);
    return el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(d.url === state.url),
      onclick: () => selectDebate(d.url),
    },
    el('strong', {}, d.nome, last?.emAndamento ? el('span', { class: 'live-dot', title: 'Checagem ainda em andamento no g1' }) : null),
    el('small', {}, [d.data ? fmtDay(d.data) : null, last ? `${last.totais.vereditos} vereditos` : 'aguardando'].filter(Boolean).join(' · ')));
  }));
}

// Qual debate, quando foi, quando foi verificado e o link da checagem original.
function renderDebateHead() {
  const d = currentDebate();
  const s = state.scan;
  const st = state.status[state.url];
  const run = latestRun(state.url);
  const checked = st?.verificadoEm || run?.verificadoEm;

  $('source-link').href = state.url;
  $('debate-eyebrow').textContent = d.turno || 'Checagem do Fato ou Fake';
  const longDate = d.data ? fmtDay(d.data, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  $('debate-title').textContent = [d.titulo || (d.nome ? `Debate ${d.nome}` : 'Debate'), longDate].filter(Boolean).join(' · ');
  document.title = `${d.titulo || d.nome || 'Debate'} · Verdade à Vista`;

  $('debate-meta').textContent = s
    ? `${s.candidatos.map((c) => `${c.nome} (${c.partido})`).join(' × ')} · ${s.totais.falas} falas checadas pelo Fato ou Fake · ${s.totais.vereditos} vereditos`
    : '';

  const box = $('status');
  const latest = s && run?.id === s.id;
  box.replaceChildren(...[
    s?.emAndamento ? el('span', { class: 'pill pill--live', title: 'A página do g1 diz que a checagem ainda está em andamento' }, 'Checagem ainda em andamento no g1') : null,
    // "encerrado" em data/debates.json: o Fato ou Fake terminou a checagem e a varredura parou.
    d.encerrado && !s?.emAndamento
      ? el('span', { class: 'pill pill--done' }, `Checagem concluída pelo Fato ou Fake · resultado final de ${fmtDay(d.encerrado)}`)
      : null,
    checked ? el('span', { class: 'pill' }, (state.local || d.encerrado ? 'Última verificação ' : 'Verificado a cada 10 minutos · última verificação ') + fmtDate(checked)) : null,
    s && !latest ? el('span', { class: 'pill' }, `Vendo varredura antiga de ${fmtDate(s.extraidoEm)}`) : null,
    s?.modificadoEm ? el('span', { class: 'muted' }, 'Página editada pelo g1 em ', fmtDate(s.modificadoEm)) : null,
  ].filter(Boolean));

  if (s) {
    const m = s.mudancas;
    if (state.flash) {
      box.append(el('div', { class: 'changes' }, el('strong', {}, state.flash)));
    } else if (m && state.local) {
      const items = [
        ...(m.novas || []).map((c) => ['Nova', c]),
        ...(m.alteradas || []).map((c) => ['Mudou', c]),
        ...(m.removidas || []).map((c) => ['Saiu', c]),
      ];
      box.append(el('div', { class: 'changes' },
        el('strong', {}, items.length ? `Mudanças desde a varredura anterior (${items.length})` : 'Nada mudou desde a varredura anterior'),
        items.length ? el('ul', {}, items.map(([kind, c]) => el('li', {},
          `${kind}: ${c.candidato} · `, badge(c.veredito),
          c.vereditoAnterior ? ` (antes: ${verdictInfo(c.vereditoAnterior).label})` : '',
          ' — ', truncate(c.alegacao, 110)))) : null));
    }
  }

  if (st && st.ok === false) showError(`A última verificação (${fmtDate(st.verificadoEm)}) falhou: ${st.erro}. Mostrando a última varredura que deu certo.`, true);

  if (!s) {
    $('empty-title').textContent = `${d.titulo || 'Este debate'} ainda não foi varrido`;
    $('empty-text').textContent = state.local
      ? 'Clique em Varrer agora para ler a checagem do Fato ou Fake.'
      : 'A varredura automática roda a cada 10 minutos. Volte daqui a pouco.';
  }
}

function badge(key) {
  const v = verdictInfo(key);
  return el('span', { class: 'badge', style: `--tone:var(${v.color})` }, el('i'), v.label.toUpperCase());
}

// Balança da verdade: frase de quem teve mais falas Fake e a balança de pratos.
function renderSummary() {
  const cands = state.scan.candidatos.map((c) => ({
    ...c,
    fake: c.vereditos.FAKE || 0,
    pFake: pct(c.vereditos.FAKE || 0, c.totalVereditos),
  }));
  const byFake = [...cands].sort((a, b) => b.pFake - a.pFake || b.fake - a.fake);
  const top = byFake[0];
  const tie = byFake.length > 1 && byFake[1].pFake === top.pFake;

  const fakeText = (c) => `${c.fake} ${plural(c.fake, 'fala classificada', 'falas classificadas')} como Fake (${c.pFake}% do que foi checado)`;
  let lead;
  if (!cands.some((c) => c.fake)) lead = ['Nenhuma fala foi classificada como Fake neste debate.'];
  else if (tie) lead = ['Empate: ', ...byFake.map((c, i) => [i ? ' e ' : '', el('span', { class: 'hl' }, c.nome)]).flat(), ` tiveram ${top.pFake}% das falas checadas classificadas como Fake.`];
  else lead = [el('span', { class: 'hl' }, top.nome), ` teve ${fakeText(top)}.`, ...byFake.slice(1).map((c) => ` ${c.nome}: ${c.fake} (${c.pFake}%).`)];

  $('summary').replaceChildren(
    el('h2', { class: 'summary__title', id: 'summary-title' }, 'Balança da verdade'),
    el('p', { class: 'summary__lead' }, lead),
    cands.length === 2 ? el('div', { class: 'balance' }, balanceSvg(cands)) : null,
    el('p', { class: 'summary__note' },
      'A balança pesa o percentual de falas classificadas como Fake: desce o lado de quem teve mais. ',
      'O ponteiro de cada cartão abaixo mostra o índice de veracidade, um cálculo nosso sobre os vereditos do Fato ou Fake: ',
      'Fato vale 1, Não é bem assim vale 0,5 e Fake vale 0, e fazemos a média de cada candidato. ',
      'O Fato ou Fake escolhe quais falas checar, por isso comparamos proporções e não só totais.'),
  );
}

// Fato = 1, Não é bem assim = 0,5, Fake = 0; média de 0 a 100.
function truthIndex(c) {
  if (!c.totalVereditos) return 0;
  return Math.round((100 * ((c.vereditos.FATO || 0) + 0.5 * (c.vereditos.NAO_E_BEM_ASSIM || 0))) / c.totalVereditos);
}

// ---------- Ícone dinâmico ----------

// Velocímetro do ícone: arcos vermelho/amarelo/verde e o ponteiro no valor v (0 a 100).
// O ponteiro é desenhado para cima (valor 50) e girado; assim a logo do topo pode animar.
const needleTurn = (v) => (Math.max(0, Math.min(100, v)) - 50) * 1.8;
function gaugeIconSvg(v, needleClass = '') {
  const at = (val, r) => { const a = Math.PI * (1 - val / 100); return `${(16 + r * Math.cos(a)).toFixed(2)} ${(21 - r * Math.sin(a)).toFixed(2)}`; };
  const seg = (a, b, color) => `<path d="M${at(a, 10.5)}A10.5 10.5 0 0 1 ${at(b, 10.5)}" fill="none" stroke="${color}" stroke-width="4"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1a1a19"/>`
    + seg(0, 31, '#d03b3b') + seg(35, 65, '#fab219') + seg(69, 100, '#0ca30c')
    + `<path class="${needleClass}" d="M16 21V12.5" stroke="#f0efec" stroke-width="2.4" stroke-linecap="round" transform="rotate(${needleTurn(v).toFixed(1)} 16 21)"/>`
    + '<circle cx="16" cy="21" r="2.6" fill="#f0efec"/></svg>';
}

// Índice geral do debate aberto: todos os vereditos de todos os candidatos juntos.
function debateIndex(scan) {
  const all = { vereditos: {}, totalVereditos: 0 };
  for (const c of scan?.candidatos || []) {
    for (const [k, n] of Object.entries(c.vereditos)) all.vereditos[k] = (all.vereditos[k] || 0) + n;
    all.totalVereditos += c.totalVereditos;
  }
  return all.totalVereditos ? truthIndex(all) : null;
}

// Aba do navegador e logo do topo apontam para o índice do debate aberto.
function updateSiteIcon() {
  const v = debateIndex(state.scan);
  const shown = v ?? 50;
  document.querySelector('link[rel="icon"]').href = 'data:image/svg+xml,' + encodeURIComponent(gaugeIconSvg(shown));
  const mark = $('brand-mark');
  let needle = mark.querySelector('.brand__needle');
  if (!needle) {
    mark.innerHTML = gaugeIconSvg(50, 'brand__needle');
    needle = mark.querySelector('.brand__needle');
    needle.removeAttribute('transform');
    needle.getBoundingClientRect(); // garante a animação a partir do meio
  }
  needle.style.transform = `rotate(${needleTurn(shown)}deg)`;
  const d = currentDebate();
  mark.parentElement.title = v == null ? 'Verdade à Vista' : `Índice de veracidade do ${d.titulo || 'debate'}: ${v} de 100 (todos os candidatos)`;
}

// ---------- SVG com fotos ----------

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

let clipSeq = 0;
// Foto redonda com anel na cor do candidato (ou iniciais, se não houver foto).
function svgAvatar(nome, cx, cy, r) {
  const c = candidate(nome);
  const id = `av-clip-${++clipSeq}`;
  return s('g', {},
    s('circle', { cx, cy, r: r + 3, fill: candColor(nome) }),
    s('circle', { cx, cy, r: r + 1, fill: 'var(--surface)' }),
    c.foto
      ? [s('clipPath', { id }, s('circle', { cx, cy, r })),
        s('image', { href: c.foto, x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, preserveAspectRatio: 'xMidYMin slice', 'clip-path': `url(#${id})` })]
      : [s('circle', { cx, cy, r, fill: 'var(--surface-2)' }),
        s('text', { x: cx, y: cy + r * 0.3, 'text-anchor': 'middle', 'font-size': r * 0.8, 'font-weight': 700, fill: 'var(--ink)' }, initials(nome))]);
}

// Balança de pratos: inclina para o lado com maior % de Fake.
function balanceSvg(cands) {
  const [a, b] = cands.map((c) => ({ ...c, n: c.vereditos.FAKE || 0, p: pct(c.vereditos.FAKE || 0, c.totalVereditos) }));
  const px = 180, py = 58, L = 128;
  const deg = Math.max(-16, Math.min(16, (a.p - b.p) * 0.4)); // positivo: lado esquerdo desce
  const t = (deg * Math.PI) / 180;
  const ends = [{ x: px - L * Math.cos(t), y: py + L * Math.sin(t) }, { x: px + L * Math.cos(t), y: py - L * Math.sin(t) }];
  const pan = (end, c) => {
    const panY = end.y + 80, w = 46;
    return s('g', {},
      s('path', { d: `M${end.x} ${end.y}L${end.x - w + 4} ${panY}M${end.x} ${end.y}L${end.x + w - 4} ${panY}`, stroke: 'var(--axis)', 'stroke-width': 1.5 }),
      s('path', { d: `M${end.x - w} ${panY}h${2 * w}a${w} 17 0 0 1 ${-2 * w} 0z`, fill: 'var(--v-fake)', 'fill-opacity': (0.2 + (0.8 * c.p) / 100).toFixed(2) }),
      svgAvatar(c.nome, end.x, panY - 24, 20),
      s('text', { x: end.x, y: panY + 40, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 16, 'font-weight': 750 }, `${c.p}% fake`),
      s('text', { x: end.x, y: panY + 56, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 12 }, `${candidate(c.nome).curto || c.nome} · ${c.n} de ${c.totalVereditos}`));
  };
  return s('svg', { viewBox: '0 0 360 240', role: 'img', 'aria-label': `Balança: ${a.nome} ${a.p}% fake, ${b.nome} ${b.p}% fake` },
    s('path', { d: `M${px} ${py}V226M${px - 46} 226h92`, stroke: 'var(--ink-2)', 'stroke-width': 4, 'stroke-linecap': 'round' }),
    s('path', { d: `M${ends[0].x} ${ends[0].y}L${ends[1].x} ${ends[1].y}`, stroke: 'var(--ink)', 'stroke-width': 4, 'stroke-linecap': 'round' }),
    s('circle', { cx: px, cy: py, r: 7, fill: 'var(--ink)' }),
    pan(ends[0], a), pan(ends[1], b));
}

// Velocímetro do índice de veracidade, para os cartões do placar.
function gauge(c) {
  const v = truthIndex(c);
  const cx = 50, cy = 50, r = 38;
  const at = (val, rr = r) => { const a = Math.PI * (1 - val / 100); return { x: cx + rr * Math.cos(a), y: cy - rr * Math.sin(a) }; };
  const arc = (v0, v1, color) => { const p0 = at(v0), p1 = at(v1); return s('path', { d: `M${p0.x} ${p0.y}A${r} ${r} 0 0 1 ${p1.x} ${p1.y}`, fill: 'none', stroke: `var(${color})`, 'stroke-width': 9 }); };
  const tip = at(v, r - 12);
  return el('div', { class: 'gauge', title: 'Índice de veracidade: Fato = 1, Não é bem assim = 0,5, Fake = 0' },
    s('svg', { viewBox: '0 0 100 56', role: 'img', 'aria-label': `Índice de veracidade ${v} de 100` },
      arc(0, 32, '--v-fake'), arc(34, 65, '--v-nebm'), arc(67, 100, '--v-fato'),
      s('path', { d: `M${cx} ${cy}L${tip.x} ${tip.y}`, stroke: 'var(--ink)', 'stroke-width': 3, 'stroke-linecap': 'round' }),
      s('circle', { cx, cy, r: 4.5, fill: 'var(--ink)' })),
    el('div', {}, el('b', {}, v), el('small', {}, 'índice de veracidade')));
}

function renderScoreboard() {
  const cands = state.scan.candidatos;
  const share = (c, k) => pct(c.vereditos[k] || 0, c.totalVereditos);
  const leader = (k) => {
    const sorted = [...cands].sort((a, b) => share(b, k) - share(a, k));
    return sorted.length > 1 && share(sorted[0], k) > share(sorted[1], k) && (sorted[0].vereditos[k] || 0) > 0 ? sorted[0].nome : null;
  };
  const mostFake = leader('FAKE');
  const mostFato = leader('FATO');

  const box = $('scoreboard');
  box.classList.toggle('scoreboard--pair', cands.length === 2);
  box.replaceChildren(...cands.map((c) => el('article', { class: 'score' },
    el('div', { class: 'score__head' },
      avatar(c.nome),
      el('div', { class: 'score__who' },
        el('div', { class: 'score__name' }, candidate(c.nome).curto || c.nome),
        el('div', { class: 'score__sub' }, `${c.partido} · ${c.totalVereditos} vereditos · ${c.falas} falas`),
        c.nome === mostFake ? el('span', { class: 'flag flag--fake' }, 'Mais fakes') : null,
        c.nome === mostFato ? el('span', { class: 'flag flag--fato' }, 'Mais fatos') : null),
      gauge(c)),
    el('div', { class: 'stackbar', role: 'img', 'aria-label': VERDICTS.map((v) => `${v.label}: ${c.vereditos[v.key] || 0}`).join(', ') },
      VERDICTS.map((v) => {
        const n = c.vereditos[v.key] || 0;
        return n ? el('span', { style: `flex:${n};background:var(${v.color})`, title: `${v.label}: ${n}` }) : null;
      })),
    // Maior quantidade primeiro; no empate vale a ordem Fake, Não é bem assim, Fato.
    el('ul', { class: 'score__rows' }, [...SCORE_ORDER].sort((a, b) => (c.vereditos[b] || 0) - (c.vereditos[a] || 0)).map((k) => {
      const v = verdictInfo(k);
      const n = c.vereditos[k] || 0;
      return el('li', { class: 'score__row', style: `--tone:var(${v.color})` },
        el('span', { class: 'score__label' }, el('span', { class: 'dot' }), v.plural),
        el('span', { class: 'score__num' }, n),
        el('span', { class: 'score__pct' }, `${share(c, k)}%`));
    })),
  )));
}

function buildChartTypeButtons() {
  $('chart-types').replaceChildren(...CHART_TYPES.map((t) => el('button', {
    type: 'button', role: 'tab', 'data-type': t.key, 'aria-selected': String(t.key === state.chartType),
    onclick: () => { state.chartType = t.key; savePref('chartType', t.key); renderChart(); },
  }, t.label)));
}

function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }

function baseOptions() {
  const ink2 = cssVar('--ink-2'), grid = cssVar('--grid'), axis = cssVar('--axis');
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.color = ink2;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--surface'), titleColor: cssVar('--ink'), bodyColor: ink2,
        borderColor: axis, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: axis }, ticks: { color: ink2 } },
      y: { beginAtZero: true, grace: '12%', grid: { color: grid }, border: { display: false }, ticks: { precision: 0, color: ink2 } },
    },
  };
}

// Rótulo de valor na ponta de cada barra (ou no topo da pilha).
const valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.mode) return;
    const { ctx } = chart;
    const horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = cssVar('--ink');
    if (opts.mode === 'each') {
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        if (meta.hidden) return;
        meta.data.forEach((bar, j) => {
          const v = ds.data[j];
          if (v == null) return;
          if (horizontal) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(v, bar.x + 6, bar.y); }
          else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(v, bar.x, bar.y - 4); }
        });
      });
    } else if (opts.mode === 'total') {
      const last = chart.data.datasets.length - 1;
      chart.getDatasetMeta(last).data.forEach((bar, j) => {
        const total = chart.data.datasets.reduce((s, ds) => s + (ds.data[j] || 0), 0);
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`Total ${total}`, bar.x, bar.y - 4);
      });
    }
    ctx.restore();
  },
};

// Itens [rótulo, cor, nome do candidato opcional]; com candidato, a foto entra ao lado.
function setLegend(items) {
  $('legend').replaceChildren(...items.map(([label, color, nome]) =>
    el('span', {}, el('i', { style: `background:${color}` }), nome ? avatar(nome, 'xs') : null, label)));
}

// Fotos carregadas uma vez para desenhar dentro dos gráficos (canvas).
const photoCache = {};
function photoImage(nome) {
  const src = candidate(nome).foto;
  if (!src) return null;
  let img = photoCache[src];
  if (!img) {
    img = photoCache[src] = new Image();
    img.onload = () => state.charts.forEach((ch) => ch.draw());
    img.src = src;
  }
  return img.complete && img.naturalWidth ? img : null;
}

// Foto de cada candidato junto ao rótulo do eixo (embaixo, ou à esquerda no gráfico horizontal).
const axisAvatars = {
  id: 'axisAvatars',
  afterDraw(chart, _args, opts) {
    if (!opts?.names) return;
    const horizontal = chart.options.indexAxis === 'y';
    const scale = horizontal ? chart.scales.y : chart.scales.x;
    const { ctx } = chart;
    const r = 13;
    opts.names.forEach((nome, i) => {
      const p = scale.getPixelForTick(i);
      const x = horizontal ? scale.left - r - 4 : p;
      const y = horizontal ? p : scale.bottom + r + 4;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 2 * Math.PI); ctx.fillStyle = candColor(nome); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.clip();
      const img = photoImage(nome);
      if (img) {
        ctx.drawImage(img, x - r, y - r, 2 * r, (2 * r * img.naturalHeight) / img.naturalWidth);
      } else {
        ctx.fillStyle = cssVar('--surface-2'); ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        ctx.fillStyle = cssVar('--ink'); ctx.font = '700 10px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(initials(nome), x, y);
      }
      ctx.restore();
    });
  },
};

function renderChart() {
  document.querySelectorAll('#chart-types button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === state.chartType)));
  destroyCharts();
  const area = $('chart-area');
  area.replaceChildren();
  area.classList.toggle('is-multi', state.chartType === 'rosca' || state.chartType === 'debates');
  $('evo-toolbar').hidden = state.chartType !== 'evolucao';
  $('chart-note').textContent = '';

  const cands = state.scan.candidatos;
  const surface = cssVar('--surface');
  const vColors = VERDICTS.map((v) => cssVar(v.color));
  const opts = baseOptions();
  const type = state.chartType;

  if (type === 'evolucao') return renderEvolution(area, opts);
  if (type === 'debates') return renderDebates(area);

  if (type === 'rosca') {
    setLegend(VERDICTS.map((v, i) => [v.label, vColors[i]]));
    cands.forEach((c) => {
      const canvas = el('canvas', { 'aria-label': `Vereditos de ${c.nome}`, role: 'img' });
      area.append(el('div', { class: 'mini' }, el('h3', {}, avatar(c.nome, 'sm'), `${c.nome} (${c.partido})`), el('div', { class: 'mini__canvas' }, canvas)));
      const center = {
        id: 'center',
        afterDraw(chart) {
          const { ctx, chartArea: a } = chart;
          ctx.save();
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillStyle = cssVar('--ink'); ctx.font = '650 26px system-ui, sans-serif';
          ctx.fillText(c.totalVereditos, (a.left + a.right) / 2, (a.top + a.bottom) / 2 - 8);
          ctx.fillStyle = cssVar('--muted'); ctx.font = '12px system-ui, sans-serif';
          ctx.fillText('vereditos', (a.left + a.right) / 2, (a.top + a.bottom) / 2 + 14);
          ctx.restore();
        },
      };
      state.charts.push(new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: VERDICTS.map((v) => v.label),
          datasets: [{ data: VERDICTS.map((v) => c.vereditos[v.key] || 0), backgroundColor: vColors, borderColor: surface, borderWidth: 2, borderRadius: 4 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '64%',
          plugins: {
            legend: { display: false },
            tooltip: { ...opts.plugins.tooltip, callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed} (${pct(ctx.parsed, c.totalVereditos)}%)` } },
          },
        },
        plugins: [center],
      }));
    });
    renderDataTable();
    return;
  }

  let labels, datasets;
  if (type === 'porVeredito') {
    labels = VERDICTS.map((v) => v.label);
    datasets = cands.map((c) => ({ label: c.nome, data: VERDICTS.map((v) => c.vereditos[v.key] || 0), backgroundColor: candColor(c.nome) }));
    setLegend(cands.map((c) => [c.nome, candColor(c.nome), c.nome]));
  } else {
    labels = cands.map((c) => candidate(c.nome).curto || c.nome);
    datasets = VERDICTS.map((v, i) => ({
      label: v.label,
      data: cands.map((c) => {
        const n = c.vereditos[v.key] || 0;
        return type === 'percentual' ? pct(n, c.totalVereditos) : n;
      }),
      backgroundColor: vColors[i],
    }));
    setLegend(VERDICTS.map((v, i) => [v.label, vColors[i]]));
  }

  const stacked = type === 'empilhado' || type === 'percentual';
  datasets.forEach((d) => Object.assign(d, stacked
    ? { borderColor: surface, borderWidth: { top: 2 }, borderSkipped: 'start', borderRadius: 0, maxBarThickness: 120 }
    : { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 56, categoryPercentage: 0.7, barPercentage: 0.9 }));

  if (type === 'horizontal') {
    opts.indexAxis = 'y';
    const x = opts.scales.x, y = opts.scales.y;
    opts.scales = { x: { ...y, grace: '15%' }, y: { ...x } };
  }
  if (stacked) {
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
  }
  if (type === 'percentual') {
    opts.scales.y.max = 100;
    opts.scales.y.grace = 0;
    opts.scales.y.ticks.callback = (v) => v + '%';
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => {
        const c = cands[ctx.dataIndex];
        return ` ${ctx.dataset.label}: ${ctx.parsed.y}% (${c.vereditos[VERDICTS[ctx.datasetIndex].key] || 0} de ${c.totalVereditos})`;
      },
    };
  }
  opts.plugins.valueLabels = { mode: type === 'percentual' ? null : type === 'empilhado' ? 'total' : 'each' };
  // Eixo com candidatos: espaço extra e a foto ao lado de cada nome.
  if (type !== 'porVeredito') {
    opts.plugins.axisAvatars = { names: cands.map((c) => c.nome) };
    opts.layout = { padding: type === 'horizontal' ? { left: 36 } : { bottom: 34 } };
  }
  if (type === 'empilhado') $('chart-note').textContent = 'Toque ou passe o mouse sobre cada parte para ver a contagem.';
  if (type === 'percentual') $('chart-note').textContent = 'Proporção de cada veredito sobre o total de vereditos do candidato.';

  const canvas = el('canvas', { role: 'img', 'aria-label': 'Gráfico de vereditos por candidato' });
  area.append(canvas);
  state.charts.push(new Chart(canvas, { type: 'bar', data: { labels, datasets }, options: opts, plugins: [valueLabels, axisAvatars] }));
  renderDataTable();
}

function renderEvolution(area, opts) {
  const url = state.scan.url;
  const runs = runsOf(url);
  const names = [...new Set(runs.flatMap((r) => r.candidatos.map((c) => c.nome)))];
  const metric = state.evoMetric;
  const value = (run, name) => {
    const c = run.candidatos.find((x) => x.nome === name);
    if (!c) return null;
    return metric === 'TOTAL' ? c.totalVereditos : (c.vereditos[metric] || 0);
  };
  setLegend(names.map((n) => [n, candColor(n), n]));
  const canvas = el('canvas', { role: 'img', 'aria-label': 'Evolução dos vereditos ao longo das varreduras' });
  area.append(canvas);
  opts.interaction = { mode: 'index', intersect: false };
  opts.plugins.tooltip.callbacks = { title: (items) => 'Varredura de ' + items[0].label };
  state.charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      labels: runs.map((r) => new Date(r.extraidoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      datasets: names.map((n) => ({
        label: n, data: runs.map((r) => value(r, n)), borderColor: candColor(n), backgroundColor: candColor(n),
        borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: cssVar('--surface'), pointBorderWidth: 2, tension: 0,
      })),
    },
    options: opts,
  }));
  const label = metric === 'TOTAL' ? 'total de vereditos' : `vereditos "${verdictInfo(metric).label}"`;
  $('chart-note').textContent = runs.length < 2
    ? 'Só há uma varredura salva deste debate. Uma nova entra no histórico quando o g1 muda a checagem.'
    : `Número de ${label} em cada uma das ${runs.length} varreduras deste debate.`;
  renderDataTable(runs, names, value);
}

// Um gráfico por candidato, uma barra empilhada por debate (última varredura de cada um).
function renderDebates(area) {
  const debates = debateList().map((d) => ({ ...d, run: latestRun(d.url) })).filter((d) => d.run);
  const names = [...new Set(debates.flatMap((d) => d.run.candidatos.map((c) => c.nome)))];
  const surface = cssVar('--surface');
  const vColors = VERDICTS.map((v) => cssVar(v.color));
  const count = (d, name, key) => {
    const c = d.run.candidatos.find((x) => x.nome === name);
    if (!c) return null;
    return key ? (c.vereditos[key] || 0) : c.totalVereditos;
  };
  // Mesma escala em todos os gráficos para dar para comparar candidatos.
  const yMax = Math.ceil(Math.max(1, ...debates.flatMap((d) => names.map((n) => count(d, n) || 0))) * 1.15);
  setLegend(VERDICTS.map((v, i) => [v.label, vColors[i]]));

  names.forEach((name) => {
    const canvas = el('canvas', { role: 'img', 'aria-label': `Vereditos de ${name} em cada debate` });
    area.append(el('div', { class: 'mini' }, el('h3', {}, avatar(name, 'sm'), name), el('div', { class: 'mini__canvas' }, canvas)));
    const opts = baseOptions();
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    opts.scales.y.max = yMax;
    opts.plugins.valueLabels = { mode: 'total' };
    state.charts.push(new Chart(canvas, {
      type: 'bar',
      data: {
        labels: debates.map((d) => d.nome),
        datasets: VERDICTS.map((v, i) => ({
          label: v.label, data: debates.map((d) => count(d, name, v.key)), backgroundColor: vColors[i],
          borderColor: surface, borderWidth: { top: 2 }, borderSkipped: 'start', borderRadius: 0, maxBarThickness: 90,
        })),
      },
      options: opts,
      plugins: [valueLabels],
    }));
  });

  $('chart-note').textContent = debates.length < 2
    ? 'Ainda não há dois debates varridos para comparar.'
    : `Última varredura de cada debate. Mesma escala nos ${names.length} gráficos.`;
  $('data-table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Candidato'), el('th', {}, 'Debate'), VERDICTS.map((v) => el('th', { class: 'num' }, v.label)), el('th', { class: 'num' }, 'Total'))),
    el('tbody', {}, names.flatMap((n) => debates.map((d) => el('tr', {},
      el('td', {}, n), el('td', {}, d.nome),
      VERDICTS.map((v) => el('td', { class: 'num' }, count(d, n, v.key) ?? '—')),
      el('td', { class: 'num' }, count(d, n) ?? '—')))))));
}

function renderDataTable(runs, names, value) {
  const box = $('data-table');
  if (runs) {
    box.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Varredura'), names.map((n) => el('th', { class: 'num' }, n)))),
      el('tbody', {}, runs.map((r) => el('tr', {}, el('td', {}, fmtDate(r.extraidoEm)), names.map((n) => el('td', { class: 'num' }, value(r, n) ?? '—')))))));
    return;
  }
  const cands = state.scan.candidatos;
  box.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Candidato'), VERDICTS.map((v) => el('th', { class: 'num' }, v.label)), el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Falas'))),
    el('tbody', {}, cands.map((c) => el('tr', {},
      el('td', {}, `${c.nome} (${c.partido})`),
      VERDICTS.map((v) => el('td', { class: 'num' }, `${c.vereditos[v.key] || 0} (${pct(c.vereditos[v.key] || 0, c.totalVereditos)}%)`)),
      el('td', { class: 'num' }, c.totalVereditos),
      el('td', { class: 'num' }, c.falas))))));
}

function renderFilters() {
  const fc = $('f-cand'), fv = $('f-ver');
  const keepC = fc.value, keepV = fv.value;
  fc.replaceChildren(el('option', { value: '' }, 'Todos os candidatos'), ...state.scan.candidatos.map((c) => el('option', { value: c.nome }, c.nome)));
  fv.replaceChildren(el('option', { value: '' }, 'Todos os vereditos'), ...VERDICTS.map((v) => el('option', { value: v.key }, v.label)));
  fc.value = state.scan.candidatos.some((c) => c.nome === keepC) ? keepC : '';
  fv.value = keepV;
}

function renderExplanation(lines) {
  const out = [];
  let list = null;
  for (const line of lines || []) {
    if (line.startsWith('- ')) {
      if (!list) { list = el('ul'); out.push(list); }
      list.append(el('li', {}, line.slice(2)));
      continue;
    }
    list = null;
    const bold = /^\*\*(.*)\*\*$/.exec(line);
    out.push(bold ? el('p', {}, el('strong', {}, bold[1])) : el('p', {}, line));
  }
  return out;
}

function renderChecks() {
  const fc = $('f-cand').value, fv = $('f-ver').value;
  const list = state.scan.checagens.filter((c) => (!fc || c.candidato === fc) && (!fv || c.vereditos.some((v) => v.veredito === fv)));
  const box = $('checks');
  if (!list.length) return box.replaceChildren(el('p', { class: 'empty-list' }, 'Nenhuma checagem com esses filtros.'));
  // A borda lateral usa a cor do veredito mais grave da fala.
  const worst = (c) => SCORE_ORDER.find((k) => c.vereditos.some((v) => v.veredito === k)) || c.vereditos[0]?.veredito;
  box.replaceChildren(...list.map((c) => el('article', { class: 'check', style: `--tone:var(${verdictInfo(worst(c)).color})` },
    el('div', { class: 'check__meta' },
      el('span', { class: 'check__who' }, avatar(c.candidato, 'sm'), c.candidato),
      c.vereditos.map((v) => badge(v.veredito)),
      el('span', { class: 'check__id' }, c.id)),
    el('blockquote', {}, c.fala),
    c.vereditos.length > 1 ? c.vereditos.map((v) => el('p', { class: 'check__sub' }, badge(v.veredito), ' ', v.descricao)) : null,
    // Versão pública não traz o texto das explicações: elas ficam na página do g1.
    c.explicacao?.length
      ? el('details', {}, el('summary', {}, 'Por quê?'), renderExplanation(c.explicacao))
      : el('a', { class: 'check__more', href: state.scan.url, target: '_blank', rel: 'noopener noreferrer' }, 'Por quê? Leia a explicação no g1 ↗'),
  )));
}

function renderHistory() {
  const runs = [...runsOf(state.url)].reverse();
  $('history-count').textContent = runs.length ? `${runs.length} varredura${runs.length > 1 ? 's' : ''}` : '';
  const box = $('history');
  if (!runs.length) return box.replaceChildren(el('li', { class: 'empty-list' }, 'Nenhuma varredura salva.'));
  box.replaceChildren(...runs.map((r) => el('li', {},
    el('button', { type: 'button', 'aria-current': String(state.scan && state.scan.id === r.id), onclick: () => loadScan(r.id) },
      el('div', { class: 'history__top' },
        el('span', {}, fmtDate(r.extraidoEm)),
        r.novas ? el('span', { class: 'tag-new' }, `${r.novas} mudança${r.novas > 1 ? 's' : ''}`) : el('span', { class: 'small muted' }, `${r.totais.vereditos} vereditos`)),
      el('div', { class: 'history__cands' }, r.candidatos.map((c) => el('span', {},
        el('b', {}, c.nome), ': ',
        VERDICTS.map((v) => `${c.vereditos[v.key] || 0} ${v.label.toLowerCase()}`).join(' · '))))),
    el('div', { class: 'history__links' },
      el('a', { href: `data/md/${r.id}.md`, target: '_blank', rel: 'noopener' }, 'Markdown'),
      el('a', { href: `data/md/${r.id}.md`, download: `verdade-a-vista_${r.id}.md` }, 'baixar'),
      el('a', { href: `data/scans/${r.id}.json`, target: '_blank', rel: 'noopener' }, 'JSON')),
  )));
}

function renderPhotoCredits() {
  const withPhoto = state.candidatos.filter((c) => c.foto && c.credito);
  $('photo-credits').replaceChildren(...(withPhoto.length ? ['Fotos: ', ...withPhoto.flatMap((c, i) => [
    i ? ' · ' : '',
    el('a', { href: c.fonteFoto, target: '_blank', rel: 'noopener noreferrer' }, `${c.nome}: ${c.credito}`),
    c.licenca ? ` (${c.licenca})` : '',
  ]), ', via Wikimedia Commons.'] : []));
}

init();
