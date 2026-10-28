/*
 * review-tier.js — the dispatcher core that hands a session the review tier
 * its change owes when it loads the code-review skill on a change touching a
 * declared sensitive path, and tells an adopter that has declared none that no
 * review can escalate (#1619, spec #1612 §Detection moments, §Skill-load lines
 * for the rollout, §Staged-review mode). Its production ports, git, the
 * session's start point and write ledger and the host's declaration, are
 * lib/review-tier-host.js.
 *
 * A CORE OF ITS OWN BESIDE guard-review-rules, NOT A PART OF IT, and ahead of
 * it in lib/guard-cores.json: the joined context puts the tier first, so a
 * long areas list pushes the review rules, not the tier, past the preview
 * (#1619), as inject-tracker-docs.sh's typed route does.
 *
 * IMPLICIT: on a Skill call naming `code-review`, matches the staged paths and the paths this session changed since its base, in the root and in the worktree of the root's repository the payload's `cwd` sits in, against the declared sensitive paths (lib/sensitive-paths.js); where an area matched or any globless area is declared, injects the tier owed, each area's focus, examples and `live` flag, the focus and attack Artefact paths, the escalated-review rules, the focused and attacker run briefs and the records to write (#1621); where `sensitivePaths` is absent, injects one line saying so.
 * JUSTIFIED: fail-safe — a change to a sensitive path reviewed at the standard tier misses the defects that cost money or leak data, and the vendored skill cannot carry the tier (spec #1612).
 * DEFEAT: any array value of `sensitivePaths`, `[]` included, silences the undeclared line; `scripts/clear-rule-latch.sh` clears the fragments' latch; listing `inject-review-tier` under the host's `disabled` silences it whole.
 *
 * THE AREAS RIDE IN THE PRELUDE, UNLATCHED, because they change with the diff:
 * a second review in one session is told its own areas. The rules after them
 * are fragments, latched once a session.
 *
 * LIMITS
 *  - Paths since the session base count only where this session wrote them
 *    or its own commits touched them, lib/code-signal.sh's attribution over
 *    `writes --committed` (mantahostels#114, #2390). Staged paths count
 *    whoever staged them: the staged state is what the commit carries.
 *  - A worktree outside the root adds its staged paths only (#2386). The
 *    declaration read is the root's in any worktree.
 *  - It fires on the Skill TOOL only, as guard-review-rules does. A typed
 *    `/code-review` reaches it through scripts/inject-tracker-docs.sh, which
 *    runs this core alone (`guard-dispatch.js --only inject-review-tier`) on
 *    a Skill payload of its own making (#1697).
 *  - It FAILS OPEN on anything it cannot resolve, and the fail-open is
 *    RECORDED (mantahostels#147).
 */

const path = require("node:path");
const { matchSensitivePaths } = require("./sensitive-paths.js");
const { reviewSuffix } = require("./review-suffix.js");
const { caught } = require("./caught.js");
const { ruleOrFallback } = require("./guard-verdict.js");

/**
 * @typedef {import("./sensitive-paths.js").Match} Match
 * @typedef {{
 *   topLevel: (dir: string) => string | null,
 *   commonDir: (dir: string) => string | null,
 *   staged: (tree: string) => string[] | null,
 *   sessionBase: (sid: string) => string | null,
 *   changedSince: (tree: string, base: string) => string[] | null,
 *   billed: (sid: string) => string[] | null,
 *   declared: () => import("./workflow-core-config.js").SensitivePath[] | undefined,
 * }} TierPorts git's top level and absolute common dir of a directory, null
 *   where git will not say, the top level throwing where git overran; a
 *   tree's staged paths, null where git will not say; the session's start
 *   point, null where none is recorded or git cannot place it, throwing where
 *   git overran; a tree's paths changed since a commit, untracked ones
 *   included, null where git will not say; the paths from the root the
 *   session wrote or its own commits touched, null where its write ledger
 *   will not read; and the host's
 *   `sensitivePaths`, throwing where its config will not read
 * @typedef {import("./guard-dispatch.js").CoreContext & TierPorts} TierContext
 */

/** The paths listed per area are capped because the prelude is not: a long
 * list would push the fragments after it off this call. 3 is a first guess,
 * never measured against the cap. */
const PATHS_LISTED_MAX = 3;

