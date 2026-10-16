// 星际距离 · 3D 真实恒星位置图
// 数据：HYG v4.0 星表（Hipparcos + 耶鲁亮星表 + Gliese），单位统一换算成「光年」。
// 关键点：每颗星都用它真实的三维坐标 (x, y, z) 画出来，而不是压在天球球面上。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as Astronomy from 'astronomy-engine';
import * as Solar from './solar.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 赤道坐标 (J2000) -> 银道坐标 的旋转矩阵。已校验：银河北极 -> (0,0,1)，银心 -> (1,0,0)。
// HYG 的原始坐标系：+X 指向春分点，+Z 指向北天极，+Y 指向赤经 6h。
const EQ_TO_GAL = [
  [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

const RING_RADII = [10, 20, 30, 40, 50];
const MAX_LY = 50;

// ---------------------------------------------------------------------------
// 恒星颜色：用色指数 B−V 估温度，再把温度映射成颜色（近似，不是光谱渲染）
// ---------------------------------------------------------------------------

const TEMP_STOPS = [
  [2000, [1.0, 0.52, 0.28]],
  [3500, [1.0, 0.72, 0.52]],
  [5000, [1.0, 0.92, 0.82]],
  [6500, [1.0, 1.0, 1.0]],
  [10000, [0.78, 0.86, 1.0]],
  [20000, [0.63, 0.75, 1.0]],
  [40000, [0.56, 0.68, 1.0]],
];

function bvToTemp(bv) {
  const b = Math.max(-0.4, Math.min(2.2, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

function tempToColor(t) {
  if (t <= TEMP_STOPS[0][0]) return TEMP_STOPS[0][1];
  const last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    const [t0, c0] = TEMP_STOPS[i];
    const [t1, c1] = TEMP_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return [1, 1, 1];
}

/**
 * 在地球上看到的亮暗 -> 光点大小。
 *
 * 人眼看到的亮度就是「视星等」：星等每差 1 等，实际亮度差 2.512 倍，所以
 * 天狼星(-1.44) 比肉眼极限(6.5) 亮了约 1500 倍。要在屏幕上表现这么大的动态范围，
 * 不能直接按亮度线性画，否则除了十几颗亮星以外全是看不见的点。
 * 这里用天文软件常用的做法：先把星等线性的压到 0..1，再用幂函数把差距拉开。
 *
 * 标定基准：mag 6.5（肉眼刚好看得见）= 1.5 px，mag -1.5（全天最亮）= 13 px。
 * gain 是"曝光补偿"，以星等为单位：+1 相当于把所有星都看作亮了 1 等。
 */
const MAG_FAINT = 6.5;
const MAG_BRIGHT = -1.5;

function magToBrightness(mag, gain) {
  const x = (MAG_FAINT - (mag - gain)) / (MAG_FAINT - MAG_BRIGHT);
  return Math.pow(Math.min(1, Math.max(0, x)), 1.35);
}

/** 核心圆盘直径（CSS 像素） */
function magToCore(mag, gain) {
  return 1.5 + 10.0 * magToBrightness(mag, gain);
}

/** 外发光直径：核心越大光晕越大，另外给所有星一点基础光晕 */
function magToGlow(core) {
  return core * 2.6 + 3.0;
}

// 每次改了页面就 bump 一下，方便一眼确认浏览器加载的是不是最新版
const BUILD = '9';

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,      // 视野要同时容得下 1e-6 光年和 5000 光年
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x04060d, 1);

const scene = new THREE.Scene();

// 所有天体内容都放在 world 这个组里。整体平移 world，就相当于"把观察点搬到另一颗恒星上"：
// 选中的星会跑到原点，太阳和其余恒星则跟着移动 —— 这正是用来直观感受距离的手段。
const world = new THREE.Group();
scene.add(world);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 1e-6, 20000);
camera.position.set(38, -52, 34);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
controls.minDistance = 1e-6;      // 允许一路缩放进太阳系
controls.maxDistance = 900;
controls.target.set(0, 0, 0);

const defaultCam = camera.position.clone();

// 泛光（bloom）：恒星的核心很亮，让它向四周"溢出"一点光，看起来才像在发光。
// 光点自身的外发光写在星点着色器里，这一层是额外的整体辉光。
//
// 关键：必须自己建一张带 MSAA 的离屏贴图交给 composer。
// renderer 上的 antialias 只对"直接画到画布"生效；一旦用 EffectComposer，
// 画面先渲染到一张普通贴图上，那张贴图默认没有多重采样，于是所有线条
// （轨道线、距离连线、网格）都变成 1 像素硬边，在相机微动时沿线爬行抖动。
const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composerTarget = new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, composerTarget);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.5,    // strength 强度
  0.6,    // radius 扩散半径
  0.3     // threshold 只有比这个更亮的部分才溢出
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// 星空背景：纯黑，不放任何"假星星"——画面上出现的每一颗都是星表里真实存在的天体。

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const bool = (key, dflt) => (params.has(key) ? params.get(key) !== '0' : dflt);

const state = {
  frame: params.get('frame') === 'equatorial' ? 'equatorial' : 'galactic',
  mode: params.get('mode') === 'sphere' ? 'sphere' : 'true',
  maxLy: Math.max(5, Math.min(MAX_LY, Number(params.get('max')) || MAX_LY)),
  showRings: bool('rings', true),
  showGrid: bool('grid', true),
  // 参考网格面的透明度（滑条控制）。放到 state 里是为了让"重建网格"时也能沿用
  gridAlpha: Math.max(0, Math.min(1, params.has('gridalpha') ? Number(params.get('gridalpha')) : 0.28)),
  showNames: bool('names', true),
  showLines: bool('lines', true),
  showGlow: bool('glow', true),
  showBloom: bool('bloom', true),
  showOrbits: bool('orbits', true),
  showBodies: bool('bodies', true),
  showComets: bool('comets', true),
  // 「行星」涵盖 planet + dwarf + asteroid：这样「太阳系天体」正好被
  // 「行星 / 彗星」两个开关完整分割，不会有一类天体两个开关都管不到。
  showPlanets: bool('planets', true),
  // 「显示星等」上限：只显示视星等 <= 该值的恒星（星等越低越亮）。
  // 21 = 不做过滤（数据里最暗的星是 20.1 等）。
  magLimit: params.has('maglim') ? Number(params.get('maglim')) : 21,
  shownStars: -1,          // 过滤后实际显示的恒星数，用于 HUD
  gain: params.has('gain') ? Math.max(-2, Math.min(5, Number(params.get('gain')) || 0)) : 0,
  selected: -1,
  selectedBody: -1,       // 选中的太阳系天体（solarBodies 下标）
  originStar: -1,         // -1 = 站在太阳上；否则代表"站在第 N 颗星上看"
  centerStar: -1,         // -1 = 以太阳为视角中心；否则代表"绕着第 N 颗星转"
  centerBody: -1,         // 绕某个太阳系天体旋转
  morph: 0,               // 0 = 真实距离，1 = 天球
  morphTarget: 0,
  // ---- 时间与太阳系 ----
  simTime: Date.now(),    // 当前模拟时刻（毫秒 UTC）
  timeRate: 1,            // 时间倍速
  timeFlow: true,         // 是否随真实时间流动
  simLoaded: false,
};
state.morph = state.morphTarget = state.mode === 'sphere' ? 1 : 0;

let allStars = [];        // 数据集里的 981 颗星
let active = [];          // 当前显示范围内的星
let starPoints = null;
let spokes = null;
let selectedLine = null;
let observerLine = null;  // 观察点 -> 选中恒星 的连线（站在别的恒星上时才画）
let ringsGroup = null;
let sunGroup = null;
let labelData = [];       // [{ star, el }]
let morphFrame = 0;       // 过渡动画里给连线做节流用
let lastFrameMs = performance.now();

const labelLayer = document.getElementById('labels');

/**
 * 观察点。world 整体平移 = 把观察者搬到另一颗恒星上：
 * 那颗星落到原点，太阳和其余所有恒星随之移动，于是"从别处看太阳系"变成了一个可以转动的场景。
 */
function applyOrigin() {
  if (state.originStar < 0) {
    world.position.set(0, 0, 0);
  } else {
    world.position.copy(truePos(allStars[state.originStar])).multiplyScalar(-1);
  }
  // 场景整体平移了，视角支点要跟着搬到同一个天体上，否则会突然偏掉
  if (state.centerBody >= 0 && solarPos[state.centerBody]) {
    controls.target.copy(bodyScenePos(state.centerBody, new THREE.Vector3()));
  } else {
    controls.target.copy(centerScenePos(state.centerStar));
  }
  controls.update();
  updateOriginUI();
  updateCenterUI();
}

/** 观察点在"世界坐标"里的位置（CPU 侧投影、拾取都要加上它） */
function originOffset() {
  return world.position;
}

/**
 * 视角中心 —— 和"观察点"是两件不同的事：
 *
 *   居中(center)  只把旋转/缩放的支点搬到某颗星上，星空本身一动不动，
 *                 所以距离读数、从太阳射出的连线全都还是以太阳为准。
 *   观察点(origin) 是把整个场景平移，连参考系都换了。
 *
 * 太阳在世界坐标里的位置就是 world.position（因为太阳在 world 的局部原点上）。
 */
function centerScenePos(idx) {
  if (idx < 0) return world.position.clone();
  return truePos(allStars[idx]).clone().add(world.position);
}

function centerOn(idx) {
  const oldTarget = controls.target.clone();
  const dir = camera.position.clone().sub(oldTarget);
  if (dir.lengthSq() < 1e-6) dir.set(38, -52, 34);
  dir.normalize();

  state.centerStar = idx;
  state.centerBody = -1;
  const target = centerScenePos(idx);
  // 只搬支点，不改变缩放级别（但要避免缩放级别离谱到看不见东西）
  const keepDist = THREE.MathUtils.clamp(
    camera.position.distanceTo(oldTarget), state.maxLy * 0.3, state.maxLy * 0.85
  );

  controls.target.copy(target);
  camera.position.copy(target).add(dir.multiplyScalar(keepDist));
  controls.update();
  updateCenterUI();
  lastLabelRefresh = 0;
  refreshLabels();
}

function updateCenterUI() {
  const hudEl = document.getElementById('hud-center');
  const btn = document.getElementById('center-btn');

  let who;
  if (state.centerBody >= 0 && solarBodies[state.centerBody]) {
    const b = solarBodies[state.centerBody];
    who = b.zh || b.name;
  } else if (state.centerStar >= 0) {
    who = allStars[state.centerStar].zh || allStars[state.centerStar].name || allStars[state.centerStar].label;
  } else {
    who = '太阳';
  }
  if (hudEl) hudEl.textContent = '中心：' + who;

  if (!btn) return;
  const onThisBody = state.centerBody >= 0 && state.centerBody === state.selectedBody;
  const onThisStar = state.centerStar >= 0 && state.centerStar === state.selected;
  const on = onThisBody || onThisStar;
  btn.classList.toggle('on', on);
  btn.disabled = state.selected < 0 && state.selectedBody < 0 && state.centerStar < 0 && state.centerBody < 0;
  // 只换文字，别动按钮里的图标（textContent 会把 svg 一起清掉）
  const txt = document.getElementById('center-btn-text');
  if (txt) txt.textContent = on ? '取消居中' : '居中';
  btn.title = on
    ? '点击取消居中，回到以太阳为中心'
    : '以这颗天体为视角中心（距离仍然以太阳为准）';
}

/** 绕某个太阳系天体旋转 */
function centerOnBody(i) {
  const oldTarget = controls.target.clone();
  const dir = camera.position.clone().sub(oldTarget);
  if (dir.lengthSq() < 1e-14) dir.set(0.4, -0.5, 0.75);
  dir.normalize();

  state.centerBody = i;
  state.centerStar = -1;
  const target = bodyScenePos(i, new THREE.Vector3());
  const keepDist = THREE.MathUtils.clamp(
    camera.position.distanceTo(oldTarget), 2 / AU_PER_LY_SCENE, state.maxLy
  );
  controls.target.copy(target);
  camera.position.copy(target).add(dir.multiplyScalar(keepDist));
  controls.update();
  updateCenterUI();
  lastLabelRefresh = 0;
}

const AU_PER_LY_SCENE = 63241.077;

// ---------------------------------------------------------------------------
// 读取数据
// ---------------------------------------------------------------------------

const loadingEl = document.getElementById('loading');

fetch('./data/nearby50.json')
  .then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then((doc) => {
    allStars = doc.stars.map(prepareStar);
    refreshSizes();
    const vEl = document.getElementById('hud-version');
    if (vEl) vEl.textContent = 'build ' + BUILD;
    // 顺手自检：菜单栏要是没被样式放到位，就直接说明白
    const mb = document.getElementById('menubar');
    if (mb && getComputedStyle(mb).position !== 'fixed') {
      vEl.textContent = 'build ' + BUILD + ' · ⚠ style.css 可能是旧缓存，请按 Ctrl+F5';
      vEl.style.color = '#ff9a9a';
    }
    sunGroup = buildSun();
    scene.add(sunGroup);
    rebuildGuides();

    // 初始相机距离跟"显示范围"成比例：范围 50 光年时约 72 光年，范围 10 光年时约 14.5 光年
    const dir = new THREE.Vector3(38, -52, 34).normalize();
    camera.position.copy(dir.multiplyScalar(state.maxLy * 1.45));
    defaultCam.copy(camera.position);
    controls.update();

    buildLabels();
    rebuild();
    wireUI();
    loadingEl.classList.add('done');
    setTimeout(() => loadingEl.remove(), 700);

    // 太阳系数据是可选加载的：拿不到也不影响恒星部分
    loadSolarSystem();

    // ?star=Sirius 可以直接定位到某颗星；?from=Proxima 可以一进来就站在那颗星上
    const findStar = (q) => {
      if (!q) return null;
      const lq = q.toLowerCase();
      return allStars.find(
        (s) => s.label.toLowerCase() === lq || (s.zh || '') === q || (s.en || '').toLowerCase() === lq
      ) || allStars.find((s) => (s.label + s.zh + s.en + (s.bf || '') + (s.con || '')).toLowerCase().includes(lq)) || null;
    };

    const from = findStar(params.get('from'));
    if (from) {
      state.originStar = allStars.indexOf(from);
      applyOrigin();
      frameAfterOriginChange();
    }

    const want = findStar(params.get('star'));
    if (want) selectStar(allStars.indexOf(want));

    // ?center=Sirius 一进来就以某颗星为视角中心（距离仍然以太阳为准）
    const ctr = findStar(params.get('center'));
    if (ctr) centerOn(allStars.indexOf(ctr));

    animate();
  })
  .catch((err) => {
    loadingEl.classList.add('error');
    loadingEl.textContent =
      '数据加载失败：' + err.message + '（请通过本地服务器打开本页，不要直接双击 html 文件）';
  });

/** 太阳系数据 + 时间初始化（加载失败时静默降级，恒星部分照常工作） */
function loadSolarSystem() {
  fetch('./data/solar-system.json')
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((doc) => {
      solarBodies = doc.bodies;
      solarPos.length = solarBodies.length;
      buildSolarSystem();
      state.simLoaded = true;
      const t = params.get('t');
      setSimTime(t ? Date.parse(t) || Date.now() : Date.now());
      const go = params.get('solar');
      if (go !== null && go !== '0') gotoSolarSystem();
      const wantBody = params.get('body');
      if (wantBody) {
        const i = solarBodies.findIndex(
          (b) => (b.zh || '') === wantBody ||
                 b.name.toLowerCase() === wantBody.toLowerCase() ||
                 b.id === wantBody ||
                 b.name.toLowerCase().includes(wantBody.toLowerCase())
        );
        if (i >= 0) { selectBody(i); if (go === null) gotoSolarSystem(); }
      }
    })
    .catch((e) => {
      console.warn('太阳系数据加载失败：', e.message);
      const n = document.getElementById('time-now');
      if (n) n.textContent = '未加载';
    });
}

function prepareStar(s) {
  const eq = new THREE.Vector3(s.x, s.y, s.z);          // 光年，赤道坐标
  const gal = new THREE.Vector3(
    EQ_TO_GAL[0][0] * s.x + EQ_TO_GAL[0][1] * s.y + EQ_TO_GAL[0][2] * s.z,
    EQ_TO_GAL[1][0] * s.x + EQ_TO_GAL[1][1] * s.y + EQ_TO_GAL[1][2] * s.z,
    EQ_TO_GAL[2][0] * s.x + EQ_TO_GAL[2][1] * s.y + EQ_TO_GAL[2][2] * s.z
  );
  const color = tempToColor(bvToTemp(s.ci));
  const label = s.name || s.zh || s.en || s.bf || (s.hip ? 'HIP ' + s.hip : 'HYG ' + s.id);
  return { ...s, eq, gal, color, label };
}

/** 按当前「亮度增益」重新算每颗星的核心/光晕尺寸与强度 */
function refreshSizes() {
  allStars.forEach((s) => {
    const b = magToBrightness(s.mag, state.gain);
    s.bright = b;
    s.core = magToCore(s.mag, state.gain);
    s.glow = magToGlow(s.core);
    s.glowI = 0.12 + 0.5 * b;   // 亮星的光晕相对更明显
    s.sat = 0.45 * b;           // 亮星的核心略微过曝发白（保留一点本来的颜色）
  });
}

/** 当前坐标系下的真实位置 */
function truePos(st) {
  return state.frame === 'galactic' ? st.gal : st.eq;
}

// ---------------------------------------------------------------------------
// 恒星点云
// ---------------------------------------------------------------------------

const vertexShader = `
  attribute float aSize;    // 核心圆盘直径（CSS 像素）
  attribute float aGlow;    // 外发光直径（CSS 像素）
  attribute float aGlowI;   // 发光强度
  attribute float aSat;     // 核心过曝发白的程度
  attribute float aHide;    // 1 = 被「显示星等」过滤掉，直接裁剪
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uRefDist;
  uniform float uGlowOn;
  varying vec3 vColor;
  varying float vCoreR;
  varying float vGlowI;
  varying float vSat;
  void main() {
    vColor = aColor;
    vGlowI = aGlowI * uGlowOn;
    vSat = aSat;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 「显示星等」过滤：不合格的星直接丢到裁剪空间外
    if (aHide > 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 1.0;
      return;
    }
    // 近大远小：尺寸按 (参考距离 / 该点到相机的距离) 的平方根变化。
    // 参考距离是**固定的**（不随相机距离变），否则对正中心的天体来说
    // 参考距离和它到相机的距离同步变化，比值恒为 1 —— 它自己就永远不变大，
    // 只有周围的星在变，看着像在"平移"而不是"靠近"。
    // 用平方根压缩是因为场景跨度太大（0.0007 光年 到 50 光年）。
    float atten = clamp(sqrt(uRefDist / max(-mv.z, 1e-6)), 0.45, 6.0);
    float corePx = aSize * uPixelRatio * atten;
    float glowPx = max(aGlow * uPixelRatio * atten, corePx + 1.5);
    gl_PointSize = max(floor(max(glowPx, 2.5) * 2.0 + 0.5) * 0.5, 2.0);
    vCoreR = clamp(corePx / gl_PointSize, 0.18, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = `
  varying vec3 vColor;
  varying float vCoreR;
  varying float vGlowI;
  varying float vSat;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (r > 1.0) discard;

    // 核心：实心圆盘，亮度越高越"过曝"偏向白
    float core = 1.0 - smoothstep(vCoreR * 0.55, vCoreR, r);
    vec3 coreCol = mix(vColor, vec3(1.0), vSat * core);

    // 光晕：从核心边缘向外衰减的拖尾，让光点"发亮"而不是一个硬边圆点
    float t = max(0.0, (r - vCoreR * 0.5) / max(1.0 - vCoreR * 0.5, 0.001));
    float glow = pow(1.0 - t, 2.2) * vGlowI;

    gl_FragColor = vec4(coreCol * core + vColor * glow, 1.0);
  }
`;

const starMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uRefDist: { value: 60.0 },
    uGlowOn: { value: 1.0 },
  },
  vertexShader,
  fragmentShader,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

function rebuild() {
  active = allStars.filter((s) => s.ly <= state.maxLy);
  const n = active.length;
  const posTrue = new Float32Array(n * 3);
  const posSphere = new Float32Array(n * 3);
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const glows = new Float32Array(n);
  const glowI = new Float32Array(n);
  const sats = new Float32Array(n);
  const hides = new Float32Array(n);
  const colors = new Float32Array(n * 3);

  active.forEach((s, i) => {
    const p = truePos(s);
    posTrue[i * 3] = p.x; posTrue[i * 3 + 1] = p.y; posTrue[i * 3 + 2] = p.z;

    // 天球模式：方向不变，半径统一拉到最远距离 -> 只剩方向信息，和传统星图一样
    const len = p.length() || 1;
    const R = state.maxLy;
    posSphere[i * 3] = (p.x / len) * R;
    posSphere[i * 3 + 1] = (p.y / len) * R;
    posSphere[i * 3 + 2] = (p.z / len) * R;

    // 初始位置要按当前的过渡进度来写，否则切换坐标/范围后会"跳"回真实位置
    const k = state.morph * state.morph * (3 - 2 * state.morph);
    positions[i * 3] = posTrue[i * 3] * (1 - k) + posSphere[i * 3] * k;
    positions[i * 3 + 1] = posTrue[i * 3 + 1] * (1 - k) + posSphere[i * 3 + 1] * k;
    positions[i * 3 + 2] = posTrue[i * 3 + 2] * (1 - k) + posSphere[i * 3 + 2] * k;

    sizes[i] = s.core;
    glows[i] = s.glow;
    glowI[i] = s.glowI;
    sats[i] = s.sat;
    hides[i] = s.mag > state.magLimit ? 1 : 0;
    colors[i * 3] = s.color[0]; colors[i * 3 + 1] = s.color[1]; colors[i * 3 + 2] = s.color[2];
  });

  active._posTrue = posTrue;
  active._posSphere = posSphere;

  if (starPoints) {
    scene.remove(starPoints);
    starPoints.geometry.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glows, 1));
  geo.setAttribute('aGlowI', new THREE.BufferAttribute(glowI, 1));
  geo.setAttribute('aSat', new THREE.BufferAttribute(sats, 1));
  geo.setAttribute('aHide', new THREE.BufferAttribute(hides, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  starPoints = new THREE.Points(geo, starMaterial);
  starPoints.frustumCulled = false;
  scene.add(starPoints);

  rebuildSpokes();
  applyOrigin();
  // 换了坐标系，太阳系天体的位置和轨道线都要跟着转
  if (solarBodies.length) { buildSolarOrbits(); updateSolarSystem(); }
  state.shownStars = -1;      // 重建后由 applyMagFilter 重新统计
  applyMagFilter();
  updateHud();
  updateLabels();
  if (state.selected >= 0 && !active.includes(allStars[state.selected])) selectStar(-1);
}

/** 只改亮度标定（不改显示范围）时，直接更新尺寸属性，不用重建几何体 */
function applySizes() {
  refreshSizes();
  if (!starPoints) return;
  const g = starPoints.geometry;
  const aSize = g.getAttribute('aSize');
  const aGlow = g.getAttribute('aGlow');
  const aGlowI = g.getAttribute('aGlowI');
  const aSat = g.getAttribute('aSat');
  if (!aSize || aSize.count !== active.length) return;   // 范围变了，交给 rebuild 处理
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    aSize.array[i] = s.core;
    aGlow.array[i] = s.glow;
    aGlowI.array[i] = s.glowI;
    aSat.array[i] = s.sat;
  }
  aSize.needsUpdate = true;
  aGlow.needsUpdate = true;
  aGlowI.needsUpdate = true;
  aSat.needsUpdate = true;
}

/** 从太阳到较亮恒星的连线：把"距离"变成看得见的长度。
 *  只画 mag<=7.5 的星，而且从 15% 处起画，避免上百条线在太阳处糊成一团亮斑。 */
function rebuildSpokes() {
  if (spokes) { scene.remove(spokes); spokes.geometry.dispose(); }
  const pts = [];
  if (state.showLines && state.mode !== 'sphere') {
    const k = state.morph * state.morph * (3 - 2 * state.morph);
    active.forEach((s, i) => {
      if (s.mag > 7.5) return;
      const p = truePos(s);
      const x = p.x * (1 - k) + active._posSphere[i * 3] * k;
      const y = p.y * (1 - k) + active._posSphere[i * 3 + 1] * k;
      const z = p.z * (1 - k) + active._posSphere[i * 3 + 2] * k;
      const t = 0.15;
      pts.push(x * t, y * t, z * t, x, y, z);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  spokes = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0x4a86d8, transparent: true, opacity: 0.13, depthWrite: false })
  );
  spokes.frustumCulled = false;
  scene.add(spokes);
}

// ---------------------------------------------------------------------------
// 太阳、距离环、参考网格
// ---------------------------------------------------------------------------

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,240,200,1)');
  grad.addColorStop(0.25, 'rgba(255,205,110,0.75)');
  grad.addColorStop(0.55, 'rgba(255,150,50,0.22)');
  grad.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function buildSun() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0 })
  );
  g.add(core);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glow.scale.set(4, 4, 1);
  g.add(glow);
  return g;
}

function textSprite(text, color = '#8fb6f0', size = 15) {
  const pad = 6;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `${size}px -apple-system, "Microsoft YaHei", sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  c.width = w; c.height = size + pad * 2;
  const g2 = c.getContext('2d');
  g2.font = `${size}px -apple-system, "Microsoft YaHei", sans-serif`;
  g2.fillStyle = color;
  g2.textBaseline = 'middle';
  g2.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(c.width / 34, c.height / 34, 1);
  return sprite;
}

