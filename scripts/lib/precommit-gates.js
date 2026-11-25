const path = require("node:path");
const { coreRoot } = require("./script-path.js");
const { JS_TEST_FILE } = require("./test-kind.js");

const JS_TEST = JS_TEST_FILE.source;

const SITE_IDENTITY = ["severity", "tag", "file", "match"];

/**
 * @typedef {string | { text: string, sites?: number }} RefusalLine
 * @typedef {object} MemberGate
 * @property {string} id
 * @property {string} script
 * @property {import("./precommit-dispatch.js").Lander} lander
 * @property {string[]} args
 * @property {import("./precommit-dispatch.js").Arm} arm
 * @property {"gate" | "warn"} policy
 * @property {"checker" | "program"} kind
 * @property {string} [side]
 * @property {boolean} [quietPass]
 * @property {import("./precommit-dispatch.js").When} [when]
 * @typedef {(io: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *   import("./precommit-dispatch.js").RowResult} Program
 * @typedef {object} ProfileFields
 * @property {string} staged
 * @property {RefusalLine[]} refusals
 * @property {string[]} [sources]
 * @property {string[]} [identity]
 * @property {{ scope: string, cite: string, cost: string }} notice
 * @property {boolean} floor
 * @typedef {MemberGate & ProfileFields} ProfileGate
 * @typedef {MemberGate | ProfileGate} PrecommitGate
 */

