/*
 * precommit-gates.js — the pre-commit's Node gates, one row per gate (#4597).
 * Each row is the gate's one registration, read by:
 *
 * - scripts/precommit-dispatch.js, which runs the rows in this order in one
 *   process (#5172), lib/precommit-dispatch.js's header holding the contract.
 * - lib/fault-profiles.js's PROFILES, from a profile row's `identity`.
 * - lib/shared-fault-notices.js's NOTICES, from its `notice`.
 * - lib/arm-secondary.js's refusal table, from its `refusals`; a member with
 *   no profile keeps its lines in scripts/commit-gate-refusals.json.
 * - The row test (precommit-whole-repo-gates.test.ts), the refusal-source
 *   test (lib/arm-secondary.test.ts) and base §0's floor test
 *   (tooling-matrix.test.ts), which iterate PROFILE_GATES.
 *
 * Base §0's floor table is the one edit a new code gate still owes beside its
 * row: that table mixes these gates with gates of other shapes in one curated
 * order, so the floor test requires a row naming each `floor` gate's script
 * rather than rendering it.
 *
 * THE BASELINE MUST EXIST for an `against` gate: lib/check.js resolves
 * HEAD^{tree} before it reads anything, so in a repo with no commit yet the
 * gate is BROKEN, exit 2, refusing the very first commit (mantahostels#1940).
 * Mid-merge, an `against` gate also inherits a fault a merged-in head already
 * on `main` carries (#4582).
 * An `index` gate judges the tree this commit makes, never an untracked or
 * unstaged file outside it, and still refuses a breach HEAD already carries
 * (#3687).
 *
 * `script` and `sources` are spelt from the core root, and `fromCoreRoot` reads
 * them there through coreRoot(), the anchor under which the read-edge
 * extractor attributes them to a test importing this module (base §X10).
 */

const path = require("node:path");
const { coreRoot } = require("./script-path.js");
const { JS_TEST_FILE } = require("./test-kind.js");

/** A JS test file's name, the arm of every row reading scripts/ tests. */
const JS_TEST = JS_TEST_FILE.source;

/** A finding's identity where a row names none: one site in one file. */
const SITE_IDENTITY = ["severity", "tag", "file", "match"];

/**
 * @typedef {string | { text: string, sites?: number }} RefusalLine
 * @typedef {object} MemberGate
 * @property {string} id the gate's refusal-table id, and its fault profile's
 *   where it has one
 * @property {string} script the checker, from the repo root
 * @property {import("./precommit-dispatch.js").Lander} lander the queue
 *   lander's gate sets that run it beside a plain commit (#4545): `every`
 *   both, `merge` the merge set, `batch` the batch set, `none` neither, a
 *   gate the lander's Actions run repeats
 * @property {string[]} args what the dispatcher hands the checker; on a
 *   program row, the arguments under which its script's own process runs
 *   what PROGRAM runs, which check-in-process-armed-rows and
 *   check-in-process-always-rows hold equal
 * @property {import("./precommit-dispatch.js").Arm} arm the staged paths
 *   that run it
 * @property {"gate" | "warn"} policy whether its red refuses the commit
 * @property {"checker" | "program"} kind a lib/check.js checker exporting
 *   its SPEC, or a program exporting its PROGRAM
 * @property {string} [side] why its `--against`/`--index` sides spawn the
 *   checker rather than run in-process, where they do
 * @property {boolean} [quietPass] its pass prints nothing unless it WARNs
 * @typedef {(io: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *   import("./precommit-dispatch.js").RowResult} Program a program row's
 *   core: its exit code and output over the repo at `cwd`, never a write to
 *   this process's own state
 * @typedef {object} ProfileFields a whole-repo checker's, its faults
 *   attributed to the commit that adds them
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
 * @typedef {MemberGate & ProfileFields} ProfileGate
 * @typedef {MemberGate | ProfileGate} PrecommitGate
 */

