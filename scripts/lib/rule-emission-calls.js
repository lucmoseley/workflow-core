/*
 * rule-emission-calls.js — how a guard's text spells a rule fetch: the
 * accessor calls and injectRules decisions that print a rule file, and the
 * ids each names. Rule pricing (lib/rule-emission.js), the registry
 * (check-guard-registry.js) and the dependency graph (lib/guard-reach.js)
 * read emissions through this one table, so they cannot disagree about
 * which guard prints which fragment. Split out of rule-emission.js so the
 * graph and rule pricing need no import cycle (workflow-core#4233).
 */

const RULE_ID = "(?:rule:)?[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * The name each emission below opens on, by the regex that reads it. A
 * comment can split an emission so it only matches once the comment is
 * stripped (workflow-core#3481), but never takes its name away, so namesAnEmission gates
 * on these alone.
 */
const EMISSION_NAMES = {
	inject: ["injectRules"],
	shell: ["rule_text", "rule_or_path"],
	nodeIdFirst: [
		"readRuleText",
		"readRuleTextOr",
		"readRuleParagraph",
		"ruleText",
	],
	nodeIdSecond: ["ruleOrFallback"],
};
/**
 * The pre-emptive emission, a Node guard core's `{ injectRules: [<id>…] }`
 * decision, which lib/guard-entry.js latches and caps (workflow-core#2784). Shared with
 * scripts/check-guard-registry.js so the two readings cannot drift. The ids
 * must be quoted literals in the array: one held in a constant is invisible.
 */
const INJECT_RULES_RE = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is the host repo's own files, which its own writers control; a crafted one slows the check, nothing worse (workflow-core#4642)
	`\\b${EMISSION_NAMES.inject.join("|")}:\\s*\\[((?:\\s*["']${RULE_ID}["']\\s*,?)+)\\s*\\]`,
	"g",
);

/**
 * An injectRules key, never a `.injectRules` read; a shorthand key included.
 * Residual: a destructure (`{ injectRules } = d`) and a mention inside a
 * string literal match too, and so read as unread — the safe direction.
 */
const INJECT_RULES_KEY_RE = /(?<![\w$.])injectRules(?=\s*[:,}])/g;
/* INJECT_RULES_RE admits no empty array, which emits nothing and is no
 * unread injection either. */
const LITERAL_INJECTION_RE = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is the host repo's own files, which its own writers control; a crafted one slows the check, nothing worse (workflow-core#4642)
	`(?:${INJECT_RULES_RE.source}|injectRules:\\s*\\[\\s*\\])`,
	"y",
);

/**
 * Where `text` first hands injectRules something other than a literal id
 * array — a variable, a spread, a shorthand key — whose ids no scan can read
 * (workflow-core#3011), or undefined.
 * @param {string} text
 * @returns {number | undefined}
 */
function firstUnreadInjection(text) {
	return [...text.matchAll(INJECT_RULES_KEY_RE)]
		.map((m) => m.index ?? 0)
		.find((at) => {
			LITERAL_INJECTION_RE.lastIndex = at;
			return !LITERAL_INJECTION_RE.test(text);
		});
}

/**
 * Every pre-emptive emission in `text`; group 1 holds the ids.
 * @param {string} text
 */
const emissionMatches = (text) => [...text.matchAll(INJECT_RULES_RE)];

/**
 * The bare ids in one emission's id run.
 *
 * ONE optional `rule:` comes off, because the latch bares one (mantahostels#2719).
 */
const RULE_ARG_RE = /["']?(?:rule:)?([a-z0-9]+(?:-[a-z0-9]+)*)["']?/g;

/**
 * The DIRECT accessor call — a shell hook's `rule_text <id>`, or
 * `rule_or_path <id>`, lib/rule-text.sh's wrapper of it with a logged pointer
 * fallback (workflow-core#3439) — which splices the fragment into text the hook composes
 * itself.
 *
 * UNANCHORED: the call sits inside a condition rather than at the head of its
 * own statement. The cost is that a mention in a comment matches, which
 * over-reports the census.
 */
const DIRECT_RULE_RE = new RegExp(
	`\\b(?:${EMISSION_NAMES.shell.join("|")})\\s+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))`,
	"g",
);
/**
 * The Node accessors' direct call, the id a quoted literal first, split across
 * lines as Biome formats it: `readRuleText`, `readRuleTextOr`, and `ruleText`,
 * a core's injected port onto readRuleText (lib/guard-entry.js) (workflow-core#2905); and
 * lib/guard-verdict.js's `ruleOrFallback`, the id second after the core's
 * context (workflow-core#3146).
 */
const NODE_DIRECT_RULE_RE = new RegExp(
	`\\b(?:(?:${EMISSION_NAMES.nodeIdFirst.join("|")})\\(|(?:${EMISSION_NAMES.nodeIdSecond.join("|")})\\(\\s*[\\w.]+\\s*,)\\s*["']([a-z0-9-]+)["']\\s*[),]`,
	"g",
);

const EMISSION_NAME_RE = new RegExp(
	`\\b(?:${Object.values(EMISSION_NAMES).flat().join("|")})\\b`,
);

/**
 * Whether `text` names any emission's opening name, comments included: one
 * naming none emits no rule.
 * @param {string} text
 */
const namesAnEmission = (text) => EMISSION_NAME_RE.test(text);

/**
 * Every DIRECT accessor call in one source, shell and Node spellings alike, as
 * the id it fetches and where the call starts. Shared with
 * scripts/check-guard-registry.js.
 *
 * @param {string} text
 * @returns {{ id: string, index: number }[]}
 */
function directAccessorCalls(text) {
	/** @type {{ id: string, index: number }[]} */
	const calls = [];
	for (const re of [DIRECT_RULE_RE, NODE_DIRECT_RULE_RE])
		for (const m of text.matchAll(re)) {
			const id = m[1] ?? m[2] ?? m[3];
			if (id) calls.push({ id, index: m.index ?? 0 });
		}
	return calls;
}

/**
 * Every DIRECT accessor call in one guard's source, as id → how many CALL
 * SITES name it, in the order given.
 *
 * @param {string} text the guard's source
 * @returns {Map<string, number>}
 */
function directRuleCounts(text) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const { id } of directAccessorCalls(text))
		counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
}

module.exports = {
	directAccessorCalls,
	directRuleCounts,
	emissionMatches,
	firstUnreadInjection,
	namesAnEmission,
	RULE_ARG_RE,
	RULE_ID,
};
