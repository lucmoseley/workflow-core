/*
 * arm-stats.js — the before/after test's statistics (workflow-core#2045, workflow-core#2046,
 * `docs/research/startup-load-before-after-test.md` D3–D4): the main run's
 * size, its Poisson regression and Mann–Whitney cross-check, and workflow-core#2241's
 * within-task comparisons of acceptance, wall time and spend.
 */

/**
 * Guesses, not measurements: IRLS on a Poisson log link converges in under 10
 * passes on the pilot's data, and a pivot this small means the strata are
 * collinear, not merely ill-conditioned.
 */
const MAX_IRLS_PASSES = 100;
const IRLS_STEP_TOLERANCE = 1e-10;
const SINGULAR_PIVOT = 1e-12;
/** Guesses: the incomplete gamma's series and continued fraction settle well inside these at any df a report meets. */
const MAX_GAMMA_TERMS = 500;
const GAMMA_TOLERANCE = 1e-14;
/** Numerical Recipes 5.2's FPMIN for the modified Lentz method: near the smallest double, so a zero denominator becomes finite. */
const TINY = 1e-300;
/** Two-sided alpha 0.05 and 80% power, D4's design. */
const Z_ALPHA = 1.959_964;
const Z_POWER = 0.841_621;

/**
 * @typedef {{ task: string, arm: string, score: number }} Scored
 */

/** @param {number[]} xs */
function meanVar(xs) {
	const n = xs.length;
	const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
	const variance =
		n > 1 ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
	return { n, mean, variance };
}

/**
 * Runs per arm for a two-sided test of rate ratio `1 - drop`, D3's Poisson
 * model scaled by the dispersion (variance / mean):
 * n = (zα + zβ)² · φ · (1/m0 + 1/m1) / ln(1 − d)².
 * @param {{ m0: number, dispersion: number, drop: number }} opts
 */
function runsPerArm({ m0, dispersion, drop }) {
	if (m0 <= 0) return Number.POSITIVE_INFINITY;
	const m1 = m0 * (1 - drop);
	return Math.ceil(
		((Z_ALPHA + Z_POWER) ** 2 * dispersion * (1 / m0 + 1 / m1)) /
			Math.log(1 - drop) ** 2,
	);
}

/**
 * Variance pooled over every (task, arm) cell, weighted by its degrees of
 * freedom, so a gap between tasks is not counted as noise.
 * @param {Scored[]} scored
 */
function withinTask(scored) {
	/** @type {Map<string, number[]>} */
	const cells = new Map();
	for (const s of scored) {
		const key = `${s.task}\u0000${s.arm}`;
		cells.set(key, [...(cells.get(key) ?? []), s.score]);
	}
	let ss = 0;
	let df = 0;
	for (const xs of cells.values()) {
		const { n, variance } = meanVar(xs);
		ss += variance * (n - 1);
		df += n - 1;
	}
	const pooled = df > 0 ? ss / df : 0;
	const grand = meanVar(scored.map((s) => s.score)).mean;
	return { pooled, df, dispersion: grand > 0 ? pooled / grand : 0 };
}

/**
 * The standard normal CDF, by Abramowitz and Stegun 7.1.26 (error < 1.5e-7).
 * @param {number} z
 */
