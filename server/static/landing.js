const $ = (sel) => document.querySelector(sel);
let currentMode = 'at_least_elements';
const searchState = { q: '', page: 1, perPage: 15, total: 0 };

async function apiGet(path) {
  const res = await fetch(appUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function toMaterialURL(id) {
  // pretty path served by Flask route /m/<id>
  return appUrl(`/m/${encodeURIComponent(id)}`);
}

function escapeHTML(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SPACE_GROUP_SYMBOLS = 'P1|P-1|P2|P2_1|C2|Pm|Pc|Cm|Cc|P2/m|P2_1/m|C2/m|P2/c|P2_1/c|C2/c|P222|P222_1|P2_12_12|P2_12_12_1|C222_1|C222|F222|I222|I2_12_12_1|Pmm2|Pmc2_1|Pcc2|Pma2|Pca2_1|Pnc2|Pmn2_1|Pba2|Pna2_1|Pnn2|Cmm2|Cmc2_1|Ccc2|Amm2|Aem2|Ama2|Aea2|Fmm2|Fdd2|Imm2|Iba2|Ima2|Pmmm|Pnnn|Pccm|Pban|Pmma|Pnna|Pmna|Pcca|Pbam|Pccn|Pbcm|Pnnm|Pmmn|Pbcn|Pbca|Pnma|Cmcm|Cmce|Cmmm|Cccm|Cmme|Ccce|Fmmm|Fddd|Immm|Ibam|Ibca|Imma|P4|P4_1|P4_2|P4_3|I4|I4_1|P-4|I-4|P4/m|P4_2/m|P4/n|P4_2/n|I4/m|I4_1/a|P422|P42_12|P4_122|P4_12_12|P4_222|P4_22_12|P4_322|P4_32_12|I422|I4_122|P4mm|P4bm|P4_2cm|P4_2nm|P4cc|P4nc|P4_2mc|P4_2bc|I4mm|I4cm|I4_1md|I4_1cd|P-42m|P-42c|P-42_1m|P-42_1c|P-4m2|P-4c2|P-4b2|P-4n2|I-4m2|I-4c2|I-42m|I-42d|P4/mmm|P4/mcc|P4/nbm|P4/nnc|P4/mbm|P4/mnc|P4/nmm|P4/ncc|P4_2/mmc|P4_2/mcm|P4_2/nbc|P4_2/nnm|P4_2/mbc|P4_2/mnm|P4_2/nmc|P4_2/ncm|I4/mmm|I4/mcm|I4_1/amd|I4_1/acd|P3|P3_1|P3_2|R3|P-3|R-3|P312|P321|P3_112|P3_121|P3_212|P3_221|R32|P3m1|P31m|P3c1|P31c|R3m|R3c|P-31m|P-31c|P-3m1|P-3c1|R-3m|R-3c|P6|P6_1|P6_5|P6_2|P6_4|P6_3|P-6|P6/m|P6_3/m|P622|P6_122|P6_522|P6_222|P6_422|P6_322|P6mm|P6cc|P6_3cm|P6_3mc|P-6m2|P-6c2|P-62m|P-62c|P6/mmm|P6/mcc|P6_3/mcm|P6_3/mmc|P23|F23|I23|P2_13|I2_13|Pm-3|Pn-3|Fm-3|Fd-3|Im-3|Pa-3|Ia-3|P432|P4_232|F432|F4_132|I432|P4_332|P4_132|I4_132|P-43m|F-43m|I-43m|P-43n|F-43c|I-43d|Pm-3m|Pn-3n|Pm-3n|Pn-3m|Fm-3m|Fm-3c|Fd-3m|Fd-3c|Im-3m|Ia-3d'.split('|');

function formatHmSymbolHTML(symbol) {
  return escapeHTML(symbol).replace(/_([0-9]+)/g, '<sub>$1</sub>');
}

function formatSpaceGroupHTML(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-') return '-';
  const match = raw.match(/\d{1,3}/);
  const num = match ? parseInt(match[0], 10) : NaN;
  const symbol = Number.isFinite(num) ? SPACE_GROUP_SYMBOLS[num - 1] : '';
  return symbol ? `${formatHmSymbolHTML(symbol)} (${num})` : escapeHTML(raw);
}

// ---------- Periodic table helpers ----------

// 9x18 periodic table layout (empty string = gap)
const PT_LAYOUT = [
  // 1st period
  ["H",  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "He"],
  // 2nd period
  ["Li", "Be", "", "", "", "", "", "", "", "", "", "", "B",  "C",  "N",  "O",  "F",  "Ne"],
  // 3rd period
  ["Na", "Mg", "", "", "", "", "", "", "", "", "", "", "Al", "Si", "P",  "S",  "Cl", "Ar"],
  // 4th period
  ["K",  "Ca", "Sc", "Ti", "V",  "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr"],
  // 5th period
  ["Rb", "Sr", "Y",  "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I",  "Xe"],
  // 6th period main row (with La–Lu placeholder)
  ["Cs", "Ba", "La-Lu", "Hf", "Ta", "W",  "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn"],
  // 7th period main row (with Ac–Lr placeholder)
  ["Fr", "Ra", "Ac-Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"],
  // Lanthanoids
  ["", "", "", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu"],
  // Actinoids
  ["", "", "", "Ac", "Th", "Pa", "U",  "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr"],
];

// category per element for color coding
const PT_CATEGORY = {
  // Alkali metals
  Li: 'alkali', Na: 'alkali', K: 'alkali', Rb: 'alkali', Cs: 'alkali', Fr: 'alkali',
  // Alkaline earth metals
  Be: 'alkaline', Mg: 'alkaline', Ca: 'alkaline', Sr: 'alkaline', Ba: 'alkaline', Ra: 'alkaline',
  // Transition metals (d-block + some heavier)
  Sc: 'transition', Ti: 'transition', V: 'transition', Cr: 'transition', Mn: 'transition', Fe: 'transition',
  Co: 'transition', Ni: 'transition', Cu: 'transition', Zn: 'transition',
  Y: 'transition', Zr: 'transition', Nb: 'transition', Mo: 'transition', Tc: 'transition', Ru: 'transition',
  Rh: 'transition', Pd: 'transition', Ag: 'transition', Cd: 'transition',
  Hf: 'transition', Ta: 'transition', W: 'transition', Re: 'transition', Os: 'transition', Ir: 'transition',
  Pt: 'transition', Au: 'transition', Hg: 'transition',
  Rf: 'transition', Db: 'transition', Sg: 'transition', Bh: 'transition', Hs: 'transition',
  Mt: 'transition', Ds: 'transition', Rg: 'transition', Cn: 'transition',
  // Lanthanoids
  La: 'lanthanoid', Ce: 'lanthanoid', Pr: 'lanthanoid', Nd: 'lanthanoid', Pm: 'lanthanoid',
  Sm: 'lanthanoid', Eu: 'lanthanoid', Gd: 'lanthanoid', Tb: 'lanthanoid', Dy: 'lanthanoid',
  Ho: 'lanthanoid', Er: 'lanthanoid', Tm: 'lanthanoid', Yb: 'lanthanoid', Lu: 'lanthanoid',
  // Actinoids
  Ac: 'actinoid', Th: 'actinoid', Pa: 'actinoid', U: 'actinoid', Np: 'actinoid', Pu: 'actinoid',
  Am: 'actinoid', Cm: 'actinoid', Bk: 'actinoid', Cf: 'actinoid', Es: 'actinoid', Fm: 'actinoid',
  Md: 'actinoid', No: 'actinoid', Lr: 'actinoid',
  // Metalloids (semi-metals)
  B: 'metalloid', Si: 'metalloid', Ge: 'metalloid', As: 'metalloid', Sb: 'metalloid', Te: 'metalloid',
  // Post-transition metals
  Al: 'post', Ga: 'post', In: 'post', Sn: 'post', Tl: 'post', Pb: 'post', Bi: 'post', Po: 'post',
  Nh: 'post', Fl: 'post', Mc: 'post', Lv: 'post',
  // Nonmetals
  H: 'nonmetal', C: 'nonmetal', N: 'nonmetal', O: 'nonmetal', P: 'nonmetal', S: 'nonmetal', Se: 'nonmetal',
  // Halogens
  F: 'halogen', Cl: 'halogen', Br: 'halogen', I: 'halogen', At: 'halogen', Ts: 'halogen',
  // Noble gases
  He: 'noble', Ne: 'noble', Ar: 'noble', Kr: 'noble', Xe: 'noble', Rn: 'noble', Og: 'noble',
};

const ptSelected = new Set();

function buildPeriodicTable() {
  const grid = document.getElementById('ptGrid');
  if (!grid) return;
  grid.innerHTML = '';
  PT_LAYOUT.forEach((row) => {
    row.forEach((sym) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (!sym) {
        btn.className = 'pt-el pt-empty';
        grid.appendChild(btn);
        return;
      }
      // special placeholders for f-block
      if (sym === 'La-Lu' || sym === 'Ac-Lr') {
        btn.className = 'pt-el pt-placeholder ' + (sym === 'La-Lu' ? 'pt-placeholder-lan' : 'pt-placeholder-act');
        btn.textContent = sym;
        btn.disabled = true;
        grid.appendChild(btn);
        return;
      }

      btn.className = 'pt-el';
      btn.textContent = sym;
      btn.dataset.el = sym;
      const cat = PT_CATEGORY[sym];
      if (cat) btn.classList.add(`pt-cat-${cat}`);
      btn.addEventListener('click', () => toggleElement(sym, btn));
      grid.appendChild(btn);
    });
  });
}

function updateFromSelection() {
  const input = $('#searchInput');
  const label = $('#ptSelected');
  if (!input || !label) return;
  if (!ptSelected.size) {
    label.textContent = 'Selected elements: \u2013';
    input.value = '';
    updateHighlights();
    return;
  }
  const list = Array.from(ptSelected);
  list.sort(); // alphabetical order, matches backend canonicalization
  const delim = currentMode === 'only_elements' ? '-' : (currentMode === 'at_least_elements' ? ',' : '');
  const formula = list.join(delim);
  input.value = formula;
  label.textContent = `Selected elements: ${list.join(', ')}`;
  updateHighlights();
}

function toggleElement(sym, btn) {
  if (ptSelected.has(sym)) {
    ptSelected.delete(sym);
    btn.classList.remove('pt-selected');
  } else {
    ptSelected.add(sym);
    btn.classList.add('pt-selected');
  }
  updateFromSelection();
  updateHighlights();
  // 元素选择变化后立即刷新材料列表（无需再手动点 Search）
  searchState.page = 1;
  doSearch();
}

// ---------- Search ----------

async function doSearch() {
  const q = $('#searchInput').value.trim();
  const page = searchState.page || 1;
  const perPage = searchState.perPage || 15;
  try {
    const params = new URLSearchParams();
    params.set('q', q);
    if (currentMode && currentMode !== 'formula') {
      params.set('mode', currentMode);
    }
    params.set('page', String(page));
    params.set('per_page', String(perPage));
    const data = await apiGet(`/api/search?${params.toString()}`);
    const results = data.results || [];
    const canonical = data.canonical;
    const exact = results.filter(r => (r.reduced_formula || r.formula) === canonical);

    searchState.q = q;
    searchState.page = data.page || page;
    searchState.perPage = data.per_page || perPage;
    searchState.total = data.total || results.length;

    // 只有在 Formula 模式下才自动跳转；元素模式始终展示列表
    if (q && currentMode === 'formula' && exact.length === 1) {
      window.location.href = toMaterialURL(exact[0].id);
      return;
    }
    // reorder: exact matches first, then others
    const others = results.filter(r => (r.reduced_formula || r.formula) !== canonical);
    const ordered = [...exact, ...others];
    renderSuggest(ordered, searchState);
  } catch (e) {
    renderSuggest([], searchState);
  }
}

function renderSuggest(list, state = { page: 1, perPage: 15, total: 0 }) {
  const shell = $('#resultsShell');
  if (!shell) return;
  shell.innerHTML = '';

  if (!list.length) {
    const div = document.createElement('div');
    div.className = 'results-shell-empty';
    div.textContent = 'No matching materials';
    shell.appendChild(div);
    return;
  }

  const table = document.createElement('table');
  table.className = 'results-table';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th style="width:36%;">Formula</th>
      <th style="width:18%;">Space group</th>
      <th style="width:23%;">MP ID</th>
      <th style="width:23%;">ICSD</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  list.forEach(item => {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    const formula = item.display_formula || item.reduced_formula || item.formula || '-';
    const sg = formatSpaceGroupHTML(item.space_group);
    const mpid = item.mp_id || '';
    const icsd = item.icsd || '';
    tr.innerHTML = `
      <td class="col-formula">${formula}</td>
      <td>${sg}</td>
      <td class="col-id">${mpid || '\u2013'}</td>
      <td>${icsd || '\u2013'}</td>
    `;
    tr.addEventListener('click', () => {
      window.location.href = toMaterialURL(item.id);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  shell.appendChild(table);

  const total = state.total || list.length;
  const page = state.page || 1;
  const perPage = state.perPage || list.length;
  if (total > perPage) {
    const totalPages = Math.ceil(total / perPage);

    const nav = document.createElement('div');
    nav.className = 'results-nav pager';
    const addBtn = (label, disabled, handler, isActive=false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (disabled) b.disabled = true;
      if (isActive) b.classList.add('active');
      if (!disabled && handler) b.addEventListener('click', handler);
      return b;
    };

    // Previous
    nav.appendChild(addBtn('Previous', page <= 1, () => {
      searchState.page = page - 1;
      doSearch();
    }));

    const windowSize = 3;
    const pages = [];
    pages.push(1);
    const start = Math.max(2, page - windowSize);
    const end = Math.min(totalPages - 1, page + windowSize);
    for (let p = start; p <= end; p++) pages.push(p);
    if (totalPages > 1) pages.push(totalPages);

    let last = 0;
    pages.forEach(p => {
      if (p - last > 1) {
        const gap = document.createElement('span');
        gap.className = 'pager-gap';
        gap.textContent = '…';
        nav.appendChild(gap);
      }
      nav.appendChild(addBtn(String(p), false, () => {
        searchState.page = p;
        doSearch();
      }, p === page));
      last = p;
    });

    // Next
    nav.appendChild(addBtn('Next', page >= totalPages, () => {
      searchState.page = page + 1;
      doSearch();
    }));

    // meta + jump
    const meta = document.createElement('div');
    meta.className = 'results-meta';
    meta.textContent = `Total: ${total}`;
    const jump = document.createElement('div');
    jump.className = 'jump-wrap';
    jump.innerHTML = `Jump to <input type="number" min="1" max="${totalPages}" value="${page}" /> / ${totalPages}`;
    const jumpInput = jump.querySelector('input');
    if (jumpInput) {
      jumpInput.addEventListener('change', () => {
        let p = parseInt(jumpInput.value, 10);
        if (isNaN(p) || p < 1) p = 1;
        if (p > totalPages) p = totalPages;
        searchState.page = p;
        doSearch();
      });
    }
    const navRow = document.createElement('div');
    navRow.className = 'results-nav-row';
    navRow.appendChild(meta);
    navRow.appendChild(nav);
    navRow.appendChild(jump);
    shell.appendChild(navRow);
  }
}

function setup() {
  const input = $('#searchInput');
  if (input) input.value = '';
  const shell = $('#resultsShell');
  if (shell) shell.innerHTML = '';
  ptSelected.clear();
  updateFromSelection();
  updateHighlights();

  $('#searchBtn').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  $('#searchInput').addEventListener('input', () => {
    syncSelectionFromInput();
  });

  const modeButtons = Array.from(document.querySelectorAll('.mode-btn'));
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode') || 'formula';
      currentMode = mode;
      searchState.page = 1;
      modeButtons.forEach(b => b.classList.toggle('active', b === btn));
      // 更新 placeholder，提示当前模式
      const input = $('#searchInput');
      if (!input) return;
      if (mode === 'only_elements') {
        input.placeholder = 'Elements only, e.g. Ag-F';
      } else if (mode === 'at_least_elements') {
        input.placeholder = 'At least elements, e.g. Ag or Ag,F';
      } else {
        input.placeholder = 'Search formula (press Enter)';
      }
      // 根据当前模式调整输入内容的连接符
      updateFromSelection();
      updateHighlights();
      doSearch();
    });
  });
  // set initial active state/placeholder according to currentMode
  modeButtons.forEach(b => b.classList.toggle('active', (b.getAttribute('data-mode') || '') === currentMode));
  if (input) {
    if (currentMode === 'only_elements') {
      input.placeholder = 'Elements only, e.g. Ag-F';
    } else if (currentMode === 'at_least_elements') {
      input.placeholder = 'At least elements, e.g. Ag or Ag,F';
    } else {
      input.placeholder = 'Search formula (press Enter)';
    }
  }
  updateFromSelection();
  doSearch();
}

setup();
buildPeriodicTable();

function syncSelectionFromInput() {
  const input = $('#searchInput');
  if (!input) return;
  const val = (input.value || '').trim();
  // parse by current delimiter
  const delim = currentMode === 'only_elements' ? /-/ : (currentMode === 'at_least_elements' ? /,/ : /,/);
  const tokens = val ? val.split(delim) : [];
  ptSelected.clear();
  const gridButtons = document.querySelectorAll('.pt-el');
  gridButtons.forEach(btn => btn.classList.remove('pt-selected'));
  tokens.forEach(tok => {
    const el = tok.trim();
    if (!el) return;
    ptSelected.add(el);
    const btn = document.querySelector(`.pt-el[data-el="${el}"]`);
    if (btn) btn.classList.add('pt-selected');
  });
  const label = $('#ptSelected');
  if (label) {
    if (!ptSelected.size) label.textContent = 'Selected elements: –';
    else label.textContent = `Selected elements: ${Array.from(ptSelected).sort().join(', ')}`;
  }
  updateHighlights();
}
async function updateHighlights() {
  const els = Array.from(ptSelected);
  const gridButtons = document.querySelectorAll('.pt-el');
  gridButtons.forEach(b => b.classList.remove('pt-dim', 'pt-highlight'));
  if (!els.length) return;
  const mode = currentMode || 'at_least_elements';
  try {
    const params = new URLSearchParams();
    params.set('elements', els.join(','));
    params.set('mode', mode);
    const res = await fetch(appUrl(`/api/element_candidates?${params.toString()}`));
    const data = await res.json();
    const allowed = new Set(data.elements || els);
    gridButtons.forEach(btn => {
      const el = btn.dataset.el;
      if (!el) return;
      if (allowed.has(el)) {
        btn.classList.add('pt-highlight');
      } else {
        btn.classList.add('pt-dim');
      }
    });
  } catch {
    // on error, do nothing
  }
}
