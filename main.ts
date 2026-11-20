// gta6-trophy-rarity-forecast-01 — a principled earn-rate forecaster.
//
// Node 22, standard library only, deterministic, offline.
//
// The page prints, for each trophy, the percent of Exophase-tracked players who earned it.
// A read gives players_tracked P and rates r_i. The implied earner count is E_i = r_i/100 * P.
// Exophase updates in discrete refreshes: between refreshes P and every E_i are frozen, so the
// page is unchanged; at a refresh P jumps (new tracked players dilute rates) and E_i may jump
// (new earners). We therefore model
//
//     log(rate_i) = log(100) + log(E_i) - log(P)
//
// and extrapolate log(E_i) and log(P) separately, with recency weighting and damped growth,
// then convert to a logit-scale predictive distribution whose width comes from fit residuals,
// observed refresh jumps and a horizon term. This separates denominator dilution from genuine
// earner growth and keeps rare/common trophies on the scorer's logit scale.
//
// Run (outside the grader):
//   mkdir -p out
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard-normal quantiles at the scored levels.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
const HOUR = 3_600_000;
// Growth damping time constants (hours): an extrapolated slope is integrated only over
// tau*(1 - exp(-dt/tau)) hours, so a long horizon does not produce runaway exponential growth.
const TAU_P = 36;
const TAU_E = 72;
// Recency half-life (hours) for the weighted fits.
const HALF_LIFE = 30;
// Domain prior: Exophase's first refresh of a freshly released game adds a large cohort
// (launch night: 638 -> 3868 tracked, ~6x) that dilutes every non-saturated trophy.
const FIRST_REFRESH_FACTOR = 6.06;
const SATURATED = 99.0;

interface TrophyMeta {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyMeta[];
  history: Read[];
  notes?: string;
}
interface Epoch {
  key: string; // (P, rates) signature used to detect refreshes
  t: number; // hours since release
  P: number; // players tracked
  rates: number[]; // last read of the epoch, nulls replaced by NaN
  n: number; // reads in the epoch
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const logistic = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursSinceRelease = (iso: string): number => (Date.parse(iso) - RELEASE_MS) / HOUR;
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Weighted least squares y = a + b x; returns slope b, intercept a and residual sd. */
function wls(xs: number[], ys: number[], ws: number[]): { a: number; b: number; sd: number } {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    sw += w; sx += w * xs[i]; sy += w * ys[i];
    sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i];
  }
  const den = sw * sxx - sx * sx;
  const b = den > 1e-9 ? (sw * sxy - sx * sy) / den : 0;
  const a = sw > 0 ? (sy - b * sx) / sw : sy;
  let v = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = ys[i] - (a + b * xs[i]);
    v += ws[i] * d * d;
  }
  return { a, b, sd: sw > 0 ? Math.sqrt(v / sw) : 0 };
}

