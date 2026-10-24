/*
 * secret-ask.js — the founder asked to supply a credential, read the one way
 * (#1031, #1817). guard-priced-options.js refuses such an ask unless it routes
 * the value through `write-secret.js`; scripts/measure-secret-ask.js runs the
 * same cue over the session corpus.
 */

const {
	CONFIDENCE_ANY,
	splitQuestions,
	optionSpans,
	optionBody,
} = require("./round-marker.js");
const { SHELL_VAR_NAME } = require("./shell-var-name.js");

/* Inline code spans and fenced blocks alike: where a pasteable text sits. */
const CODE_SPAN = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g;

/* How far, in characters, a cue reaches from its verb or noun to the word that
 * completes it without crossing a clause: chosen, not measured, to span "the
 * command from my". The guard's `BACK_REFERENCE` reaches as far. */
const CLAUSE_REACH = 40;

/* A supply verb reaching, within one clause, a credential noun. Not after
 * "I"/"we", a modal between or not — the agent handling a token is no ask; not
 * after a determiner ("the share of", "the type warnings"), the word being a
 * noun there; not run on by a hyphen (`send-keys`); "give" and "hand" only to
 * "me"/"us"/"over", since "give the token write access" grants rather than
 * supplies; and not an LLM's or a design system's tokens. */
const SECRET_NOUN =
	"(?:(?:api|access)[ -]?keys?|keys?|tokens?|credentials?|passwords?|passphrases?|secrets?|PATs?)";
/* "a model cannot supply the key" states a limit, not an ask. */
const NEGATED = String.raw`\b(?:cannot|can't|won't|couldn't|wouldn't)\s+`;
const AGENT = String.raw`\b(?:I|I'll|I'd|we|we'll)\s+(?:(?:can't|cannot|can|won't|will|would|could|don't|do not|also|just|then)\s+)?`;
const DETERMINER = String.raw`\b(?:the|a|an|what|which|this|that|each|any|its|their)\s+`;
const SECRET_ASK = new RegExp(
	String.raw`(?<!${AGENT})(?<!${NEGATED})(?<!${DETERMINER})\b(?:paste|enter|type(?!\s+(?:of|warnings?)\b)|supply|provide|send|share(?!\s+of\b)|(?:give|hand)\s+(?:me|us|over))\b(?!-)(?:(?!\b(?:and|then|so)\b)[^.,;\n]){0,${CLAUSE_REACH}}?(?<!\b(?:output|input|cache|context|design|\d+k?)\s+)\b${SECRET_NOUN}\b`,
	"i",
);
/* What expands inside double quotes — `$`, backtick, `\` — spelt for a regex
 * character class. */
const EXPANDS = "$`\\\\";
const BARE_CHAR = String.raw`[^\s;&|<>()'"#${EXPANDS}]`;
/* One shell word that substitutes no command or variable: bare, quoted, or
 * joined segments of both, so a path script-path.js's `shellWord` quotes as
 * `'o'\''b'` reads as one word. Globs, braces and `~` stay readable: none
 * puts a value on the line. */
const SHELL_WORD = String.raw`(?:${BARE_CHAR}+|'[^'\n]*'|"[^"\n${EXPANDS}]*"|\\')+`;
/* The route the hand-over prescribes, as the whole of a code span the founder
 * would paste: an optional `cd <dir> &&`, then `node`, a path — never a
 * flag — whose last segment is the script, and the variable it writes. Anything else beside it — a pipe or
 * redirect feeding it, an assignment, a further argument or command, a `node`
 * flag, a trailing comment — can put the value on a command line or in a
 * file, so the span is no route; a bare filename or a mention in prose is
 * none either (#2612). */
const ROUTE_COMMAND = new RegExp(
	String.raw`^(?:cd\s+${SHELL_WORD}\s*&&\s*)?node\s+(?!-)${SHELL_WORD}(?<=(?:^|[\s/]|\s['"])write-secret\.js['"]?)\s+(?:${SHELL_VAR_NAME}|'${SHELL_VAR_NAME}'|"${SHELL_VAR_NAME}")$`,
);
/* A span shaped as the route's command, runnable or not: `write-secret.js`
 * with any other word, `node` or not, the script running by its shebang. */
const ROUTE_SHAPED = /^(?=.*\bwrite-secret\.js\b)\S+\s+\S/;
/* ROUTE_COMMAND as a refusal spells it. */
const ROUTE_SHAPE = "cd <dir> && node <path>/write-secret.js NAME";
/* A `!` just before a span, as a `` `!` `` span or a bare, quoted or
 * bracketed `!`, with only whitespace, `:`, `,`, a dash, `+`, emphasis,
 * "then", "and" or "followed by" between (#2612). Other words between ("type
 * `!`, then in a normal terminal run …") break it, as does a negation
 * governing the `!` ("never after `!`:", "without a `!`:", "no need for
 * `!`:"). Prose naming `!` some other way ("with `!` in front", "an
 * exclamation mark", "type `!`. Then: …") is not read, nor a negation that
 * only looks like one ("why not type `!`:"): the line still fails closed
 * there, write-secret.js refusing a stdin that is no terminal. */
