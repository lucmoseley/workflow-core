/*
 * env-file.js — the secrets file, its line grammar, and the values and names
 * read from it.
 *
 * THE SECRETS FILE is `$XDG_CONFIG_HOME/workflow-core/secrets.env`, with
 * `~/.config` where XDG_CONFIG_HOME is unset, empty or relative (the XDG Base
 * Directory spec). `scripts/write-secret.js` writes it owner-only. It sits
 * outside every working tree, so a script that writes a relative `.env` from
 * whatever cwd it lands in cannot reach it (#3202). An absolute
 * WFC_SECRETS_FILE stands in for it, for tests only, resolved so the path
 * checked is the path written (#3715). Its directory holds a `.gitignore` of
 * `*`, keeping it out of a bare dotfiles repository's `add` (#3539), bar
 * under the override, whose directory may be a repository with its own.
 *
 * A LINE is `NAME=value` or `export NAME = value`, the value trimmed and one
 * quote stripped from each end. The file's leading BOM and each line's
 * trailing `\r` are no part of any line; the spaces between its parts are any
 * whitespace but a line break (#3542). This grammar is the writer's too:
 * `scripts/write-secret.js` replaces the value of exactly the lines this
 * reader reads, quoting it with quoteValue so unquoteValue reads it back.
 *
 * THE MASKER READS MORE THAN THAT (#3917): readStoredSecrets also takes a line
 * as dotenv's parser does, a dotted or hyphened name or `NAME: value`, and a
 * quoted value across breaks, commented out line by line or not; and a
 * commented-out `NAME=value`, bar PROSE_VALUE's, and no `# NAME: value`, as a comment's `Updated: 2026-11-02` or
 * `scope=repository` is prose it would mask everywhere (#4048). Nothing else reads or writes by
 * this reading.
 *
 * A RETURNED VALUE IS A SECRET: a caller puts it in no log line or message.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { logError } = require("./arbiter-core.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group");

/* `\s` less the line breaks `.` stops at, so a value holding one reads back
 * as no line. */
const SPACE = String.raw`[^\S\r\n\u2028\u2029]`;
const ENV_LINE = new RegExp(
	`^(${SPACE}*(?:export${SPACE}+)?([A-Za-z_][A-Za-z0-9_]*)${SPACE}*=${SPACE}*)(?!${SPACE})(.*)$`,
);

/** The breaks a line can hold mid-way once split on `\n`. */
const INNER_BREAK = /[\r\u2028\u2029]/;

const ANY_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

/* What dotenv's parser takes to end a line, and what it reads inside a value. */
const LINE_END = /\r\n|[\n\r]/;
const SEPARATOR = /[\u2028\u2029]/;

/* A line as dotenv's LINE reads one (github.com/motdotla/dotenv, lib/main.js),
 * an `=` behind any comment marks: the marks, the name, the value. */
