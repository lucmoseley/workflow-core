/** @type {Readonly<Record<string, "breach" | "notice" | "concision">>} */
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
	"practice-guard": "breach",
	"guard-session-ceiling": "notice",
	"guard-lost-deny": "notice",
	"guard-automode-refusal": "notice",
	"guard-jev-advisory": "notice",
	"park-on-round": "notice",
	"refill-wake": "notice",
	"concision-backstop": "concision",
};

const ENVIRONMENT_DENY = new Set(["guard-suite-concurrency"]);

const INVENTORY = "guard-inventory";
const JOB_DIR = "guard-job-dir-scratch";

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

const MIXED = new Set(["guard-priced-options"]);

/** @param {string} key */
const guardNameOf = (key) => key.replace(/ .*/s, "").replace(/\.(js|sh)$/, "");

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