function normalCdf(z) {
	const x = Math.abs(z) / Math.SQRT2;
	const t = 1 / (1 + 0.327_591_1 * x);
	const poly =
		t *
		(0.254_829_592 +
			t *
				(-0.284_496_736 +
					t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
	const erf = 1 - poly * Math.exp(-x * x);
	return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** @param {number} z */
const twoSidedP = (z) => 2 * (1 - normalCdf(Math.abs(z)));

/** Lanczos's coefficients for g = 7, n = 9. */
const LANCZOS = /** @type {const} */ ([
	0.999_999_999_999_809_9, 676.520_368_121_885_1, -1259.139_216_722_402_8,
	771.323_428_777_653_1, -176.615_029_162_140_6, 12.507_343_278_686_905,
	-0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
	1.505_632_735_149_311_6e-7,
]);

/**
 * ln Γ(x) for x > 0, by Lanczos.
 * @param {number} x
 */
function lnGamma(x) {
	const z = x - 1;
	const [c0, ...rest] = LANCZOS;
	let a = c0;
	for (const [i, c] of rest.entries()) a += c / (z + i + 1);
	const t = z + 7.5;
	return (
		0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
	);
}

/**
 * The chi-square survival function, P(X ≥ x) on `df` degrees of freedom: the
 * regularised upper incomplete gamma Q(df/2, x/2), by its series below
 * a + 1 and its continued fraction above (Numerical Recipes 6.2).
 * @param {number} x
 * @param {number} df
 */
function chiSquareSf(x, df) {
	if (x <= 0) return 1;
	const a = df / 2;
	const h = x / 2;
	const front = Math.exp(-h + a * Math.log(h) - lnGamma(a));
	if (h < a + 1) {
		let term = 1 / a;
		let sum = term;
		for (let n = 1; n < MAX_GAMMA_TERMS; n++) {
			term *= h / (a + n);
			sum += term;
			if (Math.abs(term) < Math.abs(sum) * GAMMA_TOLERANCE) break;
		}
		return 1 - sum * front;
	}
	let b = h + 1 - a;
	let c = 1 / TINY;
	let d = 1 / b;
	let f = d;
	for (let i = 1; i < MAX_GAMMA_TERMS; i++) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < TINY) d = TINY;
		c = b + an / c;
		if (Math.abs(c) < TINY) c = TINY;
		d = 1 / d;
		const step = d * c;
		f *= step;
		if (Math.abs(step - 1) < GAMMA_TOLERANCE) break;
	}
	return front * f;
}

/**
 * @param {number[]} u
 * @param {number[]} v
 */
const dot = (u, v) => u.reduce((acc, x, i) => acc + x * (v[i] ?? 0), 0);

/**
 * @param {number[][]} m
 * @param {number[]} v
 */
const matVec = (m, v) => m.map((row) => dot(row, v));

/**
 * Xᵀ diag(w) X.
 * @param {number[][]} xs
 * @param {number[]} w
 */
function weightedGram(xs, w) {
	const k = xs[0]?.length ?? 0;
	return Array.from({ length: k }, (_i, i) =>
		Array.from({ length: k }, (_j, j) =>
			xs.reduce(
				(acc, x, r) => acc + (x[i] ?? 0) * (x[j] ?? 0) * (w[r] ?? 0),
				0,
			),
		),
	);
}

/**
 * Subtract `f` times `src` from `dst`, in place.
 * @param {number[]} dst accumulator: rewritten in place
 * @param {number[]} src
 * @param {number} f
 */
function subtractRow(dst, src, f) {
	for (let j = 0; j < dst.length; j++)
		dst[j] = (dst[j] ?? 0) - f * (src[j] ?? 0);
}

/**
 * The row at or below `c` with the largest entry in column `c`.
 * @param {number[][]} a
 * @param {number} c
 */
function pivotIndex(a, c) {
	let p = c;
	for (let r = c + 1; r < a.length; r++)
		if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[p]?.[c] ?? 0)) p = r;
	return p;
}

/**
 * The inverse of a small symmetric positive-definite matrix, by Gauss–Jordan
 * with partial pivoting.
 * @param {number[][]} m
 */
function invert(m) {
	const n = m.length;
	const a = m.map((row, i) => [
		...row,
		...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
	]);
	for (let c = 0; c < n; c++) {
		const p = pivotIndex(a, c);
		[a[c], a[p]] = [a[p] ?? [], a[c] ?? []];
		const pivotRow = a[c] ?? [];
		const pivot = pivotRow[c] ?? 0;
		if (Math.abs(pivot) < SINGULAR_PIVOT)
			throw new Error("singular information matrix");
		subtractRow(pivotRow, pivotRow, 1 - 1 / pivot);
		for (const [r, row] of a.entries())
			if (r !== c) subtractRow(row, pivotRow, row[c] ?? 0);
	}
	return a.map((row) => row.slice(n));
}

/**
 * @param {number[][]} xs
 * @param {number} k
 */
