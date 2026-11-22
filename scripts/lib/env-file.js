const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { logError } = require("./arbiter-core.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group");

const SPACE = String.raw`[^\S\r\n\u2028\u2029]`;
const ENV_LINE = new RegExp(
	`^(${SPACE}*(?:export${SPACE}+)?([A-Za-z_][A-Za-z0-9_]*)${SPACE}*=${SPACE}*)(?!${SPACE})(.*)$`,
);

const INNER_BREAK = /[\r\u2028\u2029]/;

const ANY_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

const LINE_END = /\r\n|[\n\r]/;
const SEPARATOR = /[\u2028\u2029]/;

const DOTENV_LINE =
	/^(?:\s*(?:export\s+)?[\w.-]+:\s+|([\s#]*)(?:export\s+)?([\w.-]+)\s*=\s*)((?:\S[^\r\n]*)?)$/;

/* #4048 */
const PROSE_VALUE = /^[a-z]+$/;
const SECRET_NAME = /pass|pwd|secret|key|token|auth|cred/i;

const BOM = "\uFEFF";

/**
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
 * @param {string} body
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

/** @param {string} body */
function parseAcrossBreaks(body) {
	return body.split(INNER_BREAK).map((part) => parseEnvLine(part));
}

/**
 * @param {string} body
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
 * @param {string} raw
 * @returns {string}
 */
function unquoteValue(raw) {
	return raw.trim().replace(/^["']|["']$/g, "");
}

const QUOTES = "\"'`";

/**
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
 * @param {string} text
 * @returns {string}
 */
function cutComment(text) {
	return text.replace(/\s#[\s\S]*/, "");
}

/**
 * #3908, #4048
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

/** @typedef {(text: string, at: number) => boolean} QuoteRule */

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
 * @param {string} text
 * @param {string} quote
 * @param {number} from
 * @param {QuoteRule} escaped
 * @returns {{ closing: number, lastEscaped: number }}
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

/** @typedef {{ lead: string, text: string }} Part */

/**
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

const COMMENT_MARKS = /^(\s*)#(?:[\s#]*#)?/;

/* #3999 */
const COMMENT_OPENINGS = [
	{ opening: COMMENT_MARKS, kept: "$1" },
	{ opening: /^(\s*)#(?:[\s#]*#)? /, kept: "$1" },
	{ opening: /^\s*#[\s#]*/, kept: "" },
];

/**
 * @param {Part[]} parts
 * @param {boolean} commented
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
	return values.flat();
}

/**
 * @param {string} text
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
 * @param {string} value
 * @returns {string | null}
 */
function quoteValue(value) {
	if (!/[#$`]|^["'`]|["'`]$/.test(value)) return value;
	return value.includes("'") ? null : `'${value}'`;
}

// #3715
/** @returns {string | null} */
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
 * @param {string} file
 * @param {number} [flags]
 * @returns {Buffer}
 */
function readRegularFile(file, flags = 0) {
	const { O_NONBLOCK, O_RDONLY } = fs.constants;
	let fd;
	try {
		fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | flags);
	} catch (e) {
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
 * @param {string} file
 * @param {string} name
 * @returns {string|null}
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
 * @param {string} ignore
 * @returns {boolean}
 */
function isIgnoreAll(ignore) {
	try {
		const bytes = readRegularFile(ignore, fs.constants.O_NOFOLLOW);
		return bytes.toString("utf8") === "*\n";
	} catch {
		return false;
	}
}

// #3539, #3663, #3822
/** @param {string} dir */
function ignoreStore(dir) {
	const ignore = path.join(dir, ".gitignore");
	if (!isIgnoreAll(ignore)) writeFileAtomic(ignore, "*\n", { mode: 0o600 });
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function readSecretKeepingIgnore(name) {
	const file = secretsFile();
	const value = readEnvFileValue(file, name);
	if (secretsOverride() !== null) return value;
	const dir = path.dirname(file);
	try {
		ignoreStore(dir);
	} catch (e) {
		logError("env-file ignoreStore", e, dir);
	}
	return value;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const RESAVE_UTF8 = "Re-save it as UTF-8, then re-run.";

const UNMASKABLE = "so its secrets cannot be masked.";

// #3550
/**
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
		return { fault: "invalid" };
	}
}

/** @returns {string} */
function readStoredText() {
	const file = secretsFile();
	let bytes;
	try {
		bytes = readRegularFile(file);
	} catch (err) {
		const { code, message } = caught(err);
		// #3908
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

// #3661, #3710, #3821, #3908, #3917, #4048
/** @returns {{ names: string[], values: string[] }} */
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
