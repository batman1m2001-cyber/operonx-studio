/* operonx studio — the Factory picture: a project as one lit isometric model (SPATIAL_FACTORY_PLAN F3).
 *
 * Everything drawn is the factory model (factorymodel.js), nothing else:
 *   core      the shared blocks (silver) and the resources flows name (glass enclosures)
 *   cluster   one flow, a part per op — or, past 30 flows, one domain, a part per flow
 *   door      a small part on a cluster's outer edge: a service, or a job
 *   cable     up to three strands per kind of link from a cluster to the core, laid side by side
 * The parts are machined titanium; colour is only ever a small light (the --fx-* tokens on #factory).
 * A fixed isometric camera: drag pans, the wheel zooms, F or the button fits everything.
 * A click selects a cluster or a core item: what it links to stays lit, the rest goes quiet, and a card
 * lists it; a double click on a flow, or a row of the card, opens the flow in the editor. / finds by name.
 *
 * An ES module, loaded on demand by factory.js — the studio's pages do not pay for three.js until
 * the picture is opened. mount(host, ir, stats, {onOpen(flow, node)}) → {pause, resume, fit, select, reveal, dispose}. */
import * as THREE from "./vendor/three/three.module.min.js";
import { EffectComposer } from "./vendor/three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/three/addons/postprocessing/OutputPass.js";

export function mount(host, ir, stats, opts = {}) {
const FactoryModel = window.FactoryModel, NAME = ir.name || "";
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
host.textContent = "";
const canvas = mk("canvas", "fx-gl"), labelHost = mk("div", "fx-labels"), hud = mk("div", "fx-hud"), legend = mk("div", "fx-legend"), resetBtn = mk("button", "fx-reset", "Reset view");
resetBtn.type = "button"; resetBtn.title = "Fit the whole project  (F)"; canvas.setAttribute("aria-label", "The project as one model: drag to move, scroll to zoom");
const titleEl = mk("h2"), countsEl = mk("p"); hud.append(titleEl, countsEl); host.append(canvas, labelHost, hud, legend, resetBtn);
const vw = () => host.clientWidth || 1, vh = () => host.clientHeight || 1;
/* Colours are the --fx-* tokens on #factory (studio.css) and nowhere else; `tok` reads one. */
const css = getComputedStyle(host);
const tok = (name) => new THREE.Color(css.getPropertyValue(`--fx-${name}`).trim());
const CLEAR = !matchMedia("(prefers-reduced-transparency: reduce)").matches;
const BIG = 30, MANY = 12, STRAND = 0.3;
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

const model = FactoryModel.build(ir, stats);
const grouped = model.flows.length > BIG;

// ── what stands where ─────────────────────────────────────────────
/* the core: shared blocks, then the resources in use (by kind when there are many) */
const core = [], boxOfRes = new Map();
for (const b of model.blocks.filter(b => b.shared)) core.push({id: b.id, name: b.name, m: "block", h: 1.1 + Math.min(2.2, b.ops * 0.16), kind: "block"});
const used = model.resources.filter(r => r.flows.length);
if (used.length <= MANY) for (const r of used) { core.push({id: r.id, name: r.name, m: "resource", h: 1.0, kind: "resource"}); boxOfRes.set(r.id, r.id); }
else { const kinds = new Map(); for (const r of used) { if (!kinds.has(r.kind)) kinds.set(r.kind, []); kinds.get(r.kind).push(r); }
  for (const [k, rs] of kinds) { const id = rs.length > 1 ? `k:${k}` : rs[0].id; core.push({id, name: rs.length > 1 ? `${k} ×${rs.length}` : rs[0].name, m: "resource", h: 0.9 + Math.min(1.6, rs.length * 0.18), kind: "resource"}); for (const r of rs) boxOfRes.set(r.id, id); } }

/* the clusters */
const sharedAt = new Set(model.blocks.filter(b => b.shared).flatMap(b => b.uses.map(u => u.at)));
const opCube = (n) => ({
  m: sharedAt.has(n.id) ? "sharedOp" : n.agent || /Agent/.test(n.kind || "") ? "agent" : n.graph ? "module" : /Branch/.test(n.kind || "") ? "branch" : /LLM/i.test(n.kind || "") ? "llm" : n.resource ? "resOp" : "op",
  h: n.graph ? 0.7 + Math.min(1.5, (n.subgraph_ops || n.graph.nodes.length) * 0.12) : /Branch/.test(n.kind || "") ? 0.14 : 0.5});
const doorsOf = (ids) => { const seen = new Set(ids.flatMap(i => model.upstream(i).filter(x => /^[sj]:/.test(x)))); return [...seen].map(i => model.by.get(i)); };
const clusters = grouped
  ? model.domains.map(d => { const fs = d.flows.map(i => model.by.get(i)); return {id: d.id, name: d.name || "(no module)", members: d.flows, sub: `${fs.length} flows`,
      cubes: fs.map(f => { const sh = model.outOf(f.id).some(l => l.kind === "uses" && model.by.get(l.dst).shared); return {m: f.errors ? "flowAlert" : sh ? "flowShare" : "flow", h: 0.4 + Math.min(1.8, f.ops / 28)}; }), doors: doorsOf(d.flows)}; })
  : model.flows.map(f => { const g = ir.graphs.find(x => x.name === f.name); return {id: f.id, name: f.name, members: [f.id], sub: `${g.nodes.length} ops`, cubes: g.nodes.map(opCube), doors: doorsOf([f.id])}; });
const asked = new Map(); for (const d of model.unresolved) { if (!asked.has(d.asks)) asked.set(d.asks, new Set()); asked.get(d.asks).add(d); for (const l of model.into(d.id)) asked.get(d.asks).add(model.by.get(l.src)); }
for (const [name, ds] of asked) clusters.push({id: `?:${name}`, name, members: [], sub: "not among this project's graphs", cubes: [], doors: [...ds], ghost: true});

/* the links: one strand per (cluster, core item), all a cluster's strands one bundle */
const clusterOf = new Map(); for (const c of clusters) for (const m of c.members) clusterOf.set(m, c.id);
const boxOf = (id) => { const e = model.by.get(id); if (!e) return null; if (e.type === "flow") return clusterOf.get(id); if (e.type === "block") return e.shared ? id : null; if (e.type === "resource") return boxOfRes.get(id) || null; return null; };
const pairs = FactoryModel.pairs(model, boxOf);
const strandsFor = (n) => (n === 0 ? 0 : n <= 3 ? 1 : n <= 8 ? 2 : 3);
for (const c of clusters) { const mine = pairs.filter(p => p.src === c.id); c.links = mine;
  c.strands = ["uses", "needs"].flatMap(k => Array.from({length: strandsFor(mine.filter(p => p.kind === k).length)}, () => ({kind: k}))); c.bw = Math.max(0, c.strands.length - 1) * STRAND; }

// ── layout, on the ground plane ───────────────────────────────────
for (const c of clusters) {
  const n = c.cubes.length; c.cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.25))); c.rows = Math.max(n ? 1 : 0, Math.ceil(n / c.cols));
  c.wu = Math.max(c.cols + 1.0, c.bw + 1.4, 3);                                  // along the core's side
  c.perRow = Math.max(1, Math.floor((c.wu - 0.6) / 0.5)); c.doorRows = Math.ceil(c.doors.length / c.perRow);
  c.wv = c.rows + 1.0 + (c.doorRows ? c.doorRows * 0.5 + 0.35 : 0);                // away from the core
}
const SIDES = [{out: [1, 0], tan: [0, 1]}, {out: [0, 1], tan: [-1, 0]}, {out: [-1, 0], tan: [0, -1]}, {out: [0, -1], tan: [1, 0]}].map(s => ({...s, list: [], span: 0}));
for (const c of clusters.slice().sort((a, b) => b.wu - a.wu)) { const s = SIDES.reduce((a, b) => (b.span < a.span ? b : a)); s.list.push(c); s.span += c.wu + 2.6; }
const GAP = 2.6;
const cols = Math.max(1, Math.ceil(Math.sqrt(core.length))), CELL = core.length <= 9 ? 3.6 : 2.7;
let coreHalf = Math.max(3.2, Math.ceil(core.length / cols) * CELL / 2 + 1.2, cols * CELL / 2 + 1.2);
coreHalf = Math.max(coreHalf, ...SIDES.map(s => (sum(s.list, c => c.bw + 0.9) + 1) / 2));
/* a pinwheel: each side's row of clusters starts level with the core and runs on past one corner — its own —
 * so the bundles of two neighbouring sides never meet in a corner */