/** @type {PrecommitGate[]} */
const GATES = [
	{
		id: "main-checkout-commit",
		script: "scripts/check-main-checkout-commit.js",
		lander: "every",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "guard-registry",
		script: "scripts/check-guard-registry.js",
		lander: "merge",
		args: ["--against", "HEAD"],
		arm: {
			pattern:
				/^(docs\/|\.claude\/|scripts\/|\.husky\/|self-plugin\/|AGENTS\.md$|CLAUDE\.md$)/,
		},
		policy: "gate",
		kind: "checker",
		side:
			"its judged root is a module variable --root resets and its rule store an " +
			"env var it writes, so an in-process index side leaves the parent reading " +
			"a removed tree",
		staged: "scripts/guard-x.sh",
		refusals: [
			"Fix the rule or fix the claim",
			"keyed by its path, must say what",
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
	{
		id: "test-read-edges",
		script: "scripts/generate-test-read-edges.js",
		lander: "none",
		args: ["--check"],
		arm: {
			pattern: new RegExp(String.raw`${JS_TEST}|^docs/test-read-edges\.json$`),
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "review-hold",
		script: "scripts/review-hold-gate.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "program",
	},
	{
		id: "roadmap-pair",
		script: "scripts/check-roadmap-pair.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "roadmap-valid",
		script: "scripts/check-roadmap-valid.js",
		lander: "batch",
		args: [],
		arm: { pattern: /^docs\/reference-roadmap\.html$/ },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "citation-tracker",
		script: "scripts/check-citation-tracker.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "gate-switches",
		script: "scripts/check-gate-switches.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "lockfile-sync",
		script: "scripts/check-lockfile-sync.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "research-added",
		script: "scripts/check-research-added.js",
		lander: "batch",
		args: [],
		arm: { pattern: /^docs\/research\// },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "vendored-skills",
		script: "scripts/check-vendored-skills.js",
		lander: "batch",
		args: [],
		arm: {
			pattern:
				/^(\.agents\/skills\/|\.agents\/vendored-skill-edits\.json$|skills-lock\.json$|\.claude\/skills\/THIRD-PARTY-NOTICES\.md$)/,
		},
		policy: "gate",
		kind: "checker",
	},
	{
		id: "hook-liveness",
		script: "scripts/check-hook-liveness.js",
		lander: "batch",
		args: ["--only", "self-plugin"],
		arm: {
			pattern:
				/^(self-plugin\/hooks\/hooks\.json$|\.claude\/settings\.json$|scripts\/)/,
		},
		policy: "gate",
		kind: "checker",
	},
	{
		id: "plugin-hooks",
		script: "scripts/generate-plugin-hooks.js",
		lander: "batch",
		args: ["--check"],
		arm: {
			pattern:
				/^(self-plugin\/hooks\/hooks\.json|hooks\/hooks\.json|scripts\/[^/]+|scripts\/lib\/(core-hooks|deny-capable|guard-fires)\.js)$/,
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "guard-test-isolation",
		script: "scripts/check-guard-test-isolation.js",
		lander: "none",
		args: ["--against", "HEAD"],
		arm: {
			pattern: new RegExp(
				String.raw`^scripts/.*${JS_TEST}|^scripts/.*\.(ts|sh)$`,
			),
		},
		policy: "gate",
		kind: "checker",
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
	{
		id: "host-root-test-isolation",
		script: "scripts/check-host-root-test-isolation.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: {
			pattern: new RegExp(
				String.raw`^scripts/.*${JS_TEST}|^scripts/.*\.(js|sh)$`,
			),
		},
		policy: "gate",
		kind: "checker",
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
	{
		id: "git-fixture-identity",
		script: "scripts/check-git-fixture-identity.js",
		lander: "none",
		args: ["--against", "HEAD"],
		arm: { pattern: new RegExp(`^scripts/.*${JS_TEST}`) },
		policy: "gate",
		kind: "checker",
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
	{
		id: "test-env-writes",
		script: "scripts/check-test-env-writes.js",
		lander: "none",
		args: ["--against", "HEAD"],
		arm: { pattern: new RegExp(String.raw`${JS_TEST}|^scripts/.*\.ts$`) },
		policy: "gate",
		kind: "checker",
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
	{
		id: "host-root",
		script: "scripts/check-host-root.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: { pattern: /^(scripts\/|\.claude\/|\.husky\/)/ },
		policy: "gate",
		kind: "checker",
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
	{
		id: "website-copy",
		script: "scripts/check-website-copy.js",
		lander: "none",
		args: ["--against", "HEAD"],
		arm: { pattern: /^app\// },
		policy: "gate",
		kind: "checker",
		staged: "app/page.tsx",
		refusals: ["These are banned tells from"],
		notice: {
			scope: "whole-repo scan of app/",
			cite: "(mantahostels#1834)",
			cost: "warns every other session's commit touching app/",
		},
		floor: false,
	},
	{
		id: "skill-frontmatter",
		script: "scripts/check-skill-frontmatter.js",
		lander: "none",
		args: ["--against", "HEAD"],
		arm: { pattern: /^\.claude\/skills\/[^/]+\/SKILL\.md$/ },
		policy: "gate",
		kind: "checker",
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
	{
		id: "hand-callers",
		script: "scripts/check-hand-callers.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: { pattern: /^(scripts\/|\.claude\/skills\/[^/]+\/scripts\/)/ },
		policy: "gate",
		kind: "checker",
		staged: "scripts/a.js",
		identity: ["severity", "tag", "file", "match", "nth"],
		refusals: [
			"a hand-kept caller list goes stale on every caller edit (#4404).",
		],
		notice: {
			scope: "every script header under scripts/ and a skill's scripts/",
			cite: "(#4885)",
			cost: "warns every other session's commit staging a script",
		},
		floor: true,
	},
	{
		id: "comment-policy",
		script: "scripts/check-comment-policy.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: { pattern: /\.(?:[cm]?[jt]sx?|py|sh|bash)$|(?:^|\/)[^/.]+$/ },
		when: { facts: ["module:comments"] },
		policy: "gate",
		kind: "checker",
		staged: "scripts/a.js",
		identity: ["severity", "tag", "file", "match", "nth"],
		sources: ["scripts/lib/comment-policy.js"],
		refusals: [
			"fits no permitted comment kind",
			"not on the style-only list",
			"suppression naming no rule",
			"names no file under docs/adr/",
		],
		notice: {
			scope: "every JS, TS, Python and shell file",
			cite: "(#5490)",
			cost: "warns every other session's commit staging code",
		},
		floor: false,
	},
	{
		id: "registrations",
		script: "scripts/check-registrations.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: {
			pattern:
				/^(\.claude\/(settings|registrations|guard-fire-needles)\.json$|self-plugin\/hooks\/hooks\.json$|scripts\/|\.husky\/|\.github\/workflows\/)/,
		},
		policy: "gate",
		kind: "checker",
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
	{
		id: "cli-args",
		script: "scripts/check-cli-args.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: { pattern: /^scripts\/[^/]+\.js$/ },
		policy: "gate",
		kind: "checker",
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
	{
		id: "test-spawn",
		script: "scripts/check-test-spawn.js",
		lander: "batch",
		args: ["--index"],
		arm: {
			pattern: new RegExp(String.raw`^(scripts|\.claude/skills)/.*${JS_TEST}`),
		},
		policy: "gate",
		kind: "checker",
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
	{
		id: "jsonl-reads",
		script: "scripts/check-jsonl-reads.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^scripts\/.+\.[cm]?js$/ },
		policy: "gate",
		kind: "checker",
		staged: "scripts/a.js",
		refusals: ["hand-parses JSONL"],
		notice: {
			scope: "every hand split-and-parse of JSONL",
			cite: "(#3452, #3453)",
			cost: "refuses every other session's commit staging a scripts/ program until that site reads through lib/jsonl.js",
		},
		floor: true,
	},
	{
		id: "gh-route",
		script: "scripts/check-gh-route.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^(scripts|\.claude\/skills|\.husky|hooks)\// },
		policy: "gate",
		kind: "checker",
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
	{
		id: "arbiter-commands",
		script: "scripts/check-arbiter-commands.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^scripts\/.+\.[cm]?js$/ },
		policy: "gate",
		kind: "checker",
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
	{
		id: "clock-copies",
		script: "scripts/check-clock-copies.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^scripts\/.+\.[cm]?js$/ },
		policy: "gate",
		kind: "checker",
		staged: "scripts/a.js",
		refusals: ["reads WFC_NOW itself"],
		notice: {
			scope: "every WFC_NOW read outside lib/clock.js's now()",
			cite: "(#3457)",
			cost: "refuses every other session's commit staging a scripts/ program until that read goes through now()",
		},
		floor: true,
	},
	{
		id: "report-programs",
		script: "scripts/check-report-programs.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^scripts\/report-[^/]+\.[cm]?js$/ },
		policy: "gate",
		kind: "checker",
		staged: "scripts/report-a.js",
		refusals: ["report-program breach(es)"],
		notice: {
			scope: "every report-* program's issue filing",
			cite: "(#3454)",
			cost: "refuses every other session's commit staging a report-* until that program files through createIssue",
		},
		floor: true,
	},
	{
		id: "program-output",
		script: "scripts/check-program-output.js",
		lander: "batch",
		args: ["--index"],
		arm: {
			pattern: /^(scripts|\.claude\/skills\/[^/]+\/scripts)\/.+\.[cm]?js$/,
		},
		policy: "gate",
		kind: "checker",
		staged: ".claude/skills/s/scripts/a.js",
		refusals: ["write(s) past writeFd"],
		notice: {
			scope: "every write past writeFd in a program ending in process.exit",
			cite: "(#4018)",
			cost: "refuses every other session's commit staging a scripts/ or skill program until that write goes through writeFd",
		},
		floor: true,
	},
	{
		id: "precommit-exit",
		script: "scripts/check-precommit-exit.js",
		lander: "batch",
		args: ["--index"],
		arm: { pattern: /^\.husky\/pre-commit(\.local)?$/ },
		policy: "gate",
		kind: "checker",
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
	{
		id: "rule-fragments",
		script: "scripts/generate-rule-fragments.js",
		lander: "batch",
		args: ["--check"],
		arm: {
			pattern: /^docs\/agents\/rules\//,
			computed: "rule-fragment-sources",
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "effort-guide-routing",
		script: "scripts/generate-effort-guide-routing.js",
		lander: "batch",
		args: ["--check"],
		arm: {
			pattern:
				/^(docs\/effort-guide\.md|scripts\/lib\/model-routing\.json|scripts\/generate-effort-guide-routing\.js|scripts\/lib\/model-table\.js)$/,
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "core-docs",
		script: "scripts/generate-core-docs.js",
		lander: "batch",
		args: ["--check"],
		arm: {
			pattern:
				/^(GLOSSARY\.md|docs\/doc-map\.md|\.claude\/workflow-core\.(glossary|doc-map)\.md|scripts\/generate-core-docs\.js|scripts\/lib\/core-docs\.js)$/,
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "user-settings-drift",
		script: "scripts/check-user-settings-drift.js",
		lander: "batch",
		args: ["--warn"],
		arm: { always: true },
		policy: "warn",
		kind: "checker",
	},
	{
		id: "code-standards",
		script: "scripts/check-code-standards.js",
		lander: "batch",
		args: ["--touching", "HEAD", "--warn"],
		arm: { always: true },
		policy: "warn",
		kind: "checker",
	},
	{
		id: "primitives",
		script: "scripts/check-primitives.js",
		lander: "batch",
		args: ["--paths-only"],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "skill-body-size",
		script: "scripts/check-skill-body-size.js",
		lander: "batch",
		args: ["--touching", "HEAD"],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "adopter-boundary",
		script: "scripts/check-adopter-boundary.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "workflow-permissions",
		script: "scripts/check-workflow-permissions.js",
		lander: "none",
		args: [],
		arm: { pattern: /^\.github\/workflows\/[^/]+\.ya?ml$/, live: true },
		policy: "gate",
		kind: "checker",
	},
	{
		id: "doc-map",
		script: "scripts/lib/doc-map-gate-program.js",
		lander: "batch",
		args: [],
		arm: {
			pattern:
				/^(docs\/|\.claude\/|hooks\/|self-plugin\/|AGENTS\.md$|CLAUDE\.md$|PRODUCT\.md$|DESIGN\.md$|GLOSSARY\.md$)/,
		},
		policy: "gate",
		kind: "program",
	},
	{
		id: "context-budget",
		script: "scripts/check-context-budget.js",
		lander: "batch",
		args: ["--against", "HEAD"],
		arm: {
			pattern:
				/^(CLAUDE\.md$|AGENTS\.md$|docs\/|\.claude\/|scripts\/|self-plugin\/)/,
			computed: "always-loaded-pool",
		},
		policy: "gate",
		kind: "checker",
		quietPass: true,
	},
	{
		id: "injector-margin",
		script: "scripts/check-injector-margin.js",
		lander: "batch",
		args: ["--index"],
		arm: {
			pattern:
				/^(scripts\/lib\/tracker-inject-text\.js|docs\/agents\/rules\/review-(dispatch-shape|deviations-read|finding-destination)\.txt)$/,
		},
		policy: "gate",
		kind: "checker",
	},
];

/**
 * @param {PrecommitGate} g
 * @returns {g is ProfileGate}
 */
const isProfileGate = (g) => "notice" in g;

const PROFILE_GATES = GATES.filter(isProfileGate);

/**
 * @param {string} rel
 * @returns {string}
 */
const fromCoreRoot = (rel) => path.join(coreRoot(), rel);

module.exports = { GATES, fromCoreRoot, PROFILE_GATES, SITE_IDENTITY };