function buildRings() {
  const g = new THREE.Group();
  g.name = 'rings';
  const R = state.maxLy;
  RING_RADII.forEach((r) => {
    if (r > R) return;
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x2f5f9e, transparent: true, opacity: r === R ? 0.55 : 0.3, depthWrite: false })
    );
    g.add(line);
    const label = textSprite(r + ' 光年', r === R ? '#ffd479' : '#6f9ad4', 15);
    label.position.set(r, 0, 0);
    g.add(label);
  });
  return g;
}

function buildGrid() {
  const g = new THREE.Group();
  g.name = 'grid';
  const R = state.maxLy;
  // 参考网格面（银道面上的 12 条径向线 + 最外圈）：红色，透明度压低，
  // 只作为坐标参考，不和恒星、轨道线抢视线。
  const mat = new THREE.LineBasicMaterial({
    color: 0xe0454a, transparent: true, opacity: state.gridAlpha, depthWrite: false,
  });
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat));

  const circle = [];
  for (let i = 0; i <= 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    circle.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
  }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), mat.clone()));
  return g;
}

/** 距离环和网格的大小跟着"显示范围"走，否则缩到 10 光年时还会看到 50 光年的大圈 */
function rebuildGuides() {
  if (ringsGroup) { scene.remove(ringsGroup); disposeGroup(ringsGroup); }
  const oldGrid = scene.getObjectByName('grid');
  if (oldGrid) { scene.remove(oldGrid); disposeGroup(oldGrid); }
  ringsGroup = buildRings();
  ringsGroup.visible = state.showRings;
  const grid = buildGrid();
  grid.visible = state.showGrid;
  scene.add(ringsGroup);
  scene.add(grid);
  // 太阳的光晕也要跟着范围缩放，否则缩到 10 光年时它会糊满整个屏幕
  if (sunGroup) sunGroup.scale.setScalar(state.maxLy / MAX_LY);
}