for (const s of SIDES) { const line = s.list.sort((a, b) => b.wu - a.wu), span = sum(line, c => c.wu) + GAP * Math.max(0, line.length - 1);
  let u = span <= coreHalf * 2 ? -span / 2 : -coreHalf; for (const c of line) { c.u = u + c.wu / 2; u += c.wu + GAP; } }
core.forEach((it, i) => { const r = Math.floor(i / cols), k = i % cols, rows = Math.ceil(core.length / cols); it.x = (k - (cols - 1) / 2) * CELL; it.z = (r - (rows - 1) / 2) * CELL; });
/* each side: where every bundle lands on the core's edge, and the lane it turns in — the bundle that
 * has farthest to go turns nearest the core, so no two bundles of a side cross */
let channel = 2;
for (const s of SIDES) {
  const live = s.list.filter(c => c.strands.length); let at = -(sum(live, c => c.bw + 0.9) - 0.9) / 2;
  for (const c of live) { c.slot = at + c.bw / 2; at += c.bw + 0.9; }
  for (const half of [live.filter(c => c.u >= c.slot), live.filter(c => c.u < c.slot)]) { let v = 1.4;
    for (const c of half.sort((a, b) => Math.abs(b.u - b.slot) - Math.abs(a.u - a.slot))) { c.lane = v + c.bw / 2; v += c.bw + 0.8; } channel = Math.max(channel, v + 0.6); }
}
const RIN = coreHalf + channel;
for (const s of SIDES) for (const c of s.list) { c.side = s; c.v = RIN + c.wv / 2; c.x = s.tan[0] * c.u + s.out[0] * c.v; c.z = s.tan[1] * c.u + s.out[1] * c.v; }
const world = (s, u, v) => [s.tan[0] * u + s.out[0] * v, s.tan[1] * u + s.out[1] * v];

// ── scene ─────────────────────────────────────────────────────────
const v3 = new THREE.Vector3(), M = new THREE.Matrix4(), col = new THREE.Color();
const renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: "high-performance"});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.22;
const scene = new THREE.Scene(); scene.background = tok("bg");
const DIR = new THREE.Vector3(1, 1, 1).normalize();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
camera.position.copy(DIR.clone().multiplyScalar(200)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
const RIGHT = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), UP = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

/* Light: a product studio, as the environment metal reflects. The camera never turns, so every family
 * of faces looks at one place in the room; a soft panel stands in each: broad and cool-white over the
 * tops, dimmer for the two sides, and narrow bright ones where the chamfers look — that is what puts a
 * silver line on every machined edge without drawing one. */
{ const refl = (n) => new THREE.Vector3(...n).normalize().multiplyScalar(2 * new THREE.Vector3(...n).normalize().dot(DIR)).sub(DIR).normalize();
  const panels = [[[0, 1, 0], 0.5, 2.0, [0.93, 0.97, 1.0]], [[1, 0, 0], 0.26, 2.0, [0.97, 0.97, 1.0]], [[0, 0, 1], 0.12, 2.0, [0.84, 0.88, 1.0]], [[1, 1, 0], 1.7, 7.0], [[0, 1, 1], 1.25, 7.0], [[1, 0, 1], 0.6, 7.0], [[1, 1, 1], 1.5, 9.0]];
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({side: THREE.BackSide,
    uniforms: {uDir: {value: panels.map(p => refl(p[0]))}, uLobe: {value: panels.map(p => new THREE.Vector2(p[1], p[2]))}, uCol: {value: panels.map(p => new THREE.Vector3(...(p[3] || [0.96, 0.98, 1.0])))}},
    vertexShader: `varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vD; uniform vec3 uDir[7]; uniform vec2 uLobe[7]; uniform vec3 uCol[7];
      void main() { vec3 d = normalize(vD); vec3 l = vec3(0.95, 0.975, 1.0) * (0.035 + 0.05 * smoothstep(-1.0, 1.0, d.y));
        for (int i = 0; i < 7; i++) l += uCol[i] * uLobe[i].x * pow(max(dot(d, uDir[i]), 0.0), uLobe[i].y);
        gl_FragColor = vec4(l, 1.0); }`})));
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(room, 0.015).texture; pm.dispose(); }

/* Geometry: one machined box for every box-like part. Its vertices carry which corner they belong to
 * and how the chamfer, the top frame and the recess pull them in; the size comes per instance, so a
 * chamfer is the same 3 hundredths on a small module and on a plate. shape = (chamfer, frame, recess):
 * with frame = chamfer and recess = 0 it is a plain chamfered block. */
