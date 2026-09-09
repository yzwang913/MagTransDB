const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

let viewer = null;
let currentMaterial = null;

function escapeHTML(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatFormulaHTML(f) {
  if (!f) return '-';
  const esc = escapeHTML(f);
  return esc.replace(/(\d+)/g, '<sub>$1</sub>');
}

async function apiGet(path) {
  const res = await fetch(appUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderResults(list) {
  const ul = $('#resultsList');
  ul.innerHTML = '';
  list.forEach(item => {
    const li = document.createElement('li');
    const formulaHTML = formatFormulaHTML(item.reduced_formula || item.formula || '-');
    li.innerHTML = `
      <div class="item-id">${item.id}</div>
      <div class="item-sub">Formula: ${formulaHTML} | SG: ${item.space_group ?? '-'} | Primitive: ${item.has_poscar ? '✓' : '×'} | Conventional: ${item.has_bposcar ? '✓' : '×'}</div>
    `;
    li.addEventListener('click', () => loadMaterial(item.id));
    ul.appendChild(li);
  });
}

function metaText(meta) {
  const lines = [];
  lines.push(`ID: ${meta.id}`);
  if (meta.reduced_formula || meta.formula) lines.push(`Formula: ${formatFormulaHTML(meta.reduced_formula || meta.formula)}`);
  if (meta.space_group != null) lines.push(`Space group (SG): ${meta.space_group}`);
  return lines.join(' | ');
}

function updateInfoBox(poscar) {
  const box = $('#infoBox');
  if (!poscar) { box.textContent = 'Primitive cell not available'; return; }
  const { lattice, coordinate_type, atoms, title } = poscar;
  const lines = [];
  lines.push(`Title: ${title}`);
  lines.push(`Coordinate: ${coordinate_type}`);
  lines.push(`Lattice a: ${lattice.a.map(v=>v.toFixed(6)).join(' ')}`);
  lines.push(`Lattice b: ${lattice.b.map(v=>v.toFixed(6)).join(' ')}`);
  lines.push(`Lattice c: ${lattice.c.map(v=>v.toFixed(6)).join(' ')}`);
  lines.push(`Atoms: ${atoms.length}`);
  box.textContent = lines.join('\n');
}

async function loadMaterial(id) {
  try {
    const data = await apiGet(`/api/materials/${encodeURIComponent(id)}`);
    currentMaterial = data;
    $('#materialMeta').innerHTML = metaText(data.meta || { id });
    const type = document.querySelector('input[name="celltype"]:checked').value;
    const poscar = type === 'bposcar' ? data.bposcar : data.poscar;
    if (!viewer) viewer = new CrystalViewer($('#viewer'));
    viewer.build(poscar);
    updateInfoBox(poscar);
  } catch (e) {
    console.error(e);
    alert('Failed to load material');
  }
}

async function doSearch() {
  const q = $('#searchInput').value.trim();
  const data = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
  renderResults(data.results || []);
}

function setupEvents() {
  $('#searchBtn').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  $all('input[name="celltype"]').forEach(r => r.addEventListener('change', () => {
    if (!currentMaterial) return;
    const type = document.querySelector('input[name="celltype"]:checked').value;
    const poscar = type === 'bposcar' ? currentMaterial.bposcar : currentMaterial.poscar;
    if (!viewer) viewer = new CrystalViewer($('#viewer'));
    viewer.build(poscar);
    updateInfoBox(poscar);
  }));
}

async function init() {
  setupEvents();
  // initial search: show some entries
  try {
    const data = await apiGet('/api/search');
    renderResults(data.results || []);
  } catch(e) { console.error(e); }
}

init();
