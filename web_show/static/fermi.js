(() => {
  const $ = (sel) => document.querySelector(sel);

  const GEOMETRY_EPS = 1e-7;
  const SECTION_EPS = 1e-4;
  const ONSAGER_AREA_TO_KT = 10.47576797;
  const TWO_PI_CUBED = (2 * Math.PI) ** 3;
  const SDH_SCAN_SLICES = 49;
  const BZ_NEIGHBOR_SHELL = 2;
  const DEFAULT_COLORS = [0x0c9488, 0xe26d3d, 0x226f9a, 0x8f9b2f, 0x8b5cf6, 0xef4444];

  const state = {
    avail: null,
    availId: null,
    material: null,
    bandCache: new Map(),
    selectedBandIndices: new Set(),
    bandColorMap: new Map(),
    currentIsoEnergy: 0,
    currentIsoBounds: { min: -1, max: 1, step: 0.01 },
    sectionState: {
      enabled: false,
      normalCoefficients: [0, 0, 1],
      offsetFactor: 0,
    },
    sdhState: {
      normalCoefficients: [0, 0, 1],
    },
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    contentGroup: null,
    currentSurfaces: [],
    currentFrame: null,
    currentSectionGroup: null,
    currentSdhGroup: null,
    currentSdhMeshes: [],
    sdhResultByKey: new Map(),
    sdhResultEls: new Map(),
    sdhHoverKey: null,
    sectionPreviewState: null,
    sectionUpdateToken: 0,
    renderToken: 0,
    renderTimer: null,
    animating: false,
    raycaster: null,
    pointerNdc: null,
    orthoViewRadius: 4,
  };

  function matId() {
    const path = window.location.pathname;
    const m = path.match(/\/m\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    try {
      const u = new URL(window.location.href);
      return u.searchParams.get("id");
    } catch {
      return null;
    }
  }

  function displayMaterialId(id) {
    return String(id || "").replace(/_/g, " ");
  }

  async function apiGet(path) {
    let res;
    try {
      res = await fetch(appUrl(path), { cache: "no-store" });
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      throw new Error(`${path} -> ${reason}`);
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  function setInfo(msg) {
    const el = $("#fermiInfo");
    if (el) el.textContent = msg || "";
  }

  function setSdhStatus(msg) {
    const el = $("#fermiSdhStatus");
    if (el) el.textContent = msg || "";
  }

  function setCarrierHint(msg) {
    const el = $("#fermiCarrierHint");
    if (el) el.textContent = msg || "";
  }

  function clearSdhResults() {
    const el = $("#fermiSdhResults");
    if (el) el.innerHTML = "";
  }

  function sdhResultKey(result) {
    return `${result.bandIndex}:${result.kind}:${result.sliceIndex}:${result.area.toFixed(6)}`;
  }

  function formatSdhMeta(result) {
    return `${result.frequency.toFixed(3)} kT | A=${result.area.toFixed(4)} Å⁻² | slice=${result.sliceIndex + 1}/${SDH_SCAN_SLICES}`;
  }

  function setSdhRowActive(key) {
    state.sdhResultEls.forEach((el, k) => {
      el.classList.toggle("is-active", !!key && k === key);
    });
  }

  function hideSdhHover() {
    const tip = document.getElementById("fermiSdhHover");
    if (tip) {
      tip.style.display = "none";
    }
    state.sdhHoverKey = null;
    setSdhRowActive(null);
  }

  function showSdhHover(result, clientX, clientY) {
    const tip = document.getElementById("fermiSdhHover");
    const root = document.getElementById("fermiSceneRoot");
    if (!tip || !root) return;

    const label = `Band ${result.bandIndex} | ${result.kind === "max" ? "Maximum orbit" : "Minimum orbit"}`;
    tip.innerHTML = `<strong>${label}</strong><br>${formatSdhMeta(result)}`;
    tip.style.display = "block";

    const rect = root.getBoundingClientRect();
    let x = clientX - rect.left + 12;
    let y = clientY - rect.top + 12;
    const maxX = rect.width - tip.offsetWidth - 8;
    const maxY = rect.height - tip.offsetHeight - 8;
    x = Math.max(8, Math.min(maxX, x));
    y = Math.max(8, Math.min(maxY, y));

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function showBlock(show) {
    const block = $("#fermiBlock");
    if (block) block.style.display = show ? "block" : "none";
  }

  function setLoading(show, msg) {
    const overlay = $("#fermiLoading");
    if (!overlay) return;
    overlay.style.display = show ? "block" : "none";
    if (msg) overlay.textContent = msg;
  }

  function currentDataset() {
    const sel = document.getElementById("fermiDataset");
    return sel && sel.value ? String(sel.value) : "soc";
  }

  function datasetLabel(dataset = currentDataset()) {
    return dataset === "nosoc" ? "without SOC" : "SOC";
  }

  function surfaceAngleToSpherical(surface, angleDeg) {
    const angle = Number(angleDeg) || 0;
    if (surface === "Ra_Rb_surface") {
      return { theta: 90, phi: angle };
    }
    if (surface === "Rc_Ra_surface") {
      return { theta: angle, phi: 0 };
    }
    if (surface === "Rb_Rc_surface") {
      if (angle <= 90) return { theta: 90 - angle, phi: 90 };
      return { theta: angle - 90, phi: -90 };
    }
    return null;
  }

  function sphericalDegToWorldNormal(thetaDeg, phiDeg) {
    const theta = (Number(thetaDeg) || 0) * Math.PI / 180;
    const phi = (Number(phiDeg) || 0) * Math.PI / 180;
    const sinTheta = Math.sin(theta);
    const normal = new THREE.Vector3(
      sinTheta * Math.cos(phi),
      sinTheta * Math.sin(phi),
      Math.cos(theta),
    );
    if (normal.lengthSq() < GEOMETRY_EPS) return new THREE.Vector3(0, 0, 1);
    return normal.normalize();
  }

  function buildAnalysisContext(reason = "updated") {
    const material = state.material;
    const selectedBands = getSelectedBands(material);
    return {
      reason,
      materialId: material ? material.id : null,
      dataset: material ? material.dataset : currentDataset(),
      datasetLabel: datasetLabel(material ? material.dataset : currentDataset()),
      isoEnergy: Number.isFinite(state.currentIsoEnergy) ? state.currentIsoEnergy : null,
      bandIndices: selectedBands.map((band) => band.index),
    };
  }

  function emitAnalysisState(reason = "updated") {
    window.dispatchEvent(new CustomEvent("fermi:analysis-state", {
      detail: buildAnalysisContext(reason),
    }));
  }

  function apiPath(id, dataset = currentDataset(), suffix = "") {
    const base = `/api/fermi/${encodeURIComponent(id)}${suffix}`;
    if (dataset === "nosoc") {
      return appUrl(`${base}${base.includes("?") ? "&" : "?"}dataset=nosoc`);
    }
    return appUrl(base);
  }

  function updateDownloadButton(id, avail) {
    const btn = document.getElementById("fermiDownloadBxsf");
    if (!btn) return;
    const dataset = currentDataset();
    let canDownload = false;
    let href = "";

    if (dataset === "nosoc") {
      canDownload = !avail || !!avail.nosoc;
    } else {
      canDownload = !avail || !!avail.soc;
    }
    href = apiPath(id, dataset, "/bxsf");

    if (!canDownload) {
      btn.style.display = "none";
      btn.onclick = null;
      return;
    }

    btn.style.display = "inline-flex";
    btn.onclick = () => {
      try {
        const a = document.createElement("a");
        a.href = href;
        a.download = "FS3D.bxsf";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch {
        window.location.href = href;
      }
    };
  }

  async function ensureDatasetOptions(id) {
    const sel = document.getElementById("fermiDataset");
    const row = document.querySelector(".fermi-dataset-row");
    if (!sel) return { soc: false, nosoc: false };

    const curVal = sel.value ? String(sel.value) : "soc";
    if (state.availId === id && state.avail) {
      const a = state.avail;
      const opts = [];
      if (a.soc) opts.push({ value: "soc", label: "SOC" });
      if (a.nosoc) opts.push({ value: "nosoc", label: "without SOC" });
      sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
      if (opts.length) {
        sel.value = opts.some((o) => o.value === curVal) ? curVal : opts[0].value;
      }
      if (row) row.style.display = opts.length ? "flex" : "none";
      return a;
    }

    const [socMeta, nosocMeta] = await Promise.all([
      apiGet(apiPath(id, "soc")).catch(() => ({ available: false })),
      apiGet(apiPath(id, "nosoc")).catch(() => ({ available: false })),
    ]);

    const avail = { soc: !!socMeta.available, nosoc: !!nosocMeta.available };
    state.availId = id;
    state.avail = avail;

    const options = [];
    if (avail.soc) options.push({ value: "soc", label: "SOC" });
    if (avail.nosoc) options.push({ value: "nosoc", label: "without SOC" });
    sel.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (options.length) {
      sel.value = options.some((o) => o.value === curVal) ? curVal : options[0].value;
    }
    if (row) row.style.display = options.length ? "flex" : "none";

    return avail;
  }

  function clampToRange(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function clampSignedUnit(value) {
    return Math.min(1, Math.max(-1, value));
  }

  function formatEnergy(value) {
    return `${Number(value).toFixed(4)} eV`;
  }

  function formatScientific(value, digits = 3) {
    if (!Number.isFinite(value)) return "-";
    if (Math.abs(value) < 1e-30) return "0";
    const exponent = Math.floor(Math.log10(Math.abs(value)));
    const mantissa = value / (10 ** exponent);
    return `${mantissa.toFixed(digits)}e${exponent >= 0 ? "+" : ""}${exponent}`;
  }

  function determinant3(rows) {
    if (!Array.isArray(rows) || rows.length < 3) return NaN;
    const [a, b, c] = rows;
    return (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    );
  }

  function getRealCellVolumeA3(material) {
    if (!material || !Array.isArray(material.basis) || material.basis.length < 3) return NaN;
    const reciprocalVolume = Math.abs(determinant3(material.basis));
    if (!(reciprocalVolume > GEOMETRY_EPS)) return NaN;
    return TWO_PI_CUBED / reciprocalVolume;
  }

  function getReciprocalCellVolume(material) {
    if (!material || !Array.isArray(material.basis) || material.basis.length < 3) return NaN;
    return Math.abs(determinant3(material.basis));
  }

  function getCarrierSpinFactor(material) {
    return material && material.dataset === "nosoc" ? 2 : 1;
  }

  function getPeriodicVoxelShape(dims) {
    return [
      Math.max(1, (dims[0] || 2) - 1),
      Math.max(1, (dims[1] || 2) - 1),
      Math.max(1, (dims[2] || 2) - 1),
    ];
  }

  function collectPeriodicComponents(mask, shape, targetValue) {
    const [nx, ny, nz] = shape;
    const plane = nx * ny;
    const total = plane * nz;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    const liftX = new Int32Array(total);
    const liftY = new Int32Array(total);
    const liftZ = new Int32Array(total);
    const components = [];
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    for (let start = 0; start < total; start += 1) {
      if (visited[start] || mask[start] !== targetValue) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      const startZ = Math.floor(start / plane);
      const startRem = start - startZ * plane;
      const startY = Math.floor(startRem / nx);
      const startX = startRem - startY * nx;
      liftX[start] = startX;
      liftY[start] = startY;
      liftZ[start] = startZ;

      let count = 0;
      let crossesBoundary = false;
      let winds = false;

      while (head < tail) {
        const idx = queue[head++];
        count += 1;

        const iz = Math.floor(idx / plane);
        const rem = idx - iz * plane;
        const iy = Math.floor(rem / nx);
        const ix = rem - iy * nx;

        for (let d = 0; d < directions.length; d += 1) {
          const [dx, dy, dz] = directions[d];
          let jx = ix + dx;
          let jy = iy + dy;
          let jz = iz + dz;
          let crossed = false;

          if (jx < 0) {
            jx = nx - 1;
            crossed = true;
          } else if (jx >= nx) {
            jx = 0;
            crossed = true;
          }
          if (jy < 0) {
            jy = ny - 1;
            crossed = true;
          } else if (jy >= ny) {
            jy = 0;
            crossed = true;
          }
          if (jz < 0) {
            jz = nz - 1;
            crossed = true;
          } else if (jz >= nz) {
            jz = 0;
            crossed = true;
          }

          const neighbor = jx + nx * (jy + ny * jz);
          if (mask[neighbor] !== targetValue) continue;
          if (crossed) crossesBoundary = true;

          const expectedX = liftX[idx] + dx;
          const expectedY = liftY[idx] + dy;
          const expectedZ = liftZ[idx] + dz;

          if (!visited[neighbor]) {
            visited[neighbor] = 1;
            liftX[neighbor] = expectedX;
            liftY[neighbor] = expectedY;
            liftZ[neighbor] = expectedZ;
            queue[tail++] = neighbor;
            continue;
          }

          if (
            liftX[neighbor] !== expectedX
            || liftY[neighbor] !== expectedY
            || liftZ[neighbor] !== expectedZ
          ) {
            winds = true;
          }
        }
      }

      components.push({ count, crossesBoundary, winds });
    }

    return components;
  }

  function getPocketClosureMeta(component) {
    if (component && component.winds) {
      return {
        key: "open",
        label: "open / wrapping",
        className: "is-open",
        isClosed: false,
      };
    }
    if (component && component.crossesBoundary) {
      return {
        key: "closed-periodic",
        label: "closed across BZ",
        className: "is-closed-periodic",
        isClosed: true,
      };
    }
    return {
      key: "closed",
      label: "closed",
      className: "is-closed",
      isClosed: true,
    };
  }

  function analyzeBandCarrierPockets(material, band) {
    const values = band.volume instanceof Float32Array ? band.volume : null;
    if (!values || !values.length) return [];

    const reciprocalVolume = getReciprocalCellVolume(material);
    if (!(reciprocalVolume > GEOMETRY_EPS)) return [];

    const shape = getPeriodicVoxelShape(material.dims);
    const [nx, ny, nz] = shape;
    const total = nx * ny * nz;
    if (total <= 0) return [];

    const mask = new Uint8Array(total);
    let cursor = 0;
    for (let iz = 0; iz < nz; iz += 1) {
      for (let iy = 0; iy < ny; iy += 1) {
        for (let ix = 0; ix < nx; ix += 1) {
          const fx = (ix + 0.5) / nx;
          const fy = (iy + 0.5) / ny;
          const fz = (iz + 0.5) / nz;
          mask[cursor] = sampleVolume(values, material.dims, fx, fy, fz) <= state.currentIsoEnergy ? 1 : 0;
          cursor += 1;
        }
      }
    }

    const spinFactor = getCarrierSpinFactor(material);
    const voxelVolume = reciprocalVolume / total;
    const rows = [];

    const pushPocketRows = (components, character, className) => {
      const groups = new Map();
      components.forEach((component) => {
        if (component.count <= 1) return;
        const closure = getPocketClosureMeta(component);
        const group = groups.get(closure.key) || {
          pocketCount: 0,
          voxelCount: 0,
          closureLabel: closure.label,
          closureClassName: closure.className,
          isClosed: closure.isClosed,
        };
        group.pocketCount += 1;
        group.voxelCount += component.count;
        groups.set(closure.key, group);
      });

      ["closed", "closed-periodic", "open"].forEach((key) => {
        const group = groups.get(key);
        if (!group) return;
        const componentVolume = group.voxelCount * voxelVolume;
        const isOpenGroup = key === "open";
        rows.push({
          bandIndex: band.index,
          pocketCount: group.pocketCount,
          character: isOpenGroup ? "open sheet" : character,
          sourceCharacter: character,
          className: isOpenGroup ? "is-neutral" : className,
          closureLabel: group.closureLabel,
          closureClassName: group.closureClassName,
          isClosed: group.isClosed,
          pocketVolume: componentVolume,
          carrierPerCell: group.isClosed ? spinFactor * componentVolume / reciprocalVolume : null,
          concentrationCm3: group.isClosed ? spinFactor * componentVolume * 1e24 / TWO_PI_CUBED : null,
        });
      });
    };

    pushPocketRows(collectPeriodicComponents(mask, shape, 1), "electron", "is-electron");
    pushPocketRows(collectPeriodicComponents(mask, shape, 0), "hole", "is-hole");

    return rows;
  }

  function clearCarrierPanel(message = "Load the Fermi surface to evaluate carrier concentration.") {
    const block = document.getElementById("fermiCarrierBlock");
    const rows = document.getElementById("fermiCarrierRows");
    const dataset = document.getElementById("fermiCarrierDataset");
    const cellVolume = document.getElementById("fermiCarrierCellVolume");
    const electronTotal = document.getElementById("fermiCarrierElectronTotal");
    const holeTotal = document.getElementById("fermiCarrierHoleTotal");
    if (block) block.style.display = "block";
    if (rows) rows.innerHTML = "";
    if (dataset) dataset.textContent = "-";
    if (cellVolume) cellVolume.textContent = "-";
    if (electronTotal) electronTotal.textContent = "-";
    if (holeTotal) holeTotal.textContent = "-";
    setCarrierHint(message);
  }

  async function updateCarrierPanel(material = state.material) {
    const block = document.getElementById("fermiCarrierBlock");
    const rows = document.getElementById("fermiCarrierRows");
    const datasetEl = document.getElementById("fermiCarrierDataset");
    const cellVolumeEl = document.getElementById("fermiCarrierCellVolume");
    const electronTotalEl = document.getElementById("fermiCarrierElectronTotal");
    const holeTotalEl = document.getElementById("fermiCarrierHoleTotal");
    if (!block || !rows || !datasetEl || !cellVolumeEl || !electronTotalEl || !holeTotalEl) return;

    if (!material) {
      clearCarrierPanel("Load the Fermi surface to evaluate carrier concentration.");
      return;
    }

    const selectedBands = getSelectedBands(material);
    block.style.display = "block";
    rows.innerHTML = "";

    datasetEl.textContent = `${datasetLabel(material.dataset)} / ${formatEnergy(state.currentIsoEnergy)}`;
    const cellVolumeA3 = getRealCellVolumeA3(material);
    const spinFactor = getCarrierSpinFactor(material);
    cellVolumeEl.textContent = Number.isFinite(cellVolumeA3) ? cellVolumeA3.toFixed(4) : "-";

    if (!selectedBands.length) {
      electronTotalEl.textContent = "0";
      holeTotalEl.textContent = "0";
      setCarrierHint("Select at least one band above to evaluate carrier concentration.");
      return;
    }

    let totalElectronCm3 = 0;
    let totalHoleCm3 = 0;
    const openBandIndices = new Set();

    const appendCarrierRow = (band, row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <span class="fermi-carrier-band">
            <span class="fermi-carrier-dot" style="background:${formatLegendColor(band.index)};"></span>
            <span>Band ${band.index}</span>
          </span>
        </td>
        <td class="fermi-carrier-mono">${row.pocketCount || "-"}</td>
        <td><span class="fermi-carrier-character ${row.className}">${row.character}</span></td>
        <td><span class="fermi-carrier-closure ${row.closureClassName}">${row.closureLabel}</span></td>
        <td class="fermi-carrier-mono">${row.pocketVolume > 0 ? row.pocketVolume.toFixed(6) : "-"}</td>
        <td class="fermi-carrier-mono">${Number.isFinite(row.carrierPerCell) ? row.carrierPerCell.toFixed(6) : "-"}</td>
        <td class="fermi-carrier-mono">${Number.isFinite(row.concentrationCm3) ? formatScientific(row.concentrationCm3, 4) : "-"}</td>
      `;
      rows.appendChild(tr);
    };

    for (const band of selectedBands) {
      await ensureBandVolume(material, band);
      const pocketRows = analyzeBandCarrierPockets(material, band);
      if (!pocketRows.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>
            <span class="fermi-carrier-band">
              <span class="fermi-carrier-dot" style="background:${formatLegendColor(band.index)};"></span>
              <span>Band ${band.index}</span>
            </span>
          </td>
          <td class="fermi-carrier-mono">0</td>
          <td><span class="fermi-carrier-character is-neutral">no pocket</span></td>
          <td class="fermi-carrier-mono">-</td>
          <td class="fermi-carrier-mono">-</td>
          <td class="fermi-carrier-mono">0</td>
          <td class="fermi-carrier-mono">0</td>
        `;
        rows.appendChild(tr);
        continue;
      }

      const closedRows = [];
      const openRows = [];
      pocketRows.forEach((row) => {
        if (row.character === "electron" && Number.isFinite(row.concentrationCm3)) totalElectronCm3 += row.concentrationCm3;
        if (row.character === "hole" && Number.isFinite(row.concentrationCm3)) totalHoleCm3 += row.concentrationCm3;
        if (!row.isClosed) {
          openBandIndices.add(row.bandIndex);
          openRows.push(row);
        } else {
          closedRows.push(row);
        }
      });

      closedRows.forEach((row) => appendCarrierRow(band, row));

      const openSides = new Set(openRows.map((row) => row.sourceCharacter).filter(Boolean));
      const hideComplementaryOpenBackground = closedRows.length > 0 && openSides.size <= 1;

      if (openRows.length && !hideComplementaryOpenBackground) {
        appendCarrierRow(band, {
          pocketCount: openRows.reduce((sum, row) => sum + (Number(row.pocketCount) || 0), 0),
          character: "open sheet",
          sourceCharacter: "open",
          className: "is-neutral",
          closureLabel: "open / wrapping",
          closureClassName: "is-open",
          pocketVolume: NaN,
          carrierPerCell: null,
          concentrationCm3: null,
        });
      }
    }

    electronTotalEl.textContent = totalElectronCm3 > 0 ? formatScientific(totalElectronCm3, 4) : "0";
    holeTotalEl.textContent = totalHoleCm3 > 0 ? formatScientific(totalHoleCm3, 4) : "0";
    setCarrierHint(
      openBandIndices.size
        ? `Strict carrier density is summed only from rows marked "closed" or "closed across BZ". ${openBandIndices.size} band(s) still contain genuinely open / wrapping sheets; complementary background open regions are hidden, and only nontrivial open sheets are merged into one "open sheet" row per band. Spin factor g=${spinFactor}.`
        : `Strict carrier density is summed from closed pockets only. "closed across BZ" means a pocket crosses a first-BZ face but becomes finite after periodic stitching to neighboring Brillouin zones. Spin factor g=${spinFactor}.`
    );
  }

  function getDefaultBandColor(index) {
    const hex = DEFAULT_COLORS[(index - 1) % DEFAULT_COLORS.length];
    return [
      ((hex >> 16) & 0xff) / 255,
      ((hex >> 8) & 0xff) / 255,
      (hex & 0xff) / 255,
    ];
  }

  function getBandColor(index) {
    return state.bandColorMap.get(index) || getDefaultBandColor(index);
  }

  function setBandColor(index, channel, rawValue) {
    const next = [...getBandColor(index)];
    const parsed = Number.parseFloat(rawValue);
    if (Number.isFinite(parsed)) next[channel] = clamp01(parsed);
    state.bandColorMap.set(index, next);
    return next;
  }

  function formatLegendColor(index) {
    return `rgb(${getBandColor(index).map((v) => Math.round(v * 255)).join(" ")})`;
  }

  function getBandColorLinear(index) {
    const rgb = getBandColor(index);
    const color = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]);
    if (typeof color.convertSRGBToLinear === "function") color.convertSRGBToLinear();
    return color;
  }

  function getSelectedBands(material = state.material) {
    if (!material) return [];
    return material.bands.filter((band) => state.selectedBandIndices.has(band.index));
  }

  function setBandPickerOpen(isOpen) {
    const picker = document.getElementById("fermiBandPicker");
    const btn = document.getElementById("fermiBandPickerBtn");
    const menu = document.getElementById("fermiBandPickerMenu");
    if (!picker || !btn || !menu) return;
    picker.classList.toggle("is-open", !!isOpen);
    menu.classList.toggle("is-hidden", !isOpen);
    btn.setAttribute("aria-expanded", String(!!isOpen));
  }

  function updateBandPickerLabel() {
    const label = document.getElementById("fermiBandPickerLabel");
    if (!label) return;
    const selected = getSelectedBands();
    if (!selected.length) {
      label.textContent = "No bands selected";
      return;
    }
    if (selected.length === 1) {
      label.textContent = `Band ${selected[0].index}`;
      return;
    }
    label.textContent = `Bands ${selected.map((b) => b.index).join(", ")}`;
  }

  function updateLegend(bands) {
    const root = document.getElementById("fermiLegend");
    if (!root) return;
    root.innerHTML = "";

    if (!bands.length) {
      const empty = document.createElement("span");
      empty.className = "fermi-ws-legend-empty";
      empty.textContent = "No bands selected";
      root.appendChild(empty);
      return;
    }

    bands.forEach((band) => {
      const item = document.createElement("span");
      item.className = "fermi-ws-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "fermi-ws-legend-swatch";
      swatch.style.background = formatLegendColor(band.index);
      const text = document.createElement("span");
      text.textContent = `Band ${band.index}`;
      item.append(swatch, text);
      root.appendChild(item);
    });
  }

  function populateBandPicker(material) {
    const menu = document.getElementById("fermiBandPickerMenu");
    if (!menu) return;
    menu.innerHTML = "";

    material.bands.forEach((band) => {
      const row = document.createElement("div");
      row.className = "fermi-band-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "fermi-band-option-check";
      checkbox.value = String(band.index);
      checkbox.checked = state.selectedBandIndices.has(band.index);

      const titleWrap = document.createElement("span");
      titleWrap.className = "fermi-band-option-copy";
      const title = document.createElement("span");
      title.className = "fermi-band-option-title";
      title.textContent = `Band ${band.index}, RGB :`;
      titleWrap.appendChild(title);

      const rgb = document.createElement("div");
      rgb.className = "fermi-band-option-rgb-group";
      const color = getBandColor(band.index);
      color.forEach((value, channel) => {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "fermi-band-option-rgb-input";
        input.min = "0";
        input.max = "1";
        input.step = "0.01";
        input.value = value.toFixed(6);
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("change", () => {
          const next = setBandColor(band.index, channel, input.value);
          input.value = next[channel].toFixed(6);
          if (state.selectedBandIndices.has(band.index)) requestRender(20);
        });
        rgb.appendChild(input);
      });

      row.append(checkbox, titleWrap, rgb);
      menu.appendChild(row);

      row.addEventListener("click", (event) => {
        if (event.target === checkbox || event.target.classList.contains("fermi-band-option-rgb-input")) {
          return;
        }
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      });

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedBandIndices.add(band.index);
        else state.selectedBandIndices.delete(band.index);
        updateBandPickerLabel();
        requestRender(20);
      });
    });

    updateBandPickerLabel();
  }

  function getIsoEnergyBounds(material) {
    let min = Infinity;
    let max = -Infinity;

    material.bands.forEach((band) => {
      if (Number.isFinite(band.min)) min = Math.min(min, band.min);
      if (Number.isFinite(band.max)) max = Math.max(max, band.max);
    });

    if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < GEOMETRY_EPS) {
      min = material.fermiEnergy - 1;
      max = material.fermiEnergy + 1;
    }

    const span = Math.max(max - min, 0.01);
    return {
      min,
      max,
      step: Math.max(span / 400, 0.001),
    };
  }

  function syncIsoEnergyControls(material, nextValue = state.currentIsoEnergy) {
    state.currentIsoBounds = getIsoEnergyBounds(material);
    state.currentIsoEnergy = clampToRange(nextValue, state.currentIsoBounds.min, state.currentIsoBounds.max);

    const slider = document.getElementById("fermiIsoSlider");
    const number = document.getElementById("fermiIsoNumber");
    const range = document.getElementById("fermiIsoRange");

    if (slider) {
      slider.min = state.currentIsoBounds.min.toFixed(4);
      slider.max = state.currentIsoBounds.max.toFixed(4);
      slider.step = state.currentIsoBounds.step.toFixed(5);
      slider.value = state.currentIsoEnergy.toFixed(5);
    }

    if (number) {
      number.min = state.currentIsoBounds.min.toFixed(4);
      number.max = state.currentIsoBounds.max.toFixed(4);
      number.step = state.currentIsoBounds.step.toFixed(5);
      number.value = state.currentIsoEnergy.toFixed(5);
    }

    if (range) {
      range.textContent =
        `Range: ${formatEnergy(state.currentIsoBounds.min)} to ${formatEnergy(state.currentIsoBounds.max)} | Default Ef: ${formatEnergy(material.fermiEnergy)}`;
    }
  }

  function setIsoEnergy(rawValue) {
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) {
      if (state.material) syncIsoEnergyControls(state.material, state.currentIsoEnergy);
      return false;
    }

    state.currentIsoEnergy = clampToRange(parsed, state.currentIsoBounds.min, state.currentIsoBounds.max);

    const slider = document.getElementById("fermiIsoSlider");
    const number = document.getElementById("fermiIsoNumber");
    if (slider) slider.value = state.currentIsoEnergy.toFixed(5);
    if (number) number.value = state.currentIsoEnergy.toFixed(5);
    return true;
  }

  function parseSectionInput(input, fallback) {
    if (!input) return fallback;
    const parsed = Number.parseFloat(input.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function syncSectionStateFromUi({ preserveOffset = true } = {}) {
    const enabledEl = document.getElementById("fermiSectionEnabled");
    const n1 = document.getElementById("fermiSectionN1");
    const n2 = document.getElementById("fermiSectionN2");
    const n3 = document.getElementById("fermiSectionN3");
    const offsetEl = document.getElementById("fermiSectionOffset");

    state.sectionState.enabled = !!(enabledEl && enabledEl.checked);
    state.sectionState.normalCoefficients = [
      parseSectionInput(n1, state.sectionState.normalCoefficients[0]),
      parseSectionInput(n2, state.sectionState.normalCoefficients[1]),
      parseSectionInput(n3, state.sectionState.normalCoefficients[2]),
    ];

    const nextOffset = preserveOffset
      ? parseSectionInput(offsetEl, state.sectionState.offsetFactor)
      : 0;
    state.sectionState.offsetFactor = clampSignedUnit(nextOffset);
    if (offsetEl) offsetEl.value = state.sectionState.offsetFactor.toFixed(2);
  }

  function syncSdhStateFromUi() {
    const n1 = document.getElementById("fermiSdhN1");
    const n2 = document.getElementById("fermiSdhN2");
    const n3 = document.getElementById("fermiSdhN3");

    state.sdhState.normalCoefficients = [
      parseSectionInput(n1, state.sdhState.normalCoefficients[0]),
      parseSectionInput(n2, state.sdhState.normalCoefficients[1]),
      parseSectionInput(n3, state.sdhState.normalCoefficients[2]),
    ];
  }

  function setSectionCanvasMessage(message) {
    const empty = document.getElementById("fermiSectionEmpty");
    if (!empty) return;
    empty.textContent = message;
    empty.classList.toggle("is-hidden", !message);
  }

  function clearSectionCanvas() {
    const canvas = document.getElementById("fermiSectionCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function buildSectionPlaneBasis(normal) {
    const reference = Math.abs(normal.z) < 0.92
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(reference, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    return { u, v };
  }

  function projectPointToSection(point, origin, basis) {
    const delta = new THREE.Vector3().subVectors(point, origin);
    return {
      x: delta.dot(basis.u),
      y: delta.dot(basis.v),
    };
  }

  function collectProjectedSectionSegments(positions, origin, basis) {
    const segments = [];
    for (let i = 0; i < positions.length; i += 6) {
      const start = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
      const end = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
      segments.push({
        start: projectPointToSection(start, origin, basis),
        end: projectPointToSection(end, origin, basis),
      });
    }
    return segments;
  }

  function makeProjectedKey(point, tolerance) {
    return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`;
  }

  function computeSignedLoopArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const cur = points[i];
      const next = points[(i + 1) % points.length];
      area += cur.x * next.y - next.x * cur.y;
    }
    return area * 0.5;
  }

  function computeLoopArea(points) {
    return Math.abs(computeSignedLoopArea(points));
  }

  function computeLoopCentroid(points) {
    const center = { x: 0, y: 0 };
    points.forEach((p) => {
      center.x += p.x;
      center.y += p.y;
    });
    center.x /= points.length;
    center.y /= points.length;
    return center;
  }

  function buildClosedLoopsFromPositions(positions, origin, basis, tolerance) {
    const nodes = new Map();
    const edgeKeys = new Set();

    for (let i = 0; i < positions.length; i += 6) {
      const startWorld = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
      const endWorld = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
      const startProjected = projectPointToSection(startWorld, origin, basis);
      const endProjected = projectPointToSection(endWorld, origin, basis);

      const startKey = makeProjectedKey(startProjected, tolerance);
      const endKey = makeProjectedKey(endProjected, tolerance);
      if (startKey === endKey) continue;

      if (!nodes.has(startKey)) {
        nodes.set(startKey, {
          key: startKey,
          projected: startProjected,
          world: startWorld,
          neighbors: new Set(),
        });
      }
      if (!nodes.has(endKey)) {
        nodes.set(endKey, {
          key: endKey,
          projected: endProjected,
          world: endWorld,
          neighbors: new Set(),
        });
      }

      const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      nodes.get(startKey).neighbors.add(endKey);
      nodes.get(endKey).neighbors.add(startKey);
    }

    const usedEdges = new Set();
    const loops = [];

    for (const [key, node] of nodes) {
      for (const neighbor of node.neighbors) {
        const initialEdgeKey = key < neighbor ? `${key}|${neighbor}` : `${neighbor}|${key}`;
        if (usedEdges.has(initialEdgeKey)) continue;

        const path = [key];
        let previous = key;
        let current = neighbor;
        let closed = false;

        while (true) {
          const edgeKey = previous < current ? `${previous}|${current}` : `${current}|${previous}`;
          usedEdges.add(edgeKey);

          if (current === key) {
            closed = true;
            break;
          }

          path.push(current);
          const options = [...nodes.get(current).neighbors].filter((candidate) => candidate !== previous);
          if (!options.length) break;

          const unusedOption =
            options.find((candidate) => {
              const nextEdgeKey = current < candidate ? `${current}|${candidate}` : `${candidate}|${current}`;
              return !usedEdges.has(nextEdgeKey);
            }) ?? options[0];

          previous = current;
          current = unusedOption;

          if (path.length > nodes.size + 2) break;
        }

        if (!closed || path.length < 3) continue;

        const projectedPoints = path.map((nodeKey) => nodes.get(nodeKey).projected);
        const worldPoints = path.map((nodeKey) => nodes.get(nodeKey).world.clone());
        const area = computeLoopArea(projectedPoints);
        if (area <= tolerance ** 2) continue;

        loops.push({
          projectedPoints,
          worldPoints,
          centroid: computeLoopCentroid(projectedPoints),
          area,
        });
      }
    }

    return loops;
  }

  function findMatchingLoop(targetLoop, candidateLoops, centerTolerance, areaTolerance = 0.8) {
    let bestMatch = null;
    let bestScore = Infinity;

    for (const candidate of candidateLoops) {
      const dx = candidate.centroid.x - targetLoop.centroid.x;
      const dy = candidate.centroid.y - targetLoop.centroid.y;
      const distance = Math.hypot(dx, dy);
      if (distance > centerTolerance) continue;

      const relativeAreaDiff = Math.abs(candidate.area - targetLoop.area) / Math.max(targetLoop.area, 1e-6);
      if (relativeAreaDiff > areaTolerance) continue;

      const score = distance + relativeAreaDiff * centerTolerance;
      if (score < bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    return bestMatch;
  }

  function isPointOnSegment2D(point, start, end, tolerance = 1e-6) {
    const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
    if (Math.abs(cross) > tolerance) return false;

    const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
    if (dot < -tolerance) return false;

    const squaredLength = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    return dot <= squaredLength + tolerance;
  }

  function isPointInsidePolygon2D(point, polygon, tolerance = 1e-6) {
    if (polygon.length < 3) return false;

    for (let i = 0; i < polygon.length; i += 1) {
      const start = polygon[i];
      const end = polygon[(i + 1) % polygon.length];
      if (isPointOnSegment2D(point, start, end, tolerance)) return true;
    }

    let inside = false;
    for (let i = 0, prev = polygon.length - 1; i < polygon.length; prev = i, i += 1) {
      const cur = polygon[i];
      const prior = polygon[prev];
      const crosses = cur.y > point.y !== prior.y > point.y
        && point.x < ((prior.x - cur.x) * (point.y - cur.y)) / ((prior.y - cur.y) || tolerance) + cur.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function orientation2D(a, b, c, tolerance = 1e-9) {
    const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(value) <= tolerance) return 0;
    return value > 0 ? 1 : -1;
  }

  function segmentsIntersect2D(a1, a2, b1, b2, tolerance = 1e-6) {
    const o1 = orientation2D(a1, a2, b1);
    const o2 = orientation2D(a1, a2, b2);
    const o3 = orientation2D(b1, b2, a1);
    const o4 = orientation2D(b1, b2, a2);

    if (o1 !== o2 && o3 !== o4) return true;

    return (
      (o1 === 0 && isPointOnSegment2D(b1, a1, a2, tolerance))
      || (o2 === 0 && isPointOnSegment2D(b2, a1, a2, tolerance))
      || (o3 === 0 && isPointOnSegment2D(a1, b1, b2, tolerance))
      || (o4 === 0 && isPointOnSegment2D(a2, b1, b2, tolerance))
    );
  }

  function doesLoopOverlapPolygon(loop, polygon) {
    if (polygon.length < 3 || loop.projectedPoints.length < 3) return false;

    if (loop.projectedPoints.some((point) => isPointInsidePolygon2D(point, polygon))) return true;
    if (polygon.some((point) => isPointInsidePolygon2D(point, loop.projectedPoints))) return true;

    for (let i = 0; i < loop.projectedPoints.length; i += 1) {
      const ls = loop.projectedPoints[i];
      const le = loop.projectedPoints[(i + 1) % loop.projectedPoints.length];
      for (let j = 0; j < polygon.length; j += 1) {
        const ps = polygon[j];
        const pe = polygon[(j + 1) % polygon.length];
        if (segmentsIntersect2D(ls, le, ps, pe)) return true;
      }
    }

    return false;
  }

  function dedupeExtremalOrbits(results, centerTolerance) {
    const deduped = [];

    for (const result of results.sort((left, right) => Math.abs(right.curvature) - Math.abs(left.curvature))) {
      const duplicate = deduped.find((candidate) => {
        if (candidate.bandIndex !== result.bandIndex || candidate.kind !== result.kind) return false;
        const dx = candidate.centroid.x - result.centroid.x;
        const dy = candidate.centroid.y - result.centroid.y;
        const distance = Math.hypot(dx, dy);
        const relativeAreaDiff = Math.abs(candidate.area - result.area) / Math.max(result.area, 1e-6);
        return distance <= centerTolerance && relativeAreaDiff <= 0.1;
      });
      if (!duplicate) deduped.push(result);
    }

    return deduped;
  }

  function buildOrbitHighlight(points, color, radius) {
    const curve = new THREE.CatmullRomCurve3(points, true, "catmullrom", 0.08);
    const tubularSegments = Math.max(points.length * 4, 48);
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 10, true);
    return new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.96,
      })
    );
  }

  function basisToMatrix3(basis) {
    return new THREE.Matrix3().set(
      basis[0][0], basis[1][0], basis[2][0],
      basis[0][1], basis[1][1], basis[2][1],
      basis[0][2], basis[1][2], basis[2][2]
    );
  }

  function buildBrillouinPlanes(basisVectors) {
    const planes = [];

    for (let i = -BZ_NEIGHBOR_SHELL; i <= BZ_NEIGHBOR_SHELL; i += 1) {
      for (let j = -BZ_NEIGHBOR_SHELL; j <= BZ_NEIGHBOR_SHELL; j += 1) {
        for (let k = -BZ_NEIGHBOR_SHELL; k <= BZ_NEIGHBOR_SHELL; k += 1) {
          if (i === 0 && j === 0 && k === 0) continue;

          const vec = new THREE.Vector3()
            .addScaledVector(basisVectors[0], i)
            .addScaledVector(basisVectors[1], j)
            .addScaledVector(basisVectors[2], k);
          const len = vec.length();
          if (len < GEOMETRY_EPS) continue;

          planes.push({
            normal: vec.multiplyScalar(1 / len),
            offset: 0.5 * len,
          });
        }
      }
    }

    return planes;
  }

  function intersectThreePlanes(pa, pb, pc) {
    const crossBC = new THREE.Vector3().crossVectors(pb.normal, pc.normal);
    const denom = pa.normal.dot(crossBC);
    if (Math.abs(denom) < GEOMETRY_EPS) return null;

    const termA = crossBC.multiplyScalar(pa.offset);
    const termB = new THREE.Vector3()
      .crossVectors(pc.normal, pa.normal)
      .multiplyScalar(pb.offset);
    const termC = new THREE.Vector3()
      .crossVectors(pa.normal, pb.normal)
      .multiplyScalar(pc.offset);

    return termA.add(termB).add(termC).multiplyScalar(1 / denom);
  }

  function pointInsidePlanes(x, y, z, planes, tolerance = GEOMETRY_EPS) {
    for (const plane of planes) {
      const d = plane.normal.x * x + plane.normal.y * y + plane.normal.z * z;
      if (d > plane.offset + tolerance) return false;
    }
    return true;
  }

  function buildBoundsTransform(bounds) {
    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const halfSpan = new THREE.Vector3().subVectors(bounds.max, bounds.min).multiplyScalar(0.5);
    return new THREE.Matrix4().set(
      halfSpan.x, 0, 0, center.x,
      0, halfSpan.y, 0, center.y,
      0, 0, halfSpan.z, center.z,
      0, 0, 0, 1
    );
  }

  function expandBounds(bounds, padding) {
    return {
      min: bounds.min.clone().addScalar(-padding),
      max: bounds.max.clone().addScalar(padding),
    };
  }

  function buildFirstBrillouinZone(basis) {
    const basisVectors = basis.map((vec) => new THREE.Vector3(...vec));
    const allPlanes = buildBrillouinPlanes(basisVectors);
    if (!allPlanes.length) throw new Error("Unable to build Brillouin-zone planes");

    const zoneScale = Math.max(...basisVectors.map((v) => v.length()), 1);
    const vertexTolerance = Math.max(zoneScale * 1e-4, 1e-5);
    const facetTolerance = Math.max(zoneScale * 2e-4, 2e-5);

    const vertices = [];
    const seenVertices = new Set();

    for (let i = 0; i < allPlanes.length - 2; i += 1) {
      for (let j = i + 1; j < allPlanes.length - 1; j += 1) {
        for (let k = j + 1; k < allPlanes.length; k += 1) {
          const point = intersectThreePlanes(allPlanes[i], allPlanes[j], allPlanes[k]);
          if (!point) continue;
          if (!pointInsidePlanes(point.x, point.y, point.z, allPlanes, facetTolerance)) continue;

          const key = [
            Math.round(point.x / vertexTolerance),
            Math.round(point.y / vertexTolerance),
            Math.round(point.z / vertexTolerance),
          ].join(":");
          if (seenVertices.has(key)) continue;
          seenVertices.add(key);

          const activePlanes = [];
          for (let p = 0; p < allPlanes.length; p += 1) {
            const plane = allPlanes[p];
            const d = plane.normal.x * point.x + plane.normal.y * point.y + plane.normal.z * point.z;
            if (Math.abs(d - plane.offset) <= facetTolerance) activePlanes.push(p);
          }

          vertices.push({ position: point, activePlanes });
        }
      }
    }

    if (vertices.length < 4) throw new Error("Failed to construct first Brillouin zone vertices");

    const activePlaneSet = new Set();
    vertices.forEach((v) => v.activePlanes.forEach((idx) => activePlaneSet.add(idx)));
    const planes = activePlaneSet.size
      ? Array.from(activePlaneSet, (idx) => allPlanes[idx])
      : allPlanes;

    const edges = [];
    const seenEdges = new Set();
    for (let i = 0; i < allPlanes.length - 1; i += 1) {
      for (let j = i + 1; j < allPlanes.length; j += 1) {
        const direction = new THREE.Vector3().crossVectors(allPlanes[i].normal, allPlanes[j].normal);
        if (direction.lengthSq() < GEOMETRY_EPS) continue;
        direction.normalize();

        const shared = [];
        for (let v = 0; v < vertices.length; v += 1) {
          const active = vertices[v].activePlanes;
          if (active.includes(i) && active.includes(j)) shared.push(v);
        }

        if (shared.length < 2) continue;

        shared.sort((a, b) => vertices[a].position.dot(direction) - vertices[b].position.dot(direction));

        for (let idx = 0; idx < shared.length - 1; idx += 1) {
          const a = shared[idx];
          const b = shared[idx + 1];
          const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (seenEdges.has(edgeKey)) continue;

          const midpoint = new THREE.Vector3().addVectors(vertices[a].position, vertices[b].position).multiplyScalar(0.5);
          if (!pointInsidePlanes(midpoint.x, midpoint.y, midpoint.z, planes, facetTolerance * 2)) continue;

          seenEdges.add(edgeKey);
          edges.push([a, b]);
        }
      }
    }

    const bounds = {
      min: new THREE.Vector3(Infinity, Infinity, Infinity),
      max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
    };
    vertices.forEach((v) => {
      bounds.min.min(v.position);
      bounds.max.max(v.position);
    });

    const samplingBounds = expandBounds(bounds, zoneScale * 0.18);

    const inverseBasisMatrix = basisToMatrix3(basis).clone();
    if (Math.abs(inverseBasisMatrix.determinant()) < GEOMETRY_EPS) {
      throw new Error("Reciprocal basis matrix is singular");
    }
    inverseBasisMatrix.invert();

    return {
      basisVectors,
      vertices: vertices.map((v) => v.position),
      edges,
      planes,
      bounds,
      samplingBounds,
      boundsTransform: buildBoundsTransform(samplingBounds),
      inverseBasisMatrix,
      facetTolerance,
    };
  }

  function buildBrillouinFrame(zone) {
    const positions = [];
    zone.edges.forEach(([a, b]) => {
      const start = zone.vertices[a];
      const end = zone.vertices[b];
      positions.push(...start.toArray(), ...end.toArray());
    });

    const frame = new THREE.Group();
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      frame.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: 0x111827,
            transparent: true,
            opacity: 0.9,
          })
        )
      );
    }

    return frame;
  }

  function buildZoneClippingPlanes(zone) {
    return zone.planes.map((plane) => new THREE.Plane(plane.normal.clone().multiplyScalar(-1), plane.offset));
  }

  function getPointCloudRadius(points) {
    let radius = 0;
    points.forEach((p) => {
      radius = Math.max(radius, p.length());
    });
    return radius;
  }

  function wrapFractional(value) {
    return value - Math.floor(value);
  }

  function sampleVolume(values, dims, x, y, z) {
    const nx = Math.max(2, dims[0] || 2);
    const ny = Math.max(2, dims[1] || 2);
    const nz = Math.max(2, dims[2] || 2);

    const px = Math.max(nx - 1, 1);
    const py = Math.max(ny - 1, 1);
    const pz = Math.max(nz - 1, 1);

    const wrap01 = (v) => {
      const w = v % 1;
      return w < 0 ? w + 1 : w;
    };

    const sx = wrap01(x) * px;
    const sy = wrap01(y) * py;
    const sz = wrap01(z) * pz;

    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const z0 = Math.floor(sz);
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const z1 = (z0 + 1) % pz;

    const tx = sx - x0;
    const ty = sy - y0;
    const tz = sz - z0;

    // BXSF BANDGRID values are written with the third grid index varying fastest:
    // for i0 -> for i1 -> for i2.  Keep this order to match FermiSurfer.
    const at = (ix, iy, iz) => values[iz + nz * (iy + ny * ix)] || 0;

    const c000 = at(x0, y0, z0);
    const c100 = at(x1, y0, z0);
    const c010 = at(x0, y1, z0);
    const c110 = at(x1, y1, z0);
    const c001 = at(x0, y0, z1);
    const c101 = at(x1, y0, z1);
    const c011 = at(x0, y1, z1);
    const c111 = at(x1, y1, z1);

    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;

    return c0 * (1 - tz) + c1 * tz;
  }

  function sampleBandEnergyAtWorld(material, band, worldPoint) {
    if (!material || !material.brillouinZone || !(band?.volume instanceof Float32Array)) return null;
    const inverse = material.brillouinZone.inverseBasisMatrix.elements;
    const wx = worldPoint.x;
    const wy = worldPoint.y;
    const wz = worldPoint.z;
    const fx = wrapFractional(inverse[0] * wx + inverse[3] * wy + inverse[6] * wz);
    const fy = wrapFractional(inverse[1] * wx + inverse[4] * wy + inverse[7] * wz);
    const fz = wrapFractional(inverse[2] * wx + inverse[5] * wy + inverse[8] * wz);
    return sampleVolume(band.volume, material.dims, fx, fy, fz);
  }

  function estimateWorldSamplingStep(material) {
    const basis = Array.isArray(material?.basis) ? material.basis : [];
    const dims = Array.isArray(material?.dims) ? material.dims : [2, 2, 2];
    const steps = basis.map((vec, idx) => {
      const x = Number(vec?.[0]) || 0;
      const y = Number(vec?.[1]) || 0;
      const z = Number(vec?.[2]) || 0;
      const length = Math.hypot(x, y, z);
      return length / Math.max(1, (Number(dims[idx]) || 2) - 1);
    }).filter((value) => Number.isFinite(value) && value > 0);
    if (!steps.length) return 1e-3;
    return Math.max(Math.min(...steps) * 0.75, 1e-3);
  }

  function smoothClosedCurve(points, rounds = 2) {
    if (!Array.isArray(points) || points.length < 5) return Array.isArray(points) ? points.slice() : [];
    let current = points.map((point) => ({ x: point.x, y: point.y }));
    for (let round = 0; round < rounds; round += 1) {
      current = current.map((point, idx) => {
        const prev = current[(idx - 1 + current.length) % current.length];
        const next = current[(idx + 1) % current.length];
        return {
          x: prev.x * 0.25 + point.x * 0.5 + next.x * 0.25,
          y: prev.y * 0.25 + point.y * 0.5 + next.y * 0.25,
        };
      });
    }
    return current;
  }

  function normalize2D(x, y) {
    const length = Math.hypot(x, y);
    if (!(length > GEOMETRY_EPS)) return null;
    return { x: x / length, y: y / length };
  }

  function buildBrillouinField(material, band, targetResolution) {
    const zone = material.brillouinZone;
    const field = new Float32Array(targetResolution ** 3);
    const denom = Math.max(targetResolution - 1, 1);

    const min = zone.samplingBounds.min;
    const max = zone.samplingBounds.max;
    const span = new THREE.Vector3().subVectors(max, min);

    const inverse = zone.inverseBasisMatrix.elements;
    let cursor = 0;

    for (let z = 0; z < targetResolution; z += 1) {
      const wz = min.z + (span.z * z) / denom;
      for (let y = 0; y < targetResolution; y += 1) {
        const wy = min.y + (span.y * y) / denom;
        for (let x = 0; x < targetResolution; x += 1) {
          const wx = min.x + (span.x * x) / denom;
          const fx = wrapFractional(inverse[0] * wx + inverse[3] * wy + inverse[6] * wz);
          const fy = wrapFractional(inverse[1] * wx + inverse[4] * wy + inverse[7] * wz);
          const fz = wrapFractional(inverse[2] * wx + inverse[5] * wy + inverse[8] * wz);
          field[cursor] = sampleVolume(band.volume, material.dims, fx, fy, fz);
          cursor += 1;
        }
      }
    }

    return {
      field,
      matrix: zone.boundsTransform,
    };
  }

  function disposeRenderable(object) {
    if (!object) return;
    object.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
        else node.material.dispose();
      }
    });
  }

  function clearSectionVisualization() {
    if (!state.currentSectionGroup) {
      state.sectionPreviewState = null;
      clearSectionCanvas();
      setSectionCanvasMessage("Enable section to show the 2D cross-section");
      return;
    }

    disposeRenderable(state.currentSectionGroup);
    state.contentGroup.remove(state.currentSectionGroup);
    state.currentSectionGroup = null;
    state.sectionPreviewState = null;
    clearSectionCanvas();
    setSectionCanvasMessage("Enable section to show the 2D cross-section");
  }

  function disposeCurrentObjects() {
    clearSdhVisualization();
    clearSectionVisualization();

    state.currentSurfaces.forEach((surface) => {
      state.contentGroup.remove(surface);
      disposeRenderable(surface);
    });
    state.currentSurfaces = [];

    if (state.currentFrame) {
      state.contentGroup.remove(state.currentFrame);
      disposeRenderable(state.currentFrame);
      state.currentFrame = null;
    }
  }

  function buildPlaneInfoForNormal(zone, normal, offsetFactor) {
    let projectionMin = Infinity;
    let projectionMax = -Infinity;

    zone.vertices.forEach((vertex) => {
      const projection = normal.dot(vertex);
      projectionMin = Math.min(projectionMin, projection);
      projectionMax = Math.max(projectionMax, projection);
    });

    const center = 0.5 * (projectionMin + projectionMax);
    const halfSpan = Math.max(0.5 * (projectionMax - projectionMin), GEOMETRY_EPS * 16);
    const offset = center + offsetFactor * halfSpan;

    return {
      plane: new THREE.Plane(normal.clone(), -offset),
      normal,
      offset,
      projectionMin,
      projectionMax,
      halfSpan,
    };
  }

  function getSectionWorldNormal(zone, coefficients = state.sectionState.normalCoefficients) {
    const normal = new THREE.Vector3();
    for (let i = 0; i < 3; i += 1) {
      normal.addScaledVector(zone.basisVectors[i], coefficients[i]);
    }

    if (normal.lengthSq() < GEOMETRY_EPS) {
      return zone.basisVectors[2].clone().normalize();
    }

    return normal.normalize();
  }

  function getSectionPlaneInfo(zone) {
    const normal = getSectionWorldNormal(zone);
    return buildPlaneInfoForNormal(zone, normal, state.sectionState.offsetFactor);
  }

  function updateSectionReadout(material = state.material) {
    const el = document.getElementById("fermiSectionReadout");
    if (!el) return;

    if (!material || !material.brillouinZone) {
      el.textContent = "Central plane";
      return;
    }

    const zone = material.brillouinZone;
    const { normal, offset, projectionMin, projectionMax } = getSectionPlaneInfo(zone);
    const coeffs = state.sectionState.normalCoefficients.map((v) => v.toFixed(1)).join(", ");
    const span = Math.max(projectionMax - projectionMin, GEOMETRY_EPS);
    const percentage = ((offset - projectionMin) / span) * 100;

    el.textContent = `n = (${coeffs}) | ${percentage.toFixed(1)}% | d = ${offset.toFixed(3)}`;
    el.dataset.normal = `${normal.x.toFixed(3)}, ${normal.y.toFixed(3)}, ${normal.z.toFixed(3)}`;
  }

  function collectZoneSectionPolygon(zone, planeInfo, origin, basis) {
    const points = [];
    const toleranceSq = (SECTION_EPS * 8) ** 2;

    zone.edges.forEach(([startIdx, endIdx]) => {
      const start = zone.vertices[startIdx];
      const end = zone.vertices[endIdx];
      const d0 = planeInfo.plane.distanceToPoint(start);
      const d1 = planeInfo.plane.distanceToPoint(end);
      const startOn = Math.abs(d0) <= SECTION_EPS;
      const endOn = Math.abs(d1) <= SECTION_EPS;

      if (startOn) {
        if (!points.some((p) => p.distanceToSquared(start) <= toleranceSq)) points.push(start.clone());
      }
      if (endOn) {
        if (!points.some((p) => p.distanceToSquared(end) <= toleranceSq)) points.push(end.clone());
      }
      if (startOn || endOn || d0 * d1 > 0) return;

      const t = d0 / (d0 - d1);
      const intersection = start.clone().lerp(end, t);
      if (!points.some((p) => p.distanceToSquared(intersection) <= toleranceSq)) points.push(intersection);
    });

    if (points.length < 3) return [];

    const centroid = new THREE.Vector3();
    points.forEach((p) => centroid.add(p));
    centroid.multiplyScalar(1 / points.length);
    const centroidProjected = projectPointToSection(centroid, origin, basis);

    return points
      .map((point) => projectPointToSection(point, origin, basis))
      .sort((a, b) => {
        const aa = Math.atan2(a.y - centroidProjected.y, a.x - centroidProjected.x);
        const bb = Math.atan2(b.y - centroidProjected.y, b.x - centroidProjected.x);
        return aa - bb;
      });
  }

  function expandSectionBounds(bounds, point) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }

  function pushSectionPoint(points, point, tolerance = SECTION_EPS) {
    const toleranceSq = tolerance ** 2;
    if (points.some((candidate) => candidate.distanceToSquared(point) <= toleranceSq)) return;
    points.push(point);
  }

  function collectEdgePlaneIntersection(start, end, distanceStart, distanceEnd, points) {
    const startOnPlane = Math.abs(distanceStart) <= SECTION_EPS;
    const endOnPlane = Math.abs(distanceEnd) <= SECTION_EPS;

    if (startOnPlane && endOnPlane) return;
    if (startOnPlane) {
      pushSectionPoint(points, start.clone());
      return;
    }
    if (endOnPlane) {
      pushSectionPoint(points, end.clone());
      return;
    }
    if (distanceStart * distanceEnd > 0) return;

    const t = distanceStart / (distanceStart - distanceEnd);
    pushSectionPoint(points, start.clone().lerp(end, t));
  }

  function intersectTriangleWithPlane(a, b, c, plane) {
    const da = plane.distanceToPoint(a);
    const db = plane.distanceToPoint(b);
    const dc = plane.distanceToPoint(c);
    const points = [];

    collectEdgePlaneIntersection(a, b, da, db, points);
    collectEdgePlaneIntersection(b, c, db, dc, points);
    collectEdgePlaneIntersection(c, a, dc, da, points);

    if (points.length < 2) return null;
    if (points.length === 2) return points;

    let bestPair = [points[0], points[1]];
    let bestDistance = bestPair[0].distanceToSquared(bestPair[1]);

    for (let i = 0; i < points.length - 1; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const d = points[i].distanceToSquared(points[j]);
        if (d > bestDistance) {
          bestDistance = d;
          bestPair = [points[i], points[j]];
        }
      }
    }

    return bestPair;
  }

  function appendMeshSectionSegments(mesh, plane, positions) {
    const geometry = mesh.geometry;
    const positionAttribute = geometry && geometry.getAttribute("position");
    if (!positionAttribute) return;

    mesh.updateMatrixWorld(true);

    const indexAttribute = geometry.getIndex();
    const hasFiniteDrawRange = geometry.drawRange
      && Number.isFinite(geometry.drawRange.count)
      && geometry.drawRange.count > 0;
    const drawStart = hasFiniteDrawRange ? Math.max(0, geometry.drawRange.start || 0) : 0;
    const drawCount = hasFiniteDrawRange
      ? geometry.drawRange.count
      : indexAttribute
        ? indexAttribute.count
        : positionAttribute.count;
    const drawEnd = drawStart + drawCount;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (let triangle = drawStart; triangle + 2 < drawEnd; triangle += 3) {
      const ia = indexAttribute ? indexAttribute.getX(triangle) : triangle;
      const ib = indexAttribute ? indexAttribute.getX(triangle + 1) : triangle + 1;
      const ic = indexAttribute ? indexAttribute.getX(triangle + 2) : triangle + 2;

      a.fromBufferAttribute(positionAttribute, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positionAttribute, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positionAttribute, ic).applyMatrix4(mesh.matrixWorld);

      const segment = intersectTriangleWithPlane(a, b, c, plane);
      if (!segment) continue;
      positions.push(...segment[0].toArray(), ...segment[1].toArray());
    }
  }

  function buildSectionPlaneMesh(zone, planeInfo) {
    const clippingPlanes = buildZoneClippingPlanes(zone);
    const radius = Math.max(getPointCloudRadius(zone.vertices), 1) * 2.6;
    const planeMesh = new THREE.Mesh(
      new THREE.PlaneBufferGeometry(radius, radius),
      new THREE.MeshBasicMaterial({
        color: 0x0b3f66,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
        clippingPlanes,
      })
    );
    planeMesh.position.copy(planeInfo.normal.clone().multiplyScalar(planeInfo.offset));
    planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), planeInfo.normal);
    planeMesh.renderOrder = 1;
    return planeMesh;
  }

  function drawSectionPreview() {
    const canvas = document.getElementById("fermiSectionCanvas");
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.restore();

    if (!state.sectionPreviewState || !state.sectionPreviewState.polygon || !state.sectionPreviewState.polygon.length) {
      setSectionCanvasMessage(
        state.sectionState.enabled
          ? "The current plane does not intersect any visible bands"
          : "Enable section to show the 2D cross-section"
      );
      return;
    }

    setSectionCanvasMessage("");

    const padding = 18;
    const usableWidth = Math.max(width - padding * 2, 1);
    const usableHeight = Math.max(height - padding * 2, 1);
    const { minX, maxX, minY, maxY } = state.sectionPreviewState.bounds;
    const spanX = Math.max(maxX - minX, SECTION_EPS);
    const spanY = Math.max(maxY - minY, SECTION_EPS);
    const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;

    const project = (point) => ({
      x: width * 0.5 + (point.x - centerX) * scale,
      y: height * 0.5 - (point.y - centerY) * scale,
    });

    const polygonPoints = state.sectionPreviewState.polygon.map(project);

    context.save();
    context.beginPath();
    polygonPoints.forEach((p, idx) => {
      if (idx === 0) context.moveTo(p.x, p.y);
      else context.lineTo(p.x, p.y);
    });
    if (polygonPoints.length) {
      const first = polygonPoints[0];
      context.lineTo(first.x, first.y);
    }
    context.clip();

    state.sectionPreviewState.bands.forEach((band) => {
      context.save();
      context.strokeStyle = band.color;
      context.lineWidth = 1.8;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      band.segments.forEach((segment) => {
        const start = project(segment.start);
        const end = project(segment.end);
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
      });
      context.stroke();
      context.restore();
    });
    context.restore();

    context.save();
    context.strokeStyle = "rgba(15,23,42,0.92)";
    context.lineWidth = 2.2;
    context.lineJoin = "round";
    context.beginPath();
    polygonPoints.forEach((p, idx) => {
      if (idx === 0) context.moveTo(p.x, p.y);
      else context.lineTo(p.x, p.y);
    });
    if (polygonPoints.length) {
      const first = polygonPoints[0];
      context.lineTo(first.x, first.y);
    }
    context.stroke();
    context.restore();
  }

  function computeRealOrbitFromLoop(loop, material, band, basis) {
    if (!loop || !Array.isArray(loop.worldPoints) || loop.worldPoints.length < 3 || !band || !basis) return null;

    const step = estimateWorldSamplingStep(material);
    const projectedLoop = Array.isArray(loop.projectedPoints) ? loop.projectedPoints : [];
    const signedArea = projectedLoop.length >= 3 ? computeSignedLoopArea(projectedLoop) : 0;
    const handedness = signedArea >= 0 ? 1 : -1;
    const velocityPoints = [];
    loop.worldPoints.forEach((worldPoint, idx) => {
      const plusU = worldPoint.clone().addScaledVector(basis.u, step);
      const minusU = worldPoint.clone().addScaledVector(basis.u, -step);
      const plusV = worldPoint.clone().addScaledVector(basis.v, step);
      const minusV = worldPoint.clone().addScaledVector(basis.v, -step);

      const ePlusU = sampleBandEnergyAtWorld(material, band, plusU);
      const eMinusU = sampleBandEnergyAtWorld(material, band, minusU);
      const ePlusV = sampleBandEnergyAtWorld(material, band, plusV);
      const eMinusV = sampleBandEnergyAtWorld(material, band, minusV);
      if ([ePlusU, eMinusU, ePlusV, eMinusV].some((value) => !Number.isFinite(value))) return;

      const gradU = (ePlusU - eMinusU) / (2 * step);
      const gradV = (ePlusV - eMinusV) / (2 * step);
      const speed = Math.hypot(gradU, gradV);

      const prev = projectedLoop[(idx - 1 + projectedLoop.length) % projectedLoop.length];
      const next = projectedLoop[(idx + 1) % projectedLoop.length];
      if (!prev || !next) return;
      const tangent = normalize2D(next.x - prev.x, next.y - prev.y);
      if (!tangent) return;

      // With B along the section normal, dk/dt is tangent to the contour and
      // v is the tangent rotated by -90 degrees. Use the BXSF gradient only
      // for the speed magnitude; use the contour tangent for the direction.
      velocityPoints.push({
        x: handedness * speed * tangent.y,
        y: handedness * speed * (-tangent.x),
      });
    });

    if (velocityPoints.length < 3) return null;
    const smoothed = smoothClosedCurve(velocityPoints, 3);
    const center = computeLoopCentroid(smoothed);
    const projectedPoints = smoothed.map((point) => ({
      x: point.x - center.x,
      y: point.y - center.y,
    }));

    const area = computeLoopArea(projectedPoints);
    if (!(area > GEOMETRY_EPS)) return null;
    return { projectedPoints, area };
  }

  function updateSectionVisualization() {
    clearSectionVisualization();

    if (!state.sectionState.enabled || !state.material || !state.material.brillouinZone) {
      return;
    }

    const zone = state.material.brillouinZone;
    const planeInfo = getSectionPlaneInfo(zone);
    const planeOrigin = planeInfo.normal.clone().multiplyScalar(planeInfo.offset);
    const planeBasis = buildSectionPlaneBasis(planeInfo.normal);
    const zonePolygon = collectZoneSectionPolygon(zone, planeInfo, planeOrigin, planeBasis);
    const spanScale = Math.max(planeInfo.projectionMax - planeInfo.projectionMin, 1e-3);
    const loopTolerance = Math.max(spanScale * 0.002, 1e-4);

    const sectionGroup = new THREE.Group();
    sectionGroup.add(buildSectionPlaneMesh(zone, planeInfo));

    const selectedBands = getSelectedBands(state.material);
    const previewBands = [];
    const previewBounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };

    zonePolygon.forEach((p) => expandSectionBounds(previewBounds, p));

    state.currentSurfaces.forEach((surface, idx) => {
      const positions = [];
      appendMeshSectionSegments(surface, planeInfo.plane, positions);
      if (!positions.length) return;

      const band = selectedBands[idx];
      const projectedSegments = collectProjectedSectionSegments(positions, planeOrigin, planeBasis);
      const rawLoops = buildClosedLoopsFromPositions(positions, planeOrigin, planeBasis, loopTolerance);
      const filteredLoops = zonePolygon.length ? rawLoops.filter((loop) => doesLoopOverlapPolygon(loop, zonePolygon)) : [];
      projectedSegments.forEach((segment) => {
        expandSectionBounds(previewBounds, segment.start);
        expandSectionBounds(previewBounds, segment.end);
      });

      previewBands.push({
        bandIndex: band.index,
        color: `rgb(${getBandColor(band.index).map((v) => Math.round(v * 255)).join(" ")})`,
        segments: projectedSegments,
        loops: filteredLoops,
      });
    });

    state.currentSectionGroup = sectionGroup;
    state.contentGroup.add(state.currentSectionGroup);

    state.sectionPreviewState = zonePolygon.length
      ? {
          polygon: zonePolygon,
          bands: previewBands,
          bounds: previewBounds,
          planeNormal: planeInfo.normal.clone(),
          planeBasis,
        }
      : null;

    drawSectionPreview();
  }

  function clearSdhVisualization() {
    if (!state.currentSdhGroup) {
      state.currentSdhMeshes = [];
      hideSdhHover();
      return;
    }
    if (state.contentGroup) state.contentGroup.remove(state.currentSdhGroup);
    disposeRenderable(state.currentSdhGroup);
    state.currentSdhGroup = null;
    state.currentSdhMeshes = [];
    hideSdhHover();
  }

  function invalidateSdh(message = "Parameters updated. Please recompute SdH.") {
    clearSdhVisualization();
    clearSdhResults();
    state.sdhResultByKey = new Map();
    state.sdhResultEls = new Map();
    setSdhStatus(message);
  }

  function renderSdhResults(results) {
    const root = document.getElementById("fermiSdhResults");
    if (!root) return;
    clearSdhResults();
    state.sdhResultByKey = new Map();
    state.sdhResultEls = new Map();

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "fermi-sdh-result";
      empty.textContent = "No reliable closed extremal orbit was found for this direction.";
      root.appendChild(empty);
      return;
    }

    results.forEach((result) => {
      const key = sdhResultKey(result);
      state.sdhResultByKey.set(key, result);
      const item = document.createElement("div");
      item.className = "fermi-sdh-result";
      item.dataset.sdhKey = key;

      const title = document.createElement("div");
      title.className = "fermi-sdh-result-title";

      const dot = document.createElement("span");
      dot.className = "fermi-sdh-result-dot";
      dot.style.background = formatLegendColor(result.bandIndex);

      const label = document.createElement("span");
      label.textContent = `Band ${result.bandIndex} | ${result.kind === "max" ? "Maximum orbit" : "Minimum orbit"}`;

      const meta = document.createElement("div");
      meta.className = "fermi-sdh-result-meta";
      meta.textContent = formatSdhMeta(result);

      title.append(dot, label);
      item.append(title, meta);
      root.appendChild(item);
      state.sdhResultEls.set(key, item);
    });
  }

  function renderSdhExtremalOrbits(results, zone) {
    clearSdhVisualization();
    if (!results.length) return;

    const orbitGroup = new THREE.Group();
    const radius = Math.max(getPointCloudRadius(zone.vertices), 1) * 0.008;
    const meshes = [];

    results.forEach((result) => {
      const key = sdhResultKey(result);
      const orbitColor = getBandColorLinear(result.bandIndex).offsetHSL(0, 0, result.kind === "max" ? 0.08 : -0.06);
      const orbit = buildOrbitHighlight(result.worldPoints, orbitColor, radius);
      orbit.userData.sdhKey = key;
      orbitGroup.add(orbit);
      meshes.push(orbit);
    });

    state.currentSdhGroup = orbitGroup;
    state.currentSdhMeshes = meshes;
    state.contentGroup.add(orbitGroup);
  }

  function buildSdhSlices(surface, zone, normal) {
    const planeBasis = buildSectionPlaneBasis(normal);
    const baseInfo = buildPlaneInfoForNormal(zone, normal, 0);
    const spanScale = Math.max(baseInfo.projectionMax - baseInfo.projectionMin, 1e-3);
    const loopTolerance = Math.max(spanScale * 0.002, 1e-4);
    const centerTolerance = Math.max(spanScale * 0.12, 5e-3);
    const slices = [];

    for (let sliceIndex = 0; sliceIndex < SDH_SCAN_SLICES; sliceIndex += 1) {
      const factor = -1 + (2 * sliceIndex) / Math.max(SDH_SCAN_SLICES - 1, 1);
      const planeInfo = buildPlaneInfoForNormal(zone, normal, factor);
      const planeOrigin = planeInfo.normal.clone().multiplyScalar(planeInfo.offset);
      const zonePolygon = collectZoneSectionPolygon(zone, planeInfo, planeOrigin, planeBasis);
      const positions = [];
      appendMeshSectionSegments(surface, planeInfo.plane, positions);
      const rawLoops = buildClosedLoopsFromPositions(positions, planeOrigin, planeBasis, loopTolerance);

      slices.push({
        sliceIndex,
        loops: zonePolygon.length ? rawLoops.filter((loop) => doesLoopOverlapPolygon(loop, zonePolygon)) : [],
      });
    }

    return { slices, centerTolerance };
  }

  function computeSdhExtremalOrbitsFromSlices(slices, band, centerTolerance) {
    const results = [];
    for (let sliceIndex = 1; sliceIndex < slices.length - 1; sliceIndex += 1) {
      const currentSlice = slices[sliceIndex];
      const previousSlice = slices[sliceIndex - 1];
      const nextSlice = slices[sliceIndex + 1];

      for (const loop of currentSlice.loops) {
        const previousMatch = findMatchingLoop(loop, previousSlice.loops, centerTolerance);
        const nextMatch = findMatchingLoop(loop, nextSlice.loops, centerTolerance);
        if (!previousMatch || !nextMatch) continue;

        const isMax = loop.area >= previousMatch.area
          && loop.area >= nextMatch.area
          && (loop.area > previousMatch.area || loop.area > nextMatch.area);
        const isMin = loop.area <= previousMatch.area
          && loop.area <= nextMatch.area
          && (loop.area < previousMatch.area || loop.area < nextMatch.area);
        if (!isMax && !isMin) continue;

        results.push({
          bandIndex: band.index,
          kind: isMax ? "max" : "min",
          area: loop.area,
          frequency: loop.area * ONSAGER_AREA_TO_KT,
          curvature: previousMatch.area + nextMatch.area - 2 * loop.area,
          centroid: loop.centroid,
          worldPoints: loop.worldPoints,
          sliceIndex,
        });
      }
    }

    return dedupeExtremalOrbits(results, centerTolerance);
  }

  function computeSdhExtremalOrbits(surface, band, zone, normal) {
    const { slices, centerTolerance } = buildSdhSlices(surface, zone, normal);
    return computeSdhExtremalOrbitsFromSlices(slices, band, centerTolerance);
  }

  function pickTrackedExtremalOrbit(results, kind = "max") {
    const filtered = Array.isArray(results) ? results.filter((result) => result.kind === kind) : [];
    if (!filtered.length) return null;
    return filtered.reduce((best, current) => {
      if (!best) return current;
      if (kind === "min") return current.area < best.area ? current : best;
      return current.area > best.area ? current : best;
    }, null);
  }

  function pickClosedOrbitFallback(slices, bandIndex, kind = "max") {
    const loops = [];
    (Array.isArray(slices) ? slices : []).forEach((slice) => {
      (Array.isArray(slice.loops) ? slice.loops : []).forEach((loop) => {
        loops.push({
          bandIndex,
          kind,
          area: loop.area,
          frequency: loop.area * ONSAGER_AREA_TO_KT,
          curvature: null,
          centroid: loop.centroid,
          worldPoints: loop.worldPoints,
          sliceIndex: slice.sliceIndex,
          source: "fallback",
        });
      });
    });
    if (!loops.length) return null;
    return loops.reduce((best, current) => {
      if (!best) return current;
      if (kind === "min") return current.area < best.area ? current : best;
      return current.area > best.area ? current : best;
    }, null);
  }

  function pickTrackedOrbitForDirection(surface, band, zone, normal, kind = "max") {
    const { slices, centerTolerance } = buildSdhSlices(surface, zone, normal);
    const closedLoopCount = slices.reduce((sum, slice) => sum + ((slice && Array.isArray(slice.loops)) ? slice.loops.length : 0), 0);
    const sliceWithLoops = slices.reduce((sum, slice) => sum + ((((slice && Array.isArray(slice.loops)) ? slice.loops.length : 0) > 0) ? 1 : 0), 0);
    const strictResults = computeSdhExtremalOrbitsFromSlices(slices, band, centerTolerance)
      .map((result) => ({ ...result, source: "extremal" }));
    const strictPick = pickTrackedExtremalOrbit(strictResults, kind);
    if (strictPick) {
      return { picked: strictPick, source: "extremal", strictCount: strictResults.length, closedLoopCount, sliceWithLoops };
    }
    const fallbackPick = pickClosedOrbitFallback(slices, band.index, kind);
    if (fallbackPick) {
      return { picked: fallbackPick, source: "fallback", strictCount: strictResults.length, closedLoopCount, sliceWithLoops };
    }
    return { picked: null, source: null, strictCount: strictResults.length, closedLoopCount, sliceWithLoops };
  }

  async function ensureMaterialReadyForAnalysis() {
    const wantedDataset = currentDataset();
    if (!state.material || state.material.dataset !== wantedDataset || !state.currentSurfaces.length) {
      await loadSelectedDataset();
    } else {
      await renderSelection();
    }

    if (!state.material || !state.currentSurfaces.length) {
      throw new Error("Load the Fermi surface first.");
    }
    return state.material;
  }

  async function analyzeExtremalOrbitSweep({ surface, anglesDeg, kind = "max" } = {}) {
    if (!surface || !Array.isArray(anglesDeg) || !anglesDeg.length) {
      throw new Error("Missing surface or angles for extremal-orbit sweep.");
    }
    const material = await ensureMaterialReadyForAnalysis();
    if (!material.brillouinZone) {
      material.brillouinZone = buildFirstBrillouinZone(material.basis);
    }

    const zone = material.brillouinZone;
    const selectedBands = getSelectedBands(material);
    const crossingBands = Array.isArray(material.allBands) ? material.allBands.filter((band) => band.hasFermi) : [];
    const surfaces = Array.isArray(state.currentSurfaces) ? state.currentSurfaces : [];
    if (!selectedBands.length || !surfaces.length) {
      throw new Error("No rendered Fermi-surface bands are available.");
    }

    const samples = [];
    let fallbackCount = 0;
    let strictCount = 0;
    const closedLoopsPerAngle = [];
    const slicesWithLoopsPerAngle = [];
    for (let idx = 0; idx < anglesDeg.length; idx += 1) {
      const angle = Number(anglesDeg[idx]);
      if (!Number.isFinite(angle)) continue;
      const spherical = surfaceAngleToSpherical(surface, angle);
      if (!spherical) continue;
      const normal = sphericalDegToWorldNormal(spherical.theta, spherical.phi);

      let bestPick = null;
      let angleClosedLoopCount = 0;
      let angleSliceWithLoops = 0;
      surfaces.forEach((surfaceMesh, surfaceIdx) => {
        const fallbackBand = selectedBands[surfaceIdx];
        const bandIndex = Number(surfaceMesh?.userData?.bandIndex);
        const band = selectedBands.find((item) => item.index === bandIndex) || fallbackBand;
        if (!band) return;
        const candidate = pickTrackedOrbitForDirection(surfaceMesh, band, zone, normal, kind);
        angleClosedLoopCount += Number(candidate.closedLoopCount) || 0;
        angleSliceWithLoops += Number(candidate.sliceWithLoops) || 0;
        if (!candidate.picked) return;
        const pickedArea = Number(candidate.picked.area) || 0;
        const bestArea = Number(bestPick?.picked?.area) || 0;
        if (!bestPick) {
          bestPick = candidate;
          return;
        }
        if (kind === "min") {
          if (pickedArea < bestArea) bestPick = candidate;
        } else if (pickedArea > bestArea) {
          bestPick = candidate;
        }
      });
      closedLoopsPerAngle.push(angleClosedLoopCount);
      slicesWithLoopsPerAngle.push(angleSliceWithLoops);

      const picked = bestPick && bestPick.picked;
      if (picked) {
        if (bestPick.source === "fallback") fallbackCount += 1;
        else strictCount += 1;
        samples.push({
          angle,
          area: picked.area,
          frequency: picked.frequency,
          bandIndex: picked.bandIndex,
          sliceIndex: picked.sliceIndex,
          source: bestPick.source || picked.source || "extremal",
          closedLoopCount: angleClosedLoopCount,
          sliceWithLoops: angleSliceWithLoops,
        });
      }

      if (idx < anglesDeg.length - 1 && idx % 3 === 2) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    return {
      surface,
      kind,
      dataset: material.dataset,
      datasetLabel: datasetLabel(material.dataset),
      isoEnergy: state.currentIsoEnergy,
      bandIndices: selectedBands.map((band) => band.index),
      crossingBandCount: crossingBands.length,
      totalBandCount: Array.isArray(material.allBands) ? material.allBands.length : selectedBands.length,
      selectedBandRanges: selectedBands.map((band) => ({
        index: band.index,
        hasFermi: !!band.hasFermi,
        deltaMinEf: Number(band.min) - Number(material.fermiEnergy || 0),
        deltaMaxEf: Number(band.max) - Number(material.fermiEnergy || 0),
      })),
      totalAngles: anglesDeg.length,
      validAngles: samples.length,
      strictAngles: strictCount,
      fallbackAngles: fallbackCount,
      closedLoopsMeanPerAngle: closedLoopsPerAngle.length
        ? closedLoopsPerAngle.reduce((sum, value) => sum + value, 0) / closedLoopsPerAngle.length
        : 0,
      closedLoopsMaxPerAngle: closedLoopsPerAngle.length ? Math.max(...closedLoopsPerAngle) : 0,
      slicesWithLoopsMeanPerAngle: slicesWithLoopsPerAngle.length
        ? slicesWithLoopsPerAngle.reduce((sum, value) => sum + value, 0) / slicesWithLoopsPerAngle.length
        : 0,
      slicesWithLoopsMaxPerAngle: slicesWithLoopsPerAngle.length ? Math.max(...slicesWithLoopsPerAngle) : 0,
      angles: samples.map((sample) => sample.angle),
      areas: samples.map((sample) => sample.area),
      frequencies: samples.map((sample) => sample.frequency),
      tracedBandIndices: samples.map((sample) => sample.bandIndex),
      samples,
    };
  }

  async function computeSdhAnalysis() {
    if (!state.material || !state.material.brillouinZone) return;

    const selectedBands = getSelectedBands(state.material);
    if (!selectedBands.length || !state.currentSurfaces.length) {
      invalidateSdh("No bands are currently available for SdH analysis.");
      return;
    }

    syncSdhStateFromUi();

    const zone = state.material.brillouinZone;
    const normal = getSectionWorldNormal(zone, state.sdhState.normalCoefficients);
    const directionLabel = state.sdhState.normalCoefficients.map((value) => value.toFixed(1)).join(", ");

    setLoading(true, "Scanning SdH extremal orbits...");
    setSdhStatus(`Scanning SdH extremal orbits: B // (${directionLabel})`);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      let results = [];
      state.currentSurfaces.forEach((surface, idx) => {
        const band = selectedBands[idx];
        if (!band) return;
        results.push(...computeSdhExtremalOrbits(surface, band, zone, normal));
      });
      results = results.sort((left, right) => right.frequency - left.frequency);

      renderSdhExtremalOrbits(results, zone);
      renderSdhResults(results);
      setSdhStatus(
        results.length
          ? `Found ${results.length} SdH extremal orbit(s) | B // (${directionLabel})`
          : `No reliable SdH extremal orbit found | B // (${directionLabel})`
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSdhPointerMove(event) {
    if (!state.raycaster || !state.pointerNdc || !state.camera || !state.currentSdhMeshes.length) {
      hideSdhHover();
      return;
    }
    const canvas = state.renderer && state.renderer.domElement;
    if (!canvas) {
      hideSdhHover();
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const y = -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    if (x < -1 || x > 1 || y < -1 || y > 1) {
      hideSdhHover();
      return;
    }

    state.pointerNdc.set(x, y);
    state.raycaster.setFromCamera(state.pointerNdc, state.camera);

    const hits = state.raycaster.intersectObjects(state.currentSdhMeshes, true);
    const hit = hits.find((item) => item.object && item.object.userData && item.object.userData.sdhKey);
    if (!hit) {
      hideSdhHover();
      return;
    }

    const key = hit.object.userData.sdhKey;
    const result = state.sdhResultByKey.get(key);
    if (!result) {
      hideSdhHover();
      return;
    }

    state.sdhHoverKey = key;
    setSdhRowActive(key);
    showSdhHover(result, event.clientX, event.clientY);
  }

  function scheduleSectionUpdate({ preserveOffset = true } = {}) {
    syncSectionStateFromUi({ preserveOffset });
    updateSectionReadout();
    if (!preserveOffset) {
      invalidateSdh("Section direction updated. Please recompute SdH.");
    }

    const token = ++state.sectionUpdateToken;
    requestAnimationFrame(() => {
      if (token !== state.sectionUpdateToken) return;
      updateSectionVisualization();
    });
  }

  function updateStats(material, selectedBands, targetResolution) {
    const e = document.getElementById("fermiStatEnergy");
    const b = document.getElementById("fermiStatBands");
    const g = document.getElementById("fermiStatGrid");
    const r = document.getElementById("fermiStatRender");
    const title = document.getElementById("fermiViewerTitle");

    if (e) e.textContent = formatEnergy(state.currentIsoEnergy);
    if (b) b.textContent = String(selectedBands.length);
    if (g) g.textContent = `${material.dims[0]} x ${material.dims[1]} x ${material.dims[2]}`;
    if (r) r.textContent = `${targetResolution} x ${targetResolution} x ${targetResolution}`;

    if (title) {
      const displayId = displayMaterialId(material.id);
      if (!selectedBands.length) {
        title.textContent = `${displayId} / No Bands`;
      } else if (selectedBands.length === 1) {
        title.textContent = `${displayId} / Band ${selectedBands[0].index}`;
      } else {
        title.textContent = `${displayId} / ${selectedBands.length} Bands`;
      }
    }
  }

  async function ensureBandVolume(material, band) {
    if (band.volume instanceof Float32Array && band.volume.length) return;

    const key = `${material.dataset}:${material.id}:${band.index}`;
    if (state.bandCache.has(key)) {
      band.volume = state.bandCache.get(key);
      return;
    }

    const payload = await apiGet(apiPath(material.id, material.dataset, `/band/${band.index}`));
    const values = Array.isArray(payload.values) ? payload.values : [];
    const volume = Float32Array.from(values);
    band.volume = volume;
    state.bandCache.set(key, volume);

    if (Array.isArray(payload.dims) && payload.dims.length === 3) {
      const dims = payload.dims.map((v) => Math.max(2, Number(v) || 2));
      material.dims = dims;
    }
  }

  function requestRender(delay = 0) {
    if (state.renderTimer) {
      window.clearTimeout(state.renderTimer);
      state.renderTimer = null;
    }
    state.renderTimer = window.setTimeout(() => {
      renderSelection().catch((error) => {
        setInfo(`Fermi surface unavailable: ${error && error.message ? error.message : error}`);
        setLoading(false);
      });
    }, Math.max(0, delay));
  }

  async function renderSelection() {
    const material = state.material;
    if (!material) return;

    const qualityEl = document.getElementById("fermiQuality");
    const targetResolution = qualityEl ? Number(qualityEl.value) : 56;
    const validResolution = Number.isFinite(targetResolution) ? targetResolution : 56;

    const selectedBands = getSelectedBands(material);
    const token = ++state.renderToken;

    setLoading(true, `Extracting first-BZ iso-surface @ ${validResolution}^3...`);
    setInfo(
      selectedBands.length
        ? `Rebuilding ${selectedBands.length} first-Brillouin-zone Fermi surface(s) (${datasetLabel(material.dataset)}, E=${formatEnergy(state.currentIsoEnergy)})...`
        : `Updating first-Brillouin-zone frame (${datasetLabel(material.dataset)}, E=${formatEnergy(state.currentIsoEnergy)})...`
    );

    disposeCurrentObjects();

    if (!material.brillouinZone) {
      material.brillouinZone = buildFirstBrillouinZone(material.basis);
    }

    const zone = material.brillouinZone;
    const clippingPlanes = buildZoneClippingPlanes(zone);
    const pendingMeshes = [];

    const discardPendingMeshes = () => {
      pendingMeshes.forEach((mesh) => disposeRenderable(mesh));
      pendingMeshes.length = 0;
    };

    for (const band of selectedBands) {
      await ensureBandVolume(material, band);
      if (token !== state.renderToken) {
        discardPendingMeshes();
        return;
      }

      const { field, matrix } = buildBrillouinField(material, band, validResolution);

      const mc = new THREE.MarchingCubes(validResolution, new THREE.MeshBasicMaterial(), false, false);
      mc.isolation = state.currentIsoEnergy;
      mc.field.set(field);
      const geometry = mc.generateBufferGeometry();
      mc.material.dispose();

      const pos = geometry.getAttribute("position");
      if (!pos || pos.count <= 0) {
        geometry.dispose();
        continue;
      }

      geometry.applyMatrix4(matrix);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();

      const color = getBandColorLinear(band.index);
      const surfaceColor = color.clone();
      surfaceColor.offsetHSL(0, 0.16, 0.12);
      const surfaceMaterial = new THREE.MeshPhongMaterial({
        color: surfaceColor,
        shininess: 86,
        specular: new THREE.Color(0xffffff),
        emissive: surfaceColor.clone().multiplyScalar(0.26),
        side: THREE.DoubleSide,
        transparent: false,
        clippingPlanes,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });

      const mesh = new THREE.Mesh(geometry, surfaceMaterial);
      mesh.frustumCulled = false;
      mesh.userData.bandIndex = band.index;

      // Thin feature lines make small Fermi pockets visible on the white canvas
      // without changing the extracted iso-surface geometry.
      const bboxSize = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length()
        : 0;
      const zoneRadius = Math.max(getPointCloudRadius(zone.vertices), 1);
      const isTinyPocket = bboxSize > 0 && bboxSize < zoneRadius * 0.28;
      const edgeGeometry = new THREE.EdgesGeometry(geometry, isTinyPocket ? 10 : 28);
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: 0x102033,
        transparent: true,
        opacity: isTinyPocket ? 0.72 : 0.42,
        depthWrite: false,
        clippingPlanes,
      });
      const edgeMesh = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeMesh.frustumCulled = false;
      mesh.add(edgeMesh);

      pendingMeshes.push(mesh);
    }

    if (token !== state.renderToken) {
      discardPendingMeshes();
      return;
    }

    for (const mesh of pendingMeshes) {
      state.currentSurfaces.push(mesh);
      state.contentGroup.add(mesh);
    }

    state.currentFrame = buildBrillouinFrame(zone);
    state.contentGroup.add(state.currentFrame);

    const radius = Math.max(getPointCloudRadius(zone.vertices), 1);
    state.orthoViewRadius = Math.max(radius * 1.45, 1.5);
    state.controls.target.set(0, 0, 0);
    state.controls.minDistance = Math.max(radius * 0.7, 1.2);
    state.controls.maxDistance = Math.max(radius * 5.0, 8);
    state.controls.minZoom = 0.08;
    state.controls.maxZoom = 200;
    state.camera.near = Math.max(radius / 150, 0.01);
    state.camera.far = Math.max(radius * 18, 36);
    state.camera.position.set(radius * 1.9, radius * 1.4, radius * 1.9);
    updateOrthographicCameraFrustum();
    state.controls.update();

    updateSectionReadout(material);
    updateSectionVisualization();
    updateLegend(selectedBands);
    updateBandPickerLabel();
    updateStats(material, selectedBands, validResolution);
    await updateCarrierPanel(material);
    invalidateSdh("Fermi surface updated. Please recompute SdH.");

    setLoading(false);
    setInfo(
      selectedBands.length
        ? `Rendered ${selectedBands.length} band(s) in first Brillouin zone (${datasetLabel(material.dataset)}).`
        : `Only first Brillouin-zone frame is shown (${datasetLabel(material.dataset)}).`
    );
    emitAnalysisState("rendered");
  }

  function buildMaterial(meta, id, dataset) {
    const dimsRaw = Array.isArray(meta.dims) && meta.dims.length === 3 ? meta.dims : [64, 64, 64];
    const dims = dimsRaw.map((v) => Math.max(2, Number(v) || 2));

    const vectorsRaw = Array.isArray(meta.vectors) && meta.vectors.length >= 3
      ? meta.vectors
      : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

    const basis = vectorsRaw.slice(0, 3).map((vec) => {
      const vv = Array.isArray(vec) ? vec : [0, 0, 0];
      return [Number(vv[0]) || 0, Number(vv[1]) || 0, Number(vv[2]) || 0];
    });

    const allBands = (Array.isArray(meta.bands) ? meta.bands : []).map((b) => ({
      index: Number(b.band),
      min: Number(b.min),
      max: Number(b.max),
      hasFermi: !!b.has_fermi,
      volume: null,
    })).filter((b) => Number.isFinite(b.index) && b.index >= 1);

    const crossing = allBands.filter((b) => b.hasFermi);
    const bands = crossing.length ? crossing : allBands;

    return {
      id,
      dataset,
      fermiEnergy: Number(meta.fermi_energy) || 0,
      dims,
      basis,
      bands,
      allBands,
      brillouinZone: null,
    };
  }

  async function loadSelectedDataset() {
    const id = matId();
    if (!id) return;

    if (!window.THREE || !THREE.OrbitControls || !THREE.MarchingCubes) {
      setInfo("THREE/OrbitControls/MarchingCubes not ready");
      return;
    }

    const dataset = currentDataset();
    const label = datasetLabel(dataset);

    // Ensure renderer buffer matches visible container size.
    resizeRenderer();
    setLoading(true, `Loading ${label} Fermi data...`);

    try {
      const meta = await apiGet(apiPath(id, dataset));
      if (!meta.available) {
        clearCarrierPanel(`${label} Fermi surface is not available.`);
        setInfo(meta.message || `${label} Fermi surface not available`);
        setLoading(false);
        return;
      }

      const material = buildMaterial(meta, id, dataset);
      if (!material.bands.length) {
        clearCarrierPanel(`${label} has no usable bands for carrier analysis.`);
        setInfo(`${label} has no usable bands`);
        setLoading(false);
        return;
      }

      state.material = material;
      state.selectedBandIndices = new Set(material.bands.map((b) => b.index));
      state.bandColorMap = new Map(material.bands.map((b) => [b.index, getDefaultBandColor(b.index)]));

      material.brillouinZone = buildFirstBrillouinZone(material.basis);

      syncIsoEnergyControls(material, material.fermiEnergy);
      populateBandPicker(material);
      updateLegend(getSelectedBands(material));
      updateSectionReadout(material);

      setBandPickerOpen(false);
      await renderSelection();
    } catch (error) {
      clearCarrierPanel("Fermi surface unavailable, so carrier concentration could not be evaluated.");
      setInfo(`Fermi surface unavailable: ${error && error.message ? error.message : error}`);
      setLoading(false);
    }
  }

  function onDatasetChanged() {
    const id = matId();
    if (id && state.avail) updateDownloadButton(id, state.avail);

    disposeCurrentObjects();
    state.material = null;
    state.selectedBandIndices = new Set();
    const menu = document.getElementById("fermiBandPickerMenu");
    if (menu) menu.innerHTML = "";
    updateLegend([]);
    updateBandPickerLabel();
    updateSectionReadout();
    setSectionCanvasMessage("Enable section to show the 2D cross-section");
    clearCarrierPanel("Dataset changed. Load the Fermi surface again to evaluate carrier concentration.");
    invalidateSdh("Dataset changed. Please recompute SdH.");
    setInfo('Dataset changed. Click "Load Fermi surface" to render.');
    emitAnalysisState("dataset-changed");
  }

  function updateOrthographicCameraFrustum() {
    const root = document.getElementById("fermiSceneRoot");
    if (!root || !state.camera || !state.camera.isOrthographicCamera) return;
    const width = Math.max(root.clientWidth || 1, 1);
    const height = Math.max(root.clientHeight || 1, 1);
    const aspect = width / height;
    const viewRadius = Math.max(Number(state.orthoViewRadius) || 4, 1e-3);
    state.camera.left = -viewRadius * aspect;
    state.camera.right = viewRadius * aspect;
    state.camera.top = viewRadius;
    state.camera.bottom = -viewRadius;
    state.camera.updateProjectionMatrix();
  }

  function initScene() {
    const root = document.getElementById("fermiSceneRoot");
    if (!root || state.renderer) return;

    if (!window.THREE) {
      setInfo("THREE.js is not loaded");
      return;
    }

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    root.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.01, 100);
    camera.position.set(4.8, 3.8, 5.4);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = false;

    const hemiLight = new THREE.HemisphereLight(0xeef6ff, 0x203040, 1.1);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
    keyLight.position.set(5, 6, 7);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x7ab4ff, 0.35);
    fillLight.position.set(-4, 2, -5);
    scene.add(fillLight);

    const contentGroup = new THREE.Group();
    scene.add(contentGroup);

    state.renderer = renderer;
    state.scene = scene;
    state.camera = camera;
    state.controls = controls;
    state.contentGroup = contentGroup;
    state.raycaster = new THREE.Raycaster();
    state.pointerNdc = new THREE.Vector2();

    resizeRenderer();

    if (!state.animating) {
      state.animating = true;
      animate();
    }
  }

  function resizeRenderer() {
    const root = document.getElementById("fermiSceneRoot");
    if (!root || !state.renderer || !state.camera) return;

    const width = root.clientWidth || 1;
    const height = root.clientHeight || 1;
    state.renderer.setSize(width, height, false);
    if (state.camera.isOrthographicCamera) {
      updateOrthographicCameraFrustum();
    } else {
      state.camera.aspect = width / Math.max(height, 1);
      state.camera.updateProjectionMatrix();
    }
    drawSectionPreview();
  }

  function animate() {
    if (!state.animating) return;
    requestAnimationFrame(animate);
    if (state.controls) state.controls.update();
    if (state.renderer && state.scene && state.camera) {
      state.renderer.render(state.scene, state.camera);
    }
  }

  async function prepareFermiBlock() {
    showBlock(true);
    // #fermiBlock is initially hidden; defer resize until visible.
    requestAnimationFrame(() => resizeRenderer());
    const id = matId();
    if (!id) return;

    const loadBtn = document.getElementById("fermiLoadBtn");
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.style.display = "inline-flex";
    }

    try {
      const avail = await ensureDatasetOptions(id);
      updateDownloadButton(id, avail);

      const hasAny = avail.soc || avail.nosoc;
      if (!hasAny) {
        clearCarrierPanel("Fermi surface not available.");
        setInfo("Fermi surface not available");
        if (loadBtn) loadBtn.style.display = "none";
        return;
      }

      setInfo('Click "Load Fermi surface" to render.');
      if (loadBtn) loadBtn.disabled = false;
    } catch (error) {
      setInfo(`Fermi surface unavailable: ${error && error.message ? error.message : error}`);
      if (loadBtn) loadBtn.disabled = true;
    }
  }

  async function downloadFermiSurfaceImage() {
    const btn = document.getElementById("fermiDownloadBtn");
    const oldText = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Rendering...";
    }
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (state.renderer && state.scene && state.camera) {
        state.renderer.render(state.scene, state.camera);
      }

      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const captureCanvas = async (canvas) => {
        if (!canvas) return null;
        try {
          return await loadImage(canvas.toDataURL("image/png"));
        } catch {
          return null;
        }
      };
      const selectedText = (selectId) => {
        const el = document.getElementById(selectId);
        const opt = el && el.selectedOptions ? el.selectedOptions[0] : null;
        return opt ? opt.textContent.trim() : (el && el.value ? String(el.value) : "-");
      };
      const textOf = (id) => {
        const el = document.getElementById(id);
        return el ? el.textContent.trim() : "-";
      };

      const stageImg = await captureCanvas(state.renderer && state.renderer.domElement);
      const sectionImg = await captureCanvas(document.getElementById("fermiSectionCanvas"));
      const scale = 2;
      const width = 1800;
      const margin = 36;
      const pad = 28;
      const cardW = width - margin * 2;
      const topH = 110;
      const imageH = 560;
      const controlsH = 205;
      const height = margin + 56 + topH + imageH + controlsH + margin;
      const out = document.createElement("canvas");
      out.width = width * scale;
      out.height = height * scale;
      const ctx = out.getContext("2d");
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
        ctx.fillStyle = opts.color || "#111827";
        ctx.font = opts.font || "16px Arial, sans-serif";
        ctx.textAlign = opts.align || "left";
        ctx.textBaseline = opts.baseline || "top";
        ctx.fillText(String(text || ""), x, y);
        ctx.restore();
      };
      const wrapText = (text, x, y, maxW, lineH, opts = {}) => {
        const words = String(text || "").split(/\s+/).filter(Boolean);
        let line = "";
        let yy = y;
        ctx.save();
        ctx.fillStyle = opts.color || "#64748b";
        ctx.font = opts.font || "14px Arial, sans-serif";
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
      const drawImageInBox = (img, x, y, w, h, fill = "#ffffff") => {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
        if (!img) {
          drawText("Image unavailable", x + 16, y + 16, { color: "#64748b" });
          return;
        }
        const iw = img.naturalWidth || img.width || w;
        const ih = img.naturalHeight || img.height || h;
        const ratio = Math.min(w / iw, h / ih);
        const dw = iw * ratio;
        const dh = ih * ratio;
        ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      };
      const drawStat = (label, value, x, y, w) => {
        rr(x, y, w, 64, 10);
        ctx.fillStyle = "#f8fafc";
        ctx.strokeStyle = "#dce2f2";
        ctx.fill();
        ctx.stroke();
        drawText(label, x + 12, y + 10, { font: "12px Arial, sans-serif", color: "#64748b" });
        drawText(value, x + 12, y + 32, { font: "bold 17px Arial, sans-serif" });
      };

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#2563eb";
      rr(margin + 2, margin + 12, 8, 24, 5);
      ctx.fill();
      drawText("Fermi Surface", margin + 20, margin + 12, { font: "bold 26px Arial, sans-serif" });

      let y = margin + 56;
      rr(margin, y, cardW, topH, 14);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#dfe4ee";
      ctx.fill();
      ctx.stroke();
      drawStat("Dataset", selectedText("fermiDataset"), margin + pad, y + 22, 220);
      drawStat("Fermi Energy", textOf("fermiStatEnergy"), margin + pad + 240, y + 22, 250);
      drawStat("Visible Bands", textOf("fermiStatBands"), margin + pad + 510, y + 22, 220);
      drawStat("Source Grid", textOf("fermiStatGrid"), margin + pad + 750, y + 22, 260);
      drawStat("Render Grid", textOf("fermiStatRender"), margin + pad + 1030, y + 22, 260);
      wrapText(textOf("fermiInfo"), margin + pad + 1310, y + 24, cardW - pad * 2 - 1310, 18, { color: "#64748b" });

      y += topH + 18;
      const stageW = Math.round((cardW - pad * 2 - 18) * 0.66);
      const sectionW = cardW - pad * 2 - 18 - stageW;
      rr(margin, y, cardW, imageH, 14);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#dfe4ee";
      ctx.fill();
      ctx.stroke();
      drawText(textOf("fermiViewerTitle") || "First-Brillouin-zone Fermi surface", margin + pad, y + 18, { font: "bold 21px Arial, sans-serif" });
      drawText("2D Section", margin + pad + stageW + 18, y + 18, { font: "bold 21px Arial, sans-serif" });
      drawImageInBox(stageImg, margin + pad, y + 52, stageW, imageH - 80, "#0a0f16");
      drawImageInBox(sectionImg, margin + pad + stageW + 18, y + 52, sectionW, imageH - 80, "#0a0f16");

      y += imageH + 18;
      rr(margin, y, cardW, controlsH, 14);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#dfe4ee";
      ctx.fill();
      ctx.stroke();
      const colW = (cardW - pad * 2 - 36) / 3;
      drawText("Bands", margin + pad, y + 20, { font: "bold 17px Arial, sans-serif" });
      wrapText(textOf("fermiBandPickerLabel"), margin + pad, y + 50, colW, 18, { color: "#111827" });
      drawText("Section", margin + pad + colW + 18, y + 20, { font: "bold 17px Arial, sans-serif" });
      wrapText(`normal=(${["fermiSectionN1","fermiSectionN2","fermiSectionN3"].map((id) => document.getElementById(id)?.value || "0").join(", ")}), ${textOf("fermiSectionReadout")}`, margin + pad + colW + 18, y + 50, colW, 18, { color: "#111827" });
      drawText("SdH", margin + pad + (colW + 18) * 2, y + 20, { font: "bold 17px Arial, sans-serif" });
      wrapText(`${textOf("fermiSdhStatus")} B=(${["fermiSdhN1","fermiSdhN2","fermiSdhN3"].map((id) => document.getElementById(id)?.value || "0").join(", ")})`, margin + pad + (colW + 18) * 2, y + 50, colW, 18, { color: "#111827" });

      const safeId = String((state.material && state.material.id) || matId() || "material").replace(/[^\w.-]+/g, "_");
      const filename = `${safeId}_Fermi_Surface.png`;
      await new Promise((resolve) => {
        out.toBlob((blob) => {
          const a = document.createElement("a");
          if (blob) {
            const url = URL.createObjectURL(blob);
            a.href = url;
            setTimeout(() => URL.revokeObjectURL(url), 500);
          } else {
            a.href = out.toDataURL("image/png");
          }
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          resolve();
        }, "image/png");
      });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  function svgEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function svgNum(value) {
    return Number.isFinite(value) ? Number(value).toFixed(3).replace(/\.?0+$/, "") : "0";
  }

  function downloadTextFile(text, filename, mime = "image/svg+xml;charset=utf-8") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function projectWorldToSvg(point, camera, width, height) {
    const p = point.clone().project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * width,
      y: (-p.y * 0.5 + 0.5) * height,
      z: p.z,
      ok: Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
    };
  }

  function svgPolyline(points, attrs = "") {
    if (!points || points.length < 2) return "";
    const d = points.map((p, idx) => `${idx ? "L" : "M"} ${svgNum(p.x)} ${svgNum(p.y)}`).join(" ");
    return `<path d="${d}" ${attrs}/>`;
  }

  function clipPolygonToBrillouinZone(points, zone) {
    if (!Array.isArray(points) || points.length < 3 || !zone?.planes?.length) return [];
    const tolerance = Math.max(zone.facetTolerance || GEOMETRY_EPS, GEOMETRY_EPS) * 4;
    let clipped = points.map((point) => point.clone());

    zone.planes.forEach((plane) => {
      if (clipped.length < 3) return;
      const next = [];
      const signedDistance = (point) => plane.normal.dot(point) - plane.offset;

      for (let i = 0; i < clipped.length; i += 1) {
        const current = clipped[i];
        const previous = clipped[(i + clipped.length - 1) % clipped.length];
        const currentDistance = signedDistance(current);
        const previousDistance = signedDistance(previous);
        const currentInside = currentDistance <= tolerance;
        const previousInside = previousDistance <= tolerance;

        if (currentInside !== previousInside) {
          const denom = previousDistance - currentDistance;
          if (Math.abs(denom) > GEOMETRY_EPS) {
            const t = previousDistance / denom;
            next.push(previous.clone().lerp(current, Math.min(1, Math.max(0, t))));
          }
        }
        if (currentInside) next.push(current.clone());
      }
      clipped = next;
    });

    return clipped.length >= 3 ? clipped : [];
  }

  function buildStageSvg() {
    if (!state.camera || !state.renderer || !state.material || !state.material.brillouinZone) {
      throw new Error("Fermi surface view unavailable");
    }
    const canvas = state.renderer.domElement;
    const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    const camera = state.camera;
    const zone = state.material.brillouinZone;
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

    const edgeLines = [];
    const edgeDepths = [];
    zone.edges.forEach(([ia, ib]) => {
      const pa = projectWorldToSvg(zone.vertices[ia], camera, width, height);
      const pb = projectWorldToSvg(zone.vertices[ib], camera, width, height);
      if (!pa.ok || !pb.ok) return;
      const line = `<line x1="${svgNum(pa.x)}" y1="${svgNum(pa.y)}" x2="${svgNum(pb.x)}" y2="${svgNum(pb.y)}" stroke="#111827" stroke-width="1.15" vector-effect="non-scaling-stroke"/>`;
      edgeLines.push({ line, z: (pa.z + pb.z) * 0.5 });
      edgeDepths.push((pa.z + pb.z) * 0.5);
    });

    const sortedEdgeDepths = edgeDepths.slice().sort((a, b) => a - b);
    const frontEdgeCutoff = sortedEdgeDepths.length
      ? sortedEdgeDepths[Math.floor(sortedEdgeDepths.length * 0.42)]
      : -Infinity;

    edgeLines.forEach((edge) => {
      parts.push(edge.line.replace("/>", ` stroke-opacity="0.46"/>`));
    });

    if (state.sectionState.enabled && state.sectionPreviewState && state.sectionPreviewState.polygon?.length) {
      const planeInfo = getSectionPlaneInfo(zone);
      const origin = planeInfo.normal.clone().multiplyScalar(planeInfo.offset);
      const basis = state.sectionPreviewState.planeBasis || buildSectionPlaneBasis(planeInfo.normal);
      const planePoints = state.sectionPreviewState.polygon.map((p) => {
        const world = origin.clone().addScaledVector(basis.u, p.x).addScaledVector(basis.v, p.y);
        return projectWorldToSvg(world, camera, width, height);
      });
      if (planePoints.every((p) => p.ok)) {
        const pts = planePoints.map((p) => `${svgNum(p.x)},${svgNum(p.y)}`).join(" ");
        parts.push(`<polygon points="${pts}" fill="#dbeafe" fill-opacity="0.38" stroke="#2563eb" stroke-opacity="0.28" stroke-width="1"/>`);
      }
    }

    const triangles = [];
    state.currentSurfaces.forEach((mesh) => {
      const pos = mesh.geometry && mesh.geometry.getAttribute("position");
      if (!pos) return;
      const index = mesh.geometry.getIndex && mesh.geometry.getIndex();
      const color = formatLegendColor(mesh.userData?.bandIndex);
      const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      mesh.updateMatrixWorld(true);
      for (let i = 0; i < triCount; i += 1) {
        const ia = index ? index.getX(i * 3) : i * 3;
        const ib = index ? index.getX(i * 3 + 1) : i * 3 + 1;
        const ic = index ? index.getX(i * 3 + 2) : i * 3 + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
        const clipped = clipPolygonToBrillouinZone([a, b, c], zone);
        if (clipped.length < 3) continue;
        const projected = clipped.map((point) => projectWorldToSvg(point, camera, width, height));
        if (!projected.every((point) => point.ok)) continue;
        triangles.push({
          z: projected.reduce((sum, point) => sum + point.z, 0) / projected.length,
          color,
          points: projected.map((point) => `${svgNum(point.x)},${svgNum(point.y)}`).join(" "),
        });
      }
    });
    triangles
      .sort((a, b) => b.z - a.z)
      .forEach((tri) => {
        parts.push(`<polygon points="${tri.points}" fill="${tri.color}" fill-opacity="1" stroke="${tri.color}" stroke-opacity="0.14" stroke-width="0.28"/>`);
      });

    edgeLines.forEach((edge) => {
      if (edge.z <= frontEdgeCutoff) {
        parts.push(edge.line.replace("/>", ` stroke-opacity="0.68"/>`));
      }
    });

    parts.push(`</svg>`);
    return parts.join("");
  }

  function buildSectionSvg() {
    const canvas = document.getElementById("fermiSectionCanvas");
    if (!canvas || !state.sectionPreviewState || !state.sectionPreviewState.polygon?.length) {
      throw new Error("2D section unavailable");
    }
    const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    const padding = 18;
    const usableWidth = Math.max(width - padding * 2, 1);
    const usableHeight = Math.max(height - padding * 2, 1);
    const { minX, maxX, minY, maxY } = state.sectionPreviewState.bounds;
    const spanX = Math.max(maxX - minX, SECTION_EPS);
    const spanY = Math.max(maxY - minY, SECTION_EPS);
    const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const project = (point) => ({
      x: width * 0.5 + (point.x - centerX) * scale,
      y: height * 0.5 - (point.y - centerY) * scale,
    });

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

    const poly = state.sectionPreviewState.polygon.map(project);
    const clipId = `sectionClip-${Date.now().toString(36)}`;
    const polyPts = poly.map((p) => `${svgNum(p.x)},${svgNum(p.y)}`).join(" ");
    parts.push(`<defs><clipPath id="${clipId}"><polygon points="${polyPts}"/></clipPath></defs>`);
    parts.push(`<g clip-path="url(#${clipId})">`);
    state.sectionPreviewState.bands.forEach((band) => {
      const color = svgEscape(band.color || "#2563eb");
      band.segments.forEach((segment) => {
        const p0 = project(segment.start);
        const p1 = project(segment.end);
        parts.push(`<line x1="${svgNum(p0.x)}" y1="${svgNum(p0.y)}" x2="${svgNum(p1.x)}" y2="${svgNum(p1.y)}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`);
      });
    });
    parts.push(`</g>`);
    parts.push(`<polygon points="${polyPts}" fill="none" stroke="#111827" stroke-width="2.4" stroke-linejoin="round"/>`);
    parts.push(`</svg>`);
    return parts.join("");
  }

  async function downloadFermiCanvasImage(kind) {
    const isStage = kind === "stage";
    const btn = document.getElementById(isStage ? "fermiDownloadStage" : "fermiDownloadSection");
    const oldText = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Rendering...";
    }
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let svg = "";
      if (isStage) {
        if (state.renderer && state.scene && state.camera) {
          state.renderer.render(state.scene, state.camera);
        }
        svg = buildStageSvg();
      } else {
        drawSectionPreview();
        svg = buildSectionSvg();
      }
      const safeId = String((state.material && state.material.id) || matId() || "material").replace(/[^\w.-]+/g, "_");
      const filename = `${safeId}_${isStage ? "fermi_surface" : "fermi_2d_section"}.svg`;
      downloadTextFile(svg, filename);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  function bindEvents() {
    const downloadBtn = document.getElementById("fermiDownloadBtn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => {
        downloadFermiSurfaceImage().catch(() => {
          setInfo("Fermi Surface image export failed");
        });
      });
    }
    const stageDownloadBtn = document.getElementById("fermiDownloadStage");
    if (stageDownloadBtn) {
      stageDownloadBtn.addEventListener("click", () => {
        downloadFermiCanvasImage("stage").catch(() => {
          setInfo("Fermi-surface image export failed");
        });
      });
    }
    const sectionDownloadBtn = document.getElementById("fermiDownloadSection");
    if (sectionDownloadBtn) {
      sectionDownloadBtn.addEventListener("click", () => {
        downloadFermiCanvasImage("section").catch(() => {
          setInfo("2D section image export failed");
        });
      });
    }

    const datasetSel = document.getElementById("fermiDataset");
    if (datasetSel) {
      datasetSel.addEventListener("change", onDatasetChanged);
    }

    const loadBtn = document.getElementById("fermiLoadBtn");
    if (loadBtn) {
      loadBtn.addEventListener("click", () => {
        loadSelectedDataset();
      });
    }

    const pickerBtn = document.getElementById("fermiBandPickerBtn");
    const picker = document.getElementById("fermiBandPicker");
    if (pickerBtn && picker) {
      pickerBtn.addEventListener("click", () => {
        const isOpen = picker.classList.contains("is-open");
        setBandPickerOpen(!isOpen);
      });

      document.addEventListener("click", (event) => {
        if (!picker.contains(event.target)) setBandPickerOpen(false);
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setBandPickerOpen(false);
      });
    }

    const quality = document.getElementById("fermiQuality");
    if (quality) {
      quality.addEventListener("change", () => {
        if (state.material) requestRender(10);
      });
    }

    const isoSlider = document.getElementById("fermiIsoSlider");
    const isoNumber = document.getElementById("fermiIsoNumber");
    const isoReset = document.getElementById("fermiIsoReset");

    if (isoSlider) {
      isoSlider.addEventListener("input", () => {
        if (!state.material) return;
        if (setIsoEnergy(isoSlider.value)) requestRender(40);
      });
      isoSlider.addEventListener("change", () => {
        if (!state.material) return;
        if (setIsoEnergy(isoSlider.value)) requestRender(10);
      });
    }

    if (isoNumber) {
      isoNumber.addEventListener("change", () => {
        if (!state.material) return;
        if (setIsoEnergy(isoNumber.value)) requestRender(10);
      });
    }

    if (isoReset) {
      isoReset.addEventListener("click", () => {
        if (!state.material) return;
        syncIsoEnergyControls(state.material, state.material.fermiEnergy);
        requestRender(10);
      });
    }

    const sectionEnabled = document.getElementById("fermiSectionEnabled");
    const sectionN1 = document.getElementById("fermiSectionN1");
    const sectionN2 = document.getElementById("fermiSectionN2");
    const sectionN3 = document.getElementById("fermiSectionN3");
    const sectionOffset = document.getElementById("fermiSectionOffset");
    const sdhRun = document.getElementById("fermiSdhRun");
    const sdhN1 = document.getElementById("fermiSdhN1");
    const sdhN2 = document.getElementById("fermiSdhN2");
    const sdhN3 = document.getElementById("fermiSdhN3");

    if (sectionEnabled) {
      sectionEnabled.addEventListener("change", () => {
        scheduleSectionUpdate();
      });
    }

    [sectionN1, sectionN2, sectionN3].forEach((el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        scheduleSectionUpdate({ preserveOffset: false });
      });
    });

    if (sectionOffset) {
      sectionOffset.addEventListener("input", () => {
        scheduleSectionUpdate();
      });
    }

    if (sdhRun) {
      sdhRun.addEventListener("click", () => {
        computeSdhAnalysis().catch((error) => {
          setSdhStatus(`SdH failed: ${error && error.message ? error.message : error}`);
          setLoading(false);
        });
      });
    }

    [sdhN1, sdhN2, sdhN3].forEach((el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        syncSdhStateFromUi();
        invalidateSdh("Magnetic-field direction updated. Please recompute SdH.");
      });
    });

    const canvas = state.renderer && state.renderer.domElement;
    if (canvas) {
      canvas.addEventListener("pointermove", handleSdhPointerMove);
      canvas.addEventListener("pointerleave", () => {
        hideSdhHover();
      });
    }

    window.addEventListener("resize", () => {
      resizeRenderer();
    });
  }

  window.addEventListener("load", async () => {
    try {
      syncSectionStateFromUi();
      syncSdhStateFromUi();
      updateSectionReadout();
      setSectionCanvasMessage("Enable section to show the 2D cross-section");
      setSdhStatus("Not computed");
      clearSdhResults();
      clearCarrierPanel();

      await prepareFermiBlock();
      initScene();
      bindEvents();
      resizeRenderer();
      window.FermiSurfaceAnalysis = {
        analyzeExtremalOrbitSweep,
        getSelection: () => buildAnalysisContext("snapshot"),
      };
    } catch (error) {
      setInfo(`Fermi surface unavailable: ${error && error.message ? error.message : error}`);
      setLoading(false);
    }
  });
})();