/** 把滑条的值写到参考网格面上（拖拽时实时生效，不用重建网格） */
function applyGridAlpha() {
  const grid = scene.getObjectByName('grid');
  if (grid) {
    grid.traverse((o) => { if (o.material) o.material.opacity = state.gridAlpha; });
  }
  const val = document.getElementById('grid-alpha-val');
  if (val) val.textContent = Math.round(state.gridAlpha * 100) + '%';
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// 恒星名称标签（HTML 叠加层，比在 WebGL 里画文字更清晰）
// ---------------------------------------------------------------------------

function buildLabels() {
  labelLayer.innerHTML = '';
  labelData = [];
  allStars
    .filter((s) => (s.ly <= 14 || s.mag <= 6.0) && (s.name || s.zh || s.bf))
    .sort((a, b) => a.ly - b.ly || a.mag - b.mag)
    .slice(0, 90)
    .forEach((s) => {
      const el = document.createElement('div');
      el.className = 'lbl';
      const zh = s.zh && s.zh !== s.label ? `${s.label} · ${s.zh}` : s.label;
      el.innerHTML = `${zh}<span class="ly">${s.ly.toFixed(1)} 光年</span>`;
      el.style.display = 'none';
      labelLayer.appendChild(el);
      labelData.push({ star: s, el });
    });
}

const tmpV = new THREE.Vector3();

/**
 * 每帧都把 90 个标签画出来会糊成一团，所以先按屏幕位置做一次简单的矩形避让：
 * 优先保留离太阳近的星，后面的标签和已放下的标签重叠就隐藏。
 */
let lastLabelRefresh = 0;
let lastLabelsWereFar = false;   // 标签"缩得太远"状态的迟滞

// 时间栏的输入框是否被用户改过。改过就不能再用模拟时间去覆盖它，
// 否则点「确定」的瞬间 blur 之后的下一帧 rAF 会把值改回去 —— 表现为"时间改不了"。
// 放在模块顶层（而不是 state 里）是为了避免 updateTimeUI 早期调用时的 TDZ 问题。
let timeDirty = false;

function refreshLabels() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const placed = [];
  const sel = allStars[state.selected];
  const camDist = camera.position.distanceTo(controls.target);
  // 缩进太阳系以后，恒星标签会挡住行星，直接让位
  const solarMode = camDist < SOLAR_FADE_LY * 0.5;
  // 缩得太远时干脆不显示名字：这个距离下标签会挤成一团，而且会在
  // 碰撞判定上来回翻转。留一个 1.25 倍的余量做迟滞，避免在阈值上闪。
  const labelLimit = state.maxLy * 2.2;
  const tooFar = camDist > (lastLabelsWereFar ? labelLimit * 1.25 : labelLimit);
  lastLabelsWereFar = tooFar;

  labelData.forEach(({ star, el }) => {
    if (!state.showNames || solarMode || tooFar || !active.includes(star) ||
        star.mag > state.magLimit) {
      el.style.display = 'none';
      return;
    }
    tmpV.copy(truePos(star)).add(originOffset()).project(camera);
    if (tmpV.z > 1) { el.style.display = 'none'; return; }

    // 先看它上一帧是不是显示着的，再改 display —— 顺序反了迟滞就永远不生效
    const wasShown = el.style.display !== 'none';
    el.style.display = 'block';
    el.classList.toggle('sel', star === sel);
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    const x = (tmpV.x * 0.5 + 0.5) * w;
    const y = (-tmpV.y * 0.5 + 0.5) * h;

    if (x < 0 || x > w || y < 0 || y > h) { el.style.display = 'none'; return; }

    const top = y - 12;
    // 迟滞：已经显示出来的标签判定框小一点，新标签要求更多余量
    const pad = wasShown ? 1 : 4;
    const box = { x0: x - bw / 2 - pad, y0: top - bh - pad, x1: x + bw / 2 + pad, y1: top + pad };
    const hit = placed.some((p) => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1));
    if (hit && star !== sel) {
      el.style.display = 'none';
      return;
    }
    placed.push(box);
    el.dataset.x = x;
    el.dataset.y = top;
  });
}

