#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { asidePid, writeFileAtomic } = require("./lib/atomic-write.js");
const {
	LOCK_WAIT_MS,
	NotALock,
	pidLock,
	waitForLock,
} = require("./lib/pid-lock.js");
const { HELP, parseOrCode } = require("./lib/cli-args");
const { isPrivateGroup, USERDB_DIRS } = require("./lib/private-group.js");
const { readFdAll } = require("./lib/read-fd.js");
const { writeFd } = require("./lib/write-fd.js");
const { maskTokens } = require("./lib/token-shapes.js");
const {
	assignsAcrossBreak,
	decodeSecrets,
	ignoreStore,
	NotRegularFile,
	parseEnvLine,
	quoteValue,
	readRegularFile,
	RESAVE_UTF8,
	secretsFile,
	secretsOverride,
	splitEnvLines,
	UTF8,
} = require("./lib/env-file.js");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { readHidden } = require("./lib/read-hidden.js");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { SHELL_VAR_NAME } = require("./lib/shell-var-name.js");

const VAR_NAME = new RegExp(`^${SHELL_VAR_NAME}$`);

// #3904 guess: 8, a margin over the hyphen-free labels RFC 7468 and OpenSSL write
const PEM_HEADER = /^-{4,5} ?BEGIN [^-]*(?:-[^-]+){0,8}-{4,5}$/;

const USAGE = `usage: write-secret.js <NAME>
  <NAME>  a shell variable name; the value is then asked for with typing hidden`;

/**
 * @param {string} file
 * @param {string} why
 * @param {number} status
 * @returns {number}
 */
function refuse(file, why, status) {
	writeFd(2, `write-secret: refused, ${file} untouched — ${why}\n`);
	return status;
}

/**
 * @param {string} file
 * @param {string} what
 * @param {string} why
 * @param {string} [fix]
 * @returns {number}
 */
