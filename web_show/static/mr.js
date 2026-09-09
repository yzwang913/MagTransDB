// Minimal MR data UI + plotting
(() => {
  const $ = (sel) => document.querySelector(sel);

  // Match matplotlib tab10 used by rho_vs_angle.sh
  const COLOR_PALETTE = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];
  const bzViewerState = new WeakMap();

  function renderRhoSubHTML(component) {
    const sub = String(component || 'xx');
    return `<span class="rho-math"><span class="rho">ρ</span><sub>${sub}</sub></span>`;
  }

  function setupPrettySelect(selectEl, triggerEl, menuEl) {
    if (!selectEl || !triggerEl || !menuEl) return;
    const wrap = triggerEl.closest('.pretty-select-wrap');
    if (!wrap) return;

    const rebuild = () => {
      menuEl.innerHTML = '';
      Array.from(selectEl.options || []).forEach((opt) => {
        const item = document.createElement('div');
        item.className = 'pretty-select-item';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        item.innerHTML = renderRhoSubHTML(opt.value);
        item.setAttribute('aria-selected', opt.value === selectEl.value ? 'true' : 'false');
        item.addEventListener('click', () => {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          wrap.classList.remove('open');
          triggerEl.setAttribute('aria-expanded', 'false');
          updateTrigger();
        });
        menuEl.appendChild(item);
      });
    };

    const updateTrigger = () => {
      triggerEl.innerHTML = renderRhoSubHTML(selectEl.value);
      Array.from(menuEl.children).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        el.setAttribute('aria-selected', el.dataset.value === selectEl.value ? 'true' : 'false');
      });
    };

    const close = () => {
      wrap.classList.remove('open');
      triggerEl.setAttribute('aria-expanded', 'false');
    };

    triggerEl.addEventListener('click', (e) => {
      e.preventDefault();
      const open = wrap.classList.toggle('open');
      triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) rebuild();
      updateTrigger();
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
    selectEl.addEventListener('change', updateTrigger);

    rebuild();
    updateTrigger();
  }

  function matId() {
    const path = window.location.pathname;
    const m = path.match(/\/m\/([^\/]+)/);
    if (m) return decodeURIComponent(m[1]);
    const u = new URL(window.location.href);
    return u.searchParams.get('id');
  }

  async function apiGet(path) {
    const res = await fetch(appUrl(path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setHint(msg) {
    const el = $('#mrHint');
    if (el) el.textContent = msg || '';
  }

  function showBlock(show) {
    const blk = $('#mrBlock');
    if (blk) blk.style.display = show ? 'block' : 'none';
  }

  function setPolarHint(msg) {
    const el = $('#mrPolarHint');
    if (el) el.textContent = msg || '';
  }

  function showPolarBlock(show) {
    const blk = $('#mrPolarBlock');
    if (blk) blk.style.display = show ? 'block' : 'none';
  }
  function showFourierBlock(show) {
    const blk = $('#mrFourierBlock');
    if (blk) blk.style.display = show ? 'block' : 'none';
  }
  let __mjQueue = Promise.resolve();
  function typesetMath(el) {
    if (!el || !window.MathJax || typeof window.MathJax.typesetPromise !== 'function') return;
    __mjQueue = __mjQueue
      .then(() => window.MathJax.typesetPromise([el]))
      .catch(() => {});
  }

  const formatAngleLabel = (theta, phi) => `B\u03b8=${theta.toFixed(2)}°, B\u03d5=${phi.toFixed(2)}°`;

  function optionize(select, list, toText = (x) => String(x), toValue = (x) => String(x)) {
    select.innerHTML = '';
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = toValue(item);
      opt.textContent = toText(item);
      select.appendChild(opt);
    });
  }

  const SURFACE_LABEL = {
    'Ra_Rb_surface': 'ab plane',
    'Rb_Rc_surface': 'bc plane',
    'Rc_Ra_surface': 'ca plane',
  };
  const prettySurface = (s) => SURFACE_LABEL[s] || s;

  function buildLabelTokens(label, opts = {}) {
    const baseSize = opts.baseSize ?? 13;
    const subSize = opts.subSize ?? 10;
    const dySub = opts.dySub ?? 4;
    const separatorGap = opts.separatorGap ?? 6;
    const parts = String(label || '').split('|');
    const tokens = [];
    parts.forEach((part, idx) => {
      if (idx > 0) tokens.push({ text: '|', size: baseSize, dy: 0, gap: separatorGap });
      const seg = part.trim();
      if (!seg) return;
      const us = seg.indexOf('_');
      if (us === -1) {
        tokens.push({ text: seg, size: baseSize, dy: 0 });
        return;
      }
      const head = seg.slice(0, us);
      const sub = seg.slice(us + 1);
      if (head) tokens.push({ text: head, size: baseSize, dy: 0 });
      if (sub) tokens.push({ text: sub, size: subSize, dy: dySub });
    });
    return tokens;
  }

  function measureLabelTokens(ctx, tokens) {
    let total = 0;
    tokens.forEach(t => {
      ctx.font = `${t.size}px Georgia, "Times New Roman", serif`;
      total += ctx.measureText(t.text).width + (t.gap || 0);
    });
    return total;
  }

  function drawLabelTokens(ctx, tokens, x, y, opts = {}) {
    const total = measureLabelTokens(ctx, tokens);
    let cursor = x - total / 2;
    const doStroke = !!opts.strokeStyle;
    const prevAlign = ctx.textAlign;
    tokens.forEach(t => {
      ctx.font = `${t.size}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'left';
      if (doStroke) {
        ctx.lineWidth = opts.lineWidth ?? 0;
        ctx.strokeStyle = opts.strokeStyle;
        ctx.strokeText(t.text, cursor, y + t.dy);
      }
      if (opts.fillStyle) ctx.fillStyle = opts.fillStyle;
      ctx.fillText(t.text, cursor, y + t.dy);
      cursor += ctx.measureText(t.text).width + (t.gap || 0);
    });
    ctx.textAlign = prevAlign;
  }

  function drawLabelTokensFrom(ctx, tokens, x, y, opts = {}) {
    let cursor = x;
    const doStroke = !!opts.strokeStyle;
    const prevAlign = ctx.textAlign;
    tokens.forEach(t => {
      ctx.font = `${t.size}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'left';
      if (doStroke) {
        ctx.lineWidth = opts.lineWidth ?? 0;
        ctx.strokeStyle = opts.strokeStyle;
        ctx.strokeText(t.text, cursor, y + t.dy);
      }
      if (opts.fillStyle) ctx.fillStyle = opts.fillStyle;
      ctx.fillText(t.text, cursor, y + t.dy);
      cursor += ctx.measureText(t.text).width + (t.gap || 0);
    });
    ctx.textAlign = prevAlign;
  }

  function drawLabelWithSubscript(ctx, label, x, y) {
    const tokens = buildLabelTokens(label, {
      baseSize: 13,
      subSize: 10,
      dySub: 4,
      separatorGap: 6,
    });
    if (!tokens.length) return;
    drawLabelTokens(ctx, tokens, x, y, { fillStyle: ctx.fillStyle });
  }

  function drawBandTickLabel(ctx, label, x, y) {
    const nice = String(label || '').replace(/\\Gamma|\\\\Gamma|Gamma/g, 'Γ');
    if (!nice.includes('|')) {
      drawLabelWithSubscript(ctx, nice, x, y);
      return;
    }
    const [leftRaw, ...rest] = nice.split('|');
    const rightRaw = rest.join('|');
    const tokenOpts = {
      baseSize: 13,
      subSize: 10,
      dySub: 4,
      separatorGap: 6,
    };
    const leftTokens = buildLabelTokens(leftRaw.trim(), tokenOpts);
    const rightTokens = buildLabelTokens(rightRaw.trim(), tokenOpts);
    const prevAlign = ctx.textAlign;
    ctx.font = `${tokenOpts.baseSize}px Georgia, "Times New Roman", serif`;
    const sepWidth = ctx.measureText('|').width;
    const sideGap = 3;
    const leftWidth = measureLabelTokens(ctx, leftTokens);
    const rightStart = x + sepWidth / 2 + sideGap;
    const leftStart = x - sepWidth / 2 - sideGap - leftWidth;

    drawLabelTokensFrom(ctx, leftTokens, leftStart, y, { fillStyle: ctx.fillStyle });
    ctx.textAlign = 'center';
    ctx.fillText('|', x, y);
    ctx.textAlign = prevAlign;
    drawLabelTokensFrom(ctx, rightTokens, rightStart, y, { fillStyle: ctx.fillStyle });
  }

  // ---------------- Band structure ----------------
  function drawBand(canvas, data){
    const ctx = canvas.getContext('2d');
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 800;
    const H = canvas.clientHeight || 340;
    canvas.width = W * dpi;
    canvas.height = H * dpi;
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!data || !data.bands || !data.bands.length || !data.kdist || !data.kdist.length) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '13px sans-serif';
      ctx.fillText('No band data', 16, 24);
      return;
    }
    const bands = data.bands;
    const k = data.kdist;
    const xmax = k[k.length - 1] || (k.length - 1);
    let ymin = Infinity, ymax = -Infinity;
    bands.forEach(b => b.forEach(v => { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }));
    if (!isFinite(ymin) || !isFinite(ymax)) {
      ctx.fillStyle = '#9ca3af';
      ctx.fillText('Band data invalid', 12, 20);
      return;
    }
    // Paper-style band window around the Fermi level.
    ymin = -3;
    ymax = 3;
    const padL = 58, padR = 20, padT = 18, padB = 40;
    const plotW = Math.max(1, W - padL - padR);
    const plotH = Math.max(1, H - padT - padB);
    const x2px = (x) => padL + (x / (xmax || 1)) * plotW;
    const clampY = (y) => Math.max(ymin, Math.min(ymax, y));
    const y2px = (y) => padT + plotH - ((clampY(y) - ymin) / (ymax - ymin)) * plotH;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(padL, padT, plotW, plotH);

    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(padL, padT, plotW, plotH);

    // fermi level (0 eV)
    if (0 >= ymin && 0 <= ymax) {
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1.15;
      ctx.setLineDash([7, 5]);
      const y0 = y2px(0);
      ctx.beginPath();
      ctx.moveTo(padL, y0);
      ctx.lineTo(padL + plotW, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#111827';
    ctx.font = '13px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [-3, -1.5, 0, 1.5, 3].forEach((v) => {
      const py = y2px(v);
      ctx.fillText(v.toFixed(1), padL - 7, py);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL - 5, py);
      ctx.lineTo(padL, py);
      ctx.stroke();
    });
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    const palette = ['#173da8'];
    // clip drawing to plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    const breakEps = 1e-9;
    bands.forEach((b, idx) => {
      const col = palette[idx % palette.length];
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.35;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      b.forEach((val, i) => {
        const px = x2px(k[i]);
        const py = y2px(val);
        if (i === 0 || k[i] <= k[i - 1] + breakEps) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.stroke();
    });
    ctx.restore();

    // k-path ticks with labels
    if (data.ticks && Array.isArray(data.ticks) && data.ticks.length) {
      ctx.save();
      ctx.fillStyle = '#111827';
      ctx.font = '15px Georgia, "Times New Roman", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ticks = data.ticks;
      // vertical lines over plot only
      ticks.forEach(tk => {
        const pos = (typeof tk.pos === 'number') ? tk.pos : k[Math.min(k.length - 1, Math.max(0, tk.idx || 0))];
        const px = x2px(pos);
        ctx.strokeStyle = 'rgba(107,114,128,0.45)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(px, padT);
        ctx.lineTo(px, padT + plotH);
        ctx.stroke();
      });
      // labels below axis, ensure last label visible
      ticks.forEach(tk => {
        const pos = (typeof tk.pos === 'number') ? tk.pos : k[Math.min(k.length - 1, Math.max(0, tk.idx || 0))];
        const px = x2px(pos);
        const lbl = tk.label ? String(tk.label) : '';
        drawBandTickLabel(ctx, lbl, px, padT + plotH + 7);
      });
      ctx.restore();
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = '14px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    // x label removed by request
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lead = 'Energy ';
    const base = 'E - E';
    const sub = 'F';
    const tail = ' (eV)';
    ctx.font = '14px Georgia, "Times New Roman", serif';
    const wLead = ctx.measureText(lead).width;
    const wBase = ctx.measureText(base).width;
    const wTail = ctx.measureText(tail).width;
    ctx.font = '10px Georgia, "Times New Roman", serif';
    const wSub = ctx.measureText(sub).width;
    const gap = 2;
    const total = wLead + wBase + wSub + gap + wTail;
    let x = -total / 2;
    ctx.font = '14px Georgia, "Times New Roman", serif';
    ctx.fillText(lead, x + wLead / 2, 0);
    x += wLead;
    ctx.fillText(base, x + wBase / 2, 0);
    x += wBase;
    ctx.font = '10px Georgia, "Times New Roman", serif';
    ctx.fillText(sub, x + wSub / 2, 3);
    x += wSub + gap;
    ctx.font = '14px Georgia, "Times New Roman", serif';
    ctx.fillText(tail, x + wTail / 2, 0);
    ctx.restore();

  }

  function drawBzFallback(canvas, data){
    const ctx = canvas.getContext('2d');
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 260;
    const H = canvas.clientHeight || 340;
    canvas.width = W * dpi;
    canvas.height = H * dpi;
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!data || !Array.isArray(data.bz_lines) || data.bz_lines.length === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('No BZ data', 10, 18);
      return;
    }
    const lines = data.bz_lines;
    const points = Array.isArray(data.bz_points) ? data.bz_points : [];
    const rz = Math.PI / 4;
    const rx = Math.PI / 7;
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const project = (p) => {
      const x0 = p[0], y0 = p[1], z0 = p[2];
      const x1 = x0 * cz - y0 * sz;
      const y1 = x0 * sz + y0 * cz;
      const y2 = y1 * cx - z0 * sx;
      return [x1, y2];
    };
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const projLines = lines.map(seg => seg.map(pt => {
      const p2 = project(pt);
      minx = Math.min(minx, p2[0]); maxx = Math.max(maxx, p2[0]);
      miny = Math.min(miny, p2[1]); maxy = Math.max(maxy, p2[1]);
      return p2;
    }));
    const projPoints = points.map(p => {
      const p2 = project(p.point || [0,0,0]);
      minx = Math.min(minx, p2[0]); maxx = Math.max(maxx, p2[0]);
      miny = Math.min(miny, p2[1]); maxy = Math.max(maxy, p2[1]);
      return { label: p.label || '', xy: p2 };
    });
    const pad = 12;
    const spanX = maxx - minx || 1;
    const spanY = maxy - miny || 1;
    const boxW = W - pad * 2;
    const boxH = H - pad * 2;
    const marginFactor = 0.74;
    const scale = Math.min(boxW / spanX, boxH / spanY) * marginFactor;
    const scaledW = spanX * scale;
    const scaledH = spanY * scale;
    const offsetX = pad + (boxW - scaledW) / 2;
    const offsetY = pad + (boxH - scaledH) / 2;
    const x2px = (x) => offsetX + (x - minx) * scale;
    const y2px = (y) => H - (offsetY + (y - miny) * scale);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, boxW, boxH);

    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.2;
    projLines.forEach(seg => {
      ctx.beginPath();
      ctx.moveTo(x2px(seg[0][0]), y2px(seg[0][1]));
      ctx.lineTo(x2px(seg[1][0]), y2px(seg[1][1]));
      ctx.stroke();
    });

    ctx.fillStyle = '#1e293b';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    projPoints.forEach(p => {
      const px = x2px(p.xy[0]);
      const py = y2px(p.xy[1]);
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
      const label = String(p.label || '').replace(/\\Gamma|\\\\Gamma|Gamma/g, 'Γ');
      if (label) drawLabelWithSubscript(ctx, label, px + 10, py - 1);
    });
  }

  function disposeThreeMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(disposeThreeMaterial);
      return;
    }
    ['map', 'alphaMap'].forEach((key) => {
      const tex = material[key];
      if (tex && typeof tex.dispose === 'function') tex.dispose();
    });
    if (typeof material.dispose === 'function') material.dispose();
  }

  function disposeThreeObject(root) {
    if (!root || typeof root.traverse !== 'function') return;
    root.traverse((obj) => {
      if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
      if (obj.material) disposeThreeMaterial(obj.material);
    });
  }

  function destroyBzViewer(canvas) {
    const prev = bzViewerState.get(canvas);
    if (!prev) return;
    if (prev.resizeObserver) prev.resizeObserver.disconnect();
    if (prev.resizeHandler) window.removeEventListener('resize', prev.resizeHandler);
    if (prev.controls && typeof prev.controls.dispose === 'function') prev.controls.dispose();
    if (prev.root) disposeThreeObject(prev.root);
    if (prev.renderer) {
      if (typeof prev.renderer.dispose === 'function') prev.renderer.dispose();
    }
    bzViewerState.delete(canvas);
  }

  function resizeBzViewer(state) {
    if (!state || !state.renderer || !state.camera || !state.canvas) return;
    const width = Math.max(1, Math.round(state.canvas.clientWidth || 260));
    const height = Math.max(1, Math.round(state.canvas.clientHeight || 340));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    state.renderer.setPixelRatio(pixelRatio);
    state.renderer.setSize(width, height, false);
    state.aspect = width / Math.max(height, 1);
    fitBzCamera(state);
    state.renderer.render(state.scene, state.camera);
  }

  function fitBzCamera(state) {
    if (!state || !state.camera || !state.center || !state.viewDir || !Number.isFinite(state.viewRadius)) return;
    const camera = state.camera;
    const aspect = Math.max(state.aspect || 1, 0.1);
    const halfHeight = Math.max(state.viewRadius, 1e-6);
    const halfWidth = halfHeight * aspect;
    if (camera.isOrthographicCamera) {
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    const distance = Math.max(state.viewRadius * 12, 1);
    camera.position.copy(state.center.clone().add(state.viewDir.clone().multiplyScalar(distance)));
    camera.near = 1e-6;
    camera.far = distance + state.viewRadius * 24 + 10;
    camera.lookAt(state.center);
    camera.updateProjectionMatrix();
    if (state.controls) {
      state.controls.target.copy(state.center);
      state.controls.minDistance = 1e-9;
      state.controls.maxDistance = Infinity;
      state.controls.minZoom = 0;
      state.controls.maxZoom = Infinity;
      state.controls.update();
    }
  }

  function makeBzLabelSprite(label, radius, opts = {}) {
    const nice = String(label || '').replace(/\\Gamma|\\\\Gamma|Gamma/g, 'Γ');
    if (!nice) return null;
    const tokens = buildLabelTokens(nice, {
      baseSize: opts.baseSize ?? 20,
      subSize: opts.subSize ?? 13,
      dySub: opts.dySub ?? 5,
      separatorGap: 8,
    });
    if (!tokens.length) return null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const padding = 12;
    const metric = document.createElement('canvas').getContext('2d');
    if (!metric) return null;
    const width = Math.max(68, Math.ceil(measureLabelTokens(metric, tokens) + padding * 2));
    const height = 46;
    const supersample = Math.max(2, Math.min(window.devicePixelRatio || 1, 2) * 2);
    canvas.width = Math.ceil(width * supersample);
    canvas.height = Math.ceil(height * supersample);

    ctx.setTransform(supersample, 0, 0, supersample, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.shadowColor = opts.shadowColor ?? 'rgba(255,255,255,0.85)';
    ctx.shadowBlur = opts.shadowBlur ?? 1.2;
    ctx.shadowOffsetY = opts.shadowOffsetY ?? 0.4;
    drawLabelTokens(ctx, tokens, width / 2, height / 2, {
      fillStyle: opts.fillStyle || '#111111',
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const aspect = width / Math.max(height, 1);
    const scaleBase = opts.scaleBase || Math.max(radius * 0.078, 0.08);
    sprite.scale.set(scaleBase * aspect, scaleBase, 1);
    return sprite;
  }

  function renderInteractiveBz(canvas, data) {
    if (!window.THREE || typeof THREE.WebGLRenderer !== 'function' || typeof THREE.OrbitControls !== 'function') {
      return false;
    }
    const lines = Array.isArray(data?.bz_lines) ? data.bz_lines : [];
    if (!lines.length) return false;

    const points = Array.isArray(data?.bz_points) ? data.bz_points : [];
    const box = new THREE.Box3();
    let hasBounds = false;
    const lineVertices = [];
    lines.forEach((seg) => {
      if (!Array.isArray(seg) || seg.length !== 2) return;
      seg.forEach((pt) => {
        if (!Array.isArray(pt) || pt.length < 3) return;
        const v = new THREE.Vector3(Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0);
        lineVertices.push(v.x, v.y, v.z);
        box.expandByPoint(v);
        hasBounds = true;
      });
    });
    points.forEach((p) => {
      const pt = Array.isArray(p?.point) ? p.point : null;
      if (!pt || pt.length < 3) return;
      box.expandByPoint(new THREE.Vector3(Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0));
      hasBounds = true;
    });
    if (!hasBounds || lineVertices.length < 6) return false;

    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fitRadius = Math.max(sphere.radius || 0, 1e-6);
    const radius = Math.max(fitRadius, 0.5);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (_) {
      return false;
    }
    renderer.setClearColor(0xffffff, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1e-6, Math.max(fitRadius * 80, 100));
    const root = new THREE.Group();
    scene.add(root);

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.95 });
    root.add(new THREE.LineSegments(lineGeometry, lineMaterial));

    const pointVectors = [];
    points.forEach((p) => {
      const pt = Array.isArray(p?.point) ? p.point : null;
      if (!pt || pt.length < 3) return;
      pointVectors.push(new THREE.Vector3(Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0));
    });
    const pointVertices = [];
    pointVectors.forEach((pt) => {
      pointVertices.push(pt.x, pt.y, pt.z);
    });
    if (pointVertices.length) {
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pointVertices, 3));
      const pointMaterial = new THREE.PointsMaterial({
        color: 0x000000,
        size: Math.max(radius * 0.05, 0.045),
        sizeAttenuation: true,
      });
      root.add(new THREE.Points(pointGeometry, pointMaterial));
    }

    points.forEach((p) => {
      const pt = Array.isArray(p?.point) ? p.point : null;
      if (!pt || pt.length < 3) return;
      const sprite = makeBzLabelSprite(p.label || '', radius, {
        fillStyle: '#111111',
        baseSize: 22,
        subSize: 14,
        scaleBase: Math.max(radius * 0.085, 0.085),
      });
      if (!sprite) return;
      const pos = new THREE.Vector3(Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0);
      let offset = pos.clone().sub(center);
      if (offset.lengthSq() < 1e-6) offset = new THREE.Vector3(0.4, 0.4, 0.4);
      offset.normalize().multiplyScalar(Math.max(radius * 0.085, 0.06));
      sprite.position.copy(pos.add(offset));
      root.add(sprite);
    });

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controls.target.copy(center);

    const state = {
      canvas,
      renderer,
      scene,
      camera,
      controls,
      root,
      center: center.clone(),
      viewRadius: fitRadius * 1.5,
      viewDir: new THREE.Vector3(1.45, 1.15, 1.55).normalize(),
    };
    const render = () => state.renderer.render(state.scene, state.camera);
    controls.addEventListener('change', render);

    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => resizeBzViewer(state));
      state.resizeObserver.observe(canvas);
    } else {
      state.resizeHandler = () => resizeBzViewer(state);
      window.addEventListener('resize', state.resizeHandler);
    }

    bzViewerState.set(canvas, state);
    resizeBzViewer(state);
    render();
    return true;
  }

  function drawBz(canvas, data){
    if (!canvas) return;
    destroyBzViewer(canvas);
    try {
      const ok = renderInteractiveBz(canvas, data);
      if (ok) return;
    } catch (e) {
      destroyBzViewer(canvas);
    }
    try {
      drawBzFallback(canvas, data);
    } catch (e) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const W = canvas.clientWidth || 260;
      const H = canvas.clientHeight || 340;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.fillText('BZ render unavailable', 12, 22);
    }
  }

  function bandSvgLabel(label, x, y, opts = {}) {
    const text = String(label || '').replace(/\\Gamma|\\\\Gamma|Gamma/g, 'Γ');
    const fontSize = opts.fontSize ?? 18;
    const fill = opts.fill || '#111827';
    const anchor = opts.anchor || 'middle';
    const baseline = opts.baseline || 'middle';
    const parts = text.split('|');
    const chunks = [];
    parts.forEach((part, partIdx) => {
      if (partIdx > 0) chunks.push(`<tspan>${svgEscape('|')}</tspan>`);
      const seg = part.trim();
      const us = seg.indexOf('_');
      if (us === -1) {
        chunks.push(`<tspan>${svgEscape(seg)}</tspan>`);
      } else {
        const head = seg.slice(0, us);
        const sub = seg.slice(us + 1);
        if (head) chunks.push(`<tspan>${svgEscape(head)}</tspan>`);
        if (sub) chunks.push(`<tspan baseline-shift="sub" font-size="${Math.round(fontSize * 0.68)}">${svgEscape(sub)}</tspan>`);
      }
    });
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="${fill}">${chunks.join('')}</text>`;
  }

  function makeBandStructureSvg(data, width = 1200, height = 620) {
    if (!data || !Array.isArray(data.bands) || !data.bands.length || !Array.isArray(data.kdist) || !data.kdist.length) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="24" y="34" fill="#94a3b8" font-size="18">No band data</text></svg>`;
    }
    const bands = data.bands;
    const k = data.kdist;
    const xmax = k[k.length - 1] || (k.length - 1) || 1;
    const ymin = -3;
    const ymax = 3;
    const padL = 76;
    const padR = 28;
    const padT = 28;
    const padB = 62;
    const plotW = Math.max(1, width - padL - padR);
    const plotH = Math.max(1, height - padT - padB);
    const x2px = (x) => padL + (Number(x || 0) / xmax) * plotW;
    const clampY = (y) => Math.max(ymin, Math.min(ymax, Number(y || 0)));
    const y2px = (y) => padT + plotH - ((clampY(y) - ymin) / (ymax - ymin)) * plotH;
    const clipId = `bandClip${Math.random().toString(36).slice(2)}`;
    const out = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      `<defs><clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`,
      `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#111827" stroke-width="1.6"/>`,
    ];
    if (Array.isArray(data.ticks)) {
      data.ticks.forEach((tk) => {
        const pos = (typeof tk.pos === 'number') ? tk.pos : k[Math.min(k.length - 1, Math.max(0, tk.idx || 0))];
        const px = x2px(pos);
        out.push(`<line x1="${px.toFixed(2)}" y1="${padT}" x2="${px.toFixed(2)}" y2="${padT + plotH}" stroke="rgba(107,114,128,0.45)" stroke-width="1"/>`);
      });
    }
    const y0 = y2px(0);
    out.push(`<line x1="${padL}" y1="${y0.toFixed(2)}" x2="${padL + plotW}" y2="${y0.toFixed(2)}" stroke="#111827" stroke-width="1.5" stroke-dasharray="8 7"/>`);
    [-3, -1.5, 0, 1.5, 3].forEach((v) => {
      const py = y2px(v);
      out.push(`<line x1="${padL - 7}" y1="${py.toFixed(2)}" x2="${padL}" y2="${py.toFixed(2)}" stroke="#111827" stroke-width="1"/>`);
      out.push(`<text x="${padL - 12}" y="${py.toFixed(2)}" text-anchor="end" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#111827">${v.toFixed(1)}</text>`);
    });
    out.push(`<g clip-path="url(#${clipId})">`);
    const breakEps = 1e-9;
    bands.forEach((band) => {
      const chunks = [];
      let d = [];
      const n = Math.min(band.length, k.length);
      for (let i = 0; i < n; i++) {
        const px = x2px(k[i]);
        const py = y2px(band[i]);
        if (i === 0 || k[i] <= k[i - 1] + breakEps) {
          if (d.length) chunks.push(d.join(' '));
          d = [`M${px.toFixed(2)} ${py.toFixed(2)}`];
        } else {
          d.push(`L${px.toFixed(2)} ${py.toFixed(2)}`);
        }
      }
      if (d.length) chunks.push(d.join(' '));
      chunks.forEach((path) => out.push(`<path d="${path}" fill="none" stroke="#173da8" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`));
    });
    out.push('</g>');
    if (Array.isArray(data.ticks)) {
      data.ticks.forEach((tk) => {
        const pos = (typeof tk.pos === 'number') ? tk.pos : k[Math.min(k.length - 1, Math.max(0, tk.idx || 0))];
        const px = x2px(pos);
        out.push(bandSvgLabel(tk.label || '', px, padT + plotH + 30, { fontSize: 21, baseline: 'middle' }));
      });
    }
    out.push(`<text transform="translate(26 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, 'Times New Roman', serif" font-size="21" fill="#111827">Energy E - E<tspan baseline-shift="sub" font-size="14">F</tspan> (eV)</text>`);
    out.push('</svg>');
    return out.join('');
  }

  function makeBzSvg(canvas, data, width = 640, height = 520) {
    const lines = Array.isArray(data?.bz_lines) ? data.bz_lines : [];
    const points = Array.isArray(data?.bz_points) ? data.bz_points : [];
    if (!lines.length) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="24" y="34" fill="#94a3b8" font-size="18">No BZ data</text></svg>`;
    }
    const state = canvas ? bzViewerState.get(canvas) : null;
    let project3 = null;
    if (state?.camera && window.THREE) {
      const camera = state.camera;
      camera.updateMatrixWorld();
      if (state.controls && typeof state.controls.update === 'function') state.controls.update();
      project3 = (pt) => {
        const v = new THREE.Vector3(Number(pt[0]) || 0, Number(pt[1]) || 0, Number(pt[2]) || 0);
        v.project(camera);
        return {
          x: (v.x * 0.5 + 0.5) * width,
          y: (-v.y * 0.5 + 0.5) * height,
          z: v.z,
        };
      };
    } else {
      const rz = Math.PI / 4;
      const rx = Math.PI / 7;
      const cz = Math.cos(rz), sz = Math.sin(rz);
      const cx = Math.cos(rx), sx = Math.sin(rx);
      const rawProject = (pt) => {
        const x0 = Number(pt[0]) || 0;
        const y0 = Number(pt[1]) || 0;
        const z0 = Number(pt[2]) || 0;
        const x1 = x0 * cz - y0 * sz;
        const y1 = x0 * sz + y0 * cz;
        return [x1, y1 * cx - z0 * sx];
      };
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      lines.forEach((seg) => seg.forEach((pt) => {
        const p = rawProject(pt);
        minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
        miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
      }));
      points.forEach((p) => {
        const pt = Array.isArray(p.point) ? p.point : [0, 0, 0];
        const pp = rawProject(pt);
        minx = Math.min(minx, pp[0]); maxx = Math.max(maxx, pp[0]);
        miny = Math.min(miny, pp[1]); maxy = Math.max(maxy, pp[1]);
      });
      const pad = 48;
      const scale = Math.min((width - pad * 2) / ((maxx - minx) || 1), (height - pad * 2) / ((maxy - miny) || 1)) * 0.82;
      const cx0 = (minx + maxx) / 2;
      const cy0 = (miny + maxy) / 2;
      project3 = (pt) => {
        const p = rawProject(pt);
        return { x: width / 2 + (p[0] - cx0) * scale, y: height / 2 - (p[1] - cy0) * scale, z: 0 };
      };
    }
    const center = (() => {
      const pts = [];
      lines.forEach((seg) => seg.forEach((pt) => pts.push(pt)));
      const c = [0, 0, 0];
      pts.forEach((pt) => {
        c[0] += Number(pt[0]) || 0;
        c[1] += Number(pt[1]) || 0;
        c[2] += Number(pt[2]) || 0;
      });
      return pts.length ? c.map((v) => v / pts.length) : [0, 0, 0];
    })();
    const out = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
    ];
    lines.forEach((seg) => {
      if (!Array.isArray(seg) || seg.length !== 2) return;
      const a = project3(seg[0]);
      const b = project3(seg[1]);
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return;
      out.push(`<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="#111111" stroke-width="1.2" stroke-linecap="round"/>`);
    });
    points.forEach((p) => {
      const pt = Array.isArray(p.point) ? p.point : null;
      if (!pt || pt.length < 3) return;
      const pp = project3(pt);
      if (![pp.x, pp.y].every(Number.isFinite)) return;
      const dx = (Number(pt[0]) || 0) - center[0];
      const dy = (Number(pt[1]) || 0) - center[1];
      const dz = (Number(pt[2]) || 0) - center[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const outPt = project3([pt[0] + dx / len * 0.05, pt[1] + dy / len * 0.05, pt[2] + dz / len * 0.05]);
      const lx = Number.isFinite(outPt.x) ? outPt.x : pp.x + 10;
      const ly = Number.isFinite(outPt.y) ? outPt.y : pp.y - 8;
      out.push(`<circle cx="${pp.x.toFixed(2)}" cy="${pp.y.toFixed(2)}" r="3.6" fill="#111111"/>`);
      out.push(bandSvgLabel(p.label || '', lx, ly - 8, { fontSize: 22, fill: '#111111', baseline: 'middle' }));
    });
    out.push('</svg>');
    return out.join('');
  }

  async function initBand() {
    const id = matId();
    const block = document.getElementById('bandBlock');
    const canvas = document.getElementById('bandCanvas');
    const bzCanvas = document.getElementById('bandBzCanvas');
    const bandDownloadBtn = document.getElementById('bandDownloadSvg');
    const bzDownloadBtn = document.getElementById('bandBzDownloadSvg');
    const tabs = Array.from(document.querySelectorAll('.band-tab'));
    const hint = document.getElementById('bandHint');
    const variantBadge = document.getElementById('bandVariantBadge');
    const statsBadge = document.getElementById('bandStatsBadge');
    if (!id || !block || !canvas || !tabs.length) return;
    let currentBandData = null;
    let currentBandVariant = 'soc';

    const setHint = (msg) => { if (hint) hint.textContent = msg || ''; };
    const activate = (v) => tabs.forEach(t => t.classList.toggle('active', t.dataset.variant === v));
    const safeStem = () => String(id || 'material')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'material';
    const setDownloadsEnabled = (enabled) => {
      [bandDownloadBtn, bzDownloadBtn].forEach((btn) => {
        if (btn) btn.disabled = !enabled;
      });
    };
    const setSummary = (variant, data) => {
      if (variantBadge) {
        variantBadge.textContent = variant === 'soc' ? 'SOC' : 'without SOC';
        variantBadge.classList.toggle('is-nosoc', variant !== 'soc');
      }
      if (statsBadge) {
        const nk = data && data.nkpoints != null ? data.nkpoints : '-';
        const nb = data && data.nbands != null ? data.nbands : '-';
        statsBadge.textContent = `nk=${nk} · nb=${nb}`;
      }
    };

    async function loadVariant(v) {
      let data = null;
      try {
        setSummary(v, null);
        setHint('Loading band data...');
        data = await apiGet(`/api/band/${encodeURIComponent(id)}?variant=${v}`);
        if (!data.available) {
          currentBandData = null;
          setDownloadsEnabled(false);
          setHint(`No band data for ${v === 'soc' ? 'SOC' : 'without SOC'}`);
          return false;
        }
      } catch (e) {
        setSummary(v, null);
        currentBandData = null;
        setDownloadsEnabled(false);
        setHint('Failed to load band data');
        return false;
      }

      try {
        drawBand(canvas, data);
        if (bzCanvas) drawBz(bzCanvas, data);
        currentBandData = data;
        currentBandVariant = v;
        setDownloadsEnabled(true);
        setSummary(v, data);
        setHint('');
        block.style.display = 'block';
        return true;
      } catch (e) {
        setSummary(v, data);
        setHint('Band data loaded, but the plot failed to render');
        return false;
      }
    }

    setDownloadsEnabled(false);
    if (bandDownloadBtn) {
      bandDownloadBtn.addEventListener('click', () => {
        if (!currentBandData) return;
        const svg = makeBandStructureSvg(currentBandData, 1200, 620);
        downloadSvg(svg, `${safeStem()}_band_structure_${currentBandVariant}.svg`);
      });
    }
    if (bzDownloadBtn) {
      bzDownloadBtn.addEventListener('click', () => {
        if (!currentBandData) return;
        const width = Math.max(520, Math.round(bzCanvas?.clientWidth || 520));
        const height = Math.max(520, Math.round(bzCanvas?.clientHeight || 520));
        const svg = makeBzSvg(bzCanvas, currentBandData, width, height);
        downloadSvg(svg, `${safeStem()}_brillouin_zone_${currentBandVariant}.svg`);
      });
    }

    tabs.forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset.variant || 'soc';
        activate(v);
        await loadVariant(v);
      });
    });

    let ok = await loadVariant('soc');
    if (!ok) {
      activate('nosoc');
      ok = await loadVariant('nosoc');
    } else {
      activate('soc');
    }
    if (!ok) block.style.display = 'none';
  }

  function axisZoomValue(value) {
    const z = Number(value);
    if (!Number.isFinite(z) || z < 1) return 1;
    return Math.min(50, z);
  }

  function zoomAxisDomain(min, max, zoom, centerHint) {
    const z = axisZoomValue(zoom);
    if (z <= 1 || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min, max];
    const span = (max - min) / z;
    let center = Number.isFinite(centerHint)
      ? Number(centerHint)
      : (min <= 0 && max >= 0 ? 0 : (min + max) / 2);
    const minCenter = min + span / 2;
    const maxCenter = max - span / 2;
    if (minCenter <= maxCenter) center = Math.min(maxCenter, Math.max(minCenter, center));
    return [center - span / 2, center + span / 2];
  }

  function zoomYDomain(min, max, zoom, opts = {}) {
    const z = axisZoomValue(zoom);
    if (z <= 1 || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min, max];
    const span = (max - min) / z;
    if (opts.yZeroLine && min < 0 && max > 0) {
      const half = Math.max(Math.abs(min), Math.abs(max)) / z;
      return [-half, half];
    }
    if (Number.isFinite(opts.yZoomCenter)) {
      return zoomAxisDomain(min, max, z, opts.yZoomCenter);
    }
    if (Number.isFinite(opts.yMin) && !Number.isFinite(opts.yMax)) return [min, min + span];
    if (Number.isFinite(opts.yMax) && !Number.isFinite(opts.yMin)) return [max - span, max];
    if (min >= 0) return [min, min + span];
    if (max <= 0) return [max - span, max];
    return [-span / 2, span / 2];
  }

  // canvas plotting utility
  function drawPlot(canvas, seriesInput, opts={}) {
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 480;
    const H = canvas.clientHeight || 220;
    canvas.width = Math.max(1, Math.floor(W * dpi));
    canvas.height = Math.max(1, Math.floor(H * dpi));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);
    canvas.__mrPlotSvg = makeLinePlotSvg(W, H, seriesInput, opts);

    // paddings tuned to avoid label overlap and shrink x-span
    const padL = 58, padR = 14, padT = 18, padB = 38;
    const plotW = Math.max(1, W - padL - padR);
    const plotH = Math.max(1, H - padT - padB);

    // normalize input to a list of series
    const list = Array.isArray(seriesInput)
      ? seriesInput.filter(s => s && s.x && s.y && s.x.length)
      : (seriesInput && seriesInput.x && seriesInput.y && seriesInput.x.length ? [seriesInput] : []);
    if (!list.length) {
      ctx.fillStyle = '#111827';
      ctx.fillText('No data', padL + 8, padT + 16);
      return;
    }
    // compute domains across all series
    let xmin = Infinity, xmax = -Infinity;
    let maxAbs = 0;
    for (const s of list) {
      xmin = Math.min(xmin, ...s.x);
      xmax = Math.max(xmax, ...s.x);
      for (const v of s.y) { const a = Math.abs(v); if (a > maxAbs) maxAbs = a; }
    }
    if (Number.isFinite(opts.xMin)) xmin = opts.xMin;
    if (Number.isFinite(opts.xMax)) xmax = opts.xMax;
    [xmin, xmax] = zoomAxisDomain(xmin, xmax, opts.xZoom, opts.xZoomCenter);
    const xr = (xmax - xmin) || 1;
    // shared y exponent and scaled lists
    const useScientificY = opts.yScientific !== false;
    let yExp = 0;
    if (useScientificY && maxAbs > 0) yExp = Math.floor(Math.log10(maxAbs));
    const yScale = useScientificY ? (Math.pow(10, yExp) || 1) : 1;
    const scaledLists = list.map(s => ({ x: s.x, y: s.y.map(v => v / yScale), label: s.label, color: s.color }));
    let yminS = Infinity, ymaxS = -Infinity;
    for (const s of scaledLists) {
      yminS = Math.min(yminS, ...s.y);
      ymaxS = Math.max(ymaxS, ...s.y);
    }
    let yrS = (ymaxS - yminS) || 1;
    const yPad = yrS * 0.08;
    if (Number.isFinite(opts.yMin)) yminS = opts.yMin / yScale;
    else yminS -= yPad;
    if (Number.isFinite(opts.yMax)) ymaxS = opts.yMax / yScale;
    else ymaxS += yPad;
    if (ymaxS <= yminS) ymaxS = yminS + 1;
    if (opts.yZeroLine && yminS < 0 && ymaxS > 0) {
      const yBound = Math.max(Math.abs(yminS), Math.abs(ymaxS));
      if (Number.isFinite(yBound) && yBound > 0) {
        yminS = -yBound;
        ymaxS = yBound;
      }
    }
    [yminS, ymaxS] = zoomYDomain(yminS, ymaxS, opts.yZoom, opts);
    yrS = (ymaxS - yminS) || 1;
    const x2px = (x) => padL + ((x - xmin) / xr) * plotW;
    const y2px = (yScaled) => padT + plotH - ((yScaled - yminS) / yrS) * plotH;

    // axes ticks (5 ticks)
    ctx.fillStyle = '#111827';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fmtTick = (v) => {
      const av = Math.abs(v);
      if (av >= 100) return v.toFixed(0);
      if (av >= 10) return v.toFixed(0);
      if (av >= 1) return v.toFixed(1).replace(/\.0$/, '');
      return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    };
    for (let i=0;i<=5;i++){
      const t = xmin + (xr * i / 5);
      const px = x2px(t);
      ctx.strokeStyle = '#e8edf5';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT+plotH); ctx.stroke();
      ctx.fillText(fmtTick(t), px, padT + plotH + 4);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif';
    const fmt = (v) => {
      const digits = Number.isFinite(opts.yTickDigits) ? Math.max(0, Math.floor(opts.yTickDigits)) : 2;
      const zeroCutoff = 0.5 * Math.pow(10, -digits);
      if (Math.abs(v) < zeroCutoff) return digits === 0 ? '0' : (0).toFixed(digits);
      const fixed = v.toFixed(digits);
      return fixed === '-0' || fixed === '-0.00' ? (digits === 0 ? '0' : (0).toFixed(digits)) : fixed;
    };
    const yTickSteps = opts.yZeroLine ? 4 : 5;
    for (let i=0;i<=yTickSteps;i++){
      const tS = yminS + (yrS * i / yTickSteps);
      const py = y2px(tS);
      ctx.strokeStyle = '#e8edf5';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL+plotW, py); ctx.stroke();
      ctx.fillText(fmt(tS), padL - 6, py);
    }
    if (opts.yZeroLine && yminS < 0 && ymaxS > 0) {
      const py0 = y2px(0);
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(padL, py0); ctx.lineTo(padL + plotW, py0); ctx.stroke();
      ctx.restore();
    }

    if (xmin <= 0 && xmax >= 0) {
      const px0 = x2px(0);
      ctx.save();
      ctx.strokeStyle = '#6b7280';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(px0, padT); ctx.lineTo(px0, padT + plotH); ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

    // y-axis common factor at top: render as '×10' with superscript n (no caret)
    if (useScientificY && yExp !== 0) {
      ctx.save();
      ctx.fillStyle = '#111827';
      const baseStr = '×10';
      const expStr = String(yExp);
      ctx.font = '12px sans-serif';
      const wBase = ctx.measureText(baseStr).width;
      ctx.font = '10px sans-serif';
      const wExp = ctx.measureText(expStr).width;
      const totalW = wBase + wExp;
      const xShift = 10; // move slightly right into plot area
      const x0 = padL - totalW / 2 + xShift;
      const y0 = padT - 2; // keep safely inside canvas top area
      // draw base centered as part of total width
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.font = '12px sans-serif';
      ctx.fillText(baseStr, x0, y0);
      // draw exponent as superscript
      ctx.font = '10px sans-serif';
      ctx.fillText(expStr, x0 + wBase, y0 - 6);
      ctx.restore();
    }

    // series lines (support multiple)
    const colorFor = (i, fallback) => fallback || COLOR_PALETTE[i % COLOR_PALETTE.length];
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    ctx.lineWidth = 2.2;
    scaledLists.forEach((s, i) => {
      ctx.strokeStyle = colorFor(i, s.color || opts.color);
      ctx.beginPath();
      for (let k=0;k<s.x.length;k++){
        const px = x2px(s.x[k]);
        const py = y2px(s.y[k]);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    ctx.restore();

    // legend (top-right) when multiple series
    if (scaledLists.length > 1 && opts.showLegend !== false) {
      const labels = scaledLists.map((s,i)=>({text: s.label || `Series ${i+1}`, color: colorFor(i, s.color || opts.color)}));
      ctx.save();
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lineW = 18, lineH = 10, pad = 6, gap = 12;
      const rowStep = lineH + 6;
      const textWidths = labels.map(l => ctx.measureText(l.text).width);
      const itemW = Math.max(...textWidths.map((w)=> w + lineW + gap)) + 2 * pad;
      const maxRows = Math.max(1, Math.floor((plotH - 18 - 2 * pad) / rowStep));
      const colCount = Math.max(1, Math.ceil(labels.length / maxRows));
      const rowsPerCol = Math.ceil(labels.length / colCount);
      const boxW = Math.min(plotW - 16, itemW * colCount);
      const boxH = rowsPerCol * rowStep + 2*pad;
      const rightMargin = 10;
      const x0 = padL + plotW - boxW - rightMargin;
      const y0 = padT + 6;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, boxW, boxH);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.76)';
      ctx.fillRect(x0, y0, boxW, boxH);
      ctx.strokeStyle = 'rgba(203, 213, 225, 0.9)';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, boxW - 1, boxH - 1);
      ctx.restore();
      labels.forEach((l, idx) => {
        const col = Math.floor(idx / rowsPerCol);
        const row = idx % rowsPerCol;
        const colX = x0 + col * itemW;
        const yy = y0 + pad + row * rowStep;
        if (colX + itemW > x0 + boxW + 1) return;
        // line sample
        ctx.strokeStyle = l.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(colX + pad, yy + lineH/2); ctx.lineTo(colX + pad + lineW, yy + lineH/2); ctx.stroke();
        // text
        ctx.fillStyle = '#111827';
        ctx.fillText(l.text, colX + pad + lineW + gap, yy + lineH/2);
      });
      ctx.restore();
    }

    // labels
    ctx.fillStyle = '#111827';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '13px sans-serif';
    ctx.fillText(opts.xlabel || 'Bτ', padL + plotW / 2, padT + plotH + 24);
    ctx.save();
    ctx.translate(16, padT + plotH / 2);
    ctx.rotate(-Math.PI/2);
    if (opts.ylabelBase) {
      // draw base + subscript + units, with subscript smaller and lowered
      const base = String(opts.ylabelBase);
      const sub = opts.ylabelSub ? String(opts.ylabelSub) : '';
      const units = opts.ylabelUnits ? String(opts.ylabelUnits) : '';
      const tail = opts.ylabelTail ? String(opts.ylabelTail) : '';
      const factorExp = yExp || 0;
      // measure widths for centering
      ctx.textBaseline = 'alphabetic';
      ctx.font = '13px sans-serif';
      const wBase = ctx.measureText(base).width;
      ctx.font = '11px sans-serif';
      const wSub = sub ? ctx.measureText(sub).width : 0;
      ctx.font = '13px sans-serif';
      const wTail = tail ? ctx.measureText(tail).width : 0;
      const wUnits = units ? ctx.measureText(units).width : 0;
      const afterBaseGap = sub ? 3 : 1;
      const afterTailGap = tail ? 2 : 0;
      const beforeUnitsGap = units ? (opts.ylabelUnitsGap ?? 18) : 0; // spacing between tail and units on same line
      // center full label on one line (base + sub + tail + gap + units)
      const totalWidth = wBase + (sub ? wSub : 0) + afterBaseGap + wTail + afterTailGap + beforeUnitsGap + wUnits;
      let offset = - totalWidth / 2;
      // draw base
      ctx.font = '13px sans-serif';
      ctx.fillText(base, offset, 0);
      offset += wBase;
      // draw subscript
      if (sub) {
        ctx.font = '11px sans-serif';
        ctx.fillText(sub, offset + 1, 3);
        offset += wSub + afterBaseGap;
      } else {
        offset += afterBaseGap;
      }
      // draw tail (·τ or /τ)
      ctx.font = '13px sans-serif';
      if (tail) {
        ctx.fillText(tail, offset, 0);
        offset += wTail + afterTailGap;
      }
      // spacing then units on same line
      if (units) {
        offset += beforeUnitsGap;
        ctx.font = '13px sans-serif';
        ctx.fillText(units, offset, 0);
      }
    } else {
      ctx.font = '13px sans-serif';
      // center plain ylabel
      const w = ctx.measureText(opts.ylabel || 'Value').width;
      ctx.fillText(opts.ylabel || 'Value', -w/2, 0);
    }
    ctx.restore();
  }

  function makeLinePlotSvg(width, height, seriesInput, opts = {}) {
    const W = Math.max(1, Math.round(width || 480));
    const H = Math.max(1, Math.round(height || 220));
    const padL = 58, padR = 14, padT = 18, padB = 38;
    const plotW = Math.max(1, W - padL - padR);
    const plotH = Math.max(1, H - padT - padB);
    const list = Array.isArray(seriesInput)
      ? seriesInput.filter(s => s && Array.isArray(s.x) && Array.isArray(s.y) && s.x.length)
      : (seriesInput && Array.isArray(seriesInput.x) && Array.isArray(seriesInput.y) && seriesInput.x.length ? [seriesInput] : []);
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
    ];
    if (!list.length) {
      parts.push(`<text x="${padL + 8}" y="${padT + 16}" font-size="12" fill="#111827">No data</text></svg>`);
      return parts.join('');
    }

    let xmin = Infinity, xmax = -Infinity;
    let maxAbs = 0;
    list.forEach((s) => {
      s.x.forEach((x) => { const n = Number(x); if (Number.isFinite(n)) { xmin = Math.min(xmin, n); xmax = Math.max(xmax, n); } });
      s.y.forEach((y) => { const n = Math.abs(Number(y)); if (Number.isFinite(n)) maxAbs = Math.max(maxAbs, n); });
    });
    if (Number.isFinite(opts.xMin)) xmin = opts.xMin;
    if (Number.isFinite(opts.xMax)) xmax = opts.xMax;
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax <= xmin) { xmin = 0; xmax = 1; }
    [xmin, xmax] = zoomAxisDomain(xmin, xmax, opts.xZoom, opts.xZoomCenter);
    const xr = (xmax - xmin) || 1;
    const useScientificY = opts.yScientific !== false;
    let yExp = 0;
    if (useScientificY && maxAbs > 0) yExp = Math.floor(Math.log10(maxAbs));
    const yScale = useScientificY ? (Math.pow(10, yExp) || 1) : 1;
    const scaledLists = list.map(s => ({
      x: s.x,
      y: s.y.map(v => Number(v) / yScale),
      label: s.label,
      color: s.color,
    }));
    let yminS = Infinity, ymaxS = -Infinity;
    scaledLists.forEach((s) => {
      s.y.forEach((v) => {
        if (Number.isFinite(v)) {
          yminS = Math.min(yminS, v);
          ymaxS = Math.max(ymaxS, v);
        }
      });
    });
    if (!Number.isFinite(yminS) || !Number.isFinite(ymaxS)) { yminS = 0; ymaxS = 1; }
    let yrS = (ymaxS - yminS) || 1;
    const yPad = yrS * 0.08;
    if (Number.isFinite(opts.yMin)) yminS = opts.yMin / yScale;
    else yminS -= yPad;
    if (Number.isFinite(opts.yMax)) ymaxS = opts.yMax / yScale;
    else ymaxS += yPad;
    if (ymaxS <= yminS) ymaxS = yminS + 1;
    if (opts.yZeroLine && yminS < 0 && ymaxS > 0) {
      const yBound = Math.max(Math.abs(yminS), Math.abs(ymaxS));
      if (Number.isFinite(yBound) && yBound > 0) {
        yminS = -yBound;
        ymaxS = yBound;
      }
    }
    [yminS, ymaxS] = zoomYDomain(yminS, ymaxS, opts.yZoom, opts);
    yrS = (ymaxS - yminS) || 1;
    const x2px = (x) => padL + ((x - xmin) / xr) * plotW;
    const y2px = (yScaled) => padT + plotH - ((yScaled - yminS) / yrS) * plotH;
    const fmtTick = (v) => {
      const av = Math.abs(v);
      if (av >= 100) return v.toFixed(0);
      if (av >= 10) return v.toFixed(0);
      if (av >= 1) return v.toFixed(1).replace(/\.0$/, '');
      return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    };
    const fmtY = (v) => {
      const digits = Number.isFinite(opts.yTickDigits) ? Math.max(0, Math.floor(opts.yTickDigits)) : 2;
      const zeroCutoff = 0.5 * Math.pow(10, -digits);
      if (Math.abs(v) < zeroCutoff) return digits === 0 ? '0' : (0).toFixed(digits);
      const fixed = v.toFixed(digits);
      return fixed === '-0' || fixed === '-0.00' ? (digits === 0 ? '0' : (0).toFixed(digits)) : fixed;
    };

    parts.push(`<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#6b7280" stroke-width="1.2"/>`);
    for (let i = 0; i <= 5; i++) {
      const t = xmin + (xr * i / 5);
      const px = x2px(t);
      parts.push(`<line x1="${px.toFixed(2)}" y1="${padT}" x2="${px.toFixed(2)}" y2="${(padT + plotH).toFixed(2)}" stroke="#e8edf5" stroke-width="1"/>`);
      parts.push(`<text x="${px.toFixed(2)}" y="${(padT + plotH + 16).toFixed(2)}" text-anchor="middle" font-size="12" fill="#111827">${svgEscape(fmtTick(t))}</text>`);
    }
    const yTickSteps = opts.yZeroLine ? 4 : 5;
    for (let i = 0; i <= yTickSteps; i++) {
      const tS = yminS + (yrS * i / yTickSteps);
      const py = y2px(tS);
      parts.push(`<line x1="${padL}" y1="${py.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${py.toFixed(2)}" stroke="#e8edf5" stroke-width="1"/>`);
      parts.push(`<text x="${padL - 6}" y="${py.toFixed(2)}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="#111827">${svgEscape(fmtY(tS))}</text>`);
    }
    if (opts.yZeroLine && yminS < 0 && ymaxS > 0) {
      const py0 = y2px(0);
      parts.push(`<line x1="${padL}" y1="${py0.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${py0.toFixed(2)}" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="4 4"/>`);
    }
    if (xmin <= 0 && xmax >= 0) {
      const px0 = x2px(0);
      parts.push(`<line x1="${px0.toFixed(2)}" y1="${padT}" x2="${px0.toFixed(2)}" y2="${(padT + plotH).toFixed(2)}" stroke="#6b7280" stroke-width="1.1" stroke-dasharray="6 6"/>`);
    }
    if (useScientificY && yExp !== 0) {
      parts.push(svgSciOffset(padL + 2, padT - 2, yExp));
    }

    const clipId = `lineClip${Math.random().toString(36).slice(2)}`;
    parts.push(`<defs><clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`);
    parts.push(`<g clip-path="url(#${clipId})">`);
    scaledLists.forEach((s, i) => {
      const color = svgEscape(s.color || COLOR_PALETTE[i % COLOR_PALETTE.length]);
      const d = [];
      const n = Math.min(s.x.length, s.y.length);
      for (let k = 0; k < n; k++) {
        const x = Number(s.x[k]);
        const y = Number(s.y[k]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        d.push(`${d.length ? 'L' : 'M'}${x2px(x).toFixed(3)} ${y2px(y).toFixed(3)}`);
      }
      if (d.length) parts.push(`<path d="${d.join(' ')}" fill="none" stroke="${color}" stroke-width="2.2"/>`);
    });
    parts.push('</g>');

    if (scaledLists.length > 1 && opts.showLegend !== false) {
      const labels = scaledLists.map((s, i) => ({
        text: s.label || `Series ${i + 1}`,
        color: s.color || COLOR_PALETTE[i % COLOR_PALETTE.length],
      }));
      parts.push(svgLegend(labels, padL + plotW - 10, padT + 6, {
        fill: 'rgba(255,255,255,0.76)',
        stroke: 'rgba(203,213,225,0.9)',
      }));
    }

    parts.push(`<text x="${(padL + plotW / 2).toFixed(2)}" y="${(padT + plotH + 34).toFixed(2)}" text-anchor="middle" font-size="13" fill="#111827">${svgEscape(opts.xlabel || 'Bτ')}</text>`);
    const yLabel = opts.ylabelBase
      ? `${opts.ylabelBase}${opts.ylabelSub || ''}${opts.ylabelTail || ''}${opts.ylabelUnits ? ` ${opts.ylabelUnits}` : ''}`
      : (opts.ylabel || 'Value');
    parts.push(`<text transform="translate(16 ${(padT + plotH / 2).toFixed(2)}) rotate(-90)" text-anchor="middle" dominant-baseline="middle" font-size="13" fill="#111827">${svgEscape(yLabel)}</text>`);
    parts.push('</svg>');
    return parts.join('');
  }

  // polar plotting utility for anisotropic MR
  function drawPolar(canvas, anglesDeg, seriesList, opts={}) {
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 480;
    const H = canvas.clientHeight || 480;
    canvas.width = Math.max(1, Math.floor(W * dpi));
    canvas.height = Math.max(1, Math.floor(H * dpi));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const angles = Array.isArray(anglesDeg) ? anglesDeg : [];
    const series = Array.isArray(seriesList) ? seriesList : [];
    if (!angles.length || !series.length) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('No polar data', 16, 20);
      return;
    }

    // compute radial scale
    let maxVal = 0;
    series.forEach(s => {
      (s.values || []).forEach(v => {
        const a = Math.abs(v);
        if (a > maxVal) maxVal = a;
      });
    });
    if (maxVal <= 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('Polar data is zero', 16, 20);
      return;
    }

    const pad = 40;
    const radius = Math.max(10, Math.min(W, H) / 2 - pad);
    const cx = W / 2;
    const cy = H / 2;
    const scale = radius / maxVal;

    // draw grid (circles + cross axes)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    const rings = 4;
    for (let i = 1; i <= rings; i++) {
      const r = (radius * i) / rings;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-radius, 0); ctx.lineTo(radius, 0);
    ctx.moveTo(0, -radius); ctx.lineTo(0, radius);
    ctx.stroke();

    // draw series as polar curves
    series.forEach((s, idx) => {
      const vals = s.values || [];
      if (!vals.length) return;
      const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const n = Math.min(angles.length, vals.length);
      for (let i = 0; i < n; i++) {
        const ang = (angles[i] || 0) * Math.PI / 180;
        const r = (vals[i] || 0) * scale;
        const x = r * Math.cos(ang);
        const y = -r * Math.sin(ang);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    });
    ctx.restore();

    if (opts.showTitle !== false) {
      ctx.fillStyle = '#334155';
      ctx.font = '13px sans-serif';
      ctx.textBaseline = 'top';
      const title = opts.title || (opts.comp ? `ρ_${opts.comp} polar plot` : 'Polar plot');
      ctx.fillText(title, 16, 12);
    }

    if (opts.showLegend !== false) {
      ctx.font = '12px sans-serif';
      let y = opts.showTitle === false ? 12 : 32;
      series.forEach((s, idx) => {
        const btau = s.btau != null ? s.btau : null;
        const label = btau != null ? `Bτ=${btau}` : `Series ${idx + 1}`;
        const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
        ctx.fillStyle = color;
        ctx.fillRect(16, y + 5, 16, 2);
        ctx.fillStyle = '#334155';
        ctx.fillText(label, 38, y);
        y += 16;
      });
    }
  }

  function computeYBounds(values, fallbackTop = 1.0) {
    const vals = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
    if (!vals.length) return [0.0, fallbackTop];
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return [0.0, fallbackTop];
    const delta = yMax - yMin;
    if (Math.abs(delta) < 1e-30) {
      const base = Math.abs(yMax) || 1.0;
      yMin -= 0.05 * base;
      yMax += 0.10 * base;
    } else {
      yMin -= 0.05 * delta;
      yMax += 0.10 * delta;
    }
    if (yMax <= yMin) yMax = yMin + (Math.abs(yMin) || 1.0);
    return [yMin, yMax];
  }

  function sciFormatSetup(minV, maxV) {
    const maxAbs = Math.max(Math.abs(minV || 0), Math.abs(maxV || 0));
    if (!Number.isFinite(maxAbs) || maxAbs <= 0) return { exp: 0, scale: 1 };
    const exp = Math.floor(Math.log10(maxAbs));
    const scale = Math.pow(10, exp) || 1;
    return { exp, scale };
  }

  function fmtScaledTick(v) {
    const av = Math.abs(v);
    if (av >= 100) return v.toFixed(0);
    if (av >= 10) return v.toFixed(1);
    if (av >= 1) return v.toFixed(2);
    if (av >= 0.1) return v.toFixed(3);
    return v.toFixed(4);
  }

  function fmtOneDecimalTick(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(1) : '';
  }

  function sciExponent(exp) {
    const n = Number(exp);
    return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : null;
  }

  function drawSciOffset(ctx, x, y, exp, opts = {}) {
    const e = sciExponent(exp);
    if (e === null) return;
    const unit = opts.unit ? ' Ω·m·s' : '';
    const stroke = opts.stroke || null;
    const fill = opts.fill || '#111827';

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const drawText = (text, xx, yy) => {
      if (stroke) {
        ctx.lineWidth = stroke.width ?? 3;
        ctx.strokeStyle = stroke.color || 'rgba(255,255,255,0.92)';
        ctx.strokeText(text, xx, yy);
      }
      ctx.fillStyle = fill;
      ctx.fillText(text, xx, yy);
    };

    ctx.font = '10px sans-serif';
    const base = '×10';
    drawText(base, x, y);
    x += ctx.measureText(base).width;

    ctx.font = '8px sans-serif';
    const sup = String(e);
    drawText(sup, x, y - 5);
    x += ctx.measureText(sup).width;

    if (unit) {
      ctx.font = '10px sans-serif';
      drawText(unit, x, y);
    }
    ctx.restore();
  }

  function svgSciOffset(x, y, exp, opts = {}) {
    const e = sciExponent(exp);
    if (e === null) return '';
    const unit = opts.unit ? ' Ω·m·s' : '';
    const stroke = opts.stroke
      ? ` stroke="${opts.stroke.color || 'rgba(255,255,255,0.92)'}" stroke-width="${opts.stroke.width ?? 3}" paint-order="stroke fill"`
      : '';
    return `<text x="${x}" y="${y}" font-size="10" fill="${opts.fill || '#111827'}"${stroke}>×10<tspan baseline-shift="super" font-size="8">${e}</tspan>${unit}</text>`;
  }

  function drawLegendBox(ctx, labels, opts = {}) {
    if (!labels.length) return;
    const xRight = opts.xRight ?? 0;
    const yTop = opts.yTop ?? 0;
    const lineW = opts.lineW ?? 18;
    const lineH = opts.lineH ?? 10;
    const pad = opts.pad ?? 6;
    const gap = opts.gap ?? 10;
    const rowGap = opts.rowGap ?? 6;
    const fill = opts.fill ?? 'rgba(255,255,255,0.65)';
    const stroke = opts.stroke ?? 'rgba(0,0,0,0.15)';
    const text = opts.text ?? '#111827';
    const font = opts.font ?? '11px sans-serif';

    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidths = labels.map((l) => ctx.measureText(l.text).width);
    const boxW = Math.max(...textWidths.map((w) => w + lineW + gap)) + 2 * pad;
    const rowStep = lineH + rowGap;
    const boxH = labels.length * rowStep + 2 * pad;
    const x0 = xRight - boxW;
    const y0 = yTop;
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, boxW, boxH);
    if (stroke && stroke !== 'none' && stroke !== 'transparent') {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, boxW, boxH);
    }
    labels.forEach((l, idx) => {
      const yy = y0 + pad + idx * rowStep;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 + pad, yy + lineH / 2);
      ctx.lineTo(x0 + pad + lineW, yy + lineH / 2);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(l.text, x0 + pad + lineW + gap, yy + lineH / 2);
    });
    ctx.restore();
  }

  function boundsByScale(values, yScale, keepPositiveMin = false) {
    const vals = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
    if (!vals.length) return [keepPositiveMin ? 1e-6 : 0, 1];
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    let delta = maxV - minV;
    if (!(delta > 0)) delta = Math.max(Math.abs(maxV), 1) * 0.05;
    const s = Number.isFinite(yScale) && yScale >= 0 ? yScale : 0;
    let lower = minV - s * delta;
    let upper = maxV + s * delta;
    if (keepPositiveMin) {
      const eps = Math.max(1e-30, Math.abs(maxV) * 1e-9);
      if (!(lower > 0)) lower = eps;
      if (!(upper > lower)) upper = lower + Math.max(eps, delta);
    } else if (!(upper > lower)) {
      upper = lower + Math.max(1e-12, delta);
    }
    return [lower, upper];
  }

  // Draw anisotropic polar subplot in matplotlib-like style from rho_vs_angle.sh.
  function drawPolarMpl(canvas, anglesDeg, seriesList, opts = {}) {
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 240;
    const H = canvas.clientHeight || 220;
    canvas.width = Math.max(1, Math.floor(W * dpi));
    canvas.height = Math.max(1, Math.floor(H * dpi));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const angles = Array.isArray(anglesDeg) ? anglesDeg : [];
    const series = Array.isArray(seriesList) ? seriesList : [];
    if (!angles.length || !series.length) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('No polar data', 12, 20);
      return;
    }

    const allVals = [];
    series.forEach((s) => (s.values || []).forEach((v) => {
      const n = Number(v);
      if (Number.isFinite(n)) allVals.push(n);
    }));
    const useManual = Number.isFinite(opts.yMin) && Number.isFinite(opts.yMax) && opts.yMax > opts.yMin;
    const viewScale = Number.isFinite(opts.viewScale) && opts.viewScale >= 0 ? Number(opts.viewScale) : 0;
    let rMin;
    let rMax;
    if (useManual) {
      rMin = Number(opts.yMin);
      rMax = Number(opts.yMax);
      if (!(rMin > 0)) rMin = Math.max(1e-30, Math.abs(rMax) * 1e-9);
      if (!(rMax > rMin)) rMax = rMin + Math.max(1e-12, Math.abs(rMin));
    } else {
      [rMin, rMax] = boundsByScale(allVals, viewScale, true);
    }
    const rRange = Math.max(1e-30, rMax - rMin);
    const sci = sciFormatSetup(rMin, rMax);

    const pad = 26;
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.max(10, Math.min(W, H) / 2 - pad);
    const rings = 5;
    const angles15 = Array.from({ length: 24 }, (_, i) => i * 15);

    ctx.save();
    ctx.strokeStyle = 'rgba(107,114,128,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (let i = 1; i <= rings; i++) {
      const rr = (radius * i) / rings;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    angles15.forEach((deg) => {
      const a = deg * Math.PI / 180;
      const x2 = cx + radius * Math.sin(a);
      const y2 = cy - radius * Math.cos(a);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    });
    ctx.restore();

    // 30° labels, 15° unlabeled to mirror script.
    ctx.fillStyle = '#374151';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 15) {
      if (deg % 30 !== 0) continue;
      const a = deg * Math.PI / 180;
      const lx = cx + (radius + 15) * Math.sin(a);
      const ly = cy - (radius + 15) * Math.cos(a);
      ctx.fillText(`${deg}°`, lx, ly);
    }

    // Radial labels at 345° to stay away from the 30° angular label block.
    const rlabA = 345 * Math.PI / 180;
    const radialLabels = [];
    for (let i = 1; i <= rings; i++) {
      const rr = (radius * i) / rings;
      const raw = rMin + (rRange * i) / rings;
      const scaled = raw / sci.scale;
      radialLabels.push({
        text: fmtScaledTick(scaled),
        x: cx + rr * Math.sin(rlabA) + 6,
        y: cy - rr * Math.cos(rlabA) - 2,
      });
    }

    // Data lines (clip to polar boundary like matplotlib axes patch).
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    series.forEach((s, idx) => {
      const vals = Array.isArray(s.values) ? s.values : [];
      const n = Math.min(angles.length, vals.length);
      if (n < 2) return;
      const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = Number(angles[i]) * Math.PI / 180;
        const rv = Number(vals[i]);
        const rr = radius * ((rv - rMin) / rRange);
        const x = cx + rr * Math.sin(a);   // 0° at north, clockwise
        const y = cy - rr * Math.cos(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.restore();

    // Draw radial labels after data lines so text stays above the curves.
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '11px sans-serif';
    radialLabels.forEach(({ text, x, y }) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#374151';
      ctx.fillText(text, x, y);
    });
    if (sci.exp !== 0) {
      drawSciOffset(ctx, 8, 14, sci.exp, {
        unit: true,
        stroke: { color: 'rgba(255,255,255,0.92)', width: 3 },
      });
    }
    ctx.restore();

    if (opts.showLegend !== false) {
      const labels = series.map((s, idx) => {
        const bt = Number(s.btau);
        return {
          text: `Bτ=${Number.isFinite(bt) ? Math.round(bt) : idx + 1}`,
          color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
        };
      });
      drawLegendBox(ctx, labels, {
        xRight: W + 0.2,
        yTop: H - (labels.length * 9 + 6),
        lineW: 12,
        lineH: 7,
        pad: 3,
        gap: 5,
        rowGap: 2,
        font: '9px sans-serif',
        fill: 'rgba(255,255,255,0.6)',
        stroke: 'none',
        text: '#111827',
      });
    }
  }

  // Draw anisotropic cartesian subplot in matplotlib-like style from rho_vs_angle.sh.
  function drawCartMpl(canvas, seriesInput, opts = {}) {
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 240;
    const H = canvas.clientHeight || 220;
    canvas.width = Math.max(1, Math.floor(W * dpi));
    canvas.height = Math.max(1, Math.floor(H * dpi));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const list = Array.isArray(seriesInput)
      ? seriesInput.filter((s) => s && Array.isArray(s.x) && Array.isArray(s.y) && s.x.length > 1 && s.y.length > 1)
      : [];
    const padL = 40;
    const padR = 18;
    const padT = 10;
    const padB = 30;
    const plotW = Math.max(1, W - padL - padR);
    const plotH = Math.max(1, H - padT - padB);

    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);

    if (!list.length) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('No cart data', 12, 20);
      return;
    }

    // Script uses fixed [0,180] for x.
    const xmin = 0;
    const xmax = 180;
    const xr = 180;

    const allY = [];
    list.forEach((s) => s.y.forEach((v) => {
      const n = Number(v);
      if (Number.isFinite(n)) allY.push(n);
    }));
    const useManual = Number.isFinite(opts.yMin) && Number.isFinite(opts.yMax) && opts.yMax > opts.yMin;
    const viewScale = Number.isFinite(opts.viewScale) && opts.viewScale >= 0 ? Number(opts.viewScale) : 0;
    let ymin;
    let ymax;
    if (useManual) {
      ymin = Number(opts.yMin);
      ymax = Number(opts.yMax);
    } else {
      [ymin, ymax] = boundsByScale(allY, viewScale, false);
    }
    const yr = Math.max(1e-30, ymax - ymin);
    const sci = sciFormatSetup(ymin, ymax);
    const sciScale = sci.scale;

    const x2px = (x) => padL + ((x - xmin) / xr) * plotW;
    const y2px = (y) => padT + plotH - (((y / sciScale) - (ymin / sciScale)) / (yr / sciScale)) * plotH;

    // Grid and ticks.
    ctx.save();
    ctx.strokeStyle = 'rgba(107,114,128,0.45)';
    ctx.setLineDash([4, 3]);
    for (let x = 0; x <= 180; x += 30) {
      const px = x2px(x);
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      const yv = (ymin / sciScale) + ((ymax / sciScale) - (ymin / sciScale)) * (i / 5);
      const py = padT + plotH - (plotH * i / 5);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
      ctx.fillStyle = '#111827';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtOneDecimalTick(yv), padL - 4, py);
    }
    ctx.restore();

    ctx.fillStyle = '#111827';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let x = 0; x <= 180; x += 30) {
      ctx.fillText(String(x), x2px(x), padT + plotH + 4);
    }

    // exponent text like ScalarFormatter offset.
    if (sci.exp !== 0) {
      // Keep scientific-notation offset fully inside canvas to avoid top clipping.
      drawSciOffset(ctx, padL + 2, padT + 12, sci.exp);
    }

    // Lines (clip to axis rectangle like matplotlib).
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    list.forEach((s, idx) => {
      const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const n = Math.min(s.x.length, s.y.length);
      for (let i = 0; i < n; i++) {
        const x = Number(s.x[i]);
        const y = Number(s.y[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const px = x2px(x);
        const py = y2px(y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    ctx.restore();

    // Axis labels.
    ctx.fillStyle = '#111827';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('θ (°)', padL + plotW / 2, H - 12);
    if (opts.showYLabel) {
      ctx.save();
      ctx.translate(12, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ρ·τ (Ω·m·s)', 0, 0);
      ctx.restore();
    }

    if (opts.showLegend !== false) {
      const labels = list.map((s, idx) => ({
        text: s.label || `Series ${idx + 1}`,
        color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
      }));
      drawLegendBox(ctx, labels, {
        xRight: padL + plotW - 5,
        yTop: padT + 5,
        lineW: 12,
        lineH: 7,
        pad: 3,
        gap: 5,
        rowGap: 2,
        font: '9px sans-serif',
        fill: 'rgba(255,255,255,0.6)',
        stroke: 'rgba(0,0,0,0.10)',
        text: '#111827',
      });
    }
  }

  function svgEscape(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function svgLegend(labels, xRight, yTop, opts = {}) {
    if (!labels.length) return '';
    const pad = opts.pad ?? 6;
    const lineW = opts.lineW ?? 18;
    const lineH = opts.lineH ?? 10;
    const rowH = lineH + (opts.rowGap ?? 6);
    const gap = opts.gap ?? 10;
    const fontSize = opts.fontSize ?? 11;
    const maxText = Math.max(...labels.map((l) => String(l.text || '').length));
    const boxW = Math.max(50, lineW + gap + maxText * (fontSize * 0.62) + 2 * pad);
    const boxH = labels.length * rowH + 2 * pad;
    const x0 = xRight - boxW;
    const rows = labels.map((l, idx) => {
      const yy = yTop + pad + idx * rowH;
      const mid = yy + lineH / 2;
      return `<line x1="${x0 + pad}" y1="${mid}" x2="${x0 + pad + lineW}" y2="${mid}" stroke="${svgEscape(l.color)}" stroke-width="1.6"/><text x="${x0 + pad + lineW + gap}" y="${mid}" dominant-baseline="middle" font-size="${fontSize}" fill="${opts.text || '#111827'}">${svgEscape(l.text)}</text>`;
    }).join('');
    const stroke = opts.stroke === 'none' ? 'none' : (opts.stroke || 'rgba(0,0,0,0.10)');
    return `<g><rect x="${x0}" y="${yTop}" width="${boxW}" height="${boxH}" fill="${opts.fill || 'rgba(255,255,255,0.6)'}" stroke="${stroke}"/>${rows}</g>`;
  }

  function polarMplSvg(width, height, anglesDeg, seriesList, opts = {}) {
    const W = Math.max(1, Math.round(width || 240));
    const H = Math.max(1, Math.round(height || 220));
    const angles = Array.isArray(anglesDeg) ? anglesDeg : [];
    const series = Array.isArray(seriesList) ? seriesList : [];
    const base = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="100%" height="100%" fill="#ffffff"/>`];
    if (!angles.length || !series.length) {
      base.push('<text x="12" y="20" font-size="12" fill="#9ca3af">No polar data</text></svg>');
      return base.join('');
    }

    const allVals = [];
    series.forEach((s) => (s.values || []).forEach((v) => {
      const n = Number(v);
      if (Number.isFinite(n)) allVals.push(n);
    }));
    const viewScale = Number.isFinite(opts.viewScale) && opts.viewScale >= 0 ? Number(opts.viewScale) : 0;
    let rMin;
    let rMax;
    if (Number.isFinite(opts.yMin) && Number.isFinite(opts.yMax) && opts.yMax > opts.yMin) {
      rMin = Number(opts.yMin);
      rMax = Number(opts.yMax);
      if (!(rMin > 0)) rMin = Math.max(1e-30, Math.abs(rMax) * 1e-9);
    } else {
      [rMin, rMax] = boundsByScale(allVals, viewScale, true);
    }
    const rRange = Math.max(1e-30, rMax - rMin);
    const sci = sciFormatSetup(rMin, rMax);
    const pad = 26;
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.max(10, Math.min(W, H) / 2 - pad);
    const rings = 5;
    const clipId = `polarClip${Math.random().toString(36).slice(2)}`;

    base.push(`<defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${radius}"/></clipPath></defs>`);
    for (let i = 1; i <= rings; i++) {
      const rr = (radius * i) / rings;
      base.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="rgba(107,114,128,0.45)" stroke-width="1" stroke-dasharray="4 3"/>`);
    }
    for (let deg = 0; deg < 360; deg += 15) {
      const a = deg * Math.PI / 180;
      const x2 = cx + radius * Math.sin(a);
      const y2 = cy - radius * Math.cos(a);
      base.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="rgba(107,114,128,0.45)" stroke-width="1" stroke-dasharray="4 3"/>`);
      if (deg % 30 === 0) {
        const lx = cx + (radius + 15) * Math.sin(a);
        const ly = cy - (radius + 15) * Math.cos(a);
        base.push(`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#374151">${deg}°</text>`);
      }
    }

    base.push(`<g clip-path="url(#${clipId})">`);
    series.forEach((s, idx) => {
      const vals = Array.isArray(s.values) ? s.values : [];
      const n = Math.min(angles.length, vals.length);
      if (n < 2) return;
      const d = [];
      for (let i = 0; i < n; i++) {
        const a = Number(angles[i]) * Math.PI / 180;
        const rv = Number(vals[i]);
        const rr = radius * ((rv - rMin) / rRange);
        const x = cx + rr * Math.sin(a);
        const y = cy - rr * Math.cos(a);
        if (Number.isFinite(x) && Number.isFinite(y)) d.push(`${d.length ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`);
      }
      if (d.length) base.push(`<path d="${d.join(' ')}" fill="none" stroke="${COLOR_PALETTE[idx % COLOR_PALETTE.length]}" stroke-width="2"/>`);
    });
    base.push('</g>');

    const rlabA = 345 * Math.PI / 180;
    for (let i = 1; i <= rings; i++) {
      const rr = (radius * i) / rings;
      const raw = rMin + (rRange * i) / rings;
      const scaled = raw / sci.scale;
      const x = cx + rr * Math.sin(rlabA) + 6;
      const y = cy - rr * Math.cos(rlabA) - 2;
      base.push(`<text x="${x}" y="${y}" dominant-baseline="middle" font-size="11" fill="#374151" stroke="rgba(255,255,255,0.92)" stroke-width="3" paint-order="stroke fill">${svgEscape(fmtScaledTick(scaled))}</text>`);
    }
    if (sci.exp !== 0) base.push(svgSciOffset(8, 14, sci.exp, {
      unit: true,
      stroke: { color: 'rgba(255,255,255,0.92)', width: 3 },
    }));
    if (opts.showLegend !== false) {
      const labels = series.map((s, idx) => {
        const bt = Number(s.btau);
        return { text: `Bτ=${Number.isFinite(bt) ? Math.round(bt) : idx + 1}`, color: COLOR_PALETTE[idx % COLOR_PALETTE.length] };
      });
      base.push(svgLegend(labels, W + 0.2, H - (labels.length * 9 + 6), {
        lineW: 12,
        lineH: 7,
        pad: 3,
        gap: 5,
        rowGap: 2,
        fontSize: 9,
        fill: 'rgba(255,255,255,0.6)',
        stroke: 'none',
      }));
    }
    base.push('</svg>');
    return base.join('');
  }

  function cartMplSvg(width, height, seriesInput, opts = {}) {
    const W = Math.max(1, Math.round(width || 240));
    const H = Math.max(1, Math.round(height || 220));
    const list = Array.isArray(seriesInput)
      ? seriesInput.filter((s) => s && Array.isArray(s.x) && Array.isArray(s.y) && s.x.length > 1 && s.y.length > 1)
      : [];
    const padL = 40, padR = 18, padT = 10, padB = 30;
    const plotW = Math.max(1, W - padL - padR);
    const plotH = Math.max(1, H - padT - padB);
    const base = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="100%" height="100%" fill="#ffffff"/>`, `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#6b7280" stroke-width="1"/>`];
    if (!list.length) {
      base.push('<text x="12" y="20" font-size="12" fill="#9ca3af">No cart data</text></svg>');
      return base.join('');
    }
    const xmin = 0, xr = 180;
    const allY = [];
    list.forEach((s) => s.y.forEach((v) => { const n = Number(v); if (Number.isFinite(n)) allY.push(n); }));
    const viewScale = Number.isFinite(opts.viewScale) && opts.viewScale >= 0 ? Number(opts.viewScale) : 0;
    let ymin, ymax;
    if (Number.isFinite(opts.yMin) && Number.isFinite(opts.yMax) && opts.yMax > opts.yMin) {
      ymin = Number(opts.yMin); ymax = Number(opts.yMax);
    } else {
      [ymin, ymax] = boundsByScale(allY, viewScale, false);
    }
    const yr = Math.max(1e-30, ymax - ymin);
    const sci = sciFormatSetup(ymin, ymax);
    const sciScale = sci.scale;
    const x2px = (x) => padL + ((x - xmin) / xr) * plotW;
    const y2px = (y) => padT + plotH - (((y / sciScale) - (ymin / sciScale)) / (yr / sciScale)) * plotH;
    for (let x = 0; x <= 180; x += 30) {
      const px = x2px(x);
      base.push(`<line x1="${px}" y1="${padT}" x2="${px}" y2="${padT + plotH}" stroke="rgba(107,114,128,0.45)" stroke-width="1" stroke-dasharray="4 3"/>`);
      base.push(`<text x="${px}" y="${padT + plotH + 15}" text-anchor="middle" font-size="11" fill="#111827">${x}</text>`);
    }
    for (let i = 0; i <= 5; i++) {
      const yv = (ymin / sciScale) + ((ymax / sciScale) - (ymin / sciScale)) * (i / 5);
      const py = padT + plotH - (plotH * i / 5);
      base.push(`<line x1="${padL}" y1="${py}" x2="${padL + plotW}" y2="${py}" stroke="rgba(107,114,128,0.45)" stroke-width="1" stroke-dasharray="4 3"/>`);
      base.push(`<text x="${padL - 4}" y="${py}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#111827">${svgEscape(fmtOneDecimalTick(yv))}</text>`);
    }
    if (sci.exp !== 0) base.push(svgSciOffset(padL + 2, padT + 12, sci.exp));
    const clipId = `cartClip${Math.random().toString(36).slice(2)}`;
    base.push(`<defs><clipPath id="${clipId}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs><g clip-path="url(#${clipId})">`);
    list.forEach((s, idx) => {
      const n = Math.min(s.x.length, s.y.length);
      const d = [];
      for (let i = 0; i < n; i++) {
        const x = Number(s.x[i]);
        const y = Number(s.y[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        d.push(`${d.length ? 'L' : 'M'}${x2px(x).toFixed(3)} ${y2px(y).toFixed(3)}`);
      }
      if (d.length) base.push(`<path d="${d.join(' ')}" fill="none" stroke="${COLOR_PALETTE[idx % COLOR_PALETTE.length]}" stroke-width="2"/>`);
    });
    base.push('</g>');
    base.push(`<text x="${padL + plotW / 2}" y="${H - 3}" text-anchor="middle" font-size="11" fill="#111827">θ (°)</text>`);
    if (opts.showYLabel) {
      base.push(`<text transform="translate(12 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#111827">ρ·τ (Ω·m·s)</text>`);
    }
    if (opts.showLegend !== false) {
      const labels = list.map((s, idx) => ({ text: s.label || `Series ${idx + 1}`, color: COLOR_PALETTE[idx % COLOR_PALETTE.length] }));
      base.push(svgLegend(labels, padL + plotW - 5, padT + 5, {
        lineW: 12,
        lineH: 7,
        pad: 3,
        gap: 5,
        rowGap: 2,
        fontSize: 9,
        fill: 'rgba(255,255,255,0.6)',
        stroke: 'rgba(0,0,0,0.10)',
      }));
    }
    base.push('</svg>');
    return base.join('');
  }

  function downloadSvg(svgText, filename) {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function initMR() {
    const id = matId();
    if (!id) return;
    const surfaceSelA = $('#mrSurfaceA');
    const surfaceSelB = $('#mrSurfaceB');
    const angleCompareSel = $('#mrAngle');
    const fixedAngleSel = $('#mrFixedAngle');
    const fixedTempSel = $('#mrFixedTemp');
    const muSelA = $('#mrMuA');
    const muSelB = $('#mrMuB');
    const tempCompareSel = $('#mrTemp');
    const compSelA = $('#mrCompA');
    const compSelB = $('#mrCompB');
    const compPrettyA = $('#mrCompPrettyA');
    const compPrettyB = $('#mrCompPrettyB');
    const compMenuA = $('#mrCompMenuA');
    const compMenuB = $('#mrCompMenuB');
    const downloadAllBtn = $('#mrDownloadAllBtn');
    const anglePickerEl = $('#mrAnglePicker');
    const tempPickerEl = $('#mrTempPicker');
    const mrAngleDegByName = new Map();
    const canvasRhoA = $('#mrPlotRhoA');
    const canvasSigmaA = $('#mrPlotSigmaA');
    const canvasMRA = $('#mrPlotMRA');
    const canvasRhoB = $('#mrPlotRhoB');
    const canvasSigmaB = $('#mrPlotSigmaB');
    const canvasMRB = $('#mrPlotMRB');
    const mrWrapA = $('#mrPlotMRWrapA');
    const mrWrapB = $('#mrPlotMRWrapB');
    const plotsA = $('#mrCompareAngleCard .mr-card-plots');
    const plotsB = $('#mrCompareTempCard .mr-card-plots');
    const statusA = $('#mrStatusA');
    const statusB = $('#mrStatusB');
    const zoomXA = $('#mrZoomXA');
    const zoomYA = $('#mrZoomYA');
    const zoomXB = $('#mrZoomXB');
    const zoomYB = $('#mrZoomYB');
    const zoomXAValue = $('#mrZoomXAValue');
    const zoomYAValue = $('#mrZoomYAValue');
    const zoomXBValue = $('#mrZoomXBValue');
    const zoomYBValue = $('#mrZoomYBValue');
    const mrCellHostA = $('#mrCellViewerA');
    const mrCellHostB = $('#mrCellViewerB');
    const mrCellReadoutA = $('#mrCellReadoutA');
    const mrCellReadoutB = $('#mrCellReadoutB');
    let mrCellViewerA = null;
    let mrCellViewerB = null;
    if (!surfaceSelA || !surfaceSelB || !angleCompareSel || !fixedAngleSel || !fixedTempSel || !muSelA || !muSelB || !tempCompareSel || !compSelA || !compSelB) return;

    // initial sizes for canvas
    const resizePlots = () => {
      [canvasRhoA, canvasSigmaA, canvasRhoB, canvasSigmaB].forEach(c => {
        if (!c) return;
        c.style.width = '100%';
        c.style.height = '185px';
      });
      [canvasMRA, canvasMRB].forEach(c => {
        if (!c) return;
        c.style.width = '100%';
        c.style.height = '390px';
      });
    };
    resizePlots();

    const exportStem = () => String(id || 'material')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'material';

    const addCanvasSvgDownload = (canvas, suffix) => {
      const wrap = canvas?.closest?.('.plot-wrap');
      if (!canvas || !wrap || wrap.querySelector('.mr-plot-download')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mr-plot-download';
      btn.textContent = 'SVG';
      btn.title = 'Download this plot as SVG';
      btn.addEventListener('click', () => {
        const svg = canvas.__mrPlotSvg || makeLinePlotSvg(canvas.clientWidth || 480, canvas.clientHeight || 220, null, {});
        downloadSvg(svg, `${exportStem()}_${suffix}.svg`);
      });
      wrap.appendChild(btn);
    };

    const addCellSvgDownload = (host, getViewer, suffix) => {
      const head = host?.closest?.('.mr-cell-card')?.querySelector?.('.mr-cell-head');
      if (!head || head.querySelector('.mr-cell-download')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mr-plot-download mr-cell-download';
      btn.textContent = 'Download SVG';
      btn.title = 'Download this Conventional Cell as SVG';
      btn.addEventListener('click', () => {
        const viewer = getViewer?.() || host?.__crystalViewer;
        if (!viewer || typeof viewer.exportSVG !== 'function') return;
        downloadSvg(viewer.exportSVG(), `${exportStem()}_${suffix}.svg`);
      });
      const badge = head.querySelector('.mr-cell-badge');
      if (badge) head.insertBefore(btn, badge);
      else head.appendChild(btn);
    };

    addCanvasSvgDownload(canvasMRA, 'mr_comparison_A_MR');
    addCanvasSvgDownload(canvasRhoA, 'mr_comparison_A_rho_total');
    addCanvasSvgDownload(canvasSigmaA, 'mr_comparison_A_sigma_total');
    addCanvasSvgDownload(canvasMRB, 'mr_comparison_B_MR');
    addCanvasSvgDownload(canvasRhoB, 'mr_comparison_B_rho_total');
    addCanvasSvgDownload(canvasSigmaB, 'mr_comparison_B_sigma_total');
    addCellSvgDownload(mrCellHostA, () => mrCellViewerA, 'mr_comparison_A_conventional_cell');
    addCellSvgDownload(mrCellHostB, () => mrCellViewerB, 'mr_comparison_B_conventional_cell');

    async function downloadMrBlockImage() {
      if (!downloadAllBtn) return;
      const oldText = downloadAllBtn.textContent;
      downloadAllBtn.disabled = true;
      downloadAllBtn.textContent = 'Rendering...';
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const loadImage = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
        const captureCanvas = async (canvas) => {
          if (!canvas) return null;
          try {
            return await loadImage(canvas.toDataURL('image/png'));
          } catch (e) {
            return null;
          }
        };
        const captureViewer = async (host) => {
          try {
            const viewer = host?.__crystalViewer;
            if (viewer && typeof viewer.capturePNG === 'function') return await loadImage(viewer.capturePNG());
            const canvas = host?.querySelector('canvas');
            return canvas ? await captureCanvas(canvas) : null;
          } catch (e) {
            return null;
          }
        };
        const selectedText = (selectEl) => {
          const opt = selectEl?.selectedOptions?.[0];
          return opt ? opt.textContent.trim() : (selectEl?.value || '-');
        };
        const multiText = (selectEl) => {
          const vals = Array.from(selectEl?.selectedOptions || []).map((o) => o.textContent.trim()).filter(Boolean);
          return vals.length ? vals.join(', ') : '-';
        };
        const compText = (comp) => `ρ${String(comp || '').toLowerCase()}`;
        const isVisible = (el) => !!el && window.getComputedStyle(el).display !== 'none';
        const data = [
          {
            title: 'Comparison A: fixed temperature, compare different angles',
            mode: 'By angle',
            controls: [
              ['Plane', selectedText(surfaceSelA)],
              ['Fermi level (meV)', selectedText(muSelA)],
              ['Component', compText(compSelA.value)],
              ['Temperature', selectedText(fixedTempSel)],
              ['Angle', multiText(angleCompareSel)],
            ],
            showMR: isVisible(mrWrapA),
            status: statusA?.textContent || '',
            cellTitle: 'Conventional Cell',
            cellSubtitle: mrCellReadoutA?.textContent || '',
            plots: [
              { title: 'MR curve', canvas: canvasMRA, primary: true, visible: isVisible(mrWrapA) },
              { title: 'ρ_total curve', canvas: canvasRhoA, primary: false, visible: true },
              { title: 'σ_total curve', canvas: canvasSigmaA, primary: false, visible: true },
            ],
            cellHost: mrCellHostA,
          },
          {
            title: 'Comparison B: fixed angle, compare different temperatures',
            mode: 'By temperature',
            controls: [
              ['Plane', selectedText(surfaceSelB)],
              ['Fermi level (meV)', selectedText(muSelB)],
              ['Component', compText(compSelB.value)],
              ['Angle', selectedText(fixedAngleSel)],
              ['Temperature', multiText(tempCompareSel)],
            ],
            showMR: isVisible(mrWrapB),
            status: statusB?.textContent || '',
            cellTitle: 'Conventional Cell',
            cellSubtitle: mrCellReadoutB?.textContent || '',
            plots: [
              { title: 'MR curve', canvas: canvasMRB, primary: true, visible: isVisible(mrWrapB) },
              { title: 'ρ_total curve', canvas: canvasRhoB, primary: false, visible: true },
              { title: 'σ_total curve', canvas: canvasSigmaB, primary: false, visible: true },
            ],
            cellHost: mrCellHostB,
          },
        ];
        for (const card of data) {
          for (const plot of card.plots) plot.img = plot.visible ? await captureCanvas(plot.canvas) : null;
          card.cellImg = await captureViewer(card.cellHost);
        }

        const scale = 2;
        const width = 1800;
        const margin = 36;
        const gap = 28;
        const cardW = width - margin * 2;
        const cardPad = 28;
        const cellW = 520;
        const mainW = cardW - cardPad * 2 - cellW - 28;
        const controlH = 140;
        const statusH = 58;
        const cardH = 940;
        const height = margin + 62 + data.length * cardH + (data.length - 1) * gap + margin;
        const out = document.createElement('canvas');
        out.width = width * scale;
        out.height = height * scale;
        const ctx = out.getContext('2d');
        ctx.scale(scale, scale);
        const rr = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };
        const drawText = (text, x, y, opts = {}) => {
          ctx.save();
          ctx.fillStyle = opts.color || '#111827';
          ctx.font = opts.font || '16px Arial, sans-serif';
          ctx.textAlign = opts.align || 'left';
          ctx.textBaseline = opts.baseline || 'top';
          ctx.fillText(String(text || ''), x, y);
          ctx.restore();
        };
        const wrapText = (text, x, y, maxW, lineH, opts = {}) => {
          const words = String(text || '').split(/\s+/);
          let line = '';
          let yy = y;
          ctx.save();
          ctx.fillStyle = opts.color || '#64748b';
          ctx.font = opts.font || '16px Arial, sans-serif';
          words.forEach((word) => {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxW && line) {
              ctx.fillText(line, x, yy);
              line = word;
              yy += lineH;
            } else {
              line = test;
            }
          });
          if (line) ctx.fillText(line, x, yy);
          ctx.restore();
          return yy + lineH;
        };
        const drawPill = (text, x, y, w) => {
          ctx.save();
          rr(x, y, w, 34, 8);
          ctx.fillStyle = '#eaf2ff';
          ctx.strokeStyle = '#dbe7ff';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          drawText(text, x + w / 2, y + 8, { align: 'center', font: 'bold 15px Arial, sans-serif', color: '#2457b8' });
          ctx.restore();
        };
        const drawControl = ([label, value], x, y, w) => {
          drawText(label, x, y, { font: 'bold 15px Arial, sans-serif', color: '#1f2937' });
          rr(x, y + 24, w, 44, 9);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#d9dee9';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          wrapText(value, x + 14, y + 37, w - 28, 16, { font: '17px Arial, sans-serif', color: '#111827' });
        };
        const drawImageInBox = (img, x, y, w, h) => {
          ctx.save();
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, w, h);
          if (img) {
            const iw = img.naturalWidth || img.width || w;
            const ih = img.naturalHeight || img.height || h;
            const ratio = Math.min(w / iw, h / ih);
            const dw = iw * ratio;
            const dh = ih * ratio;
            ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
          } else {
            drawText('Image unavailable', x + 12, y + 12, { color: '#64748b' });
          }
          ctx.restore();
        };

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        rr(margin, margin, cardW, 50, 12);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.fillStyle = '#2563eb';
        rr(margin + 2, margin + 12, 8, 24, 5);
        ctx.fill();
        drawText('MR & Hall', margin + 20, margin + 12, { font: 'bold 24px Arial, sans-serif' });

        let y = margin + 62;
        data.forEach((card) => {
          rr(margin, y, cardW, cardH, 14);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#dfe4ee';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          const x0 = margin + cardPad;
          const y0 = y + cardPad;
          drawText(card.title, x0, y0, { font: 'bold 24px Arial, sans-serif' });
          drawPill(card.mode, margin + cardW - cardPad - 126, y0 - 3, 126);

          const controlTop = y0 + 56;
          const smallW = (mainW - 42) / 4;
          card.controls.slice(0, 4).forEach((control, idx) => drawControl(control, x0 + idx * (smallW + 14), controlTop, smallW));
          drawControl(card.controls[4], x0, controlTop + 78, mainW, 78);

          const plotsTop = controlTop + controlH + 22;
          if (card.showMR) {
            drawText('MR curve', x0 + mainW * 0.27, plotsTop, { font: 'bold 22px Arial, sans-serif', align: 'center' });
            drawText('ρ_total curve', x0 + mainW * 0.76, plotsTop, { font: 'bold 20px Arial, sans-serif', align: 'center' });
            drawText('σ_total curve', x0 + mainW * 0.76, plotsTop + 310, { font: 'bold 20px Arial, sans-serif', align: 'center' });
            drawImageInBox(card.plots[0].img, x0, plotsTop + 34, 610, 540);
            drawImageInBox(card.plots[1].img, x0 + 660, plotsTop + 34, mainW - 660, 260);
            drawImageInBox(card.plots[2].img, x0 + 660, plotsTop + 344, mainW - 660, 260);
          } else {
            const halfW = (mainW - 26) / 2;
            drawText('ρ_total curve', x0 + halfW / 2, plotsTop, { font: 'bold 22px Arial, sans-serif', align: 'center' });
            drawText('σ_total curve', x0 + halfW + 26 + halfW / 2, plotsTop, { font: 'bold 22px Arial, sans-serif', align: 'center' });
            drawImageInBox(card.plots[1].img, x0, plotsTop + 34, halfW, 560);
            drawImageInBox(card.plots[2].img, x0 + halfW + 26, plotsTop + 34, halfW, 560);
          }

          const statusY = y + cardH - cardPad - statusH;
          rr(x0, statusY, mainW, statusH, 10);
          ctx.fillStyle = '#eff6ff';
          ctx.fill();
          drawText(`i  ${card.status}`, x0 + 22, statusY + 18, { font: 'bold 18px Arial, sans-serif', color: '#2457b8' });

          const cellX = x0 + mainW + 28;
          rr(cellX, y0 + 42, cellW, cardH - cardPad * 2 - 42, 12);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#dfe4ee';
          ctx.fill();
          ctx.stroke();
          drawText(card.cellTitle, cellX + 20, y0 + 62, { font: 'bold 21px Arial, sans-serif' });
          wrapText(card.cellSubtitle, cellX + 20, y0 + 92, cellW - 160, 19, { font: '16px Arial, sans-serif' });
          drawPill('Plane + B', cellX + cellW - 132, y0 + 66, 104);
          ctx.strokeStyle = '#edf1f7';
          ctx.beginPath();
          ctx.moveTo(cellX, y0 + 146);
          ctx.lineTo(cellX + cellW, y0 + 146);
          ctx.stroke();
          drawImageInBox(card.cellImg, cellX + 12, y0 + 158, cellW - 24, cardH - cardPad * 2 - 210);

          y += cardH + gap;
        });

        const safeId = String(id || 'material').replace(/[^\w.-]+/g, '_');
        const filename = `${safeId}_MR_Plots.png`;
        await new Promise((resolve) => {
          out.toBlob((pngBlob) => {
            if (!pngBlob) {
              const a = document.createElement('a');
              a.href = out.toDataURL('image/png');
              a.download = filename;
              a.click();
              resolve();
              return;
            }
            const pngUrl = URL.createObjectURL(pngBlob);
            const a = document.createElement('a');
            a.href = pngUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(pngUrl), 500);
            resolve();
          }, 'image/png');
        });
      } catch (e) {
        setHint('MR Plots image export failed');
      } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.textContent = oldText;
      }
    }

    try {
      const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/surfaces`);
      const surfaces = data.surfaces || [];
      if (!surfaces.length) { showBlock(false); return; }
      showBlock(true);
      optionize(surfaceSelA, surfaces, prettySurface, (s)=>s);
      optionize(surfaceSelB, surfaces, prettySurface, (s)=>s);
    } catch (e) {
      showBlock(false);
      return;
    }

    setupPrettySelect(compSelA, compPrettyA, compMenuA);
    setupPrettySelect(compSelB, compPrettyB, compMenuB);

    async function setupMrCellViewer() {
      if ((!mrCellHostA && !mrCellHostB) || !window.CrystalViewer) return;
      try {
        const detail = await apiGet(`/api/materials/${encodeURIComponent(id)}`);
        const cell = detail?.bposcar || detail?.poscar || null;
        if (!cell) {
          if (mrCellReadoutA) mrCellReadoutA.textContent = 'No conventional-cell structure data';
          if (mrCellReadoutB) mrCellReadoutB.textContent = 'No conventional-cell structure data';
          return;
        }
        const buildOptions = {
          supercell: [1, 1, 1],
          showBonds: false,
          showCell: true,
          showCellFaces: true,
          completeBoundaryAtoms: true,
          boundaryAtomEps: 5e-3,
          showAxes: true,
          backgroundColor: 0xffffff,
          atomRadius: 0.28,
          atomMetalness: 0.58,
          atomRoughness: 0.22,
          bondRadius: 0.045,
          bondColor: 0x111111,
          bondFactor: 1.08,
          bondMaxCut: 3.0,
          bondMetalness: 0.15,
          bondRoughness: 0.48,
          cellFaceColor: 0xf2d2b6,
          cellFaceOpacity: 0.12,
          cellEdgeColor: 0x111111,
          cellEdgeOpacity: 0.95,
          initialZoom: 0.5,
          axesViewportMargin: 8,
        };
        if (mrCellHostA) {
          mrCellViewerA = new CrystalViewer(mrCellHostA);
          mrCellViewerA.build(cell, buildOptions);
        }
        if (mrCellHostB) {
          mrCellViewerB = new CrystalViewer(mrCellHostB);
          mrCellViewerB.build(cell, buildOptions);
        }
        updateMrCellOverlay();
      } catch (e) {
        if (mrCellReadoutA) mrCellReadoutA.textContent = 'Cell overlay unavailable';
        if (mrCellReadoutB) mrCellReadoutB.textContent = 'Cell overlay unavailable';
      }
    }

    const fmtScalar = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v ?? '');
      return n.toFixed(Math.abs(n - Math.round(n)) < 1e-6 ? 0 : 1);
    };

    const parseAngleName = (name) => {
      const m = String(name || '').match(/Btheta_([\-\d\.]+)_Bphi_([\-\d\.]+)/);
      if (!m) return null;
      return { theta: parseFloat(m[1]), phi: parseFloat(m[2]) };
    };

    const angleLabel = (name) => {
      const opt = Array.from(fixedAngleSel.options || []).find(o => o.value === name)
        || Array.from(angleCompareSel.options || []).find(o => o.value === name);
      if (opt) return opt.textContent;
      const parsed = parseAngleName(name);
      if (parsed) return formatAngleLabel(parsed.theta, parsed.phi);
      return name;
    };

    const planeAngleDeg = (name, surface) => {
      const mapped = mrAngleDegByName.get(`${surface}::${name}`);
      if (Number.isFinite(mapped)) return mapped;
      const parsed = parseAngleName(name);
      if (!parsed) return NaN;
      const th = (Number(parsed.theta) || 0) * Math.PI / 180;
      const ph = (Number(parsed.phi) || 0) * Math.PI / 180;
      const aComp = Math.sin(th) * Math.cos(ph);
      const bComp = Math.sin(th) * Math.sin(ph);
      const cComp = Math.cos(th);
      let angle;
      if (surface === 'Rb_Rc_surface') {
        // bc plane: the data folders are generated as two spherical-coordinate
        // branches, Bphi=+b and Bphi=-b.  Use that native convention directly:
        // +b branch maps to 90°-Btheta, -b branch maps to 90°+Btheta.
        const phiSign = Math.sin(ph);
        if (Math.abs(phiSign) > 1e-8) {
          let deg = phiSign >= 0 ? (90 - parsed.theta) : (90 + parsed.theta);
          deg = ((deg % 360) + 360) % 360;
          const snapped = Math.round(deg / 5) * 5;
          return Math.abs(snapped - deg) < 1e-6 ? snapped : deg;
        }
        angle = Math.atan2(cComp, bComp);
      } else if (surface === 'Rc_Ra_surface') {
        // ca plane: 0° starts from c, rotating toward a.
        angle = Math.atan2(aComp, cComp);
      } else {
        // ab plane: 0° starts from a, rotating toward b.
        angle = Math.atan2(bComp, aComp);
      }
      let deg = angle * 180 / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      if (Math.abs(deg - 360) < 1e-6) deg = 0;
      return deg;
    };

    const compactAngleLabel = (name, surface = surfaceSelA.value) => {
      const parsed = parseAngleName(name);
      if (!parsed) return angleLabel(name);
      const angleDeg = planeAngleDeg(name, surface);
      if (!Number.isFinite(angleDeg)) return angleLabel(name);
      return `${fmtScalar(angleDeg)}°`;
    };

    const tempLabel = (v) => `${fmtScalar(v)} K`;
    const selectedValues = (selectEl) =>
      Array.from(selectEl.selectedOptions || []).map(o => o.value).filter(Boolean);
    const selectedTempsB = () =>
      selectedValues(tempCompareSel).map(v => parseFloat(v)).filter(v => !isNaN(v));
    const isDiagonalRhoComponent = (comp) => ['xx', 'yy', 'zz'].includes(String(comp || '').toLowerCase());
    const isOddTensorComponent = (comp) => ['xy', 'xz', 'yx', 'yz', 'zx', 'zy'].includes(String(comp || '').toLowerCase());

    function setupMultiPicker(selectEl, pickerEl, labelFor, placeholder) {
      if (!selectEl || !pickerEl) return { sync: () => {} };
      pickerEl.innerHTML = `
        <button class="mr-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
          <span class="mr-picker-values"></span>
        </button>
        <div class="mr-picker-menu" role="listbox" aria-multiselectable="true"></div>
      `;
      const trigger = pickerEl.querySelector('.mr-picker-trigger');
      const valuesEl = pickerEl.querySelector('.mr-picker-values');
      const menuEl = pickerEl.querySelector('.mr-picker-menu');

      const close = () => {
        pickerEl.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      };

      const sync = () => {
        const options = Array.from(selectEl.options || []);
        const selected = options.filter(o => o.selected);
        valuesEl.innerHTML = '';
        if (!selected.length) {
          const empty = document.createElement('span');
          empty.className = 'mr-picker-empty';
          empty.textContent = placeholder;
          valuesEl.appendChild(empty);
        } else {
          selected.forEach((opt) => {
            const chip = document.createElement('span');
            chip.className = 'mr-chip';
            chip.innerHTML = `${escapeHTML(labelFor(opt.value, opt.textContent))}<button type="button" aria-label="Remove">×</button>`;
            const remove = chip.querySelector('button');
            remove.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              opt.selected = false;
              selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            });
            valuesEl.appendChild(chip);
          });
        }

        menuEl.innerHTML = '';
        options.forEach((opt) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'mr-picker-option';
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
          row.innerHTML = `<span class="mr-picker-check"></span><span>${escapeHTML(labelFor(opt.value, opt.textContent))}</span>`;
          row.addEventListener('click', (e) => {
            e.preventDefault();
            opt.selected = !opt.selected;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          });
          menuEl.appendChild(row);
        });
      };

      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        const open = pickerEl.classList.toggle('open');
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        sync();
      });
      document.addEventListener('click', (e) => {
        if (!pickerEl.contains(e.target)) close();
      });
      selectEl.addEventListener('change', sync);
      sync();
      return { sync };
    }

    const anglePicker = setupMultiPicker(angleCompareSel, anglePickerEl, (v) => compactAngleLabel(v, surfaceSelA.value), 'Select angles');
    const tempPicker = setupMultiPicker(tempCompareSel, tempPickerEl, (v) => tempLabel(v), 'Select temperatures');

    const chooseClosestOption = (selectEl, target, numericFromValue = (v) => Number(v)) => {
      const opts = Array.from(selectEl.options || []);
      if (!opts.length) return;
      let best = opts[0];
      let bestDist = Infinity;
      opts.forEach((opt) => {
        const n = numericFromValue(opt.value);
        const dist = Number.isFinite(n) ? Math.abs(n - target) : Infinity;
        if (dist < bestDist) {
          best = opt;
          bestDist = dist;
        }
      });
      selectEl.value = best.value;
    };

    const angleMetric = (name, surface = surfaceSelA.value) => {
      return planeAngleDeg(name, surface);
    };

    function selectPreferredAngles(selectEl = angleCompareSel, surface = surfaceSelA.value) {
      const opts = Array.from(selectEl.options || []);
      opts.forEach(o => { o.selected = false; });
      const preferred = [0, 30, 45, 60, 90];
      preferred.forEach((target) => {
        const opt = opts.find(o => Math.abs(angleMetric(o.value, surface) - target) < 1e-6);
        if (opt) opt.selected = true;
      });
      if (!opts.some(o => o.selected)) opts.slice(0, Math.min(5, opts.length)).forEach(o => { o.selected = true; });
    }

    function selectPreferredTemps() {
      const opts = Array.from(tempCompareSel.options || []);
      opts.forEach(o => { o.selected = false; });
      const preferred = [70, 130, 190, 250, 310];
      preferred.forEach((target) => {
        const opt = opts.find(o => Math.abs(parseFloat(o.value) - target) < 1e-6);
        if (opt) opt.selected = true;
      });
      if (!opts.some(o => o.selected)) opts.slice(0, Math.min(5, opts.length)).forEach(o => { o.selected = true; });
    }

    function updateFieldArrow(){
      try {
        const s = surfaceSelA.value;
        const ang = selectedValues(angleCompareSel)[0] || fixedAngleSel.value || '';
        const m = ang.match(/Btheta_([\-\d\.]+)_Bphi_([\-\d\.]+)/);
        if (!m) { if (window.viewerPOS?.setFieldDirection) { viewerPOS.setFieldDirection(null); viewerBPOS.setFieldDirection(null); } return; }
        const th = parseFloat(m[1]);
        const ph = parseFloat(m[2]);
        if (window.viewerPOS?.setFieldFromAngles) viewerPOS.setFieldFromAngles(s, th, ph);
        if (window.viewerBPOS?.setFieldFromAngles) viewerBPOS.setFieldFromAngles(s, th, ph);
      } catch(e){}
    }

    function updateMrCellOverlay() {
      const applyFields = (viewer, readout, surface, angleNames, fallbackText, emptyText) => {
        if (!viewer || typeof viewer.setMrPlaneAndFields !== 'function') return;
        const fields = (angleNames || [])
          .map((angleName, idx) => {
            const parsed = parseAngleName(angleName);
            if (!parsed) return null;
            return {
              theta: parsed.theta,
              phi: parsed.phi,
              angleDeg: angleMetric(angleName, surface),
              color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
              label: compactAngleLabel(angleName, surface),
            };
          })
          .filter(Boolean);
        if (!surface || !fields.length) {
          viewer.clearMrOverlay?.();
          if (readout) readout.textContent = fallbackText;
          return;
        }
        viewer.setMrPlaneAndFields(surface, fields);
        if (readout) {
          const labelText = fields.length <= 6
            ? fields.map((field) => field.label).join(', ')
            : `${fields.length} directions`;
          readout.textContent = `${prettySurface(surface)} highlighted; B directions ${labelText || emptyText}`;
        }
      };
      applyFields(
        mrCellViewerA,
        mrCellReadoutA,
        surfaceSelA.value,
        selectedValues(angleCompareSel),
        'Select angles in Comparison A',
        'selected'
      );
      applyFields(
        mrCellViewerB,
        mrCellReadoutB,
        surfaceSelB.value,
        fixedAngleSel.value ? [fixedAngleSel.value] : [],
        'Select an angle in Comparison B',
        'selected'
      );
    }

    async function loadAnglesA() {
      setHint('Loading angles...');
      const s = surfaceSelA.value;
      const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(s)}/angles`);
      (r.angles || []).forEach((a) => {
        const val = Number(a.plane_angle);
        if (Number.isFinite(val)) mrAngleDegByName.set(`${s}::${a.name}`, val);
      });
      const angles = (r.angles || []).sort((a,b)=> (angleMetric(a.name, s) - angleMetric(b.name, s)) || (a.theta-b.theta) || (a.phi-b.phi));
      optionize(angleCompareSel, angles, (a)=>compactAngleLabel(a.name, s), (a)=>a.name);
      selectPreferredAngles(angleCompareSel, s);
      anglePicker.sync();
      setHint('');
      updateFieldArrow();
    }

    async function loadAnglesB() {
      setHint('Loading angles...');
      const s = surfaceSelB.value;
      const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(s)}/angles`);
      (r.angles || []).forEach((a) => {
        const val = Number(a.plane_angle);
        if (Number.isFinite(val)) mrAngleDegByName.set(`${s}::${a.name}`, val);
      });
      const angles = (r.angles || []).sort((a,b)=> (angleMetric(a.name, s) - angleMetric(b.name, s)) || (a.theta-b.theta) || (a.phi-b.phi));
      optionize(fixedAngleSel, angles, (a)=>compactAngleLabel(a.name, s), (a)=>a.name);
      if (fixedAngleSel.options.length) chooseClosestOption(fixedAngleSel, 0, (v) => angleMetric(v, s));
      setHint('');
    }

    const selectedAnglesA = () => selectedValues(angleCompareSel);

    const firstAngleA = () => {
      const list = selectedAnglesA();
      if (list.length) return list[0];
      const opt = angleCompareSel.options?.[0];
      return opt ? opt.value : '';
    };

    async function loadMusFor(surfaceSel, angleName, muSel) {
      setHint('Loading Fermi levels...');
      const s = surfaceSel.value;
      const a = angleName;
      if (!a) { optionize(muSel, [], (v)=>v, (v)=>v); setHint(''); return; }
      const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(s)}/angles/${encodeURIComponent(a)}/mus`);
      const mus = r.mus || [];
      optionize(muSel, mus, (v)=>v.toFixed(1), (v)=>String(v));
      if (muSel.options.length) {
        const target = Array.from(muSel.options).find(o => Math.abs(parseFloat(o.value) - 0) < 1e-6);
        if (target) target.selected = true;
        else muSel.options[0].selected = true;
      }
      setHint('');
    }

    const loadMusA = () => loadMusFor(surfaceSelA, firstAngleA(), muSelA);
    const loadMusB = () => loadMusFor(surfaceSelB, fixedAngleSel.value, muSelB);
    const visibleMrTemps = (temps) => (Array.isArray(temps) ? temps : [])
      .sort((x,y)=>x-y)
      .filter((t) => ![10, 40, 70].some((hidden) => Math.abs(Number(t) - hidden) <= 1e-6));

    async function loadTempsA() {
      setHint('Loading temperatures...');
      const s = surfaceSelA.value;
      const a = firstAngleA();
      const mu = muSelA.value;
      if (!a) { optionize(fixedTempSel, [], (v)=>v, (v)=>v); setHint('No angles selected'); return; }
      const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(s)}/angles/${encodeURIComponent(a)}/temps?mu=${encodeURIComponent(mu)}`);
      const temps = visibleMrTemps(r.temps || []);
      optionize(fixedTempSel, temps, (v)=>tempLabel(v), (v)=>String(v));
      if (!fixedTempSel.options.length) {
        setHint('No temperatures available');
        return;
      }
      chooseClosestOption(fixedTempSel, 50, (v) => parseFloat(v));
      setHint('');
    }

    async function loadTempsB() {
      setHint('Loading temperatures...');
      const s = surfaceSelB.value; const a = fixedAngleSel.value; const mu = muSelB.value;
      if (!a) { optionize(tempCompareSel, [], (v)=>v, (v)=>v); setHint('No angles selected'); return; }
      const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(s)}/angles/${encodeURIComponent(a)}/temps?mu=${encodeURIComponent(mu)}`);
      const temps = visibleMrTemps(r.temps || []);
      optionize(tempCompareSel, temps, (v)=>tempLabel(v), (v)=>String(v));
      if (!tempCompareSel.options.length) {
        setHint('No temperatures available');
        return;
      }
      chooseClosestOption(fixedTempSel, 50, (v) => parseFloat(v));
      selectPreferredTemps();
      tempPicker.sync();
      setHint('');
    }

    function rhoToMrSeries(series) {
      if (!series || !Array.isArray(series.x) || !Array.isArray(series.y) || !series.x.length || series.x.length !== series.y.length) {
        return null;
      }
      let zeroIdx = 0;
      let zeroDist = Infinity;
      series.x.forEach((x, idx) => {
        const dist = Math.abs(Number(x) || 0);
        if (dist < zeroDist) {
          zeroDist = dist;
          zeroIdx = idx;
        }
      });
      const rho0 = Number(series.y[zeroIdx]);
      if (!Number.isFinite(rho0) || Math.abs(rho0) < 1e-30) return null;
      return {
        x: series.x,
        y: series.y.map((v) => ((Number(v) - rho0) / rho0) * 100),
        label: series.label,
        color: series.color,
      };
    }

    const BTAU_DOMAIN = { min: -20, max: 20 };

    function expandSeriesToBtauDomain(seriesList, opts = {}) {
      const mirrorSign = opts.odd ? -1 : 1;
      return (Array.isArray(seriesList) ? seriesList : [])
        .map((series) => {
          if (!series || !Array.isArray(series.x) || !Array.isArray(series.y)) return null;
          const hasNegative = series.x.some((x) => Number(x) < -1e-9);
          const pairs = [];
          series.x.forEach((xRaw, idx) => {
            const x = Number(xRaw);
            const y = Number(series.y[idx]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x >= BTAU_DOMAIN.min && x <= BTAU_DOMAIN.max) pairs.push({ x, y });
            if (!hasNegative && x > 1e-9 && -x >= BTAU_DOMAIN.min && -x <= BTAU_DOMAIN.max) {
              pairs.push({ x: -x, y: mirrorSign * y });
            }
          });
          pairs.sort((a, b) => a.x - b.x);
          return {
            ...series,
            x: pairs.map((p) => p.x),
            y: pairs.map((p) => p.y),
          };
        })
        .filter((series) => series && Array.isArray(series.x) && series.x.length);
    }

    const btauPlotOpts = (opts) => ({
      ...opts,
      xMin: BTAU_DOMAIN.min,
      xMax: BTAU_DOMAIN.max,
    });

    const zoomLabel = (value) => `${axisZoomValue(value).toFixed(1)}x`;

    function readZoom(input) {
      return axisZoomValue(input?.value);
    }

    function setupAxisZoom(input, output) {
      if (!input) return;
      const sync = () => {
        if (output) output.textContent = zoomLabel(input.value);
      };
      sync();
      input.addEventListener('input', () => {
        sync();
        scheduleZoomPlot();
      });
    }

    const zoomOptsA = () => ({
      xZoom: readZoom(zoomXA),
      yZoom: readZoom(zoomYA),
      xZoomCenter: 0,
    });

    const zoomOptsB = () => ({
      xZoom: readZoom(zoomXB),
      yZoom: readZoom(zoomYB),
      xZoomCenter: 0,
    });

    let zoomPlotTimer = null;
    function scheduleZoomPlot() {
      window.clearTimeout(zoomPlotTimer);
      zoomPlotTimer = window.setTimeout(() => {
        plotNow();
      }, 90);
    }

    setupAxisZoom(zoomXA, zoomXAValue);
    setupAxisZoom(zoomYA, zoomYAValue);
    setupAxisZoom(zoomXB, zoomXBValue);
    setupAxisZoom(zoomYB, zoomYBValue);

    function drawEmptyAll() {
      [canvasRhoA, canvasSigmaA, canvasMRA, canvasRhoB, canvasSigmaB, canvasMRB].forEach(c => drawPlot(c, null, {}));
    }

    function drawEmptyA() {
      [canvasRhoA, canvasSigmaA, canvasMRA].forEach(c => drawPlot(c, null, {}));
    }

    function drawEmptyB() {
      [canvasRhoB, canvasSigmaB, canvasMRB].forEach(c => drawPlot(c, null, {}));
    }

    function setPanelMode(plotsEl, wrapEl, showMR) {
      if (plotsEl) plotsEl.classList.toggle('no-mr', !showMR);
      if (wrapEl) wrapEl.style.display = showMR ? '' : 'none';
    }

    async function fetchOne(surface, angleName, mu, Tval, comp) {
      try {
        const r = await apiGet(`/api/mr/${encodeURIComponent(id)}/series?surface=${encodeURIComponent(surface)}&angle=${encodeURIComponent(angleName)}&mu=${encodeURIComponent(mu)}&T=${encodeURIComponent(Tval)}&comp=${encodeURIComponent(comp)}`);
        return { angle: angleName, T: Tval, rho: r.rho || null, sigma: r.sigma || null };
      } catch (e) {
        return { angle: angleName, T: Tval, rho: null, sigma: null };
      }
    }

    async function plotNow() {
      setHint('Plotting...');
      const sA = surfaceSelA.value;
      const sB = surfaceSelB.value;
      let angles = selectedAnglesA();
      if (!angles.length && angleCompareSel.options.length) angles = [angleCompareSel.options[0].value];
      const muA = parseFloat(muSelA.value);
      const muB = parseFloat(muSelB.value);
      let Ts = selectedTempsB();
      const compA = compSelA.value;
      const compB = compSelB.value;
      const showMRA = isDiagonalRhoComponent(compA);
      const showMRB = isDiagonalRhoComponent(compB);
      const oddA = isOddTensorComponent(compA);
      const oddB = isOddTensorComponent(compB);
      const fixedT = parseFloat(fixedTempSel.value);
      const fixedAngle = fixedAngleSel.value;
      try {
        if (!Ts.length && tempCompareSel.options.length) Ts = [parseFloat(tempCompareSel.options[0].value)];
        if (!angles.length) drawEmptyA();
        if (!Ts.length || !fixedAngle) drawEmptyB();
        const [allA, allB] = await Promise.all([
          angles.length && Number.isFinite(fixedT)
            ? Promise.all(angles.map(ang => fetchOne(sA, ang, muA, fixedT, compA)))
            : Promise.resolve([]),
          Ts.length && fixedAngle
            ? Promise.all(Ts.map(T => fetchOne(sB, fixedAngle, muB, T, compB)))
            : Promise.resolve([]),
        ]);
        const rhoListA = allA
          .filter(o => o.rho)
          .map((o)=> ({ x: o.rho.x, y: o.rho.y, label: compactAngleLabel(o.angle, sA) }));
        const sigmaListA = allA
          .filter(o => o.sigma)
          .map((o)=> ({ x: o.sigma.x, y: o.sigma.y, label: compactAngleLabel(o.angle, sA) }));
        const mrListA = showMRA
          ? rhoListA.map(rhoToMrSeries).filter(Boolean)
          : [];
        const rhoListB = allB
          .filter(o => o.rho)
          .map((o)=> ({ x: o.rho.x, y: o.rho.y, label: tempLabel(o.T) }));
        const sigmaListB = allB
          .filter(o => o.sigma)
          .map((o)=> ({ x: o.sigma.x, y: o.sigma.y, label: tempLabel(o.T) }));
        const mrListB = showMRB
          ? rhoListB.map(rhoToMrSeries).filter(Boolean)
          : [];
        const zoomA = zoomOptsA();
        const zoomB = zoomOptsB();

        setPanelMode(plotsA, mrWrapA, showMRA);
        setPanelMode(plotsB, mrWrapB, showMRB);
        drawPlot(
          canvasRhoA,
          expandSeriesToBtauDomain(rhoListA, { odd: oddA }),
          btauPlotOpts({ ...zoomA, xlabel: 'Bτ (T·ps)', ylabelBase: 'ρ', ylabelSub: compA, ylabelTail: '·τ', ylabelUnits: '(Ω·m·s)', yZeroLine: oddA })
        );
        drawPlot(
          canvasSigmaA,
          expandSeriesToBtauDomain(sigmaListA, { odd: oddA }),
          btauPlotOpts({ ...zoomA, xlabel: 'Bτ (T·ps)', ylabelBase: 'σ', ylabelSub: compA, ylabelTail: '/τ', ylabelUnits: '(Ω·m·s)⁻¹', ylabelUnitsGap: 22, yZeroLine: oddA })
        );
        if (showMRA) {
          drawPlot(
            canvasMRA,
            expandSeriesToBtauDomain(mrListA),
            btauPlotOpts({ ...zoomA, xlabel: 'Bτ (T·ps)', ylabel: 'MR (%)', yMin: 0, yScientific: false, yTickDigits: 0 })
          );
        }
        drawPlot(
          canvasRhoB,
          expandSeriesToBtauDomain(rhoListB, { odd: oddB }),
          btauPlotOpts({ ...zoomB, xlabel: 'Bτ (T·ps)', ylabelBase: 'ρ', ylabelSub: compB, ylabelTail: '·τ', ylabelUnits: '(Ω·m·s)', yZeroLine: oddB })
        );
        drawPlot(
          canvasSigmaB,
          expandSeriesToBtauDomain(sigmaListB, { odd: oddB }),
          btauPlotOpts({ ...zoomB, xlabel: 'Bτ (T·ps)', ylabelBase: 'σ', ylabelSub: compB, ylabelTail: '/τ', ylabelUnits: '(Ω·m·s)⁻¹', ylabelUnitsGap: 22, yZeroLine: oddB })
        );
        if (showMRB) {
          drawPlot(
            canvasMRB,
            expandSeriesToBtauDomain(mrListB),
            btauPlotOpts({ ...zoomB, xlabel: 'Bτ (T·ps)', ylabel: 'MR (%)', yMin: 0, yScientific: false, yTickDigits: 0 })
          );
        }
        if (statusA) {
          statusA.innerHTML = showMRA
            ? `Fixed temperature: ${escapeHTML(tempLabel(fixedT))} | Angles compared: ${rhoListA.length}`
            : `Fixed temperature: ${escapeHTML(tempLabel(fixedT))} | MR curve hidden for ${renderRhoSubHTML(compA)}`;
        }
        if (statusB) {
          statusB.innerHTML = showMRB
            ? `Fixed angle: ${escapeHTML(compactAngleLabel(fixedAngle, sB))} | Temperatures compared: ${rhoListB.length}`
            : `Fixed angle: ${escapeHTML(compactAngleLabel(fixedAngle, sB))} | MR curve hidden for ${renderRhoSubHTML(compB)}`;
        }
        if (!rhoListA.length && !sigmaListA.length && !rhoListB.length && !sigmaListB.length) setHint('No matching data'); else setHint('');
        // ensure field arrow reflects current selection
        updateFieldArrow();
      } catch (e) {
        drawEmptyAll();
        setPanelMode(plotsA, mrWrapA, false);
        setPanelMode(plotsB, mrWrapB, false);
        setHint('Plot failed');
      }
    }

    surfaceSelA.addEventListener('change', async ()=>{ await loadAnglesA(); updateMrCellOverlay(); await loadMusA(); await loadTempsA(); await plotNow(); });
    surfaceSelB.addEventListener('change', async ()=>{ await loadAnglesB(); updateMrCellOverlay(); await loadMusB(); await loadTempsB(); await plotNow(); });
    angleCompareSel.addEventListener('change', async ()=>{ updateFieldArrow(); updateMrCellOverlay(); await loadMusA(); await loadTempsA(); await plotNow(); });
    fixedAngleSel.addEventListener('change', async ()=>{ updateFieldArrow(); updateMrCellOverlay(); await loadMusB(); await loadTempsB(); await plotNow(); });
    muSelA.addEventListener('change', async ()=>{ await loadTempsA(); await plotNow(); });
    muSelB.addEventListener('change', async ()=>{ await loadTempsB(); await plotNow(); });
    fixedTempSel.addEventListener('change', plotNow);
    tempCompareSel.addEventListener('change', plotNow);
    compSelA.addEventListener('change', plotNow);
    compSelB.addEventListener('change', plotNow);
    if (downloadAllBtn) downloadAllBtn.addEventListener('click', downloadMrBlockImage);

    // initial cascade
    await setupMrCellViewer();
    await Promise.all([loadAnglesA(), loadAnglesB()]);
    updateMrCellOverlay();
    await Promise.all([loadMusA(), loadMusB()]);
    await Promise.all([loadTempsA(), loadTempsB()]);
    updateMrCellOverlay();
    await plotNow();
  }

  async function initMRPolar() {
    const id = matId();
    if (!id) return;
    const surfaceSel = $('#mrPolarSurface');
    const compSel = $('#mrPolarComp');
    const compPretty = $('#mrPolarCompPretty');
    const compMenu = $('#mrPolarCompMenu');
    const downloadAllBtn = $('#mrPolarDownloadAllBtn');
    const polarWrap = document.querySelector('#mrPolarBlock .mr-polar-view');
    const cartWrap = $('#mrCartWrap');
    const polarGrid = $('#mrPolarGrid');
    const cartGrid = $('#mrCartGrid');
    if (!surfaceSel || !compSel || !polarWrap || !cartWrap || !polarGrid || !cartGrid) return;

    let surfaces = [];
    try {
      const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/surfaces`);
      surfaces = data.surfaces || [];
    } catch (e) {
      showPolarBlock(false);
      return;
    }

    if (!surfaces.length) {
      showPolarBlock(false);
      return;
    }

    showPolarBlock(true);
    optionize(surfaceSel, surfaces, prettySurface, (s)=>s);
    if (surfaceSel.options.length) surfaceSel.selectedIndex = 0;
    if (Array.from(compSel.options || []).some((o) => o.value === 'zz')) compSel.value = 'zz';
    setupPrettySelect(compSel, compPretty, compMenu);

    const MU_TARGETS = [-20, -10, 0, 10, 20];
    const axisMap = { 'Ra_Rb_surface': 'a', 'Rb_Rc_surface': 'b', 'Rc_Ra_surface': 'c' };
    const diagCompSet = new Set(['xx', 'yy', 'zz']);
    let requestSeq = 0;
    let currentBundle = null;

    const fmtMu = (v) => `${Number(v).toFixed(1)} meV`;
    const fmtScale = (v) => `${v.toFixed(2)}x`;
    const safeToken = (v) => String(v ?? '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]+/g, '');
    const btauLabel = (v, idx) => {
      const b = Number(v);
      if (!Number.isFinite(b)) return `Bτ=${idx + 1}`;
      return `Bτ=${Math.round(b)}`;
    };
    const computeAnisotropyAtBtau = (data, targetBtau = 18) => {
      if (!data || !Array.isArray(data.series)) return null;
      let best = null;
      (data.series || []).forEach((s) => {
        const bt = Number(s?.btau);
        if (!Number.isFinite(bt) || !Array.isArray(s?.values)) return;
        const values = s.values
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v));
        if (values.length < 2) return;
        const delta = Math.abs(bt - targetBtau);
        if (!best || delta < best.delta) best = { btau: bt, values, delta };
      });
      if (!best) return null;
      const min = Math.min(...best.values);
      const max = Math.max(...best.values);
      if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(min) < 1e-30) return null;
      return {
        value: (max - min) / min,
        min,
        max,
        btau: best.btau,
        exact: best.delta < 1e-6,
      };
    };
    const fmtAnisotropy = (result) => {
      if (!result || !Number.isFinite(result.value)) return 'AMR(0.0 meV, Bτ=18)：-';
      const bt = result.exact ? '18' : `≈${Number(result.btau).toFixed(2).replace(/\.00$/, '')}`;
      return `AMR(0.0 meV, Bτ=${bt})：${result.value.toFixed(3)} (${(result.value * 100).toFixed(1)}%)`;
    };

    const buildSubplotCards = (container, kind) => {
      container.innerHTML = '';
      return MU_TARGETS.map((mu, idx) => {
        const card = document.createElement('article');
        card.className = 'mr-subplot-card';
        card.innerHTML = `
          <div class="mr-subplot-title">${fmtMu(mu)}</div>
          <canvas class="mr-subplot-canvas"></canvas>
          <div class="mr-subplot-slider-row">
            <span>scale</span>
            <input type="range" min="0.20" max="3.00" step="0.05" value="1.00" aria-label="${kind} scale ${mu} meV">
            <span class="mr-subplot-slider-val">1.00x</span>
          </div>
          <div class="mr-subplot-actions">
            <button type="button" class="mr-subplot-download" aria-label="${kind} download ${mu} meV">Download</button>
          </div>
        `;
        container.appendChild(card);
        const titleEl = card.querySelector('.mr-subplot-title');
        const canvasEl = card.querySelector('canvas');
        const sliderEl = card.querySelector('input[type="range"]');
        const valEl = card.querySelector('.mr-subplot-slider-val');
        const downloadEl = card.querySelector('.mr-subplot-download');
        return { mu, idx, kind, titleEl, canvasEl, sliderEl, valEl, downloadEl };
      });
    };

    const polarCards = buildSubplotCards(polarGrid, 'polar');
    const cartCards = buildSubplotCards(cartGrid, 'cart');
    const downloadCardImage = (card) => {
      if (!card?.canvasEl || !card.svgPayload) return;
      try {
        const surface = safeToken(currentBundle?.surface || surfaceSel.value || 'surface');
        const comp = safeToken((currentBundle?.comp || compSel.value || 'comp').toLowerCase());
        const mu = Number(card.mu);
        const muTag = Number.isFinite(mu) ? `mu${mu.toFixed(1).replace('.', 'p')}` : 'mu';
        const mat = safeToken(id || 'material');
        const kind = safeToken(card.kind || 'plot');
        const filename = [mat, kind, surface, comp, muTag].filter(Boolean).join('_') + '.svg';
        const p = card.svgPayload;
        const svg = p.kind === 'polar'
          ? polarMplSvg(p.width, p.height, p.angles, p.series, p.opts)
          : cartMplSvg(p.width, p.height, p.series, p.opts);
        downloadSvg(svg, filename);
      } catch (e) {}
    };
    async function downloadPolarBlockImage() {
      if (!downloadAllBtn) return;
      const oldText = downloadAllBtn.textContent;
      downloadAllBtn.disabled = true;
      downloadAllBtn.textContent = 'Rendering...';
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const loadImage = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
        const captureCanvas = async (canvas) => {
          if (!canvas) return null;
          try {
            return await loadImage(canvas.toDataURL('image/png'));
          } catch {
            return null;
          }
        };
        const selectedText = (selectEl) => {
          const opt = selectEl?.selectedOptions?.[0];
          return opt ? opt.textContent.trim() : (selectEl?.value || '-');
        };
        const compText = (comp) => `ρ${String(comp || '').toLowerCase()}`;
        const isVisible = (el) => !!el && window.getComputedStyle(el).display !== 'none';
        const diagComp = diagCompSet.has(String(currentBundle?.comp || compSel.value || '').toLowerCase());
        const sections = [];
        if (diagComp && isVisible(polarWrap)) {
          sections.push({ title: 'Polar plots', cards: polarCards });
        }
        sections.push({ title: 'Cartesian plots', cards: cartCards });
        for (const section of sections) {
          for (const card of section.cards) card.exportImg = await captureCanvas(card.canvasEl);
        }

        const scale = 2;
        const width = 1800;
        const margin = 36;
        const pad = 28;
        const gap = 18;
        const cardW = width - margin * 2;
        const plotCols = 5;
        const plotGap = 18;
        const plotCardW = (cardW - pad * 2 - plotGap * (plotCols - 1)) / plotCols;
        const plotCardH = 355;
        const sectionH = 46 + plotCardH;
        const metaH = 104;
        const height = margin + 54 + metaH + sections.length * sectionH + Math.max(0, sections.length - 1) * gap + margin;
        const out = document.createElement('canvas');
        out.width = width * scale;
        out.height = height * scale;
        const ctx = out.getContext('2d');
        ctx.scale(scale, scale);
        const rr = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };
        const drawText = (text, x, y, opts = {}) => {
          ctx.save();
          ctx.fillStyle = opts.color || '#111827';
          ctx.font = opts.font || '16px Arial, sans-serif';
          ctx.textAlign = opts.align || 'left';
          ctx.textBaseline = opts.baseline || 'top';
          ctx.fillText(String(text || ''), x, y);
          ctx.restore();
        };
        const wrapText = (text, x, y, maxW, lineH, opts = {}) => {
          const words = String(text || '').split(/\s+/).filter(Boolean);
          let line = '';
          let yy = y;
          ctx.save();
          ctx.fillStyle = opts.color || '#64748b';
          ctx.font = opts.font || '16px Arial, sans-serif';
          words.forEach((word) => {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxW && line) {
              ctx.fillText(line, x, yy);
              line = word;
              yy += lineH;
            } else {
              line = test;
            }
          });
          if (line) ctx.fillText(line, x, yy);
          ctx.restore();
        };
        const drawPill = (text, x, y, w) => {
          rr(x, y, w, 34, 8);
          ctx.fillStyle = '#eaf2ff';
          ctx.strokeStyle = '#dbe7ff';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          drawText(text, x + w / 2, y + 8, { align: 'center', font: 'bold 15px Arial, sans-serif', color: '#2457b8' });
        };
        const drawControl = (label, value, x, y, w) => {
          drawText(label, x, y, { font: 'bold 15px Arial, sans-serif', color: '#1f2937' });
          rr(x, y + 24, w, 44, 9);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#d9dee9';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          drawText(value, x + 14, y + 37, { font: '17px Arial, sans-serif' });
        };
        const drawImageInBox = (img, x, y, w, h) => {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, w, h);
          if (img) {
            const iw = img.naturalWidth || img.width || w;
            const ih = img.naturalHeight || img.height || h;
            const ratio = Math.min(w / iw, h / ih);
            const dw = iw * ratio;
            const dh = ih * ratio;
            ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
          } else {
            drawText('Image unavailable', x + 12, y + 12, { color: '#64748b' });
          }
        };

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#2563eb';
        rr(margin + 2, margin + 12, 8, 24, 5);
        ctx.fill();
        drawText('Anisotropy Plots', margin + 20, margin + 12, { font: 'bold 24px Arial, sans-serif' });
        drawPill(diagComp ? 'Polar + Cartesian' : 'Cartesian', width - margin - 168, margin + 6, 168);

        let y = margin + 54;
        rr(margin, y, cardW, metaH, 14);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#dfe4ee';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
        const controlW = (cardW - pad * 2 - 36) / 3;
        drawControl('Plane', selectedText(surfaceSel), margin + pad, y + 18, controlW);
        drawControl('Component', compText(compSel.value), margin + pad + controlW + 18, y + 18, controlW);
        drawControl('0° definition', $('#mrPolarZeroDef')?.textContent || '-', margin + pad + (controlW + 18) * 2, y + 18, controlW);
        y += metaH + gap;

        sections.forEach((section) => {
          rr(margin, y, cardW, sectionH, 14);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#dfe4ee';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
          drawText(section.title, margin + pad, y + 18, { font: 'bold 22px Arial, sans-serif' });
          section.cards.forEach((card, idx) => {
            const x = margin + pad + idx * (plotCardW + plotGap);
            const py = y + 54;
            rr(x, py, plotCardW, plotCardH, 10);
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#e5e7eb';
            ctx.fill();
            ctx.stroke();
            const title = card.titleEl?.textContent || fmtMu(card.mu);
            drawText(title, x + plotCardW / 2, py + 12, { align: 'center', font: 'bold 16px Arial, sans-serif' });
            drawImageInBox(card.exportImg, x + 12, py + 42, plotCardW - 24, plotCardH - 72);
            drawText(card.valEl?.textContent || '', x + plotCardW / 2, py + plotCardH - 24, { align: 'center', font: '13px Arial, sans-serif', color: '#64748b' });
          });
          y += sectionH + gap;
        });

        const safeId = safeToken(id || 'material');
        const surface = safeToken(currentBundle?.surface || surfaceSel.value || 'surface');
        const comp = safeToken((currentBundle?.comp || compSel.value || 'comp').toLowerCase());
        const filename = [safeId, 'anisotropic_MR', surface, comp].filter(Boolean).join('_') + '.png';
        await new Promise((resolve) => {
          out.toBlob((pngBlob) => {
            if (!pngBlob) {
              const a = document.createElement('a');
              a.href = out.toDataURL('image/png');
              a.download = filename;
              a.click();
              resolve();
              return;
            }
            const pngUrl = URL.createObjectURL(pngBlob);
            const a = document.createElement('a');
            a.href = pngUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(pngUrl), 500);
            resolve();
          }, 'image/png');
        });
      } catch {
        setPolarHint('Anisotropic MR image export failed');
      } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.textContent = oldText;
      }
    }
    [...polarCards, ...cartCards].forEach((c) => {
      c.sliderEl.addEventListener('input', () => renderCurrent());
      if (c.downloadEl) c.downloadEl.addEventListener('click', () => downloadCardImage(c));
    });
    if (downloadAllBtn) downloadAllBtn.addEventListener('click', downloadPolarBlockImage);

    const updateMeta = () => {
      const zeroDefEl = $('#mrPolarZeroDef');
      const amrEl = $('#mrPolarAmrValue');
      const surface = currentBundle?.surface || surfaceSel.value || '';
      const comp = (currentBundle?.comp || compSel.value || '').toLowerCase();
      const diagComp = diagCompSet.has(comp);
      if (zeroDefEl) {
        const axis = axisMap[surface] || '';
        if (axis) {
          zeroDefEl.textContent = `0°：${axis}轴`;
          zeroDefEl.title = '0°定义：ab面→a轴；bc面→b轴；ca面→c轴';
        } else {
          zeroDefEl.textContent = '';
          zeroDefEl.removeAttribute('title');
        }
      }
      if (amrEl) {
        if (diagComp) {
          const result = computeAnisotropyAtBtau(currentBundle?.byMu?.get(0), 18);
          amrEl.textContent = fmtAnisotropy(result);
          amrEl.title = '各向异性固定使用 μ=0.0 meV、Bτ=18 的角度数据，按 (max-min)/min 计算';
        } else {
          amrEl.textContent = '';
          amrEl.removeAttribute('title');
        }
      }
    };

    const renderOneCard = (card, data, comp, kind, showLegend) => {
      const sf = Number(card.sliderEl.value);
      const scale = Number.isFinite(sf) && sf > 0 ? sf : 1;
      card.valEl.textContent = fmtScale(scale);
      const muFound = Number(data?.mu_found);
      card.titleEl.textContent = Number.isFinite(muFound) && Math.abs(muFound - card.mu) > 1e-6
        ? `${fmtMu(card.mu)} (→ ${fmtMu(muFound)})`
        : fmtMu(card.mu);

      if (!data || !Array.isArray(data.angles) || !Array.isArray(data.series) || !data.angles.length || !data.series.length) {
        card.svgPayload = {
          kind,
          width: card.canvasEl?.clientWidth || 240,
          height: card.canvasEl?.clientHeight || 220,
          angles: [],
          series: [],
          opts: { showLegend: false, showYLabel: true },
        };
        if (kind === 'polar') drawPolarMpl(card.canvasEl, [], [], { showLegend: false });
        else drawCartMpl(card.canvasEl, null, { showLegend: false, showYLabel: true });
        return;
      }

      const angles = data.angles.map((x) => {
        const n = Number(x);
        return Number.isFinite(n) ? n : 0;
      });
      const prepared = [];
      (data.series || []).forEach((s) => {
        const rawVals = Array.isArray(s.values)
          ? s.values.map((v) => {
              const n = Number(v);
              return Number.isFinite(n) ? n : 0;
            })
          : [];
        const n = Math.min(angles.length, rawVals.length);
        if (n < 2) return;
        const xAll = angles.slice(0, n);
        const yRaw = rawVals.slice(0, n);
        prepared.push({ btau: s.btau, xAll, yRaw });
      });

      const outSeries = [];
      prepared.forEach((p, idx) => {
        const xAll = p.xAll;
        const yAll = p.yRaw.slice();
        if (kind === 'polar') {
          outSeries.push({ btau: p.btau, values: yAll });
          return;
        }
        let pts = xAll.map((x, i) => ({ x, y: yAll[i] }));
        // Match rho_vs_angle.sh linear_slice:
        // drop trailing closure point if the last angle is 0°.
        if (pts.length > 1 && Math.abs((pts[pts.length - 1].x || 0) - 0) <= 1e-9) {
          pts = pts.slice(0, -1);
        }
        const halfPts = pts.filter((p) => p.x <= 180 + 1e-9);
        const use = halfPts.length >= 2 ? halfPts : pts;
        outSeries.push({
          x: use.map((p) => p.x),
          y: use.map((p) => p.y),
          label: btauLabel(p.btau, idx),
        });
      });
      if (kind === 'polar') {
        const opts = { comp, showLegend, viewScale: scale };
        card.svgPayload = {
          kind: 'polar',
          width: card.canvasEl?.clientWidth || 240,
          height: card.canvasEl?.clientHeight || 220,
          angles,
          series: outSeries,
          opts,
        };
        drawPolarMpl(card.canvasEl, angles, outSeries, opts);
        return;
      }
      const opts = {
        showLegend,
        showYLabel: true,
        viewScale: scale,
      };
      card.svgPayload = {
        kind: 'cart',
        width: card.canvasEl?.clientWidth || 240,
        height: card.canvasEl?.clientHeight || 220,
        series: outSeries,
        opts,
      };
      drawCartMpl(card.canvasEl, outSeries, opts);
    };

    const renderCurrent = () => {
      const comp = String(currentBundle?.comp || compSel.value || 'xx');
      const diagComp = diagCompSet.has(comp.toLowerCase());
      polarWrap.style.display = diagComp ? 'block' : 'none';
      cartWrap.style.display = 'block';
      cartWrap.style.marginTop = diagComp ? '10px' : '0';
      if (diagComp) {
        polarCards.forEach((card) => {
          const data = currentBundle?.byMu?.get(card.mu) || null;
          renderOneCard(card, data, comp, 'polar', true);
        });
      }
      cartCards.forEach((card) => {
        const data = currentBundle?.byMu?.get(card.mu) || null;
        renderOneCard(card, data, comp, 'cart', true);
      });
    };

    const updatePlot = async () => {
      const surface = surfaceSel.value;
      const comp = compSel.value || 'xx';
      if (!surface || !comp) {
        currentBundle = null;
        setPolarHint('Please select plane and component');
        renderCurrent();
        updateMeta();
        return;
      }

      const seq = ++requestSeq;
      setPolarHint('Loading 5x1 anisotropic MR subplots...');
      try {
        const tasks = MU_TARGETS.map(async (mu) => {
          try {
            const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(surface)}/polar/${encodeURIComponent(comp)}?mu=${encodeURIComponent(mu)}`);
            return { mu, data };
          } catch {
            return { mu, data: null };
          }
        });
        const items = await Promise.all(tasks);
        if (seq !== requestSeq) return;

        const byMu = new Map();
        let ok = 0;
        items.forEach((it) => {
          byMu.set(it.mu, it.data);
          if (it.data && Array.isArray(it.data.angles) && Array.isArray(it.data.series) && it.data.angles.length && it.data.series.length) ok += 1;
        });
        currentBundle = { surface, comp, byMu };
        if (ok <= 0) setPolarHint('No anisotropic MR data for current selection');
        else if (ok < MU_TARGETS.length) setPolarHint(`Loaded ${ok}/${MU_TARGETS.length} μ panels`);
        else setPolarHint('');
        updateMeta();
        renderCurrent();
      } catch {
        if (seq !== requestSeq) return;
        currentBundle = null;
        setPolarHint('Anisotropic MR data unavailable for current selection');
        updateMeta();
        renderCurrent();
      }
    };

    surfaceSel.addEventListener('change', updatePlot);
    compSel.addEventListener('change', updatePlot);
    window.addEventListener('resize', renderCurrent);
    updatePlot();
  }

  function computeFourierMetrics(anglesDeg, values, maxN = 8) {
    const n = Math.min(Array.isArray(anglesDeg) ? anglesDeg.length : 0, Array.isArray(values) ? values.length : 0);
    if (n < 4) return null;
    const samples = [];
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const t = Number(anglesDeg[i]);
      const v = Number(values[i]);
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      // Normalize to [0, 2pi) to avoid duplicated 0°/360° endpoint leakage.
      let r = (t * Math.PI / 180) % twoPi;
      if (r < 0) r += twoPi;
      samples.push({ theta: r, y: v });
    }
    if (samples.length < 4) return null;

    samples.sort((a, b) => a.theta - b.theta);

    const dedup = [];
    const eps = 1e-10;
    for (const s of samples) {
      if (!dedup.length || Math.abs(s.theta - dedup[dedup.length - 1].theta) > eps) {
        dedup.push(s);
      }
    }
    const theta = dedup.map((s) => s.theta);
    const y = dedup.map((s) => s.y);
    const m = y.length;
    if (m < 4) return null;

    const rho0 = y.reduce((s, v) => s + v, 0) / m;
    const rhoMin = Math.min(...y);
    const rhoMax = Math.max(...y);
    const amrRatio = Math.abs(rhoMin) > 1e-30 ? (rhoMax - rhoMin) / rhoMin : null;
    const rms = Math.abs(rho0) > 1e-30
      ? Math.sqrt(y.reduce((s, v) => s + (v - rho0) * (v - rho0), 0) / m) / Math.abs(rho0)
      : null;

    const harmonics = [];
    for (let nH = 1; nH <= maxN; nH++) {
      let a = 0;
      let b = 0;
      for (let i = 0; i < m; i++) {
        const nt = nH * theta[i];
        a += y[i] * Math.cos(nt);
        b += y[i] * Math.sin(nt);
      }
      a = (2 / m) * a;
      b = (2 / m) * b;
      const amp = Math.hypot(a, b);
      const ratio = Math.abs(rho0) > 1e-30 ? amp / Math.abs(rho0) : 0;
      harmonics.push({ n: nH, a, b, amp, ratio });
    }

    let dominant = harmonics[0] || { n: 1, ratio: 0 };
    harmonics.forEach((h) => {
      if (h.ratio > dominant.ratio) dominant = h;
    });
    return {
      rho0,
      rhoMin,
      rhoMax,
      amrRatio,
      rms,
      dominantN: dominant.n,
      dominantRatio: dominant.ratio,
      harmonics,
    };
  }

  function drawFourierPolar(canvas, metrics, opts = {}) {
    const ctx = canvas.getContext('2d');
    const dpi = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 420;
    const H = canvas.clientHeight || 360;
    canvas.width = Math.max(1, Math.floor(W * dpi));
    canvas.height = Math.max(1, Math.floor(H * dpi));
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!metrics || !metrics.harmonics || !metrics.harmonics.length) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText('No Fourier data', 16, 22);
      return;
    }

    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.max(10, Math.min(W, H) * 0.36);
    const plotRadius = radius * 0.9;

    const rhoAbs = Math.max(1e-30, Math.abs(Number(metrics.rho0) || 0));
    const fillColor = opts.fillColor || 'rgba(37,99,235,0.18)';
    const strokeColor = opts.strokeColor || '#2563eb';
    const refLabel = opts.refLabel || null;

    const pts = [];
    let relMax = Number.NEGATIVE_INFINITY;
    for (let deg = 0; deg <= 360; deg++) {
      // Use display convention: 0° at top, angle increases clockwise.
      const alpha = deg * Math.PI / 180;
      let v = metrics.rho0 || 0;
      (metrics.harmonics || []).forEach((h) => {
        v += h.a * Math.cos(h.n * alpha) + h.b * Math.sin(h.n * alpha);
      });
      const rel = v / rhoAbs;
      relMax = Math.max(relMax, rel);
      pts.push({ alpha, rel });
    }

    const scaleCandidates = [1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 10.0];
    const targetMax = Math.max(1.0, relMax * 1.05);
    let scaleMax = scaleCandidates.find((x) => x >= targetMax);
    if (!scaleMax) scaleMax = targetMax;

    ctx.strokeStyle = '#dbe4f2';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach((f) => {
      ctx.beginPath();
      ctx.arc(cx, cy, plotRadius * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    // rho*tau = |(rho*tau)0| reference ring
    const refFrac = Math.min(1, 1 / scaleMax);
    ctx.save();
    ctx.strokeStyle = '#a8bfdc';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, plotRadius * refFrac, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(cx - plotRadius, cy); ctx.lineTo(cx + plotRadius, cy);
    ctx.moveTo(cx, cy - plotRadius); ctx.lineTo(cx, cy + plotRadius);
    ctx.stroke();

    ctx.beginPath();
    pts.forEach((p, i) => {
      const rel = Math.max(0, p.rel);
      const rr = plotRadius * (rel / scaleMax);
      const x = cx + rr * Math.sin(p.alpha);
      const y = cy - rr * Math.cos(p.alpha);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '18px sans-serif';
    ctx.fillText('0°', cx - 8, cy - plotRadius - 8);
    ctx.fillText('90°', cx + plotRadius + 6, cy + 4);
    ctx.fillText('180°', cx - 18, cy + plotRadius + 16);
    ctx.fillText('270°', cx - plotRadius - 36, cy + 4);
    if (refLabel) {
      ctx.fillText(refLabel, 14, 18);
    } else {
      const y = 18;
      let x = 14;
      ctx.font = '12px sans-serif';
      const head = 'r = ρτ/|(ρτ)';
      ctx.fillText(head, x, y);
      x += ctx.measureText(head).width;
      ctx.font = '9px sans-serif';
      ctx.fillText('0', x, y + 3);
      x += ctx.measureText('0').width;
      ctx.font = '12px sans-serif';
      ctx.fillText('|', x, y);
    }

    const legendX = 14;
    const legendY = 38;
    ctx.save();
    ctx.strokeStyle = '#a8bfdc';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(legendX, legendY - 4);
    ctx.lineTo(legendX + 30, legendY - 4);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#64748b';
    ctx.font = '12px sans-serif';
    ctx.fillText('r = 1 reference', legendX + 38, legendY);
  }

  function fourierPolarSvg(width, height, metrics, opts = {}) {
    const W = Number(width) || 560;
    const H = Number(height) || 420;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
    ];
    if (!metrics || !metrics.harmonics || !metrics.harmonics.length) {
      parts.push('<text x="16" y="24" font-size="12" fill="#9ca3af">No Fourier data</text></svg>');
      return parts.join('');
    }

    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.max(10, Math.min(W, H) * 0.36);
    const plotRadius = radius * 0.9;
    const rhoAbs = Math.max(1e-30, Math.abs(Number(metrics.rho0) || 0));
    const fillColor = opts.fillColor || 'rgba(37,99,235,0.18)';
    const strokeColor = opts.strokeColor || '#2563eb';

    const pts = [];
    let relMax = Number.NEGATIVE_INFINITY;
    for (let deg = 0; deg <= 360; deg++) {
      const alpha = deg * Math.PI / 180;
      let v = metrics.rho0 || 0;
      (metrics.harmonics || []).forEach((h) => {
        v += h.a * Math.cos(h.n * alpha) + h.b * Math.sin(h.n * alpha);
      });
      const rel = v / rhoAbs;
      relMax = Math.max(relMax, rel);
      pts.push({ alpha, rel });
    }

    const scaleCandidates = [1.0, 1.2, 1.5, 2.0, 3.0, 5.0, 10.0];
    const targetMax = Math.max(1.0, relMax * 1.05);
    let scaleMax = scaleCandidates.find((x) => x >= targetMax);
    if (!scaleMax) scaleMax = targetMax;

    [0.25, 0.5, 0.75, 1.0].forEach((f) => {
      parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(plotRadius * f).toFixed(2)}" fill="none" stroke="#dbe4f2" stroke-width="1"/>`);
    });
    const refFrac = Math.min(1, 1 / scaleMax);
    parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(plotRadius * refFrac).toFixed(2)}" fill="none" stroke="#a8bfdc" stroke-width="1" stroke-dasharray="4 3"/>`);
    parts.push(`<line x1="${(cx - plotRadius).toFixed(2)}" y1="${cy.toFixed(2)}" x2="${(cx + plotRadius).toFixed(2)}" y2="${cy.toFixed(2)}" stroke="#dbe4f2" stroke-width="1"/>`);
    parts.push(`<line x1="${cx.toFixed(2)}" y1="${(cy - plotRadius).toFixed(2)}" x2="${cx.toFixed(2)}" y2="${(cy + plotRadius).toFixed(2)}" stroke="#dbe4f2" stroke-width="1"/>`);

    const path = pts.map((p, i) => {
      const rel = Math.max(0, p.rel);
      const rr = plotRadius * (rel / scaleMax);
      const x = cx + rr * Math.sin(p.alpha);
      const y = cy - rr * Math.cos(p.alpha);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ') + ' Z';
    parts.push(`<path d="${path}" fill="${svgEscape(fillColor)}" stroke="${svgEscape(strokeColor)}" stroke-width="2"/>`);

    const textStyle = 'font-family:Arial, sans-serif;font-size:12px;fill:#64748b';
    const angleTextStyle = 'font-family:Arial, sans-serif;font-size:18px;fill:#64748b';
    parts.push(`<text x="${(cx - 8).toFixed(2)}" y="${(cy - plotRadius - 8).toFixed(2)}" style="${angleTextStyle}">0°</text>`);
    parts.push(`<text x="${(cx + plotRadius + 6).toFixed(2)}" y="${(cy + 4).toFixed(2)}" style="${angleTextStyle}">90°</text>`);
    parts.push(`<text x="${(cx - 18).toFixed(2)}" y="${(cy + plotRadius + 16).toFixed(2)}" style="${angleTextStyle}">180°</text>`);
    parts.push(`<text x="${(cx - plotRadius - 36).toFixed(2)}" y="${(cy + 4).toFixed(2)}" style="${angleTextStyle}">270°</text>`);
    parts.push(`<text x="14" y="18" style="${textStyle}">r = ρτ/|(ρτ)<tspan baseline-shift="sub" font-size="9">0</tspan>|</text>`);
    parts.push('<line x1="14" y1="34" x2="44" y2="34" stroke="#a8bfdc" stroke-width="1" stroke-dasharray="4 3"/>');
    parts.push(`<text x="52" y="38" style="${textStyle}">r = 1 reference</text>`);
    parts.push('</svg>');
    return parts.join('');
  }

  function renderFourierBars(container, harmonics) {
    if (!container) return;
    const hs = Array.isArray(harmonics) ? harmonics : [];
    const maxR = Math.max(1e-8, ...hs.map((h) => Number(h.ratio) || 0));
    container.innerHTML = '';
    hs.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'mr-fourier-bar-row';
      const pct = Math.max(0, Math.min(100, ((h.ratio || 0) / maxR) * 100));
      row.innerHTML = `
        <div>\\(n=${h.n}\\)</div>
        <div class="mr-fourier-track"><div class="mr-fourier-fill" style="width:${pct}%;"></div></div>
        <div>\\(${(h.ratio || 0).toFixed(4)}\\)</div>
      `;
      container.appendChild(row);
    });
  }

  async function initMRFourier() {
    const id = matId();
    if (!id) return;

    const block = $('#mrFourierBlock');
    const surfaceSel = $('#mrFourierSurface');
    const compSel = $('#mrFourierComp');
    const btauSel = $('#mrFourierBtau');
    const hintEl = $('#mrFourierHint');
    const rho0El = $('#mrFourierRho0');
    const amrEl = $('#mrFourierAmr');
    const rmsEl = $('#mrFourierRms');
    const domEl = $('#mrFourierDom');
    const domRatioEl = $('#mrFourierDomRatio');
    const barsEl = $('#mrFourierBars');
    const rowsEl = $('#mrFourierRows');
    const similarHintEl = $('#mrFourierSimilarHint');
    const similarListEl = $('#mrFourierSimilarList');
    const similarAllHintEl = $('#mrFourierSimilarAllHint');
    const similarAllListEl = $('#mrFourierSimilarAllList');
    const polarCanvas = $('#mrFourierPolarCanvas');
    const polarSvgBtn = $('#mrFourierPolarSvgBtn');
    const downloadBtn = $('#mrFourierDownloadBtn');
    if (!block || !surfaceSel || !compSel || !btauSel || !hintEl || !rho0El || !amrEl || !rmsEl || !domEl || !domRatioEl || !barsEl || !rowsEl || !similarHintEl || !similarListEl || !similarAllHintEl || !similarAllListEl || !polarCanvas) return;

    const setHint = (msg) => { hintEl.textContent = msg || ''; };
    const setSimilarHint = (msg) => {
      similarHintEl.innerHTML = msg || '';
      typesetMath(similarHintEl);
    };
    const setSimilarAllHint = (msg) => {
      similarAllHintEl.innerHTML = msg || '';
      typesetMath(similarAllHintEl);
    };
    const resetCards = () => {
      rho0El.textContent = '-';
      amrEl.textContent = '-';
      rmsEl.textContent = '-';
      domEl.textContent = '-';
      domRatioEl.textContent = '-';
      barsEl.innerHTML = '';
      rowsEl.innerHTML = '';
      similarListEl.innerHTML = '';
      similarAllListEl.innerHTML = '';
      setSimilarHint('');
      setSimilarAllHint('');
      drawFourierPolar(polarCanvas, null);
      typesetMath(block);
    };
    const fmtSciTex = (v) => {
      if (!Number.isFinite(v)) return '-';
      const s = Number(v).toExponential(3);
      const parts = s.split('e');
      if (parts.length !== 2) return String(s);
      const mant = parts[0];
      const exp = Number(parts[1]);
      if (!Number.isFinite(exp)) return String(s);
      return `\\(${mant}\\times10^{${exp}}\\)`;
    };
    const fmtNum = (v, d = 4) => (Number.isFinite(v) ? Number(v).toFixed(d) : '-');

    let currentData = null;
    let summaryRows = [];
    let similarReqSeq = 0;
    let similarAllReqSeq = 0;

    const pickedFourierRow = () => {
      if (!summaryRows.length) return null;
      const selIdx = Number(btauSel.value);
      return summaryRows.find((r) => r.idx === selIdx) || summaryRows[0] || null;
    };

    try {
      const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/surfaces`);
      const surfaces = data.surfaces || [];
      if (!surfaces.length) {
        showFourierBlock(false);
        return;
      }
      showFourierBlock(true);
      optionize(surfaceSel, surfaces, prettySurface, (s) => s);
    } catch {
      showFourierBlock(false);
      return;
    }

    function renderSummaryTable(activeIdx) {
      rowsEl.innerHTML = '';
      summaryRows.forEach((row) => {
        const tr = document.createElement('tr');
        if (row.idx === activeIdx) tr.className = 'active';
        tr.innerHTML = `
          <td>${row.btauLabel}</td>
          <td>${fmtSciTex(row.metrics.rho0)}</td>
          <td>${fmtNum(row.metrics.amrRatio, 4)}</td>
          <td>${fmtNum(row.metrics.rms, 4)}</td>
          <td>${row.metrics.dominantN}</td>
          <td>${fmtNum(row.metrics.dominantRatio, 4)}</td>
        `;
        rowsEl.appendChild(tr);
      });
    }

    function renderSelected() {
      if (!summaryRows.length) {
        resetCards();
        return;
      }
      const picked = pickedFourierRow();
      rho0El.innerHTML = fmtSciTex(picked.metrics.rho0);
      amrEl.textContent = fmtNum(picked.metrics.amrRatio, 4);
      rmsEl.textContent = fmtNum(picked.metrics.rms, 4);
      domEl.innerHTML = `\\( n^{*} = ${picked.metrics.dominantN} \\)`;
      domRatioEl.innerHTML = `\\( R_{n^{*}} = ${fmtNum(picked.metrics.dominantRatio, 4)} \\)`;
      renderFourierBars(barsEl, picked.metrics.harmonics);
      drawFourierPolar(polarCanvas, picked.metrics);
      renderSummaryTable(picked.idx);
      updateSimilarList(picked);
      updateSimilarAllList(picked);
      typesetMath(block);
    }

    if (polarSvgBtn) {
      polarSvgBtn.addEventListener('click', () => {
        const picked = pickedFourierRow();
        const metrics = picked?.metrics || null;
        const W = Math.max(560, Math.round(polarCanvas.clientWidth || 560));
        const H = Math.max(420, Math.round(polarCanvas.clientHeight || 420));
        const svg = fourierPolarSvg(W, H, metrics);
        const surface = surfaceSel.value || 'surface';
        const comp = compSel.value || 'comp';
        const btau = String(picked?.btauLabel || 'btau').replace(/[^\w.-]+/g, '_');
        downloadSvg(svg, `${id}_fourier_polar_${surface}_${comp}_${btau}.svg`);
      });
    }

    async function downloadFourierImage() {
      if (!downloadBtn) return;
      const oldText = downloadBtn.textContent;
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Rendering...';
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const loadImage = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
        let polarImg = null;
        try {
          polarImg = await loadImage(polarCanvas.toDataURL('image/png'));
        } catch {}
        const selectedText = (selectEl) => {
          const opt = selectEl?.selectedOptions?.[0];
          return opt ? opt.textContent.trim() : (selectEl?.value || '-');
        };
        const selIdx = Number(btauSel.value);
        const picked = summaryRows.find((r) => r.idx === selIdx) || summaryRows[0] || null;
        const harmonics = picked?.metrics?.harmonics || [];
        const scale = 2;
        const width = 1800;
        const margin = 36;
        const pad = 28;
        const cardW = width - margin * 2;
        const formulaH = 126;
        const controlsH = 74;
        const metricsH = 150;
        const vizH = 520;
        const tableH = 64 + Math.max(1, summaryRows.length) * 40;
        const height = margin + 56 + formulaH + controlsH + metricsH + vizH + tableH + margin + 72;
        const out = document.createElement('canvas');
        out.width = width * scale;
        out.height = height * scale;
        const ctx = out.getContext('2d');
        ctx.scale(scale, scale);
        const rr = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };
        const drawText = (text, x, y, opts = {}) => {
          ctx.save();
          ctx.fillStyle = opts.color || '#111827';
          ctx.font = opts.font || '16px Arial, sans-serif';
          ctx.textAlign = opts.align || 'left';
          ctx.textBaseline = opts.baseline || 'top';
          ctx.fillText(String(text || ''), x, y);
          ctx.restore();
        };
        const wrapText = (text, x, y, maxW, lineH, opts = {}) => {
          const words = String(text || '').split(/\s+/).filter(Boolean);
          let line = '';
          let yy = y;
          ctx.save();
          ctx.fillStyle = opts.color || '#475569';
          ctx.font = opts.font || '15px Arial, sans-serif';
          words.forEach((word) => {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxW && line) {
              ctx.fillText(line, x, yy);
              line = word;
              yy += lineH;
            } else {
              line = test;
            }
          });
          if (line) ctx.fillText(line, x, yy);
          ctx.restore();
        };
        const drawStat = (label, value, sub, x, y, w) => {
          rr(x, y, w, 118, 12);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#e5e7eb';
          ctx.fill();
          ctx.stroke();
          drawText(label, x + 16, y + 16, { font: '16px Arial, sans-serif', color: '#64748b' });
          drawText(value, x + 16, y + 44, { font: 'bold 28px Arial, sans-serif' });
          if (sub) drawText(sub, x + 16, y + 82, { font: '14px Arial, sans-serif', color: '#64748b' });
        };
        const drawImageInBox = (img, x, y, w, h) => {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, w, h);
          if (!img) {
            drawText('Image unavailable', x + 14, y + 14, { color: '#64748b' });
            return;
          }
          const iw = img.naturalWidth || img.width || w;
          const ih = img.naturalHeight || img.height || h;
          const ratio = Math.min(w / iw, h / ih);
          const dw = iw * ratio;
          const dh = ih * ratio;
          ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        };
        const fmt = (v, d = 4) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-';

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#2563eb';
        rr(margin + 2, margin + 12, 8, 24, 5);
        ctx.fill();
        drawText('Anisotropy Fingerprint', margin + 20, margin + 10, { font: 'bold 26px Arial, sans-serif' });

        let y = margin + 56;
        rr(margin, y, cardW, formulaH, 14);
        ctx.fillStyle = '#f8fbff';
        ctx.strokeStyle = '#dfe7f5';
        ctx.fill();
        ctx.stroke();
        [
          'Fourier: (rho*tau)(phi) = (rho*tau)0 + sum[n=1..8] { an cos(n phi) + bn sin(n phi) }',
          'Amplitude: An = sqrt(an^2 + bn^2),  Rn = An / |(rho*tau)0|',
          'AMR = ((rho*tau)_max - (rho*tau)_min) / (rho*tau)_min',
          'RMS: A_rms = sqrt((1/N) sum_i [rho*tau(phi_i)-(rho*tau)0]^2) / |(rho*tau)0|',
        ].forEach((line, idx) => drawText(line, margin + pad, y + 18 + idx * 25, { font: '16px Georgia, serif', color: '#334155' }));

        y += formulaH + 18;
        rr(margin, y, cardW, controlsH, 14);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#dfe4ee';
        ctx.fill();
        ctx.stroke();
        drawText(`Plane: ${selectedText(surfaceSel)}`, margin + pad, y + 24, { font: 'bold 20px Arial, sans-serif', color: '#334155' });
        drawText(`Component: ${selectedText(compSel)}`, margin + pad + 360, y + 24, { font: 'bold 20px Arial, sans-serif', color: '#334155' });
        drawText(`Btau: ${selectedText(btauSel)}`, margin + pad + 700, y + 24, { font: 'bold 20px Arial, sans-serif', color: '#334155' });
        wrapText(hintEl.textContent || '', margin + pad + 980, y + 25, cardW - pad * 2 - 980, 18);

        y += controlsH + 18;
        rr(margin, y, cardW, metricsH, 14);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#dfe4ee';
        ctx.fill();
        ctx.stroke();
        const statW = (cardW - pad * 2 - 36) / 4;
        drawStat('(rho*tau)0', rho0El.textContent, '<rho*tau>_phi', margin + pad, y + 18, statW);
        drawStat('AMR', amrEl.textContent, '((rho*tau)_max-(rho*tau)_min)/(rho*tau)_min', margin + pad + statW + 12, y + 18, statW);
        drawStat('A_rms', rmsEl.textContent, 'sqrt((1/N) sum_i [rho*tau(phi_i)-(rho*tau)0]^2)/|(rho*tau)0|', margin + pad + (statW + 12) * 2, y + 18, statW);
        drawStat('Dominant harmonic', domEl.textContent, domRatioEl.textContent, margin + pad + (statW + 12) * 3, y + 18, statW);

        y += metricsH + 18;
        rr(margin, y, cardW, vizH, 14);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#dfe4ee';
        ctx.fill();
        ctx.stroke();
        const leftW = (cardW - pad * 2 - 18) / 2;
        const rightW = leftW;
        drawText('Polar fingerprint (reconstructed)', margin + pad, y + 20, { font: 'bold 22px Arial, sans-serif' });
        drawText('Harmonic spectrum Rn = An / |(rho*tau)0|', margin + pad + leftW + 18, y + 20, { font: 'bold 22px Arial, sans-serif' });
        drawImageInBox(polarImg, margin + pad, y + 58, leftW, vizH - 86);
        const barX = margin + pad + leftW + 18;
        const barY = y + 72;
        const maxR = Math.max(1e-8, ...harmonics.map((h) => Number(h.ratio) || 0));
        harmonics.forEach((h, idx) => {
          const yy = barY + idx * 43;
          const pct = Math.max(0, Math.min(1, (Number(h.ratio) || 0) / maxR));
          drawText(`n = ${h.n}`, barX, yy + 5, { font: '17px Georgia, serif', color: '#334155' });
          rr(barX + 70, yy, rightW - 190, 18, 9);
          ctx.fillStyle = '#e9eef6';
          ctx.fill();
          rr(barX + 70, yy, (rightW - 190) * pct, 18, 9);
          const grad = ctx.createLinearGradient(barX + 70, yy, barX + rightW - 120, yy);
          grad.addColorStop(0, '#60a5fa');
          grad.addColorStop(1, '#2563eb');
          ctx.fillStyle = grad;
          ctx.fill();
          drawText(fmt(h.ratio, 4), barX + rightW - 100, yy - 1, { font: '16px Georgia, serif', color: '#334155' });
        });

        y += vizH + 18;
        rr(margin, y, cardW, tableH, 14);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#dfe4ee';
        ctx.fill();
        ctx.stroke();
        const cols = ['Btau', '(rho*tau)0', 'AMR', 'A_rms', 'n*', 'R_n*'];
        const widths = [180, 430, 300, 300, 180, 250];
        let x = margin + pad;
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(x, y + 20, cardW - pad * 2, 36);
        cols.forEach((col, idx) => {
          drawText(col, x + 10, y + 29, { font: 'bold 15px Arial, sans-serif', color: '#334155' });
          x += widths[idx];
        });
        summaryRows.forEach((row, ridx) => {
          const yy = y + 56 + ridx * 40;
          ctx.fillStyle = row === picked ? '#eaf1ff' : (ridx % 2 ? '#ffffff' : '#f8fafc');
          ctx.fillRect(margin + pad, yy, cardW - pad * 2, 40);
          const vals = [
            row.btauLabel,
            Number.isFinite(row.metrics.rho0) ? row.metrics.rho0.toExponential(3).replace('e', ' x 10^') : '-',
            fmt(row.metrics.amrRatio, 4),
            fmt(row.metrics.rms, 4),
            row.metrics.dominantN,
            fmt(row.metrics.dominantRatio, 4),
          ];
          x = margin + pad;
          vals.forEach((val, idx) => {
            drawText(val, x + 10, yy + 11, { font: '15px Arial, sans-serif', color: '#111827' });
            x += widths[idx];
          });
        });

        const safeId = String(id || 'material').replace(/[^\w.-]+/g, '_');
        const surface = String(surfaceSel.value || 'surface').replace(/[^\w.-]+/g, '_');
        const comp = String(compSel.value || 'comp').replace(/[^\w.-]+/g, '_');
        const filename = `${safeId}_Fourier_Anisotropy_${surface}_${comp}.png`;
        await new Promise((resolve) => {
          out.toBlob((blob) => {
            const a = document.createElement('a');
            if (blob) {
              const url = URL.createObjectURL(blob);
              a.href = url;
              setTimeout(() => URL.revokeObjectURL(url), 500);
            } else {
              a.href = out.toDataURL('image/png');
            }
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            resolve();
          }, 'image/png');
        });
      } catch {
        setHint('Anisotropy Fingerprint image export failed');
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = oldText;
      }
    }

    async function updateSimilarList(pickedRow) {
      const surface = surfaceSel.value;
      const comp = compSel.value;
      if (!surface || !comp || !pickedRow) {
        similarListEl.innerHTML = '';
        setSimilarHint('');
        return;
      }
      const seq = ++similarReqSeq;
      const bt = Number(pickedRow.btau);
      const btPart = Number.isFinite(bt) ? `&btau=${encodeURIComponent(bt)}` : '';
      const minSim = 0.97;
      const metricMeaning = 'This metric compares normalized Fourier amplitudes and is invariant under an overall angular rotation. It identifies materials with similar harmonic content rather than identical crystallographic orientation.';
      setSimilarHint('Searching similar materials...');
      try {
        const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(surface)}/similar/${encodeURIComponent(comp)}?topk=2000&min_similarity=${encodeURIComponent(minSim)}${btPart}`);
        if (seq !== similarReqSeq) return;
        const items = Array.isArray(data.items) ? data.items : [];
        similarListEl.innerHTML = '';
        if (!items.length) {
          setSimilarHint(
            `Single-combo metric: \\( d = \\sqrt{\\left\\langle\\left(R_n^{A}-R_n^{B}\\right)^2\\right\\rangle_n},\\; S = \\frac{1}{1+d} \\). ${metricMeaning} Showing \\(S \\ge ${minSim.toFixed(2)}\\); none found.`
          );
          return;
        }
        items.forEach((it) => {
          const link = document.createElement('a');
          link.className = 'mr-fourier-similar-item';
          link.href = appUrl(it.url || `/m/${encodeURIComponent(it.id || '')}`);
          link.title = `distance=${Number(it.distance || 0).toFixed(4)}, Btau=${it.btau ?? '-'}`;
          const sim = Number(it.similarity);
          link.innerHTML = `
            <span>${escapeHTML(it.name || it.id || '-')}</span>
            <span class="mr-fourier-similar-score">S=${Number.isFinite(sim) ? sim.toFixed(3) : '-'}</span>
          `;
          similarListEl.appendChild(link);
        });
        setSimilarHint(
          `Single-combo metric: \\( d = \\sqrt{\\left\\langle\\left(R_n^{A}-R_n^{B}\\right)^2\\right\\rangle_n},\\; S = \\frac{1}{1+d} \\). ` +
          `${metricMeaning} Showing all \\(S \\ge ${minSim.toFixed(2)}\\).`
        );
      } catch {
        if (seq !== similarReqSeq) return;
        similarListEl.innerHTML = '';
        setSimilarHint('Failed to load similar materials.');
      }
    }

    async function updateSimilarAllList(pickedRow) {
      if (!pickedRow) {
        similarAllListEl.innerHTML = '';
        setSimilarAllHint('');
        return;
      }
      const seq = ++similarAllReqSeq;
      const bt = Number(pickedRow.btau);
      const btPart = Number.isFinite(bt) ? `&btau=${encodeURIComponent(bt)}` : '';
      const minSim = 0.97;
      setSimilarAllHint('Searching globally consistent similar materials...');
      try {
        const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/similar_all?topk=2000&min_similarity=${encodeURIComponent(minSim)}${btPart}`);
        if (seq !== similarAllReqSeq) return;
        const items = Array.isArray(data.items) ? data.items : [];
        similarAllListEl.innerHTML = '';
        if (!items.length) {
          setSimilarAllHint(
            `Global metric: \\( d_c \\) is computed for each of 9 combos and \\( S_c = \\frac{1}{1+d_c} \\). ` +
            `Showing materials with every \\(S_c \\ge ${minSim.toFixed(2)}\\); none found.`
          );
          return;
        }
        items.forEach((it) => {
          const link = document.createElement('a');
          link.className = 'mr-fourier-similar-item';
          link.href = appUrl(it.url || `/m/${encodeURIComponent(it.id || '')}`);
          const sim = Number(it.similarity);
          const simMin = Number(it.similarity_min);
          const dmean = Number(it.distance_mean);
          const dmax = Number(it.distance_max);
          const dmatch = Number(it.dominant_match_count);
          link.title = `meanS=${Number.isFinite(sim) ? sim.toFixed(4) : '-'}, minS=${Number.isFinite(simMin) ? simMin.toFixed(4) : '-'}, meanDist=${Number.isFinite(dmean) ? dmean.toFixed(4) : '-'}, maxDist=${Number.isFinite(dmax) ? dmax.toFixed(4) : '-'}, dominantMatch=${Number.isFinite(dmatch) ? dmatch : '-'}/9`;
          link.innerHTML = `
            <span>${escapeHTML(it.name || it.id || '-')}</span>
            <span class="mr-fourier-similar-score">S<sub>min</sub>=${Number.isFinite(simMin) ? simMin.toFixed(3) : '-'}</span>
          `;
          similarAllListEl.appendChild(link);
        });
        setSimilarAllHint(
          `Global metric: \\( d_c \\) is computed for each of 9 combos and \\( S_c = \\frac{1}{1+d_c} \\). ` +
          `Showing materials with every \\(S_c \\ge ${minSim.toFixed(2)}\\).`
        );
      } catch {
        if (seq !== similarAllReqSeq) return;
        similarAllListEl.innerHTML = '';
        setSimilarAllHint('Failed to load globally consistent similar materials.');
      }
    }

    function buildSummaryFromCurrent() {
      if (!currentData || !Array.isArray(currentData.series) || !Array.isArray(currentData.angles)) {
        summaryRows = [];
        return;
      }
      summaryRows = currentData.series
        .map((s) => {
          const metrics = computeFourierMetrics(currentData.angles, s.values || [], 8);
          if (!metrics) return null;
          const bt = Number(s.btau);
          return {
            idx: Number(s.idx),
            btau: Number.isFinite(bt) ? bt : null,
            btauLabel: Number.isFinite(bt) ? bt.toFixed(1).replace(/\.0+$/, '') : `series-${Number(s.idx) + 1}`,
            metrics,
          };
        })
        .filter(Boolean);
    }

    async function loadCurrentSurfaceComp() {
      const surface = surfaceSel.value;
      const comp = compSel.value;
      if (!surface || !comp) {
        setHint('Please select plane and component');
        resetCards();
        return;
      }
      setHint('Loading Fourier data...');
      try {
        const data = await apiGet(`/api/mr/${encodeURIComponent(id)}/${encodeURIComponent(surface)}/polar/${encodeURIComponent(comp)}`);
        const angles = Array.isArray(data.angles) ? data.angles : [];
        const series = Array.isArray(data.series) ? data.series.map((s, idx) => ({
          idx,
          btau: s.btau,
          values: Array.isArray(s.values) ? s.values : [],
        })) : [];
        if (!angles.length || !series.length) {
          currentData = null;
          optionize(btauSel, [], (x) => x, (x) => x);
          resetCards();
          setHint('No Fourier data found for this material/plane/component');
          return;
        }

        currentData = { angles, series };
        optionize(
          btauSel,
          series,
          (s) => {
            const bt = Number(s.btau);
            return Number.isFinite(bt) ? bt.toFixed(1).replace(/\.0+$/, '') : `series-${s.idx + 1}`;
          },
          (s) => String(s.idx)
        );

        let preferred = series[0] ? Number(series[0].idx) : 0;
        let bestBtauDelta = Number.POSITIVE_INFINITY;
        series.forEach((s) => {
          const bt = Number(s.btau);
          if (!Number.isFinite(bt)) return;
          const delta = Math.abs(bt - 10);
          if (delta < bestBtauDelta) {
            bestBtauDelta = delta;
            preferred = Number(s.idx);
          }
        });
        btauSel.value = String(preferred);
        buildSummaryFromCurrent();
        renderSelected();
        setHint('');
      } catch {
        currentData = null;
        optionize(btauSel, [], (x) => x, (x) => x);
        resetCards();
        setHint('Fourier data unavailable for current selection');
      }
    }

    surfaceSel.addEventListener('change', loadCurrentSurfaceComp);
    compSel.addEventListener('change', loadCurrentSurfaceComp);
    btauSel.addEventListener('change', renderSelected);
    if (downloadBtn) downloadBtn.addEventListener('click', downloadFourierImage);

    await loadCurrentSurfaceComp();
    typesetMath(block);
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn();
  }
  onReady(() => { initMR(); initBand(); initMRPolar(); initMRFourier(); });
})();