/** @type {PrecommitGate[]} */
const GATES = [
	/*
	 * Once the main checkout is cut over to the worktree model (#4248), it takes
	 * no commit at all: its main moves by the levelling step's fast-forward
	 * alone.
	 */
	{
		id: "main-checkout-commit",
		script: "scripts/check-main-checkout-commit.js",
		lander: "every",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * Every parallel-safety rule in CLAUDE.md's guard-registry region states a
	 * backing that holds — an **Enforced** claim naming a guard that exists and
	 * is wired — and a commit must not leave a registry anchor expired that HEAD
	 * did not (#2617): the way out is the `--review` re-anchor, staged with it.
	 * scripts/ and .husky/ arm it because a guard is a file: deleting
	 * .husky/pre-commit falsifies an **Enforced** claim without any document
	 * changing. self-plugin/ holds the wiring an UNWIRED claim is judged
	 * against.
	 *
	 * Identity is `file` + `rule`, which every FAIL kind carries; a staleness
	 * warning carries neither, and `guard` names its path. lib/fault-profiles.js
	 * widens its gating to the WARN the checker marks as refusing (#2617).
	 */
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
	 * docs/test-read-edges.json lets `--changed` select the tests that READ a
	 * document rather than import it. It is derived from the test corpus, so a
	 * commit adding or removing a runtime read makes it stale, and a stale
	 * manifest fails silently (mantahostels#2031). Armed on test files and the manifest, not on
	 * docs/: adding a document changes no edge until a test reads it. Neither
	 * lander set runs it: each lander merge has just written the manifest with
	 * this generator (lib/regenerated-files.js, #4573).
	 */
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
	/*
	 * A session's commit on a declared sensitive path with no escalated review
	 * of exactly its staged tree (#1622). The program owns its skips.
	 */
	{
		id: "review-hold",
		script: "scripts/review-hold-gate.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "program",
	},
	/*
	 * The roadmap HTML and its digest are only correct together; refuse the
	 * half-staged pair here rather than leaving it to CI.
	 */
	{
		id: "roadmap-pair",
		script: "scripts/check-roadmap-pair.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * The staged roadmap is structurally valid, or it does not get committed
	 * (mantahostels#698). The checker judges the STAGED blob against HEAD's, so
	 * an unsaved roadmap edit the commit does not carry stays out of it. Only
	 * validator ERRORs refuse; WARNINGs and the added/removed card list report
	 * and pass, a roadmap-edit run that adds a card being ordinary work.
	 */
	{
		id: "roadmap-valid",
		script: "scripts/check-roadmap-valid.js",
		lander: "none",
		args: [],
		arm: { pattern: /^docs\/reference-roadmap\.html$/ },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A citation of this repo's tracker is bare `#N`; `mantahostels#N` names
	 * the inherited tracker (#162). Unarmed by path: the fault landed in
	 * shell, JS, TS, JSON and markdown alike, so there is no directory to
	 * narrow on. Not content-armed either: a pre-filter that fails leaves the
	 * gate green, which contradicts the checker's own fail-safe annotation.
	 *
	 * DEFEAT:    a `citation-exempt: <why>` comment drops one line, and
	 *            WFC_CITATION_TRACKER_OFF=1 stands the gate down for one commit.
	 */
	{
		id: "citation-tracker",
		script: "scripts/check-citation-tracker.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A gate's subject tracked while its switch is off (#1506). Unarmed, as it judges the whole
	 * index: a subject that landed before this shipped is refused at the next
	 * commit.
	 */
	{
		id: "gate-switches",
		script: "scripts/check-gate-switches.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A staged lockfile out of step with the staged package.json (#2029). The
	 * refusal prints the lockfile rule, whose only delivery this is. Unarmed
	 * here: the checker arms itself on the paths it reads, so the two cannot
	 * drift (#3434).
	 */
	{
		id: "lockfile-sync",
		script: "scripts/check-lockfile-sync.js",
		lander: "batch",
		args: [],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A file added under docs/research/ (#2356): research is posted on its
	 * issue, never landed in the tree. The refusal prints the rule.
	 */
	{
		id: "research-added",
		script: "scripts/check-research-added.js",
		lander: "batch",
		args: [],
		arm: { pattern: /^docs\/research\// },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A local edit to a vendored skill body is declared, or this commit does
	 * not land (mantahostels#1809, specified at mantahostels#1826). Armed on a
	 * vendored path, the manifest or the licence notices (#1939). It reads the
	 * worktree, not the index: all the vendored files plus the manifest are too
	 * many paths to stage out one by one.
	 */
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
	/*
	 * Every command the core registers its own hooks with resolves to a file
	 * that exists, and is executable where the command runs it directly
	 * (mantahostels#1898): a hook wired to a missing path fires nothing and
	 * says nothing. Armed on either registration file or a script, since
	 * renaming a guard falsifies the wiring without the registration changing.
	 * The working tree, not the index: whether a hook can run is a property of
	 * the files on this machine now. Only the self-plugin assertion; its
	 * siblings read ~/.claude and answer on `npm run status`.
	 */
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
	/*
	 * hooks/hooks.json is the plugin's copy of the self-plugin's hooks, so an
	 * edit there without a re-render ships adopters the old hook set (#4,
	 * #2441). Any script too: one that gains or loses a deny moves its
	 * onFailure (#2670).
	 */
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
	/*
	 * An own skill whose frontmatter js-yaml rejects, which a strict reader
	 * drops silently (#887). js-yaml's absence refuses, naming the install
	 * (#1380). Identity excludes `at`, which a line added above moves.
	 */
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
	/*
	 * A script header line keeping a caller list by hand, which goes stale on
	 * every caller edit (#4885). Identity is the line's text and its
	 * occurrence in the file, never `line`, which a line added above moves, so
	 * an adopter's inherited lines warn and only a new one refuses. A renamed
	 * script's lines read as new and refuse.
	 */
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
	/*
	 * A test spawning node on the program under test rather than running it
	 * through runInProcess, with no `spawn-kept: <why>` (§X3, #3458). One spawn
	 * per finding, at its call's first line and occurrence, never its line
	 * number.
	 */
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
	/*
	 * A hand split-and-parse of JSONL rather than lib/jsonl.js (#3452, #3453).
	 * `match` is the split line's text and its occurrence in the file, so a
	 * line added above an inherited site leaves it inherited and a second copy
	 * is new: every `index` gate below keys its sites the same way.
	 */
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
	/*
	 * A `gh` call off lib/gh.js and WFC_GH, or a `claude` call off
	 * lib/claude-bin.js and WFC_CLAUDE_BIN: a second var, a local spawn, a bare
	 * shell call or a test's PATH stub (§X2, §N7; #3455, #3559).
	 */
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
	/* An arbiter command spelt by hand rather than through buildArbiterCommand (#3990). */
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
	/* A program reading WFC_NOW itself rather than lib/clock.js's now() (#3457). */
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
	/* A report-* program filing past createIssue (#3454). Only a report-*
	 * holds the breach, so only staging one arms it. */
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
	/* A program ending in process.exit writing past writeFd (§N6, #4018). */
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
	/* A checker line in .husky/pre-commit or .husky/pre-commit.local exiting 1
	 * on its failure, which turns its BROKEN into a finding (§N4, #3456). Keyed
	 * on the line's text, never its number. */
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
	/*
	 * docs/agents/rules/<id>.txt is rendered from an anchor pair in the
	 * document that authors the rule, so an edit inside those anchors makes the
	 * fragment stale, and the guard delivers a rule the document no longer says
	 * (mantahostels#2493). Armed on the generator's own source list (#3118) and
	 * on the generated files; never on scripts/: the generator's own edits are
	 * caught when it is re-run.
	 */
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
	/*
	 * The effort guide's routing block is rendered from the routing file, so
	 * an edit to either, or to the generator, without a re-render leaves the
	 * guide disagreeing with what the code routes (#5033).
	 */
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
	/*
	 * The user-settings snapshot against ~/.claude/settings.json, checked here
	 * and not in CI: its source lives outside the repo, so a runner could only
	 * ever skip. Report-only, since drift in an unrelated file must not block
	 * an unrelated commit.
	 */
	{
		id: "user-settings-drift",
		script: "scripts/check-user-settings-drift.js",
		lander: "batch",
		args: ["--warn"],
		arm: { always: true },
		policy: "warn",
		kind: "checker",
	},
	/*
	 * The code standards' citations, §N7 exports and pythonRoutes (#1863),
	 * scoped to what this commit touches (mantahostels#2631). Report-only by
	 * ruling (mantahostels#1091). Always armed: a citation can point at almost
	 * any tracked file, and the run is cheap. --touching HEAD reads the
	 * worktree, not the index, so an unstaged edit can surface here — accepted
	 * (check-code-standards.js:27-43).
	 */
	{
		id: "code-standards",
		script: "scripts/check-code-standards.js",
		lander: "batch",
		args: ["--touching", "HEAD", "--warn"],
		arm: { always: true },
		policy: "warn",
		kind: "checker",
	},
	/*
	 * A primitives row naming a path or § id that does not resolve, or a local
	 * row taking a base row's job (#3451). Every commit, since a renamed
	 * exemplar can sit anywhere; --paths-only keeps it to stat calls. It reads the worktree, so an unstaged
	 * rename the commit does not carry can surface here; a base row's fault
	 * only warns in an adopter.
	 */
	{
		id: "primitives",
		script: "scripts/check-primitives.js",
		lander: "batch",
		args: ["--paths-only"],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * An own skill body this commit grows past its cap, reported only
	 * (mantahostels#3136); and a skill or command body holding an unescaped
	 * $<digit>, which the harness rewrites to an argument — that limb FAILs,
	 * so the row gates (#1490). --touching HEAD reads the worktree, so an
	 * unstaged edit can surface here — accepted, the fix being one escape.
	 */
	{
		id: "skill-body-size",
		script: "scripts/check-skill-body-size.js",
		lander: "batch",
		args: ["--touching", "HEAD"],
		arm: { always: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * A workflow job reaching past the timer-triggered autonomy ceiling, R1
	 * (docs/agents/autonomy-ceiling.md). Added or modified files only, `live`:
	 * a commit deleting the last workflow would otherwise refuse on
	 * NOTHING-INSPECTED. It reads the working tree, so an unstaged workflow
	 * edit the commit does not carry can surface here (#1380).
	 */
	{
		id: "workflow-permissions",
		script: "scripts/check-workflow-permissions.js",
		lander: "none",
		args: [],
		arm: { pattern: /^\.github\/workflows\/[^/]+\.ya?ml$/, live: true },
		policy: "gate",
		kind: "checker",
	},
	/*
	 * The doc map's own coverage, checked at commit as well as in
	 * roadmap-digest.yml (mantahostels#390); lib/doc-map-gate.js's header holds
	 * its rules. The pattern spells SCOPE in lib/doc-map.js, and
	 * lib/doc-map-gate-program.test.ts asserts the parity.
	 */
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
	/*
	 * The always-loaded context budget (#1014): a commit that adds bytes and
	 * leaves a surface at or over its cap is refused; an over-cap total it did
	 * not increase stays a WARN. --against HEAD reads both totals out of git, so
	 * a half-saved CLAUDE.md the commit does not carry is not charged.
	 *
	 * The pattern is deliberately wider than the caps, so a capped file moved
	 * elsewhere stays covered; `scripts/` is whole, since the event cap is the
	 * rule text the wired guards deliver (mantahostels#2004). The computed list
	 * is the pool the host config declares under `alwaysLoaded` (#33), which an
	 * adopter may place outside the pattern.
	 *
	 * Silent on a pass: its byte line on nearly every commit would teach the
	 * reader to skip it.
	 */
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
];

/**
 * @param {PrecommitGate} g
 * @returns {g is ProfileGate}
 */
const isProfileGate = (g) => "notice" in g;

/** The rows whose checker has a fault profile, in order. */
const PROFILE_GATES = GATES.filter(isProfileGate);

/**
 * A path from the core root, absolute, in the core the running code sits in:
 * not script-path.js's corePath, which spells one for a command line.
 * @param {string} rel
 * @returns {string}
 */
const fromCoreRoot = (rel) => path.join(coreRoot(), rel);

module.exports = { GATES, fromCoreRoot, PROFILE_GATES, SITE_IDENTITY };