const transpose = (xs, k) =>
	Array.from({ length: k }, (_, j) => xs.map((x) => x[j] ?? 0));

/**
 * A Poisson GLM's coefficients by IRLS, and the
 * fitted means.
 * @param {number[][]} xs
 * @param {number[]} ys
 * @param {number[]} start
 */
function fitPoisson(xs, ys, start) {
	let beta = start;
	const transposed = transpose(xs, start.length);
	const meansOf = (/** @type {number[]} */ b) =>
		xs.map((x) => Math.exp(dot(x, b)));
	for (let i = 0; i < MAX_IRLS_PASSES; i++) {
		const mu = meansOf(beta);
		const gradient = matVec(
			transposed,
			ys.map((y, r) => y - (mu[r] ?? 0)),
		);
		const step = matVec(invert(weightedGram(xs, mu)), gradient);
		beta = beta.map((b, j) => b + (step[j] ?? 0));
		if (Math.max(...step.map(Math.abs)) < IRLS_STEP_TOLERANCE)
			return { beta, mu: meansOf(beta) };
	}
	throw new Error(`IRLS did not converge in ${MAX_IRLS_PASSES} passes`);
}

/**
 * Why `scored` gives no arm ratio, or null where it does.
 * @param {Scored[]} rows the runs of tasks scoring above 0
 * @param {string[]} arms
 */
function noRatio(rows, arms) {
	if (rows.length === 0) return "no task scored above 0";
	const zero = arms.find((a) => !rows.some((s) => s.arm === a && s.score > 0));
	return zero ? `arm ${zero} scored 0 in every run, so no ratio` : null;
}

/**
 * The design matrix of arm on task strata: column 0 is 1 for `treated`, then
 * one indicator column per task.
 * @param {Scored[]} rows
 * @param {string[]} tasks
 * @param {string} treated
 */
const armDesign = (rows, tasks, treated) =>
	rows.map((s) => [
		s.arm === treated ? 1 : 0,
		...tasks.map((t) => (t === s.task ? 1 : 0)),
	]);

/**
 * The arm coefficient's HC0 sandwich standard error,
 * (XᵀWX)⁻¹ Xᵀ diag(e²) X (XᵀWX)⁻¹ at row 0.
 * @param {number[][]} xs
 * @param {number[]} w the fit's weights: the Poisson means, or 1 for least squares
 * @param {number[]} e the residuals
 */
function armSe(xs, w, e) {
	const bread = invert(weightedGram(xs, w));
	const meat = weightedGram(
		xs,
		e.map((r) => r ** 2),
	);
	const row0 = bread[0] ?? [];
	return Math.sqrt(dot(row0, matVec(meat, row0)));
}

/**
 * An arm effect on the log scale as its ratio, interval and p.
 * @param {number} b
 * @param {number} se
 */
const ratioOf = (b, se) => ({
	ratio: Math.exp(b),
	ci95: [Math.exp(b - Z_ALPHA * se), Math.exp(b + Z_ALPHA * se)],
	p: se > 0 ? twoSidedP(b / se) : null,
	logSe: se,
});

/**
 * The arm compared against `baseline`, or why there is none: the rows must
 * carry exactly two arms, `baseline` one of them.
 * @param {{ arm: string }[]} rows
 * @param {string} baseline
 * @returns {{ arms: string[], treated: string } | { error: string }}
 */
function twoArms(rows, baseline) {
	const arms = [...new Set(rows.map((s) => s.arm))].sort();
	const treated = arms.find((a) => a !== baseline);
	return arms.length === 2 && arms.includes(baseline) && treated
		? { arms, treated }
		: { error: `needs exactly two arms, one of them ${baseline}` };
}

/**
 * D3's primary analysis: a Poisson regression of score on arm with each task
 * a fixed stratum, and session-level robust (sandwich, HC0) standard errors.
 * A task scoring 0 in every run is dropped: its stratum's estimate runs to −∞.
 * @param {Scored[]} scored
 * @param {string} baseline the arm the rate ratio is read against
 */
