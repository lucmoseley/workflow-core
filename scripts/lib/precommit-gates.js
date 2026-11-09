/*
 * precommit-gates.js — the pre-commit's whole-repo checker gates, one row per
 * gate (#4597). Each row is the gate's one registration, read by:
 *
 * - .husky/pre-commit's two `precommit-gates` regions, rendered by
 *   scripts/generate-precommit-gates.js, whose `--check` refuses a stale one.
 * - lib/fault-profiles.js's PROFILES, from `identity`.
 * - lib/shared-fault-notices.js's NOTICES, from `notice`.
 * - lib/arm-secondary.js's refusal table, from `refusals`.
 * - The hook test (precommit-whole-repo-gates.test.ts), the refusal-source
 *   test (lib/arm-secondary.test.ts) and base §0's floor test
 *   (tooling-matrix.test.ts), which iterate GATES.
 *
 * Base §0's floor table is the one edit a new code gate still owes beside its
 * row: that table mixes these gates with gates of other shapes in one curated
 * order, so the floor test requires a row naming each `floor` gate's script
 * rather than rendering it.
 *
 * A row renders as one block, `if [! lander_batch && ]armed <ere>; then node
 * <script> <flag> || exit "$?"; fi`, so check-precommit-exit.js, the gate
 * harness and the lander's `--gates=` sets read it as any hand-written gate.
 *
 * THE BASELINE MUST EXIST for an `against` gate: lib/check.js resolves
 * HEAD^{tree} before it reads anything, so in a repo with no commit yet the
 * gate is BROKEN, exit 2, refusing the very first commit (mantahostels#1940).
 * An `index` gate judges the tree this commit makes, never an untracked or
 * unstaged file outside it, and still refuses a breach HEAD already carries
 * (#3687).
 *
 * `script` and `sources` are spelt from the core root, and `fromCoreRoot` reads
 * them there through coreRoot(), the anchor under which the read-edge
 * extractor attributes them to a test importing this module (base §X10).
 * The generator's `--check` compiles the index's copy of this file at this
 * file's own path, so its requires resolve as this one's do.
 */

const path = require("node:path");
const { coreRoot } = require("./script-path.js");

/** A finding's identity where a row names none: one site in one file. */
const SITE_IDENTITY = ["severity", "tag", "file", "match"];

/**
 * @typedef {string | { text: string, sites?: number }} RefusalLine
 * @typedef {object} PrecommitGate
 * @property {string} id the fault profile and refusal-table id
 * @property {string} script the checker, from the repo root
 * @property {"against" | "index"} flag `--against HEAD` or `--index`
 * @property {string} ere the ERE `armed` matches staged paths against; a
 *   `$JS_TEST_ERE` in it is the hook's own variable, expanded by the shell
 * @property {"merge" | "batch" | "none"} lander the queue lander's gate set
 *   that runs it beside a plain commit (#4545): `merge` runs before the hook's
 *   `--gates=merge` exit, `none` is a gate the lander's Actions run repeats
 * @property {string} staged a path whose staging arms it
 * @property {RefusalLine[]} refusals the lines any one of which names the gate
 * @property {string[]} [sources] the files printing `refusals`, where not the
 *   script alone
 * @property {string[]} [identity] the fields naming one fault, where not
 *   SITE_IDENTITY
 * @property {{ scope: string, cite: string, cost: string }} notice the
 *   post-commit fault notice's row
 * @property {boolean} floor whether base §0's floor table names it, it being
 *   a gate that judges code
 */

