import * as THREE from "/static/vendor/three/build/three.module.js";
import { OrbitControls } from "/static/vendor/three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "/static/vendor/three/examples/jsm/loaders/GLTFLoader.js";

const state = {
  config: null,
  objects: [],
  selectedIndex: null,
  mapImage: null,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetZ: 0,
  three: {
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    objectRoot: null,
    loader: new GLTFLoader(),
    modelCache: new Map(),
  },
};

const el = {
  canvas: document.getElementById("mapCanvas"),
  threeViewport: document.getElementById("threeViewport"),
  statusBar: document.getElementById("statusBar"),
  assetSelect: document.getElementById("assetSelect"),
  defaultType: document.getElementById("defaultType"),
  objectList: document.getElementById("objectList"),
  addCenterBtn: document.getElementById("addCenterBtn"),
  saveBtn: document.getElementById("saveBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  duplicateBtn: document.getElementById("duplicateBtn"),
  applyBtn: document.getElementById("applyBtn"),
  name: document.getElementById("name"),
  id: document.getElementById("id"),
  type: document.getElementById("type"),
  x: document.getElementById("x"),
  y: document.getElementById("y"),
  z: document.getElementById("z"),
  rotY: document.getElementById("rotY"),
  scaleX: document.getElementById("scaleX"),
  scaleY: document.getElementById("scaleY"),
  scaleZ: document.getElementById("scaleZ"),
  speed: document.getElementById("speed"),
  respawn: document.getElementById("respawn"),
  moveType: document.getElementById("moveType"),
  isActive: document.getElementById("isActive"),
};

const ctx = el.canvas.getContext("2d");

function objectColor(obj) {
  const name = String(obj.name || "").toLowerCase();
  if (obj.type === "checkpoint" || name.includes("checkpoint")) return "#33c3ff";
  if (name.includes("trafficlight")) return "#ff5a5a";
  if (name.includes("trafficrect")) return "#ffb347";
  if (obj.type === "dynamic") return "#ffd34d";
  return "#7be081";
}

function toCanvas(worldX, worldZ) {
  const x = (worldX / state.config.mapSizeX) * el.canvas.width;
  const y = (worldZ / state.config.mapSizeZ) * el.canvas.height;
  return [x, y];
}

function toWorld(canvasX, canvasY) {
  const x = Math.max(0, Math.min(state.config.mapSizeX, (canvasX / el.canvas.width) * state.config.mapSizeX));
  const z = Math.max(0, Math.min(state.config.mapSizeZ, (canvasY / el.canvas.height) * state.config.mapSizeZ));
  return [x, z];
}

function nextObjectId() {
  const used = new Set(state.objects.map((obj) => Number(obj.ID) || 0));
  let next = 1000;
  while (used.has(next)) {
    next += 1;
  }
  return next;
}

function nextCheckpointName() {
  const indexes = [];
  for (const obj of state.objects) {
    const n = String(obj.name || "").toLowerCase();
    if ((obj.type || "") === "checkpoint" || n.includes("checkpoint")) {
      const parts = n.split("_");
      const idx = Number(parts[parts.length - 1]);
      indexes.push(Number.isFinite(idx) ? idx : 0);
    }
  }
  return `Checkpoint_${indexes.length ? Math.max(...indexes) + 1 : 0}`;
}

function refreshObjectList() {
  el.objectList.innerHTML = "";
  state.objects.forEach((obj, idx) => {
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = `[${obj.ID}] ${obj.name} (${obj.type}) x=${Number(obj.position.x).toFixed(2)} z=${Number(obj.position.z).toFixed(2)}`;
    if (idx === state.selectedIndex) option.selected = true;
    el.objectList.appendChild(option);
  });
}

function setSelection(idx) {
  if (idx == null || idx < 0 || idx >= state.objects.length) {
    state.selectedIndex = null;
    redraw2d();
    sync3dScene();
    return;
  }
  state.selectedIndex = idx;
  const obj = state.objects[idx];

  el.name.value = obj.name;
  el.id.value = obj.ID;
  el.type.value = obj.type;
  el.x.value = Number(obj.position.x).toFixed(3);
  el.y.value = Number(obj.position.y).toFixed(3);
  el.z.value = Number(obj.position.z).toFixed(3);
  el.rotY.value = Number(obj.rotation.y).toFixed(3);
  el.scaleX.value = Number(obj.scale.x).toFixed(3);
  el.scaleY.value = Number(obj.scale.y).toFixed(3);
  el.scaleZ.value = Number(obj.scale.z).toFixed(3);
  el.speed.value = Number(obj.speed).toFixed(3);
  el.respawn.value = Number(obj.respawnTime).toFixed(3);
  el.moveType.value = obj.moveType || "None";
  el.isActive.checked = Boolean(obj.isActive);

  refreshObjectList();
  redraw2d();
  sync3dScene();
}

function createObject(worldX, worldZ) {
  const asset = el.assetSelect.value;
  let objectType = el.defaultType.value;
  let name = asset;

  if (asset === "checkpoint") {
    objectType = "checkpoint";
    name = nextCheckpointName();
  } else if (asset === "trafficlight" || asset === "trafficrect") {
    objectType = "static";
    name = asset;
  }

  const d = state.config.defaultScales[asset] || [0.1, 0.1, 0.1];
  return {
    name,
    type: objectType,
    ID: nextObjectId(),
    position: { x: worldX, y: objectType === "checkpoint" ? 0.145 : 0, z: worldZ },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: d[0], y: d[1], z: d[2] },
    isActive: true,
    startTime: 0,
    moveType: "None",
    movePoints: [],
    speed: objectType === "checkpoint" ? 0 : 5,
    respawnTime: objectType === "checkpoint" ? 0 : 5,
  };
}