function machinedBox() {
  const tris = [], vx = (a, b, c) => ({c: [a, b, c], k: [0, 1, 1], f: 0, r: 0}), vy = (a, b, c) => ({c: [a, b, c], k: [1, 0, 1], f: 0, r: 0}), vz = (a, b, c) => ({c: [a, b, c], k: [1, 1, 0], f: 0, r: 0});
  const vi = (a, c, r) => ({c: [a, 1, c], k: [0, 0, 0], f: 1, r});
  const at = (v) => [v.c[0] * (0.5 - (v.k[0] * 0.1 + v.f * 0.22)), v.c[1] > 0 ? 1 - v.k[1] * 0.1 - v.r * 0.1 : v.k[1] * 0.1, v.c[2] * (0.5 - (v.k[2] * 0.1 + v.f * 0.22))];
  const face = (vs, n) => { for (let i = 1; i < vs.length - 1; i++) { const t = [vs[0], vs[i], vs[i + 1]], [a, b, c] = t.map(v => new THREE.Vector3(...at(v)));
    if (b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3(...n)) < 0) t.reverse(); tris.push({t, n: new THREE.Vector3(...n).normalize().toArray()}); } };
  const S = [-1, 1];
  for (const a of S) face([vx(a, -1, -1), vx(a, 1, -1), vx(a, 1, 1), vx(a, -1, 1)], [a, 0, 0]);
  for (const c of S) face([vz(-1, -1, c), vz(1, -1, c), vz(1, 1, c), vz(-1, 1, c)], [0, 0, c]);
  for (const a of S) { face([vy(a, 1, -1), vy(a, 1, 1), vi(a, 1, 0), vi(a, -1, 0)], [0, 1, 0]); face([vi(a, -1, 0), vi(a, 1, 0), vi(a, 1, 1), vi(a, -1, 1)], [-a, 0, 0]); }
  for (const c of S) { face([vy(-1, 1, c), vy(1, 1, c), vi(1, c, 0), vi(-1, c, 0)], [0, 1, 0]); face([vi(-1, c, 0), vi(1, c, 0), vi(1, c, 1), vi(-1, c, 1)], [0, 0, -c]); }
  face([vi(-1, -1, 1), vi(1, -1, 1), vi(1, 1, 1), vi(-1, 1, 1)], [0, 1, 0]);
  for (const a of S) for (const b of S) face([vx(a, b, -1), vx(a, b, 1), vy(a, b, 1), vy(a, b, -1)], [a, b, 0]);
  for (const a of S) for (const c of S) face([vx(a, -1, c), vx(a, 1, c), vz(a, 1, c), vz(a, -1, c)], [a, 0, c]);
  for (const b of S) for (const c of S) face([vy(-1, b, c), vy(1, b, c), vz(1, b, c), vz(-1, b, c)], [0, b, c]);
  for (const a of S) for (const b of S) for (const c of S) face([vx(a, b, c), vy(a, b, c), vz(a, b, c)], [a, b, c]);
  const g = new THREE.BufferGeometry(), flat = (f, n) => new THREE.BufferAttribute(new Float32Array(tris.flatMap(T => T.t.flatMap(v => f(v, T)))), n);
  g.setAttribute("position", flat(v => at(v), 3)); g.setAttribute("normal", flat((v, T) => T.n, 3));
  g.setAttribute("corner", flat(v => v.c, 3)); g.setAttribute("kk", flat(v => v.k, 3)); g.setAttribute("fr", flat(v => [v.f, v.r], 2));
  return g;
}
/* Material: titanium or glass, both physically lit by the room. Brushed grain runs one way everywhere
 * (across the tops, round the sides) and is only drawn where a streak is wider than a pixel. */
function machined({metal, rough, grain, clear, opacity}) {
  const m = new THREE.MeshStandardMaterial({metalness: metal, roughness: rough, transparent: !!clear, opacity: opacity == null ? 1 : opacity, depthWrite: !clear});
  m.defines = {GRAIN: grain.toFixed(3)}; if (!metal) m.defines.GLASS = 1; m.customProgramCacheKey = () => `machined${grain}:${metal}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>
      attribute vec3 corner; attribute vec3 kk; attribute vec2 fr; attribute vec3 dims; attribute vec4 shape; varying vec3 vWp; varying vec3 vObjN; varying vec4 vC; varying vec3 vFx;`)
      .replace("#include <begin_vertex>", `vec3 hh = dims * 0.5; vec2 pull = kk.xz * shape.x + fr.x * shape.y;
        float yy = corner.y > 0.0 ? dims.y - kk.y * shape.x - fr.y * shape.z : kk.y * shape.x;
        vec3 transformed = vec3(corner.x * (hh.x - pull.x), yy, corner.z * (hh.z - pull.y));
        vObjN = normal; vWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        vC = vec4(corner.x, yy / max(dims.y, 0.0001), corner.z, yy); vFx = vec3(fr, shape.w);`);
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vWp; varying vec3 vObjN; varying vec4 vC; varying vec3 vFx; float fxHash(float n) { return fract(sin(n * 127.1) * 43758.5453); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        { /* which face this is: a chamfer, a top (its frame or its floor), a side (outer, or the wall of a recess) */
          bool cham = abs(vObjN.x) + abs(vObjN.y) + abs(vObjN.z) > 1.2, top = vObjN.y > 0.9, wall = !top && !cham && vFx.x > 0.5;
          float away = -(vC.x + vC.z) * 0.5;                       // -1 at the corner nearest the eye, +1 at the farthest
          #ifdef GLASS
            /* glass: darker than the metal round it, and a soft panel of the room lying across it */
            float sheen = top ? pow(smoothstep(-1.0, 1.0, away), 2.2) : 0.35 * vC.y;
            totalEmissiveRadiance += vec3(0.74, 0.86, 1.0) * (0.008 + 0.075 * sheen);
          #else
            float gx = top ? vWp.x - vWp.z : vWp.y, fine = clamp(1.0 - fwidth(gx) * 80.0, 0.0, 1.0);
            float tone = 1.0 + (fxHash(floor(gx * 80.0)) - 0.5) * GRAIN * fine * (cham ? 0.0 : 1.0);
            vec3 tint = vec3(1.0);
            if (cham) tone *= 1.1 + 0.1 * vFx.z;                                     // a polished edge
            else if (top && vFx.y < 0.5) tone *= 1.1;                                 // the frame round a panel: polished
            else if (top) { float u = away * 0.7 + (vC.x - vC.z) * 0.15; tone *= 0.9 + 0.2 * away + (0.16 + 0.2 * vFx.z) * exp(-pow((u - 0.3) / 0.3, 2.0)); tint = vec3(0.975, 0.99, 1.03); }   // a satin top, a touch cooler
            else if (wall) tone *= mix(0.72, 0.3, vFx.y);                             // down into a recess
            else { tone *= mix(0.66, 1.0, smoothstep(0.0, 0.34, vC.w)) * (0.86 + 0.2 * vC.y + (0.12 + 0.2 * vFx.z) * exp(-pow((vC.y - 0.74) / 0.2, 2.0))); }   // a side: darker where it meets the plate
            diffuseColor.rgb *= tone * tint;
          #endif
        }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        #ifndef GLASS
        { bool cham = abs(vObjN.x) + abs(vObjN.y) + abs(vObjN.z) > 1.2;
          roughnessFactor *= cham ? 0.52 - 0.14 * vFx.z : (vObjN.y > 0.9 && vFx.y < 0.5 ? 0.62 : 1.0 - 0.22 * vFx.z); }
        #endif`);
  };
  return m;
}
/* a batch: every part of one material is one draw call */
const BOX = machinedBox();
let owner = null;                                                  // the cluster or core item being built: everything drawn meanwhile is its
class Batch { constructor(material, sorted) { this.material = material; this.sorted = sorted; this.items = []; }
  add(x, y, z, sx, sy, sz, color, shape) { this.items.push({x, y, z, sx, sy, sz, color, shape, owner}); }
  build(order) { let list = this.items; if (!list.length) return null; if (this.sorted) list = list.slice().sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
    const g = BOX.clone(), each = (f, n) => new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap(f)), n);
    g.setAttribute("dims", each(b => [b.sx, b.sy, b.sz], 3)); g.setAttribute("shape", each(b => [b.shape[0], b.shape[1], b.shape[2], b.shape[3] || 0], 4));
    const mesh = new THREE.InstancedMesh(g, this.material, list.length);
    list.forEach((b, i) => { M.makeTranslation(b.x, b.y, b.z); mesh.setMatrixAt(i, M);
      const j = this.spread ? (Math.abs(Math.sin(b.x * 12.9898 + b.z * 78.233) * 43758.5453) % 1) - 0.5 : 0;
      b.base = b.color.clone().multiplyScalar(1 + j * (this.spread || 0)); mesh.setColorAt(i, b.base); });
    mesh.frustumCulled = false; mesh.renderOrder = order || 0; scene.add(mesh); this.mesh = mesh; this.list = list; return mesh; }
  /* each instance at its own tone times k(owner): how a selection quiets the rest */
  tone(k) { if (!this.mesh) return; this.list.forEach((b, i) => this.mesh.setColorAt(i, col.copy(b.base).multiplyScalar(k(b.owner)))); this.mesh.instanceColor.needsUpdate = true; } }
