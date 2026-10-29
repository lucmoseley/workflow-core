#!/usr/bin/env node
/*
 * cut-mantahostels.js — performs the whole cut that makes mantahostels the
 * core's second adopter, in one commit: its own copies of the machinery are
 * deleted and it runs the agent workflow from a pinned workflow-core release
 * (#423, under the spec #412; ruled #393, #397, #399, #400).
 *
 * Usage:
 *   node scripts/cut-mantahostels.js --pin <tag> [--root <dir>] [--config-dir <dir>]
 *   node scripts/cut-mantahostels.js --plugin-root <dir> [--root <dir>] [--spec <file>]
 *
 * RUN IT FROM A TERMINAL OR A workflow-core SESSION, NEVER FROM INSIDE
 * mantahostels: it refuses while any process's working directory is inside
 * `--root` (default `~/mantahostels`) or one of its worktrees, because a live
 * Manta session would have its hooks swapped underneath it (spec stories 7-8).
 *
 * `--pin` installs the plugin at project scope from the core's git url at that
 * tag, and points the hooks at the install. `--plugin-root` skips the install
 * and uses a directory as the plugin, which is how the cut is proved against a
 * throwaway clone without touching this machine's plugin registry. `--spec`
 * replaces the built-in MANTA spec below, for the test's fixture repo only.
 *
 * WHAT IT DOES, IN ORDER: plans and refuses on anything it cannot do cleanly,
 * writing nothing; prints the rollback recipe; tags `pre-wfc-cut`; makes every
 * edit; runs the plugin's own `init-adopter.js` for the plugin-side writes (the
 * seven hooks, `core.hooksPath`, `.claude/workflow-core.md`, the settings keys,
 * the roadmap digest, doc-map §A); checks the guard registry; commits once,
 * through the plugin-pointed pre-commit stack.
 *
 * THE MANTA-SPECIFIC FACTS ARE IN `MANTA`, and nowhere else. The sets file
 * (`docs/research/wfc-cut-sets.json`, mantahostels' #422 report) supplies what
 * is deleted; MANTA supplies the corrections #423 owns on top of it.
 *
 * Left behind by the release build (lib/plugin-tree.js): it acts on one
 * adopter, once, and ships to none.
 *
 * Joins no §N3 family: it mutates another repository and commits there.
 *
 * EXITS 0 cut committed / 1 refused or failed, naming why and how to recover /
 * 2 the arguments are wrong.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { execGit, spawnGitSync } = require("./lib/git.js");
const { procRoot } = require("./lib/proc-root.js");
const { readProcCwd } = require("./lib/claude-sessions.js");
const { materialisePlugin, fixByHand } = require("./lib/materialise-plugin.js");
const {
	CONFIG_PATH,
	UPSTREAM_CODE_REPO,
} = require("./lib/workflow-core-config.js");
const { consumesFaults, readTrackedFiles } = require("./lib/doc-map.js");
const { formatConfigJson } = require("./lib/config-json.js");
const {
	findInstallRecord,
	resolveConfigDir,
} = require("./lib/plugin-state.js");
const { isUnder } = require("./lib/is-under.js");
const { requiredGroup } = require("./lib/regex-group.js");
const {
	parse: parseArgs,
	printExit,
	CliExit,
	flagValue,
} = require("./lib/cli-args");
const { caught } = require("./lib/caught.js");

const TAG = "pre-wfc-cut";
const MARKETPLACE = "workflow-core";
const CORE_URL = `https://github.com/${UPSTREAM_CODE_REPO}.git`;

/**
 * @typedef {{path: string, find: string | {from: string, through: string},
 *   replace: string}} Edit exactly one occurrence of `find` (or of the span
 *   from `from` through `through`) becomes `replace`, else the cut refuses
 */

/**
 * @typedef {object} Spec
 * @property {string} setsFile the #422 sets, repo-relative
 * @property {string} claudeMdBase the commit CLAUDE.md's line numbers are read at
 * @property {{remove: [number, number][], replace: {line: number, find: string,
 *   with: string}[], insertAfter: {line: number, text: string}[]}} claudeMd
 * @property {string[]} keep paths the sets delete that the cut keeps
 * @property {Record<string, string>} move deleted paths the cut moves instead
 * @property {string[]} deleteAlso paths outside the sets the cut deletes
 * @property {Edit[]} edits
 * @property {Record<string, string|null>} packageScripts set, or null to drop
 * @property {Record<string, string|null>} packageComments `comments` keys, likewise
 * @property {Record<string, string>} docMapRoles sidecar row → its `role`
 * @property {Record<string, Record<string, string|null>>} register new sidecar rows
 * @property {Record<string, unknown>} config `.claude/workflow-core.json`
 * @property {{from: string, startsWith: string, to: string, heading: string}}
 *   ranking the one paragraph lifted out of a deleted skill before it goes
 * @property {{to: string, anchors: string[], header: string}} localGates the
 *   pre-commit blocks moved into the adopter's own hook file (#434, #437)
 * @property {string[]} regenerate commands re-rendering what the edits staled,
 *   run after init with `$WFC_PLUGIN_ROOT` set
 * @property {string} minPin the lowest release a `--pin` may name
 * @property {string} commitMessage
 */

/* Every fact here is mantahostels' at `bbcfa0259`, or the spec's at the commit
 * it names. */
