import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Prim3, Scene3DSpec, Vec3 } from "./types";

/*
 * The interpreter that owns three.js. The director never reaches this: it hands us a Scene3DSpec
 * (data only), and this file is the sole place a WebGL context is made. That keeps the project's
 * no-JS-sandbox rule true for 3-D too — a model can describe a solid, it cannot run code.
 *
 * The window has its own local coordinate space, unrelated to the 2-D plane's world units; the flat
 * stage camera frames the whole box as usual, and this camera only looks inside the box. Auto-framing
 * from the primitives' bounding sphere means a terse spec and a verbose one both fill the window.
 */

const D2R = Math.PI / 180;
const FOG_COLOR = "#0a0910";
const DEFAULT_COLOR = "#e8e6f0";

const v3 = (p?: Vec3): [number, number, number] => (p ? [p[0], p[1], p[2]] : [0, 0, 0]);

function material(color: string | undefined, opacity: number | undefined, wire: boolean | undefined): THREE.Material {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color ?? DEFAULT_COLOR),
    roughness: 0.55,
    metalness: 0.12,
    wireframe: !!wire,
  });
  if (opacity !== undefined && opacity < 1) {
    m.transparent = true;
    m.opacity = opacity;
  }
  return m;
}

/** A flat label on a canvas-textured sprite — the only text a 3-D window draws, and it stays glued to its solid. */
function labelSprite(text: string, radius: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const px = 128;
  canvas.width = px * 3;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `600 ${Math.round(px * 0.6)}px system-ui, "PingFang SC", sans-serif`;
  ctx.fillStyle = DEFAULT_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 12;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(radius * 1.5, radius * 0.5, 1);
  return sprite;
}

function makeArrow(from: Vec3, to: Vec3, color: string | undefined, radius: number | undefined): THREE.Group {
  const g = new THREE.Group();
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-4) return g;
  dir.normalize();
  const shaftR = Math.max(radius ?? len * 0.04, len * 0.01);
  const headLen = Math.min(len * 0.28, len * 0.9);
  const shaftLen = len - headLen;
  const headR = Math.max(shaftR * 2.4, headLen * 0.36);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 20), material(color, undefined, undefined));
  shaft.quaternion.copy(quat);
  shaft.position.copy(a.clone().add(dir.clone().multiplyScalar(shaftLen / 2)));
  const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 24), material(color, undefined, undefined));
  head.quaternion.copy(quat);
  head.position.copy(a.clone().add(dir.clone().multiplyScalar(shaftLen + headLen / 2)));
  g.add(shaft, head);
  return g;
}

/** One primitive → an Object3D, or null when the shape needs endpoints it wasn't given. */
function buildPrim(p: Prim3): THREE.Object3D | null {
  const mat = () => material(p.color, p.opacity, p.wireframe);
  const size = p.size ?? 2;
  let obj: THREE.Object3D | null = null;
  switch (p.shape) {
    case "box":
      obj = new THREE.Mesh(new THREE.BoxGeometry(size, p.height ?? size, p.radius2 ?? size), mat());
      break;
    case "sphere":
      obj = new THREE.Mesh(new THREE.SphereGeometry(p.radius ?? size / 2, 32, 24), mat());
      break;
    case "cylinder":
      obj = new THREE.Mesh(new THREE.CylinderGeometry(p.radius2 ?? p.radius ?? 1, p.radius ?? 1, p.height ?? size, 32), mat());
      break;
    case "cone":
      obj = new THREE.Mesh(new THREE.ConeGeometry(p.radius ?? size / 2, p.height ?? size, 32), mat());
      break;
    case "torus":
      obj = new THREE.Mesh(new THREE.TorusGeometry(p.radius ?? 1.5, p.radius2 ?? (p.radius ?? 1.5) * 0.3, 20, 48), mat());
      break;
    case "plane": {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, p.height ?? size * 2), material(p.color, p.opacity, p.wireframe));
      (m.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      obj = m;
      break;
    }
    case "line": {
      if (!p.from || !p.to) return null;
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p.from), new THREE.Vector3(...p.to)]);
      obj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(p.color ?? DEFAULT_COLOR) }));
      break;
    }
    case "arrow": {
      if (!p.from || !p.to) return null;
      obj = makeArrow(p.from, p.to, p.color, p.radius);
      break;
    }
    default:
      return null;
  }
  const pos = v3(p.pos);
  // line/arrow carry their own endpoints; only translate the whole thing when pos is also given.
  if (p.shape !== "line" && p.shape !== "arrow") obj.position.set(pos[0], pos[1], pos[2]);
  else if (p.pos) obj.position.set(...v3(p.pos));
  if (p.rot) obj.rotation.set(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R);
  if (p.label) {
    const anchor = p.shape === "line" || p.shape === "arrow" ? new THREE.Vector3(...pos) : new THREE.Vector3(0, (p.radius ?? size / 2) + 0.4, 0);
    const s = labelSprite(p.label, Math.max(p.radius ?? size / 2, 0.6));
    s.position.copy(anchor);
    obj.add(s);
  }
  return obj;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    const list = Array.isArray(m) ? m : m ? [m] : [];
    for (const one of list) {
      const sm = one as THREE.SpriteMaterial;
      if (sm.map) sm.map.dispose();
      one.dispose();
    }
  });
}

