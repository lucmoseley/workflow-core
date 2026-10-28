#!/usr/bin/env node
/*
 * write-secret.js — reads one secret with typing hidden and writes it into the
 * secrets file, so a founder hand-over can capture a credential without its
 * value ever entering the chat (#640, spec #632).
 *
 * Usage:
 *   node write-secret.js <NAME>
 *
 * The value is typed at the terminal with echo off. A value on piped stdin is
 * accepted too — the test seam; the hand-over never uses it, because a piped
 * value sits in the shell's history. Under Claude Code's `!` prefix stdin is
 * no terminal and carries nothing, and there is no controlling terminal to
 * open instead (#2554).
 *
 * TARGET: `lib/env-file.js`'s secrets file, outside every working tree, so a
 * stray relative `.env` write in any checkout cannot destroy it (#3202). Its
 * directory is created owner-only.
 *
 * NO FAMILY (§N3), as `grant-permission.js`: 0 written; 1 the file sits in a
 * git working tree, is a symlink, or cannot be written; 2 bad arguments or a
 * value no line can carry. Every refusal leaves the file untouched, and one
 * about the file itself comes before the value is asked for.
 *
 * IN A WORKING TREE IS REFUSED (#3202): a `.git` in the file's directory or
 * any above it, as where XDG_CONFIG_HOME names a checkout or the home directory is a
 * dotfiles repository, means a commit there could take it. Residual: a bare
 * repository whose work tree is set elsewhere, as a bare dotfiles setup, is
 * not seen.
 *
 * A SYMLINK IS REFUSED: its target may lie in a working tree (#640 review).
 *
 * NOTHING OF THE VALUE IS PRINTED — not it, its length or any part of it — and
 * nor is a malformed name, which is most likely the secret pasted in the
 * wrong place.
 *
 * THE UPSERT replaces the value on every line assigning <NAME> (`NAME=`,
 * `export NAME =`), keeping that line's prefix and CRLF ending; with none, it
 * appends `NAME=value`. Every other byte, and whether the file ends in a
 * newline, is kept. It lands by rename, owner-only.
 *
 * THE VALUE is trimmed, as `lib/env-file.js`'s reader and dotenv both trim. It
 * is written unquoted unless it holds `#` (dotenv's comment), `$` or a
 * backtick (expansion), or starts or ends with a quote (which both readers
 * strip) — then single-quoted, which both read back literally. A value needing
 * quotes that holds a single quote is refused: no quoting survives both.
 *
 * A STALE ASIDE an earlier run left, a full copy of the file, is removed
 * first, before any refusal: a regular file `secrets.env.<pid>.<hex>.tmp`
 * beside it whose pid is not running (#2320). One whose pid runs is a
 * concurrent run's, or a reused pid's: it is named and left. Residual: a
 * concurrent run in another pid namespace reads as dead and loses its aside;
 * its rename then fails and it refuses, so nothing leaks.
 *
 * NO FILE CLAIM (spec #525's ruling for `grant-permission.js`): the file is in
 * no repository, and the founder's paste has no session to claim with.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { asidePid, writeFileAtomic } = require("./lib/atomic-write.js");
const { parseOrCode } = require("./lib/cli-args");
const { secretsFile } = require("./lib/env-file.js");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { readHidden } = require("./lib/read-hidden.js");
const { caught } = require("./lib/caught.js");
const { SHELL_VAR_NAME } = require("./lib/shell-var-name.js");

const VAR_NAME = new RegExp(`^${SHELL_VAR_NAME}$`);

const USAGE = `usage: write-secret.js <NAME>
  <NAME>  a shell variable name; the value is then asked for with typing hidden`;

/**
 * @param {string} file
 * @param {string} why
 * @param {number} status
 * @returns {number}
 */
function refuse(file, why, status) {
	process.stderr.write(`write-secret: refused, ${file} untouched — ${why}\n`);
	return status;
}

/**
 * The working tree `dir` or a directory above it holds, by its `.git`, or null.
 * The walk starts from the real path of `dir`'s deepest existing directory, so
 * a symlinked config directory is judged where it points.
 * @param {string} dir
 * @returns {string | null}
 */
function findEnclosingTree(dir) {
	let d = path.resolve(dir);
	while (!isDirectory(d)) d = path.dirname(d);
	for (d = fs.realpathSync(d); ; d = path.dirname(d)) {
		if (fs.lstatSync(path.join(d, ".git"), { throwIfNoEntry: false })) return d;
		if (d === path.dirname(d)) return null;
	}
}