function updateLabels() {
  refreshLabels();
  lastLabelRefresh = performance.now();
}

// ---------------------------------------------------------------------------
// 交互：点击恒星
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;           // 是拖拽旋转，不是点击
  pick(e.clientX, e.clientY);
});

function pick(cx, cy) {
  // 太阳系天体优先：它们通常就在恒星前面，而且更小更难点中
  if (state.showBodies && solarBodies.length) {
    const camDist = camera.position.distanceTo(controls.target);
    if (camDist < SOLAR_FADE_LY * 0.5) {
      let bi = -1, bd = 18;
      for (let i = 0; i < solarBodies.length; i++) {
        const b = solarBodies[i];
        if (b.kind === 'comet' && !state.showComets) continue;
        if (!solarPos[i]) continue;
        bodyScenePos(i, tmpV).project(camera);
        if (tmpV.z > 1) continue;
        const sx = (tmpV.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-tmpV.y * 0.5 + 0.5) * window.innerHeight;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0) { selectBody(bi); return; }
    }
  }

  let best = -1;
  let bestD = 14;                   // 屏幕像素容差
  active.forEach((s, i) => {
    tmpV.set(active._posTrue[i * 3], active._posTrue[i * 3 + 1], active._posTrue[i * 3 + 2]);
    const k = state.morph;
    tmpV.set(
      tmpV.x * (1 - k) + active._posSphere[i * 3] * k,
      tmpV.y * (1 - k) + active._posSphere[i * 3 + 1] * k,
      tmpV.z * (1 - k) + active._posSphere[i * 3 + 2] * k
    );
    const proj = tmpV.clone().add(originOffset()).project(camera);
    if (proj.z > 1) return;
    const sx = (proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-proj.y * 0.5 + 0.5) * window.innerHeight;
    const d = Math.hypot(sx - cx, sy - cy);
    if (d < bestD) { bestD = d; best = allStars.indexOf(s); }
  });
  selectStar(best);
}

function selectStar(idx) {
  state.selected = idx;
  if (selectedLine) { scene.remove(selectedLine); selectedLine.geometry.dispose(); selectedLine = null; }
  const info = document.getElementById('info');

  if (idx < 0) {
    info.classList.add('hidden');
    updateLabels();
    updateOriginUI();
    updateCenterUI();
    return;
  }
  const s = allStars[idx];
  const p = truePos(s);

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), p.clone()]),
    new THREE.LineBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.85, depthWrite: false })
  );
  line.frustumCulled = false;
  selectedLine = line;
  scene.add(line);

  document.getElementById('info-name').textContent = s.zh || s.name || s.label;
  const sub = [s.name && s.name !== (s.zh || s.label) ? s.name : '', s.zh_en, s.pinyin].filter(Boolean).join(' · ');
  document.getElementById('info-sub').textContent = sub || s.label;

  const rows = [
    ['距离', `${s.ly.toFixed(2)} 光年`, true],
    ['视星等', s.mag.toFixed(2)],
    ['光谱型', s.spect || '未知'],
    ['色指数 B−V', s.ci.toFixed(3)],
    ['星座', s.con || '—'],
    ['Bayer/编号', s.bf || '—'],
    ['HIP 编号', s.hip || '—'],
    ['x / y / z', `${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)} 光年`],
    ['光到达地球需要', `${s.ly.toFixed(2)} 年`],
  ];
  document.getElementById('info-list').innerHTML = rows
    .map(([k, v, big]) => `<dt>${k}</dt><dd class="${big ? 'big' : ''}">${v}</dd>`)
    .join('');
  info.classList.remove('hidden');
  updateLabels();
  updateOriginUI();
  updateCenterUI();
}

document.getElementById('info-close').onclick = () => selectStar(-1);

// ---------------------------------------------------------------------------
// 太阳系天体 + 时间
//
// 尺度问题：海王星离太阳 30 AU，而 1 光年 = 63241 AU。在「50 光年」的视野里，
// 整个太阳系只有 0.0005 光年，比一个像素还小。所以太阳系天体用真实位置绘制，
// 但只有当镜头缩放进去（相机近裁剪面调到 1e-6 光年）才看得见。
// ---------------------------------------------------------------------------

const AU_TO_LY = 1 / 63241.077;
const AE_BODY = {
  sol: 'Sun', lun: 'Moon', mer: 'Mercury', ven: 'Venus', ter: 'Earth', mar: 'Mars',
  jup: 'Jupiter', sat: 'Saturn', ura: 'Uranus', nep: 'Neptune', plu: 'Pluto',
};
// 时间可设定的范围（1800–2050 是 JPL 近似根数精度有保证的区间）
const SIM_MIN = Date.UTC(1800, 0, 1);
const SIM_MAX = Date.UTC(2050, 11, 31, 23, 59, 59);

const SOLAR_SIZE = {
  planet: 11, dwarf: 8, asteroid: 7, comet: 6, star: 15, moon: 5,
};
const SOLAR_COLOR = {
  star: 0xffd27a, moon: 0xd8d8d8, planet: 0xbcd6ff, dwarf: 0xa8c4e8,
  asteroid: 0x9fb6d4, comet: 0x8ff0e0,
};

let solarBodies = [];        // solar-system.json 里的天体
let solarPoints = null;      // 位置点
let solarGroup = null;
let solarOrbits = null;      // 轨道线

// 太阳系天体专用着色器：固定像素大小 + 按"离太阳系的远近"淡入淡出。
// 为什么要淡出：41 个天体全都挤在原点 0.0005 光年以内，在 50 光年的视野里
// 它们会叠成一大团白斑。只有镜头真的缩进太阳系，它们才该出现。
const SOLAR_VERT = `
  attribute float aSize;
  attribute float aHide;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uFade;
  uniform float uRefDist;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vColor = aColor;
    vFade = uFade;
    if (uFade <= 0.02 || aHide > 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // 裁剪掉
      gl_PointSize = 1.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 同恒星：固定参考尺度 + 平方根压缩 + 0.5 像素量化
    float atten = clamp(sqrt(uRefDist / max(-mv.z, 1e-9)), 0.3, 6.0);
    float px = aSize * uPixelRatio * min(uFade, 1.0) * atten;
    gl_PointSize = max(floor(px * 2.0 + 0.5) * 0.5, 2.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SOLAR_FRAG = `
  varying vec3 vColor;
  varying float vFade;
  void main() {
    if (vFade <= 0.002) discard;
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float core = 1.0 - smoothstep(0.42, 0.62, r);
    float glow = pow(max(0.0, 1.0 - r), 2.4) * 0.65;
    float a = core + glow;
    if (a <= 0.002) discard;
    gl_FragColor = vec4((vColor * core + mix(vColor, vec3(1.0), 0.35) * glow) * min(vFade, 1.0), 1.0);
  }