function refuseLoose(file, what, why, fix) {
	const dir = path.dirname(file);
	return refuse(
		file,
		`${what} ${why}, so another user could read or swap the file. ${fix ?? `Make ${dir} yours with no access for anyone else (\`chmod 700\`), on a filesystem that keeps modes, then re-run.`}`,
		1,
	);
}

const USE_LOCAL_FS =
	"Point XDG_CONFIG_HOME at a directory on a local filesystem, then re-run.";

/**
 * @param {string} file
 * @returns {number | null}
 */
function dirRefusal(file) {
	const dir = path.dirname(file);
	const above = swappableAbove(dir);
	if (above !== null) {
		return refuse(
			file,
			`${above.dir}, above its directory, ${above.why}, so another user could swap the directory for one of theirs. Point XDG_CONFIG_HOME at a directory on a local filesystem whose every parent is yours or root's and writable by no one else, then re-run.`,
			1,
		);
	}
	const isDir = isDirectory(dir);
	const decided = isDir ? mountAccessWhy(dir) : null;
	if (decided !== null) {
		return refuseLoose(file, `its directory ${dir}`, decided, USE_LOCAL_FS);
	}
	const denied = searchFaultCode(dir);
	if (denied !== null) {
		return refuse(
			file,
			`its directory ${dir} cannot be searched (${denied}), so no file in it can be read or written. Give yourself access (\`chmod 700 ${dir}\`), then re-run.`,
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
	if (!isDir) return null;
	const loose = looseWhy(dir);
	return loose === null
		? null
		: refuseLoose(file, `its directory ${dir}`, loose);
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function searchFaultCode(dir) {
	try {
		fs.accessSync(dir, fs.constants.X_OK);
		return null;
	} catch (e) {
		return isAbsentFault(e) ? null : (caught(e).code ?? "error");
	}
}

/**
 * @param {string} dir
 * @returns {{ dir: string, why: string } | null}
 */
function swappableAbove(dir) {
	const checked = new Set();
	for (const hop of walkHops(path.resolve(dir))) {
		if ("why" in hop) return hop;
		if (hop.linkStat && !isOwnedByMeOrRoot(hop.linkStat))
			return {
				dir: hop.dir,
				why: "is a symlink owned by neither you nor root",
			};
		const parent = path.dirname(hop.dir);
		if (checked.has(parent)) continue;
		checked.add(parent);
		const why = swappableWhy(parent);
		if (why !== null) return { dir: parent, why };
	}
	return null;
}

// Linux follows at most 40 symlinks in one resolve, then fails ELOOP:
// https://man7.org/linux/man-pages/man7/path_resolution.7.html
const MAX_SYMLINKS = 40;

/** @typedef {{ dir: string, linkStat?: fs.Stats } | { dir: string, why: string }} Hop */

/**
 * @param {string} p
 * @returns {Hop[]}
 */
function walkHops(p) {
	/** @type {Hop[]} */
	const met = [];
	const todo = parsePathParts(p);
	let at = path.parse(p).root;
	let links = 0;
	for (let name = todo.shift(); name !== undefined; name = todo.shift()) {
		if (name === "..") {
			at = path.dirname(at);
			continue;
		}
		const entry = path.join(at, name);
		const { why, absent, st, target } = readEntry(entry);
		if (why !== undefined) return [...met, { dir: entry, why }];
		met.push(st === undefined ? { dir: entry } : { dir: entry, linkStat: st });
		if (absent) return met;
		if (target === undefined) {
			at = entry;
			continue;
		}
		if (++links > MAX_SYMLINKS)
			return [...met, { dir: entry, why: "could not be checked (ELOOP)" }];
		todo.unshift(...parsePathParts(target));
		if (path.isAbsolute(target)) at = path.parse(target).root;
	}
	return met;
}

/**
 * @param {string} p
 * @returns {string[]}
 */
function parsePathParts(p) {
	return p.split(path.sep).filter((n) => n !== "" && n !== ".");
}

/**
 * @param {string} entry
 * @returns {{ why?: string, absent?: boolean, st?: fs.Stats, target?: string }}
 */
function readEntry(entry) {
	try {
		const st = fs.lstatSync(entry);
		return st.isSymbolicLink() ? { st, target: fs.readlinkSync(entry) } : {};
	} catch (e) {
		return isAbsentFault(e) ? { absent: true } : { why: uncheckedWhy(e) };
	}
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isAbsentFault(e) {
	const { code } = caught(e);
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function uncheckedWhy(e) {
	return `could not be checked (${caught(e).code ?? "error"})`;
}

/**
 * @param {string} d
 * @returns {string | null}
 */
function swappableWhy(d) {
	let st;
	try {
		st = fs.statSync(d);
	} catch (e) {
		return isAbsentFault(e) ? null : uncheckedWhy(e);
	}
	if (!st.isDirectory()) return null;
	if (!isOwnedByMeOrRoot(st)) return "is owned by neither you nor root";
	const mount = mountAccessWhy(d);
	if (mount !== null) return mount;
	if ((st.mode & 0o1000) !== 0) return null;
	const othersWrite =
		(st.mode & 0o002) !== 0 ||
		((st.mode & 0o020) !== 0 &&
			!(isPrivateGroup(st.gid, os.userInfo(), readUserDb()) && !hasAcl(d)));
	if (othersWrite) return "is writable by others and not sticky";
	return null;
}

const NFS_SUPER_MAGIC = 0x69_69;

// https://github.com/torvalds/linux/blob/master/include/uapi/linux/magic.h
const CIFS_SUPER_MAGIC = 0xff_53_4d_42;
const SMB2_SUPER_MAGIC = 0xfe_53_4d_42;
const V9FS_MAGIC = 0x01_02_19_97;
const FUSE_SUPER_MAGIC = 0x65_73_55_46;
const AFS_SUPER_MAGIC = 0x53_46_41_4f;
const AFS_FS_MAGIC = 0x6b_41_46_53;
const CODA_SUPER_MAGIC = 0x73_75_72_45;

const REMOTE_ACCESS_MOUNTS = new Map([
	[CIFS_SUPER_MAGIC, "CIFS"],
	[SMB2_SUPER_MAGIC, "SMB2"],
	[V9FS_MAGIC, "9p (WSL's drvfs)"],
	// https://devblogs.microsoft.com/commandline/wsl-adds-inotify-filesystem-change-notification-support/
	[0x53_46_48_46, "wslfs (WSL 1's drvfs)"],
	[FUSE_SUPER_MAGIC, "FUSE"],
	[AFS_SUPER_MAGIC, "AFS"],
	[AFS_FS_MAGIC, "AFS"],
	[CODA_SUPER_MAGIC, "Coda"],
	// https://www.ibm.com/docs/en/storage-scale/6.0.1?topic=cga-determining-if-file-system-is-controlled-by-gpfs
	[0x47_50_46_53, "GPFS"],
]);

/**
 * @param {string} d
 * @returns {string | null}
 */
function mountAccessWhy(d) {
	let type;
	try {
		type = fs.statfsSync(d).type;
	} catch (e) {
		return `could not have its filesystem read (${caught(e).code ?? "error"})`;
	}
	const kind = REMOTE_ACCESS_MOUNTS.get(type >>> 0);
	if (kind !== undefined)
		return `lies on a ${kind} mount, whose server decides access whatever its mode shows`;
	if (type !== NFS_SUPER_MAGIC || !isAclMarkingLs() || isAclUnmarked(d))
		return null;
	return "carries an ACL on NFS, where an NFSv4 entry can grant another user access no mode bit shows";
}

/**
 * @param {string} d
 * @returns {boolean}
 */
function hasAcl(d) {
	return !isAclMarkingLs() || !isAclUnmarked(d);
}

/** @type {boolean | undefined} */
let marksAcl;

const LS_PATHS = ["/usr/bin/ls", "/bin/ls"];

/** @returns {string | null} */
function trustedLs() {
	for (const p of LS_PATHS) {
		let st;
		try {
			st = fs.statSync(p);
		} catch {
			continue;
		}
		if (st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0) return p;
	}
	return null;
}

/** @param {string[]} args */
function ls(...args) {
	const bin = trustedLs();
	if (bin === null) throw new Error("no root-owned ls at a fixed path");
	return execFileSync(bin, args, {
		encoding: "utf8",
		env: { LC_ALL: "C" },
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function isAclMarkingLs() {
	if (marksAcl !== undefined) return marksAcl;
	try {
		const version = ls("--version");
		const [, major, minor, patch] =
			/^ls \(uutils coreutils\) (\d+)\.(\d+)\.(\d+)/.exec(version) ?? [];
		marksAcl =
			/^ls \(GNU coreutils\) /.test(version) ||
			(patch !== undefined &&
				(Number(major) > 0 || Number(minor) > 0 || Number(patch) >= 24));
	} catch {
		marksAcl = false;
	}
	return marksAcl;
}

/** @param {string} d */
function isAclUnmarked(d) {
	try {
		// uutils' `ls -L` read a link's own attributes until https://github.com/uutils/coreutils/pull/13368
		return /^d[-rwxsStT]{9}\.? /.test(ls("-ld", "--", fs.realpathSync(d)));
	} catch {
		return false;
	}
}

/** @returns {import("./lib/private-group.js").UserDb} */
function readUserDb() {
	return {
		passwd: readText("/etc/passwd"),
		group: readText("/etc/group"),
		nsswitch: readText("/etc/nsswitch.conf"),
		userdb: Object.fromEntries(USERDB_DIRS.map((d) => [d, readDirEntries(d)])),
	};
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * @param {string} d
 * @returns {string[] | null}
 */
function readDirEntries(d) {
	try {
		return fs.readdirSync(d);
	} catch (e) {
		return caught(e).code === "ENOENT" ? [] : null;
	}
}

/** @param {fs.Stats} st */
function isOwnedByMeOrRoot(st) {
	return st.uid === process.getuid?.() || st.uid === 0;
}

class LooseAside extends Error {}

/**
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

/**
 * @param {string} p
 * @returns {string | null}
 */
function looseWhy(p) {
	const st = fs.statSync(p);
	if (st.uid !== process.getuid?.()) return "is not owned by you";
	if ((st.mode & 0o077) !== 0) return "gives access to others";
	return null;
}

/**
 * @param {string} file
 * @returns {{ text: string } | { why: string }}
 */
function readSecrets(file) {
	let bytes;
	try {
		bytes = readRegularFile(file, fs.constants.O_NOFOLLOW);
	} catch (e) {
		if (e instanceof NotRegularFile) {
			return {
				why: "it is no regular file (a FIFO, socket, device or directory), so it can hold no secrets. Remove it, then re-run.",
			};
		}
		if (caught(e).code === "ENOENT") return { text: "" };
		throw e;
	}
	const decoded = decodeSecrets(bytes);
	if (!("fault" in decoded)) return decoded;
	return {
		why:
			decoded.fault === "utf16"
				? `it opens with a UTF-16 mark or holds a NUL byte, so it looks saved as UTF-16 (Notepad's "Unicode"), which a rewrite would mangle. ${RESAVE_UTF8}`
				: `it holds bytes that are not valid UTF-8, which a rewrite would replace with U+FFFD. ${RESAVE_UTF8}`,
	};
}

/**
 * @param {string} file
 * @returns {number | null}
 */
function encodingRefusal(file) {
	try {
		const read = readSecrets(file);
		return "why" in read ? refuse(file, read.why, 1) : null;
	} catch {
		return null;
	}
}

const LEFT = "a copy of the secrets file an earlier interrupted write left";

/** @param {string} file */
function sweepAsides(file) {
	const dir = path.dirname(file);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		if (isAbsentFault(e)) return;
		writeFd(
			2,
			`write-secret: warning — ${dir} could not be listed (${caught(e).code ?? "error"}), so ${LEFT} may remain there. Look for ${path.basename(file)}.*.tmp by hand.\n`,
		);
		return;
	}
	if (searchFaultCode(dir) !== null) return;
	for (const name of names) {
		const pid = asidePid(path.basename(file), name);
		if (pid !== null) sweepAside(path.join(dir, name), pid);
	}
}

/**
 * @param {string} aside
 * @param {number} pid
 */
function sweepAside(aside, pid) {
	if (!fs.lstatSync(aside, { throwIfNoEntry: false })?.isFile()) return;
	if (pidAlive(pid)) {
		writeFd(
			2,
			`write-secret: left ${aside}, a copy of the secrets file: its pid ${pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
		);
		return;
	}
	try {
		fs.rmSync(aside);
		writeFd(2, `write-secret: removed ${aside}, ${LEFT}.\n`);
	} catch (e) {
		writeFd(
			2,
			`write-secret: warning — ${aside}, ${LEFT}, could not be removed (${caught(e).code ?? "error"}). Delete it by hand.\n`,
		);
	}
}

/** @returns {string | null} */
function readPiped() {
	const bytes = readFdAll(0);
	try {
		return UTF8.decode(bytes).replace(/\r?\n$/, "");
	} catch {
		return null;
	}
}

/**
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
 * @param {string} file
 * @param {string} name
 * @param {string | null} raw
 * @param {boolean} fromTerminal
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
	if (PEM_HEADER.test(trimmed)) {
		return refuse(
			file,
			"the value is only the first line of a PEM key, which one line cannot carry. Re-run and give the whole key base64-encoded onto one line.",
			2,
		);
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
 * @param {string} file
 * @returns {number | null}
 */
function ignoreRefusal(file) {
	const dir = path.dirname(file);
	try {
		ignoreStore(dir);
		return null;
	} catch (e) {
		return refuse(
			file,
			`${path.join(dir, ".gitignore")} could not be made to hold \`*\` (${caught(e).code ?? "error"}), so a bare dotfiles repository's \`add\` could take the file. Replace it with a regular file, then re-run.`,
			1,
		);
	}
}

/**
 * @param {string} file
 * @param {string} name
 * @param {string} value
 * @returns {number}
 */
function storeValue(file, name, value) {
	const dir = path.dirname(file);
	const lock = pidLock(`${file}.lock`, path.basename(__filename));
	let locked = false;
	let replaced = false;
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
		// #3539
		const refused = dirRefusal(file);
		if (refused !== null) return refused;
		const unignored = secretsOverride() === null ? ignoreRefusal(file) : null;
		if (unignored !== null) return unignored;

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
		replaced = next.replaced;
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
	reportStored(file, name, replaced);
	return 0;
}

/**
 * @param {string} file
 * @param {string} name
 * @param {boolean} replaced
 */
function reportStored(file, name, replaced) {
	try {
		writeFd(
			1,
			`write-secret: ${replaced ? "replaced" : "added"} ${name} in ${file}\n`,
		);
	} catch (e) {
		ignoreFailure(() =>
			writeFd(
				2,
				`write-secret: ${name} is stored in ${file}, but its success line could not be printed (${caught(e).code ?? "error"}).\n`,
			),
		);
	}
}

/**
 * @param {string[]} argv
 * @returns {number | Promise<number>}
 */
function main(argv) {
	const file = secretsFile();
	const [only] = argv;
	// #3663
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
		writeFd(2, `${USAGE}\n`);
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
	writeFd(2, `Value for ${name} (typing hidden, Enter to finish): `);
	return readHidden(process.stdin).then(
		(raw) => {
			writeFd(2, "\n");
			return upsertEnv(file, name, raw, true);
		},
		(e) => {
			try {
				writeFd(2, "\n");
				return refuse(file, caught(e).message, 2);
			} catch (w) {
				if (caught(w).code !== "EIO") throw w;
				return 2;
			}
		},
	);
}

module.exports = { main };

if (require.main === module) {
	const status = main(process.argv.slice(2));
	if (typeof status === "number") process.exitCode = status;
	else
		status.then(
			(s) => {
				process.exitCode = s;
			},
			(e) => {
				writeFd(2, `write-secret: ${e}\n`);
				process.exitCode = 1;
			},
		);
}
