/* workflow-core#5401 */
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
const LOWER_BOUND_TARGET_RE = /\btarget\s+[\d.]+%\s*\([^)]*\blower bound\b/i;
const UNIT_STOP = new Set(["a", "an", "the", "of", "on", "in", "per", "more"]);
// guess: a unit phrase's head noun sits in its first three words, `VM boots on a Windows` (workflow-core#5406)
const UNIT_HEAD_WORDS = 3;
// guess: a million times the largest live baseline, 1842 minutes on workflow-core#5346 (workflow-core#5406)
const MAX_TRIALS = 10_000_000;
// guess: far under a stated window's last decimal, far over float error near 1e4 (workflow-core#5406)
const EPSILON = 1e-9;
const RULE_OF_THREE_ALPHA = 0.05;

/** @typedef {"conditional"|"fisher"|"binomial"} WindowMethod */
/** @type {Record<WindowMethod, string>} */
const METHOD_SAYS = {
	conditional: "the conditional Poisson test",
	fisher: "one-sided Fisher",
	binomial: "the exact binomial against the target",
};

/** @param {string} basis @returns {WindowMethod|null} */
function parseMethod(basis) {
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
			.slice(0, UNIT_HEAD_WORDS)
			.map((w) => w.replace(/s$/, "")),
	);

/** @param {string} a @param {string} b */
function isSameUnit(a, b) {
	const of = unitWords(a);
	return [...unitWords(b)].some((w) => of.has(w));
}

/** @param {number} k @param {number} baseSize @param {number} alpha */
const conditionalWindow = (k, baseSize, alpha) =>
	baseSize * (alpha ** (-1 / k) - 1);

/** @param {number} k @param {number} baseSize @param {number} alpha */
function fisherWindow(k, baseSize, alpha) {
	for (let n = 1; n <= MAX_TRIALS; n++) {
		let p = 1;
		for (let i = 0; i < k; i++) p *= (baseSize - i) / (baseSize + n - i);
		if (p <= alpha) return n;
	}
	return null;
}

/** @param {number} target @param {number} alpha */
function binomialRange(target, alpha) {
	const exact = Math.ceil(Math.log(alpha) / Math.log(1 - target) - EPSILON);
	const rule =
		Math.abs(alpha - RULE_OF_THREE_ALPHA) < EPSILON ? 3 : -Math.log(alpha);
	return {
		low: exact,
		high: Math.max(exact, Math.ceil(rule / target - EPSILON)),
	};
}

/** @param {string} written */
const decimalsOf = (written) => written.split(".")[1]?.length ?? 0;

/** @param {number} value @param {number} places @param {"round"|"ceil"} how */
function toPlaces(value, places, how) {
	const scale = 10 ** places;
	return Math[how](value * scale - (how === "ceil" ? EPSILON : 0)) / scale;
}

/**
 * @typedef {{method: WindowMethod, k: number, baseSize: number, base: string,
 *   alpha: number, level: string, n: number, stated: string,
 *   target: string|undefined, note: string}} Figures
 * @typedef {{computed: string, holds: boolean, figures: string}} Computed
 * @typedef {{method: WindowMethod, stated: string, computed: string,
 *   says: string, holds: boolean}} WindowReading
 */

/**
 * @param {string} basis
 * @param {WindowMethod} written
 * @param {number} k
 */
function methodFor(basis, written, k) {
	const isBoundTarget =
		written === "binomial" && k >= 1 && LOWER_BOUND_TARGET_RE.test(basis);
	return isBoundTarget
		? {
				method: /** @type {const} */ ("fisher"),
				note: " (its target is the baseline's lower bound, which sizes a before/after question by the two-sample test)",
			}
		: { method: written, note: "" };
}

/**
 * @param {string} basis
 * @returns {Figures|null}
 */
function parseFigures(basis) {
	const written = parseMethod(basis);
	const base = BASELINE_RE.exec(basis);
	const pass = STATED_RE.exec(basis);
	const confidence = CONFIDENCE_RE.exec(basis);
	if (!written || !base || !pass || !confidence || pass[1] !== "0") return null;
	const [, kWritten = "", sizeWritten = "", baseUnit = ""] = base;
	const [, , stated = "", statedUnit = ""] = pass;
	if (!isSameUnit(baseUnit, statedUnit)) return null;
	const level = confidence[1] ?? "";
	const alpha = 1 - Number(level) / 100;
	const baseSize = numberOf(sizeWritten);
	if (!(alpha > 0 && alpha < 1) || !(baseSize > 0)) return null;
	const k = Number(kWritten);
	return {
		...methodFor(basis, written, k),
		k,
		baseSize,
		base: `baseline ${kWritten}/${sizeWritten}`,
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
	fisher: ({ k, baseSize, alpha, n, base }) => {
		const least =
			k < 1 || k > baseSize ? null : fisherWindow(k, baseSize, alpha);
		return least === null
			? null
			: { computed: `${least}`, holds: n === least, figures: base };
	},
	conditional: ({ k, baseSize, alpha, n, stated, base }) => {
		if (k < 1) return null;
		const exact = conditionalWindow(k, baseSize, alpha);
		const places = decimalsOf(stated);
		const shown = [
			toPlaces(exact, places, "round"),
			toPlaces(exact, places, "ceil"),
		];
		return {
			computed: (shown[0] ?? exact).toFixed(places),
			holds: shown.some((v) => Math.abs(v - n) < EPSILON),
			figures: base,
		};
	},
};

/**
 * @param {string} basis
 * @returns {WindowReading|null}
 */
function parseWindow(basis) {
	const f = parseFigures(basis);
	const c = f && COMPUTE[f.method](f);
	if (!f || !c) return null;
	return {
		method: f.method,
		stated: f.stated,
		computed: c.computed,
		says: `${METHOD_SAYS[f.method]}, ${c.figures} at ${f.level}% one-sided${f.note}`,
		holds: c.holds,
	};
}

module.exports = { parseWindow };
