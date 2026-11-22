/* #5401 */
const NUMBER = "(\\d[\\d,]*(?:\\.\\d+)?)";
const BASELINE_RE = new RegExp(
	`\\bbaseline\\s+(\\d+)\\s*/\\s*${NUMBER}\\s+([^;(]*)`,
	"i",
);
const STATED_RE = new RegExp(
	`\\bpass\\s*=\\s*(\\d+)\\s[^;=]*?\\bn\\s*=\\s*${NUMBER}\\s+([^;(]*)`,
	"i",
);
const CONFIDENCE_RE = /(?<![\d.])(\d+(?:\.\d+)?)%\s+one-sided/i;
const TARGET_RE = /\btarget\s+(\d+(?:\.\d+)?)%/i;
const UNIT_STOP = new Set(["a", "an", "the", "of", "on", "in", "per", "more"]);
const MAX_TRIALS = 10_000_000;

/** @typedef {"conditional"|"fisher"|"binomial"} WindowMethod */
/** @type {Record<WindowMethod, string>} */
const METHOD_SAYS = {
	conditional: "the conditional Poisson test",
	fisher: "one-sided Fisher",
	binomial: "the exact binomial against the target",
};

/** @param {string} basis @returns {WindowMethod|null} */
function methodOf(basis) {
	if (/\bFisher\b/i.test(basis)) return "fisher";
	if (/\bconditional\b/i.test(basis)) return "conditional";
	if (/\bexact binomial\b|\brule of three\b/i.test(basis)) return "binomial";
	return null;
}

/** @param {string} written */
const numberOf = (written) => Number(written.replace(/,/g, ""));

/** @param {string} phrase */
const unitWords = (phrase) =>
	new Set(
		phrase
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter((w) => w && !UNIT_STOP.has(w))
			.slice(0, 3)
			.map((w) => w.replace(/s$/, "")),
	);

/** @param {string} a @param {string} b */
function sameUnit(a, b) {
	const of = unitWords(a);
	return [...unitWords(b)].some((w) => of.has(w));
}

/** @param {number} k @param {number} t1 @param {number} alpha */
const conditionalWindow = (k, t1, alpha) => t1 * (alpha ** (-1 / k) - 1);

/** @param {number} k @param {number} big @param {number} alpha */
function fisherWindow(k, big, alpha) {
	for (let n = 1; n <= MAX_TRIALS; n++) {
		let p = 1;
		for (let i = 0; i < k; i++) p *= (big - i) / (big + n - i);
		if (p <= alpha) return n;
	}
	return null;
}

/** @param {number} target @param {number} alpha */
function binomialRange(target, alpha) {
	const exact = Math.ceil(Math.log(alpha) / Math.log(1 - target) - 1e-9);
	const rule = Math.abs(alpha - 0.05) < 1e-12 ? 3 : -Math.log(alpha);
	return {
		low: exact,
		high: Math.max(exact, Math.ceil(rule / target - 1e-9)),
	};
}

/** @param {string} written */
const decimalsOf = (written) => written.split(".")[1]?.length ?? 0;

/** @param {number} value @param {number} places @param {"round"|"ceil"} how */
function toPlaces(value, places, how) {
	const scale = 10 ** places;
	return Math[how](value * scale - (how === "ceil" ? 1e-9 : 0)) / scale;
}

/**
 * @typedef {{method: WindowMethod, k: number, big: number, base: string,
 *   alpha: number, level: string, n: number, stated: string,
 *   target: string|undefined}} Figures
 * @typedef {{computed: string, holds: boolean, figures: string}} Computed
 * @typedef {{method: WindowMethod, stated: string, computed: string,
 *   says: string, holds: boolean}} WindowReading
 */

/**
 * @param {string} basis
 * @returns {Figures|null}
 */
function figuresOf(basis) {
	const method = methodOf(basis);
	const base = BASELINE_RE.exec(basis);
	const pass = STATED_RE.exec(basis);
	const confidence = CONFIDENCE_RE.exec(basis);
	if (!method || !base || !pass || !confidence || pass[1] !== "0") return null;
	const [, kWritten = "", bigWritten = "", baseUnit = ""] = base;
	const [, , stated = "", statedUnit = ""] = pass;
	if (!sameUnit(baseUnit, statedUnit)) return null;
	const level = confidence[1] ?? "";
	const alpha = 1 - Number(level) / 100;
	const big = numberOf(bigWritten);
	if (!(alpha > 0 && alpha < 1) || !(big > 0)) return null;
	return {
		method,
		k: Number(kWritten),
		big,
		base: `baseline ${kWritten}/${bigWritten}`,
		alpha,
		level,
		n: numberOf(stated),
		stated,
		target: TARGET_RE.exec(basis)?.[1],
	};
}

/** @type {Record<WindowMethod, (f: Figures) => Computed|null>} */
const COMPUTE = {
	binomial: ({ target, alpha, n }) => {
		const p = Number(target) / 100;
		if (!(p > 0 && p < 1)) return null;
		const { low, high } = binomialRange(p, alpha);
		return {
			computed: low === high ? `${low}` : `${low} to ${high}`,
			holds: n >= low && n <= high,
			figures: `target ${target}%`,
		};
	},
	fisher: ({ k, big, alpha, n, base }) => {
		const least = k < 1 || k > big ? null : fisherWindow(k, big, alpha);
		return least === null
			? null
			: { computed: `${least}`, holds: n === least, figures: base };
	},
	conditional: ({ k, big, alpha, n, stated, base }) => {
		if (k < 1) return null;
		const exact = conditionalWindow(k, big, alpha);
		const places = decimalsOf(stated);
		const shown = [
			toPlaces(exact, places, "round"),
			toPlaces(exact, places, "ceil"),
		];
		return {
			computed: (shown[0] ?? exact).toFixed(places),
			holds: shown.some((v) => Math.abs(v - n) < 1e-9),
			figures: base,
		};
	},
};

/**
 * @param {string} basis
 * @returns {WindowReading|null}
 */
function readWindow(basis) {
	const f = figuresOf(basis);
	const c = f && COMPUTE[f.method](f);
	if (!f || !c) return null;
	return {
		method: f.method,
		stated: f.stated,
		computed: c.computed,
		says: `${METHOD_SAYS[f.method]}, ${c.figures} at ${f.level}% one-sided`,
		holds: c.holds,
	};
}

module.exports = { readWindow, conditionalWindow, fisherWindow };
