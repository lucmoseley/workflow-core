#!/usr/bin/env node
/*
 * write-secret.js — reads one secret with typing hidden and writes it into the
 * host repository's `.env`, so a founder hand-over can capture a credential
 * without its value ever entering the chat (#640, spec #632).
 *
 * Usage:
 *   node write-secret.js <NAME>
 *
 * The value is typed at the terminal with echo off. A value on piped stdin is
 * accepted too — the test seam; the hand-over never uses it, because a piped
 * value sits in the shell's history. Under Claude Code's `!` prefix stdin is
 * no terminal and carries nothing, and there is no controlling terminal to
 * open instead (#2554): `lib/empty-secret.js` words that refusal.
 *
 * TARGET: `.env` at the host root, `lib/host-root.js`'s, so an install writes
 * into the adopter's tree, never the plugin cache.
 *
 * NO FAMILY (§N3), as `grant-permission.js`: 0 written; 1 `.env` is tracked by
 * git, is a symlink, or cannot be written; 2 bad arguments or a value no .env
 * line can carry. Every refusal leaves `.env` untouched, and one about `.env`
 * itself comes before the value is asked for.
 *
 * A SYMLINKED `.env` IS REFUSED: its target may be a tracked file, which the
 * tracked check on `.env` itself cannot see (#640 review).
 *
 * NOTHING OF THE VALUE IS PRINTED — not it, its length or any part of it — and
 * nor is a malformed name, which is most likely the secret pasted in the
 * wrong place.
 *
 * THE UPSERT replaces the value on every line assigning <NAME> (`NAME=`,
 * `export NAME =`), keeping that line's prefix and CRLF ending; with none, it
 * appends `NAME=value`. Every other byte, and whether the file ends in a
 * newline, is kept. It lands by rename; a new `.env` is created owner-only, an
 * existing one keeps its mode.
 *
 * THE VALUE is trimmed, as `guard-jev-advisory.js`'s reader and dotenv both
 * trim. It is written unquoted unless it holds `#` (dotenv's comment), `$` or a
 * backtick (expansion), or starts or ends with a quote (which both readers
 * strip) — then single-quoted, which both read back literally. A value needing
 * quotes that holds a single quote is refused: no quoting survives both.
 *
 * A STALE ASIDE an earlier run left, a full copy of `.env`, is removed first,
 * before any refusal: a regular file `.env.<pid>.<hex>.tmp` at the host root
 * whose pid is not running. Only this writer makes that name there (#2320).
 * One whose pid runs is a concurrent run's, or a reused pid's: it is named and
 * left. One git tracks is named and left too, as its copy is in history.
 * Residual: a concurrent run in another pid namespace reads as dead and loses
 * its aside; its rename then fails and it refuses, so nothing leaks.
 *
 * NO FILE CLAIM (spec #525's ruling for `grant-permission.js`): `.env` is
 * untracked, and the founder's paste has no session to claim with.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const {
	asidePath,
	asidePid,
	writeFileAtomic,
} = require("./lib/atomic-write.js");
const { spawnSync } = require("node:child_process");
const { parseOrCode } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { readHidden } = require("./lib/read-hidden.js");
const { caught } = require("./lib/caught.js");
const { SHELL_VAR_NAME } = require("./lib/shell-var-name.js");

const VAR_NAME = new RegExp(`^${SHELL_VAR_NAME}$`);

const USAGE = `usage: write-secret.js <NAME>
  <NAME>  a shell variable name; the value is then asked for with typing hidden`;

/**
 * @param {string} why
 * @param {number} status
 * @returns {number}
 */
function refuse(why, status) {
	process.stderr.write(`write-secret: refused, .env untouched — ${why}\n`);
	return status;
}

/**
 * Whether git tracks `file` under `root`: `ls-files --error-unmatch` exits 0
 * tracked, 1 untracked, 128 outside a repository — nothing to commit it into.
 * Anything else, git missing included, is null: FAILS CLOSED (#640 review).
 * @param {string} root
 * @param {string} file
 * @returns {boolean | null}
 */
function isTracked(root, file) {
	const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], {
		cwd: root,
		stdio: "ignore",
	});
	if (r.status === 0) return true;
	if (r.status === 1 || r.status === 128) return false;
	return null;
}

/**
 * Whether git ignores `file` under `root`. Any failure reads as "not
 * ignored", which fails toward the warning (#640).
 * @param {string} root
 * @param {string} file
 * @returns {boolean}
 */
function isIgnored(root, file) {
	return (
		spawnSync("git", ["check-ignore", "-q", "--", file], {
			cwd: root,
			stdio: "ignore",
		}).status === 0
	);
}

/**
 * Warns where git would let `.env`, or the aside writeFileAtomic leaves when a
 * run dies or its cleanup fails, be committed. Before the value is asked for,
 * so a refused or killed run is warned too (#2255).
 * @param {string} root
 */
