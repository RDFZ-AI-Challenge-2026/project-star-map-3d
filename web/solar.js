// solar.js — 太阳系天体的位置计算
//
// 三种根数格式，统一输出「赤道 J2000 日心坐标，单位 AU」，这样能和 HYG 恒星数据放在同一个坐标系里：
//
//   jpl    行星、冥王星：a e i L W N + 每世纪变化率（NASA/JPL 近似位置法）
//   osc    矮行星、小行星：a e i M w N + 平均运动 n（历元 2015-06-27）
//   comet  彗星：q e i w N + 过近日点时刻 Tp（MPC）
//
// 椭圆、双曲线、抛物线三种圆锥曲线都处理。

export const AU_PER_LY = 63241.077;
export const DEG = Math.PI / 180;
const OBLIQUITY = 23.4392911 * DEG;      // J2000 平黄赤交角
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DAY_MS = 86400000;
const GAUSS_K = 0.9856076686;            // 度/天，a=1AU 时的平均运动

/** MPC 的 Tp 形如 "2061-08-01.5919"，小数部分是一天中的比例，Date.parse 认不出来 */
export function parseTp(tp) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}(?:\.\d+)?)$/.exec(String(tp).trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, 1) + (+m[3] - 1) * DAY_MS;
}

// ---------------------------------------------------------------------------
// 开普勒方程
// ---------------------------------------------------------------------------