/** @type {Spec} */
const MANTA = {
	setsFile: "docs/research/wfc-cut-sets.json",
	/* Spec §Implementation Decisions: "removes lines 16-23, 40, 45-73, 76, 78,
	 * 83-92, 94-95, 98-148 (at `7c7678c18`)" (#397). */
	claudeMdBase: "7c7678c18",
	claudeMd: {
		remove: [
			[16, 23],
			[40, 40],
			[45, 73],
			[76, 76],
			[78, 78],
			[83, 92],
			[94, 95],
			[98, 148],
		],
		replace: [
			{
				line: 11,
				find: "`docs/effort-guide.md`.",
				with: "the core's `docs/effort-guide.md`, under the plugin root `.husky/pre-commit` sets as `WFC_PLUGIN_ROOT`.",
			},
			{
				line: 43,
				find: "**Enforced** / **Unenforced**",
				with: "**Enforced** / **Advisory** / **Unenforced**",
			},
		],
		insertAfter: [
			{ line: 5, text: "@.claude/workflow-core.md" },
			{
				line: 15,
				text: "- Manta's standing rulings the core does not carry — filing a `manual-finding`, what counts as Manta's world for §B, and the named external write-scope surfaces — are in `docs/rulings.md`, not auto-loaded. Read it before any of the three.",
			},
		],
	},
	keep: [
		/* check-snapshot-restatements.js reads it by path, and the core never
		 * ships it (plugin-tree.js LEFT_BEHIND). */
		"scripts/snapshot-memory.sh",
		/* The sets keep the vendored helpers but delete what they spawn or
		 * source: generate-doc-pages.js spawns register-doc.js,
		 * doc-map-generator.js spawns the arbiter to claim for itself, and
		 * guard-log.sh sources guard-root.sh. */
		"scripts/register-doc.js",
		"scripts/session-arbiter.js",
		"scripts/lib/agent-liveness.js",
		"scripts/lib/detached-run.js",
		"scripts/lib/oracle-cache.js",
		"scripts/lib/guard-root.sh",
		"scripts/lib/rule-text.sh",
		/* precommit-gate-harness.ts reads it from the repo root, to run the
		 * local gates' blocks as the hook would. */
		"scripts/lib/precommit-gate.sh",
		/* The instruction-surface check reads its baseline from the host. */
		"scripts/instruction-surface-anchors.json",
	],
	move: {
		"scripts/guard-registry-anchors.json":
			".claude/guard-registry-anchors.json",
		"scripts/plugin-context-cost.json": ".claude/plugin-context-cost.json",
	},
	/* The sweeps the core already runs (#399). */
	deleteAlso: [
		".github/workflows/bisect.yml",
		".github/workflows/issue-card-drift.yml",
		".github/workflows/roadmap-digest.yml",
		".github/workflows/scheduled-checks.yml",
	],
	edits: [
		{
			path: ".github/workflows/ci.yml",
			find: {
				from: "# NO PUSH OR PULL_REQUEST TRIGGER",
				through: "  workflow_dispatch:\n",
			},
			replace:
				"# Product checks only (workflow-core#399): the agent machinery these jobs\n" +
				"# once also covered is workflow-core's, pinned in .claude/workflow-core.json\n" +
				"# and tested there. On every push to main, and by hand.\n" +
				"on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n",
		},
		{
			path: ".github/workflows/ci.yml",
			find: {
				from: "      #\n      # `--full` IS LOAD-BEARING SINCE #3208",
				through:
					"      # flag this step tests everything or nothing depending on that file.\n",
			},
			replace: "",
		},
		{
			path: ".github/workflows/ci.yml",
			find: "        run: npm run test -- --full\n",
			replace: "        run: npm run test\n",
		},
		{
			path: "vitest.config.ts",
			find: {
				from: "\t\t// Reports a tracked file rewritten by a parallel session",
				through: '\t\t\t"./scripts/vitest-inflight-reporter.ts",\n\t\t],\n',
			},
			replace: "",
		},
		{
			path: "eslint.config.test.ts",
			find: 'const NODE_SURFACE = ["scripts/pick-next.js", "scripts/check-doc-map.test.ts"];',
			replace:
				'const NODE_SURFACE = [\n\t"scripts/check-website-copy.js",\n\t"scripts/check-website-copy.test.ts",\n];',
		},
		/* Two registry rules on core machinery Manta does not run: the suite
		 * wrapper the packageScripts below replace with plain vitest, and
		 * `npm run status`, whose script the sets delete. The registry check
		 * refuses both as unwired. */
		{
			path: "docs/environment.md",
			find: {
				from: "- **A vitest run outside `scripts/run-vitest.js` has no stall watchdog**",
				through: "\n",
			},
			replace: "",
		},
		{
			path: "docs/environment.md",
			find: {
				from: "- **A stray that reaches the tree anyway is named to whoever next runs `npm run status`",
				through: "\n",
			},
			replace: "",
		},
		{
			path: "scripts/conftest.py",
			find: {
				from: '@pytest.fixture(scope="session")\ndef bench():',
				through: '"bench_suite_concurrency")\n\n\n',
			},
			replace: "",
		},
		/* The local gates' suites read the hook file the gates now live in. */
		{
			path: "scripts/lib/precommit-gate-harness.ts",
			find: '/** The live `.husky/pre-commit`. */\nexport const HOOK = fs.readFileSync(\n\tpath.join(ROOT, ".husky", "pre-commit"),',
			replace:
				'/** `.husky/pre-commit.local`, where this repo\'s own gates live (workflow-core#423). */\nexport const HOOK = fs.readFileSync(\n\tpath.join(ROOT, ".husky", "pre-commit.local"),',
		},
		/* The retro-edit gate is the core's now, and the core's hook sources the
		 * local file after every core gate (#437), so the order holds by the
		 * load point rather than by line. */
		{
			path: "scripts/precommit-compliance-version-gate.test.ts",
			find: 'const RETRO = "scripts/check-append-only-retro-edit.js";\n',
			replace: "",
		},
		{
			path: "scripts/precommit-compliance-version-gate.test.ts",
			find: {
				from: "\t// The retro-edit gate is armed on all of `^docs/`",
				through: "\t});\n});",
			},
			replace: "});",
		},
	],
	/* The runners the report says must be rewritten, not dropped: the core's
	 * wrappers are gone and CI runs without the plugin (#422 census). */
	packageScripts: {
		pretest: null,
		test: "NODE_OPTIONS=--max-old-space-size=2048 vitest run",
		"test:changed":
			"NODE_OPTIONS=--max-old-space-size=2048 vitest run --changed",
		"test:py": "python3 -m pytest -n 2",
		/* husky v9 rewrites core.hooksPath to `.husky/_` at every install, which
		 * would undo the layout `init` sets (#422's "For #423"). */
		prepare: "git config core.hooksPath .husky",
	},
	packageComments: {
		"scripts.test:changed":
			"vitest over the test files reachable from what git reports as changed. The narrowing wrapper this once called is workflow-core's and was deleted at the cut (workflow-core#423); `npm run test` is the whole suite.",
		"scripts.prepare":
			"Pins core.hooksPath to .husky, the layout workflow-core's init sets, whose hooks call the plugin's scripts. husky itself is no longer run: it would reset the path to .husky/_ at every npm install (workflow-core#423).",
	},
	/* #446 and #454: the core's doc-map kind map does not name these folders,
	 * so each row carries its present rendered text itself. */
	docMapRoles: {
		"docs/brand-assets/*":
			"Every file under `docs/brand-assets/` — brand assets",
		"docs/compliance/adequacy-singapore.md":
			"Adequacy singapore — compliance record",
		"docs/compliance/privacy-notice-retention-erasure.md":
			"Privacy notice retention erasure — compliance record",
		"docs/compliance/review-role-reference-takedown.md":
			"Review role reference takedown — compliance record",
		"docs/compliance/review-staff-role-references.md":
			"Review staff role references — compliance record",
		"docs/notes/momtest.md": "Momtest — book note",
		"docs/notes/runninglean-general.md": "Runninglean general — book note",
		"docs/notes/runninglean-mantaspecific.md":
			"Runninglean mantaspecific — book note",
		"docs/notes/runninglean.md": "Runninglean — book note",
	},
	register: {
		[CONFIG_PATH]: {
			section: "Skills & settings",
			class: "source-of-truth",
			role: "The adopter's config — contract, modules, commands, categories",
		},
		".claude/workflow-core.md": {
			section: "Skills & settings",
			class: "generated-only",
			route:
				"workflow-core's `init` only, which rewrites it on every bump; override through `.claude/workflow-core.json`",
			reader: "agent",
		},
		".claude/guard-registry-anchors.json": {
			section: "Skills & settings",
			class: "generated-only",
			route:
				"`node scripts/check-guard-registry.js --review`, which re-anchors a guard whose annotation has been read",
		},
		".claude/plugin-context-cost.json": {
			section: "Skills & settings",
			class: "source-of-truth",
			role: "What each enabled plugin costs the context window, read by the core's context-budget check",
		},
		".claude/pick-next-ranking.md": {
			section: "Skills & settings",
			class: "source-of-truth",
			role: "The adopter's own pick-next ranking rules, read by the core skill on every run",
			reader: "agent",
		},
	},
	config: {
		contract: 1,
		founder: "Luc Moseley",
		login: "lucmoseley",
		tracker: "lucmoseley/mantahostels",
		name: "MantaHostels",
		commands: {
			test: "npm run test",
			lint: "npm run lint",
			typecheck: "npm run typecheck",
			check_staged: "npm run check:staged",
		},
		modules: ["roadmap", "governance"],
		roadmapMajorPin: 7,
		capacityLadder: true,
		capacityLadderPath: "docs/machinery/capacity-procurement-ladder.md",
		cycleLogPath: "docs/machinery/cycle-log.md",
		brandSheetPath: "docs/brand/brand-sheet.md",
		userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
		manualRender: {
			command: "npm run gen:doc-pages",
			outputs: ["docs/pages/operating-manual.html", "docs/pages/index.html"],
		},
		alwaysLoaded: [
			"CLAUDE.md",
			"AGENTS.md",
			"docs/working-contract.md",
			".claude/output-styles/manta-voice.md",
			".claude/workflow-core.md",
		],
		overrides: { output_style: ".claude/output-styles/manta-voice.md" },
		/* It sends a session to the core's scripts/run-vitest.js, which Manta
		 * does not have: its `npm run test` is plain vitest, because CI runs
		 * without the plugin (#422's census). */
		disabled: ["guard-vitest-wrapper"],
	},
	/* #450: mantahostels keeps that paragraph's text as its ranking file. */
	ranking: {
		from: ".claude/skills/pick-next/SKILL.md",
		startsWith: "**Order by which factory step the work attacks.**",
		to: ".claude/pick-next-ranking.md",
		heading: "# pick-next ranking rules",
	},
	localGates: {
		to: ".husky/pre-commit.local",
		anchors: [
			"node scripts/check-compliance-version-dupes.js",
			"node scripts/check-doc-pages-render.js",
			"node scripts/check-tax-gate.js",
		],
		header:
			"# mantahostels' own pre-commit gates, sourced by workflow-core's .husky/pre-commit\n" +
			"# after every core gate, in the same shell, so staged_gate is in scope\n" +
			"# (workflow-core#434, workflow-core#437). Moved here from the pre-cut hook by workflow-core#423.\n" +
			"#\n" +
			"# IMPLICIT:  runs the compliance-version, doc-pages-render and tax-residence gates on a commit staging what each reads\n" +
			"# JUSTIFIED: fail-safe — each refuses a duplicated compliance history row, a stale generated page or a tax-year breach\n" +
			"# DEFEAT:    HUSKY=0 and `git -c core.hooksPath=`, as for every gate in .husky/pre-commit\n",
	},
	/* The generated doc pages render the sidecar and docs/environment.md, both
	 * edited above. */
	regenerate: [
		"npm run gen:doc-pages",
		/* #422's report hands the re-anchor to the cut: every guard and pool
		 * file the core now supplies moved under the census. */
		'node "$WFC_PLUGIN_ROOT/scripts/check-instruction-surface.js" --rebaseline --no-claim',
		/* The sets delete the rule manifest and both docs it renders from, and
		 * its gate refuses a missing manifest, so this writes it back with no
		 * rules (#423's third clone proof). */
		'node "$WFC_PLUGIN_ROOT/scripts/generate-rule-fragments.js"',
		/* The deletions drop test files, so the reader manifest's gate would
		 * refuse the commit as stale (#423's clone proof, #557). Staged first:
		 * the generator sees tracked files only, and init's new files are
		 * readers the commit will carry. As sweeping as the commit's own add,
		 * and safe for the same reason: plan() refused an unclean tree. */
		'git add -A && node "$WFC_PLUGIN_ROOT/scripts/generate-test-read-edges.js"',
	],
	/* The first release whose doc-map gate passes the cut commit (#604); it
	 * also carries #446-#452's config keys, which the cut writes. */
	minPin: "v1.1.19",
	commitMessage:
		"Run mantahostels' agent workflow from the pinned workflow-core release and delete its own copies of the machinery, so a fix lands once and reaches both repos (workflow-core#412)\n\n" +
		"Made by workflow-core's scripts/cut-mantahostels.js (workflow-core#423). Rollback while the live acceptance is unrecorded: workflow-core#424.\n\n" +
		"Declined core guard: guard-vitest-wrapper, in .claude/workflow-core.json's `disabled` — this repo's test scripts run vitest directly now that the core's runner wrappers are gone, so a guard steering every run through them would refuse each one.\n\n" +
		"Kept beyond the #422 report's sets, because kept files spawn or source them: scripts/register-doc.js, scripts/session-arbiter.js with lib/agent-liveness.js, lib/detached-run.js and lib/oracle-cache.js, lib/guard-root.sh, lib/rule-text.sh, lib/precommit-gate.sh; and scripts/instruction-surface-anchors.json, the core's instruction-surface baseline.",
};