function poissonArm(scored, baseline) {
	const pair = twoArms(scored, baseline);
	if ("error" in pair) return pair;
	const { arms, treated } = pair;
	/** @type {Map<string, number[]>} */
	const byTask = new Map();
	for (const s of scored)
		byTask.set(s.task, [...(byTask.get(s.task) ?? []), s.score]);
	const tasks = [...byTask]
		.filter(([, scores]) => scores.some((x) => x > 0))
		.map(([task]) => task);
	const rows = scored.filter((s) => tasks.includes(s.task));
	const why = noRatio(rows, arms);
	if (why) return { error: why };
	const xs = armDesign(rows, tasks, treated);
	const ys = rows.map((s) => s.score);
	const start = [
		0,
		...tasks.map((t) => Math.log(meanVar(byTask.get(t) ?? []).mean)),
	];
	const { beta, mu } = fitPoisson(xs, ys, start);
	const se = armSe(
		xs,
		mu,
		ys.map((y, r) => y - (mu[r] ?? 0)),
	);
	const { ratio, ...interval } = ratioOf(beta[0] ?? 0, se);
	return {
		baseline,
		treated,
		rateRatio: ratio,
		...interval,
		tasksUsed: tasks.length,
		n: rows.length,
	};
}

/**
 * workflow-core#2241's within-task ratio of geometric means: least squares of ln(value)
 * on arm with task strata, HC0 errors.
 * @param {Scored[]} scored `score` is the value compared, a wall time or a spend, each above 0
 * @param {string} baseline
 */
function geoMeanRatio(scored, baseline) {
	const pair = twoArms(scored, baseline);
	if ("error" in pair) return pair;
	const { treated } = pair;
	if (scored.some((s) => !(s.score > 0)))
		return { error: "a value at or under 0 has no logarithm" };
	const tasks = [...new Set(scored.map((s) => s.task))];
	const xs = armDesign(scored, tasks, treated);
	const ys = scored.map((s) => Math.log(s.score));
	const ones = xs.map(() => 1);
	const beta = matVec(
		invert(weightedGram(xs, ones)),
		matVec(transpose(xs, tasks.length + 1), ys),
	);
	const e = scored.map(
		(s) =>
			Math.log(s.score) - dot(armDesign([s], tasks, treated)[0] ?? [], beta),
	);
	return {
		baseline,
		treated,
		...ratioOf(beta[0] ?? 0, armSe(xs, ones, e)),
		tasksUsed: tasks.length,
		n: scored.length,
	};
}

/**
 * workflow-core#2241's acceptance comparison: the Mantel–Haenszel odds ratio of passing in
 * the treated arm against `baseline` over task strata, with the Robins–
 * Breslow–Greenland interval and the Cochran–Mantel–Haenszel test without
 * continuity correction, as statsmodels' StratifiedTable gives them. A
 * stratum of one run carries nothing and is left out.
 * @param {{ task: string, arm: string, pass: boolean }[]} judged
 * @param {string} baseline
 */
function mantelHaenszel(judged, baseline) {
	const pair = twoArms(judged, baseline);
	if ("error" in pair) return pair;
	const { treated } = pair;
	/** Sums over strata in Robins–Breslow–Greenland's R, Q, PR, PQ + QR and QS, then the CMH test's observed, expected and variance. */
	const t = { r: 0, q: 0, pr: 0, psqr: 0, qs: 0, obs: 0, exp: 0, v: 0 };
	for (const task of new Set(judged.map((s) => s.task))) {
		const cell = (/** @type {string} */ arm, /** @type {boolean} */ pass) =>
			judged.filter((s) => s.task === task && s.arm === arm && s.pass === pass)
				.length;
		const a = cell(treated, true);
		const b = cell(treated, false);
		const c = cell(baseline, true);
		const d = cell(baseline, false);
		const n = a + b + c + d;
		if (n < 2) continue;
		const r = (a * d) / n;
		const q = (b * c) / n;
		const p = (a + d) / n;
		t.r += r;
		t.q += q;
		t.pr += p * r;
		t.psqr += p * q + (1 - p) * r;
		t.qs += (1 - p) * q;
		t.obs += a;
		t.exp += ((a + b) * (a + c)) / n;
		t.v += ((a + b) * (c + d) * (a + c) * (b + d)) / (n ** 2 * (n - 1));
	}
	if (t.r === 0 || t.q === 0)
		return { error: "the pooled odds ratio is 0 or infinite" };
	const se = Math.sqrt(
		t.pr / (2 * t.r ** 2) + t.psqr / (2 * t.r * t.q) + t.qs / (2 * t.q ** 2),
	);
	const { ratio, ci95 } = ratioOf(Math.log(t.r / t.q), se);
	return {
		baseline,
		treated,
		oddsRatio: ratio,
		ci95,
		p: t.v > 0 ? chiSquareSf((t.obs - t.exp) ** 2 / t.v, 1) : null,
	};
}

