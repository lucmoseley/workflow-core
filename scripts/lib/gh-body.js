/*
 * gh-body.js — the text a `gh` call's --body or --body-file word hands gh,
 * read off the command and, for a file, through a reader port (#2796).
 *
 * A CORE: the file read is the caller's `readFile` port.
 */

const { literal } = require("./shell-words.js");

/**
 * @typedef {object} Body what the body words of one call read, appended to
 *   across words
 * @property {string} text
 * @property {boolean} given any body word was seen
 * @property {boolean} hidden the text cannot be recovered
 * @property {string} missing a --body-file path absent at hook time
 * @property {string} fault why a body file could not be read
 */

/**
 * @typedef {object} BodyEnv
 * @property {string[]} spans the parse's quoted spans
 * @property {string} subject the whole command, as typed
 * @property {string} subcmd the subcommand after `gh`, as a regex source,
 *   e.g. `issue[ \t\n\v\f\r]+create`
 * @property {string} what the call as a fault message names it, e.g.
 *   `gh issue create`
 * @property {string} cwd the directory the call runs in; "" where unknown
 * @property {string} home what a leading `~` expands to
 * @property {(path: string) => string | undefined} readFile the file's text,
 *   undefined where it is absent; throws where it cannot be read
 */

const SPACE = "[ \\t\\n\\v\\f\\r]";

/** @returns {Body} */
const newBody = () => ({
	text: "",
	given: false,
	hidden: false,
	missing: "",
	fault: "",
});

/**
 * A word read back as the shell hands it over, a command substitution's
 * trailing newlines off; null where any of it cannot be recovered.
 * @param {string} word
 * @param {string[]} spans
 */
function captured(word, spans) {
	const { text, known } = literal(word, spans);
	return known ? text.replace(/\n+$/, "") : null;
}

/**
 * One --body word. Appends its text; marks the body hidden where the text
 * cannot be recovered, which is a fail-open rather than a verdict.
 * @param {Body} body accumulator: the word's text, or hidden
 * @param {string} word
 * @param {string[]} spans
 */
function bodyWord(body, word, spans) {
	body.given = true;
	const text = captured(word, spans);
	if (text === null) body.hidden = true;
	else body.text += text;
}

/**
 * One --body-file word. The path is read off the command and the FILE through
 * `env.readFile`.
 * @param {Body} body accumulator: the file's text, or missing or hidden
 * @param {string} word
 * @param {BodyEnv} env
 */
function bodyFileWord(body, word, env) {
	body.given = true;
	const at = captured(word, env.spans);
	if (at === null) {
		body.hidden = true;
		return;
	}
	if (at === "-") {
		stdinHeredoc(body, env);
		if (body.hidden) stdinCat(body, env);
		return;
	}
	/* A quoted span is masked on the raw word, so a leading `~` there is
	 * unquoted and the shell expands it. */
	const tilde = word.startsWith("~");
	const call = new RegExp(`gh${SPACE}+${env.subcmd}`).exec(env.subject);
	const before = call
		? env.subject.slice(0, env.subject.indexOf(call[0]))
		: env.subject;
	diskBody(body, { at, before, tilde }, env);
}

/**
 * A body file read off disk: `at` the path, `before` the command text before
 * the read, `tilde` whether a leading `~` expands. One absent at hook time sets `missing`: gh files a blank issue
 * from it at exit 0 (mantahostels#3443).
 *
 * UNLESS THE COMMAND WRITES IT FIRST — `cat > f <<'X'`, `tee f`, `> f`, a
 * script given the path. That is read as the file's NAME appearing in the text
 * before the read, deliberately loose: every miss fails open. On that
 * exemption the bytes on disk are not what gh will read, so the body is
 * hidden.
 * @param {Body} body
 * @param {{ at: string, before: string, tilde: boolean }} read
 * @param {BodyEnv} env
 */
