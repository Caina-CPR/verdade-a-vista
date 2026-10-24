// Verdade à Vista: lê os arquivos de data/, desenha os gráficos e o histórico.
//
// Dois modos:
//  - publicado (Vercel): só leitura; o GitHub Actions atualiza data/ de hora em hora.
//  - local (server.ps1): /api/config responde, e aparecem os botões de varredura.

const VERDICTS = [
  { key: 'FATO', label: 'Fato', color: '--v-fato' },
  { key: 'NAO_E_BEM_ASSIM', label: 'Não é bem assim', color: '--v-nebm' },
  { key: 'FAKE', label: 'Fake', color: '--v-fake' },
];
const CAND_COLORS = ['--c1', '--c2', '--c3', '--c4'];

const CHART_TYPES = [
  { key: 'agrupado', label: 'Barras lado a lado' },
  { key: 'porVeredito', label: 'Por veredito' },
  { key: 'empilhado', label: 'Empilhado' },
  { key: 'percentual', label: '100%' },
  { key: 'horizontal', label: 'Horizontal' },
  { key: 'rosca', label: 'Rosca' },
  { key: 'evolucao', label: 'Evolução' },
  { key: 'debates', label: 'Entre debates' },
];

const state = {
  local: false,
  debates: [],
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
function verdictInfo(key) { return VERDICTS.find((v) => v.key === key) || { key, label: key, color: '--muted' }; }
function candColor(i) { return cssVar(CAND_COLORS[i % CAND_COLORS.length]); }
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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

function showError(msg) {
  const a = $('alert');
  a.textContent = msg;
  a.hidden = !msg;
}

// ---------- Debates ----------

// "FATO OU FAKE: Debate Flávio Bolsonaro x Lula na Band na eleição 2026" -> "Band"
function debateName(h) {
  if (h.debate) return h.debate;
  const m = /\b(?:na|no|da|do)\s+(\S+(?:\s+\S+)?)\s+n[ao]s?\s+elei/i.exec(h.titulo || '');
  return m ? m[1] : (h.titulo || h.url);
}

// Debates pré-cadastrados no servidor + qualquer outra URL que já tenha sido varrida.
function debateList() {
  const list = state.debates.map((d) => ({ url: d.url, nome: d.nome }));
  for (const h of state.history) if (!list.some((d) => d.url === h.url)) list.push({ url: h.url, nome: debateName(h) });
  return list;
}
const runsOf = (url) => state.history.filter((h) => h.url === url);
const latestRun = (url) => runsOf(url).at(-1);

async function selectDebate(url) {
  state.url = url;
  savePref('url', url);
  $('url').value = url;
  $('source-link').href = url;
  showError('');
  state.flash = null;
  const last = latestRun(url);
  if (last) await loadScan(last.id);
  else { state.scan = null; render(); }
}

// ---------- Ações ----------

async function init() {
  buildChartTypeButtons();
  $('btn-scan').addEventListener('click', runScan);
  $('btn-scan-all').addEventListener('click', runScanAll);
  $('evo-metric').value = state.evoMetric;
  $('evo-metric').addEventListener('change', (e) => { state.evoMetric = e.target.value; savePref('evoMetric', state.evoMetric); renderChart(); });
  $('f-cand').addEventListener('change', renderChecks);
  $('f-ver').addEventListener('change', renderChecks);
  $('url').addEventListener('input', () => { $('source-link').href = $('url').value; });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.scan && render());

  // O servidor local só existe em localhost; no site publicado nem tentamos.
  const isLocalHost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const config = isLocalHost ? await readData('/api/config', null) : null;
  state.local = config?.modo === 'local';
  $('actions').hidden = !state.local;
  $('url-box').hidden = !state.local;
  $('auto-note').hidden = state.local;

  const [debates, history, status] = await Promise.all([
    state.local ? config.debates : readData('data/debates.json', []),
    readData('data/historico.json', []),
    readData('data/status.json', {}),
  ]);
  state.debates = debates || [];
  state.history = history || [];
  state.status = status || {};
  const urls = debateList().map((d) => d.url);
  if (!urls.length) return showError('Nenhum debate cadastrado em data/debates.json.');
  await selectDebate(urls.includes(state.url) ? state.url : (state.history.at(-1)?.url || urls.at(-1)));
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
    const res = await scanUrl($('url').value.trim());
    state.scan = res.scan;
    state.flash = res.salvo ? null : 'Nada mudou desde a última varredura salva. Verificado agora.';
    state.url = state.scan.url;
    savePref('url', state.url);
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
    $('url').value = state.scan.url;
    $('source-link').href = state.scan.url;
    render();
  } catch (e) {
    showError('Não consegui abrir essa varredura: ' + e.message);
  }
}

// ---------- Render ----------