function hitTest(x, y) {
  let best = null;
  let bestDist = 14 * 14;
  state.objects.forEach((obj, idx) => {
    const [ox, oy] = toCanvas(Number(obj.position.x), Number(obj.position.z));
    const dx = ox - x;
    const dy = oy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestDist) {
      best = idx;
      bestDist = d2;
    }
  });
  return best;
}

function applyPropertyChanges() {
  if (state.selectedIndex == null) return;
  const obj = state.objects[state.selectedIndex];
  obj.name = el.name.value || obj.name;
  obj.type = el.type.value || obj.type;
  obj.ID = Number(el.id.value) || obj.ID;
  obj.position.x = Math.max(0, Math.min(state.config.mapSizeX, Number(el.x.value) || obj.position.x));
  obj.position.y = Number(el.y.value) || obj.position.y;
  obj.position.z = Math.max(0, Math.min(state.config.mapSizeZ, Number(el.z.value) || obj.position.z));
  obj.rotation.y = Number(el.rotY.value) || obj.rotation.y;
  obj.scale.x = Number(el.scaleX.value) || obj.scale.x;
  obj.scale.y = Number(el.scaleY.value) || obj.scale.y;
  obj.scale.z = Number(el.scaleZ.value) || obj.scale.z;
  obj.speed = Number(el.speed.value) || obj.speed;
  obj.respawnTime = Number(el.respawn.value) || obj.respawnTime;
  obj.moveType = el.moveType.value || "None";
  obj.isActive = Boolean(el.isActive.checked);

  if (obj.type === "checkpoint" && !String(obj.name).toLowerCase().includes("checkpoint")) {
    obj.name = nextCheckpointName();
    el.name.value = obj.name;
  }

  refreshObjectList();
  redraw2d();
  sync3dScene();
}

async function saveObjects() {
  const response = await fetch("/api/objects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objects: state.objects }),
  });
  if (!response.ok) {
    throw new Error("save failed");
  }
}

function resizeCanvasToDisplaySize() {
  const rect = el.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (el.canvas.width !== width || el.canvas.height !== height) {
    el.canvas.width = width;
    el.canvas.height = height;
  }
}