/** @param {string} p */
function isSymlink(p) {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** @param {string} p */
function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

const LEFT = "a copy of the secrets file an earlier interrupted write left";

/**
 * Removes, or names and leaves, each aside of `file`, never reading one.
 * @param {string} file
 */
function sweepAsides(file) {
	const dir = path.dirname(file);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		/* No directory yet, or a file where one goes: the write refuses. */
		if (caught(e).code === "ENOENT" || caught(e).code === "ENOTDIR") return;
		process.stderr.write(
			`write-secret: warning — ${dir} could not be listed (${caught(e).code ?? "error"}), so ${LEFT} may remain there. Look for ${path.basename(file)}.*.tmp by hand.\n`,
		);
		return;
	}
	for (const name of names) {
		const pid = asidePid(path.basename(file), name);
		if (pid === null) continue;
		const aside = path.join(dir, name);
		if (!fs.lstatSync(aside, { throwIfNoEntry: false })?.isFile()) continue;
		if (pidAlive(pid)) {
			process.stderr.write(
				`write-secret: left ${aside}, a copy of the secrets file: its pid ${pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
			);
			continue;
		}
		try {
			fs.rmSync(aside);
			process.stderr.write(`write-secret: removed ${aside}, ${LEFT}.\n`);
		} catch (e) {
			process.stderr.write(
				`write-secret: warning — ${aside}, ${LEFT}, could not be removed (${caught(e).code ?? "error"}). Delete it by hand.\n`,
			);
		}
	}
}

/**
 * The value from piped stdin, less one trailing line break.
 * @returns {string}
 */
function readPiped() {
	return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

/**
 * `value` as a .env line's right-hand side, or null where none reads back.
 * @param {string} value
 * @returns {string | null}
 */
function quoteValue(value) {
	if (!/[#$`]|^["'`]|["'`]$/.test(value)) return value;
	return value.includes("'") ? null : `'${value}'`;
}

/**
 * `text` with <name>'s value replaced on every line assigning it, or the
 * assignment appended.
 * @param {string} text
 * @param {string} name
 * @param {string} value
 * @returns {{ text: string, replaced: boolean }}
 */
function upsert(text, name, value) {
	const assigns = new RegExp(
		`^([ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*).*?(\\r?)$`,
	);
	let replaced = false;
	const lines = text.split("\n").map((line) => {
		const m = line.match(assigns);
		if (!m) return line;
		replaced = true;
		return `${m[1]}${value}${m[2]}`;
	});
	if (replaced) return { text: lines.join("\n"), replaced };
	if (text === "") return { text: `${name}=${value}\n`, replaced };
	return text.endsWith("\n")
		? { text: `${text}${name}=${value}\n`, replaced }
		: { text: `${text}\n${name}=${value}`, replaced };
}

/**
 * Upserts the value, once it is in hand, into `file`.
 * @param {string} file
 * @param {string} name
 * @param {string} raw
 * @param {boolean} fromTerminal whether `raw` was typed at the hidden prompt
 * @returns {number}
 */
function upsertEnv(file, name, raw, fromTerminal) {
	if (/[\r\n]/.test(raw)) {
		return refuse(
			file,
			"the value holds a line break, which one line cannot carry. Re-run and give it on one line.",
			2,
		);
	}
	const trimmed = raw.trim();
	if (trimmed === "") {
		return refuse(file, emptyWhy(name, hostRoot(), fromTerminal), 2);
	}
	const value = quoteValue(trimmed);
	if (value === null) {
		return refuse(
			file,
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
			2,
		);
	}

	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const next = upsert(text, name, value);
		writeFileAtomic(file, next.text, { mode: 0o600 });
		process.stdout.write(
			`write-secret: ${next.replaced ? "replaced" : "added"} ${name} in ${file}\n`,
		);
	} catch (e) {
		return refuse(
			file,
			`it could not be written (${caught(e).code ?? "error"}). Check it is a regular file you can write, then re-run.`,
			1,
		);
	}

	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number | Promise<number>} exit status
 */
function main(argv) {
	const file = secretsFile();
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const { positionals } = parsed;
	const [name] = positionals;
	if (name === undefined)
		throw new Error("parse passed no <NAME> despite min: 1");
	if (!VAR_NAME.test(name)) {
		return refuse(
			file,
			"the argument is not a shell variable name (letters, digits and underscores, not starting with a digit). The value is asked for afterwards, never given on the command line.",
			2,
		);
	}

	sweepAsides(file);
	const tree = findEnclosingTree(path.dirname(file));
	if (tree !== null) {
		return refuse(
			file,
			`it lies in the git working tree at ${tree}, so a commit there could take it. Point XDG_CONFIG_HOME at a directory in no working tree, then re-run.`,
			1,
		);
	}
	if (isSymlink(file)) {
		return refuse(
			file,
			"it is a symlink, whose target may lie in a working tree. Replace it with a regular file, then re-run.",
			1,
		);
	}

	if (!process.stdin.isTTY) return upsertEnv(file, name, readPiped(), false);
	process.stderr.write(`Value for ${name} (typing hidden, Enter to finish): `);
	return readHidden(process.stdin).then(
		(raw) => {
			process.stderr.write("\n");
			return upsertEnv(file, name, raw, true);
		},
		() => {
			process.stderr.write("\n");
			return refuse(file, "interrupted. Re-run to enter the value.", 2);
		},
	);
}

if (require.main === module) {
	const status = main(process.argv.slice(2));
	/* Set synchronously where it can be: the piped path is the test seam, and
	 * `lib/run-in-process.js` reads the exit before any promise settles. */
	if (typeof status === "number") process.exitCode = status;
	else
		status.then(
			(s) => {
				process.exitCode = s;
			},
			(e) => {
				process.stderr.write(`write-secret: ${e}\n`);
				process.exitCode = 1;
			},
		);
}
