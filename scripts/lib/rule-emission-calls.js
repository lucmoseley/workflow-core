const RULE_ID = "(?:rule:)?[a-z0-9]+(?:-[a-z0-9]+)*";

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
const INJECT_RULES_RE = new RegExp(
	`\\b${EMISSION_NAMES.inject.join("|")}:\\s*\\[\\s*((?:["']${RULE_ID}["']\\s*(?:,\\s*)?)+)\\]`,
	"g",
);

const INJECT_RULES_KEY_RE = /(?<![\w$.])injectRules(?=\s*[:,}])/g;
const LITERAL_INJECTION_RE = new RegExp(
	`(?:${INJECT_RULES_RE.source}|injectRules:\\s*\\[\\s*\\])`,
	"y",
);

/** @param {string} text @returns {number | undefined} */
function firstUnreadInjection(text) {
	return [...text.matchAll(INJECT_RULES_KEY_RE)]
		.map((m) => m.index ?? 0)
		.find((at) => {
			LITERAL_INJECTION_RE.lastIndex = at;
			return !LITERAL_INJECTION_RE.test(text);
		});
}

/** @param {string} text */
const emissionMatches = (text) => [...text.matchAll(INJECT_RULES_RE)];

const RULE_ARG_RE = /["']?(?:rule:)?([a-z0-9]+(?:-[a-z0-9]+)*)["']?/g;

const DIRECT_RULE_RE = new RegExp(
	`\\b(?:${EMISSION_NAMES.shell.join("|")})\\s+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))`,
	"g",
);
const NODE_DIRECT_RULE_RE = new RegExp(
	`\\b(?:(?:${EMISSION_NAMES.nodeIdFirst.join("|")})\\(|(?:${EMISSION_NAMES.nodeIdSecond.join("|")})\\(\\s*[\\w.]+\\s*,)\\s*["']([a-z0-9-]+)["']\\s*[),]`,
	"g",
);

const EMISSION_NAME_RE = new RegExp(
	`\\b(?:${Object.values(EMISSION_NAMES).flat().join("|")})\\b`,
);

/** @param {string} text */
const namesAnEmission = (text) => EMISSION_NAME_RE.test(text);

/** @param {string} text @returns {{ id: string, index: number }[]} */
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

/** @param {string} text @returns {Map<string, number>} */
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