const metal = new Batch(machined({metal: 1, rough: 0.42, grain: 0.16})); metal.spread = 0.14;
const glass = new Batch(machined({metal: 0, rough: 0.04, grain: 0}));                                   // a glass panel set in a frame
const smoked = new Batch(machined({metal: 0, rough: 0.05, grain: 0, clear: CLEAR, opacity: CLEAR ? 0.36 : 1}), true); // an enclosure you see into
/* signal lights: the only colour in the picture. `far` ones are seen from any distance (an error);
 * the rest appear once a component is large enough to carry them */
const lights = {far: [], mid: []};
const light = (x, y, z, sx, sy, sz, sig, lod = "mid", gain = 1.5) => lights[lod].push({x, y, z, sx, sy, sz, sig, gain, owner});
const TI = {natural: tok("ti-natural"), silver: tok("ti-silver"), dark: tok("ti-dark"), graphite: tok("ti-graphite"), black: tok("ti-black"), plate: tok("plate"), plateCore: tok("plate-core"), smoke: tok("glass-smoke"), frost: tok("glass-frost")};
const PLAIN = (c, fin = 0) => [c, c, 0, fin];
const boxes = [], shadows = [], engraved = [], pucks = [], kinds = new Set();
const foot = (x, y, z, sx, sy, sz, grounded = true) => { boxes.push({x, y, z, sx, sy, sz, owner}); if (grounded) shadows.push({x, y, z, sx, sz}); };

/* a titanium body with a recessed glass panel in a thin frame: the construction most parts share */
function framed(x, y, z, w, h, d, body, pane, f = 0.085, fin = 0) { const c = Math.min(0.03, w * 0.07), r = 0.03;
  metal.add(x, y, z, w, h, d, body, [c, f, r, fin]); glass.add(x, y + h - r + 0.004, z, w - 2 * f - 0.024, 0.012, d - 2 * f - 0.024, pane, PLAIN(0.004)); }
/* lights. A strip is let into a side the eye sees (the right one, or both); a pip is a small lit window in a top.
 * A quiet part carries a short dim strip, an important one a full bright one. */
const strip = (x, y, z, w, sig, len = 0.42, gain = 1.5, lod = "mid", up = 0.08) => light(x + w / 2 + 0.003, y + up, z, 0.008, 0.06, w * len, sig, lod, gain);
const stripZ = (x, y, z, w, sig, len = 0.42, gain = 1.5, lod = "mid", up = 0.08) => light(x, y + up, z + w / 2 + 0.003, w * len, 0.06, 0.008, sig, lod, gain);
const pip = (x, y, z, size, sig, gain = 1.6, lod = "far") => light(x, y, z, size, 0.01, size, sig, lod, gain);

const PARTS = {
  /* an op: a framed natural-titanium module, smoked glass on top, its flow's blue as one short indicator */
  op(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.natural, TI.smoke); strip(x, y, z, 0.72, "sig-workflow", 0.2, 1.15); },
  /* a model call: the same module under frosted glass, the blue as a full strip */
  llm(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.natural, TI.frost, 0.085, 0.5); strip(x, y, z, 0.72, "sig-workflow", 0.46, 1.6); },
  /* an op that holds a resource: dark titanium, a cyan socket in its top and a cyan strip */
  resOp(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.dark, TI.smoke, 0.085, 0.5); strip(x, y, z, 0.72, "sig-resource", 0.46, 1.6); pip(x + 0.14, y + h - 0.02, z + 0.14, 0.14, "sig-resource"); },
  flow(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.natural, TI.smoke); strip(x, y, z, 0.72, "sig-workflow", 0.2, 1.15); },
  flowShare(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.silver, TI.smoke, 0.085, 1); strip(x, y, z, 0.72, "sig-workflow", 0.46, 1.6); },
  flowAlert(x, y, z, h) { framed(x, y, z, 0.72, h, 0.72, TI.natural, TI.smoke); pip(x, y + h - 0.02, z, 0.3, "sig-error", 1.5); },
  /* a nested graph: a structural frame — a dark base, and a narrower framed tower standing in it, lit blue where they meet */
  module(x, y, z, h) { const b = Math.min(0.3, h * 0.4); metal.add(x, y, z, 0.72, b, 0.72, TI.dark, PLAIN(0.03));
    framed(x, y + b, z, 0.56, h - b, 0.56, TI.natural, TI.frost, 0.07, 1);
    strip(x, y + b, z, 0.56, "sig-workflow", 0.7, 1.6, "mid", 0.012); stripZ(x, y + b, z, 0.56, "sig-workflow", 0.7, 1.6, "mid", 0.012); },
  /* an agent: Space Black, three layers, its submodule on top; violet in the seam under it and in its window */
  agent(x, y, z, h) { const t = h / 3; metal.add(x, y, z, 0.72, t, 0.72, TI.black, PLAIN(0.03, 0.6)); metal.add(x, y + t, z, 0.58, t, 0.58, TI.graphite, PLAIN(0.025, 0.6));
    framed(x, y + 2 * t, z, 0.42, t, 0.42, TI.dark, TI.smoke, 0.06, 1);
    strip(x, y + 2 * t, z, 0.42, "sig-agent", 0.8, 1.7, "far", 0.01); stripZ(x, y + 2 * t, z, 0.42, "sig-agent", 0.8, 1.7, "far", 0.01);
    pip(x, y + h - 0.02, z, 0.16, "sig-agent", 1.7); },
  /* a shared block's op: solid silver titanium, one machined groove */
  sharedOp(x, y, z, h) { const a = h * 0.62, gap = 0.014; metal.add(x, y, z, 0.72, a, 0.72, TI.silver, PLAIN(0.04, 1)); metal.add(x, y + a + gap, z, 0.72, h - a - gap, 0.72, TI.silver, PLAIN(0.04, 1)); },
  /* a branch: a low eight-sided junction with its two ways out — the taken way lit, the other dark */
  branch(x, y, z) { pucks.push({x, y, z, r: 0.33, h: 0.12, color: TI.natural}, {x, y: y + 0.12, z, r: 0.2, h: 0.045, color: TI.silver});
    metal.add(x + 0.3, y, z, 0.1, 0.07, 0.12, TI.dark, PLAIN(0.012)); metal.add(x, y, z + 0.3, 0.12, 0.07, 0.1, TI.dark, PLAIN(0.012));
    light(x + 0.352, y + 0.02, z, 0.006, 0.03, 0.07, "sig-workflow", "mid", 1.6); },
  /* a service: a compact dark module with a glass top; a job: smaller and plain, one champagne light */
  service(x, y, z) { framed(x, y, z, 0.32, 0.26, 0.32, TI.dark, TI.smoke, 0.05); },
  job(x, y, z) { metal.add(x, y, z, 0.26, 0.15, 0.26, TI.natural, PLAIN(0.02)); pip(x, y + 0.15, z, 0.1, "sig-job", 1.5); },
  /* a shared block, in the core: solid silver titanium in three machined sections, a line of blue in the upper groove */
  block(x, y, z, h) { const gap = 0.02, a = h * 0.2, b = h * 0.6; metal.add(x, y, z, 1.7, a, 1.7, TI.silver, PLAIN(0.05, 1));
    metal.add(x, y + a + gap, z, 1.7, b, 1.7, TI.silver, PLAIN(0.05, 1)); metal.add(x, y + a + b + 2 * gap, z, 1.7, h - a - b - 2 * gap, 1.7, TI.silver, PLAIN(0.05, 1));
    light(x + 0.85 - 0.03, y + a + b + gap, z, 0.02, gap, 0.5, "sig-workflow", "mid", 1.5); },
  /* a resource: a titanium base, four posts and a top rim; smoked glass set between them; a small lit core inside */
  resource(x, y, z, h) { const W = 1.7, p = 0.09, e = W / 2 - p / 2;
    metal.add(x, y, z, W, 0.16, W, TI.dark, PLAIN(0.04, 0.5)); strip(x, y, z, W, "sig-resource", 0.16, 1.6, "mid", 0.055);
    for (const a of [-1, 1]) for (const b of [-1, 1]) metal.add(x + a * e, y + 0.16, z + b * e, p, h - 0.16, p, TI.natural, PLAIN(0.014, 1));
    for (const a of [-1, 1]) { metal.add(x + a * e, y + h - p, z, p, p, W - 2 * p, TI.natural, PLAIN(0.014, 1)); metal.add(x, y + h - p, z + a * e, W - 2 * p, p, p, TI.natural, PLAIN(0.014, 1)); }
    smoked.add(x, y + 0.16, z, W - 2 * p + 0.02, h - 0.16 - 0.03, W - 2 * p + 0.02, TI.smoke, PLAIN(0.01));
    light(x, y + 0.17, z, 0.62, Math.max(0.12, h * 0.42), 0.62, "sig-resource", "far", 0.8); },
};
const part = (m, x, y, z, w, h, d) => { kinds.add(m); const n0 = pucks.length; PARTS[m](x, y, z, h); for (let i = n0; i < pucks.length; i++) pucks[i].owner = owner; foot(x, y, z, w, h, d); };