function diskBody(body, { at, before, tilde }, env) {
	body.hidden = true;
	if (before.includes(at.slice(at.lastIndexOf("/") + 1))) return;
	/* A fault here is held, not failed open at once, so a caller may still
	 * judge the call on its unread body (#668); the caller logs it otherwise. */
	const file = resolvePath(at, tilde, env);
	if (file === null) {
		body.fault = `could not tell which directory a ${env.what} body file resolves in`;
		return;
	}
	let text;
	try {
		text = env.readFile(file);
	} catch {
		body.fault = `could not read the body file of a ${env.what}`;
		return;
	}
	if (text === undefined) {
		body.missing = at;
		return;
	}
	body.hidden = false;
	body.text += text.replace(/\n+$/, "");
}

/**
 * A body path, made absolute against the directory the call runs in. Null
 * where that directory is unknown.
 * @param {string} at
 * @param {boolean} tilde a leading `~` expands
 * @param {BodyEnv} env
 * @returns {string | null}
 */
function resolvePath(at, tilde, env) {
	if (tilde) {
		if (at === "~") return env.home;
		if (at.startsWith("~/")) return `${env.home}/${at.slice(2)}`;
		if (at.startsWith("~")) return null;
	}
	if (at.startsWith("/")) return at;
	return env.cwd ? `${env.cwd}/${at}` : null;
}

/** The subject's lines, as `mapfile -t` reads them. */
const linesOf = (/** @type {string} */ subject) =>
	subject.replace(/\n$/, "").split("\n");

/**
 * `cat <path> | gh <subcommand> … --body-file -` (mantahostels#3443). Read
 * only where the subject holds exactly one line running the subcommand, and
 * that line pipes a `cat` of one plain path straight into it; the path is then
 * judged as a --body-file path is.
 * @param {Body} body
 * @param {BodyEnv} env
 */
