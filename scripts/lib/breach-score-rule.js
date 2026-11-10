/*
 * breach-score-rule.js — the before/after test's pre-registered scoring
 * classes (workflow-core#2042, `docs/research/startup-load-before-after-test.md` D3), read
 * by `score-session-breaches.js`. Committed before any run: a change here
 * after the first run voids the comparison, as the report re-scores each
 * transcript, save for two changes that leave every score as it was. One
 * renames a guard and keeps a row for the name its transcripts carry. The
 * other adds the row this scorer's test demands for a Stop guard neither arm's
 * revision registers (workflow-core#3745; workflow-core#2046 ran 9599acf98 and d487f10bf): the guard
 * fired in neither arm, and `countStop` scores only a fire it finds. It can
 * fire in a later run, but a run from a newer base S (D2) is a new comparison.
 * A guard only arm B registers can fire in that arm, so this does not cover it:
 * D3 classes it a breach in advance if it refuses a wrong act.
 *
 * Every table names a guard as the scorer attributes it: a core the dispatcher
 * runs by its `lib/guard-cores.json` row `name` (workflow-core#2943), any other guard by
 * its script's file name less its `.js` or `.sh` (workflow-core#3440).
 */

/**
 * `breach` refuses a
 * wrong act and is scored; `notice` is a length notice, failed-open machinery,
 * the classifier, or a screen-only flag, and is not; `concision` is a demanded
 * step, reported as its own family.
 * @type {Readonly<Record<string, "breach" | "notice" | "concision">>}
 */
const STOP_CLASS = {
	"guard-inventory": "breach",
	"guard-priced-options": "breach",
	"guard-unpushed-commits": "breach",
	"guard-typecheck-owed": "breach",
	"guard-selection-sum": "breach",
	"guard-uncommitted-work": "breach",
	"guard-exhausted-map": "breach",
	"guard-held-ticket": "breach",
	"guard-paste-self-match": "breach",
	"guard-session-id-prose": "breach",
	"guard-session-ceiling": "notice",
	"guard-lost-deny": "notice",
	"guard-automode-refusal": "notice",
	"guard-jev-advisory": "notice",
	"park-on-round": "notice",
	"refill-wake": "notice",
	"concision-backstop": "concision",
};

/** Denies the machine caused, not the session (workflow-core#2042). */
const ENVIRONMENT_DENY = new Set(["guard-suite-concurrency"]);

/** The two near-constant families (D3), each reported on its own. */
const INVENTORY = "guard-inventory";
const JOB_DIR = "guard-job-dir-scratch";

/**
 * D3's by-family split (workflow-core#2046):
 * each guard whose rule text the cut moved out of the always-loaded load —
 * read off the arm A → arm B diff of `CLAUDE.md` and the user-level
 * `CLAUDE.md` — so arm B meets that rule first at the guard. The `guard-npm-install` core
 * is here whole for the bare-`npx` limb (call binaries by path), which named
 * no guard: its `--ignore-scripts` and new-package limbs follow `AGENTS.md`,
 * which neither arm loads, so they are counted as moved too, a small
 * over-count. A moved guard no refusal is ever attributed to is left out, as
 * it scores nothing (workflow-core#2946). Every other scored guard is `kept`.
 */
const MOVED = new Set([
	"guard-agent-poll",
	"guard-branch",
	"guard-branch-publish",
	"guard-commit-form",
	"guard-dispatch-rewrite",
	"guard-issue-body",
	"guard-issue-close",
	"guard-issue-create-label",
	"guard-npm-install",
	"guard-pull-form",
	"guard-suite-background",
	"guard-sweep-fire",
	"guard-uncommitted-work",
	"guard-unpushed-commits",
	"guard-wait-loop",
]);

/**
 * Guards printing one rule the cut moved and one it kept: the priced-options
 * guard's status-marker limb left with the background-wait rule, while its
 * question-round shape stays in the voice.
 */
const MIXED = new Set(["guard-priced-options"]);

/**
 * A registration key's guard, as every table here names one that is no
 * dispatcher core.
 * @param {string} key
 */
const guardNameOf = (key) => key.replace(/ .*/s, "").replace(/\.(js|sh)$/, "");

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
	guardNameOf,
};