function warnUnignored(root) {
	const aside = asidePath(".env", "<pid>", "<hex>");
	// A real aside's shape, which an ignore rule for that shape must match.
	const sample = asidePath(".env", 0, "00000000");
	if (!isIgnored(root, ".env")) {
		process.stderr.write(
			`write-secret: warning — git does not ignore .env in ${root}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
		);
	} else if (!isIgnored(root, sample)) {
		process.stderr.write(
			`write-secret: warning — git ignores .env in ${root} but not ${aside}, the copy of .env an interrupted write leaves, so it could be committed. Add .env.*.tmp to .gitignore.\n`,
		);
	}
}

const LEFT = "a copy of .env an earlier interrupted write left";

/**
 * Removes the aside `name` at `root`, written by `pid`, naming it and never
 * reading it.
 * @param {string} root
 * @param {string} name
 * @param {number} pid
 */
function sweepAside(root, name, pid) {
	const file = path.join(root, name);
	if (isTracked(root, name)) {
		process.stderr.write(
			`write-secret: warning — ${file}, ${LEFT}, is tracked by git, so its secrets are in history. Rotate them, then git rm --cached it.\n`,
		);
	} else if (pidAlive(pid)) {
		process.stderr.write(
			`write-secret: left ${file}, a copy of .env: its pid ${pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
		);
	} else {
		try {
			fs.rmSync(file);
			process.stderr.write(`write-secret: removed ${file}, ${LEFT}.\n`);
		} catch (e) {
			process.stderr.write(
				`write-secret: warning — ${file}, ${LEFT}, could not be removed (${caught(e).code ?? "error"}). Delete it by hand.\n`,
			);
		}
	}
}

/** @param {string} root */
function sweepAsides(root) {
	let names;
	try {
		names = fs.readdirSync(root);
	} catch (e) {
		process.stderr.write(
			`write-secret: warning — ${root} could not be listed (${caught(e).code ?? "error"}), so ${LEFT} may remain there. Look for .env.*.tmp by hand.\n`,
		);
		return;
	}
	for (const name of names) {
		const pid = asidePid(".env", name);
		if (pid === null) continue;
		const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
		if (stat?.isFile()) sweepAside(root, name, pid);
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
 * Upserts the value, once it is in hand, into `.env` at `root`.
 * @param {string} root
 * @param {string} name
 * @param {string} raw
 * @param {boolean} fromTerminal whether `raw` was typed at the hidden prompt
 * @returns {number}
 */
function upsertEnv(root, name, raw, fromTerminal) {
	if (/[\r\n]/.test(raw)) {
		return refuse(
			"the value holds a line break, which one .env line cannot carry. Re-run and give it on one line.",
			2,
		);
	}
	const trimmed = raw.trim();
	if (trimmed === "") {
		return refuse(emptyWhy(name, root, fromTerminal), 2);
	}
	const value = quoteValue(trimmed);
	if (value === null) {
		return refuse(
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
			2,
		);
	}

	const envPath = path.join(root, ".env");
	try {
		let text = "";
		let mode = 0o600;
		if (fs.existsSync(envPath)) {
			text = fs.readFileSync(envPath, "utf8");
			mode = fs.statSync(envPath).mode & 0o777;
		}
		const next = upsert(text, name, value);
		writeFileAtomic(envPath, next.text, { mode });
		process.stdout.write(
			`write-secret: ${next.replaced ? "replaced" : "added"} ${name} in ${envPath}\n`,
		);
	} catch (e) {
		return refuse(
			`${envPath} could not be written (${caught(e).code ?? "error"}). Check it is a regular file you can write, then re-run.`,
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
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const { positionals } = parsed;
	const [name] = positionals;
	if (name === undefined)
		throw new Error("parse passed no <NAME> despite min: 1");
	if (!VAR_NAME.test(name)) {
		return refuse(
			"the argument is not a shell variable name (letters, digits and underscores, not starting with a digit). The value is asked for afterwards, never given on the command line.",
			2,
		);
	}

	const root = hostRoot();
	sweepAsides(root);
	const envPath = path.join(root, ".env");
	const tracked = isTracked(root, ".env");
	if (tracked === null) {
		return refuse(
			`git could not say whether ${envPath} is tracked, so the secret might be committed. Check git runs in ${root}, then re-run.`,
			1,
		);
	}
	if (tracked) {
		return refuse(
			`${envPath} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env) and ignore it first.`,
			1,
		);
	}
	if (fs.lstatSync(envPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
		return refuse(
			`${envPath} is a symlink, whose target git may track. Replace it with a regular file, then re-run.`,
			1,
		);
	}

	warnUnignored(root);

	if (!process.stdin.isTTY) return upsertEnv(root, name, readPiped(), false);
	process.stderr.write(`Value for ${name} (typing hidden, Enter to finish): `);
	return readHidden(process.stdin).then(
		(raw) => {
			process.stderr.write("\n");
			return upsertEnv(root, name, raw, true);
		},
		() => {
			process.stderr.write("\n");
			return refuse("interrupted. Re-run to enter the value.", 2);
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