const DOTENV_LINE =
	/^(?:\s*(?:export\s+)?[\w.-]+:\s+|([\s#]*)(?:export\s+)?([\w.-]+)\s*=\s*)([^\r\n]*)$/;

/* Prose in a comment (#4048): one unquoted lower-case word, assigned to a
 * lower-case name that names no secret. A passphrase holds a space or a hyphen, and a quote may
 * open a value whose later lines hold the secret. */
const PROSE_VALUE = /^[a-z]+$/;
const SECRET_NAME = /pass|pwd|secret|key|token|auth|cred/i;

const BOM = "\uFEFF";

/**
 * `text` as its leading BOM and its lines, each split from its trailing `\r`,
 * so `bom + lines.map((l) => l.body + l.cr).join("\n")` is `text` again.
 * @param {string} text
 * @returns {{ bom: string, lines: { body: string, cr: string }[] }}
 */
function splitEnvLines(text) {
	const bom = text.startsWith(BOM) ? BOM : "";
	const lines = text
		.slice(bom.length)
		.split("\n")
		.map((line) =>
			line.endsWith("\r")
				? { body: line.slice(0, -1), cr: "\r" }
				: { body: line, cr: "" },
		);
	return { bom, lines };
}

/**
 * The assignment a line body makes: everything before its value, the name,
 * and the value as written; or null where it makes none.
 * @param {string} body a line from `splitEnvLines`
 * @returns {{ prefix: string, name: string, raw: string } | null}
 */
function parseEnvLine(body) {
	const m = body.match(ENV_LINE);
	if (!m) return null;
	return {
		prefix: requiredGroup(m, 1, ENV_LINE),
		name: requiredGroup(m, 2, ENV_LINE),
		raw: requiredGroup(m, 3, ENV_LINE),
	};
}

/**
 * The assignment each part of `body` makes, split at every break inside it;
 * null for a part that makes none.
 * @param {string} body a line from `splitEnvLines`
 */
function parseAcrossBreaks(body) {
	return body.split(INNER_BREAK).map((part) => parseEnvLine(part));
}

/**
 * Whether `body` holds an assignment to `name` that a break inside the line
 * keeps `parseEnvLine` from reading, as a CR-only file or a pasted U+2028
 * leaves.
 * @param {string} body a line from `splitEnvLines`
 * @param {string} name
 * @returns {boolean}
 */
function assignsAcrossBreak(body, name) {
	return (
		parseEnvLine(body) === null &&
		parseAcrossBreaks(body).some((part) => part?.name === name)
	);
}

/**
 * A line's raw right-hand side as the value it assigns.
 * @param {string} raw
 * @returns {string}
 */
function unquoteValue(raw) {
	return raw.trim().replace(/^["']|["']$/g, "");
}

const QUOTES = "\"'`";

/**
 * `cut` less the quotes, backticks and spaces off each end, walked by hand as a
 * regex would rescan a long run inside the value at every start (#3661).
 * @param {string} cut
 * @returns {string}
 */
function stripReadingEdge(cut) {
	/** @param {string} char */
	const isEdge = (char) => QUOTES.includes(char) || char.trim() === "";
	let start = 0;
	let end = cut.length;
	while (start < end && isEdge(cut.charAt(start))) start++;
	while (end > start && isEdge(cut.charAt(end - 1))) end--;
	return cut.slice(start, end);
}

/**
 * `text` less a comment, from the first `#` after a space on.
 * @param {string} text
 * @returns {string}
 */
function cutComment(text) {
	return text.replace(/\s#[\s\S]*/, "");
}

/**
 * A line's raw right-hand side cut as a hand-writer may mean it, none of it the
 * writer's grammar (#3908): through the first closing quote and through the
 * last where a quote opens it, as a comment may hold one and a value may too;
 * else up to the first `#`, as dotenv reads it, and up to cutComment's, as a
 * shell does (#4048). Each goes through stripReadingEdge.
 * @param {string} raw
 * @returns {string[]}
 */
function parseHandWrittenValues(raw) {
	const trimmed = raw.trim();
	const quote = trimmed.charAt(0);
	const closes =
		quote && QUOTES.includes(quote) ? trimmed.indexOf(quote, 1) : -1;
	const cuts =
		closes === -1
			? [trimmed.replace(/#.*/, ""), cutComment(trimmed)]
			: [
					trimmed.slice(1, closes),
					trimmed.slice(1, trimmed.lastIndexOf(quote)),
				];
	return cuts.map(stripReadingEdge);
}

/** @typedef {(text: string, at: number) => boolean} QuoteRule whether the quote at `at` is escaped */

/* The two readings of a quote after backslashes: a shell's, escaped after an
 * odd run; and dotenv's, whose `\\"` alternative takes one after any run as
 * escaped (#4048). */
/** @type {QuoteRule[]} */
const QUOTE_RULES = [
	(text, at) => {
		let before = at;
		while (before > 0 && text.charAt(before - 1) === "\\") before--;
		return (at - before) % 2 === 1;
	},
	(text, at) => text.charAt(at - 1) === "\\",
];

/**
 * Where `text` holds `quote` unescaped by `escaped`, its first from `from` on,
 * and where escaped, its last before that.
 * @param {string} text
 * @param {string} quote
 * @param {number} from
 * @param {QuoteRule} escaped
 * @returns {{ closing: number, lastEscaped: number }} -1 for either it lacks
 */
function findQuotes(text, quote, from, escaped) {
	let lastEscaped = -1;
	for (
		let at = text.indexOf(quote, from);
		at !== -1;
		at = text.indexOf(quote, at + 1)
	) {
		if (!escaped(text, at)) return { closing: at, lastEscaped };
		lastEscaped = at;
	}
	return { closing: -1, lastEscaped };
}

/** @typedef {{ lead: string, text: string }} Part a part and the break before it */

/**
 * `text` as its parts between every line break.
 * @param {string} text
 * @returns {Part[]}
 */
function splitAtBreaks(text) {
	const parts = [];
	let lead = "";
	let from = 0;
	for (const match of text.matchAll(ANY_BREAK)) {
		parts.push({ lead, text: text.slice(from, match.index) });
		lead = match[0];
		from = match.index + lead.length;
	}
	parts.push({ lead, text: text.slice(from) });
	return parts;
}

/**
 * The right-hand side of a line DOTENV_LINE reads, or null where it reads none
 * or reads a comment assigning PROSE_VALUE to a name holding a lower-case
 * letter, as POSIX spells an environment variable's in capitals (XBD 8.1).
 * @param {string} line
 * @returns {string | null}
 */
function parseDotenvRaw(line) {
	const m = line.match(DOTENV_LINE);
	if (!m) return null;
	const raw = requiredGroup(m, 3, DOTENV_LINE);
	const name = m[2] ?? "";
	const prose =
		(m[1]?.includes("#") ?? false) &&
		/[a-z]/.test(name) &&
		!SECRET_NAME.test(name) &&
		PROSE_VALUE.test(raw.trim());
	return prose ? null : raw;
}

/* A line's indent, then its comment marks and the spaces between them. */
const COMMENT_MARKS = /^(\s*)#(?:[\s#]*#)?/;

/* What commenting out added to a later line, as the value's line was
 * commented out too (#3999), each with what replaces it: the marks alone and
 * those and one space, as an editor's toggle writes `# `, each keeping the
 * line's indent; or the marks and every space around them. */
const COMMENT_OPENINGS = [
	{ opening: COMMENT_MARKS, kept: "$1" },
	{ opening: /^(\s*)#(?:[\s#]*#)? /, kept: "$1" },
	{ opening: /^\s*#[\s#]*/, kept: "" },
];

/**
 * A value's parts as a masker reads it: whole, as dotenv hands on its breaks
 * too, a CR as it normalises one, and part by part. A value commented out
 * line by line is read again with each of COMMENT_OPENINGS off each later
 * part.
 * @param {Part[]} parts
 * @param {boolean} commented whether a comment mark opens the value's line
 * @returns {string[]}
 */
function readingsOfSplitValue(parts, commented) {
	/** @param {Part[]} held */
	const readings = (held) => {
		const whole = held.map(({ lead, text }) => `${lead}${text}`).join("");
		return [
			whole,
			whole.replace(/\r\n?/g, "\n"),
			...held.map(({ text }) => text),
		];
	};
	const uncommented = commented
		? COMMENT_OPENINGS.flatMap(({ opening, kept }) =>
				readings(
					parts.map((part, at) =>
						at === 0
							? part
							: { ...part, text: part.text.replace(opening, kept) },
					),
				),
			)
		: [];
	return [...readings(parts), ...uncommented].map(stripReadingEdge);
}

/**
 * The quote a part opens and leaves open, with what follows it, and whether a
 * comment mark opens the part.
 * @param {string} text
 * @param {QuoteRule} escaped
 * @returns {{ quote: string, opened: string, commented: boolean } | null}
 */
function parseOpener(text, escaped) {
	const trimmed = parseDotenvRaw(text)?.trimStart();
	const quote = trimmed?.charAt(0);
	if (!trimmed || !quote || !QUOTES.includes(quote)) return null;
	if (findQuotes(trimmed, quote, 1, escaped).closing !== -1) return null;
	return {
		quote,
		opened: trimmed.slice(1),
		commented: COMMENT_MARKS.test(text),
	};
}

/**
 * Each value a quote holds across breaks, read in one pass with one open value
 * per quote, as a second opener of that quote closes the first. Where no later
 * part closes one, as dotenv's regex backtracks it closes at the last escaped
 * quote; failing that it holds no later part.
 * @param {Part[]} parts
 * @param {QuoteRule} escaped
 * @returns {string[]}
 */
function parseSplitValues(parts, escaped) {
	/** @type {Map<string, { parts: Part[], commented: boolean, fallback: { count: number, last: Part } | null }>} */
	const open = new Map();
	const values = [];
	for (const { lead, text } of parts) {
		for (const [quote, value] of open) {
			const { closing, lastEscaped } = findQuotes(text, quote, 0, escaped);
			if (closing !== -1) {
				value.parts.push({ lead, text: text.slice(0, closing) });
				values.push(readingsOfSplitValue(value.parts, value.commented));
				open.delete(quote);
				continue;
			}
			if (lastEscaped !== -1) {
				value.fallback = {
					count: value.parts.length,
					last: { lead, text: text.slice(0, lastEscaped + 1) },
				};
			}
			value.parts.push({ lead, text });
		}
		const opener = parseOpener(text, escaped);
		if (opener) {
			open.set(opener.quote, {
				parts: [{ lead: "", text: opener.opened }],
				commented: opener.commented,
				fallback: null,
			});
		}
	}
	for (const { parts: held, commented, fallback } of open.values()) {
		if (fallback) {
			values.push(
				readingsOfSplitValue(
					[...held.slice(0, fallback.count), fallback.last],
					commented,
				),
			);
		}
	}
	/* A value of many parts overflows the stack spread into a `push`. */
	return values.flat();
}

/**
 * Each unquoted value dotenv reads across a U+2028 or U+2029, whole and part by
 * part, each as written and less cutComment's comment (#4048).
 * @param {string} text the file's text
 * @returns {string[]}
 */
function parseSeparatedValues(text) {
	return text.split(LINE_END).flatMap((line) => {
		if (!SEPARATOR.test(line)) return [];
		const raw = parseDotenvRaw(line);
		if (raw === null || QUOTES.includes(raw.trimStart().charAt(0) || " ")) {
			return [];
		}
		return [raw, ...raw.split(SEPARATOR)]
			.flatMap((value) => [value, cutComment(value)])
			.map(stripReadingEdge);
	});
}

const EXPANDED_ESCAPES = new Map([
	["n", "\n"],
	["r", "\r"],
]);

/**
 * A value as a log may print it: as written; its escapes expanded, and where
 * that makes breaks, each line of it, as a real break does (#4048); and with
 * each LF a CRLF.
 * @param {string} value
 * @returns {string[]}
 */
function buildPrintedForms(value) {
	const expanded = unescapeValue(value);
	const parts = expanded === value ? [] : splitAtBreaks(expanded);
	const lines =
		parts.length > 1 ? parts.map(({ text }) => stripReadingEdge(text)) : [];
	return [value, expanded, ...lines].flatMap((form) =>
		form.includes("\n") ? [form, form.replace(/\r?\n/g, "\r\n")] : [form],
	);
}

/**
 * `value` with its backslash escapes expanded, as a shell or dotenv would.
 * @param {string} value
 * @returns {string}
 */
function unescapeValue(value) {
	return value.replace(
		/\\(.)/g,
		(_match, char) => EXPANDED_ESCAPES.get(char) ?? char,
	);
}

/**
 * A trimmed `value` as a line's right-hand side that unquoteValue reads back
 * unchanged, or null where none does.
 * @param {string} value
 * @returns {string | null}
 */
function quoteValue(value) {
	if (!/[#$`]|^["'`]|["'`]$/.test(value)) return value;
	return value.includes("'") ? null : `'${value}'`;
}

/**
 * The secrets file WFC_SECRETS_FILE names, resolved, or null where it names
 * none.
 * @returns {string | null}
 */
function secretsOverride() {
	const override = process.env.WFC_SECRETS_FILE;
	return override && path.isAbsolute(override) ? path.resolve(override) : null;
}

/** @returns {string} */
function secretsFile() {
	const override = secretsOverride();
	if (override !== null) return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	const config =
		xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
	return path.join(config, "workflow-core", "secrets.env");
}

/** Thrown where a secrets file's path holds something no regular file is. */
class NotRegularFile extends Error {
	/**
	 * @param {string} file
	 * @param {ErrorOptions} [options]
	 */
	constructor(file, options) {
		super(
			`${file} is no regular file (a FIFO, socket, device or directory)`,
			options,
		);
	}
}

/**
 * `file`'s bytes, opened without blocking and judged by that descriptor, as a
 * FIFO blocks a plain read for good, so nothing swapped in after a check can
 * hang it (#3822).
 * @param {string} file
 * @param {number} [flags] ORed into the open, as `O_NOFOLLOW`
 * @returns {Buffer}
 * @throws NotRegularFile on a FIFO, socket, device or directory; otherwise as
 *   the open or read fails, ENOENT where it is absent
 */
function readRegularFile(file, flags = 0) {
	const { O_NONBLOCK, O_RDONLY } = fs.constants;
	let fd;
	try {
		fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | flags);
	} catch (e) {
		/* What opening a socket answers. */
		if (caught(e).code === "ENXIO")
			throw new NotRegularFile(file, { cause: e });
		throw e;
	}
	try {
		if (!fs.fstatSync(fd).isFile()) throw new NotRegularFile(file);
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The first non-empty value the file assigns `name`, or null where none does.
 * @param {string} file
 * @param {string} name
 * @returns {string|null}
 * @throws where the file cannot be read; ENOENT where it is absent
 */
function readEnvFileValue(file, name) {
	const text = readRegularFile(file).toString("utf8");
	for (const { body } of splitEnvLines(text).lines) {
		const assignment = parseEnvLine(body);
		if (assignment?.name !== name) continue;
		const value = unquoteValue(assignment.raw);
		if (value) return value;
	}
	return null;
}

/**
 * Whether `ignore` is a regular file holding exactly `*`. git follows no
 * symlinked `.gitignore` and skips an unreadable one, so neither counts
 * (#3663, #3822).
 * @param {string} ignore
 * @returns {boolean}
 */
function isIgnoreAll(ignore) {
	try {
		const bytes = readRegularFile(ignore, fs.constants.O_NOFOLLOW);
		return bytes.toString("utf8") === "*\n";
	} catch {
		/* Absent, a symlink, unreadable or no regular file: all get replaced, and
		 * a rename that cannot replace one throws in ignoreStore. */
		return false;
	}
}

/**
 * Writes `<dir>/.gitignore` holding `*`, where anything else is there.
 * @param {string} dir
 * @throws where it cannot be replaced, as a directory cannot
 */
function ignoreStore(dir) {
	const ignore = path.join(dir, ".gitignore");
	if (!isIgnoreAll(ignore)) writeFileAtomic(ignore, "*\n", { mode: 0o600 });
}

/**
 * `readEnvFileValue` on the secrets file, then `ignoreStore` on its directory,
 * so a `.gitignore` missing, symlinked, unreadable or holding anything else is
 * healed (#3663, #3822). Under the WFC_SECRETS_FILE override it writes nothing: that
 * file's directory may be a repository whose own `.gitignore` this would
 * replace.
 * @param {string} name
 * @returns {string|null}
 * @throws as `readEnvFileValue`, before anything is written
 */
function readSecretKeepingIgnore(name) {
	const file = secretsFile();
	const value = readEnvFileValue(file, name);
	if (secretsOverride() !== null) return value;
	const dir = path.dirname(file);
	try {
		ignoreStore(dir);
	} catch (e) {
		/* The value is what the caller asked for (#3663); the store is left
		 * without its ignore, so the fault goes where check:guard-errors reads. */
		logError("env-file ignoreStore", e, dir);
	}
	return value;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const RESAVE_UTF8 = "Re-save it as UTF-8, then re-run.";

const UNMASKABLE = "so its secrets cannot be masked.";

/**
 * The secrets file's bytes as text, or the fault that keeps them from being
 * read as lines: `utf16` for a UTF-16 mark or a NUL byte, which no line
 * carries and which ASCII in UTF-16 without its mark holds (#3550); `invalid`
 * for bytes that are not valid UTF-8.
 * @param {Buffer} bytes
 * @returns {{ text: string } | { fault: "utf16" | "invalid" }}
 */
function decodeSecrets(bytes) {
	if (
		(bytes[0] === 0xff && bytes[1] === 0xfe) ||
		(bytes[0] === 0xfe && bytes[1] === 0xff) ||
		bytes.includes(0)
	) {
		return { fault: "utf16" };
	}
	try {
		return { text: UTF8.decode(bytes) };
	} catch {
		/* The fatal decoder's only throw (#3663). */
		return { fault: "invalid" };
	}
}

/**
 * The secrets file's text.
 * @returns {string} empty where there is no file
 * @throws where the file is there but cannot be read as UTF-8 lines, as a
 *   masker that quietly masked fewer secrets would write their values bare,
 *   its message naming the fault and the way out
 */
function readStoredText() {
	const file = secretsFile();
	let bytes;
	try {
		bytes = readRegularFile(file);
	} catch (err) {
		const { code, message } = caught(err);
		/* ENOENT from a dangling symlink is a store gone wrong, not no store. */
		if (code === "ENOENT" && !fs.lstatSync(file, { throwIfNoEntry: false }))
			return "";
		const fault =
			err instanceof NotRegularFile
				? message
				: `${file} cannot be read (${code})`;
		throw new Error(
			`${fault}, ${UNMASKABLE} Make it a readable regular file, then re-run.`,
			{ cause: err },
		);
	}
	const decoded = decodeSecrets(bytes);
	if ("fault" in decoded) {
		throw new Error(
			`${file} is not clean UTF-8 (${decoded.fault}), ${UNMASKABLE} ${RESAVE_UTF8}`,
		);
	}
	return decoded.text;
}

/**
 * Every name the secrets file assigns, a line split at each break inside it as
 * assignsAcrossBreak reads one (#3710): what a log masker masks the value after
 * (#3661). And every non-empty value, what it masks wherever it appears (#3821),
 * from one read of the file. A line dotenv reads gives its value whole, as
 * readEnvFileValue reads it, and as parseHandWrittenValues cuts it (#3908); one
 * across breaks as parseSplitValues and parseSeparatedValues do (#3917); each
 * in every buildPrintedForms form (#3908, #4048).
 * @returns {{ names: string[], values: string[] }} empty where there is no file
 * @throws as readStoredText does
 */
function readStoredSecrets() {
	const text = readStoredText();
	const parts = splitAtBreaks(text);
	const names = parts.flatMap((part) => parseEnvLine(part.text)?.name ?? []);
	const whole = parts
		.flatMap((part) => parseDotenvRaw(part.text) ?? [])
		.flatMap((raw) => [unquoteValue(raw), ...parseHandWrittenValues(raw)]);
	const values = [
		...whole,
		...QUOTE_RULES.flatMap((escaped) => parseSplitValues(parts, escaped)),
		...parseSeparatedValues(text),
	].flatMap(buildPrintedForms);
	return {
		names: [...new Set(names)],
		values: [...new Set(values.filter(Boolean))],
	};
}

module.exports = {
	assignsAcrossBreak,
	decodeSecrets,
	ignoreStore,
	NotRegularFile,
	parseEnvLine,
	quoteValue,
	readEnvFileValue,
	readRegularFile,
	readSecretKeepingIgnore,
	SPACE,
	secretsFile,
	secretsOverride,
	splitEnvLines,
	readStoredSecrets,
	RESAVE_UTF8,
	UTF8,
};
