const {
	CONFIDENCE_ANY,
	splitQuestions,
	optionSpans,
	parseOptionBody,
} = require("./round-marker.js");
const { SHELL_VAR_NAME } = require("./shell-var-name.js");

const FENCE_OPEN = String.raw`^[ \t]*(\`{3,}|~{3,}(?!~))(?:(?<=\`)[^\`\n]*|(?<=~)[^\n]*)$`;
const FENCE_CLOSED = String.raw`${FENCE_OPEN}\n[\s\S]*?^[ \t]*\1(?:(?<=\`)\`*|(?<=~)~*)[ \t\r]*$`;
const FENCE = String.raw`${FENCE_OPEN}(?:\n[\s\S]*?^[ \t]*\1(?:(?<=\`)\`*|(?<=~)~*)[ \t\r]*$|[\s\S]*)`;

const INLINE_SPAN = /`[^`\n]+`/g;
const CODE_SPAN = new RegExp(`${FENCE}|${INLINE_SPAN.source}`, "gm");

// workflow-core#1817 guess, to span "the command from my"
const CLAUSE_REACH = 40;

const SECRET_NOUN =
	"(?:(?:api|access)[ -]?keys?|keys?|tokens?|credentials?|passwords?|passphrases?|secrets?|PATs?)";
const NEGATED = String.raw`\b(?:cannot|can't|won't|couldn't|wouldn't)\s+`;
const AGENT = String.raw`\b(?:I|I'll|I'd|we|we'll)\s+(?:(?:can't|cannot|can|won't|will|would|could|don't|do not|also|just|then)\s+)?`;
const DETERMINER = String.raw`\b(?:the|a|an|what|which|this|that|each|any|its|their)\s+`;
const SECRET_ASK = new RegExp(
	String.raw`(?=\b(?:paste|enter|type|supply|provide|send|share|give|hand)\b)(?<!${AGENT})(?<!${NEGATED})(?<!${DETERMINER})\b(?:paste|enter|type(?!\s+(?:of|warnings?)\b)|supply|provide|send|share(?!\s+of\b)|(?:give|hand)\s+(?:me|us|over))\b(?!-)(?:(?!\b(?:and|then|so)\b)[^.,;\n]){0,${CLAUSE_REACH}}?(?=\b${SECRET_NOUN}\b)(?<!\b(?:output|input|cache|context|design|\d+k?)\s+)\b${SECRET_NOUN}\b`,
	"i",
);
const EXPANDS = "$`\\\\";
const BARE_CHAR = String.raw`[^\s;&|<>()'"#${EXPANDS}]`;
const SHELL_WORD = String.raw`(?:${BARE_CHAR}+|'[^'\n]*'|"[^"\n${EXPANDS}]*"|\\')+`;
const ROUTE_COMMAND = new RegExp(
	String.raw`^(?:cd\s+${SHELL_WORD}\s*&&\s*)?node\s+(?!-)${SHELL_WORD}(?<=(?:^|[\s/]|\s['"])write-secret\.js['"]?)\s+(?:${SHELL_VAR_NAME}|'${SHELL_VAR_NAME}'|"${SHELL_VAR_NAME}")$`,
);
const ROUTE_SHAPED = /^(?=.*\bwrite-secret\.js\b)\S+\s+\S/;
const ROUTE_SHAPE = "cd <dir> && node <path>/write-secret.js NAME";
const BANG_NEGATED = String.raw`\b(?:not|never|no|without|don't|do\s+not)(?:\s+(?:need\s+for|a|an|the))?(?:\s+(?:after|with|behind|via|use|type))?\s*`;
const BANG_AHEAD = new RegExp(
	String.raw`(?:\x60(?<!${BANG_NEGATED}\x60)\s*!\s*\x60|!(?<=(?:^|\s)[*_"'(]*!)(?<!${BANG_NEGATED}\s[*_"'(]*!)(?:[*_]*["')])*)(?:[\s:,—–+*_-]|\b(?:then|and|followed\s+by)\b)*$`,
	"i",
);

/** @param {string} code */
function parseCommandLines(code) {
	const body = /^[ \t]*(?:```|~~~)/.test(code)
		? code.split("\n").slice(1)
		: [code.slice(1, -1)];
	if (/^\s*(?:`{3,}|~{3,})\s*$/.test(body.at(-1) ?? "")) body.pop();
	/** @type {string[]} */
	const lines = [];
	for (const line of body.map((l) => l.trim())) {
		if (line === "" || line.startsWith("#")) continue;
		const prev = lines.at(-1);
		if (prev !== undefined && /(?:&&|\\)$/.test(prev))
			lines[lines.length - 1] = `${prev.replace(/\\$/, "")} ${line}`;
		else lines.push(line);
	}
	return lines;
}