const BANG_AHEAD =
	/(?<!\b(?:not|never|no|without|don't|do\s+not)(?:\s+(?:need\s+for|a|an|the))?(?:\s+(?:after|with|behind|via|use|type))?\s*)(?:`\s*!\s*`|(?:^|\s)[*_"'(]*![*_"')]*)(?:[\s:,—–+*_-]|\b(?:then|and|followed\s+by)\b)*$/i;

/**
 * A code span's command lines: its delimiters, blank lines and comment lines
 * dropped first, then a line carried on by a trailing `&&` or `\` joined to
 * the next.
 * @param {string} code
 */
function commandLines(code) {
	const body = /^(?:```|~~~)/.test(code)
		? code.replace(/^[^\n]*\n?/, "").replace(/\n?[^\n]*$/, "")
		: code.slice(1, -1);
	/** @type {string[]} */
	const lines = [];
	for (const line of body.split("\n").map((l) => l.trim())) {
		if (line === "" || line.startsWith("#")) continue;
		const prev = lines.at(-1);
		if (prev !== undefined && /(?:&&|\\)$/.test(prev))
			lines[lines.length - 1] = `${prev.replace(/\\$/, "")} ${line}`;
		else lines.push(line);
	}
	return lines;
}

/**
 * The kinds of a code span shaped as the route: runnable; pasted after `!` —
 * an inline span opening with it, any fenced line opening with it, or a `!`
 * just before the span — where every line of a paste runs in that one shell,
 * whose stdin is no terminal, so write-secret.js can show no hidden prompt
 * (#2554); or broken, anything else beside the route. A `!` span is broken
 * too where its command is, so a piped line after `!` still cancels.
 * @param {string} code
 * @param {string} before the text ahead of the span
 * @returns {("runnable" | "bang" | "broken")[]}
 */
function routeKinds(code, before) {
	const lines = commandLines(code);
	const command = lines.map((l) => l.replace(/^!\s*/, "")).join(" && ");
	if (!ROUTE_SHAPED.test(command)) return [];
	const runs = ROUTE_COMMAND.test(command);
	if (lines.some((l) => l.startsWith("!")) || BANG_AHEAD.test(before))
		return runs ? ["bang"] : ["bang", "broken"];
	return runs ? ["runnable"] : ["broken"];
}

/**
 * The kind of each of `text`'s code spans shaped as the route.
 * @param {string} text
 */
const spanKinds = (text) =>
	[...text.matchAll(CODE_SPAN)].flatMap((m) =>
		routeKinds(m[0], text.slice(0, m.index)),
	);

/**
 * Whether `text` hands over a runnable route and no broken one beside it: "or
 * if it hangs, `echo $KEY | node …`" puts the value on a command line whatever
 * the first span says. A `!` line beside it is the warning #2554 keeps.
 * @param {string} text
 */
const hasSecretRoute = (text) => {
	const kinds = spanKinds(text);
	return kinds.includes("runnable") && !kinds.includes("broken");
};

/**
 * Whether `text` hands over the route after `!`, where it cannot work.
 * @param {string} text
 */
const hasBangSecretRoute = (text) => spanKinds(text).includes("bang");

/**
 * `text` without its Confidence lines: "about 10k tokens" there is the
 * estimate, not an ask.
 * @param {string} text
 */
const withoutConfidence = (text) =>
	text
		.split("\n")
		.filter((l) => !CONFIDENCE_ANY.test(l))
		.join("\n");

/**
 * The phrase asking for a credential in `text`, or undefined. Whether the
 * text routes the value is the caller's question.
 * @param {string} text
 * @returns {string | undefined}
 */
const askPhrase = (text) => text.replace(/’/g, "'").match(SECRET_ASK)?.[0];

/* A ``` or ~~~ fenced block, or a `>` quote line: text the message shows
 * rather than says — a prompt for another session, a quoted log. */
const SHOWN = /^\s{0,3}(```|~~~)[^\n]*\n[\s\S]*?^\s{0,3}\1[^\n]*$|^\s*>.*$/gm;

/**
 * The phrase in which a message's prose — every line outside its round
 * options, which the option reading judges, its fenced blocks and `>` quotes,
 * with each inline code span read as a clause break — has the founder supply
 * a credential, where the message hands over no runnable `write-secret.js`
 * route (`hasSecretRoute`); or undefined.
 * @param {string} message the outgoing assistant message
 * @returns {string | undefined}
 */
function proseAsk(message) {
	if (hasSecretRoute(message)) return;
	let prose = message;
	for (const block of splitQuestions(message))
		for (const option of optionSpans(block.lines))
			prose = prose.replace(optionBody(option.span), "");
	return askPhrase(
		withoutConfidence(prose).replace(SHOWN, "").replace(CODE_SPAN, ","),
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