const USAGE = `usage: node scripts/cut-mantahostels.js --pin <tag> [--root <dir>] [--config-dir <dir>]
       node scripts/cut-mantahostels.js --plugin-root <dir> [--root <dir>] [--spec <file>]`;

/** @param {string[]} argv */
function parse(argv) {
	const { flags } = parseArgs(argv, {
		usage: USAGE,
		flags: {
			"--root": "value",
			"--pin": "value",
			"--plugin-root": "value",
			"--config-dir": "value",
			"--spec": "value",
		},
	});
	const values = Object.fromEntries(
		Object.keys(flags).map((flag) => [flag.slice(2), flagValue(flags, flag)]),
	);
	if (Boolean(values.pin) === Boolean(values["plugin-root"]))
		throw new Error("exactly one of --pin <tag> and --plugin-root <dir>");
	return values;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function git(cwd, args, env) {
	return execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...(env ? { env } : {}),
	});
}

class Refusal extends Error {}

/**
 * Whether release tag `a` precedes `b`; a tag that is not `vX.Y.Z` precedes
 * everything, so a branch name is refused rather than trusted.
 * @param {string} a
 * @param {string} b
 */
function olderThan(a, b) {
	const x = releaseParts(a);
	const y = releaseParts(b);
	if (!x) return true;
	if (!y)
		throw new Error(`${b} is not a vX.Y.Z release tag to compare against`);
	const [x1, x2, x3] = x;
	const [y1, y2, y3] = y;
	if (x1 !== y1) return x1 < y1;
	if (x2 !== y2) return x2 < y2;
	return x3 < y3;
}

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} tag
 * @returns {[number, number, number] | null}
 */
function releaseParts(tag) {
	const m = RELEASE_TAG.exec(tag);
	if (!m) return null;
	const part = (/** @type {number} */ n) =>
		Number(requiredGroup(m, n, RELEASE_TAG));
	return [part(1), part(2), part(3)];
}

/** @param {string} root */
const tagExists = (root) => git(root, ["tag", "--list", TAG]).trim() === TAG;

/**
 * Every process whose working directory is inside `root` or a worktree of it.
 * Residual (spec story 7): a process it cannot read — another user's — is
 * skipped, and with no `/proc` it sees nothing at all.
 * @param {string} root
 * @returns {string[]} one line per process
 */