function redraw2d() {
  resizeCanvasToDisplaySize();
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

  if (state.mapImage) {
    ctx.drawImage(state.mapImage, 0, 0, el.canvas.width, el.canvas.height);
  } else {
    ctx.fillStyle = "#22303a";
    ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
  }

  ctx.strokeStyle = "#36424d";
  for (let i = 0; i < 9; i += 1) {
    const x = (i / 8) * el.canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, el.canvas.height);
    ctx.stroke();
  }
  for (let i = 0; i < 11; i += 1) {
    const y = (i / 10) * el.canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(el.canvas.width, y);
    ctx.stroke();
  }

  state.objects.forEach((obj, idx) => {
    const [cx, cy] = toCanvas(Number(obj.position.x), Number(obj.position.z));
    const selected = idx === state.selectedIndex;
    const radius = selected ? 8 : 6;

    ctx.fillStyle = objectColor(obj);
    ctx.strokeStyle = selected ? "#ffffff" : "#10202c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const rotY = Number(obj.rotation.y) || 0;
    const lineLen = 18;
    const tx = cx + lineLen * Math.sin((rotY * Math.PI) / 180);
    const ty = cy - lineLen * Math.cos((rotY * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    ctx.fillStyle = "#f3f6fa";
    ctx.font = "12px Segoe UI";
    ctx.fillText(String(obj.name || ""), cx + 10, cy - 8);
  });

  const selectedName = state.selectedIndex == null ? "None" : state.objects[state.selectedIndex]?.name || "None";
  el.statusBar.textContent = `Objects ${state.objects.length} | Selected ${selectedName} | 2D+3D synced`;
}

function initThree() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(el.threeViewport.clientWidth, el.threeViewport.clientHeight);
  el.threeViewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11181f);

  const camera = new THREE.PerspectiveCamera(50, el.threeViewport.clientWidth / Math.max(1, el.threeViewport.clientHeight), 0.01, 120);
  camera.position.set(state.config.mapSizeX * 1.2, 2.9, state.config.mapSizeZ * 1.1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(state.config.mapSizeX * 0.5, 0.0, -state.config.mapSizeZ * 0.5);
  controls.enableDamping = true;

  const hemi = new THREE.HemisphereLight(0xd8f2ff, 0x1b2f3d, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(4, 6, 5);
  scene.add(key);

  const grid = new THREE.GridHelper(Math.max(state.config.mapSizeX, state.config.mapSizeZ) * 2.2, 20, 0x3c6075, 0x2a3e4d);
  scene.add(grid);

  const objectRoot = new THREE.Group();
  scene.add(objectRoot);

  state.three.renderer = renderer;
  state.three.scene = scene;
  state.three.camera = camera;
  state.three.controls = controls;
  state.three.objectRoot = objectRoot;

  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(
    "/api/map-image",
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(state.config.mapSizeX, state.config.mapSizeZ),
        new THREE.MeshStandardMaterial({ map: texture, roughness: 1.0, metalness: 0.0 })
      );
      plane.rotation.x = -Math.PI * 0.5;
      plane.position.set(state.config.mapSizeX * 0.5, -0.001, -state.config.mapSizeZ * 0.5);
      scene.add(plane);
    },
    undefined,
    () => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(state.config.mapSizeX, state.config.mapSizeZ),
        new THREE.MeshStandardMaterial({ color: 0x2a3945, roughness: 1.0 })
      );
      plane.rotation.x = -Math.PI * 0.5;
      plane.position.set(state.config.mapSizeX * 0.5, -0.001, -state.config.mapSizeZ * 0.5);
      scene.add(plane);
    }
  );

  const animate = () => {
    requestAnimationFrame(animate);
    state.three.controls.update();
    state.three.renderer.render(state.three.scene, state.three.camera);
  };
  animate();

  window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize();
    redraw2d();
    const width = Math.max(1, el.threeViewport.clientWidth);
    const height = Math.max(1, el.threeViewport.clientHeight);
    state.three.camera.aspect = width / height;
    state.three.camera.updateProjectionMatrix();
    state.three.renderer.setSize(width, height);
  });
}

function createFallbackMesh(obj, selected) {
  const color = selected ? "#ffffff" : objectColor(obj);
  const geometry = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const material = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(geometry, material);
}

function cloneOrFallback(obj, selected) {
  const name = String(obj.name || "");
  if (name === "trafficlight") {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.25, 12),
      new THREE.MeshStandardMaterial({ color: selected ? 0xffffff : 0xff5a5a })
    );
  }
  if (name === "trafficrect") {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.12, 0.08),
      new THREE.MeshStandardMaterial({ color: selected ? 0xffffff : 0xffb347 })
    );
  }
  if (obj.type === "checkpoint" || name.toLowerCase().includes("checkpoint")) {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.09, 0.25),
      new THREE.MeshStandardMaterial({ color: selected ? 0xffffff : 0x33c3ff, transparent: true, opacity: 0.75 })
    );
  }

  if (!name.toLowerCase().endsWith(".glb")) {
    return createFallbackMesh(obj, selected);
  }

  const cache = state.three.modelCache.get(name);
  if (!cache) {
    state.three.modelCache.set(name, { status: "loading", root: null });
    state.three.loader.load(
      `${state.config.modelBaseUrl}/${encodeURIComponent(name)}`,
      (gltf) => {
        state.three.modelCache.set(name, { status: "ready", root: gltf.scene });
      },
      undefined,
      () => {
        state.three.modelCache.set(name, { status: "error", root: null });
      }
    );
    return createFallbackMesh(obj, selected);
  }

  if (cache.status !== "ready" || !cache.root) {
    return createFallbackMesh(obj, selected);
  }

  const clone = cache.root.clone(true);
  if (selected) {
    clone.traverse((node) => {
      if (node.isMesh && node.material) {
        node.material = node.material.clone();
        node.material.emissive = new THREE.Color(0xffffff);
        node.material.emissiveIntensity = 0.15;
      }
    });
  }
  return clone;
}

