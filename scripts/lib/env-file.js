/*
 * env-file.js — the secrets file, its line grammar, and one variable's value
 * from it.
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
 * THE RETURN VALUE IS A SECRET: a caller puts it in no log line or message.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
		body.split(INNER_BREAK).some((part) => parseEnvLine(part)?.name === name)
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

/**
 * The first non-empty value the file assigns `name`, or null where none does.
 * @param {string} file
 * @param {string} name
 * @returns {string|null}
 * @throws where the file cannot be read; ENOENT where it is absent
 */
function readEnvFileValue(file, name) {
	for (const { body } of splitEnvLines(fs.readFileSync(file, "utf8")).lines) {
		const assignment = parseEnvLine(body);
		if (assignment?.name !== name) continue;
		const value = unquoteValue(assignment.raw);
		if (value) return value;
	}
	return null;
}

/**
 * Writes `<dir>/.gitignore` holding `*`, where anything else is there: git
 * follows no symlinked `.gitignore`, so a symlink is replaced too (#3663).
 * @param {string} dir
 */
function ignoreStore(dir) {
	const ignore = path.join(dir, ".gitignore");
	const st = fs.lstatSync(ignore, { throwIfNoEntry: false });
	if (!st?.isFile() || fs.readFileSync(ignore, "utf8") !== "*\n")
		writeFileAtomic(ignore, "*\n", { mode: 0o600 });
}

/**
 * `readEnvFileValue` on the secrets file, then `ignoreStore` on its directory
 * where its `.gitignore` is missing or a symlink (#3663). Under the WFC_SECRETS_FILE
 * override it writes nothing: that file's directory may be a repository whose
 * own `.gitignore` this would replace.
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
		if (
			fs
				.lstatSync(path.join(dir, ".gitignore"), { throwIfNoEntry: false })
				?.isFile()
		)
			return value;
		ignoreStore(dir);
	} catch {
		/* The value is what the caller asked for (#3663). */
	}
	return value;
}

/**
 * Every name the secrets file assigns, never a value: what a log masker
 * masks the value after (#3661).
 * @returns {string[]} empty where there is no file
 * @throws where the file is there but cannot be read, as a masker that
 *   quietly masked fewer names would write their values bare
 */
function storedNames() {
	let text;
	try {
		text = fs.readFileSync(secretsFile(), "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	const names = splitEnvLines(text).lines.map(
		({ body }) => parseEnvLine(body)?.name,
	);
	return [...new Set(names.filter((name) => name !== undefined))];
}

module.exports = {
	assignsAcrossBreak,
	ignoreStore,
	parseEnvLine,
	quoteValue,
	readEnvFileValue,
	readSecretKeepingIgnore,
	secretsFile,
	secretsOverride,
	splitEnvLines,
	storedNames,
};