function readProcessesInside(root) {
	const trees = git(root, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length));
	const inside = (/** @type {string} */ p) => isUnder(p, trees, path.sep);
	/** @type {string[]} */
	const hits = [];
	const proc = procRoot();
	for (const pid of fs.readdirSync(proc)) {
		if (!/^\d+$/.test(pid)) continue;
		const cwd = readProcCwd(pid, proc);
		if (cwd === null) continue; // another user's process, or one that just exited
		if (!inside(cwd)) continue;
		let argv0 = "?";
		try {
			argv0 = fs
				.readFileSync(`${proc}/${pid}/cmdline`, "utf8")
				.replace(/\0.*$/s, "");
		} catch {} // exited between the two reads; the cwd line still names it
		hits.push(`pid ${pid} (${argv0}) in ${cwd}`);
	}
	return hits;
}

/**
 * Tracked files at HEAD, repo-relative.
 * @param {string} root
 */
function readTrackedPaths(root) {
	return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/**
 * The `if … fi` block of a hook containing the line that runs `anchor`, with
 * the comment lines directly above it — the same cut the pre-commit gate
 * harness makes, so a gate moves whole.
 * @param {string} hook
 * @param {string} anchor
 */
function cutBlock(hook, anchor) {
	const lines = hook.split("\n");
	const call = lines.findIndex(
		(l) => l.includes(anchor) && !l.trimStart().startsWith("#"),
	);
	if (call < 0) throw new Refusal(`no line in the hook runs \`${anchor}\``);
	const opens = lines
		.slice(0, call + 1)
		.findLastIndex((l) => l.startsWith("if "));
	const end = lines.findIndex((l, i) => i >= call && l === "fi");
	if (opens === -1 || end === -1)
		throw new Refusal(
			`the block running \`${anchor}\` has no column-zero if … fi`,
		);
	// The comment lines directly above the `if` move with it.
	const start =
		lines.slice(0, opens).findLastIndex((l) => !l.startsWith("#")) + 1;
	return lines.slice(start, end + 1).join("\n");
}

/**
 * @param {string} text
 * @param {Edit} change
 */
function applyEdit(text, change) {
	const { find } = change;
	const count = (/** @type {string} */ s) => text.split(s).length - 1;
	if (typeof find === "string") {
		if (count(find) !== 1)
			throw new Refusal(
				`${change.path}: expected exactly one \`${find.slice(0, 60)}\`, found ${count(find)}`,
			);
		return text.replace(find, () => change.replace);
	}
	if (count(find.from) !== 1 || count(find.through) < 1)
		throw new Refusal(
			`${change.path}: the span from \`${find.from.slice(0, 60)}\` is not where the cut expects it`,
		);
	const start = text.indexOf(find.from);
	const end = text.indexOf(find.through, start);
	if (end < 0)
		throw new Refusal(
			`${change.path}: \`${find.through.slice(0, 60)}\` does not follow \`${find.from.slice(0, 60)}\``,
		);
	return (
		text.slice(0, start) +
		change.replace +
		text.slice(end + find.through.length)
	);
}

/**
 * CLAUDE.md with the spec's line list applied, numbered at `claudeMdBase`.
 * @param {string} text
 * @param {Spec["claudeMd"]} claudeMdPlan
 */
function rewriteClaudeMd(text, claudeMdPlan) {
	const lines = text.split("\n");
	for (const r of claudeMdPlan.replace) {
		const at = lines[r.line - 1] ?? "";
		if (!at.includes(r.find))
			throw new Refusal(`CLAUDE.md:${r.line} does not carry \`${r.find}\``);
		lines[r.line - 1] = at.replace(r.find, r.with);
	}
	const removed = (/** @type {number} */ n) =>
		claudeMdPlan.remove.some(([a, b]) => n >= a && n <= b);
	/** @type {string[]} */
	const out = [];
	lines.forEach((line, i) => {
		if (!removed(i + 1)) out.push(line);
		for (const ins of claudeMdPlan.insertAfter)
			if (ins.line === i + 1) out.push(ins.text);
	});
	return out.join("\n");
}

const RELATIVE_IMPORT =
	/(?:(?:require|import)\(\s*|from\s+)["'](\.{1,2}\/[^"']+)["']/g;
const DIRNAME_JOIN =
	/path\.(?:join|resolve)\(\s*__dirname\s*,\s*((?:["'][^"']+["']\s*,?\s*)+)\)/g;
const QUOTED = /["']([^"']+)["']/g;
/* A shell lib sourced from beside the script, in each spelling the hooks use.
 * The indent stops at a line break, the next line's `^` reading on from there,
 * so a long blank stretch is read once (#3383). */
const SOURCE_BESIDE =
	/^[^\S\n\r\u2028\u2029]*(?:source|\.)\s+"(?:\$\{BASH_SOURCE\[0\]%\/\*\}|\$here|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\))\/([^"$]+)"/gm;
