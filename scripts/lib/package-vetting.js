/*
 * package-vetting.js — what the two install cores share when they vet a new
 * package against its registry: lib/npm-install.js against npm, and
 * lib/pip-install.js against PyPI (#5232).
 *
 * Each core reads its own commands and asks its own registry; this holds the
 * floors a package must clear, the wall-clock budget the asking runs inside,
 * the refusal texts and the escape both cores honour.
 *
 * THE THRESHOLDS, and what in them is a judgement.
 *
 *   MIN_AGE_DAYS=180, MIN_DOWNLOADS=1000 per month.
 *
 * Neither is a measurement; both are chosen for margin (mantahostels#1767).
 * The margin over mantahostels' own dependencies is on mantahostels#1803.
 *
 * THE ESCAPE, `allowNewPackage`, is `WFC_ALLOW_NEW_PACKAGE` in the HOOK's
 * environment, never a leading assignment on the command, which is read but
 * not honoured: an escape a session can spell for itself is not a deny
 * (mantahostels#109). It stands down the registry check alone.
 *
 * WHAT THIS DOES NOT COVER (mantahostels#1767): a legitimate package LATER
 * COMPROMISED. Nothing here is a substitute for a committed lockfile.
 */

const { ruleOrFallback } = require("./guard-verdict.js");

const MIN_AGE_DAYS = 180;
const MIN_DOWNLOADS = 1000;

/* THE WALL-CLOCK BUDGET, in seconds. The dispatcher's 60 s timeout is not a
 * verdict: a hook killed at the ceiling refuses through `"onFailure":
 * "block"`, naming nothing it checked. So a core stops asking its registry at
 * 30 s and refuses on what it could not check, saying which.
 *
 * 30 s, not 40: the budget is tested BEFORE each package and one package costs
 * up to 20 s of registry calls (each core's host), so a 40 s budget could
 * start a package at 39 s and finish at 59 s — inside the ceiling only by luck
 * (mantahostels#1803's review, H4). The 30 s run from the dispatcher's start,
 * not the core's, so the cores ahead of it spend from them, and 30 + 20
 * leaves 10 s for the output write. */
const BUDGET_S = 30;

/**
 * @typedef {{ missing: true } | { status: number | null, stdout: string }} Call
 *   a registry call: `missing` where its program could not be started, else
 *   its exit status (null where it was killed) and stdout
 * @typedef {object} VettingPorts
 * @property {() => number} now the clock, in epoch milliseconds
 * @property {() => number} startedAt when the dispatcher started, in epoch
 *   milliseconds; the budget runs from it
 * @property {boolean} allowNewPackage `WFC_ALLOW_NEW_PACKAGE` set in the
 *   hook's own environment
 * @typedef {import("./guard-verdict.js").RulePorts & VettingPorts} VettingContext
 * @typedef {"missing" | "young" | "thin" | "budget" | "unreachable"} Refusal
 * @typedef {{ kind: "ok" } | { kind: Refusal, n: string }} RegistryVerdict
 */

/** @type {RegistryVerdict} */
const UNREACHABLE = { kind: "unreachable", n: "" };
/** @type {RegistryVerdict} */
const OK = { kind: "ok" };

/** @param {number} ms */
const seconds = (ms) => Math.floor(ms / 1000);

/**
 * @param {string} text
 * @returns {unknown} the parsed value, or null where it is not JSON
 */
function jsonOf(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * The age verdict of a package first published at `created`: unreachable
 * where that is no date, young under the floor, else ok.
 * @param {unknown} created an ISO date string
 * @param {VettingContext} ctx
 * @returns {RegistryVerdict}
 */
function ageOf(created, ctx) {
	if (typeof created !== "string" || !created) return UNREACHABLE;
	const epochMs = Date.parse(created);
	if (Number.isNaN(epochMs)) return UNREACHABLE;
	/* Whole seconds each side and a division truncating towards zero. */
	const days = Math.trunc((seconds(ctx.now()) - seconds(epochMs)) / 86_400);
	return days < MIN_AGE_DAYS ? { kind: "young", n: String(days) } : OK;
}

/**
 * The downloads verdict of last month's figure: unreachable where it is no
 * whole number, thin under the floor, else ok.
 * @param {unknown} dl
 * @returns {RegistryVerdict}
 */
function downloadsOf(dl) {
	const figure =
		typeof dl === "number" || typeof dl === "string" ? String(dl) : "";
	if (!/^[0-9]+$/.test(figure)) return UNREACHABLE;
	return Number(figure) < MIN_DOWNLOADS ? { kind: "thin", n: figure } : OK;
}

/* ----------------------------------------------------------------------- */
/* The refusals.                                                           */
/* ----------------------------------------------------------------------- */

/** @param {VettingContext} ctx */
const escapeNote = (ctx) =>
	`The escape is \`WFC_ALLOW_NEW_PACKAGE=1\` in the environment Claude Code itself
was started in — NOT on this command line, which is read but never honoured: ${ruleOrFallback(ctx, "self-spelt-escape", "an escape a session can spell for itself is not a deny")} Otherwise ask the
founder to run the install from their own terminal, which sees no hook.`;

/**
 * The rule a legitimacy refusal prints whole, so no always-loaded file need
 * carry it (#5232).
 * @param {VettingContext} ctx
 */
const vettedRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"new-package-vetted",
		"verify a new package on its registry before installing it",
	);

