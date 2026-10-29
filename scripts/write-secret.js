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
 * (#3663). Under the WFC_SECRETS_FILE test override none is written, as the
 * reader writes none (#3715). Residual: ignore rules never reach a file such a repository
 * already tracks, nor an `add -f`; that file wants `git rm --cached` there.
 *
 * A DIRECTORY OTHERS CAN REACH IS REFUSED (#3539): the file's directory, and
 * the aside before its rename, must be the user's own with no group or other
 * access, checked before the prompt and again before the write. `mkdir`'s
 * mode applies only on creation, so it can be left loose.
 *
 * A PARENT OTHERS CAN WRITE IS REFUSED (#3663): each directory holding an
 * entry the path passes through as the kernel resolves it, every symlink's
 * hops included (#3715), must be owned by this user or root and writable by
 * no one else, bar a sticky one (`/tmp`), whose entries only their owner can
 * move; and each symlink met must be theirs or root's. Node holds no
 * directory by descriptor across a write (no `openat`), so the chain is
 * checked instead. Group write passes where the group is this user's private
 * one, as under `pam_umask usergroups` (#3676): their primary gid, under the
 * one `/etc/passwd` row naming them, listing no other member in `/etc/group`
 * and the primary gid of no other user, as Debian's OpenSSH StrictModes
 * allows; and where the directory carries no ACL, whose named entries the
 * group bits do not show, as GNU `ls` tells (#3715). Where lookups can reach
 * a source beyond those files (LDAP, sssd, NIS, a systemd-homed user, an
 * `initgroups` source) no group is judged private, so it refuses, as it does
 * a group with a password. On NFS, a parent or the file's directory carrying
 * any ACL GNU `ls` marks is refused, whatever its mode or sticky bit: an
 * NFSv4 ACL can grant another user access with no group or other bit set
 * (#3724). Residual: a group password or member set only in `/etc/gshadow`,
 * which the user cannot read; a process root starts under the gid, which no
 * database shows; and an ACL granting access no mode bit shows where `ls`
 * marks none: an NFSv4 ACL under an `ls` not GNU's, built without ACL
 * support, whose gnulib predates its NFSv4 reader or misses the ACL where
 * Linux 6.12+ NFS answers EACCES, or whose entries name only OWNER@, GROUP@
 * and EVERYONE@, which gnulib calls trivial whatever they grant.
 *
 * A MOUNT WHOSE SERVER DECIDES ACCESS IS REFUSED (#3726): the file's
 * directory, or a directory above it, on CIFS/SMB, 9p (WSL 2's drvfs, as
 * `/mnt/c`), WSL 1's wslfs, FUSE (sshfs, virtiofs), AFS, Coda or GPFS. Its
 * mode comes from mount options, is stored beside an ACL that decides, or is
 * ignored by the daemon, so another account may read or swap the file while
 * every mode check passes. A directory whose filesystem cannot be read is
 * refused too. Residual: a filesystem off that list whose server or ACL
 * decides access, as NFS (#3724 judges its ACL) or panfs.
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
 * piped bytes that are not UTF-8, or a U+FFFD or lone surrogate is refused
 * (#3663). The hidden prompt decodes strictly: typed bytes that are not UTF-8
 * get their own refusal naming that cause, never "interrupted" (#3675, #3708).
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

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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
	quoteValue,
	secretsFile,
	secretsOverride,
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
 * @param {string} why `looseWhy`'s or `remoteAccessWhy`'s reason
 * @param {string} [fix] the way out, where `chmod` is not it
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

/**
 * The refusal `file`'s directory earns, or null: it lies under a directory
 * others can write, in a git working tree, or exists and lies on a mount
 * whose server decides access or is reachable by others. The parents come
 * first, as the tree's walk throws on one it cannot read.
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
	const tree = findEnclosingTree(dir);
	if (tree !== null) {
		return refuse(
			file,
			`it lies in the git working tree at ${tree}, so a commit there could take it. Point XDG_CONFIG_HOME at a directory in no working tree, then re-run.`,
			1,
		);
	}
	if (!isDirectory(dir)) return null;
	const mount = remoteAccessWhy(dir);
	if (mount !== null) {
		return refuseLoose(
			file,
			`its directory ${dir}`,
			mount,
			"Point XDG_CONFIG_HOME at a directory on a local filesystem, then re-run.",
		);
	}
	const why = looseWhy(dir) ?? nfsAclWhy(dir);
	return why === null ? null : refuseLoose(file, `its directory ${dir}`, why);
}

/**
 * The first directory above `dir` that lets another user replace what it
 * holds, and why; or null. Every entry the path passes through as the kernel
 * resolves it, each symlink's own hops included, has its parent checked, and
 * each symlink met its owner too (#3663, #3715).
 * @param {string} dir
 * @returns {{ dir: string, why: string } | null}
 */
function swappableAbove(dir) {
	const checked = new Set();
	for (const hop of walkHops(path.resolve(dir))) {
		if ("why" in hop) return hop;
		if (hop.linkStat && !ownedSafely(hop.linkStat))
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

/** As Linux's MAXSYMLINKS, past which a resolve fails with ELOOP. */
const MAX_SYMLINKS = 40;

/** @typedef {{ dir: string, linkStat?: fs.Stats } | { dir: string, why: string }} Hop */

/**
 * Each entry absolute path `p` passes through, in the order a resolve meets
 * them: a symlink's target is walked in its place, `..` climbing from where
 * the walk has reached, so each entry's parent is an entry met before it or
 * the root. A symlink's entry carries its lstat. The walk stops at the first
 * entry that is absent, or that cannot be read, naming why.
 * @param {string} p
 * @returns {Hop[]}
 */
function walkHops(p) {
	/** @type {Hop[]} */
	const met = [];
	const todo = pathParts(p);
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
		todo.unshift(...pathParts(target));
		if (path.isAbsolute(target)) at = path.parse(target).root;
	}
	return met;
}

/**
 * The names `p` is made of, `..` kept and `.` dropped.
 * @param {string} p
 * @returns {string[]}
 */
function pathParts(p) {
	return p.split(path.sep).filter((n) => n !== "" && n !== ".");
}

/**
 * Entry `entry` as `walkHops` meets it: absent, a symlink and its target, any
 * other entry, or why it cannot be read.
 * @param {string} entry
 * @returns {{ why?: string, absent?: boolean, st?: fs.Stats, target?: string }}
 */
function readEntry(entry) {
	try {
		const st = fs.lstatSync(entry);
		return st.isSymbolicLink() ? { st, target: fs.readlinkSync(entry) } : {};
	} catch (e) {
		const code = caught(e).code;
		/* Absent, or a file where a directory goes: the write creates it under a
		 * parent checked here, or refuses naming the fault (#3663). */
		if (code === "ENOENT" || code === "ENOTDIR") return { absent: true };
		return { why: `could not be checked (${code ?? "error"})` };
	}
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
	/* Before the sticky pass, which such a server need not honour; nor need
	 * NFS, where an NFSv4 ACL can grant DELETE_CHILD over it (RFC 8881
	 * §6.2.1.3.2). */
	const mount = remoteAccessWhy(d);
	if (mount !== null) return mount;
	const aclWhy = nfsAclWhy(d);
	if (aclWhy !== null) return aclWhy;
	if ((st.mode & 0o1000) !== 0) return null;
	const othersWrite =
		(st.mode & 0o002) !== 0 ||
		((st.mode & 0o020) !== 0 && !(isPrivateGroup(st.gid) && !hasAcl(d)));
	if (othersWrite) return "is writable by others and not sticky";
	return null;
}

/** statfs's type for NFS of every version, Linux's NFS_SUPER_MAGIC. */
const NFS_MAGIC = 0x69_69;

/**
 * Why directory `d` may let another user in by an NFSv4 ACL, or null: it lies
 * on NFS and GNU `ls` marks an ACL on it, reading `system.nfs4_acl` as well
 * as POSIX's (#3724). Elsewhere a POSIX ACL is judged by the group bits, its
 * mask, so a read-only entry passes. Where `ls` is not GNU's, no ACL is seen,
 * so none is judged there.
 * @param {string} d
 * @returns {string | null}
 */
function nfsAclWhy(d) {
	if (!isOnNfs(d) || !isGnuLs() || isAclUnmarked(d)) return null;
	return "carries an ACL on NFS, where an NFSv4 entry can grant another user access no mode bit shows";
}

/** @param {string} d */
function isOnNfs(d) {
	try {
		return fs.statfsSync(d).type === NFS_MAGIC;
	} catch {
		/* Unjudged: an ACL `ls` marks then refuses (#3724). */
		return true;
	}
}

/**
 * statfs types whose server, daemon or ACL decides access, as Linux's magic.h
 * and coreutils' `stat -f` name them.
 */
const REMOTE_ACCESS_MOUNTS = new Map([
	[0xff_53_4d_42, "CIFS"],
	[0xfe_53_4d_42, "SMB2"],
	[0x01_02_19_97, "9p (WSL's drvfs)"],
	[0x53_46_48_46, "wslfs (WSL 1's drvfs)"],
	[0x65_73_55_46, "FUSE"],
	[0x53_46_41_4f, "AFS"],
	[0x6b_41_46_53, "AFS"],
	[0x73_75_72_45, "Coda"],
	[0x47_50_46_53, "GPFS"],
]);

/**
 * Why directory `d` may let another account in whatever its mode shows, or
 * null: it lies on a mount whose server or daemon decides access (#3726).
 * @param {string} d
 * @returns {string | null}
 */
function remoteAccessWhy(d) {
	let type;
	try {
		type = fs.statfsSync(d).type;
	} catch (e) {
		return `could not have its filesystem read (${caught(e).code ?? "error"})`;
	}
	/* Unsigned, as a 32-bit kernel's signed f_type would sign-extend CIFS's. */
	const kind = REMOTE_ACCESS_MOUNTS.get(type >>> 0);
	return kind === undefined
		? null
		: `lies on a ${kind} mount, whose server decides access whatever its mode shows`;
}

/**
 * Whether directory `d` may carry an ACL, as GNU `ls` marks by a `+` after the
 * mode: its group bits are then the ACL's mask, which a named user's entry
 * can grant write through whatever the owning group (#3715). Node reads no
 * extended attribute, and only GNU's `ls` is known to mark one, so where it
 * is not GNU's, is not root's own copy at a fixed path, or does not answer,
 * `d` is judged to carry one. Residual: a GNU `ls` built without ACL support
 * prints no `+`.
 * @param {string} d
 * @returns {boolean}
 */
function hasAcl(d) {
	return !isGnuLs() || !isAclUnmarked(d);
}

/** `isGnuLs`'s answer, asked once per run. @type {boolean | undefined} */
let gnuLs;

/** Where `ls` is run from, never PATH, which any directory on it can outrank. */
const LS_PATHS = ["/usr/bin/ls", "/bin/ls"];

/**
 * The first of LS_PATHS that root owns and no one else can write, or null.
 * @returns {string | null}
 */
function trustedLs() {
	for (const p of LS_PATHS) {
		let st;
		try {
			st = fs.statSync(p);
		} catch {
			/* Not at this path: the next is tried. */
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

/** Whether `ls` is GNU's, and so marks an ACL. */
function isGnuLs() {
	if (gnuLs !== undefined) return gnuLs;
	try {
		gnuLs = /^ls \(GNU coreutils\) /.test(ls("--version"));
	} catch {
		/* No trusted `ls` to ask: no ACL can be seen (#3715). */
		gnuLs = false;
	}
	return gnuLs;
}

/**
 * Whether GNU `ls -ldL` shows `d` with no `+` after its mode, a symlinked
 * config directory judged where it points.
 * @param {string} d
 */
function isAclUnmarked(d) {
	try {
		return /^d[-rwxsStT]{9}\.? /.test(ls("-ldL", "--", d));
	} catch {
		/* It failed on `d`: unjudged, so it refuses (#3715). */
		return false;
	}
}

/**
 * Whether `gid` is this user's private group: their primary gid in
 * `/etc/passwd`, under the one row naming them, with no other member in
 * `/etc/group` and no other user's primary gid (#3676, #3715). Only those two
 * files are read, so a host whose user and group lookups can reach another
 * source is judged to have none private.
 * @param {number} gid
 * @returns {boolean}
 */
function isPrivateGroup(gid) {
	const me = os.userInfo();
	if (gid !== me.gid || !filesAloneNameUsers()) return false;
	const groups = readDbRows("/etc/group", [2]);
	const users = readDbRows("/etc/passwd", [2, 3]);
	if (groups === null || users === null) return false;
	const rows = groups.filter((f) => Number(f[2]) === gid);
	const mine = users.filter((f) => Number(f[2]) === me.uid);
	const named = users.filter((f) => f[0] === me.username);
	return (
		named.length === 1 &&
		Number(named[0]?.[2]) === me.uid &&
		rows.length > 0 &&
		rows.every(
			([, password, , members]) =>
				NO_GROUP_PASSWORD.has(password ?? "") &&
				members?.split(",").every((m) => m === "" || m === me.username),
		) &&
		mine.length > 0 &&
		mine.every((f) => Number(f[3]) === gid) &&
		users.every((f) => Number(f[3]) !== gid || Number(f[2]) === me.uid)
	);
}

/** A group password field through which no one can `newgrp` in. */
const NO_GROUP_PASSWORD = new Set(["", "x", "!", "*"]);

/** systemd's userdb services that name no user beyond NSS's own files. */
const QUIET_USERDB = new Set([
	"io.systemd.DropIn",
	"io.systemd.DynamicUser",
	"io.systemd.Multiplexer",
	"io.systemd.NameServiceSwitch",
]);

/**
 * Whether `/etc/passwd` and `/etc/group` are the only sources of users and
 * group members: `nsswitch.conf` names only `files` for each, and for
 * `initgroups` where it is named, or `systemd` too where no userdb record or
 * service beyond dynamic users exists. Any line glibc could read as one of
 * those databases must be in the plain `<db>: <sources>` form, so no looser
 * spelling outranks the one read. A directory service (LDAP, sssd), NIS or a
 * systemd-homed user could hold a member these files never show, and
 * `initgroups` sets each login's groups apart from `group` (#3676, #3715).
 * @returns {boolean}
 */
function filesAloneNameUsers() {
	const conf = readLines("/etc/nsswitch.conf");
	if (conf === null) return false;
	const dbs = "passwd|group|initgroups";
	const lines = conf
		.map((l) => l.replace(/#.*/, ""))
		.filter((l) =>
			new RegExp(`^(${dbs})$`).test(l.trim().split(/[\s:]/)[0] ?? ""),
		);
	const parsed = lines.map((l) => new RegExp(`^(${dbs}):([^\\\\]*)$`).exec(l));
	const sources = parsed.flatMap((m) => m?.[2]?.trim().split(/\s+/) ?? []);
	const named = new Set(parsed.map((m) => m?.[1]));
	if (
		parsed.some((m) => m === null) ||
		!named.has("passwd") ||
		!named.has("group") ||
		sources.some((x) => x !== "files" && x !== "systemd")
	)
		return false;
	if (!sources.includes("systemd")) return true;
	const dropIns = [
		"/etc/userdb",
		"/run/userdb",
		"/run/host/userdb",
		"/usr/local/lib/userdb",
		"/usr/lib/userdb",
	];
	return (
		dropIns.every((d) => dirEntries(d)?.length === 0) &&
		dirEntries("/run/systemd/userdb")?.every((e) => QUIET_USERDB.has(e)) ===
			true
	);
}

/**
 * The names in directory `d`: none where it is absent, null where it cannot
 * be read.
 * @param {string} d
 * @returns {string[] | null}
 */
function dirEntries(d) {
	try {
		return fs.readdirSync(d);
	} catch (e) {
		/* Absent holds no record; any other fault leaves it unjudged. */
		return caught(e).code === "ENOENT" ? [] : null;
	}
}

/**
 * The colon-split rows of an `/etc` database, or null where it cannot be read,
 * holds a NIS compat row (`+`, `-`), whose entries live elsewhere, a row led
 * by whitespace, whose name glibc reads with it stripped (#3715), or a row
 * whose field at an index in `ids` is not a plain decimal id, which glibc's
 * parse could read as another.
 * @param {string} file
 * @param {number[]} ids
 * @returns {string[][] | null}
 */
function readDbRows(file, ids) {
	const lines = readLines(file);
	if (lines === null || lines.some((l) => /^[+\-\s]/.test(l))) return null;
	const rows = lines.map((l) => l.split(":"));
	const plain = rows.every((f) => ids.every((i) => /^\d+$/.test(f[i] ?? "")));
	return plain ? rows : null;
}

/**
 * The lines of `file` less blank ones and those glibc skips as comments, or
 * null where it cannot be read.
 * @param {string} file
 * @returns {string[] | null}
 */
function readLines(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
	} catch {
		/* Unreadable: no group is judged private, so the parent refuses. */
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
		if (secretsOverride() === null) ignoreStore(dir);

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