const SCRIPT_PATH =
	/(?:^|[\s"'}/])(scripts\/[\w./-]+\.(?:js|cjs|mjs|sh|py|ts))/g;

/**
 * References in `text` that resolve to a file the cut deletes and to nothing it
 * keeps: a relative import, a `path.join(__dirname, …)` of literals (a script
 * spawned by path), or a shell `source` beside the file. A target that never
 * existed is not the cut's doing — the patterns also match inside strings and
 * comments.
 * @param {string} from repo-relative path of the importing file
 * @param {string} text
 * @param {Set<string>} survivors every path the cut leaves tracked
 * @param {Set<string>} deleted
 */
function danglingRefs(from, text, survivors, deleted) {
	const found = [];
	const imports = [...text.matchAll(RELATIVE_IMPORT)].map((m) =>
		requiredGroup(m, 1, RELATIVE_IMPORT),
	);
	const joined = [...text.matchAll(DIRNAME_JOIN)].map((m) =>
		[...requiredGroup(m, 1, DIRNAME_JOIN).matchAll(QUOTED)]
			.map((q) => requiredGroup(q, 1, QUOTED))
			.join("/"),
	);
	const sourced = [...text.matchAll(SOURCE_BESIDE)].map((m) =>
		requiredGroup(m, 1, SOURCE_BESIDE),
	);
	const tries = [
		"",
		".js",
		".ts",
		".tsx",
		".cjs",
		".mjs",
		".json",
		"/index.js",
		"/index.ts",
	];
	for (const ref of [...imports, ...joined, ...sourced]) {
		const base = path.posix.normalize(
			path.posix.join(path.posix.dirname(from), ref),
		);
		if (
			tries.some((ext) => deleted.has(base + ext)) &&
			!tries.some((ext) => survivors.has(base + ext))
		)
			found.push(`${from} → ${ref}`);
	}
	return found;
}

/**
 * Whether a sidecar row's key names `p` — the path itself, a folder above it,
 * or a `<folder>/*` row.
 * @param {string} key
 * @param {string} p
 */
function isCoveredByRow(key, p) {
	const k = key.endsWith("/*") ? key.slice(0, -2) : key;
	return isUnder(p, [k]);
}

/**
 * The script paths a hook command or npm script runs, repo-relative.
 * @param {string} command
 */
function scriptPaths(command) {
	return [...command.matchAll(SCRIPT_PATH)].map((m) =>
		requiredGroup(m, 1, SCRIPT_PATH),
	);
}

/**
 * #400: plugin and native hooks run in parallel, and `updatedInput` is the one
 * field whose merge depends on order. The refusal naming every kept native
 * hook that returns it on a tool a plugin hook also matches, or null.
 * @param {string} root
 * @param {string} pluginRoot
 * @param {{hooks?: Record<string, {matcher?: string, hooks: {command: string}[]}[]>}} settings
 * @param {(command: string) => boolean} keptHook
 */
function racesWith(root, pluginRoot, settings, keptHook) {
	const pluginHooks = JSON.parse(
		fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
	).hooks;
	const races = [];
	for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
		for (const g of groups) {
			for (const h of g.hooks) {
				if (
					hookRaces({
						root,
						command: h.command,
						matcher: g.matcher,
						pluginGroups: pluginHooks[event],
						keptHook,
					})
				)
					races.push(`${event} ${g.matcher ?? "*"}: ${h.command}`);
			}
		}
	}
	return races.length > 0
		? `a kept native hook returns updatedInput on a tool a plugin hook also matches (#400) — drop it, or narrow its matcher off the plugin's:\n${races.join("\n")}`
		: null;
}

/**
 * Whether one native hook command races a plugin hook: kept, returning
 * `updatedInput`, and on a tool a plugin hook group also matches.
 * @param {{root: string, command: string, matcher: string|undefined,
 *   pluginGroups: {matcher?: string}[]|undefined,
 *   keptHook: (command: string) => boolean}} at
 */
function hookRaces({ root, command, matcher, pluginGroups, keptHook }) {
	return (
		keptHook(command) &&
		scriptPaths(command).some((rel) => rewrites(root, rel)) &&
		hasSharedTool(pluginGroups ?? [], matcher)
	);
}

/**
 * The tools a hook matcher names. Claude Code reads "" and ".*" as every tool.
 * @param {string|undefined} m
 */
function tools(m) {
	return new Set(
		m === undefined || m === "" || m === ".*" ? ["*"] : m.split("|"),
	);
}

/**
 * Whether the script or the shell libs it sources beside itself return
 * `updatedInput`.
 * @param {string} root
 * @param {string} rel
 */
function rewrites(root, rel) {
	const text = fs.readFileSync(path.join(root, rel), "utf8");
	const libs = [...text.matchAll(SOURCE_BESIDE)].map((m) =>
		path.join(root, path.dirname(rel), requiredGroup(m, 1, SOURCE_BESIDE)),
	);
	return [
		text,
		...libs
			.filter((f) => fs.existsSync(f))
			.map((f) => fs.readFileSync(f, "utf8")),
	].some((t) => t.includes("updatedInput"));
}

/**
 * Whether any plugin hook group matches a tool `matcher` also matches.
 * @param {{matcher?: string}[]} pluginGroups
 * @param {string|undefined} matcher
 * @returns {boolean}
 */
function hasSharedTool(pluginGroups, matcher) {
	const mine = tools(matcher);
	return pluginGroups.some((pg) =>
		[...tools(pg.matcher)].some(
			(t) => t === "*" || mine.has("*") || mine.has(t),
		),
	);
}

/**
 * Everything the cut will do, computed from the tree before any write, so a
 * refusal leaves mantahostels untouched.
 * @param {string} root
 * @param {string} pluginRoot
 * @param {Spec} spec
 */
function plan(root, pluginRoot, spec) {
	const refusals = preconditions(root, pluginRoot, spec);
	if (refusals.length > 0) throw new Refusal(refusals.join("\n"));

	const sets = JSON.parse(
		fs.readFileSync(path.join(root, spec.setsFile), "utf8"),
	);
	const files = readTrackedPaths(root);
	const all = new Set(files);

	/* A file the sets classify, changed since the report read it, invalidates
	 * the report's verdict on it (#422). */
	const classified = new Set([
		...sets.delete,
		...sets.replacedByPlugin,
		...sets.keepNativeShared,
	]);
	const moved = git(root, ["diff", "--name-only", sets.mantaAt, "HEAD"])
		.split("\n")
		.filter((p) => classified.has(p));
	if (moved.length > 0)
		throw new Refusal(
			`changed since the report's commit ${sets.mantaAt}, so its verdict no longer holds — re-run the #422 report:\n${moved.join("\n")}`,
		);

	const keep = new Set(spec.keep);
	const deleted = new Set(
		[...sets.delete, ...spec.deleteAlso].filter(
			(p) => !keep.has(p) && !(p in spec.move),
		),
	);
	const missing = [...deleted, ...Object.keys(spec.move)].filter(
		(p) => !all.has(p),
	);
	if (missing.length > 0)
		throw new Refusal(
			`listed for deletion or moving but not tracked:\n${missing.join("\n")}`,
		);

	const survivors = new Set([
		...files.filter((p) => !deleted.has(p) && !(p in spec.move)),
		...Object.values(spec.move),
	]);
	const dangling = [];
	for (const p of survivors) {
		if (!/\.((c|m)?[jt]sx?|sh)$/.test(p) || !all.has(p)) continue;
		dangling.push(
			...danglingRefs(
				p,
				fs.readFileSync(path.join(root, p), "utf8"),
				survivors,
				deleted,
			),
		);
	}
	if (dangling.length > 0)
		throw new Refusal(
			`kept files would reach deleted ones — keep the target in MANTA.keep, or edit the file reaching it:\n${dangling.join("\n")}`,
		);

	const settings = JSON.parse(
		fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"),
	);
	/* The report's allowlist, not "its script survives": a kept script can
	 * still be one the plugin now runs on the same event (spec story 5). A
	 * command naming no script is not the report's to judge, so it stays. */
	const keptHook = (/** @type {string} */ command) => {
		const scripts = scriptPaths(command);
		return (
			scripts.length === 0 ||
			scripts.every((s) => sets.settingsHooksKept.includes(s))
		);
	};
	const race = racesWith(root, pluginRoot, settings, keptHook);
	if (race) throw new Refusal(race);

	return { sets, files, deleted, survivors, settings, keptHook };
}

/**
 * Every refusal the cut can name before reading the sets: the checkout's
 * shape, its cleanliness, a prior cut, CLAUDE.md's base, the plugin root and
 * the adopter's formatter.
 * @param {string} root
 * @param {string} pluginRoot
 * @param {Spec} spec
 * @returns {string[]}
 */
function preconditions(root, pluginRoot, spec) {
	const refusals = [];
	if (git(root, ["rev-parse", "--show-cdup"]).trim() !== "")
		refusals.push(`${root} is not the top of a git checkout`);
	const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	if (branch !== "main") refusals.push(`${root} is on ${branch}, not main`);
	const dirty = git(root, [
		"status",
		"--porcelain",
		"--untracked-files=all",
	]).trim();
	if (dirty)
		refusals.push(
			`the tree is not clean — commit or remove these first, so the cut's commit is the cut alone:\n${dirty}`,
		);
	if (tagExists(root))
		refusals.push(`the tag ${TAG} already exists — a cut was run here before`);
	try {
		git(root, [
			"diff",
			"--quiet",
			spec.claudeMdBase,
			"HEAD",
			"--",
			"CLAUDE.md",
		]);
	} catch {
		refusals.push(
			`CLAUDE.md has changed since ${spec.claudeMdBase}, where the cut's line numbers are read — re-derive the line list first`,
		);
	}
	if (!fs.existsSync(path.join(pluginRoot, "scripts", "init-adopter.js")))
		refusals.push(
			`${pluginRoot} carries no scripts/init-adopter.js — not a workflow-core plugin root`,
		);
	if (!fs.existsSync(path.join(root, "node_modules", ".bin", "biome")))
		refusals.push(
			"no node_modules/.bin/biome — run `npm ci` first: the cut formats what it writes, and the pre-commit stack lints it",
		);
	return refusals;
}

/**
 * @param {string} root
 * @param {string} rel
 */
function read(root, rel) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} body
 */
