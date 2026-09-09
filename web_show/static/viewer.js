// Basic crystal viewer using three.js

class CrystalViewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);
    // small axes scene (for a/b/c gizmo)
    this.axesScene = new THREE.Scene();
    this.axesScene.background = null; // transparent overlay
    this.basePixelRatio = window.devicePixelRatio || 1;
    this.interactionPixelRatio = this.basePixelRatio;
    this.currentPixelRatio = 0;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true
    });
    // we handle clearing manually so the axes overlay does not overwrite color
    this.renderer.autoClear = false;
    this._setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight, true);
    container.innerHTML = "";
    container.appendChild(this.renderer.domElement);
    container.__crystalViewer = this;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.orthoViewSize = 10;
    this.camera = new THREE.OrthographicCamera(
      -0.5 * this.orthoViewSize * aspect,
      0.5 * this.orthoViewSize * aspect,
      0.5 * this.orthoViewSize,
      -0.5 * this.orthoViewSize,
      0.1,
      1000
    );
    // axes camera uses square viewport and copies orientation from main camera
    this.axesCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10);
    this.axesCamera.position.set(0, 0, 3);
    this.showAxes = true;
    this.axesViewportMargin = 22;

    this.target = new THREE.Vector3();
    this.viewDir = new THREE.Vector3(1, 1, 1).normalize();
    this.viewUp = new THREE.Vector3(0, 0, 1);
    this._dragging = false;
    this._last = { x: 0, y: 0 };
    const el = this.renderer.domElement;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this._dragging = true;
      this._setInteractionMode(true);
      this._last = { x: e.clientX, y: e.clientY };
      this._lastArcball = this._screenToArcball(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      const currentArcball = this._screenToArcball(e.clientX, e.clientY);
      this._rotateObjectFromArcball(this._lastArcball, currentArcball);
      this._lastArcball = currentArcball;
      this._last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._lastArcball = null;
      this._setInteractionMode(false);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._setInteractionMode(true);
      const zoom = Math.exp(-e.deltaY * 0.001);
      if (this.camera?.isOrthographicCamera) {
        this.orthoViewSize = Math.max(1e-6, Math.min(1e6, this.orthoViewSize / zoom));
        this._updateCameraProjection();
      } else {
        this.radius = Math.max(0.1, Math.min(1e6, this.radius * zoom));
      }
      clearTimeout(this._wheelEndTimer);
      this._wheelEndTimer = setTimeout(() => this._setInteractionMode(false), 120);
    }, { passive: false });

    this._sharedAtomGeometry = new THREE.SphereGeometry(1, 18, 14);
    this._sharedBondGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this._atomMaterialCache = new Map();
    this._bondMaterial = null;
    this._tmpMatrix = new THREE.Matrix4();
    this._tmpQuaternion = new THREE.Quaternion();
    this._tmpScale = new THREE.Vector3();
    this._unitY = new THREE.Vector3(0, 1, 0);
    this.radius = 10;

    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);
    // lighting for axes gizmo
    const ambAxes = new THREE.AmbientLight(0xffffff, 0.9);
    this.axesScene.add(ambAxes);
    const dirAxes = new THREE.DirectionalLight(0xffffff, 0.9);
    dirAxes.position.set(1, 1, 1);
    this.axesScene.add(dirAxes);

    this.root = new THREE.Group();
    this.groupAtoms = new THREE.Group();
    this.groupBonds = new THREE.Group();
    this.groupAxes = new THREE.Group();
    this.groupField = new THREE.Group();
    this.groupMrOverlay = new THREE.Group();
    this.root.add(this.groupAtoms);
    this.root.add(this.groupBonds);
    this.scene.add(this.groupField);
    this.scene.add(this.groupMrOverlay);
    this.scene.add(this.root);
    // axes live in a separate scene rendered in bottom-left corner
    this.axesScene.add(this.groupAxes);

    window.addEventListener('resize', () => this._onResize());
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(this.container);
    }
    this._animate();
  }

  _setPixelRatio(nextRatio) {
    if (!Number.isFinite(nextRatio) || nextRatio <= 0) return;
    if (Math.abs(this.currentPixelRatio - nextRatio) < 1e-6) return;
    this.currentPixelRatio = nextRatio;
    this.renderer.setPixelRatio(nextRatio);
    const w = Math.max(1, this.container.clientWidth || 1);
    const h = Math.max(1, this.container.clientHeight || 1);
    this.renderer.setSize(w, h, true);
  }

  _setInteractionMode(active) {
    this._setPixelRatio(active ? this.interactionPixelRatio : this.basePixelRatio);
  }

  _updateCameraProjection() {
    const w = Math.max(1, this.container.clientWidth || 1);
    const h = Math.max(1, this.container.clientHeight || 1);
    const aspect = w / h;
    if (this.camera?.isOrthographicCamera) {
      const halfH = Math.max(1e-6, this.orthoViewSize || 10) / 2;
      const halfW = halfH * aspect;
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.top = halfH;
      this.camera.bottom = -halfH;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) {
      this._updateCameraProjection();
      this.basePixelRatio = window.devicePixelRatio || 1;
      this.interactionPixelRatio = this.basePixelRatio;
      this.renderer.setSize(w, h, true);
    }
  }

  _rotateView(deltaAzimuth, deltaElevation) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(this.viewUp, -deltaAzimuth);
    this.viewDir.applyQuaternion(qYaw).normalize();

    const right = new THREE.Vector3().crossVectors(this.viewDir, this.viewUp).normalize();
    if (right.lengthSq() > 1e-12) {
      const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -deltaElevation);
      this.viewDir.applyQuaternion(qPitch).normalize();
      this.viewUp.applyQuaternion(qPitch).normalize();
    }
    // Keep up perpendicular to view direction to avoid gradual roll/skew.
    const cleanRight = new THREE.Vector3().crossVectors(this.viewDir, this.viewUp).normalize();
    if (cleanRight.lengthSq() > 1e-12) {
      this.viewUp.crossVectors(cleanRight, this.viewDir).normalize();
    }
  }

  _screenToArcball(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const r = Math.max(1, Math.min(w, h) * 0.5);
    const x = (clientX - (rect.left + w * 0.5)) / r;
    const y = ((rect.top + h * 0.5) - clientY) / r;
    const len2 = x * x + y * y;
    if (len2 > 1) {
      const invLen = 1 / Math.sqrt(len2);
      return new THREE.Vector3(x * invLen, y * invLen, 0);
    }
    return new THREE.Vector3(x, y, Math.sqrt(1 - len2)).normalize();
  }

  _rotateObjectFromArcball(from, to) {
    if (!from || !to) return;
    const dot = Math.max(-1, Math.min(1, from.dot(to)));
    if (Math.abs(1 - dot) < 1e-8) return;

    const qCamera = new THREE.Quaternion().setFromUnitVectors(from, to);
    const cameraQuat = this.camera.quaternion.clone();
    const qWorld = cameraQuat.clone()
      .multiply(qCamera)
      .multiply(cameraQuat.clone().invert())
      .normalize();
    this._applyObjectRotation(qWorld);
  }

  _applyObjectRotation(qWorld) {
    if (!qWorld) return;
    const pivot = this.target?.clone?.() || new THREE.Vector3();
    [this.root, this.groupField, this.groupMrOverlay].forEach((group) => {
      if (!group) return;
      group.position.sub(pivot).applyQuaternion(qWorld).add(pivot);
      group.quaternion.premultiply(qWorld).normalize();
      group.updateMatrixWorld(true);
    });
    if (this.groupAxes) {
      this.groupAxes.quaternion.premultiply(qWorld).normalize();
      this.groupAxes.updateMatrixWorld(true);
    }
  }

  setObjectRotationDegrees(rx = 0, ry = 0, rz = 0) {
    const nums = [rx, ry, rz].map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    });
    [this.root, this.groupField, this.groupMrOverlay, this.groupAxes].forEach((group) => this._resetGroupTransform(group));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      nums[0] * Math.PI / 180,
      nums[1] * Math.PI / 180,
      nums[2] * Math.PI / 180,
      'XYZ'
    ));
    this._applyObjectRotation(q);
    this.objectRotationDegrees = { x: nums[0], y: nums[1], z: nums[2] };
  }

  resetObjectRotation() {
    this.setObjectRotationDegrees(0, 0, 0);
  }

  _resetGroupTransform(group) {
    if (!group) return;
    group.position.set(0, 0, 0);
    group.quaternion.identity();
    group.scale.set(1, 1, 1);
    group.updateMatrixWorld(true);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this._renderFrame();
  }

  _renderFrame() {
    const camPos = this.target.clone().add(this.viewDir.clone().multiplyScalar(this.radius));
    this.camera.position.copy(camPos);
    this.camera.up.copy(this.viewUp);
    this.camera.lookAt(this.target);

    // main scene full viewport
    const w = this.container.clientWidth || this.renderer.domElement.width;
    const h = this.container.clientHeight || this.renderer.domElement.height;
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setScissorTest(false);
    // clear color+depth once for the whole frame
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    if (this.showAxes !== false) {
      // axes gizmo: small square in bottom-left, rotates with main camera
      // Place the axes camera along the main camera direction and look at origin,
      // so the gizmo stays centered and never drifts out of the corner.
      const dirAxes = this.camera.position.clone().sub(this.target).normalize();
      // Pull the gizmo camera back so arrow labels are not clipped by the small viewport.
      this.axesCamera.position.copy(dirAxes.multiplyScalar(4.8));
      this.axesCamera.up.copy(this.camera.up);
      this.axesCamera.lookAt(0, 0, 0);
      this.axesCamera.updateProjectionMatrix();

      const size = Math.min(w, h);
      // Slightly larger viewport so a/b/c labels are not clipped.
      const vp = Math.max(120, Math.round(size * 0.22));
      const margin = this.axesViewportMargin ?? 22;
      this.renderer.clearDepth();
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(margin, margin, vp, vp);
      this.renderer.setViewport(margin, margin, vp, vp);
      this.renderer.render(this.axesScene, this.axesCamera);
      this.renderer.setScissorTest(false);
    }
  }

  capturePNG() {
    this._renderFrame();
    return this.renderer.domElement.toDataURL('image/png');
  }

  exportSVG() {
    this._renderFrame();
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const w = Math.max(1, Math.round(this.container.clientWidth || this.renderer.domElement.clientWidth || 800));
    const h = Math.max(1, Math.round(this.container.clientHeight || this.renderer.domElement.clientHeight || 520));
    const esc = (v) => String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const colorHex = (mat, fallback = '#111111') => {
      const c = mat?.color;
      if (!c || typeof c.getHexString !== 'function') return fallback;
      return `#${c.getHexString()}`;
    };
    const opacityOf = (mat, fallback = 1) => {
      const n = Number(mat?.opacity);
      return mat?.transparent && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
    };
    const project = (vec) => {
      const p = vec.clone().project(this.camera);
      return {
        x: (p.x * 0.5 + 0.5) * w,
        y: (-p.y * 0.5 + 0.5) * h,
        z: p.z,
      };
    };
    const items = [];
    const atomItems = [];
    const tmpMat = new THREE.Matrix4();
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3();

    const addLineSegments = (obj, stroke, opacity = 1, widthPx = 1) => {
      const attr = obj.geometry?.getAttribute?.('position');
      if (!attr) return;
      const addProjectedLine = (pa, pb, aWorld, bWorld) => {
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-8) return;
        const len = Math.sqrt(len2);
        const lineWorld = new THREE.Vector3().subVectors(bWorld, aWorld);
        const lineWorldLen2 = lineWorld.lengthSq();
        const cuts = [0, 1];
        const overlapInset = Math.min(0.25, Math.max(0.08, widthPx * 0.2));
        const occlusionRadius = (atom) => Math.max(0, atom.r - overlapInset);
        const isAtomOnWorldLine = (atom) => {
          if (!atom.world || lineWorldLen2 < 1e-12) return false;
          const aw = new THREE.Vector3().subVectors(atom.world, aWorld);
          const tw = Math.max(0, Math.min(1, aw.dot(lineWorld) / lineWorldLen2));
          const closest = aWorld.clone().add(lineWorld.clone().multiplyScalar(tw));
          const tol = Math.max(1e-4, (atom.radiusWorld || 0) * 0.18);
          return closest.distanceToSquared(atom.world) < tol * tol;
        };
        const isAtomAtLineEndpoint = (atom) => {
          if (!atom.world) return false;
          const tol = Math.max(1e-4, (atom.radiusWorld || 0) * 0.18);
          const tol2 = tol * tol;
          return atom.world.distanceToSquared(aWorld) < tol2 || atom.world.distanceToSquared(bWorld) < tol2;
        };
        atomItems.forEach((atom) => {
          const t = Math.max(0, Math.min(1, ((atom.x - pa.x) * dx + (atom.y - pa.y) * dy) / len2));
          const cx = pa.x + dx * t;
          const cy = pa.y + dy * t;
          const d2 = (cx - atom.x) ** 2 + (cy - atom.y) ** 2;
          const rr = occlusionRadius(atom) ** 2;
          if (d2 >= rr) return;
          const dt = Math.sqrt(rr - d2) / len;
          cuts.push(Math.max(0, t - dt), Math.min(1, t + dt));
        });
        const uniqCuts = Array.from(new Set(cuts.map((v) => Math.max(0, Math.min(1, v)).toFixed(6))))
          .map(Number)
          .sort((a, b) => a - b);
        for (let j = 0; j + 1 < uniqCuts.length; j++) {
          const t0 = uniqCuts[j];
          const t1 = uniqCuts[j + 1];
          if (t1 - t0 < 1e-5) continue;
          const tm = (t0 + t1) / 2;
          const xm = pa.x + dx * tm;
          const ym = pa.y + dy * tm;
          const zm = pa.z + (pb.z - pa.z) * tm;
          const occluded = atomItems.some((atom) => {
            const d2 = (xm - atom.x) ** 2 + (ym - atom.y) ** 2;
            const sameDepthOnLine = Math.abs(atom.depth - zm) < 0.015 && isAtomOnWorldLine(atom);
            // In projected NDC depth, smaller z is closer to the camera.
            return d2 < occlusionRadius(atom) ** 2 &&
              (isAtomAtLineEndpoint(atom) || sameDepthOnLine || atom.depth < zm - 1e-5);
          });
          if (occluded) continue;
          const x0 = pa.x + dx * t0;
          const y0 = pa.y + dy * t0;
          const x1 = pa.x + dx * t1;
          const y1 = pa.y + dy * t1;
          items.push({
            depth: zm,
            svg: `<line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" stroke="${stroke}" stroke-width="${widthPx}" stroke-opacity="${opacity}" vector-effect="non-scaling-stroke"/>`,
          });
        }
      };
      for (let i = 0; i + 1 < attr.count; i += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(attr, i + 1).applyMatrix4(obj.matrixWorld);
        const pa = project(a);
        const pb = project(b);
        addProjectedLine(pa, pb, a, b);
      }
    };

    const addMeshTriangles = (obj, fill, opacity = 0.2, stroke = 'none', strokeOpacity = 0) => {
      const geom = obj.geometry;
      const attr = geom?.getAttribute?.('position');
      if (!attr) return;
      const index = geom.index;
      const triCount = index ? Math.floor(index.count / 3) : Math.floor(attr.count / 3);
      for (let t = 0; t < triCount; t++) {
        const idx = index
          ? [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]
          : [t * 3, t * 3 + 1, t * 3 + 2];
        const pts3 = idx.map((ii) => new THREE.Vector3().fromBufferAttribute(attr, ii).applyMatrix4(obj.matrixWorld));
        const pts = pts3.map(project);
        const depth = (pts[0].z + pts[1].z + pts[2].z) / 3;
        const d = `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}L${pts[1].x.toFixed(2)} ${pts[1].y.toFixed(2)}L${pts[2].x.toFixed(2)} ${pts[2].y.toFixed(2)}Z`;
        items.push({
          depth,
          svg: `<path d="${d}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="0.5"/>`,
        });
      }
    };

    const addInstancedAtoms = (obj) => {
      const mat = obj.material;
      const fill = colorHex(mat, '#c88033');
      for (let i = 0; i < obj.count; i++) {
        obj.getMatrixAt(i, tmpMat);
        tmpMat.premultiply(obj.matrixWorld);
        tmpMat.decompose(tmpPos, tmpQuat, tmpScale);
        const p = project(tmpPos);
        const radiusWorld = Math.max(tmpScale.x, tmpScale.y, tmpScale.z);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(radiusWorld);
        const pr = project(tmpPos.clone().add(right));
        const r = Math.max(2, Math.hypot(pr.x - p.x, pr.y - p.y));
        const atomItem = {
          depth: p.z,
          x: p.x,
          y: p.y,
          z: p.z,
          r,
          world: tmpPos.clone(),
          radiusWorld,
          svg: [
            `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${fill}" stroke="#0f172a" stroke-opacity="0.35" stroke-width="0.4"/>`,
            `<circle cx="${(p.x - r * 0.32).toFixed(2)}" cy="${(p.y - r * 0.35).toFixed(2)}" r="${Math.max(1, r * 0.16).toFixed(2)}" fill="#fff7b3" fill-opacity="0.9"/>`,
          ].join(''),
        };
        atomItems.push(atomItem);
        items.push(atomItem);
      }
    };

    const roots = [this.root, this.groupMrOverlay, this.groupField].filter(Boolean);
    roots.forEach((root) => {
      root.updateMatrixWorld(true);
      root.traverse((obj) => {
        if (!obj.visible) return;
        if (obj.isInstancedMesh) {
          addInstancedAtoms(obj);
          return;
        }
        if (obj.isLineSegments || obj.isLine) {
          addLineSegments(obj, colorHex(obj.material, '#111111'), opacityOf(obj.material, 1), 1);
          return;
        }
        if (obj.isMesh) {
          const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
          const fill = colorHex(mat, '#f2d2b6');
          const opacity = opacityOf(mat, 0.18);
          addMeshTriangles(obj, fill, opacity, 'none', 0);
        }
      });
    });
    const drawable = items.sort((a, b) => b.depth - a.depth);
    const body = drawable.map((it) => it.svg).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
  }

  clear() {
    this.scene.remove(this.root);
    this.root = new THREE.Group();
    this.groupAtoms = new THREE.Group();
    this.groupBonds = new THREE.Group();
    this.root.add(this.groupAtoms);
    this.root.add(this.groupBonds);
    this.scene.add(this.root);
    [this.root, this.groupField, this.groupMrOverlay, this.groupAxes].forEach((group) => this._resetGroupTransform(group));
    // clear field arrow
    while (this.groupField.children.length) {
      const obj = this.groupField.children.pop();
      if (obj) this.groupField.remove(obj);
    }
    this.clearMrOverlay();
  }

  _makeTextSprite(text, color = '#cbd5e1') {
    const fontSize = 96;
    const pad = 16;
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width, canvas.height);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // outline for contrast
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeText(text, pad, canvas.height/2);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, canvas.height/2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    const scale = 0.45; // world units per 100px approx
    sprite.scale.set(canvas.width/100*scale, canvas.height/100*scale, 1);
    return sprite;
  }

  _makeAxisLabelSprite(text, color = '#e2e8f0') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Solid black "Heiti"/bold style label (a/b/c)
    ctx.font = `900 190px "SimHei","Heiti SC","Microsoft YaHei",sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#111827';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    const scale = 0.14;
    sprite.scale.set((canvas.width / 100) * scale, (canvas.height / 100) * scale, 1);
    sprite.renderOrder = 999;
    return sprite;
  }

  _rebuildAxes(origin, maxDim) {
    // Clear old axes
    while (this.groupAxes.children.length) {
      const obj = this.groupAxes.children.pop();
      if (obj) this.groupAxes.remove(obj);
    }
    // MP-style a/b/c gizmo: grey hub sphere + three colored arrows.
    const hubRadius = 0.18;
    const shaftLen = 0.55;
    const headLen = 0.25;
    const shaftR = 0.045;
    const headR = 0.09;
    const startOffset = hubRadius + 0.02; // where arrows emerge from hub
    const labelOffset = 0.08;

    // hub sphere at origin
    const hubGeom = new THREE.SphereGeometry(hubRadius, 24, 16);
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0xe5e7eb,
      metalness: 0.15,
      roughness: 0.7
    });
    const hub = new THREE.Mesh(hubGeom, hubMat);
    hub.position.copy(origin);
    this.groupAxes.add(hub);
    const addAxis = (dir, colorHex, labelText) => {
      const dirV = new THREE.Vector3(...dir).normalize();
      // shaft as cylinder
      const shaftGeom = new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 20, 1, true);
      const shaftMat = new THREE.MeshStandardMaterial({
        color: colorHex,
        metalness: 0.35,
        roughness: 0.35
      });
      const shaft = new THREE.Mesh(shaftGeom, shaftMat);
      // orient cylinder (default along Y) to dir
      const quat = new THREE.Quaternion();
      quat.setFromUnitVectors(new THREE.Vector3(0,1,0), dirV);
      shaft.setRotationFromQuaternion(quat);
      const shaftCenterDist = startOffset + shaftLen / 2;
      shaft.position.copy(origin.clone().add(dirV.clone().multiplyScalar(shaftCenterDist)));
      this.groupAxes.add(shaft);
      // head as cone
      const headGeom = new THREE.ConeGeometry(headR, headLen, 24);
      const headMat = new THREE.MeshStandardMaterial({
        color: colorHex,
        metalness: 0.35,
        roughness: 0.4
      });
      const head = new THREE.Mesh(headGeom, headMat);
      head.setRotationFromQuaternion(quat);
      const headCenterDist = startOffset + shaftLen + headLen / 2;
      head.position.copy(origin.clone().add(dirV.clone().multiplyScalar(headCenterDist)));
      this.groupAxes.add(head);

      if (labelText) {
        const label = this._makeAxisLabelSprite(labelText);
        const labelDist = startOffset + shaftLen + headLen + labelOffset;
        label.position.copy(origin.clone().add(dirV.clone().multiplyScalar(labelDist)));
        this.groupAxes.add(label);
      }
    };
    // Prefer crystallographic axes (a, b, c) if available; otherwise fall back to Cartesian X/Y/Z.
    if (this.aVec && this.bVec && this.cVec) {
      const aDir = this.aVec.clone().normalize().toArray();
      const bDir = this.bVec.clone().normalize().toArray();
      const cDir = this.cVec.clone().normalize().toArray();
      addAxis(aDir, 0xef4444, 'a'); // a: red
      addAxis(bDir, 0x22c55e, 'b'); // b: green
      addAxis(cDir, 0x2563eb, 'c'); // c: blue
    } else {
      addAxis([1,0,0], 0xef4444, 'a');
      addAxis([0,1,0], 0x22c55e, 'b');
      addAxis([0,0,1], 0x2563eb, 'c');
    }
  }

  // Simple color mapping by element
  colorForElement(el) {
    const colors = {
      H: 0xffffff, C: 0x444444, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050,
      Na: 0xab5cf2, Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0, P: 0xff8000,
      S: 0xffff30, Cl: 0x1ff01f, K: 0x8f40d4, Ca: 0x3dff00, Sc: 0xe6e6e6,
      Ti: 0xbfc2c7, V: 0xa6a6ab, Cr: 0x8a99c7, Mn: 0x9c7ac7, Fe: 0xe06633,
      Co: 0xf090a0, Ni: 0x50d050, Cu: 0xc88033, Zn: 0x7d80b0, Ga: 0xc28f8f,
      Ge: 0x668f8f, As: 0xbd80e3, Se: 0xffa100, Br: 0xa62929, Kr: 0x5cb8d1,
      Rb: 0x702eb0, Sr: 0x00ff00, Y: 0x94ffff, Zr: 0x94e0e0, Nb: 0x73c2c9,
      Mo: 0x54b5b5, Tc: 0x3b9e9e, Ru: 0x248f8f, Rh: 0x0a7d8c, Pd: 0x006985,
      Ag: 0xc0c0c0, Cd: 0xffd98f, In: 0xa67573, Sn: 0x668080, Sb: 0x9e63b5,
      Te: 0x7c3aed, I: 0x940094, Xe: 0x429eb0, Cs: 0x57178f, Ba: 0x00c900,
      La: 0x70d4ff, Ce: 0xffffc7, Pr: 0xd9ffc7, Nd: 0xc7ffc7, Pm: 0xa3ffc7,
      Sm: 0x8fffc7, Eu: 0x61ffc7, Gd: 0x45ffc7, Tb: 0x30ffc7, Dy: 0x1fffc7,
      Ho: 0x00ff9c, Er: 0x00e675, Tm: 0x00d452, Yb: 0x00bf38, Lu: 0x00ab24,
      Hf: 0x4dc2ff, Ta: 0x4da6ff, W: 0x2194d6, Re: 0x267dab, Os: 0x266696,
      Ir: 0x175487, Pt: 0xd0d0e0, Au: 0xffd123, Hg: 0xb8b8d0, Tl: 0xa6544d,
      Pb: 0x575961, Bi: 0x9e4fb5
    };
    return colors[el] ?? 0x4cc9f0;
  }

  _getAtomMaterial(el) {
    const color = this.colorForElement(el);
    const metalness = Number.isFinite(this.atomMetalness) ? this.atomMetalness : 0.08;
    const roughness = Number.isFinite(this.atomRoughness) ? this.atomRoughness : 0.42;
    if (!this._atomMaterialCache.has(el)) {
      this._atomMaterialCache.set(el, new THREE.MeshStandardMaterial({ color, metalness, roughness }));
    } else {
      const mat = this._atomMaterialCache.get(el);
      mat.color.set(color);
      mat.metalness = metalness;
      mat.roughness = roughness;
      mat.needsUpdate = true;
    }
    return this._atomMaterialCache.get(el);
  }

  _getBondMaterial() {
    if (!this._bondMaterial) {
      this._bondMaterial = new THREE.MeshStandardMaterial({
        color: this.bondColor ?? 0xbbc0c5,
        metalness: this.bondMetalness ?? 0.2,
        roughness: this.bondRoughness ?? 0.6
      });
    } else {
      this._bondMaterial.color.set(this.bondColor ?? 0xbbc0c5);
      this._bondMaterial.metalness = this.bondMetalness ?? 0.2;
      this._bondMaterial.roughness = this.bondRoughness ?? 0.6;
      this._bondMaterial.needsUpdate = true;
    }
    return this._bondMaterial;
  }

  _addCellShell(a, b, c, nx, ny, nz, opts = {}) {
    const aP = a.clone().multiplyScalar(nx);
    const bP = b.clone().multiplyScalar(ny);
    const cP = c.clone().multiplyScalar(nz);
    const corners = [
      new THREE.Vector3(0, 0, 0),
      aP.clone(),
      bP.clone(),
      cP.clone(),
      aP.clone().add(bP),
      aP.clone().add(cP),
      bP.clone().add(cP),
      aP.clone().add(bP).add(cP),
    ];
    const faces = [
      [0, 1, 4, 2],
      [3, 5, 7, 6],
      [0, 1, 5, 3],
      [2, 4, 7, 6],
      [0, 2, 6, 3],
      [1, 4, 7, 5],
    ];
    if (opts.showCellFaces !== false) {
      const faceVerts = [];
      faces.forEach(([i, j, k, l]) => {
        [i, j, k, i, k, l].forEach((idx) => {
          const p = corners[idx];
          faceVerts.push(p.x, p.y, p.z);
        });
      });
      const faceGeom = new THREE.BufferGeometry();
      faceGeom.setAttribute('position', new THREE.Float32BufferAttribute(faceVerts, 3));
      faceGeom.computeVertexNormals();
      const faceMat = new THREE.MeshBasicMaterial({
        color: opts.cellFaceColor ?? 0xf2d2b6,
        transparent: true,
        opacity: opts.cellFaceOpacity ?? 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const faceMesh = new THREE.Mesh(faceGeom, faceMat);
      faceMesh.renderOrder = 0;
      this.root.add(faceMesh);
    }

    const edges = [
      [0, 1], [0, 2], [0, 3],
      [1, 4], [1, 5],
      [2, 4], [2, 6],
      [3, 5], [3, 6],
      [4, 7], [5, 7], [6, 7],
    ];
    const edgeVerts = [];
    edges.forEach(([i, j]) => {
      const p = corners[i];
      const q = corners[j];
      edgeVerts.push(p.x, p.y, p.z, q.x, q.y, q.z);
    });
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: opts.cellEdgeColor ?? 0x111111,
      transparent: true,
      opacity: opts.cellEdgeOpacity ?? 0.92,
    });
    const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
    edgeLines.renderOrder = 2;
    this.root.add(edgeLines);
  }

  build(poscarData, opts={}) {
    this.clear();
    if (!poscarData) return;
    this.showAxes = opts.showAxes !== false;
    const axesMarginOpt = Number(opts.axesViewportMargin);
    this.axesViewportMargin = Number.isFinite(axesMarginOpt)
      ? Math.max(4, Math.min(40, axesMarginOpt))
      : 22;
    this.scene.background = new THREE.Color(opts.backgroundColor ?? 0xffffff);
    const initialZoom = Math.max(0.1, Number(opts.initialZoom || 1));
    const scale = poscarData.scale || 1.0;
    const a = new THREE.Vector3(...poscarData.lattice.a).multiplyScalar(scale);
    const b = new THREE.Vector3(...poscarData.lattice.b).multiplyScalar(scale);
    const c = new THREE.Vector3(...poscarData.lattice.c).multiplyScalar(scale);
    // cache basis vectors for external use (e.g., field arrow)
    this.aVec = a.clone();
    this.bVec = b.clone();
    this.cVec = c.clone();

    // Options
    const nx = Math.max(1, (opts.supercell && opts.supercell[0]) || 2);
    const ny = Math.max(1, (opts.supercell && opts.supercell[1]) || 2);
    const nz = Math.max(1, (opts.supercell && opts.supercell[2]) || 2);
    const showCell = opts.showCell !== false;
    const showBonds = opts.showBonds ?? true;
    const atomRadiusOpt = Number(opts.atomRadius);
    const atomRadius = Number.isFinite(atomRadiusOpt) ? Math.max(0.05, atomRadiusOpt) : 0.26;
    const boundaryAtomEpsOpt = Number(opts.boundaryAtomEps);
    const boundaryAtomEps = Number.isFinite(boundaryAtomEpsOpt)
      ? Math.max(1e-8, Math.min(0.05, boundaryAtomEpsOpt))
      : 1e-4;
    this.atomMetalness = Number.isFinite(Number(opts.atomMetalness)) ? Math.max(0, Math.min(1, Number(opts.atomMetalness))) : 0.08;
    this.atomRoughness = Number.isFinite(Number(opts.atomRoughness)) ? Math.max(0, Math.min(1, Number(opts.atomRoughness))) : 0.42;
    const bondRadiusOpt = Number(opts.bondRadius);
    this.bondRadius = Number.isFinite(bondRadiusOpt) ? Math.max(0.01, bondRadiusOpt) : 0.06;
    this.bondColor = (opts.bondColor == null) ? 0xbbc0c5 : opts.bondColor;
    const bondFactorOpt = Number(opts.bondFactor);
    this.bondFactor = Number.isFinite(bondFactorOpt) ? Math.max(0.8, bondFactorOpt) : 1.15;
    const bondMaxCutOpt = Number(opts.bondMaxCut);
    this.bondMaxCut = Number.isFinite(bondMaxCutOpt) ? Math.max(1.0, bondMaxCutOpt) : 3.2;
    const bondMetalnessOpt = Number(opts.bondMetalness);
    const bondRoughnessOpt = Number(opts.bondRoughness);
    this.bondMetalness = Number.isFinite(bondMetalnessOpt) ? Math.max(0, Math.min(1, bondMetalnessOpt)) : 0.2;
    this.bondRoughness = Number.isFinite(bondRoughnessOpt) ? Math.max(0, Math.min(1, bondRoughnessOpt)) : 0.6;
    this._bondMaterial = null;

    if (showCell) {
      this._addCellShell(a, b, c, nx, ny, nz, opts);
    }

    // Base Atoms (cartesian positions)
    const isDirect = (poscarData.coordinate_type || 'Direct').toLowerCase().startsWith('direct');
    const baseAtoms = [];
    poscarData.atoms.forEach(atom => {
      const el = atom.element || 'X';
      let p;
      let frac = null;
      if (isDirect) {
        frac = atom.position.map((v) => {
          const n = Number(v) || 0;
          const wrapped = ((n % 1) + 1) % 1;
          return (wrapped < boundaryAtomEps || wrapped > 1 - boundaryAtomEps) ? 0 : wrapped;
        });
        p = a.clone().multiplyScalar(frac[0])
          .add(b.clone().multiplyScalar(frac[1]))
          .add(c.clone().multiplyScalar(frac[2]));
      } else {
        const cart = atom.position.map(v => v * scale);
        p = new THREE.Vector3(cart[0], cart[1], cart[2]);
      }
      baseAtoms.push({ el, pos: p.clone(), frac });
    });

    // Replicate supercell
    const replicated = [];
    const seenReplicated = new Set();
    const pushReplicated = (el, x, y, z) => {
      const key = `${el}:${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
      if (seenReplicated.has(key)) return;
      seenReplicated.add(key);
      const pos = a.clone().multiplyScalar(x)
        .add(b.clone().multiplyScalar(y))
        .add(c.clone().multiplyScalar(z));
      replicated.push({ el, pos });
    };
    const completeBoundaryAtoms = opts.completeBoundaryAtoms !== false && isDirect;
    if (completeBoundaryAtoms) {
      const coordsFor = (n, f) => {
        const vals = [];
        for (let i = 0; i < n; i++) vals.push(i + f);
        if (Math.abs(f) < boundaryAtomEps) vals.push(n);
        return vals;
      };
      for (const at of baseAtoms) {
        const f = at.frac || [0, 0, 0];
        const xs = coordsFor(nx, f[0]);
        const ys = coordsFor(ny, f[1]);
        const zs = coordsFor(nz, f[2]);
        xs.forEach((x) => ys.forEach((y) => zs.forEach((z) => pushReplicated(at.el, x, y, z))));
      }
    } else {
      for (let ix=0; ix<nx; ix++){
        for (let iy=0; iy<ny; iy++){
          for (let iz=0; iz<nz; iz++){
            const shift = a.clone().multiplyScalar(ix)
              .add(b.clone().multiplyScalar(iy))
              .add(c.clone().multiplyScalar(iz));
            for (const at of baseAtoms){
              const pos = at.pos.clone().add(shift);
              replicated.push({ el: at.el, pos });
            }
          }
        }
      }
    }

    // Draw atoms with instancing to reduce draw calls during rotation.
    const atomsByElement = new Map();
    for (const atom of replicated) {
      if (!atomsByElement.has(atom.el)) atomsByElement.set(atom.el, []);
      atomsByElement.get(atom.el).push(atom.pos);
    }
    atomsByElement.forEach((positions, el) => {
      const inst = new THREE.InstancedMesh(
        this._sharedAtomGeometry,
        this._getAtomMaterial(el),
        positions.length
      );
      inst.userData = { element: el };
      this._tmpQuaternion.identity();
      this._tmpScale.set(atomRadius, atomRadius, atomRadius);
      positions.forEach((pos, idx) => {
        this._tmpMatrix.compose(pos, this._tmpQuaternion, this._tmpScale);
        inst.setMatrixAt(idx, this._tmpMatrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      this.groupAtoms.add(inst);
    });

    // Bonds
    if (showBonds){
      this._buildBonds(replicated);
    }

    // Fit camera to scene. Avoid setFromObject() here because InstancedMesh bounds
    // can be unreliable across three.js builds and lead to an over-zoomed camera.
    const box = new THREE.Box3();
    replicated.forEach((atom) => box.expandByPoint(atom.pos));
    if (showCell || opts.showPlanes) {
      const superA = a.clone().multiplyScalar(nx);
      const superB = b.clone().multiplyScalar(ny);
      const superC = c.clone().multiplyScalar(nz);
      [
        new THREE.Vector3(0, 0, 0),
        superA.clone(),
        superB.clone(),
        superC.clone(),
        superA.clone().add(superB),
        superA.clone().add(superC),
        superB.clone().add(superC),
        superA.clone().add(superB).add(superC),
      ].forEach((corner) => box.expandByPoint(corner));
    }
    box.expandByScalar(Math.max(atomRadius * 1.5, (this.bondRadius ?? 0.06) * 2.0));
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const distBase = Math.max(10.0, maxDim * 4.0);
    const dist = distBase;
    const dirVec = new THREE.Vector3(1, 1, 1).normalize();
    const camPos = center.clone().add(dirVec.multiplyScalar(dist));
    this.target.copy(center);
    this.sceneCenter = center.clone();
    this.sceneMaxDim = maxDim;
    if (this.camera?.isOrthographicCamera) {
      this.orthoViewSize = Math.max(1e-6, (maxDim || 1.0) * 1.35 / initialZoom);
      this._updateCameraProjection();
    }
    this.radius = camPos.distanceTo(center);
    this.viewDir.copy(camPos.clone().sub(center).normalize());
    const worldUp = new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(this.viewDir, worldUp);
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    right.normalize();
    this.viewUp.crossVectors(right, this.viewDir).normalize();
    this.camera.position.copy(camPos);
    this.camera.up.copy(this.viewUp);
    this.camera.lookAt(center);
    this.camera.near = Math.max(0.01, maxDim / 100);
    this.camera.far = Math.max(1000, distBase * 10);
    this.camera.updateProjectionMatrix();

    // Axes gizmo at origin (0,0,0), aligned with lattice vectors a/b/c when available
    this._rebuildAxes(new THREE.Vector3(0,0,0), maxDim || 1.0);
    // reset field arrow if any
    this.setFieldDirection(null);
  }
}

window.CrystalViewer = CrystalViewer;

// Covalent radii table and bonds helpers
CrystalViewer.COVALENT_RADII = {
  H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07,
  S: 1.05, Cl: 1.02, K: 2.03, Ca: 1.76, Sc: 1.70,
  Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32,
  Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22,
  Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Rb: 2.16,
  Sr: 1.95, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54,
  Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45,
  Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38,
  I: 1.39, Cs: 2.35, Ba: 1.98, La: 1.95, Ce: 1.85,
  Pr: 1.85, Nd: 1.85, Sm: 1.81, Eu: 1.98, Gd: 1.80,
  Tb: 1.80, Dy: 1.80, Ho: 1.80, Er: 1.80, Tm: 1.80,
  Yb: 1.94, Lu: 1.75, Hf: 1.70, Ta: 1.62, W: 1.51,
  Re: 1.44, Os: 1.41, Ir: 1.36, Pt: 1.36, Au: 1.36,
  Hg: 1.32, Tl: 1.45, Pb: 1.46, Bi: 1.48
};

CrystalViewer.prototype._bondThreshold = function(el1, el2){
  const r1 = CrystalViewer.COVALENT_RADII[el1] ?? 1.2;
  const r2 = CrystalViewer.COVALENT_RADII[el2] ?? 1.2;
  const factor = Number.isFinite(this.bondFactor) ? this.bondFactor : 1.15; // tolerance
  const maxCut = Number.isFinite(this.bondMaxCut) ? this.bondMaxCut : 3.2;
  return Math.min(maxCut, factor * (r1 + r2));
}

CrystalViewer.prototype._buildBonds = function(repl){
  const bonds = [];
  const n = repl.length;
  for (let i=0;i<n;i++){
    const ai = repl[i];
    for (let j=i+1;j<n;j++){
      const aj = repl[j];
      const cutoff = this._bondThreshold(ai.el, aj.el);
      const d = ai.pos.distanceTo(aj.pos);
      if (d > 0.2 && d <= cutoff){
        bonds.push([ai.pos, aj.pos]);
      }
    }
  }
  if (!bonds.length) return;
  const mesh = new THREE.InstancedMesh(
    this._sharedBondGeometry,
    this._getBondMaterial(),
    bonds.length
  );
  bonds.forEach(([p1, p2], idx) => {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    this._tmpQuaternion.setFromUnitVectors(this._unitY, dir.normalize());
    this._tmpScale.set(this.bondRadius ?? 0.06, len, this.bondRadius ?? 0.06);
    this._tmpMatrix.compose(mid, this._tmpQuaternion, this._tmpScale);
    mesh.setMatrixAt(idx, this._tmpMatrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  this.groupBonds.add(mesh);
}

// Field direction helpers
CrystalViewer.prototype.setFieldDirection = function(dirVec){
  // Clear existing
  while (this.groupField.children.length) {
    const obj = this.groupField.children.pop();
    if (obj) this.groupField.remove(obj);
  }
  // B arrow disabled intentionally
  return;
}

CrystalViewer.prototype.setFieldFromAngles = function(surface, thetaDeg, phiDeg){
  // derive unit basis along a,b,c
  const a = (this.aVec && this.aVec.clone()) || new THREE.Vector3(1,0,0);
  const b = (this.bVec && this.bVec.clone()) || new THREE.Vector3(0,1,0);
  const c = (this.cVec && this.cVec.clone()) || new THREE.Vector3(0,0,1);
  const na = a.clone().normalize();
  const nb = b.clone().normalize();
  const nc = c.clone().normalize();
  const th = (thetaDeg || 0) * Math.PI / 180.0;
  const ph = (phiDeg || 0) * Math.PI / 180.0;
  const sinTheta = Math.sin(th);
  const dir = na.clone().multiplyScalar(sinTheta * Math.cos(ph))
    .add(nb.clone().multiplyScalar(sinTheta * Math.sin(ph)))
    .add(nc.clone().multiplyScalar(Math.cos(th)))
    .normalize();
  this.setFieldDirection(dir);
}

CrystalViewer.prototype.clearMrOverlay = function(){
  if (!this.groupMrOverlay) return;
  while (this.groupMrOverlay.children.length) {
    const obj = this.groupMrOverlay.children.pop();
    if (!obj) continue;
    this.groupMrOverlay.remove(obj);
    if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
    if (obj.material && typeof obj.material.dispose === 'function') obj.material.dispose();
  }
}

CrystalViewer.prototype._makeMrAngleLabelSprite = function(text, color = '#ef4444'){
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '900 76px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(15,23,42,0.45)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.26;
  sprite.scale.set((canvas.width / 100) * scale, (canvas.height / 100) * scale, 1);
  sprite.renderOrder = 30;
  return sprite;
}

CrystalViewer.prototype.setMrPlaneAndFields = function(surface, fields){
  this.clearMrOverlay();
  if (!this.aVec || !this.bVec || !this.cVec || !this.groupMrOverlay) return;

  const a = this.aVec.clone();
  const b = this.bVec.clone();
  const c = this.cVec.clone();
  const na = a.clone().normalize();
  const nb = b.clone().normalize();
  const nc = c.clone().normalize();
  const center = a.clone().add(b).add(c).multiplyScalar(0.5);

  let e1Vec = a.clone();
  let e2Vec = b.clone();
  let offset = c.clone().multiplyScalar(0.5);
  let e1Dir = na;
  let e2Dir = nb;
  if (surface === 'Rb_Rc_surface') {
    e1Vec = b.clone();
    e2Vec = c.clone();
    offset = a.clone().multiplyScalar(0.5);
    e1Dir = nb;
    e2Dir = nc;
  } else if (surface === 'Rc_Ra_surface') {
    e1Vec = c.clone();
    e2Vec = a.clone();
    offset = b.clone().multiplyScalar(0.5);
    e1Dir = nc;
    e2Dir = na;
  }

  const p0 = offset;
  const p1 = offset.clone().add(e1Vec);
  const p2 = offset.clone().add(e1Vec).add(e2Vec);
  const p3 = offset.clone().add(e2Vec);
  const verts = [
    p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
    p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
  ];
  const planeGeom = new THREE.BufferGeometry();
  planeGeom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  planeGeom.computeVertexNormals();
  const planeMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const planeMesh = new THREE.Mesh(planeGeom, planeMat);
  planeMesh.renderOrder = 5;
  this.groupMrOverlay.add(planeMesh);

  const edgeVerts = [
    p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
    p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
    p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
    p3.x, p3.y, p3.z, p0.x, p0.y, p0.z,
  ];
  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.95 });
  const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
  edgeLines.renderOrder = 6;
  this.groupMrOverlay.add(edgeLines);

  const normal = new THREE.Vector3().crossVectors(e1Dir, e2Dir).normalize();
  const axis0 = e1Vec.clone().normalize();
  let axis90 = e2Vec.clone().sub(axis0.clone().multiplyScalar(e2Vec.dot(axis0)));
  if (axis90.lengthSq() < 1e-12) axis90 = new THREE.Vector3().crossVectors(normal, axis0);
  axis90.normalize();
  const planeSpan = Math.min(e1Vec.length(), e2Vec.length());
  const arrowLen = Math.max(0.8, planeSpan * 0.55);
  const normalizedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];
  const toHex = (color, fallback) => {
    if (typeof color === 'number' && Number.isFinite(color)) return color;
    if (typeof color === 'string') {
      const hex = color.trim().replace(/^#/, '');
      const parsed = parseInt(hex, 16);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  };
  const toCssColor = (hex) => `#${(hex >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  const fmtAngle = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n - Math.round(n)) < 1e-6 ? n.toFixed(0) : n.toFixed(1)}°`;
  };

  normalizedFields.forEach((field, idx) => {
    const th = (Number(field.theta) || 0) * Math.PI / 180;
    const ph = (Number(field.phi) || 0) * Math.PI / 180;
    let dir;
    if (Number.isFinite(Number(field.angleDeg))) {
      const angle = Number(field.angleDeg) * Math.PI / 180;
      dir = axis0.clone().multiplyScalar(Math.cos(angle))
        .add(axis90.clone().multiplyScalar(Math.sin(angle)))
        .normalize();
    } else {
      const sinTheta = Math.sin(th);
      dir = na.clone().multiplyScalar(sinTheta * Math.cos(ph))
        .add(nb.clone().multiplyScalar(sinTheta * Math.sin(ph)))
        .add(nc.clone().multiplyScalar(Math.cos(th)))
        .normalize();
    }
    if (dir.lengthSq() < 1e-12) return;

    const arrowOrigin = center.clone()
      .add(dir.clone().multiplyScalar(-arrowLen * 0.5));
    const arrowColor = toHex(field.color, 0xef4444);
    const arrow = new THREE.ArrowHelper(
      dir,
      arrowOrigin,
      arrowLen,
      arrowColor,
      arrowLen * 0.24,
      arrowLen * 0.08
    );
    arrow.renderOrder = 8 + idx;
    arrow.traverse((obj) => {
      if (obj.material) {
        obj.material.depthTest = false;
        obj.material.depthWrite = false;
        obj.material.transparent = true;
        obj.material.opacity = 0.98;
      }
    });
    this.groupMrOverlay.add(arrow);

    const labelText = fmtAngle(field.angleDeg) || String(field.label || '');
    if (labelText) {
      const label = this._makeMrAngleLabelSprite(labelText, toCssColor(arrowColor));
      label.position.copy(center.clone().add(dir.clone().multiplyScalar(arrowLen * 0.72)));
      label.renderOrder = 40 + idx;
      this.groupMrOverlay.add(label);
    }
  });
}

CrystalViewer.prototype.setMrPlaneAndField = function(surface, thetaDeg, phiDeg, color){
  this.setMrPlaneAndFields(surface, [{ theta: thetaDeg, phi: phiDeg, color }]);
}