`;

// 相机离原点超过这个距离（约 600 AU）太阳系天体就完全淡出
const SOLAR_FADE_LY = 600 * AU_TO_LY;
// 太阳系视图里"近大远小"的参考尺度：取「飞向太阳系」落点(45 AU)的四成。
// 比落点小，是为了让镜头一进场时天体略小于基准，往里推就会明显变大。
const SOLAR_REF_LY = 45 * AU_TO_LY * 0.4;
let solarLabelData = [];     // [{ body, el }]
const solarPos = [];         // 每帧算出的 AU 坐标

const _v = new THREE.Vector3();

/** 日心赤道 J2000 坐标，单位 AU */
function bodyPositionAU(b, ms) {
  const aeName = b.engine && AE_BODY[b.engine];
  if (aeName && Astronomy.Body[aeName] !== undefined) {
    const v = Astronomy.HelioVector(Astronomy.Body[aeName], Astronomy.MakeTime(new Date(ms)));
    return { x: v.x, y: v.y, z: v.z };
  }
  return Solar.positionOf(b, ms);
}

/** AU（赤道 J2000） -> 场景坐标（光年，按当前坐标系） */
function auToScene(au, out) {
  const x = au.x * AU_TO_LY, y = au.y * AU_TO_LY, z = au.z * AU_TO_LY;
  if (state.frame === 'galactic') {
    out.set(
      EQ_TO_GAL[0][0] * x + EQ_TO_GAL[0][1] * y + EQ_TO_GAL[0][2] * z,
      EQ_TO_GAL[1][0] * x + EQ_TO_GAL[1][1] * y + EQ_TO_GAL[1][2] * z,
      EQ_TO_GAL[2][0] * x + EQ_TO_GAL[2][1] * y + EQ_TO_GAL[2][2] * z
    );
  } else {
    out.set(x, y, z);
  }
  return out;
}

function buildSolarSystem() {
  solarGroup = new THREE.Group();
  solarGroup.name = 'solar';
  world.add(solarGroup);

  const n = solarBodies.length;
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const hides = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const col = new THREE.Color();

  solarBodies.forEach((b, i) => {
    sizes[i] = SOLAR_SIZE[b.kind] ?? 8;
    hides[i] = (b.kind === 'comet' && !state.showComets) ? 1 : 0;
    col.setHex(SOLAR_COLOR[b.kind] ?? 0xbcd6ff);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aHide', new THREE.BufferAttribute(hides, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: renderer.getPixelRatio() },
      uFade: { value: 1 },
      uRefDist: { value: 1 },
    },
    vertexShader: SOLAR_VERT,
    fragmentShader: SOLAR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  solarPoints = new THREE.Points(geo, mat);
  solarPoints.frustumCulled = false;
  solarGroup.add(solarPoints);

  buildSolarOrbits();
  buildSolarLabels();
  applySolarVisibility();
}

function buildSolarOrbits() {
  if (solarOrbits) { world.remove(solarOrbits); disposeGroup(solarOrbits); }
  solarOrbits = new THREE.Group();
  solarOrbits.name = 'solar-orbits';

  // 两条线材质 + 两个几何体：行星一组、彗星一组。
  // 之前每颗天体各建一个 LineSegments，每条还要每帧单独判显隐 ——
  // 那种"每帧给一堆对象设 visible"的写法既慢又容易闪。
  const matPlanet = new THREE.LineBasicMaterial({
    color: 0x4a86d8, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false,
  });
  // 彗星轨道：淡金色，比行星轨道更暗更灰，不抢视线
  const matComet = new THREE.LineBasicMaterial({
    color: 0xc8b98f, transparent: true, opacity: 0.2, depthWrite: false, depthTest: false,
  });
  // depthTest: false —— 这个场景深度跨度 5.6e8 倍（0.0007 光年的行星轨道
  // 对 50 光年的星场），线条在深度比较里精度极差，会随相机微动时隐时现。
  // 轨道本来就是参考线，画在最上层最稳。

  // 彗星轨道裁到 60 AU。要画轨道的彗星里远日点最大的是斯威夫特-塔特尔（51 AU），
  // 所以实际上都画得完整。行星、冥王星、矮行星一律不裁
  // （冥王星远日点 49 AU、阋神星 97 AU，裁了就残缺）。
  const COMET_CLIP_AU = 60;
  const planetPts = [];
  const cometPts = [];
  const MIN_SEG2 = 1e-16;

  const cometSet = cometOrbitBodies();

  solarBodies.forEach((b) => {
    if (!b.elements || b.kind === 'moon' || b.kind === 'star') return;
    const isComet = b.kind === 'comet';
    if (isComet && !cometSet.includes(b)) return;
    let pts;
    try { pts = Solar.orbitPath(b, isComet ? 1200 : 512); } catch (e) { return; }
    if (!pts || pts.length < 2) return;

    const target = isComet ? cometPts : planetPts;
    const clip = isComet ? COMET_CLIP_AU : Infinity;
    let hasPrev = false;
    let px = 0, py = 0, pz = 0;
    for (const p of pts) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) { hasPrev = false; continue; }
      if (Math.hypot(p.x, p.y, p.z) > clip) { hasPrev = false; continue; }
      auToScene(p, _v);
      const cx = _v.x, cy = _v.y, cz = _v.z;
      if (hasPrev) {
        const dx = cx - px, dy = cy - py, dz = cz - pz;
        // 剔掉退化线段：零长度线段的光栅化结果不稳定
        if (dx * dx + dy * dy + dz * dz > MIN_SEG2) {
          target.push(px, py, pz, cx, cy, cz);
          px = cx; py = cy; pz = cz;
        }
      } else {
        px = cx; py = cy; pz = cz; hasPrev = true;
      }
    }
  });

  const mk = (arr, mat, order) => {
    if (arr.length < 6) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const line = new THREE.LineSegments(g, mat);
    line.frustumCulled = false;
    line.renderOrder = order;
    return line;
  };

  const planetLine = mk(planetPts, matPlanet, 1);
  if (planetLine) { planetLine.name = 'planet-orbits'; solarOrbits.add(planetLine); }
  const cometLine = mk(cometPts, matComet, 2);
  if (planetLine) solarOrbits.add(planetLine);
  if (cometLine) { cometLine.name = 'comet-orbits'; solarOrbits.add(cometLine); }
  solarOrbits.renderOrder = 1;
  world.add(solarOrbits);
}

// 彗星轨道的显示规则：
//   只画**周期短于 200 年**的彗星轨道（哈雷 75 年、斯威夫特-塔特尔 134 年、
//   以及各木星族彗星）。它们的轨道是规整的椭圆，画出来有意义。
//   长周期/星际彗星（海尔-波普 a=181 AU、C/2017 K2 a=1872 AU、奥陌陌）的轨道
//   在 40 AU 视野内本来就是几乎笔直的线 —— 画出来既不好看也不提供信息，
//   而且十几条直线叠在一起会互相干扰。想细看时点选它，单独把弧段画出来。
//   名字只在 25 AU 以内挂出，否则一片彗星名会互相挤。
const COMET_PERIOD_LIMIT = 200;   // 年
const COMET_LABEL_AU = 25;

/** 要画轨道的彗星：周期短的 + 当前选中的那颗 */
function cometOrbitBodies() {
  const list = solarBodies.filter(
    (b) => b.kind === 'comet' && b.period_years && b.period_years < COMET_PERIOD_LIMIT
  );
  const sel = state.selectedBody >= 0 ? solarBodies[state.selectedBody] : null;
  if (sel && sel.kind === 'comet' && !list.includes(sel)) list.push(sel);
  return list;
}

function buildSolarLabels() {
  solarLabelData.forEach(({ el }) => el.remove());
  solarLabelData = [];
  // 注意：solarLabelData 会跳过月球，所以它的下标和 solarBodies 对不上，
  // 必须把天体在 solarBodies 里的下标一起存下来（之前就是这里错位，
  // 导致「火星」的标签贴在水星的位置上、还来回跳）。
  solarBodies.forEach((b, i) => {
    if (b.kind === 'moon') return;                // 月球离地球太近，标签必然重叠
    const el = document.createElement('div');
    el.className = 'lbl solar';
    el.textContent = b.zh || b.name;
    el.style.display = 'none';
    labelLayer.appendChild(el);
    solarLabelData.push({ body: b, index: i, el });
  });
  // 行星优先，彗星最后：位置冲突时先保行星
  const rank = { star: 0, planet: 1, dwarf: 2, asteroid: 3, comet: 4, moon: 5 };
  solarLabelData.sort((a, b) => (rank[a.body.kind] ?? 9) - (rank[b.body.kind] ?? 9));
}

/** 「行星」= 行星 + 矮行星 + 小行星（不含太阳、月球、彗星） */
function isPlanetary(b) {
  return b.kind === 'planet' || b.kind === 'dwarf' || b.kind === 'asteroid';
}

function applySolarVisibility() {
  if (solarGroup) solarGroup.visible = state.showBodies;
  if (solarOrbits) {
    solarOrbits.visible = state.showBodies && state.showOrbits;
    // 行星轨道和彗星轨道各是一个对象，一次设置
    const po = solarOrbits.getObjectByName('planet-orbits');
    if (po) po.visible = state.showPlanets;
    const co = solarOrbits.getObjectByName('comet-orbits');
    if (co) co.visible = state.showComets;
  }
  if (solarPoints) {
    const hide = solarPoints.geometry.getAttribute('aHide');
    if (hide) {
      solarBodies.forEach((b, i) => {
        const off = (b.kind === 'comet' && !state.showComets) ||
                    (isPlanetary(b) && !state.showPlanets);
        hide.array[i] = off ? 1 : 0;
      });
      hide.needsUpdate = true;
    }
  }
  if (!state.showBodies) {
    for (const { el } of solarLabelData) el.style.display = 'none';
  }
}

/** 重新按当前时刻算一遍所有太阳系天体的位置 */
function updateSolarSystem() {
  if (!solarPoints || !solarBodies.length) return;
  const attr = solarPoints.geometry.getAttribute('position');
  const arr = attr.array;
  for (let i = 0; i < solarBodies.length; i++) {
    const au = bodyPositionAU(solarBodies[i], state.simTime);
    solarPos[i] = au;
    if (!isFinite(au.x) || !isFinite(au.y) || !isFinite(au.z)) {
      arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0;
      continue;
    }
    auToScene(au, _v);
    arr[i * 3] = _v.x; arr[i * 3 + 1] = _v.y; arr[i * 3 + 2] = _v.z;
  }
  attr.needsUpdate = true;

  // 选中的天体在动，太阳到它的连线要跟着走
  if (bodyLine && state.selectedBody >= 0 && solarPos[state.selectedBody]) {
    auToScene(solarPos[state.selectedBody], _v);
    const la = bodyLine.geometry.getAttribute('position');
    la.setXYZ(1, _v.x, _v.y, _v.z);
    la.needsUpdate = true;
  }
  // 选中天体的信息卡里「离太阳（当前）」这类数字也在变，节流刷新一下
  const nowMs = performance.now();
  if (state.selectedBody >= 0 && nowMs - lastBodyInfoMs > 500) {
    lastBodyInfoMs = nowMs;
    refreshBodyInfo();
  }
}

/** 太阳系天体的名字标签（只在镜头足够近时显示，否则会挤在原点） */
function refreshSolarLabels() {
  if (!state.showBodies || !state.showNames) {
    for (const { el } of solarLabelData) el.style.display = 'none';
    return;
  }
  const w = window.innerWidth, h = window.innerHeight;
  const camDist = camera.position.distanceTo(controls.target);
  const near = camDist < SOLAR_FADE_LY * 0.5;     // 镜头进了太阳系才显示行星名字
  const placed = [];
  for (const { body, index, el } of solarLabelData) {
    if (!near || (body.kind === 'comet' && !state.showComets) ||
        (isPlanetary(body) && !state.showPlanets)) {
      el.style.display = 'none';
      continue;
    }
    const au = solarPos[index];
    if (!au) { el.style.display = 'none'; continue; }
    // 太远的彗星只留一个记号，不挂名字，否则一片彗星名互相挤
    if (body.kind === 'comet' && state.selectedBody !== index &&
        Math.hypot(au.x, au.y, au.z) > COMET_LABEL_AU) {
      el.style.display = 'none';
      continue;
    }
    auToScene(au, _v);
    tmpV.copy(_v).add(originOffset()).project(camera);
    if (tmpV.z > 1) { el.style.display = 'none'; continue; }
    const x = (tmpV.x * 0.5 + 0.5) * w;
    const y = (-tmpV.y * 0.5 + 0.5) * h;
    if (x < 0 || x > w || y < 0 || y > h) { el.style.display = 'none'; continue; }
    // 先记录上一帧是否显示，再改 display —— 顺序反了迟滞就不生效
    const wasShown = el.style.display !== 'none';
    // 必须先让它参与布局，量的宽度才不是 0：display 还是 none 时 offsetWidth
    // 返回 0，判定框退化成一点，会出现"隐藏→量 0→显示→量到真宽→又隐藏"的死循环
    el.style.display = 'block';
    const bw = el.offsetWidth, bh = el.offsetHeight;
    // 迟滞：已显示的判定框 1px，新标签要求 5px，避免在临界距离上反复闪
    const pad = wasShown ? 1 : 5;
    const box = { x0: x - bw / 2 - pad, y0: y - bh - 4 - pad, x1: x + bw / 2 + pad, y1: y - 8 + pad };
    const hit = placed.some((p) => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1));
    if (hit) { el.style.display = 'none'; continue; }
    placed.push(box);
    el.dataset.x = x;
    el.dataset.y = y - 11;
  }
}

// ---- 时间 -----------------------------------------------------------------

function setSimTime(ms) {
  state.simTime = Math.min(SIM_MAX, Math.max(SIM_MIN, ms));
  updateSolarSystem();
  updateTimeUI();
}

/** 太阳系天体的场景坐标 */
function bodyScenePos(i, out) {
  const au = solarPos[i];
  if (!au) return out.copy(world.position);
  auToScene(au, out);
  return out.add(world.position);
}

const KIND_ZH = {
  star: '恒星（太阳）', planet: '行星', dwarf: '矮行星',
  asteroid: '小行星', comet: '彗星', moon: '卫星',
};

let bodyLine = null;      // 太阳 -> 选中天体 的连线

/** 选中一个太阳系天体：信息卡给真实轨道数据，并可以居中 */
function selectBody(i) {
  const info = document.getElementById('info');
  // 清掉恒星那边的选择
  state.selected = -1;
  if (selectedLine) { world.remove(selectedLine); selectedLine.geometry.dispose(); selectedLine = null; }
  if (observerLine) { world.remove(observerLine); observerLine.geometry.dispose(); observerLine = null; }
  if (bodyLine) { world.remove(bodyLine); bodyLine.geometry.dispose(); bodyLine = null; }

  state.selectedBody = i;
  if (i < 0) {
    info.classList.add('hidden');
    updateLabels();
    updateOriginUI();
    updateCenterUI();
    return;
  }

  const b = solarBodies[i];
  const au = solarPos[i] || { x: 0, y: 0, z: 0 };
  const r = Math.hypot(au.x, au.y, au.z);

  // 太阳 -> 天体 的连线
  const p = bodyScenePos(i, new THREE.Vector3());
  bodyLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), p.clone().sub(world.position)]),
    new THREE.LineBasicMaterial({ color: 0xffcf4a, transparent: true, opacity: 0.75, depthWrite: false })
  );
  bodyLine.frustumCulled = false;
  world.add(bodyLine);

  renderBodyInfo(i);
  info.classList.remove('hidden');
  updateLabels();
  updateCenterUI();
  // 如果选的是长周期彗星，把它的轨道弧段也画出来（其余彗星轨道不受影响）
  if (b.kind === 'comet') buildSolarOrbits();
}

let lastBodyInfoMs = 0;

/** 天体在动，信息卡里的实时数字要定期重算 */
function refreshBodyInfo() {
  if (state.selectedBody >= 0) renderBodyInfo(state.selectedBody);
}

function renderBodyInfo(i) {
  const b = solarBodies[i];
  const au = solarPos[i] || { x: 0, y: 0, z: 0 };
  const r = Math.hypot(au.x, au.y, au.z);

  document.getElementById('info-name').textContent = b.zh || b.name;
  const sub = [b.zh ? b.name : '', KIND_ZH[b.kind] || b.kind].filter(Boolean).join(' · ');
  document.getElementById('info-sub').textContent = sub;

  const rows = [['离太阳（当前）', `${r.toFixed(4)} AU`, true]];
  const el = b.elements || {};
  if (b.elem === 'jpl') {
    rows.push(['轨道半长轴', `${el.a.toFixed(5)} AU`]);
    rows.push(['轨道周期', `${(Math.pow(el.a, 1.5)).toFixed(2)} 年`]);
    rows.push(['偏心率', Number(el.e).toFixed(5)]);
  } else if (b.elem === 'osc') {
    rows.push(['轨道半长轴', `${el.a.toFixed(4)} AU`]);
    rows.push(['轨道周期', b.period_years ? `${b.period_years} 年` : '—']);
    rows.push(['偏心率', el.e.toFixed(5)]);
  } else if (b.elem === 'comet') {
    rows.push(['近日距 q', `${el.q.toFixed(4)} AU`]);
    if (b.a) rows.push(['轨道半长轴', `${b.a} AU`]);
    rows.push(['轨道周期', b.period_years ? `${b.period_years} 年` : '非周期']);
    rows.push(['偏心率', el.e.toFixed(5)]);
    rows.push(['过近日点', b.Tp]);
  }
  if (el.i !== undefined) rows.push(['轨道倾角', `${Number(el.i).toFixed(3)}°`]);

  const earthIdx = solarBodies.findIndex((x) => x.id === 'ter');
  if (earthIdx >= 0 && earthIdx !== i && solarPos[earthIdx]) {
    const e = solarPos[earthIdx];
    rows.push(['与地球距离', `${Math.hypot(au.x - e.x, au.y - e.y, au.z - e.z).toFixed(4)} AU`]);
  }
  const d = new Date(state.simTime);
  const pad = (n) => String(n).padStart(2, '0');
  rows.push(['时刻', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 本地`]);

  document.getElementById('info-list').innerHTML = rows
    .map(([k, v, big]) => `<dt>${k}</dt><dd class="${big ? 'big' : ''}">${v}</dd>`)
    .join('');
}

