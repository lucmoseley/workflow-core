const { expandTildeWord } = require("./home-path.js");
const { literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} Body
 * @property {string} text
 * @property {boolean} given
 * @property {string | null | undefined} flag
 * @property {boolean} fromFile
 * @property {boolean} hidden
 * @property {string} missing
 * @property {string} fault
 */

/**
 * @typedef {object} BodyEnv
 * @property {string[]} spans
 * @property {string} subject
 * @property {string} subcmd
 * @property {string} what
 * @property {string} cwd
 * @property {string} home
 * @property {(path: string) => string | undefined} readFile
 */

const SPACE = "[ \\t\\n\\v\\f\\r]";

/** @returns {Body} */
const newBody = () => ({
	text: "",
	given: false,
	flag: undefined,
	fromFile: false,
	hidden: false,
	missing: "",
	fault: "",
});

/** @param {Body} body */
function forget(body) {
	body.text = "";
	body.hidden = false;
	body.missing = "";
	body.fault = "";
}

/** @param {Body} body */
function takeFlag(body) {
	forget(body);
	if (body.flag === null) body.hidden = true;
	else body.text = body.flag ?? "";
}

/**
 * @param {string} word
 * @param {string[]} spans
 */
function captured(word, spans) {
	const { text, known } = literal(word, spans);
	return known ? trimEndRun(text, "\n") : null;
}

/**
 * @param {Body} body
 * @param {string} word
 * @param {string[]} spans
 */
function bodyWord(body, word, spans) {
	body.given = true;
	body.flag = captured(word, spans);
	if (!body.fromFile) takeFlag(body);
}

/**
 * @param {Body} body
 * @param {string} word
 * @param {BodyEnv} env
 */
function bodyFileWord(body, word, env) {
	const at = captured(word, env.spans);
	body.fromFile = at !== "";
	if (at === "") {
		body.given = body.flag !== undefined;
		takeFlag(body);
		return;
	}
	body.given = true;
	forget(body);
	if (at === null) {
		body.hidden = true;
		return;
	}
	if (at === "-") {
		stdinHeredoc(body, env);
		if (body.hidden) stdinCat(body, env);
		return;
	}
	const tilde = word.startsWith("~");
	const call = new RegExp(`gh${SPACE}+${env.subcmd}`).exec(env.subject);
	const before = call
		? env.subject.slice(0, env.subject.indexOf(call[0]))
		: env.subject;
	diskBody(body, { at, before, tilde }, env);
}

/**
 * @param {Body} body
 * @param {{ at: string, before: string, tilde: boolean }} read
 * @param {BodyEnv} env
 */
function diskBody(body, { at, before, tilde }, env) {
	body.hidden = true;
	if (before.includes(at.slice(at.lastIndexOf("/") + 1))) return;
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
	body.text = trimEndRun(text, "\n");
}

/**
 * @param {string} at
 * @param {boolean} tilde
 * @param {BodyEnv} env
 * @returns {string | null}
 */
function resolvePath(at, tilde, env) {
	if (tilde && at.startsWith("~")) return expandTildeWord(at, env.home);
	if (at.startsWith("/")) return at;
	return env.cwd ? `${env.cwd}/${at}` : null;
}

const linesOf = (/** @type {string} */ subject) =>
	subject.replace(/\n$/, "").split("\n");

/**
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
 * @param {Body} body
 * @param {BodyEnv} env
 */
function stdinHeredoc(body, env) {
	body.hidden = true;
	const text = heredocText(env);
	if (text === null) return;
	body.hidden = false;
	body.text = text;
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