/**
 * The legitimacy refusals. Each core passes its registry's two phrases whole,
 * so the fire needles keyed on them (scripts/guard-fire-needles.json) stay
 * literal in that core's own file.
 * @param {{ exists: string, unreached: string }} on `exists`: "exists on
 *   <the registry>"; `unreached`: "<The registry> could not be reached to
 *   check"
 * @returns {Record<Refusal, (name: string, n: string, ctx: VettingContext) => string>}
 */
function registryTexts(on) {
	return {
		missing: (name, _n, ctx) =>
			`No package named \`${name}\` ${on.exists}: @CMD@

That is the shape of a hallucinated name. Roughly one in five package references generated by a code model does not exist (Spracklen et al., USENIX Security 2025), and 43% of those names recur across re-runs — which is what makes pre-registering them worth an attacker's time. Check the name against the tool's own documentation before trying again.

${vettedRule(ctx)}`,
		young: (name, days, ctx) =>
			`\`${name}\` was first published ${days} days ago, under this guard's ${MIN_AGE_DAYS}-day floor: @CMD@

A squat registered against a hallucinated name is days old. A genuinely new package that this project needs is a founder decision, not a session's.

${vettedRule(ctx)}

${escapeNote(ctx)}`,
		thin: (name, dl, ctx) =>
			`\`${name}\` was downloaded ${dl} time(s) last month, under this guard's floor of ${MIN_DOWNLOADS}: @CMD@

A package worth installing has real download history. This has none, which is what a squatted name looks like from the outside.

${vettedRule(ctx)}

${escapeNote(ctx)}`,
		budget: (name, _n, ctx) =>
			`This guard ran out of its own time budget before it could check \`${name}\`, so nothing is known about it: @CMD@

The budget is ${BUDGET_S} s from the hook's start, under its 60 s ceiling — a hook killed at that ceiling is refused without saying which package was unchecked. Install one package at a time and each gets checked.

${vettedRule(ctx)}

${escapeNote(ctx)}`,
		unreachable: (name, _n, ctx) =>
			`${on.unreached} \`${name}\`, so this install proceeds on nothing: @CMD@

An install whose name, age and download history went unchecked is what this guard exists to prevent, so an unreachable registry refuses rather than waving it through (mantahostels#1767).

${vettedRule(ctx)}

${escapeNote(ctx)}`,
	};
}

/**
 * The refusal of a spec the registry cannot be asked about.
 * @param {string} spec
 * @param {string} kinds the spellings that bypass the registry, in prose
 * @param {VettingContext} ctx
 */
const unvettableText = (spec, kinds, ctx) =>
	`This install names a spec the registry cannot be asked about, so its legitimacy is unverifiable: \`${spec}\`

@CMD@

${kinds} all bypass the checks this guard runs on a new package — that the name exists, its age, its download history. None of them can be answered for a spec that never touches the registry.

${vettedRule(ctx)}

${escapeNote(ctx)}`;

/**
 * The refusal for the first new package the registry does not vouch for, or
 * null where every one clears. The budget is tested BEFORE each package.
 * @param {string[]} fresh
 * @param {VettingContext} ctx
 * @param {(name: string) => RegistryVerdict} verdictOf one package's
 *   registry verdict
 * @param {ReturnType<typeof registryTexts>} texts
 * @returns {string | null}
 */
function legitimacy(fresh, ctx, verdictOf, texts) {
	const deadline = seconds(ctx.startedAt()) + BUDGET_S;
	for (const name of fresh) {
		/** @type {RegistryVerdict} */
		const v =
			seconds(ctx.now()) >= deadline
				? { kind: "budget", n: "" }
				: verdictOf(name);
		if (v.kind !== "ok") return texts[v.kind](name, v.n, ctx);
	}
	return null;
}

module.exports = {
	BUDGET_S,
	MIN_AGE_DAYS,
	MIN_DOWNLOADS,
	OK,
	UNREACHABLE,
	ageOf,
	downloadsOf,
	jsonOf,
	legitimacy,
	registryTexts,
	unvettableText,
};
