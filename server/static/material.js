const $ = (sel) => document.querySelector(sel);

async function apiGet(path) {
  const res = await fetch(appUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseMatIdFromURL() {
  // support pretty path /m/<id> and query ?id=
  const path = window.location.pathname;
  const m = path.match(/\/m\/([^\/]+)/);
  if (m) return decodeURIComponent(m[1]);
  const u = new URL(window.location.href);
  return u.searchParams.get('id');
}

function escapeHTML(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatFormulaHTML(f) {
  if (!f) return '-';
  const esc = escapeHTML(f);
  return esc.replace(/(\d+)/g, '<sub>$1</sub>');
}

function len(v) { return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); }
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross(u,v){
  return [
    u[1]*v[2] - u[2]*v[1],
    u[2]*v[0] - u[0]*v[2],
    u[0]*v[1] - u[1]*v[0]
  ];
}
function deg(x){ return x*180/Math.PI; }
function angle(u,v){ return deg(Math.acos(Math.min(1, Math.max(-1, dot(u,v)/(len(u)*len(v)+1e-12))))); }

function latticeInfoHTML(poscar, meta) {
  if (!poscar) return '<div class="lattice-empty">No data</div>';
  const a = poscar.lattice.a, b = poscar.lattice.b, c = poscar.lattice.c;
  const la = len(a), lb = len(b), lc = len(c);
  const alpha = angle(b,c);
  const beta = angle(a,c);
  const gamma = angle(a,b);
  const vol = Math.abs(dot(a, cross(b,c)));
  const mpid = (meta && meta.mp_id) ? String(meta.mp_id) : '';
  const icsd = (meta && meta.icsd) ? String(meta.icsd) : '';
  const rows = [
    { label: 'a', value: `${la.toFixed(4)}`, unit: 'Å' },
    { label: 'b', value: `${lb.toFixed(4)}`, unit: 'Å' },
    { label: 'c', value: `${lc.toFixed(4)}`, unit: 'Å' },
    { label: 'α', value: `${alpha.toFixed(2)}`, unit: '°' },
    { label: 'β', value: `${beta.toFixed(2)}`, unit: '°' },
    { label: 'γ', value: `${gamma.toFixed(2)}`, unit: '°' },
    { label: 'Volume', value: `${vol.toFixed(2)}`, unit: 'Å³' },
    { label: 'Atoms', value: `${poscar.atoms.length}`, unit: '', className: 'lattice-row-muted' },
  ];
  if (mpid || icsd) {
    rows.push({ label: 'MP ID', value: mpid || '–', unit: '', className: 'lattice-row-id' });
    rows.push({ label: 'ICSD', value: icsd || '–', unit: '', className: 'lattice-row-id' });
  }
  const trs = rows.map(r => {
    const cls = r.className ? ` class="${r.className}"` : '';
    const unit = r.unit ? `<span class="lattice-unit">${escapeHTML(r.unit)}</span>` : '';
    return `<tr${cls}><td>${escapeHTML(r.label)}</td><td><span class="lattice-value">${escapeHTML(r.value)}</span>${unit}</td></tr>`;
  }).join('');
  return `<table class="lattice-table">${trs}</table>`;
}

function headerText(meta, matId) {
  const f = meta.display_formula || meta.reduced_formula || meta.formula || '-';
  const sg = meta.space_group ?? '-';
  const id = matId || meta.id || parseMatIdFromURL() || '';
  const downloadHref = id
    ? appUrl(`/api/materials/${encodeURIComponent(id)}/wannier-fermi.zip`)
    : '#';
  return `
    <span class="mat-header-title">Formula: ${formatFormulaHTML(f)} | Space group: ${escapeHTML(sg)}</span>
    <span class="mat-header-download-wrap">
      <a class="mat-header-download" href="${downloadHref}" download aria-describedby="downloadDataTip">Download data</a>
      <span class="mat-header-download-tip" id="downloadDataTip" role="tooltip">
        ZIP archive with soc/ and wosoc/ folders. Each folder contains wannier90.win, wannier90.wout, wannier90_hr.dat, and FS3D.bxsf.
      </span>
    </span>
  `;
}

let viewerCell = null;

function getCellRotationInputs(){
  const read = (id) => {
    const el = document.getElementById(id);
    const n = Number(el?.value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    x: read('cellRotX'),
    y: read('cellRotY'),
    z: read('cellRotZ'),
  };
}

function setCellRotationInputs(x = 0, y = 0, z = 0){
  const vals = { cellRotX: x, cellRotY: y, cellRotZ: z };
  Object.entries(vals).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = String(val);
  });
}

function applyCellRotationInputs(){
  const viewer = document.getElementById('viewerCell')?.__crystalViewer || viewerCell;
  if (!viewer || typeof viewer.setObjectRotationDegrees !== 'function') return;
  const rot = getCellRotationInputs();
  viewer.setObjectRotationDegrees(rot.x, rot.y, rot.z);
}
let lastData = null;

async function loadMaterial() {
  const id = parseMatIdFromURL();
  if (!id) { alert('Material ID is missing'); return; }
  try {
    const data = await apiGet(`/api/materials/${encodeURIComponent(id)}`);
    lastData = data;
    $('#materialHeader').innerHTML = headerText(data.meta || { id }, id);
    rebuildViewer(data);
  } catch (e) {
    console.error('Failed to load material:', e);
    const hdr = $('#materialHeader');
    hdr.textContent = (hdr.textContent || '') + ` | Load failed: ${e && (e.message || e)}`;
    alert('Failed to load material');
  }
}

function extractSgNumber(val) {
  if (val == null) return null;
  const m = String(val).match(/(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

function parseQuickJumpQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return { formula: '', sg: null };
  const m1 = q.match(/^(.*?)(?:\s*(?:\+|,|;|\/)\s*|\s+)(?:sg|space\s*group)?\s*#?\s*(\d{1,3})\s*$/i);
  if (m1 && m1[1].trim()) {
    return { formula: m1[1].trim(), sg: parseInt(m1[2], 10) };
  }
  const m2 = q.match(/^(.*?)(?:sg|space\s*group)\s*#?\s*(\d{1,3})\s*$/i);
  if (m2 && m2[1].trim()) {
    return { formula: m2[1].trim(), sg: parseInt(m2[2], 10) };
  }
  return { formula: q, sg: null };
}

function collectFormulaSuggestions(results) {
  const out = [];
  const seen = new Set();
  (Array.isArray(results) ? results : []).forEach((rec) => {
    const f = (rec?.display_formula || rec?.reduced_formula || rec?.formula || '').trim();
    if (!f) return;
    const sg = extractSgNumber(rec?.space_group);
    const text = Number.isFinite(sg) ? `${f} ${sg}` : f;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      value: text,
      formula: f,
      sg,
    });
  });
  return out;
}

function renderQuickJumpMenu(menuEl, suggestions, activeIndex = -1) {
  if (!menuEl) return;
  menuEl.innerHTML = '';
  if (!Array.isArray(suggestions) || !suggestions.length) {
    menuEl.classList.add('is-hidden');
    return;
  }
  suggestions.forEach((item, idx) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `quick-search-option${idx === activeIndex ? ' is-active' : ''}`;
    row.dataset.index = String(idx);
    row.innerHTML = `
      <span class="quick-search-option-formula">${escapeHTML(item.formula)}</span>
      <span class="quick-search-option-sg">${Number.isFinite(item.sg) ? `SG ${item.sg}` : 'SG -'}</span>
    `;
    menuEl.appendChild(row);
  });
  menuEl.classList.remove('is-hidden');
}

async function fetchQuickJumpResults(query, perPage) {
  const basePath = `/api/search?q=${encodeURIComponent(query)}&sort=formula&per_page=${perPage}`;
  const primary = await apiGet(basePath);
  const primaryResults = Array.isArray(primary?.results) ? primary.results : [];
  if (primaryResults.length) {
    return { data: primary, mode: 'formula' };
  }
  const fallback = await apiGet(`${basePath}&mode=at_least_elements`);
  return { data: fallback, mode: 'at_least_elements' };
}

function setupQuickJump() {
  const inputEl = document.getElementById('quickSearch');
  const btnEl = document.getElementById('quickBtn');
  const menuEl = document.getElementById('quickSearchMenu');
  if (!inputEl || !btnEl) return;
  inputEl.value = '';
  let currentSuggestions = [];
  let activeSuggestion = -1;

  const closeMenu = () => {
    activeSuggestion = -1;
    if (menuEl) menuEl.classList.add('is-hidden');
  };

  const applySuggestion = (item) => {
    if (!item) return;
    inputEl.value = item.value;
    closeMenu();
  };

  const go = async () => {
    const q = inputEl.value.trim();
    if (!q) return;
    const parsed = parseQuickJumpQuery(q);
    const formulaQ = parsed.formula || q;
    try {
      const { data } = await fetchQuickJumpResults(formulaQ, 500);
      const results = data.results || [];
      const canonical = data.canonical;
      const exactFormula = canonical
        ? results.filter((x) => (x.reduced_formula || x.formula) === canonical)
        : [];
      const scope = exactFormula.length ? exactFormula : results;

      let target = null;
      if (Number.isFinite(parsed.sg)) {
        target = scope.find((x) => extractSgNumber(x.space_group) === parsed.sg)
          || results.find((x) => extractSgNumber(x.space_group) === parsed.sg);
      }
      if (!target) target = scope[0] || results[0] || null;
      if (target) {
        inputEl.value = '';
        window.location.href = appUrl(`/m/${encodeURIComponent(target.id)}`);
      }
    } catch(e){ }
  };

  let suggestTimer = null;
  let suggestSeq = 0;
  const updateSuggestions = async () => {
    if (!menuEl) return;
    const q = inputEl.value.trim();
    const parsed = parseQuickJumpQuery(q);
    const formulaQ = (parsed.formula || '').trim();
    if (!formulaQ) {
      currentSuggestions = [];
      activeSuggestion = -1;
      renderQuickJumpMenu(menuEl, []);
      return;
    }
    const seq = ++suggestSeq;
    try {
      const { data } = await fetchQuickJumpResults(formulaQ, 120);
      if (seq !== suggestSeq) return;
      currentSuggestions = collectFormulaSuggestions(data.results || []).slice(0, 30);
      activeSuggestion = currentSuggestions.length ? 0 : -1;
      renderQuickJumpMenu(menuEl, currentSuggestions, activeSuggestion);
    } catch (e) {
      if (seq === suggestSeq) {
        currentSuggestions = [];
        activeSuggestion = -1;
        renderQuickJumpMenu(menuEl, []);
      }
    }
  };

  btnEl.addEventListener('click', go);
  inputEl.addEventListener('keydown', (e)=>{
    if (e.key === 'ArrowDown' && currentSuggestions.length) {
      e.preventDefault();
      activeSuggestion = Math.min(currentSuggestions.length - 1, activeSuggestion + 1);
      renderQuickJumpMenu(menuEl, currentSuggestions, activeSuggestion);
      return;
    }
    if (e.key === 'ArrowUp' && currentSuggestions.length) {
      e.preventDefault();
      activeSuggestion = Math.max(0, activeSuggestion - 1);
      renderQuickJumpMenu(menuEl, currentSuggestions, activeSuggestion);
      return;
    }
    if (e.key === 'Enter') {
      if (activeSuggestion >= 0 && currentSuggestions[activeSuggestion]) {
        e.preventDefault();
        applySuggestion(currentSuggestions[activeSuggestion]);
      } else {
        go();
      }
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
    }
  });
  inputEl.addEventListener('input', () => {
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(updateSuggestions, 120);
  });
  inputEl.addEventListener('focus', () => {
    if (inputEl.value.trim()) updateSuggestions();
  });
  inputEl.addEventListener('blur', () => {
    window.setTimeout(closeMenu, 120);
  });
  if (menuEl) {
    menuEl.addEventListener('mousedown', (e) => {
      const option = e.target.closest('.quick-search-option');
      if (!option) return;
      e.preventDefault();
      const idx = Number(option.dataset.index);
      applySuggestion(currentSuggestions[idx]);
    });
  }
}

function rebuildViewer(data){
  const type = document.getElementById('cellType')?.value === 'conventional' ? 'conventional' : 'primitive';
  const size = parseInt(document.getElementById('cellSize')?.value, 10) || 1;
  const showBonds = document.getElementById('cellShowBonds')?.checked ?? true;
  const cell = type === 'conventional' ? data.bposcar : data.poscar;
  const titleEl = document.getElementById('cellViewerTitle');
  if (titleEl) titleEl.textContent = 'Structure';
  if (!viewerCell) viewerCell = new CrystalViewer($('#viewerCell'));
  // Keep both Primitive/Conventional in the same MP-like visual style.
  const mpLike = (type === 'conventional' || type === 'primitive');
  if (!cell) {
    viewerCell.clear();
    const infoEl = document.getElementById('cellInfo');
    if (infoEl) infoEl.innerHTML = '<div class="lattice-empty">No structure data</div>';
    const host = document.querySelector('#viewerCell');
    if (host) host.setAttribute('aria-label', 'No structure data');
    return;
  }
  viewerCell.build(cell, {
    supercell: [size, size, size],
    showBonds,
    showCell: true,
    showCellFaces: true,
    completeBoundaryAtoms: true,
    boundaryAtomEps: 5e-3,
    // Keep MP-like clean structure while retaining crystallographic a/b/c gizmo.
    showAxes: true,
    backgroundColor: 0xffffff,
    atomRadius: mpLike ? 0.28 : 0.26,
    atomMetalness: 0.58,
    atomRoughness: 0.22,
    bondRadius: mpLike ? 0.045 : 0.06,
    bondColor: mpLike ? 0x111111 : 0xbbc0c5,
    bondFactor: mpLike ? 1.08 : 1.15,
    bondMaxCut: mpLike ? 3.0 : 3.2,
    bondMetalness: 0.15,
    bondRoughness: 0.48,
    cellFaceColor: 0xf2d2b6,
    cellFaceOpacity: 0.18,
    cellEdgeColor: 0x111111,
    cellEdgeOpacity: 0.95,
    initialZoom: mpLike ? 0.82 : 0.78,
  });
  applyCellRotationInputs();
  updateLegendFor('#viewerCell', viewerCell, cell);
  const infoEl = document.getElementById('cellInfo');
  if (infoEl) infoEl.innerHTML = latticeInfoHTML(cell, data.meta || {});
  // expose for MR module to reuse
  window.viewerPOS = viewerCell;
  window.viewerBPOS = viewerCell;
}

function updateLegendFor(viewerSelector, viewer, poscar){
  const host = document.querySelector(viewerSelector);
  if (!host) return;
  const wrap = host.closest('.viewer-wrap') || host.parentElement;
  if (!wrap) return;
  let box = wrap.querySelector('.legend');
  if (!box){
    box = document.createElement('div');
    box.className = 'legend';
    wrap.appendChild(box);
  }
  const elements = Array.from(new Set((poscar?.atoms || []).map(a => a.element))).sort();
  const rows = elements.map(el => {
    const color = viewer.colorForElement(el);
    const hex = '#' + (color >>> 0).toString(16).padStart(6, '0');
    return `<div class="legend-row"><span class="legend-dot" style="background:${hex}"></span><span>${el}</span></div>`;
  }).join('');
  box.innerHTML = rows || '<div class="legend-row">No elements</div>';
}

function setupViewerControls(data){
  ['cellType','cellSize','cellShowBonds'].forEach(id =>{
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', ()=> rebuildViewer(data));
  });

  const applyRot = document.getElementById('cellApplyRotation');
  if (applyRot && !applyRot.dataset.bound) {
    applyRot.dataset.bound = '1';
    applyRot.addEventListener('click', applyCellRotationInputs);
  }
  const resetRot = document.getElementById('cellResetRotation');
  if (resetRot && !resetRot.dataset.bound) {
    resetRot.dataset.bound = '1';
    resetRot.addEventListener('click', () => {
      setCellRotationInputs(0, 0, 0);
      applyCellRotationInputs();
    });
  }
  ['cellRotX','cellRotY','cellRotZ'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyCellRotationInputs();
    });
  });

  const dl = document.getElementById('cellDownloadPoscar');
  if (dl && !dl.dataset.bound) {
    dl.dataset.bound = '1';
    dl.addEventListener('click', () => {
      const id = parseMatIdFromURL();
      if (!id) return;
      const type = document.getElementById('cellType')?.value === 'conventional' ? 'conventional' : 'primitive';
      const url = appUrl(`/api/materials/${encodeURIComponent(id)}/poscar?type=${encodeURIComponent(type)}`);
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  const dlSvg = document.getElementById('cellDownloadSvg');
  if (dlSvg && !dlSvg.dataset.bound) {
    dlSvg.dataset.bound = '1';
    dlSvg.addEventListener('click', () => {
      const viewer = document.getElementById('viewerCell')?.__crystalViewer || viewerCell;
      if (!viewer || typeof viewer.exportSVG !== 'function') return;
      const id = parseMatIdFromURL() || 'material';
      const type = document.getElementById('cellType')?.value === 'conventional' ? 'conventional' : 'primitive';
      const svg = viewer.exportSVG();
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}_${type}_cell.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
}

// Hook rebuild after data load by monkey-patching loadMaterial to call setupViewerControls
loadMaterial = async function(){
  const id = parseMatIdFromURL();
  if (!id) { alert('Material ID is missing'); return; }
  try {
    const data = await apiGet(`/api/materials/${encodeURIComponent(id)}`);
    lastData = data;
    $('#materialHeader').innerHTML = headerText(data.meta || { id }, id);
    setupViewerControls(data);
    rebuildViewer(data);
  } catch(e){
    console.error('Failed to load material:', e);
    const hdr = $('#materialHeader');
    hdr.textContent = (hdr.textContent || '') + ` | Load failed: ${e && (e.message || e)}`;
    alert('Failed to load material');
  }
}

setupQuickJump();
loadMaterial();