/**
 * @param {string} skill
 * @param {TierContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(skill, ctx) {
	/* The names guard-review-rules matches, and for its reasons (#201). */
	if (skill === "code-review:code-review") return null;
	if (skill !== "code-review" && !skill.endsWith(":code-review")) return null;
	/* guard-review-rules refuses this call (#1165), so a tier here would ride
	 * a refusal; the namespaced retry is told. */
	if (
		skill === "code-review" &&
		!ctx.isFile(
			path.join(ctx.root, ".claude", "skills", "code-review", "SKILL.md"),
		)
	)
		return null;

	const trees = treesOf(ctx);
	const paths = [
		...trees.flatMap((t) => stagedIn(t, ctx)),
		...ownChanges(trees, ctx),
	];
	/* A config warning is the config reader's to report, not this core's. */
	let declared;
	try {
		declared = ctx.declared();
	} catch (e) {
		ctx.log(
			`the workflow-core config did not read — review tier not stated: ${caught(e).message}`,
		);
		return null;
	}
	const match = matchSensitivePaths(declared, paths);

	/* Unlatched, so every review is told until the key exists (spec #1612
	 * §Solution). */
	if (match.state === "absent") {
		const line = ruleOrFallback(
			ctx,
			"review-sensitive-undeclared",
			"No sensitive paths are declared, so no review here can escalate",
		);
		return { context: ctx.corePaths(line) };
	}
	const globless = match.globless.length > 0;
	if (match.matched.length === 0 && !globless) return null;

	/* Suffixed as guard-review-rules suffixes the two axes' paths, so
	 * concurrent reviews write apart (mantahostels#3458). */
	const suffix = ctx.session ? reviewSuffix(ctx.session) : "";
	const prelude = `Sensitive paths declared in \`.claude/workflow-core.json\`:
${areaLines(match).join("\n")}
Focus and attack Artefact paths: \`.claude/tmp/review-focus${suffix}.md\`, \`.claude/tmp/review-attack${suffix}.md\`.`;

	const notLive = [...match.matched, ...match.globless].some((a) => !a.live);
	return tierDecision(prelude, notLive, globless);
}

/**
 * The escalated review's decision: the prelude, then its fragments, highest
 * priority first.
 *
 * Each branch spells its ids out because check-guard-registry.js counts a
 * fragment as printed, and sums its bytes against the cap, only from a literal
 * `injectRules: [...]` (lib/rule-emission.js): an id held in a variable is
 * invisible to it (#1699). Residual: each new optional fragment doubles the
 * branches; review-tier.test.ts pins that they agree.
 * @param {string} prelude
 * @param {boolean} notLive some area is not live
 * @param {boolean} globless some area is declared with no globs
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
 * The trees whose paths are matched: the root, and the payload's cwd where it
 * sits in another worktree of the root's repository, since a throwaway
 * worktree keeps CLAUDE_PROJECT_DIR on the shared tree (#2386, spec #1612
 * §Detection moments).
 * @param {TierContext} ctx
 */
function treesOf(ctx) {
	const trees = [ctx.root];
	if (!ctx.cwd) return trees;
	let top;
	try {
		top = ctx.topLevel(ctx.cwd);
	} catch (e) {
		/* git overran: the fail-open is recorded (#3446). */
		ctx.log(
			`the top level of ${ctx.cwd} did not read — worktree paths left unmatched: ${caught(e).message}`,
		);
		return trees;
	}
	if (top === null || top === ctx.root) return trees;
	/* A git before 2.31 rejects --path-format (#2529). */
	const common = ctx.commonDir(ctx.cwd);
	const rootCommon = ctx.commonDir(ctx.root);
	if (common === null || rootCommon === null)
		ctx.log(
			`git rev-parse --git-common-dir failed in ${ctx.cwd} or ${ctx.root} — worktree paths left unmatched`,
		);
	else if (common === rootCommon) trees.push(top);
	return trees;
}

/**
 * A tree's staged paths, none where git will not list them (#3446).
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
 * This session's own changes since its base in each tree, or none where the
 * base or the write ledger will not read: unattributable, they are billed to
 * nobody.
 * @param {string[]} trees
 * @param {TierContext} ctx
 */
function ownChanges(trees, ctx) {
	if (!ctx.session) return [];
	/* No base yet is a session that has recorded none, not a fault. */
	let base;
	try {
		base = ctx.sessionBase(ctx.session);
	} catch (e) {
		/* git overran: the fail-open is recorded (#3446). */
		ctx.log(
			`this session's base did not place — its unstaged changes left unmatched: ${caught(e).message}`,
		);
		return [];
	}
	if (base === null) return [];
	const ledger = ctx.billed(ctx.session);
	if (ledger === null) {
		ctx.log(
			"the write ledger did not read — this session's unstaged changes left unmatched",
		);
		return [];
	}
	return trees.flatMap((t) => {
		const changed = ctx.changedSince(t, base);
		/* git would not list them: the fail-open is recorded (#3446). */
		if (changed === null) {
			ctx.log(
				`git diff or ls-files failed in ${t} — this session's unstaged changes there left unmatched`,
			);
			return [];
		}
		const mine = new Set(ledgerInTree(t, ledger, ctx.root));
		return changed.filter((p) => mine.has(p));
	});
}

/**
 * The write ledger as `tree` names its paths. The ledger records a path from
 * the root (lib/arbiter-ledger.js's recordWrite), so a worktree's file carries
 * the worktree's place under the root, and a worktree outside the root has
 * none.
 * @param {string} tree
 * @param {string[]} ledger
 * @param {string} root
 */
function ledgerInTree(tree, ledger, root) {
	if (tree === root) return ledger;
	if (!tree.startsWith(`${root}/`)) return [];
	const prefix = `${tree.slice(root.length + 1)}/`;
	return ledger
		.filter((rel) => rel.startsWith(prefix))
		.map((rel) => rel.slice(prefix.length));
}

/**
 * One line per matched area under the tier, then one per globless area.
 * @param {Match} match
 */
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