/** @type {PrecommitGate[]} */
const GATES = [
	/*
	 * Every parallel-safety rule in CLAUDE.md's guard-registry region states a
	 * backing that holds — an **Enforced** claim naming a guard that exists and
	 * is wired — and a commit must not leave a registry anchor expired that HEAD
	 * did not (#2617): the way out is the `--review` re-anchor, staged with it.
	 * scripts/ and .husky/ arm it because a guard is a file: deleting
	 * .husky/pre-commit falsifies an **Enforced** claim without any document
	 * changing. self-plugin/ holds the wiring an UNWIRED claim is judged
	 * against. Its report streams past on the way, so a session still meets the
	 * implicit-behaviour roster mantahostels#1261 put here.
	 *
	 * Identity is `file` + `rule`, which every FAIL kind carries; a staleness
	 * warning carries neither, and `guard` names its path. lib/fault-profiles.js
	 * widens its gating to the WARN the checker marks as refusing (#2617).
	 */
	{
		id: "guard-registry",
		script: "scripts/check-guard-registry.js",
		flag: "against",
		ere: String.raw`^(docs/|\.claude/|scripts/|\.husky/|self-plugin/|AGENTS\.md$|CLAUDE\.md$)`,
		lander: "merge",
		staged: "scripts/guard-x.sh",
		refusals: [
			"Fix the rule or fix the claim",
			"so its own header must say what",
			"has two parts that must agree",
			"decides whether the script runs at all",
		],
		identity: ["severity", "tag", "file", "rule", "guard"],
		notice: {
			scope: "whole-repo",
			cite: "(mantahostels#1801)",
			cost:
				"fails the scheduled sweeps, and warns every other session's commit " +
				"touching docs/, .claude/, scripts/, .husky/, self-plugin/, CLAUDE.md " +
				"or AGENTS.md, refusing only one that adds a fault of its own",
		},
		floor: false,
	},
	/*
	 * A scripts/ test that spawns a guard sourcing lib/guard-log.sh must
	 * redirect CLAUDE_CONFIG_DIR, or every fail-open it provokes is appended to
	 * the developer's real guard-errors.log (mantahostels#1452). Armed on every
	 * scripts/ .ts, since a shared helper can spawn the guard (#837), and on
	 * shell files, since a guard some test already spawns can start sourcing
	 * guard-log.sh. Whole-repo and `against`: the finding pairs a test with a
	 * script, and either half can be the one this commit stages
	 * (mantahostels#1753, mantahostels#1833).
	 *
	 * Identity excludes `guards`, which grows when an unrelated guard starts
	 * sourcing guard-log.sh.
	 */
	{
		id: "guard-test-isolation",
		script: "scripts/check-guard-test-isolation.js",
		flag: "against",
		ere: String.raw`^scripts/.*$JS_TEST_ERE|^scripts/.*\.(ts|sh)$`,
		lander: "none",
		staged: "scripts/a.test.ts",
		refusals: ["without setting CLAUDE_CONFIG_DIR, so a fail-open it provokes"],
		identity: ["severity", "tag", "file"],
		notice: {
			scope: "whole-repo",
			cite: "(mantahostels#1753)",
			cost:
				"fails the scheduled sweeps, and warns every other session's commit " +
				"touching a scripts/ test, .ts or shell file, refusing only one that " +
				"adds a fault of its own",
		},
		floor: true,
	},
	/*
	 * A scripts/ test that spawns a hostRoot()- or gr_root-rooted script must
	 * redirect CLAUDE_PROJECT_DIR, or the child roots itself in the real repo
	 * (#160; #3311, a bash checker). Whole-repo and `against` as
	 * guard-test-isolation's.
	 *
	 * Identity excludes `scripts`, which grows when an unrelated script starts
	 * requiring lib/host-root.js (#160).
	 */
	{
		id: "host-root-test-isolation",
		script: "scripts/check-host-root-test-isolation.js",
		flag: "against",
		ere: String.raw`^scripts/.*$JS_TEST_ERE|^scripts/.*\.(js|sh)$`,
		lander: "batch",
		staged: "scripts/a.test.ts",
		refusals: ["without setting CLAUDE_PROJECT_DIR, so the child roots itself"],
		identity: ["severity", "tag", "file"],
		notice: {
			scope: "whole-repo",
			cite: "(mantahostels#1753)",
			cost:
				"warns every other session's commit touching a scripts/ test or " +
				"script, refusing only one that adds a fault of its own",
		},
		floor: true,
	},
	/*
	 * A scripts/ test that raw-inits and raw-commits a git repo gives that repo
	 * its own identity, or it passes on every developer machine and fails on a
	 * runner with none (mantahostels#2355). Whole-repo and `against`: the init
	 * and commit sites can sit anywhere in one file, and a pathspec commit's
	 * staged-paths-only view could hold one without the other.
	 *
	 * Identity excludes `repos`, which grows when a second repo key joins an
	 * already-faulted file.
	 */
	{
		id: "git-fixture-identity",
		script: "scripts/check-git-fixture-identity.js",
		flag: "against",
		ere: "^scripts/.*$JS_TEST_ERE",
		lander: "none",
		staged: "scripts/a.test.ts",
		refusals: ["with no identity set for it, so it fails on a runner"],
		identity: ["severity", "tag", "file"],
		notice: {
			scope: "whole-repo",
			cite: "(mantahostels#1753)",
			cost:
				"fails the scheduled sweeps, and warns every other session's commit " +
				"touching a scripts/ test file, refusing only one that adds a " +
				"raw-init/raw-commit pair of its own",
		},
		floor: true,
	},
	/*
	 * A JS test sets or unsets an env var through vi.stubEnv, never a direct
	 * process.env write or delete, which vitest.config.ts's unstubEnvs never
	 * restores (#4019). Armed on every test vitest collects and every scripts/
	 * .ts helper; staged here as a helper alone, test-kind.test.ts pinning the
	 * test-file arm.
	 *
	 * The subject is one variable in one test file; `line` is excluded, as an
	 * edit higher up moves an inherited fault.
	 */
	{
		id: "test-env-writes",
		script: "scripts/check-test-env-writes.js",
		flag: "against",
		ere: String.raw`$JS_TEST_ERE|^scripts/.*\.ts$`,
		lander: "none",
		staged: "scripts/lib/a-testkit.ts",
		refusals: [
			"which unstubEnvs never restores, so the change outlives its case",
		],
		identity: ["severity", "tag", "file", "name"],
		notice: {
			scope: "whole-repo",
			cite: "(mantahostels#1753)",
			cost:
				"fails the scheduled sweeps, and warns every other session's commit " +
				"touching a test file, refusing only one that adds a direct " +
				"process.env assignment of its own",
		},
		floor: true,
	},
	/*
	 * Every script in the core finds the HOST repository through the one seam
	 * (#1), never by walking up from its own file: installed as a plugin the
	 * core sits in the plugin cache, where a self-rooted script reads the
	 * cache. The mirror fault is gated too — a file shipping WITH the core
	 * reached through the host root. A repo shipping no plugin SKIPs (#83).
	 * Whole-repo, since a site is judged against core-path constants other
	 * modules export (#917).
	 *
	 * The subject is the script file; `line` is excluded.
	 */
	{
		id: "host-root",
		script: "scripts/check-host-root.js",
		flag: "against",
		ere: String.raw`^(scripts/|\.claude/|\.husky/)`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: [
			{ text: "Use hostRoot() from lib/host-root.js", sites: 2 },
			"Source lib/guard-root.sh and call gr_root.",
			"reached through the host root",
			"reached through the HOST root",
		],
		identity: ["severity", "tag", "file"],
		notice: {
			scope: "every script's host-root seam",
			cite: "(#917)",
			cost: "warns every other session's commit touching scripts/, .claude/ or .husky/",
		},
		floor: true,
	},
	/*
	 * The brand sheet's §11 banned tells, on the copy strings under app/
	 * (mantahostels#858). `against` (mantahostels#1834): a tell HEAD already
	 * carries reports without blocking a bystander. Repo prose and source
	 * comments are out of scope.
	 *
	 * One banned tell in one file; `line` and `context` are excluded, a rewrite
	 * of the neighbouring sentence changing the second without the tell.
	 */
	{
		id: "website-copy",
		script: "scripts/check-website-copy.js",
		flag: "against",
		ere: "^app/",
		lander: "none",
		staged: "app/page.tsx",
		refusals: ["These are banned tells from"],
		notice: {
			scope: "whole-repo scan of app/",
			cite: "(mantahostels#1834)",
			cost: "warns every other session's commit touching app/",
		},
		floor: false,
	},
	/*
	 * An own skill whose frontmatter js-yaml rejects, which a strict reader
	 * drops silently (#887). js-yaml's absence refuses, naming the install
	 * (#1380). Identity excludes `at`, which a line added above moves.
	 */
	{
		id: "skill-frontmatter",
		script: "scripts/check-skill-frontmatter.js",
		flag: "against",
		ere: String.raw`^\.claude/skills/[^/]+/SKILL\.md$`,
		lander: "none",
		staged: ".claude/skills/s/SKILL.md",
		refusals: ["A strict YAML reader drops this skill (#887)."],
		identity: ["severity", "tag", "file"],
		notice: {
			scope: "every own skill",
			cite: "(#887)",
			cost: "fails the scheduled sweep, and warns every other session's commit touching that skill",
		},
		floor: true,
	},
	/*
	 * A hook, guard or checker of the repo's own left unregistered, untested or
	 * uncounted (#1456), standing down wherever the repo carries the core's
	 * registration tests; there it refuses any settings hook but the
	 * self-plugin canary (#2447). `key` names the member and what it lacks, so
	 * an adopter's inherited gaps warn and only a new one refuses.
	 */
	{
		id: "registrations",
		script: "scripts/check-registrations.js",
		flag: "against",
		ere: String.raw`^(\.claude/(settings|registrations|guard-fire-needles)\.json$|self-plugin/hooks/hooks\.json$|scripts/|\.husky/|\.github/workflows/)`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: [
			"is run by no hook in .claude/settings.json",
			"is run by no husky hook, workflow,",
			"has no `hooks` row",
			"the `hooks` row for ",
			"has no sibling test (",
			"`calledElsewhere` names ",
		],
		sources: ["scripts/lib/registrations.js"],
		identity: ["severity", "tag", "key"],
		notice: {
			scope: "a host's own hooks, guards and checkers",
			cite: "(#1456)",
			cost: "refuses every other session's commit touching .claude/settings.json, a host registry, scripts/, .husky/ or a workflow",
		},
		floor: true,
	},
	/*
	 * A script reading its command line without a strict parser, which ignores
	 * an unknown flag and so runs its side effect on `--help` (#920, #1532).
	 * `content` is the file's hash, so a commit editing an inherited script
	 * still on no strict parser refuses: the ratchet that moves each onto one
	 * when next touched.
	 */
	{
		id: "cli-args",
		script: "scripts/check-cli-args.js",
		flag: "against",
		ere: String.raw`^scripts/[^/]+\.js$`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: ["fall through to the default action"],
		identity: ["severity", "tag", "file", "content"],
		notice: {
			scope: "every top-level script's argv reader",
			cite: "(#920)",
			cost: "refuses every other session's commit that edits that script until it parses its argv strictly",
		},
		floor: true,
	},
	/*
	 * A test spawning node on the program under test rather than running it
	 * through runInProcess, with no `spawn-kept: <why>` (§X3, #3458). One spawn
	 * per finding, at its call's first line and occurrence, never its line
	 * number.
	 */
	{
		id: "test-spawn",
		script: "scripts/check-test-spawn.js",
		flag: "index",
		ere: String.raw`^(scripts|\.claude/skills)/.*$JS_TEST_ERE`,
		lander: "batch",
		staged: "scripts/a.test.ts",
		refusals: ["spawns node on the program under test"],
		identity: ["severity", "tag", "file", "call", "nth"],
		notice: {
			scope: "every test's spawn of node on the program under test",
			cite: "(#3458)",
			cost: "refuses every other session's commit staging a test until that spawn runs in-process or states why",
		},
		floor: true,
	},
	/*
	 * A hand split-and-parse of JSONL rather than lib/jsonl.js (#3452, #3453).
	 * `match` is the split line's text and its occurrence in the file, so a
	 * line added above an inherited site leaves it inherited and a second copy
	 * is new: every `index` gate below keys its sites the same way.
	 */
	{
		id: "jsonl-reads",
		script: "scripts/check-jsonl-reads.js",
		flag: "index",
		ere: String.raw`^scripts/.+\.[cm]?js$`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: ["hand-parses JSONL"],
		notice: {
			scope: "every hand split-and-parse of JSONL",
			cite: "(#3452, #3453)",
			cost: "refuses every other session's commit staging a scripts/ program until that site reads through lib/jsonl.js",
		},
		floor: true,
	},
	/*
	 * A `gh` call off lib/gh.js and WFC_GH, or a `claude` call off
	 * lib/claude-bin.js and WFC_CLAUDE_BIN: a second var, a local spawn, a bare
	 * shell call or a test's PATH stub (§X2, §N7; #3455, #3559).
	 */
	{
		id: "gh-route",
		script: "scripts/check-gh-route.js",
		flag: "index",
		ere: String.raw`^(scripts|\.claude/skills|\.husky|hooks)/`,
		lander: "batch",
		staged: "scripts/a.sh",
		refusals: ["off its one route"],
		sources: ["scripts/check-gh-route.js", "scripts/lib/gh-route.js"],
		notice: {
			scope: "every `gh` call off lib/gh.js and WFC_GH",
			cite: "(#3455)",
			cost: "refuses every other session's commit staging scripts/, .claude/skills/, .husky/ or hooks/ until that call reads WFC_GH",
		},
		floor: true,
	},
	/* An arbiter command spelt by hand rather than through buildArbiterCommand (#3990). */
	{
		id: "arbiter-commands",
		script: "scripts/check-arbiter-commands.js",
		flag: "index",
		ere: String.raw`^scripts/.+\.[cm]?js$`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: ["spells an arbiter command by hand"],
		notice: {
			scope:
				"every arbiter command spelt by hand rather than through buildArbiterCommand",
			cite: "(#3990)",
			cost: "refuses every other session's commit staging a scripts/ program until that command goes through the tag",
		},
		floor: true,
	},
	/* A program reading WFC_NOW itself rather than lib/check.js's now() (#3457). */
	{
		id: "clock-copies",
		script: "scripts/check-clock-copies.js",
		flag: "index",
		ere: String.raw`^scripts/.+\.[cm]?js$`,
		lander: "batch",
		staged: "scripts/a.js",
		refusals: ["reads WFC_NOW itself"],
		notice: {
			scope: "every WFC_NOW read outside lib/check.js's now()",
			cite: "(#3457)",
			cost: "refuses every other session's commit staging a scripts/ program until that read goes through now()",
		},
		floor: true,
	},
	/* A report-* program filing past createIssue (#3454). Only a report-*
	 * holds the breach, so only staging one arms it. */
	{
		id: "report-programs",
		script: "scripts/check-report-programs.js",
		flag: "index",
		ere: String.raw`^scripts/report-[^/]+\.[cm]?js$`,
		lander: "batch",
		staged: "scripts/report-a.js",
		refusals: ["report-program breach(es)"],
		notice: {
			scope: "every report-* program's issue filing",
			cite: "(#3454)",
			cost: "refuses every other session's commit staging a report-* until that program files through createIssue",
		},
		floor: true,
	},
	/* A program ending in process.exit writing past writeFd (§N6, #4018). */
	{
		id: "program-output",
		script: "scripts/check-program-output.js",
		flag: "index",
		ere: String.raw`^(scripts|\.claude/skills/[^/]+/scripts)/.+\.[cm]?js$`,
		lander: "batch",
		staged: ".claude/skills/s/scripts/a.js",
		refusals: ["write(s) past writeFd"],
		notice: {
			scope: "every write past writeFd in a program ending in process.exit",
			cite: "(#4018)",
			cost: "refuses every other session's commit staging a scripts/ or skill program until that write goes through writeFd",
		},
		floor: true,
	},
	/* A checker line in .husky/pre-commit or .husky/pre-commit.local exiting 1
	 * on its failure, which turns its BROKEN into a finding (§N4, #3456). Keyed
	 * on the line's text, never its number. */
	{
		id: "precommit-exit",
		script: "scripts/check-precommit-exit.js",
		flag: "index",
		ere: String.raw`^\.husky/pre-commit(\.local)?$`,
		lander: "batch",
		staged: ".husky/pre-commit",
		refusals: ["exits 1 on a checker's failure"],
		sources: [
			"scripts/check-precommit-exit.js",
			"scripts/lib/precommit-exit.js",
		],
		notice: {
			scope:
				"every checker line in .husky/pre-commit and .husky/pre-commit.local",
			cite: "(#3456)",
			cost: "refuses every other session's commit staging either hook until that line passes its checker's exit code on",
		},
		floor: true,
	},
];

/** The hook argument each flag renders as. */
const FLAG_ARGS = { against: "--against HEAD", index: "--index" };

/**
 * A path from the core root, absolute, in the core the running code sits in:
 * not script-path.js's corePath, which spells one for a command line.
 * @param {string} rel
 * @returns {string}
 */
const fromCoreRoot = (rel) => path.join(coreRoot(), rel);

module.exports = { FLAG_ARGS, GATES, fromCoreRoot, SITE_IDENTITY };