function updateTimeUI() {
  const d = new Date(state.simTime);
  const pad = (n) => String(n).padStart(2, '0');
  // 一律用本地时间读写界面（getFullYear 等），与输入框的时区语义一致
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const dateEl = document.getElementById('time-date');
  const clockEl = document.getElementById('time-clock');
  // 用户正在编辑（或改过还没确定）时不要覆盖，否则永远改不了
  if (dateEl && !timeDirty && document.activeElement !== dateEl) dateEl.value = dateStr;
  if (clockEl && !timeDirty && document.activeElement !== clockEl) clockEl.value = timeStr;

  const now = document.getElementById('time-now');
  if (now) now.textContent = `${dateStr} ${timeStr} 本地`;
  const hud = document.getElementById('hud-time');
  if (hud) hud.textContent = `时间 ${dateStr} ${timeStr}${state.timeFlow ? '' : '（已暂停）'}`;

  const pause = document.getElementById('time-pause');
  if (pause) pause.textContent = state.timeFlow ? '暂停' : '继续';
}

/**
 * 飞向太阳系 / 回到原处
 * 第一次飞过去之前先把当前视角存下来，按钮随之变成「回到原处」；
 * 再点一下恢复原来的视角和旋转中心。
 */
let savedView = null;

function updateSolarButton() {
  const btn = document.getElementById('goto-solar');
  if (btn) btn.textContent = savedView ? '回到原处' : '飞向太阳系';
}

/** 把镜头移到能看见行星的尺度 */
function gotoSolarSystem() {
  if (!savedView) {
    savedView = { pos: camera.position.clone(), target: controls.target.clone() };
  }
  const dir = new THREE.Vector3().copy(camera.position).sub(controls.target);
  if (dir.lengthSq() < 1e-12) dir.set(0.4, -0.5, 0.75);
  dir.normalize();
  state.centerStar = -1;
  state.centerBody = -1;
  controls.target.set(0, 0, 0);
  camera.position.copy(dir.multiplyScalar(45 / 63241.077));   // 45 AU，正好看到天王星
  controls.update();
  lastLabelRefresh = 0;
  updateLabels();
  refreshSolarLabels();
  updateSolarButton();
  updateCenterUI();
}

/** 回到点击「飞向太阳系」之前的视角 */
function returnFromSolarSystem() {
  if (savedView) {
    camera.position.copy(savedView.pos);
    controls.target.copy(savedView.target);
    savedView = null;
  } else {
    camera.position.copy(defaultCam);
    controls.target.set(0, 0, 0);
  }
  controls.update();
  lastLabelRefresh = 0;
  updateLabels();
  refreshSolarLabels();
  updateSolarButton();
  updateCenterUI();
}



// ---------------------------------------------------------------------------
// 控制面板
// ---------------------------------------------------------------------------