function renderDebateTabs() {
  $('debate-tabs').replaceChildren(...debateList().map((d) => {
    const last = latestRun(d.url);
    return el('button', {
      type: 'button', role: 'tab', title: d.url, 'aria-selected': String(d.url === state.url),
      onclick: () => selectDebate(d.url),
    }, d.nome, el('small', {}, last ? `${last.totais.vereditos} vereditos` : 'não varrido'));
  }));
}

function render() {
  const has = !!state.scan;
  renderDebateTabs();
  renderAutoNote();
  $('empty').hidden = has;
  $('content').hidden = !has;
  $('status').hidden = !has;
  renderHistory();
  if (!has) {
    const d = debateList().find((x) => x.url === state.url);
    $('empty-title').textContent = d ? `Debate ${d.nome}: ainda não varrido` : 'Comece pela primeira varredura';
    $('page-title').textContent = d ? `Debate ${d.nome}` : 'Nenhuma varredura ainda';
    return;
  }
  $('page-title').textContent = state.scan.titulo;
  renderStatus();
  renderKpis();
  renderFilters();
  renderChart();
  renderChecks();
}

// Quando foi a última verificação (feita de hora em hora no site publicado) e se ela falhou.
function renderAutoNote() {
  const st = state.status[state.url];
  const checked = st?.verificadoEm || latestRun(state.url)?.verificadoEm;
  const link = el('a', { href: state.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir a checagem no g1 ↗');
  $('auto-note').replaceChildren(
    'Atualizado automaticamente a cada hora',
    checked ? ` · última verificação ${fmtDate(checked)}` : '',
    ' · ', link,
  );
  if (st && st.ok === false) {
    showError(`A última verificação (${fmtDate(st.verificadoEm)}) falhou: ${st.erro}. Mostrando a última varredura que deu certo.`);
    $('alert').classList.add('alert--warn');
  } else $('alert').classList.remove('alert--warn');
}

function renderStatus() {
  const s = state.scan;
  const run = latestRun(s.url);
  const latest = run?.id === s.id;
  const box = $('status');
  box.replaceChildren(...[
    el('span', { class: 'pill' }, latest ? 'Varredura mais recente' : 'Varredura antiga', ' · ', fmtDate(s.extraidoEm)),
    latest && run.verificadoEm && fmtDate(run.verificadoEm) !== fmtDate(run.extraidoEm) ? el('span', { class: 'muted' }, `sem mudanças até ${fmtDate(run.verificadoEm)}`) : null,
    el('span', {}, `${s.totais.falas} falas checadas · ${s.totais.vereditos} vereditos`),
    s.emAndamento ? el('span', { class: 'pill pill--live', title: 'A página do g1 dizia que a checagem estava em andamento' }, 'Checagem ainda em andamento no g1') : null,
    s.modificadoEm ? el('span', { class: 'muted' }, 'Página atualizada pelo g1 em ', fmtDate(s.modificadoEm)) : null,
  ].filter(Boolean));
  const m = s.mudancas;
  if (state.flash) {
    box.append(el('div', { class: 'changes' }, el('strong', {}, state.flash)));
  } else if (m) {
    const items = [
      ...(m.novas || []).map((c) => ['Nova', c]),
      ...(m.alteradas || []).map((c) => ['Mudou', c]),
      ...(m.removidas || []).map((c) => ['Saiu', c]),
    ];
    box.append(el('div', { class: 'changes' },
      el('strong', {}, items.length ? `Mudanças desde a varredura anterior (${items.length})` : 'Nada mudou desde a varredura anterior'),
      items.length ? el('ul', {}, items.map(([kind, c]) => el('li', {},
        `${kind}: ${c.candidato} · `,
        badge(c.veredito),
        c.vereditoAnterior ? ` (antes: ${verdictInfo(c.vereditoAnterior).label})` : '',
        ' — ', truncate(c.alegacao, 110)))) : null,
    ));
  }
}

function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n).trimEnd() + '…' : s; }

function badge(key) {
  const v = verdictInfo(key);
  return el('span', { class: 'badge' }, el('i', { style: `background:var(${v.color})` }), v.label.toUpperCase());
}

