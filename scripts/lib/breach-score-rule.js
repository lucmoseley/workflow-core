/*
 * breach-score-rule.js — the before/after test's pre-registered scoring
 * classes (#2042, `docs/research/startup-load-before-after-test.md` D3), read
 * by `score-session-breaches.js`. Committed before any run: a change here
 * after the first run voids the comparison.
 */

/**
 * `breach` refuses a
 * wrong act and is scored; `notice` is a length notice, failed-open machinery,
 * the classifier, or a screen-only flag, and is not; `concision` is a demanded
 * step, reported as its own family.
 * @type {Readonly<Record<string, "breach" | "notice" | "concision">>}
 */
const STOP_CLASS = {
	"guard-inventory.js": "breach",
	"guard-priced-options.js": "breach",
	"guard-unpushed-commits.js": "breach",
	"guard-selection-sum.js": "breach",
	"guard-uncommitted-work.js": "breach",
	"guard-paste-self-match.js": "breach",
	"guard-session-ceiling.js": "notice",
	"guard-lost-deny.js": "notice",
	"guard-automode-refusal.js": "notice",
	"guard-jev-advisory.js": "notice",
	"park-on-round.js": "notice",
	"refill-wake.sh": "notice",
	"concision-backstop.sh": "concision",
};

/** Denies the machine caused, not the session (#2042). */
const ENVIRONMENT_DENY = new Set(["guard-suite-concurrency"]);

/**
 * A guard the dispatcher runs is named by its `lib/guard-cores.json` row
 * `name`, as the scorer attributes its deny (#2943).
 */

/** The two near-constant families (D3), each reported on its own. */
const INVENTORY = "guard-inventory.js";
const JOB_DIR = "guard-job-dir-scratch";

/**
 * D3's by-family split (#2046):
 * each guard whose rule text the cut moved out of the always-loaded load —
 * read off the arm A → arm B diff of `CLAUDE.md` and the user-level
 * `CLAUDE.md` — so arm B meets that rule first at the guard. The `guard-npm-install` core
 * is here whole for the bare-`npx` limb (call binaries by path), which named
 * no guard: its `--ignore-scripts` and new-package limbs follow `AGENTS.md`,
 * which neither arm loads, so they are counted as moved too, a small
 * over-count. A moved guard no refusal is ever attributed to is left out, as
 * it scores nothing (#2946). Every other scored guard is `kept`.
 */
const MOVED = new Set([
	"guard-agent-poll",
	"guard-branch",
	"guard-branch-publish",
	"guard-commit-form",
	"guard-dispatch-rewrite",
	"guard-file-claim",
	"guard-issue-body",
	"guard-issue-close",
	"guard-issue-create-label",
	"guard-npm-install",
	"guard-pull-form",
	"guard-suite-background",
	"guard-sweep-fire",
	"guard-uncommitted-work.js",
	"guard-unpushed-commits.js",
	"guard-wait-loop",
]);

/**
 * Guards printing one rule the cut moved and one it kept: the priced-options
 * guard's status-marker limb left with the background-wait rule, while its
 * question-round shape stays in the voice.
 */
const MIXED = new Set(["guard-priced-options.js"]);

/** How the scorer keys a deny by its guards. */
const DENY_GUARD_JOIN = "+";
const UNATTRIBUTED = "(unattributed)";

module.exports = {
	DENY_GUARD_JOIN,
	UNATTRIBUTED,
	STOP_CLASS,
	ENVIRONMENT_DENY,
	INVENTORY,
	JOB_DIR,
	MOVED,
	MIXED,
};