function sync3dScene() {
  if (!state.three.objectRoot) {
    return;
  }

  while (state.three.objectRoot.children.length > 0) {
    const child = state.three.objectRoot.children.pop();
    state.three.objectRoot.remove(child);
  }

  state.objects.forEach((obj, idx) => {
    const selected = idx === state.selectedIndex;
    const root = new THREE.Group();
    root.add(cloneOrFallback(obj, selected));

    const scaleX = Number(obj.scale?.x ?? 1);
    const scaleY = Number(obj.scale?.y ?? 1);
    const scaleZ = Number(obj.scale?.z ?? 1);
    const x = Number(obj.position?.x ?? 0);
    const y = Number(obj.position?.y ?? 0);
    const z = Number(obj.position?.z ?? 0);
    const rotY = Number(obj.rotation?.y ?? 0);

    root.position.set(x, y, state.config.zFlip ? -z : z);
    root.rotation.y = THREE.MathUtils.degToRad(state.config.zFlip ? -rotY : rotY);
    root.scale.set(scaleX, scaleY, scaleZ);
    state.three.objectRoot.add(root);
  });
}

function bindEvents() {
  el.objectList.addEventListener("change", () => {
    const idx = Number(el.objectList.value);
    setSelection(Number.isFinite(idx) ? idx : null);
  });

  el.addCenterBtn.addEventListener("click", () => {
    const obj = createObject(state.config.mapSizeX * 0.5, state.config.mapSizeZ * 0.5);
    state.objects.push(obj);
    state.selectedIndex = state.objects.length - 1;
    refreshObjectList();
    setSelection(state.selectedIndex);
  });

  el.deleteBtn.addEventListener("click", () => {
    if (state.selectedIndex == null) return;
    state.objects.splice(state.selectedIndex, 1);
    state.selectedIndex = null;
    refreshObjectList();
    redraw2d();
    sync3dScene();
  });

  el.duplicateBtn.addEventListener("click", () => {
    if (state.selectedIndex == null) return;
    const src = JSON.parse(JSON.stringify(state.objects[state.selectedIndex]));
    src.ID = nextObjectId();
    src.position.x = Math.min(state.config.mapSizeX, Number(src.position.x) + 0.12);
    src.position.z = Math.min(state.config.mapSizeZ, Number(src.position.z) + 0.12);
    if (src.type === "checkpoint") src.name = nextCheckpointName();
    state.objects.push(src);
    state.selectedIndex = state.objects.length - 1;
    refreshObjectList();
    setSelection(state.selectedIndex);
  });

  el.applyBtn.addEventListener("click", applyPropertyChanges);

  el.saveBtn.addEventListener("click", async () => {
    try {
      await saveObjects();
      el.statusBar.textContent = `Saved ${state.objects.length} objects.`;
    } catch (_err) {
      el.statusBar.textContent = "Save failed.";
    }
  });

  el.canvas.addEventListener("mousedown", (event) => {
    const rect = el.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * el.canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * el.canvas.height;

    const hit = hitTest(x, y);
    if (hit != null) {
      setSelection(hit);
      const [wx, wz] = toWorld(x, y);
      const obj = state.objects[hit];
      state.dragging = true;
      state.dragOffsetX = Number(obj.position.x) - wx;
      state.dragOffsetZ = Number(obj.position.z) - wz;
      return;
    }

    const [wx, wz] = toWorld(x, y);
    const obj = createObject(wx, wz);
    state.objects.push(obj);
    state.selectedIndex = state.objects.length - 1;
    refreshObjectList();
    setSelection(state.selectedIndex);
  });

  window.addEventListener("mouseup", () => {
    state.dragging = false;
  });

  el.canvas.addEventListener("mousemove", (event) => {
    if (!state.dragging || state.selectedIndex == null) return;
    const rect = el.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * el.canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * el.canvas.height;
    const [wx, wz] = toWorld(x, y);
    const obj = state.objects[state.selectedIndex];
    obj.position.x = Math.max(0, Math.min(state.config.mapSizeX, wx + state.dragOffsetX));
    obj.position.z = Math.max(0, Math.min(state.config.mapSizeZ, wz + state.dragOffsetZ));
    setSelection(state.selectedIndex);
  });
}

async function bootstrap() {
  const [cfgRes, objRes] = await Promise.all([fetch("/api/config"), fetch("/api/objects")]);
  state.config = await cfgRes.json();
  const objPayload = await objRes.json();
  state.objects = objPayload.objects || [];

  el.assetSelect.innerHTML = "";
  for (const asset of state.config.assets) {
    const option = document.createElement("option");
    option.value = asset;
    option.textContent = asset;
    el.assetSelect.appendChild(option);
  }

  const image = new Image();
  image.onload = () => {
    state.mapImage = image;
    redraw2d();
  };
  image.onerror = () => {
    state.mapImage = null;
    redraw2d();
  };
  image.src = "/api/map-image";

  initThree();
  bindEvents();
  refreshObjectList();
  redraw2d();
  sync3dScene();
}

bootstrap().catch((err) => {
  console.error(err);
  el.statusBar.textContent = "Startup failed.";
});