function renderKpis() {
  const cands = state.scan.candidatos;
  const max = Math.max(1, ...cands.flatMap((c) => VERDICTS.map((v) => c.vereditos[v.key] || 0)));
  $('kpis').replaceChildren(...cands.map((c, i) => el('article', { class: 'kpi' },
    el('div', { class: 'kpi__head' },
      el('span', { class: 'kpi__name' }, el('span', { class: 'kpi__swatch', style: `background:${candColor(i)}` }), c.nome),
      el('span', { class: 'small muted' }, c.partido)),
    el('div', { class: 'kpi__total' }, c.totalVereditos),
    el('div', { class: 'small muted' }, `vereditos em ${c.falas} falas`),
    el('ul', { class: 'kpi__rows' }, VERDICTS.map((v) => {
      const n = c.vereditos[v.key] || 0;
      return el('li', { class: 'kpi__row' },
        el('span', {}, el('span', { class: 'dot', style: `background:var(${v.color})` }), v.label),
        el('span', { class: 'meter', title: `${pct(n, c.totalVereditos)}% dos vereditos` },
          el('span', { style: `width:${(n / max) * 100}%;background:var(${v.color})` })),
        el('b', {}, n));
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
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.color = ink2;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--surface'), titleColor: cssVar('--ink'), bodyColor: ink2,
        borderColor: cssVar('--border') || axis, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
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

function setLegend(items) {
  $('legend').replaceChildren(...items.map(([label, color]) => el('span', {}, el('i', { style: `background:${color}` }), label)));
}

function renderChart() {
  document.querySelectorAll('#chart-types button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === state.chartType)));
  destroyCharts();
  const area = $('chart-area');
  area.replaceChildren();
  area.classList.toggle('is-multi', state.chartType === 'rosca' || state.chartType === 'debates');
  $('evo-toolbar').hidden = state.chartType !== 'evolucao';
  $('chart-note').textContent = '';

  const cands = state.scan.candidatos;
  const names = cands.map((c) => c.nome);
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
      area.append(el('div', { class: 'donut' }, el('h3', {}, `${c.nome} (${c.partido})`), el('div', { class: 'donut__canvas' }, canvas)));
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
    datasets = cands.map((c, i) => ({ label: c.nome, data: VERDICTS.map((v) => c.vereditos[v.key] || 0), backgroundColor: candColor(i) }));
    setLegend(cands.map((c, i) => [c.nome, candColor(i)]));
  } else {
    labels = names;
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
  if (type === 'empilhado') $('chart-note').textContent = 'Passe o mouse sobre cada parte para ver a contagem.';
  if (type === 'percentual') $('chart-note').textContent = 'Proporção de cada veredito sobre o total de vereditos do candidato.';

  const canvas = el('canvas', { role: 'img', 'aria-label': 'Gráfico de vereditos por candidato' });
  area.append(canvas);
  state.charts.push(new Chart(canvas, { type: 'bar', data: { labels, datasets }, options: opts, plugins: [valueLabels] }));
  renderDataTable();
}

function renderEvolution(area, opts) {
  const url = state.scan.url;
  const runs = state.history.filter((h) => h.url === url);
  const names = [...new Set(runs.flatMap((r) => r.candidatos.map((c) => c.nome)))];
  const metric = state.evoMetric;
  const value = (run, name) => {
    const c = run.candidatos.find((x) => x.nome === name);
    if (!c) return null;
    return metric === 'TOTAL' ? c.totalVereditos : (c.vereditos[metric] || 0);
  };
  setLegend(names.map((n, i) => [n, candColor(i)]));
  const canvas = el('canvas', { role: 'img', 'aria-label': 'Evolução dos vereditos ao longo das varreduras' });
  area.append(canvas);
  opts.interaction = { mode: 'index', intersect: false };
  opts.plugins.tooltip.callbacks = { title: (items) => 'Varredura de ' + items[0].label };
  state.charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      labels: runs.map((r) => new Date(r.extraidoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      datasets: names.map((n, i) => ({
        label: n, data: runs.map((r) => value(r, n)), borderColor: candColor(i), backgroundColor: candColor(i),
        borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: cssVar('--surface'), pointBorderWidth: 2, stepped: false, tension: 0,
      })),
    },
    options: opts,
  }));
  const label = metric === 'TOTAL' ? 'total de vereditos' : `vereditos "${verdictInfo(metric).label}"`;
  $('chart-note').textContent = runs.length < 2
    ? 'Só há uma varredura salva desta página. Uma nova entra no histórico quando o g1 muda a checagem.'
    : `Número de ${label} em cada uma das ${runs.length} varreduras desta página.`;
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
    area.append(el('div', { class: 'donut' }, el('h3', {}, name), el('div', { class: 'donut__canvas' }, canvas)));
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
      el('td', {}, n), el('td', {}, `${d.nome} (${fmtDate(d.run.extraidoEm)})`),
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
  box.replaceChildren(...list.map((c) => el('article', { class: 'check' },
    el('div', { class: 'check__meta' },
      c.vereditos.map((v) => badge(v.veredito)),
      el('span', {}, `${c.candidato} (${c.partido})`),
      el('span', { class: 'check__id' }, c.id)),
    el('blockquote', {}, c.fala),
    c.vereditos.length > 1 ? c.vereditos.map((v) => el('p', { class: 'check__sub' }, badge(v.veredito), ' ', v.descricao)) : null,
    // Versão pública não traz o texto das explicações: elas ficam na página do g1.
    c.explicacao?.length
      ? el('details', {}, el('summary', {}, 'Por quê?'), renderExplanation(c.explicacao))
      : el('a', { class: 'check__more small', href: state.scan.url, target: '_blank', rel: 'noopener noreferrer' }, 'Por quê? Leia a explicação no g1 ↗'),
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

init();
