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
	parseOptionBody,
} = require("./round-marker.js");
const { SHELL_VAR_NAME } = require("./shell-var-name.js");

/* A ``` or ~~~ fenced block as CommonMark reads one: opened at a line's start,
 * indented to any depth so a list item's fence reads, with no backtick in a
 * backtick fence's info string, and closed only by a line of the same
 * character at least as long, else running to the text's end (#2645).
 * `FENCE_CLOSED` leaves an unclosed fence unmatched, for a reader that drops
 * what it matches: a stray ``` must not hide the prose below it. */
const FENCE_OPEN = String.raw`(?<=^[ \t]*)(\`{3,}|~{3,})(?:(?<=\`)[^\`\n]*|(?<=~)[^\n]*)$`;
const FENCE_CLOSED = String.raw`${FENCE_OPEN}\n[\s\S]*?^[ \t]*\1(?:(?<=\`)\`*|(?<=~)~*)[ \t\r]*$`;
const FENCE = String.raw`${FENCE_OPEN}(?:\n[\s\S]*?^[ \t]*\1(?:(?<=\`)\`*|(?<=~)~*)[ \t\r]*$|[\s\S]*)`;

const INLINE_SPAN = /`[^`\n]+`/g;
/* Inline code spans and fenced blocks alike: where a pasteable text sits. */
const CODE_SPAN = new RegExp(`${FENCE}|${INLINE_SPAN.source}`, "gm");

/* How far, in characters, a cue reaches from its verb or noun to the word that
 * completes it without crossing a clause: chosen, not measured, to span "the
 * command from my". */
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
 * joined segments of both, so a path sh-quote.js's `shellQuote` quotes as
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
 * `!`:"). Prose naming `!` some other way ("with `!` in front", "type `!`.
 * Then: …") is not read, nor a negation that only looks like one ("why not
 * type `!`:"): the line still fails closed there, write-secret.js refusing a
 * stdin that is no terminal. */
const BANG_NEGATED = String.raw`\b(?:not|never|no|without|don't|do\s+not)(?:\s+(?:need\s+for|a|an|the))?(?:\s+(?:after|with|behind|via|use|type))?\s*`;
/* Each lookbehind is read at a `!` or a backtick, never at every character,
 * and the emphasis after the `!` stops at its last quote, so a long blank or
 * emphasis run is read once (#3383). */
const BANG_AHEAD = new RegExp(
	String.raw`(?:\x60(?<!${BANG_NEGATED}\x60)\s*!\s*\x60|!(?<=(?:^|\s)[*_"'(]*!)(?<!${BANG_NEGATED}\s[*_"'(]*!)(?:[*_]*["')])*)(?:[\s:,—–+*_-]|\b(?:then|and|followed\s+by)\b)*$`,
	"i",
);

/**
 * A code span's command lines: its delimiters, blank lines and comment lines
 * dropped first, then a line carried on by a trailing `&&` or `\` joined to
 * the next.
 * @param {string} code
 */
function parseCommandLines(code) {
	const body = /^(?:```|~~~)/.test(code)
		? code.split("\n").slice(1)
		: [code.slice(1, -1)];
	/* An unclosed fence runs to the text's end, its last line no fence. */
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
	const lines = parseCommandLines(code);
	const command = lines.map((l) => l.replace(/^!\s*/, "")).join(" && ");
	if (!ROUTE_SHAPED.test(command)) return [];
	const runs = ROUTE_COMMAND.test(command);
	if (lines.some((l) => l.startsWith("!")) || BANG_AHEAD.test(before))
		return runs ? ["bang"] : ["bang", "broken"];
	return runs ? ["runnable"] : ["broken"];
}

/* A variable named for a credential: its last `_`-separated part ending in
 * KEY, TOKEN, SECRET, PASS, PASSWORD, PAT, CRED(S), CREDENTIAL(S) or AUTH, so
 * APIKEY and GITHUB_PAT read and AUTHOR_NAME, SSH_AUTH_SOCK and PATTERN do
 * not. */
const SECRET_VAR = `(?=(?:[A-Za-z0-9]*_)*[A-Za-z0-9]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PAT|CREDS?|CREDENTIALS?|AUTH)(?![A-Za-z0-9_]))${SHELL_VAR_NAME}`;
/* One shell value: quoted, a `<placeholder>` however many words it holds, or
 * bare. */
const VALUE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|<[^<>\n]*>|[^\s<]\S*)`;
/* Lines that put a credential where write-secret.js exists to keep it from
 * (#2645): a credential variable exported, set or `setx`-ed, or assigned ahead
 * of a command; and a `.env` file read into a pipe, a redirect or a copy, or
 * written by one, a `.env.example` excepted. A warning not to
 * ("never `cat .env`") reads as one too. An option word ending in `cat`, `cp`,
 * `mv` or `tee` hands on to the command it names, and a redirect's file word
 * stops at a `>` no `-` or `=` precedes, a later `>` reading on from there, so
 * no word is read once per command or `>` in it (#3383). */
const LEAK_LINES = [
	new RegExp(
		String.raw`(?:^|[\s\x60;&|(!])(?:export\s+|set\s+|\$env:)${SECRET_VAR}\s*=|setx\s+${SECRET_VAR}\s|(?:^|[\x60;&|(!]\s*|&&\s*)${SECRET_VAR}=${VALUE}\s+\S`,
		"i",
	),
	/\b(?:cat|cp|mv|tee)\s+(?:-\S+(?<!\b(?:cat|cp|mv|tee))\s+)*\S*\.env(?!\.(?:example|sample|template|dist)\b)\b|(?:^|[\s/'"\x60])\.env(?:\.[\w-]+)?['"]?\s*(?:>{1,2}|\|(?!\|))|(?<![-=])>(?:>?\s+\S*|(?:[^\s.>]|\.(?!env\b)|(?<=[-=])>)*)\.env\b/,
];
/* A pipe or redirect feeding write-secret.js on a line outside any code span
 * — prose, or an indented block — where `routeKinds` never looks (#2645):
 * piped into it, or `node … write-secret.js` with a `<` or `|` anywhere
 * else on the line. A pipe's word stops at the next `|`, which reads on from
 * there, and the line is searched for the route twice, never once per `<`,
 * so a long run of either is read once (#3383). */
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
 * The kind of each of `text`'s code spans shaped as the route, and a
 * "broken" for each prose line feeding the route and each line, code or
 * prose, leaking a credential.
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

/**
 * Whether `text` hands over a runnable route and no broken one beside it: "or
 * if it hangs, `echo $KEY | node …`" puts the value on a command line whatever
 * the first span says. A `!` line beside it is the warning #2554 keeps.
 * @param {string} text
 */
const hasSecretRoute = (text) => {
	const kinds = messageKinds(text);
	return kinds.includes("runnable") && !kinds.includes("broken");
};

/**
 * Whether `text` hands over the route after `!`, where it cannot work.
 * @param {string} text
 */
const hasBangSecretRoute = (text) => messageKinds(text).includes("bang");

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

/* A fenced block or a `>` quote line: text the message shows rather than
 * says — a prompt for another session, a quoted log. */
const SHOWN = new RegExp(String.raw`${FENCE_CLOSED}|^\s*>.*$`, "gm");

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
