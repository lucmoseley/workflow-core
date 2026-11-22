const path = require("node:path");
const { matchSensitivePaths, withNarrowing } = require("./sensitive-paths.js");
const { reviewSuffix } = require("./review-suffix.js");
const { CONFIG_PATH } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { linkedTreeOrRoot } = require("./tree-or.js");

/**
 * @typedef {import("./sensitive-paths.js").Match} Match
 * @typedef {{
 *   commonDir: (dir: string) => string | null,
 *   staged: (tree: string) => string[] | null,
 *   sessionBase: (sid: string, tree: string) => string | null,
 *   changedSince: (tree: string, base: string) => string[] | null,
 *   billed: (sid: string, tree: string) => string[] | null,
 *   declared: (tree: string) => import("./workflow-core-config.js").SensitivePath[] | undefined,
 *   declaredAt: (tree: string, rev: string) => import("./workflow-core-config.js").SensitivePath[] | undefined,
 * }} TierPorts
 * @typedef {import("./core-contract.js").CoreContext & TierPorts} TierContext
 */

// guess, #1699
const PATHS_LISTED_MAX = 3;

/**
 * @param {string} skill
 * @param {TierContext} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(skill, ctx) {
	if (skill === "code-review:code-review") return null;
	if (skill !== "code-review" && !skill.endsWith(":code-review")) return null;
	if (
		skill === "code-review" &&
		!ctx.isFile(
			path.join(ctx.root, ".claude", "skills", "code-review", "SKILL.md"),
		)
	)
		return null;

	const tree = linkedTreeOrRoot(ctx);
	const base = sessionBaseIn(tree, ctx);
	const paths = [...stagedIn(tree, ctx), ...ownChanges(tree, base, ctx)];
	let declared;
	try {
		declared = ctx.declared(tree);
	} catch (e) {
		ctx.log(
			`the workflow-core config did not read — review tier not stated: ${caught(e).message}`,
		);
		return null;
	}
	const match = narrowedSince(
		matchSensitivePaths(declared, paths),
		declared,
		paths,
		{ tree, base, ctx },
	);

	if (match.state === "absent" && match.matched.length === 0) {
		const line = ruleOrFallback(
			ctx,
			"review-sensitive-undeclared",
			"No sensitive paths are declared, so no review here can escalate",
		);
		return { context: ctx.corePaths(line) };
	}
	const globless = match.globless.length > 0;
	if (match.matched.length === 0 && !globless) return null;

	const suffix = ctx.session ? reviewSuffix(ctx.session) : "";
	const prelude = `Sensitive paths declared in \`.claude/workflow-core.json\`:
${areaLines(match).join("\n")}
Focus and attack Artefact paths: \`.claude/tmp/review-focus${suffix}.md\`, \`.claude/tmp/review-attack${suffix}.md\`.`;

	const notLive = [...match.matched, ...match.globless].some((a) => !a.live);
	return tierDecision(prelude, notLive, globless);
}

/**
 * @param {Match} match
 * @param {import("./workflow-core-config.js").SensitivePath[] | undefined} declared
 * @param {string[]} paths
 * @param {{ tree: string, base: string | null, ctx: TierContext }} at
 * @returns {Match}
 */
function narrowedSince(match, declared, paths, { tree, base, ctx }) {
	if (!paths.includes(CONFIG_PATH)) return match;
	let out = match;
	for (const rev of base === null ? ["HEAD"] : ["HEAD", base]) {
		let before;
		try {
			before = ctx.declaredAt(tree, rev);
		} catch (e) {
			ctx.log(
				`the declaration at ${rev} did not read — a narrowing of it not checked: ${caught(e).message}`,
			);
			continue;
		}
		out = withNarrowing(out, before, declared, paths);
	}
	return out;
}

/**
 * @param {string} prelude
 * @param {boolean} notLive
 * @param {boolean} globless
 */
function tierDecision(prelude, notLive, globless) {
	if (notLive && globless)
		return {
			prelude,
			injectRules: [
				"review-tier-escalated",
				"review-focused-run",
				"review-attacker-run",
				"review-tier-records",
				"review-tier-globless",
				"review-tier-not-live",
			],
		};
	if (notLive)
		return {
			prelude,
			injectRules: [
				"review-tier-escalated",
				"review-focused-run",
				"review-attacker-run",
				"review-tier-records",
				"review-tier-not-live",
			],
		};
	if (globless)
		return {
			prelude,
			injectRules: [
				"review-tier-escalated",
				"review-focused-run",
				"review-attacker-run",
				"review-tier-records",
				"review-tier-globless",
			],
		};
	return {
		prelude,
		injectRules: [
			"review-tier-escalated",
			"review-focused-run",
			"review-attacker-run",
			"review-tier-records",
		],
	};
}

/**
 * @param {string} tree
 * @param {TierContext} ctx
 */
function stagedIn(tree, ctx) {
	const staged = ctx.staged(tree);
	if (staged !== null) return staged;
	ctx.log(
		`git diff --cached failed in ${tree} — its staged paths left unmatched`,
	);
	return [];
}

/**
 * @param {string} tree
 * @param {TierContext} ctx
 * @returns {string | null}
 */
function sessionBaseIn(tree, ctx) {
	if (!ctx.session) return null;
	try {
		return ctx.sessionBase(ctx.session, tree);
	} catch (e) {
		ctx.log(
			`this session's base did not place — its unstaged changes left unmatched: ${caught(e).message}`,
		);
		return null;
	}
}

/**
 * @param {string} tree
 * @param {string | null} base
 * @param {TierContext} ctx
 */
function ownChanges(tree, base, ctx) {
	if (base === null || !ctx.session) return [];
	const ledger = ctx.billed(ctx.session, tree);
	if (ledger === null) {
		ctx.log(
			"the write ledger did not read — this session's unstaged changes left unmatched",
		);
		return [];
	}
	const changed = ctx.changedSince(tree, base);
	if (changed === null) {
		ctx.log(
			`git diff or ls-files failed in ${tree} — this session's unstaged changes there left unmatched`,
		);
		return [];
	}
	const mine = new Set(ledger);
	return changed.filter((p) => mine.has(p));
}

/** @param {Match} match */
function areaLines(match) {
	/** @param {Match["matched"][number] | Match["globless"][number]} a */
	const area = (a) => {
		const where = "paths" in a ? ` (${listed(a.paths)})` : `: ${a.description}`;
		const examples =
			a.examples.length > 0 ? ` Examples: ${a.examples.join("; ")}.` : "";
		return `- \`${a.name}\`${where}, ${a.live ? "live" : "not live"}. Focus: ${a.focus}.${examples}`;
	};
	return [
		...(match.matched.length > 0
			? [
					"Tier owed: escalated. Sensitive areas this change touches:",
					...match.matched.map(area),
				]
			: []),
		...(match.globless.length > 0
			? ["Sensitive areas declared with no globs:", ...match.globless.map(area)]
			: []),
	];
}

/** @param {string[]} paths */
function listed(paths) {
	const more = paths.length - PATHS_LISTED_MAX;
	return `${paths.slice(0, PATHS_LISTED_MAX).join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

module.exports = { field: "skill", noun: "skill call", decide };
