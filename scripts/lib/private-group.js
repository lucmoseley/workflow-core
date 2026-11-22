const USERDB_DROP_INS = [
	"/etc/userdb",
	"/run/userdb",
	"/run/host/userdb",
	"/usr/local/lib/userdb",
	"/usr/lib/userdb",
];
const USERDB_SERVICES = "/run/systemd/userdb";
const USERDB_DIRS = [...USERDB_DROP_INS, USERDB_SERVICES];

const QUIET_USERDB = new Set([
	"io.systemd.DropIn",
	"io.systemd.DynamicUser",
	"io.systemd.Multiplexer",
	"io.systemd.NameServiceSwitch",
]);

const NO_GROUP_PASSWORD = new Set(["", "x", "!", "*"]);

/**
 * @typedef {object} UserDb
 * @property {string | null} passwd
 * @property {string | null} group
 * @property {string | null} nsswitch
 * @property {Record<string, string[] | null>} userdb
 */

/** @typedef {{ uid: number, gid: number, username: string }} User */

/**
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
				password !== undefined &&
				NO_GROUP_PASSWORD.has(password) &&
				members?.split(",").every((m) => m === "" || m === me.username),
		) &&
		mine.length > 0 &&
		mine.every((f) => Number(f[3]) === gid) &&
		users.every((f) => Number(f[3]) !== gid || Number(f[2]) === me.uid)
	);
}

/**
 * @param {UserDb} db
 * @returns {boolean}
 */
function isFilesOnlyUserSource(db) {
	const conf = splitContentLines(db.nsswitch);
	if (conf === null) return false;
	const dbs = "passwd|group|initgroups";
	const lines = conf
		.map((l) => l.replace(/#.*/, ""))
		.filter((l) => new RegExp(`^(${dbs})(?:[\\s:]|$)`).test(l.trim()));
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
 * @param {string | null} text
 * @param {number[]} ids
 * @returns {string[][] | null}
 */
function parseDbRows(text, ids) {
	const lines = splitContentLines(text);
	if (lines === null || lines.some((l) => /^[+\-\s]/.test(l))) return null;
	const rows = lines.map((l) => l.split(":"));
	const plain = rows.every((f) =>
		ids.every((i) => {
			const id = f[i];
			return id !== undefined && /^\d+$/.test(id);
		}),
	);
	return plain ? rows : null;
}

/**
 * @param {string | null} text
 * @returns {string[] | null}
 */
function splitContentLines(text) {
	if (text === null) return null;
	return text.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
}

module.exports = { isPrivateGroup, USERDB_DIRS };
