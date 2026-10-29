/*
 * private-group.js — whether a group is the user's private one, judged from
 * the text of the host's user databases (#3676, #3715).
 *
 * write-secret.js is its caller and does every read, from fixed paths: any
 * path or variable pointing the reads elsewhere would let the environment
 * vouch for a group (#3716).
 */

/** systemd's userdb drop-in directories, each of which must be empty. */
const USERDB_DROP_INS = [
	"/etc/userdb",
	"/run/userdb",
	"/run/host/userdb",
	"/usr/local/lib/userdb",
	"/usr/lib/userdb",
];
/** systemd's userdb service directory, which may hold only QUIET_USERDB. */
const USERDB_SERVICES = "/run/systemd/userdb";
const USERDB_DIRS = [...USERDB_DROP_INS, USERDB_SERVICES];

/** systemd's userdb services that name no user beyond NSS's own files. */
const QUIET_USERDB = new Set([
	"io.systemd.DropIn",
	"io.systemd.DynamicUser",
	"io.systemd.Multiplexer",
	"io.systemd.NameServiceSwitch",
]);

/** A group password field through which no one can `newgrp` in. */
const NO_GROUP_PASSWORD = new Set(["", "x", "!", "*"]);

/**
 * @typedef {object} UserDb what the host's user databases hold, null where
 *   unreadable
 * @property {string | null} passwd `/etc/passwd`'s text
 * @property {string | null} group `/etc/group`'s text
 * @property {string | null} nsswitch `/etc/nsswitch.conf`'s text
 * @property {Record<string, string[] | null>} userdb each of USERDB_DIRS'
 *   entries, empty where it is absent
 */

/** @typedef {{ uid: number, gid: number, username: string }} User */

/**
 * Whether `gid` is `me`'s private group: their primary gid in `/etc/passwd`,
 * under the one row naming them, with no other member in `/etc/group` and no
 * other user's primary gid. Only those two files are read, so a host whose
 * user and group lookups can reach another source is judged to have none
 * private.
 * @param {number} gid
 * @param {User} me
 * @param {UserDb} db
 * @returns {boolean}
 */
function isPrivateGroup(gid, me, db) {
	if (gid !== me.gid || !isFilesOnlyUserSource(db)) return false;
	const groups = parseDbRows(db.group, [2]);
	const users = parseDbRows(db.passwd, [2, 3]);
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

/**
 * Whether `/etc/passwd` and `/etc/group` are the only sources of users and
 * group members: `nsswitch.conf` names only `files` for each, and for
 * `initgroups` where it is named, or `systemd` too where no userdb record or
 * service beyond dynamic users exists. Any line glibc could read as one of
 * those databases must be in the plain `<db>: <sources>` form, so no looser
 * spelling outranks the one read. A directory service (LDAP, sssd), NIS or a
 * systemd-homed user could hold a member these files never show, and
 * `initgroups` sets each login's groups apart from `group`.
 * @param {UserDb} db
 * @returns {boolean}
 */
function isFilesOnlyUserSource(db) {
	const conf = splitContentLines(db.nsswitch);
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
	return (
		USERDB_DROP_INS.every((d) => db.userdb[d]?.length === 0) &&
		db.userdb[USERDB_SERVICES]?.every((e) => QUIET_USERDB.has(e)) === true
	);
}

/**
 * The colon-split rows of an `/etc` database's text, or null where it was
 * unreadable, holds a NIS compat row (`+`, `-`), whose entries live
 * elsewhere, a row led by whitespace, whose name glibc reads with it stripped
 * (#3715), or a row whose field at an index in `ids` is not a plain decimal
 * id, which glibc's parse could read as another.
 * @param {string | null} text
 * @param {number[]} ids
 * @returns {string[][] | null}
 */
function parseDbRows(text, ids) {
	const lines = splitContentLines(text);
	if (lines === null || lines.some((l) => /^[+\-\s]/.test(l))) return null;
	const rows = lines.map((l) => l.split(":"));
	const plain = rows.every((f) => ids.every((i) => /^\d+$/.test(f[i] ?? "")));
	return plain ? rows : null;
}

/**
 * `text`'s lines less blank ones and those glibc skips as comments; null
 * where it was unreadable.
 * @param {string | null} text
 * @returns {string[] | null}
 */
function splitContentLines(text) {
	if (text === null) return null;
	return text.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
}

module.exports = { isPrivateGroup, USERDB_DIRS };