function write(root, rel, body) {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
}

/**
 * Removes a file, then each parent directory it leaves empty.
 * @param {string} root
 * @param {string} rel
 */
function remove(root, rel) {
	fs.rmSync(path.join(root, rel));
	let dir = path.dirname(path.join(root, rel));
	while (dir !== root && fs.readdirSync(dir).length === 0) {
		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
}

/**
 * Every write the cut makes to mantahostels' own files.
 * @param {string} root
 * @param {Spec} spec
 * @param {ReturnType<typeof plan>} p
 * @param {(line: string) => void} out
 */
function edit(root, spec, p, out) {
	/* Read before anything it lives in is deleted or overwritten. */
	const skill = read(root, spec.ranking.from);
	const paragraph = skill
		.split("\n")
		.find((l) => l.startsWith(spec.ranking.startsWith));
	if (!paragraph)
		throw new Refusal(
			`${spec.ranking.from} no longer carries the ranking paragraph`,
		);
	const hook = read(root, ".husky/pre-commit");
	const gates = spec.localGates.anchors.map((a) => cutBlock(hook, a));

	deleteAndMove(root, spec, p);
	out(
		`deleted ${p.deleted.size} files; moved ${Object.keys(spec.move).length}; kept ${spec.keep.join(", ") || "nothing"} the sets listed`,
	);

	write(root, spec.ranking.to, `${spec.ranking.heading}\n\n${paragraph}\n`);
	write(
		root,
		spec.localGates.to,
		`${spec.localGates.header}\n${gates.join("\n\n")}\n`,
	);
	out(
		`wrote   ${spec.ranking.to}, ${spec.localGates.to} (${gates.length} gates)`,
	);

	for (const e of spec.edits)
		write(root, e.path, applyEdit(read(root, e.path), e));
	out(`edited  ${[...new Set(spec.edits.map((e) => e.path))].join(", ")}`);

	write(root, CONFIG_PATH, formatConfigJson(spec.config));
	const claudeMd = rewriteClaudeMd(read(root, "CLAUDE.md"), spec.claudeMd);
	write(root, "CLAUDE.md", claudeMd);
	out(
		`wrote   ${CONFIG_PATH}; rewrote CLAUDE.md per the line list at ${spec.claudeMdBase}`,
	);

	const { settings, dropped } = dropUnkeptHooks(p.settings, p.keptHook);
	write(
		root,
		".claude/settings.json",
		`${JSON.stringify(settings, null, "\t")}\n`,
	);
	out(
		`dropped ${dropped} .claude/settings.json hook entries the report does not keep`,
	);

	const { pkg: pruned, droppedScripts } = dropDeadScripts(
		JSON.parse(read(root, "package.json")),
		spec,
		p.deleted,
	);
	const pkg = applyPackageSpec(pruned, spec);
	write(root, "package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
	out(
		`dropped ${droppedScripts.length} package.json scripts that ran deleted scripts; rewrote ${Object.keys(spec.packageScripts).join(", ")}`,
	);

	const { classes: kept, rowsDropped } = dropDeadRows(
		JSON.parse(read(root, "docs/doc-map-classes.json")),
		p,
	);
	const classes = setRolesAndRegister(kept, spec);
	const sorted = Object.fromEntries(
		Object.keys(classes)
			.sort()
			.map((k) => [k, classes[k]]),
	);
	write(
		root,
		"docs/doc-map-classes.json",
		`${JSON.stringify(sorted, null, "\t")}\n`,
	);
	out(
		`doc-map sidecar: ${rowsDropped.length} rows of deleted files dropped, ${Object.keys(spec.docMapRoles).length} roles set, ${Object.keys(spec.register).length} registered`,
	);

	return { claudeMd };
}

/**
 * @param {string} root
 * @param {Spec} spec
 * @param {ReturnType<typeof plan>} p
 */
function deleteAndMove(root, spec, p) {
	for (const rel of p.deleted) remove(root, rel);
	for (const [from, to] of Object.entries(spec.move)) {
		fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
		fs.renameSync(path.join(root, from), path.join(root, to));
	}
}

/**
 * @typedef {any} ParsedJson One parsed settings, package.json or doc-map
 * sidecar file. `any` because JSON.parse types nothing and each key the cut
 * touches is one the file is known to carry.
 */

/**
 * Drops every settings hook entry `keptHook` refuses, and any group or event
 * left empty.
 * @param {ParsedJson} settings
 * @param {(command: string) => boolean} keptHook
 * @returns {{settings: ParsedJson, dropped: number}} the settings without
 *   them, and how many entries went
 */
function dropUnkeptHooks(settings, keptHook) {
	if (!settings.hooks) return { settings, dropped: 0 };
	let dropped = 0;
	/** @type {Record<string, unknown[]>} */
	const hooks = {};
	for (const [event, groups] of Object.entries(settings.hooks)) {
		const kept = [];
		for (const g of groups) {
			const entries = g.hooks.filter((/** @type {{command: string}} */ h) =>
				keptHook(h.command),
			);
			dropped += g.hooks.length - entries.length;
			if (entries.length > 0) kept.push({ ...g, hooks: entries });
		}
		if (kept.length > 0) hooks[event] = kept;
	}
	return { settings: { ...settings, hooks }, dropped };
}

/**
 * Drops every package.json script the spec does not set that runs a deleted
 * script.
 * @param {ParsedJson} pkg
 * @param {Spec} spec
 * @param {Set<string>} deleted
 * @returns {{pkg: ParsedJson, droppedScripts: string[]}} the package without
 *   them, and the scripts dropped
 */
function dropDeadScripts(pkg, spec, deleted) {
	const droppedScripts = [];
	/** @type {Record<string, unknown>} */
	const scripts = {};
	for (const [name, command] of Object.entries(pkg.scripts)) {
		if (
			!(name in spec.packageScripts) &&
			scriptPaths(/** @type {string} */ (command)).some((s) => deleted.has(s))
		)
			droppedScripts.push(name);
		else scripts[name] = command;
	}
	return { pkg: { ...pkg, scripts }, droppedScripts };
}

/**
 * The spec's package.json scripts and comments applied, after the comments of
 * scripts no longer present are dropped.
 * @param {ParsedJson} pkg
 * @param {Spec} spec
 * @returns {ParsedJson}
 */
function applyPackageSpec(pkg, spec) {
	const scripts = { ...pkg.scripts };
	setOrDelete(scripts, spec.packageScripts);
	const comments = pkg.comments && { ...pkg.comments };
	for (const key of Object.keys(comments ?? {})) {
		if (isOrphanScriptComment(key, scripts)) delete comments[key];
	}
	setOrDelete(comments, spec.packageComments);
	return { ...pkg, scripts, ...(comments === undefined ? {} : { comments }) };
}

/**
 * Sets each key of `changes` on `target`, deleting it where the value is null.
 * @param {Record<string, unknown>} target accumulator: each key of `changes` is set or deleted here
 * @param {Record<string, unknown>} changes
 */
function setOrDelete(target, changes) {
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete target[key];
		else target[key] = value;
	}
}

/**
 * @param {string} key a package.json comment key
 * @param {Record<string, unknown>} scripts
 * @returns {boolean} whether it annotates a script no longer present
 */
function isOrphanScriptComment(key, scripts) {
	if (!key.startsWith("scripts.")) return false;
	const script = key.slice("scripts.".length);
	return script !== "" && !(script in scripts);
}

/**
 * Drops each sidecar row whose every file the cut deleted.
 * @param {ParsedJson} classes
 * @param {ReturnType<typeof plan>} p
 * @returns {{classes: ParsedJson, rowsDropped: string[]}} the sidecar without
 *   them, and the rows dropped
 */
function dropDeadRows(classes, p) {
	const rowsDropped = [];
	/** @type {Record<string, unknown>} */
	const kept = {};
	for (const key of Object.keys(classes)) {
		const covered = p.files.filter((f) => isCoveredByRow(key, f));
		if (covered.length > 0 && covered.every((f) => !p.survivors.has(f)))
			rowsDropped.push(key);
		else kept[key] = classes[key];
	}
	return { classes: kept, rowsDropped };
}

/**
 * @param {ParsedJson} classes
 * @param {Spec} spec
 * @returns {ParsedJson} the sidecar with the spec's roles set and its rows
 *   registered
 */
function setRolesAndRegister(classes, spec) {
	const next = { ...classes };
	for (const [key, role] of Object.entries(spec.docMapRoles)) {
		if (!next[key])
			throw new Refusal(
				`docs/doc-map-classes.json has no row ${key} to set a role on`,
			);
		next[key] = { ...next[key], role };
	}
	for (const [key, row] of Object.entries(spec.register)) {
		next[key] = {
			section: row.section,
			class: row.class,
			classQualifier: null,
			role: row.role ?? null,
			route: row.route ?? null,
			consumes: null,
			...(row.reader ? { reader: row.reader } : {}),
		};
	}
	return next;
}

/**
 * Drops each `path` or `glob` `consumes` reference that resolves in neither
 * the host after the cut nor the plugin root — the files the cut deleted and
 * the plugin does not ship (#423). Judged by the check's own resolver, over the
 * same host-plus-plugin set. A pass of its own, not part of `edit()`: a
 * `--pin` run has no plugin root until the install after `edit()`.
 * @param {string} root
 * @param {string} pluginRoot
 * @param {Set<string>} survivors
 * @param {(line: string) => void} out
 */
function pruneDeadConsumes(root, pluginRoot, survivors, out) {
	const classes = JSON.parse(read(root, "docs/doc-map-classes.json"));
	const dead = new Set(
		consumesFaults(classes, {
			tracked: [...survivors, ...readTrackedFiles(pluginRoot)],
			presentUntracked: () => false,
			liveFigures: new Set(),
		})
			.dead.filter((d) => !d.shape)
			.map((d) => `${d.doc}\0${d.ref}`),
	);
	/** @type {string[]} */
	const pruned = [];
	for (const [doc, row] of Object.entries(classes)) {
		if (!Array.isArray(row.consumes)) continue;
		row.consumes = row.consumes.filter(
			(/** @type {{kind: string, ref: string}} */ c) => {
				const gone =
					(c.kind === "path" || c.kind === "glob") &&
					dead.has(`${doc}\0${c.ref}`);
				if (gone) pruned.push(`  ${doc} → ${c.ref}`);
				return !gone;
			},
		);
		if (row.consumes.length === 0) row.consumes = null;
	}
	write(
		root,
		"docs/doc-map-classes.json",
		`${JSON.stringify(classes, null, "\t")}\n`,
	);
	out(
		`doc-map sidecar: ${pruned.length} \`consumes\` references resolving nowhere dropped${pruned.length > 0 ? `:\n${pruned.join("\n")}` : ""}`,
	);
}

/**
 * @param {string} root
 * @param {string} prior the hooks path before the cut
 * @param {boolean} pinned whether the cut installs the plugin
 */
function recipe(root, prior, pinned) {
	return [
		"ROLLBACK, until the live acceptance is recorded on workflow-core#424:",
		`  1. git -C ${root} revert <cut-sha>              (through the gates)`,
		`  2. git -C ${root} config core.hooksPath ${prior || "<unset — git config --unset core.hooksPath>"}`,
		...(pinned
			? [
					`  3. cd ${root} && claude plugin uninstall workflow-core@${MARKETPLACE} --scope project`,
				]
			: []),
		"  then restart any Claude session in mantahostels",
		`  Last resort, from a terminal only, where the gates refuse the revert: HUSKY=0 git -C ${root} revert <cut-sha>`,
		"  Never reset main, never force-push.",
		"",
	].join("\n");
}

/**
 * @typedef {{root: string, pluginRoot: string | null, pin: string | null,
 *   configDir?: string, spec: Spec, out: (line: string) => void}} CutAt
 */

/** @param {CutAt} at */
function cut(at) {
	const { root, spec, out } = at;
	if (at.pin && olderThan(at.pin, spec.minPin))
		throw new Refusal(
			`--pin ${at.pin} is older than ${spec.minPin}, the first release whose doc-map gate passes the cut (#604)`,
		);
	const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
	/* Planned against the plugin root it will run, which a --pin run only has
	 * after installing — so a pin run plans against this checkout, the core
	 * the pin was cut from. */
	const planRoot = at.pluginRoot ?? path.join(__dirname, "..");

	const inside = readProcessesInside(root);
	if (inside.length > 0)
		throw new Refusal(
			`a process is working inside ${root} — end every mantahostels session first (spec story 7):\n${inside.join("\n")}`,
		);
	const p = plan(root, planRoot, spec);

	let prior = "";
	try {
		prior = git(root, ["config", "--get", "core.hooksPath"]).trim();
	} catch {} // exit 1 is git's "unset", which `prior = ""` records
	out(recipe(root, prior, Boolean(at.pin)));

	git(root, ["tag", TAG]);
	out(
		`tagged  ${TAG} at ${git(root, ["rev-parse", "--short", "HEAD"]).trim()}`,
	);

	const { claudeMd } = edit(root, spec, p, out);
	const written = [
		spec.ranking.to,
		...spec.edits.map((e) => e.path),
		...Object.values(spec.move),
		CONFIG_PATH,
		".claude/settings.json",
		"package.json",
	];

	const pluginRoot = at.pin
		? installPinned({ at, p, pin: at.pin })
		: /** @type {string} */ (at.pluginRoot);
	pruneDeadConsumes(root, pluginRoot, p.survivors, out);

	runInit({ at, pluginRoot, env });
	regenerate({ at, pluginRoot, env });
	formatWritten({ root, written, env });

	const hooksPath = git(root, ["config", "--get", "core.hooksPath"]).trim();
	out(
		`hooks   core.hooksPath is now ${hooksPath} (was ${prior || "unset"}), the layout init sets`,
	);
	out(`CLAUDE.md keeps ${Buffer.byteLength(claudeMd)} bytes`);

	checkRegistry({ root, pluginRoot, env, out });

	/* A sweeping add is safe only because plan() refused an unclean tree. */
	git(root, ["add", "-A"], env);
	const commit = spawnGitSync(["commit", "-q", "-F", "-"], {
		cwd: root,
		env,
		input: spec.commitMessage,
		encoding: "utf8",
	});
	if (commit.status !== 0)
		throw new Error(
			`the pre-commit stack refused the cut:\n${commit.stdout}${commit.stderr}`,
		);
	const sha = git(root, ["rev-parse", "HEAD"]).trim();
	const changed = git(root, ["show", "--shortstat", "--format=", sha]).trim();
	out(
		`committed ${sha} through the plugin-pointed pre-commit stack — ${changed}`,
	);
	out(
		recipe(root, prior, Boolean(at.pin)).replaceAll(
			"<cut-sha>",
			sha.slice(0, 12),
		),
	);
	return 0;
}

/**
 * A --pin run's install, at project scope, and the path it installed to —
 * refused where the release's hooks race a kept native one.
 * @param {{at: CutAt, p: ReturnType<typeof plan>, pin: string}} step
 * @returns {string}
 */
function installPinned({ at, p, pin }) {
	const { root, out } = at;
	const result = materialisePlugin({
		root,
		claudeBin: process.env.WFC_CLAUDE_BIN || "claude",
		addSource: `${CORE_URL}#${pin}`,
		pluginId: `workflow-core@${MARKETPLACE}`,
		configDir: at.configDir,
	});
	if (!result.ok)
		throw new Error(
			`installing the plugin failed: ${result.reason} — by hand: ${fixByHand(result)}`,
		);
	const record = findInstallRecord(
		path.join(resolveConfigDir(at.configDir), "plugins"),
		"workflow-core",
		MARKETPLACE,
		root,
	);
	if (!record)
		throw new Error(`installed, but no install record names ${root}`);
	const pluginRoot = record.installPath;
	out(
		`installed workflow-core@${MARKETPLACE} ${pin} at project scope → ${pluginRoot}`,
	);
	/* The plan read this checkout's hooks; the release is what will load. */
	const race = racesWith(root, pluginRoot, p.settings, p.keptHook);
	if (race) throw new Refusal(race);
	return pluginRoot;
}

/**
 * The plugin's own init-adopter.js over the cut tree, its lines relayed bar
 * its closing commit recipe.
 * @param {{at: CutAt, pluginRoot: string, env: NodeJS.ProcessEnv}} step
 */
function runInit({ at, pluginRoot, env }) {
	const { root, spec, out } = at;
	const init = spawnSync(
		process.execPath,
		[
			path.join(pluginRoot, "scripts", "init-adopter.js"),
			"--root",
			root,
			"--plugin-root",
			pluginRoot,
			"--project",
			String(spec.config.name),
			"--modules",
			/** @type {string[]} */ (spec.config.modules).join(","),
			"--no-tracker",
			"--no-plugin-install",
			...(at.pin ? ["--marketplace-ref", at.pin] : []),
			...(at.configDir ? ["--config-dir", at.configDir] : []),
		],
		{ cwd: root, env, encoding: "utf8" },
	);
	for (const line of `${init.stdout}${init.stderr}`.split("\n"))
		if (line.trim() && !line.startsWith("  git ") && !line.startsWith("Next:"))
			out(`  init  ${line}`);
	if (init.status !== 0)
		throw new Error(`init-adopter.js exited ${init.status}`);
}

/**
 * @param {{at: CutAt, pluginRoot: string, env: NodeJS.ProcessEnv}} step
 */
function regenerate({ at, pluginRoot, env }) {
	const { root, spec, out } = at;
	for (const command of spec.regenerate) {
		const r = spawnSync("sh", ["-c", command], {
			cwd: root,
			env: { ...env, WFC_PLUGIN_ROOT: pluginRoot },
			encoding: "utf8",
		});
		if (r.status !== 0)
			throw new Error(
				`\`${command}\` exited ${r.status}:\n${r.stdout}${r.stderr}`,
			);
		out(`regen   ${command}`);
	}
}

/**
 * The adopter's own formatter over the files the cut wrote, so its staged
 * Biome gate reads them as it would have written them.
 * @param {{root: string, written: string[], env: NodeJS.ProcessEnv}} step
 */
function formatWritten({ root, written, env }) {
	const biome = spawnSync(
		path.join(root, "node_modules", ".bin", "biome"),
		[
			"format",
			"--write",
			"--no-errors-on-unmatched",
			"--files-ignore-unknown=true",
			...written.filter((rel) => fs.existsSync(path.join(root, rel))),
		],
		{ cwd: root, env, encoding: "utf8" },
	);
	if (biome.status !== 0)
		throw new Error(
			`Biome could not format the cut's files:\n${biome.stdout}${biome.stderr}`,
		);
}

/**
 * The plugin's guard-registry check over the edited CLAUDE.md, its verdict
 * line relayed.
 * @param {{root: string, pluginRoot: string, env: NodeJS.ProcessEnv,
 *   out: (line: string) => void}} step
 */
function checkRegistry({ root, pluginRoot, env, out }) {
	const registry = spawnSync(
		process.execPath,
		[path.join(pluginRoot, "scripts", "check-guard-registry.js")],
		{ cwd: root, env, encoding: "utf8" },
	);
	const verdict = `${registry.stdout}${registry.stderr}`
		.trim()
		.split("\n")
		.pop();
	out(`registry ${verdict}`);
	if (registry.status !== 0)
		throw new Error(
			`the guard-registry check refuses the edited CLAUDE.md:\n${registry.stdout}${registry.stderr}`,
		);
}

/**
 * What the founder does where the cut stopped before its commit.
 * @param {string} root
 */
function recovery(root) {
	if (!tagExists(root)) return "Nothing was written.";
	return [
		"Nothing was committed. The tree was clean before the cut, so to return to it:",
		`  git -C ${root} reset --hard ${TAG} && git -C ${root} clean -fd`,
		`  git -C ${root} tag -d ${TAG}`,
		"  and restore core.hooksPath as the recipe above says, if the cut had reached it,",
		`  and, where --pin installed the plugin: cd ${root} && claude plugin uninstall workflow-core@${MARKETPLACE} --scope project`,
	].join("\n");
}

/** @param {string[]} argv */
function main(argv) {
	let values;
	try {
		values = parse(argv);
	} catch (err) {
		if (err instanceof CliExit) return printExit(err);
		writeFd(2, `cut-mantahostels: ${caught(err).message}\n`);
		return 2;
	}
	let root;
	let spec;
	try {
		root = fs.realpathSync(
			path.resolve(values.root ?? path.join(os.homedir(), "mantahostels")),
		);
		spec = values.spec
			? JSON.parse(fs.readFileSync(values.spec, "utf8"))
			: MANTA;
	} catch (err) {
		writeFd(2, `cut-mantahostels: ${caught(err).message}\n`);
		return 2;
	}
	const out = (/** @type {string} */ line) => writeFd(1, `${line}\n`);
	try {
		return cut({
			root,
			pluginRoot: values["plugin-root"]
				? path.resolve(values["plugin-root"])
				: null,
			pin: values.pin ?? null,
			configDir: values["config-dir"]
				? path.resolve(values["config-dir"])
				: undefined,
			spec,
			out,
		});
	} catch (err) {
		writeFd(
			2,
			`cut-mantahostels: ${err instanceof Refusal ? "REFUSED" : "FAILED"} — ${caught(err).message}\n${recovery(root)}\n`,
		);
		return 1;
	}
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