function stdinCat(body, env) {
	const call = `gh${SPACE}+${env.subcmd}`;
	const plain = `[^-${SPACE.slice(1, -1)}'"$\`\\\\|;&<>()][^${SPACE.slice(1, -1)}'"$\`\\\\|;&<>()]*`;
	const word = `('[^']+'|"[^"$\`\\\\]+"|${plain})`;
	const piped = new RegExp(
		`(^|[;&|(])${SPACE}*cat${SPACE}+(--${SPACE}+)?${word}${SPACE}*\\|${SPACE}*${call}`,
	);
	const callRe = new RegExp(call);
	let hit = "";
	let read = "";
	let calls = 0;
	for (const line of linesOf(env.subject)) {
		if (!callRe.test(line)) continue;
		calls++;
		const m = piped.exec(line);
		if (m) {
			hit = m[3] ?? "";
			read = m[0];
		}
	}
	if (calls !== 1 || !hit) return;
	const tilde = hit.startsWith("~");
	const at = hit.replace(/^['"]/, "").replace(/['"]$/, "");
	const before = env.subject.slice(0, env.subject.indexOf(read));
	diskBody(body, { at, before, tilde }, env);
}

/**
 * `--body-file -`: stdin, which a hook cannot see — except where stdin is a
 * heredoc, whose text sits on the command string itself. That is the form
 * docs/agents/triage-labels.md mandates for every create (mantahostels#3439).
 *
 * Read only where the association is certain: the subject holds exactly ONE
 * line running the subcommand, outside any heredoc body, and that line
 * carries exactly one `<<`, either `cat <<'X' | gh <subcommand> …` or
 * `gh <subcommand> … <<'X'`. Anything else — two such calls, `grep <<X |`, a
 * separator or `<` between the heredoc and gh, `<<-`, a `\`-continued call
 * line, mismatched delimiter quotes, an unterminated body — leaves the body
 * hidden. An unquoted delimiter expands its body, so a body holding `$`, a
 * backtick or a backslash is hidden there too.
 *
 * It rescans the raw subject: lib/shell-parse.js's heredoc pass discards each
 * body. The one way the two disagree — a quoted `<<` on an earlier line,
 * which this reads as an opener — swallows the call and fails open.
 * @param {Body} body
 * @param {BodyEnv} env
 */
function stdinHeredoc(body, env) {
	body.hidden = true;
	const text = heredocText(env);
	if (text === null) return;
	body.hidden = false;
	body.text += text;
}

/**
 * @param {BodyEnv} env
 * @returns {string | null}
 */
function heredocText(env) {
	const delim = `${SPACE}*(['"]?)([A-Za-z_][A-Za-z0-9_]*)['"]?`;
	const call = `gh${SPACE}+${env.subcmd}`;
	const re = {
		call: new RegExp(call),
		piped: new RegExp(
			`(^|[;&|(])${SPACE}*cat${SPACE}+<<${delim}[^<|;&]*\\|${SPACE}*${call}`,
		),
		attached: new RegExp(`${call}[^<|;&]*<<${delim}`),
	};
	/* `(^|[^<])` keeps a `<<<` herestring from reading as an opener. */
	const opener = new RegExp(`(^|[^<])<<-?${delim}`);
	const lines = linesOf(env.subject);
	let calls = 0;
	/** @type {{ quoted: string, text: string, end: number } | null} */
	let fed = null;
	for (let i = 0; i < lines.length; i++) {
		if (!re.call.test(lines[i] ?? "")) {
			i = pastHeredoc(lines, i, opener);
			continue;
		}
		calls++;
		fed = callBody(lines, i, re);
		if (!fed) return null;
		i = fed.end;
	}
	if (calls !== 1 || !fed) return null;
	if (!fed.quoted && /[$`\\]/.test(fed.text)) return null;
	return fed.text;
}

/**
 * Where a line that is not the call leaves the scan: past the body of any
 * heredoc it opens.
 * @param {string[]} lines
 * @param {number} i
 * @param {RegExp} opener
 */
function pastHeredoc(lines, i, opener) {
	const o = opener.exec(lines[i] ?? "");
	if (!o) return i;
	const end = closing(lines, i, o[3] ?? "");
	return end < 0 ? lines.length : end;
}

/**
 * The body the call line at `i` is fed, and the index of its closing line.
 * Null where the line opens no trusted heredoc or the heredoc never closes.
 * @param {string[]} lines
 * @param {number} i
 * @param {{ piped: RegExp, attached: RegExp }} re
 * @returns {{ quoted: string, text: string, end: number } | null}
 */
function callBody(lines, i, re) {
	const opened = callHeredoc(lines[i] ?? "", re);
	if (!opened) return null;
	const end = closing(lines, i, opened.term);
	if (end < 0) return null;
	const text = lines.slice(i + 1, end).map((l) => `${l}\n`);
	return { quoted: opened.quoted, text: text.join(""), end };
}

/**
 * The heredoc a call line opens: its delimiter and the quote around it. Null
 * where the line is not one of the two trusted shapes.
 * @param {string} line
 * @param {{ piped: RegExp, attached: RegExp }} re
 * @returns {{ quoted: string, term: string } | null}
 */
function callHeredoc(line, re) {
	if (line.split("<<").length !== 2) return null;
	if (line.includes("<<-") || line.endsWith("\\")) return null;
	const p = re.piped.exec(line);
	const a = p ? null : re.attached.exec(line);
	if (!p && !a) return null;
	const quoted = (p ? p[2] : a?.[1]) ?? "";
	const term = (p ? p[3] : a?.[2]) ?? "";
	return line.includes(`${quoted}${term}${quoted}`) ? { quoted, term } : null;
}

/**
 * The index of the line closing a heredoc opened at `from`; -1 where none
 * does.
 * @param {string[]} lines
 * @param {number} from
 * @param {string} term
 */
function closing(lines, from, term) {
	for (let j = from + 1; j < lines.length; j++)
		if (lines[j] === term || lines[j] === `${term};`) return j;
	return -1;
}

module.exports = { SPACE, captured, newBody, bodyWord, bodyFileWord };