/** Collapse reads into refresh epochs: a run of reads with identical P and rates is one epoch. */
function toEpochs(history: Read[], n: number): Epoch[] {
  const eps: Epoch[] = [];
  for (const r of history) {
    const t = hoursSinceRelease(r.at);
    const P = r.players_tracked > 0 ? r.players_tracked : (eps.length ? eps[eps.length - 1].P : 1);
    const rates = Array.from({ length: n }, (_, i) => {
      const v = r.rates[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    });
    const key = `${P}|${rates.map((x) => (Number.isNaN(x) ? 'n' : x.toFixed(2))).join(',')}`;
    const last = eps[eps.length - 1];
    if (last && last.key === key) {
      last.t = t; // representative time = latest read of the epoch
      last.n++;
      continue;
    }
    eps.push({ key, t, P, rates, n: 1 });
  }
  // Fill per-trophy gaps forward/backward within the epoch list.
  for (let i = 0; i < n; i++) {
    let lastGood = Number.NaN;
    for (const e of eps) {
      if (!Number.isNaN(e.rates[i])) lastGood = e.rates[i];
      else if (!Number.isNaN(lastGood)) e.rates[i] = lastGood;
    }
    lastGood = Number.NaN;
    for (let k = eps.length - 1; k >= 0; k--) {
      const e = eps[k];
      if (!Number.isNaN(e.rates[i])) lastGood = e.rates[i];
      else if (!Number.isNaN(lastGood)) e.rates[i] = lastGood;
      else e.rates[i] = 1.0; // totally absent trophy: neutral prior
    }
  }
  return eps;
}

function damp(dt: number, tau: number): number {
  return tau * (1 - Math.exp(-Math.max(0, dt) / tau));
}

function forecastCase(c: Case): string {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id}: unexpected levels ${JSON.stringify(c.levels)}`);
  }
  const n = c.trophies.length;
  if (!c.history.length) throw new Error(`${c.id}: empty history`);

  const eps = toEpochs(c.history, n);
  const last = eps[eps.length - 1];
  const tTarget = hoursSinceRelease(c.target);
  const dt = Math.max(0, tTarget - last.t);
  const horizonDays = Math.max(0, c.horizon_minutes) / 1440;

  // ---- players-tracked projection -------------------------------------------------------
  let logPtarget: number;
  let pSlope = 0;
  if (eps.length >= 2) {
    const xs = eps.map((e) => e.t);
    const ys = eps.map((e) => Math.log(e.P));
    const ws = eps.map((e) => Math.exp((-Math.LN2 * (last.t - e.t)) / HALF_LIFE));
    pSlope = wls(xs, ys, ws).b;
    pSlope = Math.min(0.25, Math.max(-0.05, pSlope));
    logPtarget = Math.log(last.P) + pSlope * damp(dt, TAU_P);
  } else if (last.t < 8) {
    // Early single-epoch case: anticipate the first big refresh cohort.
    logPtarget = Math.log(last.P) + Math.log(FIRST_REFRESH_FACTOR);
  } else {
    logPtarget = Math.log(last.P);
  }
  logPtarget = Math.min(logPtarget, Math.log(last.P) + Math.log(6));
  logPtarget = Math.max(logPtarget, Math.log(last.P) - Math.log(2));

  // ---- per-trophy earner projection -----------------------------------------------------
  const eSlopes: number[] = [];
  const eSd: number[] = [];
  const lastE: number[] = [];
  const rawSlopes: number[] = [];
  for (let i = 0; i < n; i++) {
    const rLast = last.rates[i];
    const E = (clamp(rLast) / 100) * last.P;
    lastE.push(E);
    const xs: number[] = [], ys: number[] = [], ws: number[] = [];
    for (const e of eps) {
      const Ei = (clamp(e.rates[i]) / 100) * e.P;
      xs.push(e.t);
      ys.push(Math.log(Ei + 0.5));
      ws.push(Math.exp((-Math.LN2 * (last.t - e.t)) / HALF_LIFE));
    }
    const fit = wls(xs, ys, ws);
    rawSlopes.push(eps.length >= 2 ? Math.min(0.30, Math.max(-0.10, fit.b)) : 0);
    eSlopes.push(rawSlopes[i]);
    eSd.push(Math.min(0.9, fit.sd));
  }

  // Shrink noisy per-trophy slopes toward a robust global slope.
  const globalSlope = median(rawSlopes);
  for (let i = 0; i < n; i++) {
    const w = eps.length / (eps.length + 2);
    eSlopes[i] = w * rawSlopes[i] + (1 - w) * globalSlope;
  }

  // ---- observed refresh jumps (global, in log-rate units) --------------------------------
  const jumpAbs: number[] = [];
  for (let k = 1; k < eps.length; k++) {
    for (let i = 0; i < n; i++) {
      const a = eps[k].rates[i], b = eps[k - 1].rates[i];
      if (a > 0 && b > 0) {
        const d = Math.log(a / b) - (Math.log(eps[k].P / eps[k - 1].P));
        if (Number.isFinite(d)) jumpAbs.push(Math.abs(d));
      }
    }
  }
  // Median absolute deviation -> sd-like scale of refresh-specific earner jumps.
  const mad = median(jumpAbs);
  const jumpSd = 1.4826 * mad;

  // ---- assemble quantiles ---------------------------------------------------------------
  const trophies = c.trophies.map((t, i) => {
    let med: number;
    let s: number;
    const rLast = last.rates[i];
    if (rLast >= SATURATED) {
      // A saturated trophy cannot exceed 100; in practice it stays there.
      med = 99.99;
      s = 0.05;
    } else {
      const logEtarget = Math.log(lastE[i] + 0.5) + eSlopes[i] * damp(dt, TAU_E);
      const logRate = Math.log(100) + logEtarget - logPtarget;
      med = clamp(Math.exp(logRate));
      const base = 0.35 * Math.sqrt(horizonDays);
      s = Math.sqrt(base * base + eSd[i] * eSd[i] + jumpSd * jumpSd);
      s = Math.min(2.5, Math.max(0.03, s));
    }
    const L = logit(med);
    const q = Z.map((z) => round4(clamp(logistic(L + z * s))));
    return { id: t.id, q };
  });

  return JSON.stringify({ trophies }) + '\n';
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), forecastCase(c));
}