/**
 * workflow-core#2241's arm × period check, post hoc: Cochran's Q over each period's log
 * rate ratio weighted by its inverse variance, on k − 1 df.
 * @param {{ rateRatio: number, logSe: number }[]} fits one per period
 */
function heterogeneity(fits) {
	const points = fits.map((f) => ({
		w: 1 / f.logSe ** 2,
		l: Math.log(f.rateRatio),
	}));
	const total = points.reduce((a, p) => a + p.w, 0);
	const pooled = points.reduce((a, p) => a + p.l * p.w, 0) / total;
	const q = points.reduce((a, p) => a + p.w * (p.l - pooled) ** 2, 0);
	const df = fits.length - 1;
	return { q, df, p: df > 0 ? chiSquareSf(q, df) : null };
}

/** @param {number[]} xs */
const geoMean = (xs) =>
	xs.length > 0
		? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length)
		: null;

/**
 * workflow-core#2241's comparison of a positive per-run value, a wall time or a spend:
 * each arm's geometric mean, their within-task ratio, and Mann–Whitney.
 * @param {Scored[]} values
 * @param {string} baseline
 */
function geoComparison(values, baseline) {
	const arms = [...new Set(values.map((s) => s.arm))].sort();
	const of = (/** @type {string | undefined} */ arm) =>
		values.filter((s) => s.arm === arm).map((s) => s.score);
	return {
		byArm: Object.fromEntries(arms.map((a) => [a, geoMean(of(a))])),
		ratio: geoMeanRatio(values, baseline),
		mannWhitney: mannWhitney(
			of(baseline),
			of(arms.find((a) => a !== baseline)),
		),
	};
}

/**
 * D3's cross-check: Mann–Whitney U on the score per session, two-sided, by the
 * normal approximation with the tie correction.
 * @param {number[]} a
 * @param {number[]} b
 */
function mannWhitney(a, b) {
	const n1 = a.length;
	const n2 = b.length;
	if (n1 === 0 || n2 === 0) return { error: "an arm has no scored run" };
	const all = [
		...a.map((v) => ({ v, g: 0 })),
		...b.map((v) => ({ v, g: 1 })),
	].sort((x, y) => x.v - y.v);
	/** @type {number[]} */
	const ranks = [];
	let tieTerm = 0;
	for (let i = 0; i < all.length; ) {
		let j = i;
		while (j < all.length && all[j]?.v === all[i]?.v) j++;
		const t = j - i;
		tieTerm += t ** 3 - t;
		for (let r = i; r < j; r++) ranks[r] = (i + j + 1) / 2;
		i = j;
	}
	const r1 = all.reduce(
		(acc, x, i) => acc + (x.g === 0 ? (ranks[i] ?? 0) : 0),
		0,
	);
	const u = r1 - (n1 * (n1 + 1)) / 2;
	const n = n1 + n2;
	const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
	const z = variance > 0 ? (u - (n1 * n2) / 2) / Math.sqrt(variance) : 0;
	return { u, z, p: variance > 0 ? twoSidedP(z) : 1 };
}

module.exports = {
	geoComparison,
	geoMeanRatio,
	heterogeneity,
	mannWhitney,
	mantelHaenszel,
	meanVar,
	poissonArm,
	runsPerArm,
	withinTask,
};
