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
 * open instead (#2554). The typed bytes are decoded as strict UTF-8: any that
 * are not valid UTF-8 are refused, never stored as U+FFFD (#3675).
 *
 * TARGET: `lib/env-file.js`'s secrets file, outside every working tree, so a
 * stray relative `.env` write in any checkout cannot destroy it (#3202). Its
 * directory is created owner-only.
 *
 * NO FAMILY (§N3), as `grant-permission.js`: 0 written; 1 the file sits in a
 * git working tree, is a symlink, lies in a directory others can reach, is
 * not clean UTF-8, is held by another run too long, holds a line assigning
 * <NAME> it cannot replace, or cannot be written; 2 bad arguments or a value
 * no line can carry. Every refusal leaves the file untouched, and one about
 * the file itself comes before the value is asked for, bar that line, which
 * is read only under the lock, and a fault reading or writing it, met at the
 * write.
 *
 * IN A WORKING TREE IS REFUSED (#3202): a `.git` in the file's directory or
 * any above it, as where XDG_CONFIG_HOME names a checkout or the home directory is a
 * dotfiles repository, means a commit there could take it. It is checked
 * before the prompt and again under the lock just before the write, so a
 * `git init` while the value is typed is caught (#3539).
 *
 * A BARE REPOSITORY whose work tree is set elsewhere, as a bare dotfiles setup
 * (`git --git-dir=~/.cfg --work-tree=~`, yadm), has no `.git` to find. The
 * directory's own `.gitignore`, holding `*`, keeps the file out of its `add`
 * (#3539). Residual: ignore rules never reach a file such a repository
 * already tracks, nor an `add -f`; that file wants `git rm --cached` there.
 *
 * A DIRECTORY OTHERS CAN REACH IS REFUSED (#3539): the file's directory, and
 * the aside before its rename, must be the user's own with no group or other
 * access, checked before the prompt and again before the write. `mkdir`'s
 * mode applies only on creation and a mount without
 * `metadata` (WSL's `/mnt/c`) ignores `chmod`, so either can be left loose.
 *
 * CONCURRENT RUNS take turns by `lib/pid-lock.js`'s lock, `secrets.env.lock`,
 * held from the read to the rename, so no run's key is lost to another's
 * rename (#3539). A lock whose run is gone is taken over.
 *
 * A SYMLINK IS REFUSED: its target may lie in a working tree (#640 review).
 *
 * A FILE NOT CLEAN UTF-8 IS REFUSED (#3550): a lossy decode would write each
 * bad byte back as U+FFFD, so a UTF-16 file (Notepad's "Unicode") or a
 * Latin-1 value stored by hand would be mangled. A NUL byte, which no .env
 * line carries, is read as UTF-16 too: without its mark, ASCII in UTF-16 is
 * valid UTF-8 whose lines no reader parses, so a rotated key's old value
 * would stay. Checked before the prompt and again under the lock.
 *
 * NOTHING OF THE VALUE IS PRINTED — not it, its length or any part of it — and
 * nor is a malformed name, which is most likely the secret pasted in the
 * wrong place.
 *
 * THE UPSERT replaces the value on every line `lib/env-file.js`'s grammar
 * reads as assigning <NAME> (`NAME=`, `export NAME =`), keeping that line's
 * prefix and CRLF ending; with none, it appends `NAME=value`. Every other
 * byte, a leading BOM and whether the file ends in a newline are kept. It
 * lands by rename, owner-only. A line assigning <NAME> across a mid-line
 * break is refused (#3542).
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
 * its rename then fails and it refuses.
 *
 * NO FILE CLAIM (spec #525's ruling for `grant-permission.js`): the file is in
 * no repository, and the founder's paste has no session to claim with.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { asidePid, writeFileAtomic } = require("./lib/atomic-write.js");
const { pidLock } = require("./lib/pid-lock.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { parseOrCode } = require("./lib/cli-args");
const {
	assignsAcrossBreak,
	parseEnvLine,
	quoteValue,
	secretsFile,
	splitEnvLines,
} = require("./lib/env-file.js");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { NOT_UTF8, readHidden } = require("./lib/read-hidden.js");
const { caught } = require("./lib/caught.js");
const { SHELL_VAR_NAME } = require("./lib/shell-var-name.js");

const VAR_NAME = new RegExp(`^${SHELL_VAR_NAME}$`);

/* First guesses, and stated as ones: a write holds the lock for milliseconds,
 * so a run waits 10 s for another's before refusing, polling every 20 ms. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

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
 * @param {string} file
 * @param {string} what the directory or file found loose
 * @param {string} why `looseWhy`'s reason
 * @returns {number}
 */
function refuseLoose(file, what, why) {
	const dir = path.dirname(file);
	return refuse(
		file,
		`${what} ${why}, so another user could read or swap the file. Make ${dir} yours with no access for anyone else (\`chmod 700\`), on a filesystem that keeps modes (not a Windows drive under WSL), then re-run.`,
		1,
	);
}

/**
 * The refusal `file`'s directory earns, or null: it lies in a git working
 * tree, or exists and is reachable by others.
 * @param {string} file
 * @returns {number | null}
 */
function dirRefusal(file) {
	const dir = path.dirname(file);
	const tree = findEnclosingTree(dir);
	if (tree !== null) {
		return refuse(
			file,
			`it lies in the git working tree at ${tree}, so a commit there could take it. Point XDG_CONFIG_HOME at a directory in no working tree, then re-run.`,
			1,
		);
	}
	if (!isDirectory(dir)) return null;
	const why = looseWhy(dir);
	return why === null ? null : refuseLoose(file, `its directory ${dir}`, why);
}

/** Thrown before the rename where the aside is reachable by others. */
class LooseAside extends Error {}

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
		/* An absent file is no symlink, and any other fault meets the write,
		 * which refuses naming it (#640, #3539). */
		return false;
	}
}

/** @param {string} p */
function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		/* A path that is absent or unreadable is no directory to look in: the
		 * walk climbs past it, and the write refuses where it cannot be made
		 * (#3202, #3539). */
		return false;
	}
}

/**
 * Why `p` is reachable by someone other than this user, or null where it is
 * not. stat, not lstat: a symlinked config directory is judged where it
 * points.
 * @param {string} p
 * @returns {string | null}
 */
function looseWhy(p) {
	const st = fs.statSync(p);
	if (st.uid !== process.getuid?.()) return "is not owned by you";
	if ((st.mode & 0o077) !== 0) return "gives access to others";
	return null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * `file`'s text, empty where it is absent; or, where its bytes are not clean
 * UTF-8, why not.
 * @param {string} file
 * @returns {{ text: string } | { why: string }}
 */
function readSecrets(file) {
	if (!fs.existsSync(file)) return { text: "" };
	const bytes = fs.readFileSync(file);
	const resave = "Re-save it as UTF-8, then re-run.";
	if (
		(bytes[0] === 0xff && bytes[1] === 0xfe) ||
		(bytes[0] === 0xfe && bytes[1] === 0xff) ||
		bytes.includes(0)
	) {
		return {
			why: `it opens with a UTF-16 mark or holds a NUL byte, so it looks saved as UTF-16 (Notepad's "Unicode"), which a rewrite would mangle. ${resave}`,
		};
	}
	try {
		return { text: UTF8.decode(bytes) };
	} catch {
		return {
			why: `it holds bytes that are not valid UTF-8, which a rewrite would replace with U+FFFD. ${resave}`,
		};
	}
}

/**
 * The refusal `file`'s encoding earns before the prompt, or null.
 * @param {string} file
 * @returns {number | null}
 */
function encodingRefusal(file) {
	try {
		const read = readSecrets(file);
		return "why" in read ? refuse(file, read.why, 1) : null;
	} catch {
		/* Residual (#3550): a file that cannot be read is refused at the write,
		 * naming its fault, so only after the value is typed. */
		return null;
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
		/* No directory yet, so no aside, and the write creates it; or a file
		 * where it goes, and the write refuses. */
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
 * `text` with <name>'s value replaced on every line assigning it, or the
 * assignment appended; or, where a line assigns it across a break the
 * grammar cannot read, that line's number.
 * @param {string} text
 * @param {string} name
 * @param {string} value
 * @returns {{ text: string, replaced: boolean } | { brokenLine: number }}
 */
function upsert(text, name, value) {
	const { bom, lines } = splitEnvLines(text);
	const broken = lines.findIndex(({ body }) => assignsAcrossBreak(body, name));
	if (broken !== -1) return { brokenLine: broken + 1 };
	let replaced = false;
	const next = lines.map(({ body, cr }) => {
		const assignment = parseEnvLine(body);
		if (assignment?.name !== name) return body + cr;
		replaced = true;
		return `${assignment.prefix}${value}${cr}`;
	});
	if (replaced) return { text: bom + next.join("\n"), replaced };
	if (text === bom) return { text: `${bom}${name}=${value}\n`, replaced };
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
	const trimmed = raw.trim();
	if (trimmed === "") {
		return refuse(file, emptyWhy(name, hostRoot(), fromTerminal), 2);
	}
	if (parseEnvLine(`${name}=${trimmed}`)?.raw !== trimmed) {
		return refuse(
			file,
			"the value holds a line break (CR, LF, U+2028 or U+2029), which one line cannot carry. Re-run and give it on one line.",
			2,
		);
	}
	const value = quoteValue(trimmed);
	if (value === null) {
		return refuse(
			file,
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
			2,
		);
	}
	return storeValue(file, name, value);
}

/**
 * Writes `<dir>/.gitignore` holding `*`, where it holds anything else.
 * @param {string} dir
 */
function ignoreAll(dir) {
	const ignore = path.join(dir, ".gitignore");
	if (!fs.existsSync(ignore) || fs.readFileSync(ignore, "utf8") !== "*\n")
		writeFileAtomic(ignore, "*\n", { mode: 0o600 });
}

/**
 * Takes `lock`, waiting up to LOCK_WAIT_MS for a live holder.
 * @param {ReturnType<typeof pidLock>} lock
 * @returns {boolean} whether it is held
 */
function waitForLock(lock) {
	const deadline = performance.now() + LOCK_WAIT_MS;
	while (!lock.acquire()) {
		if (performance.now() > deadline) return false;
		sleepSync(LOCK_POLL_MS);
	}
	return true;
}

/**
 * Upserts the checked value into `file` under the lock, once its directory is
 * created and checked.
 * @param {string} file
 * @param {string} name
 * @param {string} value as the line carries it
 * @returns {number}
 */
function storeValue(file, name, value) {
	const dir = path.dirname(file);
	const lock = pidLock(`${file}.lock`, path.basename(__filename));
	let locked = false;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		locked = waitForLock(lock);
		if (!locked) {
			return refuse(
				file,
				`another write-secret run (pid ${lock.holder() ?? "unknown"}) has held ${file}.lock for ${LOCK_WAIT_MS / 1000}s. Re-run once it finishes.`,
				1,
			);
		}
		/* Again under the lock, just before the write: the prompt and the wait
		 * leave time for a `git init` or a `chmod` above the file. */
		const refused = dirRefusal(file);
		if (refused !== null) return refused;
		ignoreAll(dir);

		const read = readSecrets(file);
		if ("why" in read) return refuse(file, read.why, 1);
		const next = upsert(read.text, name, value);
		if ("brokenLine" in next) {
			return refuse(
				file,
				`line ${next.brokenLine} assigns ${name} across a line break (CR, U+2028 or U+2029) that no reader reads past, so its old value would stay in the file. Fix that line by hand, then re-run.`,
				1,
			);
		}
		writeFileAtomic(file, next.text, {
			mode: 0o600,
			beforeRename(aside) {
				const why = looseWhy(aside);
				if (why !== null) throw new LooseAside(why);
			},
		});
		process.stdout.write(
			`write-secret: ${next.replaced ? "replaced" : "added"} ${name} in ${file}\n`,
		);
	} catch (e) {
		if (e instanceof LooseAside)
			return refuseLoose(file, "the file as written", e.message);
		return refuse(
			file,
			`it could not be written (${caught(e).code ?? "error"}). Check it is a regular file you can write, then re-run.`,
			1,
		);
	} finally {
		if (locked) lock.release();
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
	const refused = dirRefusal(file);
	if (refused !== null) return refused;
	if (isSymlink(file)) {
		return refuse(
			file,
			"it is a symlink, whose target may lie in a working tree. Replace it with a regular file, then re-run.",
			1,
		);
	}
	const unclean = encodingRefusal(file);
	if (unclean !== null) return unclean;

	if (!process.stdin.isTTY) return upsertEnv(file, name, readPiped(), false);
	process.stderr.write(`Value for ${name} (typing hidden, Enter to finish): `);
	return readHidden(process.stdin).then(
		(raw) => {
			process.stderr.write("\n");
			return upsertEnv(file, name, raw, true);
		},
		(e) => {
			process.stderr.write("\n");
			if (caught(e).message === NOT_UTF8)
				return refuse(
					file,
					"the typed value holds bytes that are not valid UTF-8, as a terminal set to another encoding sends. Set the terminal to UTF-8, then re-run.",
					2,
				);
			return refuse(file, "interrupted. Re-run to enter the value.", 2);
		},
	);
}

module.exports = { main };

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