/**
 * @param {string} code
 * @param {string} before
 * @returns {("runnable" | "bang" | "broken")[]}
 */
function routeKinds(code, before) {
	const lines = parseCommandLines(code);
	const command = lines.map((l) => l.replace(/^!\s*/, "")).join(" && ");
	if (!ROUTE_SHAPED.test(command)) return [];
	const runs = ROUTE_COMMAND.test(command);
	if (lines.some((l) => l.startsWith("!")) || BANG_AHEAD.test(before))
		return runs ? ["bang"] : ["bang", "broken"];
	return runs ? ["runnable"] : ["broken"];
}

const SECRET_VAR = `(?=(?:[A-Za-z0-9]*_)*[A-Za-z0-9]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PAT|CREDS?|CREDENTIALS?|AUTH)(?![A-Za-z0-9_]))${SHELL_VAR_NAME}`;
const VALUE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|<[^<>\n]*>|[^\s<]\S*)`;
const LEAK_LINES = [
	new RegExp(
		String.raw`(?:^|[\s\x60;&|(!])(?:export\s+|set\s+|\$env:)${SECRET_VAR}\s*=|setx\s+${SECRET_VAR}\s|(?:^|[\x60;&|(!]\s*|&&\s*)${SECRET_VAR}=${VALUE}\s+\S`,
		"i",
	),
	/\b(?:cat|cp|mv|tee)\s+(?:-\S+(?<!\b(?:cat|cp|mv|tee))\s+)*\S*\.env(?!\.(?:example|sample|template|dist)\b)\b|(?:^|[\s/'"\x60])\.env(?:\.[\w-]+)?['"]?\s*(?:>{1,2}|\|(?!\|))|(?<![-=])>(?:>?\s+\S*|(?:[^\s.>]|\.(?!env\b)|(?<=[-=])>)*)\.env\b/,
];
const PIPED_ROUTE = /\|\s*(?:node\s+)?[^\s|]*write-secret\.js\b/;
const NODE_ROUTE = /\bnode\s+\S*?write-secret\.js\b/;

/**
 * @param {string} line
 * @returns {boolean}
 */
function feedsRoute(line) {
	if (PIPED_ROUTE.test(line)) return true;
	const first = NODE_ROUTE.exec(line);
	if (!first) return false;
	if (/[<|]/.test(line.slice(first.index + first[0].length))) return true;
	const redirect = line.indexOf("<");
	return redirect >= 0 && NODE_ROUTE.test(line.slice(redirect + 1));
}

/**
 * @param {string} text
 * @returns {("runnable" | "bang" | "broken")[]}
 */
const messageKinds = (text) => [
	...[...text.matchAll(CODE_SPAN)].flatMap((m) =>
		routeKinds(m[0], text.slice(0, m.index)),
	),
	...text
		.replace(CODE_SPAN, ",")
		.split("\n")
		.filter(feedsRoute)
		.map(() => /** @type {const} */ ("broken")),
	...text
		.split("\n")
		.filter((line) => LEAK_LINES.some((leak) => leak.test(line)))
		.map(() => /** @type {const} */ ("broken")),
];

/** @param {string} text */
const hasSecretRoute = (text) => {
	const kinds = messageKinds(text);
	return kinds.includes("runnable") && !kinds.includes("broken");
};

/** @param {string} text */
const hasBangSecretRoute = (text) => messageKinds(text).includes("bang");

/** @param {string} text */
const withoutConfidence = (text) =>
	text
		.split("\n")
		.filter((l) => !CONFIDENCE_ANY.test(l))
		.join("\n");

/**
 * @param {string} text
 * @returns {string | undefined}
 */
const askPhrase = (text) => text.replace(/’/g, "'").match(SECRET_ASK)?.[0];

const SHOWN = new RegExp(
	String.raw`${FENCE_CLOSED}|^[^\S\n\r\u2028\u2029]*>.*$`,
	"gm",
);

/**
 * @param {string} message
 * @returns {string | undefined}
 */
function proseAsk(message) {
	if (hasSecretRoute(message)) return;
	let prose = message;
	for (const block of splitQuestions(message))
		for (const option of optionSpans(block.lines))
			prose = prose.replace(parseOptionBody(option.span), "");
	return askPhrase(
		withoutConfidence(prose).replace(SHOWN, "").replace(INLINE_SPAN, ","),
	);
}

module.exports = {
	CODE_SPAN,
	CLAUSE_REACH,
	hasSecretRoute,
	hasBangSecretRoute,
	ROUTE_SHAPE,
	withoutConfidence,
	askPhrase,
	proseAsk,
};