interface Handles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  controls: OrbitControls;
  helpers: THREE.Object3D[];
  render: () => void;
}

export function Scene3D({ spec, t }: { spec: Scene3DSpec; t: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const hRef = useRef<Handles | null>(null);
  const geomKey = JSON.stringify({ p: spec.prims, c: spec.camera, g: spec.grid, a: spec.axes, b: spec.background });

  // Context + camera + lights live exactly once per mounted window; the WebGL context is the scarce
  // thing here, so it is torn down on unmount rather than recreated when the art changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // no WebGL on this machine — leave the (empty) box rather than crash the board
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(6, 10, 8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
    rim.position.set(-7, -4, -6);
    scene.add(rim);

    const group = new THREE.Group();
    scene.add(group);

    const render = () => renderer.render(scene, camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false; // no persistent rAF: we only want to redraw on an actual drag
    controls.enabled = false;
    controls.addEventListener("change", render);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(host);

    hRef.current = { renderer, scene, camera, group, controls, helpers: [], render };
    return () => {
      ro.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      hRef.current = null;
    };
  }, []);

  // Rebuild solids whenever the geometry changes (a draw() that swaps the 3-D art re-runs this).
  useEffect(() => {
    const h = hRef.current;
    if (!h) return;
    disposeTree(h.group);
    h.group.clear();
    for (const old of h.helpers) {
      disposeTree(old);
      h.scene.remove(old);
    }
    h.helpers = [];

    for (const prim of spec.prims) {
      const o = buildPrim(prim);
      if (o) h.group.add(o);
    }

    const box = new THREE.Box3().setFromObject(h.group);
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 2) : box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center;
    const r = Math.max(sphere.radius, 0.5);

    if (spec.grid) {
      const g = new THREE.GridHelper(r * 4, 16, 0x444066, 0x241f38);
      g.position.y = center.y - r;
      h.scene.add(g);
      h.helpers.push(g);
    }
    if (spec.axes) {
      const a = new THREE.AxesHelper(r * 1.4);
      a.position.copy(center);
      h.scene.add(a);
      h.helpers.push(a);
    }

    if (spec.camera?.pos) h.camera.position.set(...v3(spec.camera.pos));
    else h.camera.position.set(center.x + r, center.y + r * 0.8, center.z + r * 1.7);
    const look = spec.camera?.look ? new THREE.Vector3(...v3(spec.camera.look)) : center.clone();
    h.camera.lookAt(look);
    h.controls.target.copy(look);
    if (spec.camera?.fov) h.camera.fov = spec.camera.fov;
    h.camera.near = Math.max(r / 100, 0.01);
    h.camera.far = r * 60 + 20;
    h.camera.updateProjectionMatrix();

    if (spec.background) h.renderer.setClearColor(new THREE.Color(spec.background), 1);
    else h.renderer.setClearColor(FOG_COLOR, 0); // transparent: the board's glow shows through the window

    h.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomKey]);

  // Self-rotation is a pure function of stage time, so rewinding / re-performing lands identically.
  // spinKey collapses "absent" vs "empty object" so a draw() that adds a spin actually re-runs the effect.
  const spin = spec.spin;
  const spinKey = spin ? `${spin.axis ?? "y"}:${spin.degPerSec ?? 24}` : "";
  useEffect(() => {
    const h = hRef.current;
    if (!h) return;
    if (spinKey) {
      const [axis, deg] = spinKey.split(":");
      const rad = (t / 1000) * Number(deg) * D2R;
      h.group.rotation.set(axis === "x" ? rad : 0, axis === "y" ? rad : 0, axis === "z" ? rad : 0);
    } else {
      h.group.rotation.set(0, 0, 0);
    }
    h.render();
  }, [t, spinKey]);

  // Drag-to-orbit is opt-in and lives outside the log: enable the controls, but never leave them on
  // when a later prop reuses this window without the flag.
  useEffect(() => {
    const h = hRef.current;
    if (!h) return;
    h.controls.enabled = !!spec.interactive;
    h.render();
  }, [spec.interactive]);

  return <div ref={hostRef} className="scene3d" />;
}