const labels = [];
// the core: a two-step Space Black plate, its items standing on it, each one's name cut into the plate
metal.add(0, -0.16, 0, coreHalf * 2 + 1.6, 0.16, coreHalf * 2 + 1.6, TI.graphite, PLAIN(0.04)); foot(0, -0.16, 0, coreHalf * 2 + 1.6, 0.16, coreHalf * 2 + 1.6, false);
metal.add(0, 0, 0, coreHalf * 2, 0.22, coreHalf * 2, TI.plateCore, PLAIN(0.04, 0.4));
for (const it of core) { owner = it.id; part(it.m, it.x, 0.22, it.z, 1.7, it.h, 1.7); engraved.push({text: it.name, x: it.x, y: 0.221, z: it.z + 1.22, size: 0.24});
  if (core.length <= 9) labels.push({x: it.x, y: 0.22 + it.h + 0.5, z: it.z, cls: "item", title: it.name, owner: it.id}); }
owner = null;
const nBlocks = core.filter(i => i.kind === "block").length;
labels.push({x: coreHalf + 0.6, y: -1.6, z: coreHalf + 0.6, cls: "core", title: "Core", sub: `${nBlocks} shared blocks · ${core.length - nBlocks} resources`});
// the clusters: a graphite plate each; where a bundle of fibres leaves it, and where it reaches the core, a port
for (const c of clusters) { owner = c.id;
  const s = c.side, alongX = !Math.abs(s.out[0]), padX = alongX ? c.wu : c.wv, padZ = alongX ? c.wv : c.wu;
  metal.add(c.x, 0, c.z, padX, 0.14, padZ, c.ghost ? TI.graphite : TI.plate, PLAIN(0.035, 0.3)); foot(c.x, 0, c.z, padX, 0.14, padZ, false);
  let top = 0.6;
  c.cubes.forEach((q, i) => { const r = Math.floor(i / c.cols), k = i % c.cols, inRow = Math.min(c.cols, c.cubes.length - r * c.cols);
    const [x, z] = world(s, c.u + (k - (inRow - 1) / 2), RIN + 0.5 + r + 0.5); part(q.m, x, 0.14, z, 0.72, q.h, 0.72); top = Math.max(top, q.h); });
  c.doors.forEach((d, i) => { const r = Math.floor(i / c.perRow), k = i % c.perRow, inRow = Math.min(c.perRow, c.doors.length - r * c.perRow);
    const [x, z] = world(s, c.u + (k - (inRow - 1) / 2) * 0.5, RIN + c.wv - 0.45 - r * 0.5); part(d.type === "job" ? "job" : "service", x, 0.14, z, 0.3, 0.26, 0.3); });
  if (c.strands.length) { const sig = c.strands.some(t => t.kind === "needs") ? "sig-resource" : "sig-neutral";
    for (const [u, v] of [[c.u, RIN + 0.2], [c.slot, coreHalf - 0.28]]) { const [x, z] = world(s, u, v), w = c.bw + 0.34, y = v > coreHalf ? 0.14 : 0.22;
      metal.add(x, y, z, alongX ? w : 0.3, 0.11, alongX ? 0.3 : w, TI.silver, PLAIN(0.018, 1)); light(x, y + 0.11, z, alongX ? w * 0.5 : 0.05, 0.006, alongX ? 0.05 : w * 0.5, sig); } }
  if (s.out[1] !== 1 && !c.ghost) engraved.push({text: c.name, x: c.x, y: 0.141, z: c.z + padZ / 2 - 0.2, size: 0.2, max: padX - 0.5});
  const nS = c.doors.filter(d => d.type === "service").length, nJ = c.doors.length - nS;
  labels.push({x: c.x - padX / 2, y: 0.9, z: c.z - padZ / 2, cls: c.ghost ? "ghost" : "", owner: c.id, title: c.name, sub: [c.sub, nS ? `${nS} service${nS > 1 ? "s" : ""}` : "", nJ ? `${nJ} job${nJ > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")});
}
owner = null;
metal.build(); glass.build(); smoked.build(3);
/* the junctions' eight-sided bodies */
let puckMesh = null;
if (pucks.length) { const g = new THREE.CylinderGeometry(1, 1, 1, 8); g.rotateY(Math.PI / 8); g.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({metalness: 1, roughness: 0.38, flatShading: true}), pucks.length);
  pucks.forEach((b, i) => { M.makeScale(b.r, b.h, b.r); M.setPosition(b.x, b.y, b.z); mesh.setMatrixAt(i, M); mesh.setColorAt(i, b.color); }); mesh.frustumCulled = false; scene.add(mesh); puckMesh = mesh; }
/* where a part meets the plate it stands on, the plate is a little darker */
{ const cv = document.createElement("canvas"); cv.width = cv.height = 64; const x = cv.getContext("2d"), gr = x.createRadialGradient(32, 32, 14, 32, 32, 32);
  gr.addColorStop(0, "rgba(0,0,0,0.85)"); gr.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.6}), shadows.length);
  shadows.forEach((b, i) => { M.makeScale(b.sx + 0.42, 1, b.sz + 0.42); M.setPosition(b.x, b.y + 0.003, b.z); mesh.setMatrixAt(i, M); }); mesh.frustumCulled = false; mesh.renderOrder = 1; scene.add(mesh); }
const lod = {}, lightSets = [];
const glowTex = (() => { const cv = document.createElement("canvas"); cv.width = cv.height = 64; const x = cv.getContext("2d"), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,0.42)"); gr.addColorStop(0.6, "rgba(255,255,255,0.1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cv); })();
for (const k of ["far", "mid"]) { const list = lights[k]; if (!list.length) continue; const sigs = {};
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(), list.length);
  list.forEach((b, i) => { M.makeScale(b.sx, b.sy, b.sz); M.setPosition(b.x, b.y, b.z); mesh.setMatrixAt(i, M); mesh.setColorAt(i, col.copy(sigs[b.sig] || (sigs[b.sig] = tok(b.sig))).multiplyScalar(b.gain * 1.1)); });
  mesh.frustumCulled = false; lod[k] = new THREE.Group(); lod[k].add(mesh); scene.add(lod[k]);
  /* each light's glow: a soft disc of its own colour, facing the eye, a little in front of the light */
  const halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false}), list.length);
  list.forEach((b, i) => { const r = Math.min(1.5, Math.max(b.sx, b.sy, b.sz) * 2.2 + 0.16);
    M.compose(v3.set(b.x, b.y + b.sy / 2, b.z).addScaledVector(DIR, 1.45 * r), camera.quaternion, new THREE.Vector3(r * 2, r * 2, 1)); halo.setMatrixAt(i, M);
    halo.setColorAt(i, col.copy(sigs[b.sig]).multiplyScalar((k === "mid" ? 0.26 : 0.42) * b.gain / 1.5)); });
  halo.frustumCulled = false; halo.renderOrder = 4; lod[k].add(halo); lightSets.push({list, mesh, halo, sigs, glow: k === "mid" ? 0.26 : 0.42}); }
/* identifiers cut into the plates: flat, dark, legible only close up */
lod.close = new THREE.Group(); scene.add(lod.close);
for (const e of engraved) { const cv = document.createElement("canvas"), x = cv.getContext("2d"), font = "600 44px -apple-system, 'SF Pro Text', Inter, 'Segoe UI', sans-serif";
  x.font = font; const w = Math.ceil(x.measureText(e.text.toUpperCase()).width) + 8; cv.width = w; cv.height = 56; x.font = font; x.fillStyle = "#fff"; x.textBaseline = "middle"; x.fillText(e.text.toUpperCase(), 4, 30);
  const wide = Math.min(e.max || 99, e.size * w / 56), g = new THREE.PlaneGeometry(wide, wide * 56 / w); g.rotateX(-Math.PI / 2);
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8;
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({alphaMap: tex, color: 0x05060a, transparent: true, opacity: 0.7, depthWrite: false})); mesh.position.set(e.x, e.y, e.z); mesh.renderOrder = 1; lod.close.add(mesh); }

/* cables: a strand is a thin lit tube on the ground — out of the cluster, along its lane, into the core */
const cableMat = {uses: new THREE.MeshBasicMaterial({color: tok("fiber-uses").multiplyScalar(1.3)}), needs: new THREE.MeshBasicMaterial({color: tok("fiber-needs").multiplyScalar(1.3)})};
const runs = [], cables = [];                                                // sampled strands, for the lights that travel them
const Y = 0.2;
for (const c of clusters) { const s = c.side; if (!c.strands.length) continue;
  const sgn = Math.sign(c.slot - c.u) || 1, straight = Math.abs(c.slot - c.u) < 0.05;
  c.strands.forEach((p, k) => { const o = (k - (c.strands.length - 1) / 2) * STRAND;
    // offsets keep the strands side by side through both turns
    const uv = straight ? [[c.u + o, RIN + 0.2], [c.u + o, coreHalf - 0.28]]
      : [[c.u + o, RIN + 0.2], [c.u + o, coreHalf + c.lane - o * sgn], [c.slot + o, coreHalf + c.lane - o * sgn], [c.slot + o, coreHalf - 0.28]];
    const pts = uv.map(([u, v]) => { const [x, z] = world(s, u, v); return new THREE.Vector3(x, Y, z); });
    const path = new THREE.CurvePath(), R = 0.55;
    let from = pts[0];
    for (let i = 1; i < pts.length - 1; i++) { const a = pts[i - 1], q = pts[i], b = pts[i + 1], r = Math.min(R, a.distanceTo(q) / 2, q.distanceTo(b) / 2);
      const p1 = q.clone().add(a.clone().sub(q).setLength(r)), p2 = q.clone().add(b.clone().sub(q).setLength(r));
      path.add(new THREE.LineCurve3(from, p1)); path.add(new THREE.QuadraticBezierCurve3(p1, q, p2)); from = p2; }
    path.add(new THREE.LineCurve3(from, pts[pts.length - 1]));
    const len = path.getLength();
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(12, Math.round(len * 2.2)), 0.034, 6, false), cableMat[p.kind]); scene.add(tube);
    cables.push({mesh: tube, owner: c.id, kind: p.kind});
    runs.push({owner: c.id, kind: p.kind, pts: path.getSpacedPoints(Math.max(8, Math.round(len * 2))), len, kind: p.kind, phase: (((k * 0.37 + c.u * 0.11) % 1) + 1) % 1});
  }); }
/* energy: small lights travelling every strand from its cluster to the core */
const sparkGeo = new THREE.SphereGeometry(0.06, 8, 6), sparks = new THREE.InstancedMesh(sparkGeo, new THREE.MeshBasicMaterial({color: 0xffffff}), runs.length);
runs.forEach((r, i) => sparks.setColorAt(i, col.setHex(0xffffff).multiplyScalar(1.5)));
sparks.frustumCulled = false; scene.add(sparks);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 1.18); composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── camera: fit, pan, zoom ────────────────────────────────────────
const view = {cx: 0, cy: 0, zoom: 1};
function fit() { const us = [], vs = [];
  for (const b of boxes) for (const sx of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) for (const y of [0, b.sy]) { v3.set(b.x + sx * b.sx, b.y + y, b.z + sz * b.sz); us.push(v3.dot(RIGHT)); vs.push(v3.dot(UP)); }
  const lo = (xs) => xs.reduce((a, b) => Math.min(a, b)), hi = (xs) => xs.reduce((a, b) => Math.max(a, b));
  const w = hi(us) - lo(us), hgt = hi(vs) - lo(vs) + 5;                    // room above for the names
  view.cx = (hi(us) + lo(us)) / 2; view.cy = (hi(vs) + lo(vs)) / 2 + 1.6;
  // the studio's rail and bar float over the picture: fit into what they leave free (the heading marks its corner)
  const iL = Math.max(0, hud.offsetLeft - 14), iT = Math.max(0, hud.offsetTop - 10), fw = Math.max(200, vw() - iL), fh = Math.max(200, vh() - iT);
  view.span = Math.max(hgt * 1.1 * vh() / fh, w * 1.08 * vh() / fw); view.zoom = 1;
  const k = view.span / vh(); view.cx -= iL / 2 * k; view.cy += iT / 2 * k; apply(); }
function apply() { const a = vw() / vh(), hgt = view.span / view.zoom;
  camera.left = -hgt * a / 2; camera.right = hgt * a / 2; camera.top = hgt / 2; camera.bottom = -hgt / 2; camera.updateProjectionMatrix();
  camera.position.copy(DIR.clone().multiplyScalar(200)).add(RIGHT.clone().multiplyScalar(view.cx)).add(UP.clone().multiplyScalar(view.cy)); camera.updateMatrixWorld();
  // detail by distance: a light or an engraving is drawn once it would be more than a speck
  const px = vh() / hgt; if (lod.mid) lod.mid.visible = px >= 13; lod.close.visible = px >= 30; }
function resize() { renderer.setSize(vw(), vh(), false); composer.setSize(vw(), vh()); apply(); }
const sized = new ResizeObserver(() => { if (host.clientWidth) resize(); }); sized.observe(host);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = Math.max(0.6, Math.min(12, view.zoom * Math.exp(-e.deltaY * 0.0012))); apply(); }, {passive: false});
let drag = null;
let moved = 0;
canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; moved = 0; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => { if (!drag) return; moved += Math.abs(e.clientX - drag[0]) + Math.abs(e.clientY - drag[1]); const k = (view.span / view.zoom) / vh(); view.cx -= (e.clientX - drag[0]) * k; view.cy += (e.clientY - drag[1]) * k; drag = [e.clientX, e.clientY]; apply(); });
canvas.addEventListener("pointerup", (e) => { const click = drag && moved < 5; drag = null; if (click) select(pick(e)); });
canvas.addEventListener("dblclick", (e) => { const id = pick(e); if (id && /^f:/.test(id) && opts.onOpen) opts.onOpen(model.by.get(id).name); });
/* what is under the pointer: the eye's ray against every part's box, the nearest hit */
function pick(e) { const r = canvas.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width * 2 - 1, ny = 1 - (e.clientY - r.top) / r.height * 2;
  const o = camera.position.clone().addScaledVector(RIGHT, nx * camera.right).addScaledVector(UP, ny * camera.top), d = DIR.clone().negate();
  let best = null, bt = Infinity;
  for (const b of boxes) { if (!b.owner) continue; let t0 = -Infinity, t1 = Infinity;
    for (const [oa, da, lo, hi] of [[o.x, d.x, b.x - b.sx / 2, b.x + b.sx / 2], [o.y, d.y, b.y, b.y + b.sy], [o.z, d.z, b.z - b.sz / 2, b.z + b.sz / 2]]) {
      const a = (lo - oa) / da, c = (hi - oa) / da; t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c)); }
    if (t0 <= t1 && t0 < bt) { bt = t0; best = b.owner; } }
  return best; }
resetBtn.onclick = fit;
const onKey = (e) => { if (e.ctrlKey || e.metaKey || e.altKey || !host.clientWidth) return;
  const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.key === "f" || e.key === "F") fit(); else if (e.key === "Escape" && sel) select(null); else if (e.key === "/") { e.preventDefault(); find.focus(); } };
document.addEventListener("keydown", onKey);

// ── words: names float over what they name ────────────────────────
for (const l of labels) { const d = document.createElement("div"); d.className = `lb ${l.cls}`; const b = document.createElement("b"); b.textContent = l.title; d.append(b);
  if (l.sub) { const s = document.createElement("span"); s.textContent = l.sub; d.append(s); }
  if (l.owner) { d.classList.add("open"); d.onclick = () => select(l.owner); d.ondblclick = () => { if (/^f:/.test(l.owner) && opts.onOpen) opts.onOpen(l.title); }; } labelHost.append(d); l.el = d; l.p = new THREE.Vector3(l.x, l.y, l.z); }
function place() { const put = [];
  for (const l of labels) { v3.copy(l.p).project(camera); l.sx = (v3.x + 1) / 2 * vw(); l.sy = (1 - v3.y) / 2 * vh(); l.w = l.w || l.el.offsetWidth; l.hh = l.hh || l.el.offsetHeight; }
  for (const l of labels.slice().sort((a, b) => a.sy - b.sy)) {
    for (const q of put) if (Math.abs(q.sx - l.sx) < (q.w + l.w) / 2 + 6 && l.sy - l.hh < q.sy + 2 && l.sy > q.sy - q.hh) l.sy = q.sy + l.hh + 3;
    put.push(l); l.el.style.left = `${l.sx}px`; l.el.style.top = `${l.sy}px`; } }
titleEl.textContent = model.name || NAME;
countsEl.textContent = `${model.counts.flows.toLocaleString()} flows${grouped ? ` in ${model.counts.domains} domains` : ""} · ${model.counts.services} services · ${model.counts.jobs} jobs · ${model.counts.sharedBlocks} shared blocks · ${model.counts.resources} resources`;
legend.innerHTML = [[grouped ? "flow" : "op", "sig-workflow"], ...(kinds.has("agent") ? [["agent", "sig-agent"]] : []), ["resource", "sig-resource"], ["job", "sig-job"], ...(kinds.has("flowAlert") ? [["error", "sig-error"]] : [])]
  .map(([t, c]) => `<span><i style="background:var(--fx-${c})"></i>${t}</span>`).join("") + `<span class="note">titanium: the parts · silver: shared · light: a signal</span>`;


// ── selection: a part's own links stay lit, the rest goes quiet; a card says what they are (F4) ──
const QUIET = 0.2, cableDim = {uses: cableMat.uses.clone(), needs: cableMat.needs.clone()}; for (const m of Object.values(cableDim)) m.color.multiplyScalar(0.16);
const card = mk("aside", "fx-card"); card.hidden = true; host.append(card);
const spot = new Map(); for (const it of core) spot.set(it.id, it); for (const c of clusters) spot.set(c.id, c);
let sel = null;
function select(id) { sel = id && spot.has(id) ? id : null;
  const lit = sel ? new Set([sel]) : null; if (lit) for (const p of pairs) { if (p.src === sel) lit.add(p.dst); if (p.dst === sel) lit.add(p.src); }
  const k = (o) => !lit || (o != null && lit.has(o)) ? 1 : o == null ? 0.5 : QUIET;
  for (const b of [metal, glass, smoked]) b.tone(k);
  if (puckMesh) { pucks.forEach((b, i) => puckMesh.setColorAt(i, col.copy(b.color).multiplyScalar(k(b.owner)))); puckMesh.instanceColor.needsUpdate = true; }
  for (const L of lightSets) { L.list.forEach((b, i) => { const f = k(b.owner) < 1 ? 0.12 : 1; L.mesh.setColorAt(i, col.copy(L.sigs[b.sig]).multiplyScalar(b.gain * 1.1 * f)); L.halo.setColorAt(i, col.copy(L.sigs[b.sig]).multiplyScalar(L.glow * b.gain / 1.5 * f)); });
    L.mesh.instanceColor.needsUpdate = true; L.halo.instanceColor.needsUpdate = true; }
  // a cable is lit when it is the selected cluster's, or runs from a cluster to the selected item
  const wired = (c) => !lit || c.owner === sel || pairs.some(p => p.src === c.owner && p.dst === sel && p.kind === c.kind);
  for (const c of cables) c.mesh.material = wired(c) ? cableMat[c.kind] : cableDim[c.kind];
  runs.forEach((r, i) => sparks.setColorAt(i, col.setHex(0xffffff).multiplyScalar(wired(r) ? 1.5 : 0.08))); if (runs.length) sparks.instanceColor.needsUpdate = true;
  for (const l of labels) { l.el.classList.toggle("quiet", !!lit && !(l.owner && lit.has(l.owner))); l.el.classList.toggle("picked", !!sel && l.owner === sel); }
  describe(); }
/* the card: what the selected thing is, what leads to it and what it leads to — every row goes somewhere */
function describe() { card.textContent = ""; card.hidden = !sel; if (!sel) return;
  const head = (kind, name, sub) => { const x = mk("button", "fx-x", "×"); x.type = "button"; x.title = "Clear the selection  (Esc)"; x.onclick = () => select(null);
    card.append(x, mk("p", "fx-kind", kind), mk("h3", null, name)); if (sub) card.append(mk("p", "fx-sub", sub)); };
  const list = (title, rows, max = 60) => { if (!rows.length) return; card.append(mk("h4", null, `${title} · ${rows.length}`)); const ul = mk("div", "fx-rows");
    for (const r of rows.slice(0, max)) { const b = mk(r.go ? "button" : "div", "fx-row"); if (r.go) { b.type = "button"; b.onclick = r.go; } b.append(mk("b", null, r.name)); if (r.note) b.append(mk("span", null, r.note)); ul.append(b); }
    if (rows.length > max) ul.append(mk("div", "fx-row more", `and ${rows.length - max} more`)); card.append(ul); };
  const open = (name, at) => () => opts.onOpen && opts.onOpen(name, at);
  const flowRow = (f) => ({name: f.name, note: [`${f.ops} ops`, f.runs ? `${f.runs.toLocaleString()} runs` : "", f.errors ? `${f.errors} failed` : ""].filter(Boolean).join(" · "), go: open(f.name)});
  const doorRow = (d) => ({name: d.name, note: d.type === "job" ? d.kind : `${d.kind} ${d.path || ""}`.trim()});
  const toCore = (kind) => pairs.filter(p => p.src === sel && p.kind === kind).map(p => ({name: spot.get(p.dst).name, note: p.count > 1 ? `×${p.count}` : "", go: () => select(p.dst)}));
  const c = spot.get(sel), e = model.by.get(sel);
  if (c.ghost) { head("Not in this project", c.name, "doors ask for this graph, and the project does not list it"); list("Asked for by", c.doors.map(doorRow)); return; }
  if (c.members) {                                                   // a cluster: one flow, or a domain of flows
    if (grouped) { head("Domain", c.name, c.sub); list("Flows", c.members.map(i => model.by.get(i)).sort((a, b) => b.errors - a.errors || b.runs - a.runs || b.ops - a.ops).map(flowRow), 200); }
    else { head("Flow", c.name, [c.sub, e.runs ? `${e.runs.toLocaleString()} runs in 7 days` : "", e.errors ? `${e.errors} failed` : ""].filter(Boolean).join(" · "));
      const go = mk("button", "fx-go", "Open in the editor"); go.type = "button"; go.onclick = open(c.name); card.append(go); }
    list("Comes in through", c.doors.map(doorRow), 12); list("Uses, shared with other flows", toCore("uses")); list("Needs", toCore("needs")); return; }
  const users = pairs.filter(p => p.dst === sel).map(p => ({name: spot.get(p.src).name, note: p.count > 1 ? `×${p.count}` : "", go: () => select(p.src)}));
  if (c.kind === "block") { head("Shared block", c.name, e.kind === "op" ? `one op · ${e.definedAt}` : `a nested graph of ${e.ops} ops`);
    if (grouped) list("Used in", users); list("Used by", e.uses.map(u => ({name: model.by.get(u.flow).name, note: `as ${u.name}`, go: open(model.by.get(u.flow).name, u.at)})), 80); return; }
  const rs = model.resources.filter(r => boxOfRes.get(r.id) === sel);
  head(rs.length > 1 ? "Resources" : "Resource", c.name, rs.length > 1 ? "" : rs[0].key);
  if (rs.length > 1) list("In this group", rs.map(r => ({name: r.name, note: `${r.flows.length} flows`})));
  if (grouped) list("Needed in", users); list("Needed by", [...new Set(rs.flatMap(r => r.flows))].map(i => flowRow(model.by.get(i))), 80); }
/* go to a thing by name: its cluster or core item is selected and brought to the middle */
function reveal(id) { const e = model.by.get(id); let o = spot.has(id) ? id : null;
  if (!o && e) { const f = e.type === "flow" ? e.id : e.flow || (e.job && model.by.get(e.job).flow); o = f ? clusterOf.get(f) : e.type === "resource" ? boxOfRes.get(id) : e.asks || (e.job && model.by.get(e.job).asks) ? `?:${e.asks || model.by.get(e.job).asks}` : null; }
  if (!o || !spot.has(o)) return false; const t = spot.get(o); v3.set(t.x, 0.6, t.z);
  view.zoom = Math.max(view.zoom, grouped ? 2.2 : 1.8); const k = view.span / view.zoom / vh(), iL = Math.max(0, hud.offsetLeft - 14);
  view.cx = v3.dot(RIGHT) - iL / 2 * k; view.cy = v3.dot(UP); apply(); select(o); return true; }
const find = mk("input", "fx-find"); find.type = "search"; find.placeholder = "Find a flow, service, job, block, resource…"; find.setAttribute("aria-label", "Find on the picture"); find.autocomplete = "off";
const found = mk("div", "fx-found"); found.hidden = true; hud.append(find, found);
const things = [...model.flows, ...model.blocks.filter(b => b.shared), ...model.resources.filter(r => r.flows.length), ...model.doors];
find.oninput = () => { const q = find.value.trim().toLowerCase(); found.textContent = ""; found.hidden = !q; if (!q) return;
  const hits = things.filter(t => `${t.name} ${t.path || ""}`.toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) found.append(mk("div", "fx-row more", "Nothing by that name"));
  for (const t of hits) { const b = mk("button", "fx-row"); b.type = "button"; b.append(mk("b", null, t.name), mk("span", null, t.type === "block" ? "shared block" : t.type));
    b.onclick = () => { if (reveal(t.id)) { find.value = ""; found.hidden = true; } }; found.append(b); } };
find.onkeydown = (e) => { if (e.key === "Enter") { const b = found.querySelector("button"); if (b) b.click(); } else if (e.key === "Escape") { find.value = ""; found.hidden = true; find.blur(); } e.stopPropagation(); };

fit(); resize();
const T0 = performance.now(), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let raf = 0, live = true;
function frame() { raf = 0; if (!live) return; if (!host.clientWidth) { raf = requestAnimationFrame(frame); return; }   // hidden: wait, draw nothing
  const t = still ? 0.37 : (performance.now() - T0) / 1000;
  runs.forEach((r, i) => { const f = ((t * 4.2) / r.len + r.phase) % 1, x = f * (r.pts.length - 1), a = r.pts[Math.floor(x)], b = r.pts[Math.min(r.pts.length - 1, Math.floor(x) + 1)];
    v3.lerpVectors(a, b, x - Math.floor(x)); M.makeTranslation(v3.x, v3.y + 0.02, v3.z); sparks.setMatrixAt(i, M); });
  sparks.instanceMatrix.needsUpdate = true;
  composer.render(); place(); host.dataset.ready = "1"; raf = requestAnimationFrame(frame); }
frame();
return {
  fit, select, reveal,
  pause() { live = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
  resume() { if (!live) { live = true; frame(); } },
  dispose() { this.pause(); sized.disconnect(); document.removeEventListener("keydown", onKey);
    scene.traverse(o => { if (o.geometry) o.geometry.dispose(); for (const m of [].concat(o.material || [])) { for (const k of ["map", "alphaMap"]) if (m[k]) m[k].dispose(); m.dispose(); } });
    if (scene.environment) scene.environment.dispose(); composer.dispose(); renderer.dispose(); host.textContent = ""; delete host.dataset.ready; },
};
}