function wireUI() {
  // 让面板反映真实初始状态（也支持用 URL 参数预设，例如 ?lines=0&mode=sphere）
  document.querySelectorAll('#frame-seg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.frame === state.frame));
  document.querySelectorAll('#mode-seg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === state.mode));
  document.getElementById('range').value = String(state.maxLy);
  document.getElementById('range-val').textContent = state.maxLy + ' 光年';
  document.getElementById('opt-rings').checked = state.showRings;
  document.getElementById('opt-grid').checked = state.showGrid;
  // 参考网格面的透明度滑条
  const gridAlpha = document.getElementById('grid-alpha');
  if (gridAlpha) {
    gridAlpha.value = String(Math.round(state.gridAlpha * 100));
    const sync = () => { state.gridAlpha = Number(gridAlpha.value) / 100; applyGridAlpha(); };
    gridAlpha.addEventListener('input', sync);    // 拖动过程中实时更新
    gridAlpha.addEventListener('change', sync);
  }
  applyGridAlpha();
  document.getElementById('opt-names').checked = state.showNames;
  document.getElementById('opt-lines').checked = state.showLines;
  document.getElementById('opt-orbits').checked = state.showOrbits;
  document.getElementById('opt-bodies').checked = state.showBodies;
  document.getElementById('opt-planets').checked = state.showPlanets;
  document.getElementById('opt-comets').checked = state.showComets;
  document.getElementById('opt-glow').checked = state.showGlow;
  document.getElementById('opt-bloom').checked = state.showBloom;
  document.getElementById('gain').value = String(state.gain);
  document.getElementById('gain-val').textContent = state.gain.toFixed(1);
  // 「显示星等」滑条：数字是上限，拖到最右等于不过滤
  const maglim = document.getElementById('maglim');
  if (maglim) {
    maglim.value = String(state.magLimit);
    const syncMag = () => {
      state.magLimit = Number(maglim.value);
      const v = document.getElementById('maglim-val');
      if (v) v.textContent = state.magLimit >= 21 ? '全部' : state.magLimit.toFixed(1);
      applyMagFilter();
    };
    maglim.addEventListener('input', syncMag);
    maglim.addEventListener('change', syncMag);
    syncMag();
  }
  starMaterial.uniforms.uGlowOn.value = state.showGlow ? 1 : 0;
  bloomPass.enabled = state.showBloom;
  document.getElementById('opt-lines').disabled = state.mode === 'sphere';
  ringsGroup.visible = state.showRings;
  const grid0 = scene.getObjectByName('grid');
  if (grid0) grid0.visible = state.showGrid;

  document.querySelectorAll('#frame-seg button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#frame-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.frame = btn.dataset.frame;
      rebuild();
    };
  });

  document.querySelectorAll('#mode-seg button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#mode-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.mode = btn.dataset.mode;
      state.morphTarget = state.mode === 'sphere' ? 1 : 0;
      document.getElementById('opt-lines').disabled = state.mode === 'sphere';
      rebuildSpokes();
    };
  });

  const range = document.getElementById('range');
  range.oninput = () => {
    const prev = state.maxLy;
    state.maxLy = Number(range.value);
    document.getElementById('range-val').textContent = state.maxLy + ' 光年';
    // 视野跟着范围一起缩放，否则改到 10 光年时整片星空会缩成一个小点
    const scale = state.maxLy / prev;
    camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
    controls.update();
    rebuildGuides();
    lastLabelRefresh = 0;
    rebuild();
  };

  const toggles = [
    ['opt-rings', 'showRings', (v) => { if (ringsGroup) ringsGroup.visible = v; }],
    ['opt-grid', 'showGrid', (v) => {
      const g = scene.getObjectByName('grid');
      if (g) g.visible = v;
      // 网格关掉时把透明度滑条也置灰，避免误以为滑条没反应
      const sub = document.querySelector('#panel .sub');
      if (sub) sub.classList.toggle('off', !v);
    }],
    ['opt-names', 'showNames', () => updateLabels()],
    ['opt-lines', 'showLines', () => rebuildSpokes()],
    ['opt-orbits', 'showOrbits', () => applySolarVisibility()],
    ['opt-bodies', 'showBodies', () => applySolarVisibility()],
    ['opt-planets', 'showPlanets', () => { applySolarVisibility(); updateLabels(); }],
    ['opt-comets', 'showComets', () => { applySolarVisibility(); updateLabels(); }],
    ['opt-glow', 'showGlow', (v) => { starMaterial.uniforms.uGlowOn.value = v ? 1 : 0; }],
    ['opt-bloom', 'showBloom', (v) => { bloomPass.enabled = v; }],
  ];
  toggles.forEach(([id, key, fn]) => {
    const el = document.getElementById(id);
    el.onchange = () => {
      state[key] = el.checked;
      fn(el.checked);
      updateLabels();
    };
  });

  const gain = document.getElementById('gain');
  gain.oninput = () => {
    state.gain = Number(gain.value);
    document.getElementById('gain-val').textContent = state.gain.toFixed(1);
    applySizes();
  };

  // ---- 视角中心：以选中的天体为中心 / 回到太阳 ------------------------
  document.getElementById('center-btn').onclick = () => {
    if (state.selectedBody >= 0) {
      if (state.centerBody === state.selectedBody) { state.centerBody = -1; centerOn(-1); }
      else centerOnBody(state.selectedBody);
      return;
    }
    if (state.selected < 0 && state.centerStar < 0) return;
    if (state.centerStar === state.selected) centerOn(-1);   // 已经居中了 -> 取消
    else centerOn(state.selected);
  };

  document.getElementById('reset').onclick = () => {
    state.centerStar = -1;
    state.centerBody = -1;
    state.originStar = -1;
    savedView = null;                 // 重置后按钮回到「飞向太阳系」
    applyOrigin();
    camera.position.copy(defaultCam);
    controls.target.set(0, 0, 0);
    controls.update();
    lastLabelRefresh = 0;
    refreshLabels();
    updateCenterUI();
    updateSolarButton();
  };

  // ---- 观察点：搬到某颗恒星上 / 回到太阳 -------------------------------
  document.getElementById('stand-here').onclick = () => {
    if (state.selected < 0) return;
    state.originStar = state.selected;
    applyOrigin();
    frameAfterOriginChange();
    if (observerLine) { world.remove(observerLine); observerLine.geometry.dispose(); observerLine = null; }
    selectStar(state.selected);
  };
  document.getElementById('back-to-sun').onclick = () => {
    state.originStar = -1;
    applyOrigin();
    frameAfterOriginChange();
    selectStar(state.selected);
  };

  wireSearch();
  wireSidebar();
  wireTime();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const box = document.getElementById('search-results');
      if (box && !box.classList.contains('hidden')) { hideSearchResults(); return; }
      selectStar(-1);
    }
    // "/" 快速跳到搜索框
    if (e.key === '/' && document.activeElement !== document.getElementById('search')) {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });
}

/** 「显示星等」：只留下视星等不高于 state.magLimit 的恒星。
 *  约定沿用天文惯例 —— 星等越低越亮，所以这里是「保留 mag <= 上限」。 */
function applyMagFilter() {
  if (!starPoints) return;
  const attr = starPoints.geometry.getAttribute('aHide');
  if (!attr || attr.count !== active.length) return;   // 范围变了，交给 rebuild
  const lim = state.magLimit;
  let shown = 0;
  for (let i = 0; i < active.length; i++) {
    const hide = active[i].mag > lim;
    attr.array[i] = hide ? 1 : 0;
    if (!hide) shown++;
  }
  attr.needsUpdate = true;
  state.shownStars = shown;
  refreshLabels();
  updateHud();
}

function updateHud() {
  const shown = state.shownStars;
  const filtered = shown >= 0 && shown < active.length;
  document.getElementById('hud-count').textContent = filtered
    ? `已显示 ${shown} / ${active.length} 颗恒星`
    : `已显示 ${active.length} 颗恒星`;
  if (active.length) {
    const d = active.map((s) => s.ly);
    document.getElementById('hud-near').textContent =
      `${Math.min(...d).toFixed(1)} – ${Math.max(...d).toFixed(1)} 光年`;
  }
}

// ---------------------------------------------------------------------------
// 侧边栏：收起 / 展开、拖动改变高度、使用说明
// ---------------------------------------------------------------------------

/** 侧边栏能用的最大高度（视口高度减去上下留白） */
function sidebarMaxHeight() {
  return Math.max(220, window.innerHeight - 32);
}

function wireSidebar() {
  const sidebar = document.getElementById('sidebar');
  const tab = document.getElementById('collapse-tab');
  const handle = document.getElementById('resize-handle');

  // --- 收起 / 展开：标签紧贴侧边栏左缘，收起后停在屏幕右缘 ---
  const placeTab = () => {
    const collapsed = sidebar.classList.contains('collapsed');
    // 16 (右边距) + 288 (侧边栏宽) + 1 (边框) = 305
    tab.style.right = collapsed ? '0px' : '305px';
    tab.classList.toggle('collapsed', collapsed);
    tab.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  };
  tab.onclick = () => {
    sidebar.classList.toggle('collapsed');
    placeTab();
  };
  placeTab();

  // --- 拖动底部白条改变侧边栏高度 ---
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, h: sidebar.getBoundingClientRect().height };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const max = sidebarMaxHeight();
    const min = max / 3;                       // 最小缩到原来的三分之一
    const next = Math.min(max, Math.max(min, drag.h + (e.clientY - drag.y)));
    sidebar.style.height = next + 'px';
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // --- 使用说明 ---
  const helpBtn = document.getElementById('help-btn');
  const helpBody = document.getElementById('help-body');
  helpBtn.onclick = () => {
    const hidden = helpBody.classList.toggle('hidden');
    helpBtn.textContent = hidden ? '使用说明' : '收起说明';
  };
}

// ---------------------------------------------------------------------------
// 时间栏
// ---------------------------------------------------------------------------

/**
 * 时间栏。
 *
 * 两个必须注意的点：
 *
 * 1) 用户一旦动过输入框，就不能再用模拟时间去覆盖它。
 *    否则点「确定」的瞬间会先触发 blur，紧接着到来的一帧 rAF 会把输入框
 *    改回当前模拟时间，click 再读到的就是原值 —— 表现为"时间改不了"。
 *
 * 2) 界面按**本地时间**显示和输入，内部 state.simTime 始终是 UTC 毫秒。
 *    之前直接显示 UTC：UTC+8 的用户看到的时间比自己的表慢 8 小时，
 *    会以为默认时间错了。星历计算用的是绝对时刻，和显示时区无关。
 */
function applyTimeInputs() {
  const d = document.getElementById('time-date').value;
  const t = document.getElementById('time-clock').value || '00:00:00';
  if (!d) return;
  // 本地时间 -> 绝对时刻。补 :00 是因为 <input type=time> 可能只给到分钟
  const ms = new Date(`${d}T${t.length === 5 ? t + ':00' : t}`).getTime();
  if (!Number.isNaN(ms)) {
    timeDirty = false;
    setSimTime(ms);
  }
}

function wireTime() {
  const apply = applyTimeInputs;
  document.getElementById('time-apply').onclick = apply;
  ['time-date', 'time-clock'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { timeDirty = true; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
  });

  document.querySelectorAll('#speed-seg button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#speed-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.timeRate = Number(btn.dataset.rate);
      state.timeFlow = true;
      updateTimeUI();
    };
  });

  document.getElementById('time-pause').onclick = () => {
    state.timeFlow = !state.timeFlow;
    updateTimeUI();
  };
  document.getElementById('time-now-btn').onclick = () => {
    timeDirty = false;                 // 放弃输入框里未提交的编辑，重新同步
    setSimTime(Date.now());
  };
  document.getElementById('goto-solar').onclick = () => {
    if (savedView) returnFromSolarSystem();
    else gotoSolarSystem();
  };
  updateSolarButton();
}

// ---------------------------------------------------------------------------
// 观察点：站在某颗恒星上
// ---------------------------------------------------------------------------

