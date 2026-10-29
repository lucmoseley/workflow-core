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
 * git working tree, is a symlink, lies in a directory others can reach or
 * under one others can write, is not clean UTF-8, is held by another run too
 * long or its lock's path holds no file, holds a line assigning <NAME> it
 * cannot replace, or cannot be written; 2 bad arguments or a value no line
 * can carry. Every refusal leaves the file untouched, and one about
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
 * (#3539); git follows no symlinked `.gitignore`, so one is replaced
 * (#3663). Residual: ignore rules never reach a file such a repository
 * already tracks, nor an `add -f`; that file wants `git rm --cached` there.
 *
 * A DIRECTORY OTHERS CAN REACH IS REFUSED (#3539): the file's directory, and
 * the aside before its rename, must be the user's own with no group or other
 * access, checked before the prompt and again before the write. `mkdir`'s
 * mode applies only on creation and a mount without
 * `metadata` (WSL's `/mnt/c`) ignores `chmod`, so either can be left loose.
 *
 * A PARENT OTHERS CAN WRITE IS REFUSED (#3663): each directory above the
 * file's, along the path as given and along its real path, must be owned by
 * this user or root and writable by no one else, bar a sticky one (`/tmp`),
 * whose entries only their owner can move. Node holds no directory by
 * descriptor across a write (no `openat`), so the chain is checked instead.
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
 * nor is any argument but one well-formed name, as a stray one is most likely
 * the secret pasted in the wrong place (#3663). A name shaped as a token
 * `lib/token-shapes.js` knows (`ghp_…`, `sk-ant-…`) is refused the same way;
 * residual: a vendor it does not list passes as a name.
 *
 * A VALUE IS CLEAN UTF-8 WITH NO NUL, as the file must be: one holding a NUL,
 * piped bytes that are not UTF-8, or what a lossy decode leaves (U+FFFD, a
 * lone surrogate — the hidden prompt decodes leniently) is refused (#3663).
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
const { NotALock, pidLock } = require("./lib/pid-lock.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { HELP, parseOrCode } = require("./lib/cli-args");
const { readFdAll } = require("./lib/read-fd.js");
const { maskTokens } = require("./lib/token-shapes.js");
const {
	assignsAcrossBreak,
	ignoreStore,
	parseEnvLine,
	secretsFile,
	splitEnvLines,
} = require("./lib/env-file.js");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { readHidden } = require("./lib/read-hidden.js");
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
 * The refusal `file`'s directory earns, or null: it lies under a directory
 * others can write, in a git working tree, or exists and is reachable by
 * others. The parents come first, as the tree's walk throws on one it cannot
 * read.
 * @param {string} file
 * @returns {number | null}
 */
function dirRefusal(file) {
	const dir = path.dirname(file);
	const above = swappableAbove(dir);
	if (above !== null) {
		return refuse(
			file,
			`${above.dir}, above its directory, ${above.why}, so another user could swap the directory for one of theirs. Point XDG_CONFIG_HOME at a directory whose every parent is yours or root's and writable by no one else, then re-run.`,
			1,
		);
	}
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

/**
 * The first directory above `dir`, along its path as given or its real path,
 * that lets another user replace what it holds, and why; or null. A symlink
 * along the path as given, `dir` included, counts where another user owns it
 * (#3663).
 * @param {string} dir
 * @returns {{ dir: string, why: string } | null}
 */
function swappableAbove(dir) {
	const given = path.resolve(dir);
	let existing = given;
	while (!isDirectory(existing)) existing = path.dirname(existing);
	const real = path.join(
		fs.realpathSync(existing),
		path.relative(existing, given),
	);
	const link = foreignLink(given);
	if (link !== null)
		return { dir: link, why: "is a symlink owned by neither you nor root" };
	for (const leaf of new Set([given, real])) {
		for (let d = path.dirname(leaf); ; d = path.dirname(d)) {
			const why = swappableWhy(d);
			if (why !== null) return { dir: d, why };
			if (d === path.dirname(d)) break;
		}
	}
	return null;
}

/**
 * Why directory `d` lets another user replace its entries, or null.
 * @param {string} d
 * @returns {string | null}
 */
function swappableWhy(d) {
	let st;
	try {
		st = fs.statSync(d);
	} catch (e) {
		/* Not there yet, or a file where it goes: the write creates it under a
		 * parent checked here, or refuses naming the fault (#3663). Any other
		 * fault leaves it unjudged, so it refuses. */
		if (caught(e).code === "ENOENT" || caught(e).code === "ENOTDIR")
			return null;
		return `could not be checked (${caught(e).code ?? "error"})`;
	}
	if (!st.isDirectory()) return null;
	if (!ownedSafely(st)) return "is owned by neither you nor root";
	if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)
		return "is writable by others and not sticky";
	return null;
}

/**
 * The first symlink along `p` or above it that another user owns, or null.
 * @param {string} p
 * @returns {string | null}
 */
function foreignLink(p) {
	for (let d = p; ; d = path.dirname(d)) {
		const st = lstatOrNull(d);
		if (st?.isSymbolicLink() && !ownedSafely(st)) return d;
		if (d === path.dirname(d)) return null;
	}
}

/**
 * @param {string} p
 * @returns {fs.Stats | null}
 */
function lstatOrNull(p) {
	try {
		return fs.lstatSync(p);
	} catch {
		/* Absent, or unreadable: the stat that follows names which (#3663). */
		return null;
	}
}

/** @param {fs.Stats} st */
function ownedSafely(st) {
	return st.uid === process.getuid?.() || st.uid === 0;
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
 * The value from piped stdin, less one trailing line break; or null where its
 * bytes are not valid UTF-8.
 * @returns {string | null}
 * @throws where stdin cannot be read
 */
function readPiped() {
	const bytes = readFdAll(0);
	try {
		return UTF8.decode(bytes).replace(/\r?\n$/, "");
	} catch {
		/* The fatal decoder's only throw (#3663). */
		return null;
	}
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
 * @param {string | null} raw null where its bytes were not valid UTF-8
 * @param {boolean} fromTerminal whether `raw` was typed at the hidden prompt
 * @returns {number}
 */
function upsertEnv(file, name, raw, fromTerminal) {
	if (
		raw === null ||
		raw.includes("\0") ||
		raw.includes("\uFFFD") ||
		!raw.isWellFormed()
	) {
		return refuse(
			file,
			"the value is not valid UTF-8, or holds a NUL byte or U+FFFD, which the file could not carry intact. Re-run and give it as UTF-8 text.",
			2,
		);
	}
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
		ignoreStore(dir);

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
		if (e instanceof NotALock) {
			return refuse(
				file,
				`${file}.lock is not a regular file, so it is no lock any run can take. Remove it by hand, then re-run.`,
				1,
			);
		}
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
	/* Before the parser, whose refusals quote the argument (#3663). */
	const [only] = argv;
	if (
		argv.length !== 1 ||
		only === undefined ||
		!(VAR_NAME.test(only) || HELP.has(only)) ||
		maskTokens(only).count > 0
	) {
		const status = refuse(
			file,
			"it takes one argument, a shell variable name (letters, digits and underscores, not starting with a digit), and shows none it is given, as one may be the secret. The value is asked for afterwards, never given on the command line.",
			2,
		);
		process.stderr.write(`${USAGE}\n`);
		return status;
	}
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const [name] = parsed.positionals;
	if (name === undefined)
		throw new Error("parse passed no <NAME> despite min: 1");

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

	if (!process.stdin.isTTY) {
		let piped;
		try {
			piped = readPiped();
		} catch (e) {
			return refuse(
				file,
				`stdin could not be read (${caught(e).code ?? "error"}). Re-run in your own terminal.`,
				2,
			);
		}
		return upsertEnv(file, name, piped, false);
	}
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