/** 椭圆：E − e·sinE = M（M 弧度） */
function solveElliptic(M, e) {
  M = Math.atan2(Math.sin(M), Math.cos(M));
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 80; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** 双曲线：e·sinhH − H = M（M 弧度） */
function solveHyperbolic(M, e) {
  let H = Math.asinh(M / e) || M;
  for (let k = 0; k < 120; k++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const d = f / fp;
    H -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return H;
}

/** 抛物线（e = 1）：巴克方程 */
function solveBarker(M) {
  // M = D + D³/3，其中 D = tan(ν/2)
  const W = 1.5 * M;
  const u = Math.cbrt(W + Math.sqrt(W * W + 1));
  return u - 1 / u;   // D
}

// ---------------------------------------------------------------------------
// 轨道平面 -> 赤道 J2000
// ---------------------------------------------------------------------------

/**
 * 把轨道平面内的坐标 (xp, yp) 旋转到赤道 J2000（单位同为 AU）。
 * w = 近日点幅角，N = 升交点黄经，i = 轨道倾角（弧度）。
 */
function orbitToEquatorial(xp, yp, w, N, inc) {
  const cw = Math.cos(w), sw = Math.sin(w);
  const cN = Math.cos(N), sN = Math.sin(N);
  const ci = Math.cos(inc), si = Math.sin(inc);

  const xe = (cw * cN - sw * sN * ci) * xp + (-sw * cN - cw * sN * ci) * yp;
  const ye = (cw * sN + sw * cN * ci) * xp + (-sw * sN + cw * cN * ci) * yp;
  const ze = (sw * si) * xp + (cw * si) * yp;

  // 黄道 -> 赤道
  return {
    x: xe,
    y: ye * Math.cos(OBLIQUITY) - ze * Math.sin(OBLIQUITY),
    z: ye * Math.sin(OBLIQUITY) + ze * Math.cos(OBLIQUITY),
  };
}

/**
 * 通用位置求解。body 是 solar-system.json 里的一项：
 *   { elem: 'jpl'|'osc'|'comet', elements: {...}, epoch? }
 * 返回 { x, y, z } —— 赤道 J2000 日心坐标，单位 AU。
 * dateMs: JS 时间戳（毫秒，UTC）
 */
export function positionOf(body, dateMs) {
  const el = body.elements;
  const days = (dateMs - J2000_MS) / DAY_MS;

  if (body.elem === 'jpl') {
    // 线性变化率，T 单位是世纪
    const T = days / 36525;
    const a = el.a + el.da * T;
    const e = el.e + el.de * T;
    const inc = (el.i + el.di * T) * DEG;
    const L = (el.L + el.dL * T) * DEG;
    const W = (el.W + el.dW * T) * DEG;
    const N = (el.N + el.dN * T) * DEG;
    const w = W - N;
    const M = L - W;
    const E = solveElliptic(M, e);
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    return orbitToEquatorial(xp, yp, w, N, inc);
  }

  if (body.elem === 'osc') {
    // 从历元起算，用平均运动线性外推平近点角
    const epochMs = Date.parse(body.epoch + 'T00:00:00Z');
    const dt = (dateMs - epochMs) / DAY_MS;
    const e = el.e;
    const inc = el.i * DEG;
    const M = (el.M + el.n * dt) * DEG;
    const w = el.w * DEG;
    const N = el.N * DEG;
    const E = solveElliptic(M, e);
    const xp = el.a * (Math.cos(E) - e);
    const yp = el.a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    return orbitToEquatorial(xp, yp, w, N, inc);
  }

  // 彗星：给的是过近日点时刻 Tp 和近日距 q
  const e = el.e;
  const q = el.q;
  const inc = el.i * DEG;
  const w = el.w * DEG;
  const N = el.N * DEG;
  const TpMs = parseTp(body.Tp);
  const dtDays = (dateMs - TpMs) / DAY_MS;

  if (e < 0.999999) {
    const a = q / (1 - e);
    const n = GAUSS_K / Math.pow(a, 1.5);          // 度/天
    const M = n * dtDays * DEG;
    const E = solveElliptic(M, e);
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    return orbitToEquatorial(xp, yp, w, N, inc);
  }

  if (e > 1.000001) {
    // 双曲线：a 取负号约定，这里用 aH > 0 重写
    const aH = q / (e - 1);
    const n = GAUSS_K / Math.pow(aH, 1.5);
    const M = n * dtDays * DEG;
    const H = solveHyperbolic(M, e);
    const xp = aH * (e - Math.cosh(H));
    const yp = aH * Math.sqrt(e * e - 1) * Math.sinh(H);
    return orbitToEquatorial(xp, yp, w, N, inc);
  }

  // 抛物线
  const n = GAUSS_K / Math.pow(2 * q, 1.5);        // 度/天
  const M = n * dtDays * DEG;
  const D = solveBarker(M);
  const xp = q * (1 - D * D);
  const yp = 2 * q * D;
  return orbitToEquatorial(xp, yp, w, N, inc);
}

/**
 * 轨道轨迹（用于画椭圆），返回赤道 J2000 的 AU 坐标数组。
 * 只对椭圆轨道有意义；双曲线/抛物线返回靠近太阳的一段。
 */
export function orbitPath(body, samples = 256) {
  const el = body.elements;
  const pts = [];
  let e, a, w, N, inc;

  if (body.elem === 'jpl') {
    e = el.e; a = el.a;
    inc = el.i * DEG; N = el.N * DEG; w = (el.W - el.N) * DEG;
  } else if (body.elem === 'osc') {
    e = el.e; a = el.a;
    inc = el.i * DEG; N = el.N * DEG; w = el.w * DEG;
  } else {
    e = el.e;
    if (e >= 1) {
      a = el.q / Math.abs(1 - e);
      inc = el.i * DEG; N = el.N * DEG; w = el.w * DEG;
      return hyperbolicPath(e, a, w, N, inc, samples);
    }
    a = el.q / (1 - e);
    inc = el.i * DEG; N = el.N * DEG; w = el.w * DEG;
  }

  // 采样必须按**偏近点角 E** 均匀取，不能按平近点角 M。
  // 对高偏心率的彗星，真近点角随 M 变化极不均匀：哈雷 e=0.968 时
  // dν/dM 在近日点高达约 245，一个 M 步长就能跨过近百度的真实轨道，
  // 于是整条轨道被画成一根从近日点直连远日点的 35 AU 长直线段 ——
  // 那种大跨度直线在画面里会随相机微动而剧烈闪烁。
  // 按 E 均匀采样得到的是沿椭圆均匀分布的点，曲线自然光滑。
  for (let k = 0; k <= samples; k++) {
    const E = (k / samples) * Math.PI * 2;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    pts.push(orbitToEquatorial(xp, yp, w, N, inc));
  }
  return pts;
}

function hyperbolicPath(e, aH, w, N, inc, samples) {
  const pts = [];
  const Hmax = Math.acosh(Math.max(1.0001, 1 + 6 / (e - 1 + 0.05)));
  for (let k = 0; k <= samples; k++) {
    const H = -Hmax + (2 * Hmax * k) / samples;
    const xp = aH * (e - Math.cosh(H));
    const yp = aH * Math.sqrt(Math.max(0, e * e - 1)) * Math.sinh(H);
    pts.push(orbitToEquatorial(xp, yp, w, N, inc));
  }
  return pts;
}