function updateOriginUI() {
  const label = document.getElementById('origin-name');
  const stand = document.getElementById('stand-here');
  const back = document.getElementById('back-to-sun');
  if (!label) return;

  if (state.originStar < 0) {
    label.textContent = '太阳';
    back.disabled = true;
  } else {
    const s = allStars[state.originStar];
    label.textContent = (s.zh || s.name || s.label) + `（${s.ly.toFixed(1)} 光年）`;
    back.disabled = false;
  }
  stand.disabled = state.selected < 0 || state.selected === state.originStar;
  stand.textContent = state.originStar < 0 ? '站在这颗星上看' : '搬到这颗星上';
}

/** 换观察点之后重新取景：绕原点（也就是你现在站的地方）旋转 */
function frameAfterOriginChange() {
  const dir = new THREE.Vector3().copy(camera.position).sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(38, -52, 34);
  dir.normalize().multiplyScalar(state.maxLy * 1.45);
  controls.target.set(0, 0, 0);
  camera.position.copy(dir);
  defaultCam.copy(camera.position);
  controls.update();
  lastLabelRefresh = 0;
  refreshLabels();
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

let searchHits = [];
let searchActive = 0;

function highlightSearchResult() {
  const box = document.getElementById('search-results');
  if (!box) return;
  box.querySelectorAll('.sr-item').forEach((el, k) => {
    el.classList.toggle('active', k === searchActive);
    if (k === searchActive) el.scrollIntoView({ block: 'nearest' });
  });
}

function searchableText(s) {
  return [s.label, s.zh, s.zh_en, s.pinyin, s.en, s.name, s.bf, s.con, s.hip ? 'HIP ' + s.hip : '']
    .filter(Boolean).join(' ').toLowerCase();
}

function wireSearch() {
  const input = document.getElementById('search');
  const box = document.getElementById('search-results');
  if (!input || !box) return;
  input._index = allStars.map(searchableText);

  // 菜单项「搜索」：点一下聚焦输入框；输入框有焦点时菜单项高亮
  const item = document.getElementById('mb-search');
  if (item) {
    item.onclick = () => { input.focus(); input.select(); };
    input.addEventListener('focus', () => item.classList.add('active'));
    input.addEventListener('blur', () => item.classList.remove('active'));
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { hideSearchResults(); return; }
    const hits = [];
    for (let i = 0; i < allStars.length; i++) {
      const s = allStars[i];
      const hay = input._index[i];
      const at = hay.indexOf(q);
      if (at < 0) continue;
      // 排序用：名字以关键词开头 > 出现在名字里 > 只在编号里出现，然后按距离近的优先
      const inName = (s.zh || '').toLowerCase().startsWith(q) || (s.name || '').toLowerCase().startsWith(q)
        || (s.label || '').toLowerCase().startsWith(q);
      hits.push({ i, s, score: (inName ? 0 : at === 0 ? 1 : 2) * 1000 + s.ly });
    }
    hits.sort((a, b) => a.score - b.score);
    searchHits = hits.slice(0, 8);
    searchActive = 0;
    renderSearchResults(q);
  });

  input.addEventListener('keydown', (e) => {
    if (!searchHits.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchActive = (searchActive + 1) % searchHits.length;
      highlightSearchResult();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchActive = (searchActive - 1 + searchHits.length) % searchHits.length;
      highlightSearchResult();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSearch(searchHits[searchActive].i);
    }
  });
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && e.target !== input) hideSearchResults();
  });

  // ?q=Veg 一进来就填好搜索框（方便分享一个搜索结果）
  const pre = params.get('q');
  if (pre) {
    input.value = pre;
    input.dispatchEvent(new Event('input'));
  }
}

function renderSearchResults(q) {
  const box = document.getElementById('search-results');
  if (!searchHits.length) {
    box.innerHTML = '<div class="sr-empty">没有找到匹配的恒星（只有带名字的星能被搜到）</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = searchHits
    .map(({ i, s }) => {
      const nm = s.zh || s.name || s.label;
      const alt = [s.name && s.name !== nm ? s.name : '', s.bf, s.con].filter(Boolean).join(' · ');
      return `<div class="sr-item" data-i="${i}"><span class="sr-name">${nm}</span>` +
        `<span class="sr-alt">${alt}</span><span class="sr-ly">${s.ly.toFixed(2)} 光年</span></div>`;
    })
    .join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.sr-item').forEach((el, k) => {
    el.classList.toggle('active', k === searchActive);
    el.onclick = () => pickSearch(Number(el.dataset.i));
  });
}

function hideSearchResults() {
  const box = document.getElementById('search-results');
  if (box) box.classList.add('hidden');
}

function pickSearch(idx) {
  hideSearchResults();
  const input = document.getElementById('search');
  if (input) input.value = '';
  const s = allStars[idx];

  // 如果这颗星超出了当前显示范围，先把范围放宽到能装下它
  if (s.ly > state.maxLy) {
    state.maxLy = Math.min(MAX_LY, Math.ceil(s.ly));
    const range = document.getElementById('range');
    if (range) range.value = String(state.maxLy);
    const rv = document.getElementById('range-val');
    if (rv) rv.textContent = state.maxLy + ' 光年';
    rebuildGuides();
    rebuild();
  }

  selectStar(idx);
  // 让镜头飞过去，并把它设成旋转中心
  const target = centerScenePos(idx);
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(38, -52, 34);
  dir.normalize();
  controls.target.copy(target);
  camera.position.copy(target).add(dir.multiplyScalar(Math.max(state.maxLy * 0.32, 3)));
  controls.update();
  state.centerStar = idx;
  updateCenterUI();
  lastLabelRefresh = 0;
  refreshLabels();
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);

  // ---- 时间流动 ----
  const nowWall = performance.now();
  const dtWall = Math.min((nowWall - lastFrameMs) / 1000, 0.25);   // 秒
  lastFrameMs = nowWall;
  if (state.timeFlow && state.simLoaded) {
    const before = state.simTime;
    setSimTime(state.simTime + dtWall * 1000 * state.timeRate);
    if (state.simTime === before) state.timeFlow = false;         // 撞到 1800/2050 边界就停
  }

  // 真实距离 <-> 天球 的平滑过渡
  if (Math.abs(state.morph - state.morphTarget) > 0.0005) {
    state.morph += (state.morphTarget - state.morph) * 0.09;
    const k = state.morph * state.morph * (3 - 2 * state.morph);
    const n = active.length;
    const attr = starPoints.geometry.getAttribute('position');
    const arr = attr.array;
    for (let i = 0; i < n; i++) {
      arr[i * 3] = active._posTrue[i * 3] * (1 - k) + active._posSphere[i * 3] * k;
      arr[i * 3 + 1] = active._posTrue[i * 3 + 1] * (1 - k) + active._posSphere[i * 3 + 1] * k;
      arr[i * 3 + 2] = active._posTrue[i * 3 + 2] * (1 - k) + active._posSphere[i * 3 + 2] * k;
    }
    attr.needsUpdate = true;
    if (++morphFrame % 3 === 0 && spokes && state.showLines && state.mode === 'true') rebuildSpokes();
    if (state.selected >= 0) {
      const idx = state.selected;
      const p = truePos(allStars[idx]);
      const i = active.indexOf(allStars[idx]);
      if (i >= 0 && selectedLine) {
        const arr2 = selectedLine.geometry.getAttribute('position');
        arr2.setXYZ(1,
          p.x * (1 - k) + active._posSphere[i * 3] * k,
          p.y * (1 - k) + active._posSphere[i * 3 + 1] * k,
          p.z * (1 - k) + active._posSphere[i * 3 + 2] * k);
        arr2.needsUpdate = true;
      }
    }
  }

  controls.update();
  // 近大远小的参考尺度。注意它**不跟着相机距离走**，否则正中心的天体
  // 参考距离和自身距离同步变，比值恒为 1，它自己就永远不会变大。
  // 两个尺度区制差别太大（0.0007 光年 vs 50 光年），超过 600 AU 就算星野。
  const camDist = Math.max(camera.position.distanceTo(controls.target), 1e-7);
  const inSolar = camDist < SOLAR_FADE_LY;
  const refDist = inSolar ? SOLAR_REF_LY : state.maxLy * 0.45;
  starMaterial.uniforms.uRefDist.value = refDist;
  if (solarPoints && state.showBodies) {
    solarPoints.material.uniforms.uFade.value = Math.min(1, SOLAR_FADE_LY / camDist);
    solarPoints.material.uniforms.uRefDist.value = SOLAR_REF_LY;
  }
  // 太阳的光晕 sprite 有 4 光年宽：镜头一旦缩进太阳系，相机会跑到它里面去，
  // 整个屏幕会被糊成白色。所以它的尺寸必须跟着相机距离一起按比例缩小。
  if (sunGroup) {
    const base = state.maxLy / MAX_LY;                       // 显示范围带来的缩放
    const zoom = Math.min(1, camDist / (state.maxLy * 1.45)); // 缩放到哪一级
    sunGroup.scale.setScalar(base * Math.max(zoom, 1e-7));
  }
  composer.render();

  const now = performance.now();
  if (now - lastLabelRefresh > 220) {
    if (state.showNames) refreshLabels();
    refreshSolarLabels();
    lastLabelRefresh = now;
  }
  positionLabels();
  positionSolarLabels();
}

function positionLabels() {
  if (!state.showNames) return;
  labelData.forEach(({ el }) => {
    if (el.style.display === 'none') return;
    el.style.left = el.dataset.x + 'px';
    el.style.top = el.dataset.y + 'px';
  });
}

function positionSolarLabels() {
  for (const { el } of solarLabelData) {
    if (el.style.display === 'none') continue;
    el.style.left = el.dataset.x + 'px';
    el.style.top = el.dataset.y + 'px';
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // composer 的贴图要按"绘制缓冲"尺寸（含设备像素比），否则高 DPI 屏上会糊
  const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
  composer.setSize(sz.x, sz.y);
  starMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  // 侧边栏高度限制在可视区域内，最小为最大高度的三分之一
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    const max = sidebarMaxHeight();
    const h = sidebar.getBoundingClientRect().height;
    sidebar.style.height = Math.min(max, Math.max(max / 3, h)) + 'px';
  }
  const tab = document.getElementById('collapse-tab');
  if (tab) tab.style.right = sidebar.classList.contains('collapsed') ? '0px' : '305px';
});
