const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { spawnChild } = require("./child-spawn.js");
const { deref } = require("./deref.js");
const {
	parseGitFileTarget,
	readGitFile,
	readGitFileCommonDir,
	readRegisteredTree,
	readRegistrations,
	readRegistrationCommonDir,
} = require("./git-file.js");
const { fileThrough } = require("./file-through.js");
const { findFiledLine } = require("./filed-line.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { gh, ghJson, parseErrLine } = require("./gh.js");
const { gitCommonDir } = require("./git.js");
const guardProbe = require("./guard-probe.js");
const { hostRoot } = require("./host-root.js");
const { readJobRef } = require("./job-paths.js");
const { checkoutOfCommonDir, mainCheckout } = require("./main-checkout.js");
const { refillPath } = require("./refill-dir.js");
const { buildAgeText } = require("./hold-age.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const {
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
} = require("./run-budgeted.js");
const { takesLabel } = require("./takes-label.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {{command: string} | {issueClosed: number} | {probe: true}} ClearCheck
 * @typedef {object} RepoHold
 * @property {string} id
 * @property {string} checkout
 * @property {"probe"|"park"} kind
 * @property {string} act
 * @property {number|null} issue
 * @property {ClearCheck} clearCheck
 * @property {number} raisedAt
 * @property {string[]} sessions
 * @property {HoldNotice} notice
 * @typedef {object} NoticePhase
 * @property {number} at
 * @property {number} tries
 * @property {"dispatched"|"seen"|"lost"} outcome
 * @typedef {object} HoldNotice
 * @property {NoticePhase|null} raise
 * @property {NoticePhase|null} clear
 * @property {boolean} isUnsetLogged
 * @typedef {(line: string) => void} Log
 * @typedef {object} LiftedHold
 * @property {string} root
 * @property {string} dir
 * @property {string} id
 * @property {string[]} recordJobs
 * @property {string[]} jobs
 * @property {boolean} isClearNoticeOwed
 * @typedef {import("./guard-probe.js").ProbeFailure} ProbeFailure
 * @typedef {import("./block-cause.js").RefusedCall} RefusedCall
 * @typedef {object} Probe
 * @property {(root: string) => ProbeFailure|null} readProbeFailure
 * @property {(root: string, call: RefusedCall) => string|null} readReplayFailure
 */

// guess, #3857
const TICK_CALL_TIMEOUT_MS = 30_000;

// guess, #3857
const CLEAR_CHECK_KILL_AFTER_MS = 5000;

// guess, #3857
const CLEAR_CHECK_SPAWN_TIMEOUT_MS =
	TICK_CALL_TIMEOUT_MS + 2 * CLEAR_CHECK_KILL_AFTER_MS;

// guess, #3857
const ID_BYTES = 3;

const PROBE_ID = "probe";

const LIFTED_DIR = "lifted";

const HOLD_FILE_REMEDY = "lift its id or remove the file";

const LIFTING_PREFIX = "lifting-";

// guess, #3899
const OUTAGE_HOLD_AFTER_MS = 15 * 60_000;

/** @type {HoldNotice} */
const NO_NOTICE = { raise: null, clear: null, isUnsetLogged: false };

/** @type {NoticePhase} */
const UNREAD_PHASE = { at: 0, tries: 0, outcome: "lost" };

/** @type {HoldNotice} */
const UNREAD_NOTICE = {
	raise: UNREAD_PHASE,
	clear: UNREAD_PHASE,
	isUnsetLogged: true,
};

const ID_PATTERN = new RegExp(`^(?:[0-9a-f]+|${PROBE_ID})$`);

const JOB_PATTERN = /^[0-9A-Za-z_-]+$/;

const PROBE_FILED_WHY =
	"a probe hold is raised by the refill loop, with no asking session to hold its question (#3860)";

// guess, #3857
const STORE_KEY_LENGTH = 12;

const LOCKOUT_REPAIR = "the guard code the hook line runs, as its refusal says";

/** @param {string} common */
const checkoutOf = (common) => checkoutOfCommonDir(deref(common));

/** @param {string} cwd */
function readCheckout(cwd) {
	const main = mainCheckout(cwd);
	if (main !== null) return main;
	const found = readGitFile(cwd);
	if (found === null) return cwd;
	const registration = parseGitFileTarget(found.dir, found.text);
	const common = registration && readRegistrationCommonDir(registration);
	return (common && checkoutOf(common)) ?? found.dir;
}

/** @type {AsyncLocalStorage<Map<string, string>>} */
const tickStores = new AsyncLocalStorage();

/** @param {string} root */
function holdsDir(root) {
	const stores = tickStores.getStore();
	const known = stores?.get(root);
	if (known !== undefined) return known;
	const own = path.join(root, ".git");
	const common = gitCommonDir(root) ?? readGitFileCommonDir(root);
	const dir = buildStoreDir(root, common ?? own);
	const broken = buildStoreDir(root, own);
	/** @type {Adoption[]} */
	const adoptions = [];
	if (common !== null && broken !== dir)
		adoptions.push({
			from: broken,
			remedy: STORE_REMEDY,
			adopt: () => adoptStore(broken, dir, root),
		});
	if (common !== null && checkoutOf(common) === deref(root))
		adoptions.push(...readWorktreeAdoptions(root, common, dir));
	runAdoptions(dir, adoptions);
	stores?.set(root, dir);
	return dir;
}

/**
 * @param {string} root
 * @param {string} key
 */
function buildStoreDir(root, key) {
	const hash = createHash("sha256").update(deref(key)).digest("hex");
	return refillPath(
		path.join(
			"repo-holds",
			`${path.basename(root)}-${hash.slice(0, STORE_KEY_LENGTH)}`,
		),
	);
}

/** @typedef {{from: string, remedy: string, adopt: () => void}} Adoption */

const STORE_REMEDY =
	"its holds read nowhere until it moves, so repair the directory";

const REGISTRY_REMEDY =
	"a hold its worktree raised while its .git file named nothing reads nowhere until it does, so repair it";

/** @type {Map<string, Map<string, string>>} */
const adoptFaults = new Map();

/**
 * @param {string} to
 * @param {Adoption[]} adoptions
 */
function runAdoptions(to, adoptions) {
	/** @type {Map<string, string>} */
	const faults = new Map();
	for (const { from, remedy, adopt } of adoptions) {
		try {
			adopt();
		} catch (err) {
			faults.set(from, `${from}: ${caught(err).message}; ${remedy}`);
		}
	}
	adoptFaults.set(to, faults);
}

/**
 * @param {string} root
 * @param {string} common
 * @param {string} dir
 * @returns {Adoption[]}
 */
function readWorktreeAdoptions(root, common, dir) {
	const registry = path.join(common, "worktrees");
	let registrations;
	try {
		registrations = readRegistrations(common);
	} catch (err) {
		return [
			{
				from: registry,
				remedy: REGISTRY_REMEDY,
				adopt: () => {
					throw err;
				},
			},
		];
	}
	return registrations.map((registration) => ({
		from: registration,
		remedy: REGISTRY_REMEDY,
		adopt: () => {
			const tree = readRegisteredTree(registration);
			if (tree === null) return;
			const named = readGitFileCommonDir(tree);
			if (named !== null && deref(named) === deref(common))
				adoptStore(buildStoreDir(tree, path.join(tree, ".git")), dir, root);
		},
	}));
}

const STORE_FILES = new Set([`${PROBE_ID}.paged`, `${PROBE_ID}.outage`]);

const OCCUPIED_CODES = new Set(["EEXIST", "ENOTEMPTY"]);

/**
 * @param {string} from
 * @param {string} to
 * @param {string} root
 */
function adoptStore(from, to, root) {
	const names = readNamesOrNone(from);
	if (names.length === 0) return;
	fs.mkdirSync(to, { recursive: true });
	const held = new Set(
		fs.readdirSync(to).filter(isHoldFileName).map(parseEntryId),
	);
	for (const name of names.filter((n) => !isHoldFileName(n))) {
		const id = parseEntryId(name);
		const isJobFile =
			name.startsWith(buildAttachPrefix(id)) ||
			name.startsWith(buildReplayPrefix(id));
		if (name === LIFTED_DIR) adoptLifted(from, to);
		else if (STORE_FILES.has(name))
			linkEntry(path.join(from, name), path.join(to, name));
		else if (isJobFile || !held.has(id))
			renameEntry(path.join(from, name), path.join(to, name));
	}
	for (const name of names.filter(isHoldFileName))
		if (!held.has(parseEntryId(name))) {
			rehomeRecord(path.join(from, name), name, root);
			renameEntry(path.join(from, name), path.join(to, name));
		}
	removeDirIfEmpty(from);
}

/**
 * @param {string} file
 * @param {string} name
 * @param {string} root
 */
function rehomeRecord(file, name, root) {
	const read = readHoldFile(file, name);
	if (read === null || "torn" in read || read.hold.checkout === root) return;
	writeFileAtomic(file, JSON.stringify({ ...read.hold, checkout: root }));
}

/**
 * @param {string} from
 * @param {string} to
 */
function adoptLifted(from, to) {
	const base = path.join(from, LIFTED_DIR);
	fs.mkdirSync(path.join(to, LIFTED_DIR), { recursive: true });
	for (const name of readNamesOrNone(base))
		renameEntry(path.join(base, name), path.join(to, LIFTED_DIR, name));
	removeDirIfEmpty(base);
}

/**
 * @param {string} from
 * @param {string} to
 */
function renameEntry(from, to) {
	try {
		fs.renameSync(from, to);
	} catch (err) {
		const code = caught(err).code ?? "";
		if (code !== "ENOENT" && !OCCUPIED_CODES.has(code)) throw err;
	}
}

/**
 * @param {string} from
 * @param {string} to
 */
function linkEntry(from, to) {
	try {
		fs.linkSync(from, to);
	} catch (err) {
		const { code } = caught(err);
		if (code === "ENOENT") return;
		if (code !== "EEXIST") throw err;
	}
	fs.rmSync(from, { force: true });
}

/**
 * @param {string} dir
 */
function readNamesOrNone(dir) {
	try {
		return fs.readdirSync(dir);
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
}

/**
 * @param {string} dir
 */
function removeDirIfEmpty(dir) {
	try {
		fs.rmdirSync(dir);
	} catch (err) {
		const code = caught(err).code ?? "";
		if (code !== "ENOENT" && !OCCUPIED_CODES.has(code)) throw err;
	}
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
const withTickStores = (fn) => tickStores.run(new Map(), fn);

/**
 * @param {string} id
 */
const buildHoldFileName = (id) => `${id}.json`;

/**
 * @param {string} name
 */
const isHoldFileName = (name) => name.endsWith(".json");

/**
 * @param {string} name
 */
const parseEntryId = (name) => name.split(".")[0] ?? name;

/** @param {string} id */
const buildLiftedName = (id) =>
	`${id}-${randomBytes(ID_BYTES).toString("hex")}`;

/** @param {string} name */
const parseLiftedId = (name) => name.slice(0, name.lastIndexOf("-"));

/**
 * @param {string} root
 * @param {string} id
 */
const holdFile = (root, id) => path.join(holdsDir(root), buildHoldFileName(id));

/** @param {string} id */
const buildAttachPrefix = (id) => `${id}.attached.`;

/**
 * @param {string} id
 */
const buildReplayPrefix = (id) => `${id}.replay.`;

/**
 * @param {string} dir
 * @param {string} id
 */
function removeReplays(dir, id) {
	for (const name of parseReplayNames(readNamesOrNone(dir), id))
		fs.rmSync(path.join(dir, name), { force: true });
}

/**
 * @param {string[]} names
 * @param {string} id
 */
const parseReplayNames = (names, id) =>
	names.filter((n) => n.startsWith(buildReplayPrefix(id)));

/**
 * @param {string[]} names
 * @param {string} id
 */
const parseAttachedJobs = (names, id) =>
	names
		.filter((n) => n.startsWith(buildAttachPrefix(id)))
		.map((n) => n.slice(buildAttachPrefix(id).length));

/** @param {string} id */
const buildNoticeName = (id) => `${id}.notice`;

/** @param {string} root */
const buildProbePagedFile = (root) =>
	path.join(holdsDir(root), `${PROBE_ID}.paged`);

/** @param {unknown} value */
const isNoticePhase = (value) => {
	const phase = /** @type {Partial<NoticePhase>|null} */ (value);
	return (
		value === null ||
		(typeof phase?.at === "number" &&
			typeof phase.tries === "number" &&
			["dispatched", "seen", "lost"].includes(phase.outcome ?? ""))
	);
};

/**
 * @param {string} file
 * @returns {HoldNotice}
 */
function readNotice(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return isNoticePhase(value?.raise) &&
			isNoticePhase(value?.clear) &&
			typeof value?.isUnsetLogged === "boolean"
			? value
			: UNREAD_NOTICE;
	} catch (err) {
		return caught(err).code === "ENOENT" ? NO_NOTICE : UNREAD_NOTICE;
	}
}

/**
 * @param {string} file
 * @param {HoldNotice} notice
 */
const writeNotice = (file, notice) =>
	writeFileAtomic(file, JSON.stringify(notice), { mkdir: true });

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {value is RepoHold}
 */
function isHold(value, name) {
	const hold = /** @type {Partial<RepoHold>|null} */ (value);
	const check =
		/** @type {Partial<{command: unknown, issueClosed: unknown, probe: unknown}>} */ (
			hold?.clearCheck ?? {}
		);
	return (
		typeof hold?.id === "string" &&
		ID_PATTERN.test(hold.id) &&
		name === `${hold.id}.json` &&
		typeof hold.checkout === "string" &&
		(hold.kind === "probe" || hold.kind === "park") &&
		typeof hold.act === "string" &&
		(typeof hold.issue === "number" ||
			(hold.kind === "probe" && hold.issue === null)) &&
		typeof hold.raisedAt === "number" &&
		Array.isArray(hold.sessions) &&
		(typeof check.command === "string" ||
			typeof check.issueClosed === "number" ||
			(hold.kind === "probe" && check.probe === true))
	);
}

/**
 * @param {string} root
 * @returns {{holds: RepoHold[], unread: string[]}}
 */
function readHolds(root) {
	const dir = holdsDir(root);
	const read = readStoreHolds(dir);
	const faults = [...(adoptFaults.get(dir)?.values() ?? [])];
	return faults.length > 0
		? { ...read, unread: [...faults, ...read.unread] }
		: read;
}

/**
 * @param {string} dir
 * @returns {{holds: RepoHold[], unread: string[]}}
 */
function readStoreHolds(dir) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		const { code, message } = caught(err);
		return code === "ENOENT"
			? { holds: [], unread: [] }
			: {
					holds: [],
					unread: [
						`${dir}: ${message}; repair the directory, as no hold in it reads`,
					],
				};
	}
	/** @type {RepoHold[]} */
	const holds = [];
	/** @type {string[]} */
	const unread = [];
	for (const name of names.filter(isHoldFileName)) {
		const file = path.join(dir, name);
		try {
			const read = readHoldFile(file, name);
			if (read === null) continue;
			if ("torn" in read) {
				unread.push(`${file}: ${read.torn}; ${HOLD_FILE_REMEDY}`);
				continue;
			}
			const { hold } = read;
			const noticeFile = path.join(dir, buildNoticeName(hold.id));
			const notice = readNotice(noticeFile);
			if (notice === UNREAD_NOTICE)
				unread.push(
					`${noticeFile}: not its notice state, so it sends none; remove the file`,
				);
			holds.push({
				...hold,
				notice,
				sessions: [
					...new Set([...hold.sessions, ...parseAttachedJobs(names, hold.id)]),
				],
			});
		} catch (err) {
			unread.push(`${file}: ${caught(err).message}; ${HOLD_FILE_REMEDY}`);
		}
	}
	return { holds: holds.sort((a, b) => a.raisedAt - b.raisedAt), unread };
}

/**
 * @param {string} file
 * @param {string} name
 * @returns {{hold: RepoHold}|{torn: string}|null}
 */
function readHoldFile(file, name) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return isHold(value, name) ? { hold: value } : { torn: "not a hold" };
	} catch (err) {
		if (err instanceof SyntaxError) return { torn: err.message };
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
}

/** @param {ClearCheck} check */
function buildCheckText(check) {
	if ("probe" in check) return "the shared .git probe";
	return "command" in check
		? `command: ${check.command.replace(/\s+/g, " ").trim()}`
		: `issue #${check.issueClosed} closed`;
}

/** @param {RepoHold} hold */
const buildHoldRef = (hold) => `${hold.id} in ${hold.checkout}: ${hold.act}`;

/** @param {RepoHold} hold */
const buildIssueText = (hold) =>
	hold.issue === null ? "no issue filed yet" : `issue #${hold.issue}`;

/**
 * @param {string} root
 * @param {Omit<RepoHold, "notice"> & {notice?: HoldNotice}} hold
 */
const writeHold = (root, { notice: _, ...record }) =>
	writeFileAtomic(
		holdFile(root, record.id),
		`${JSON.stringify(record, null, "\t")}\n`,
		{ mkdir: true },
	);

/**
 * @param {string} root
 * @param {{id?: string, kind: RepoHold["kind"], act: string,
 *   issue: number|null, clearCheck: ClearCheck, session: string|null,
 *   now: number}} raised
 * @returns {RepoHold}
 */
function raiseHold(
	root,
	{
		id = randomBytes(ID_BYTES).toString("hex"),
		kind,
		act,
		issue,
		clearCheck,
		session,
		now,
	},
) {
	fs.rmSync(path.join(holdsDir(root), buildNoticeName(id)), { force: true });
	removeReplays(holdsDir(root), id);
	/** @type {Omit<RepoHold, "notice">} */
	const record = {
		id,
		checkout: root,
		kind,
		act: act.replace(/\s+/g, " ").trim(),
		issue,
		clearCheck,
		raisedAt: now,
		sessions: session === null ? [] : [session],
	};
	writeHold(root, record);
	return { ...record, notice: NO_NOTICE };
}

/** @param {RepoHold} hold */
const buildRaisedLine = (hold) =>
	`repo hold raised: ${buildHoldRef(hold)}; ${buildIssueText(hold)}; clears on ${buildCheckText(hold.clearCheck)}`;

/**
 * @param {string} root
 * @param {string} id
 * @param {string} job
 * @returns {{hold: RepoHold, isNew: boolean}|null}
 */
function attachHold(root, id, job) {
	if (!ID_PATTERN.test(id)) return null;
	if (!JOB_PATTERN.test(job)) throw new Error(`not a job id: ${job}`);
	const file = path.join(holdsDir(root), `${buildAttachPrefix(id)}${job}`);
	let isNew = true;
	try {
		fs.writeFileSync(file, "", { flag: "wx" });
	} catch (err) {
		const { code } = caught(err);
		if (code === "ENOENT") return null;
		if (code !== "EEXIST") throw err;
		isNew = false;
	}
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (hold?.issue !== null) {
		if (hold) return { hold, isNew };
		fs.rmSync(file, { force: true });
		return null;
	}
	fs.rmSync(file, { force: true });
	return { hold, isNew: false };
}

/**
 * @param {RepoHold} hold
 * @param {string} job
 */
const buildAttachedLine = (hold, job) =>
	`repo hold attached: ${buildHoldRef(hold)}; session ${job}; ${hold.sessions.length} attached`;

/**
 * @param {string} text
 * @returns {RepoHold|null}
 */
function findOwnHold(text) {
	const job = readJobRef(process.env)?.jobId;
	if (!job) return null;
	const root = readCheckout(hostRoot());
	return (
		readHolds(root).holds.find(
			(h) =>
				fs.existsSync(
					path.join(holdsDir(root), `${buildAttachPrefix(h.id)}${job}`),
				) &&
				new RegExp(`\\bhold ${h.id}\\b`).test(text) &&
				new RegExp(`#${h.issue}\\b`).test(text),
		) ?? null
	);
}

/**
 * @param {string} root
 * @param {string} id
 */
function removeHold(root, id) {
	const dir = holdsDir(root);
	const name = buildLiftedName(id);
	const lifting = path.join(dir, `${LIFTING_PREFIX}${name}`);
	fs.mkdirSync(lifting, { recursive: true });
	try {
		fs.renameSync(
			holdFile(root, id),
			path.join(lifting, buildHoldFileName(id)),
		);
	} catch (err) {
		fs.rmdirSync(lifting);
		if (caught(err).code === "ENOENT") return false;
		throw err;
	}
	const beside = [
		buildNoticeName(id),
		...parseAttachedJobs(fs.readdirSync(dir), id).map(
			(job) => `${buildAttachPrefix(id)}${job}`,
		),
	];
	for (const file of beside) {
		try {
			fs.renameSync(path.join(dir, file), path.join(lifting, file));
		} catch (err) {
			if (caught(err).code !== "ENOENT") throw err;
		}
	}
	removeReplays(dir, id);
	fs.mkdirSync(path.join(dir, LIFTED_DIR), { recursive: true });
	fs.renameSync(lifting, path.join(dir, LIFTED_DIR, name));
	return true;
}

/**
 * @param {string} file
 * @param {Log} log
 * @returns {string[]|null}
 */
function readLiftedRecordJobs(file, log) {
	try {
		const { sessions } = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(sessions)
			? sessions.filter((s) => typeof s === "string")
			: [];
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		log(`lifted repo hold unread: ${file}: ${caught(err).message}`);
		return err instanceof SyntaxError ? [] : null;
	}
}

/**
 * @param {string} dir
 * @param {Log} log
 */
function readLiftedNames(dir, log) {
	try {
		return fs.readdirSync(dir);
	} catch (err) {
		const { code, message } = caught(err);
		if (code !== "ENOENT" && code !== "ENOTDIR")
			log(`lifted repo holds unread: ${dir}: ${message}`);
		return [];
	}
}

/**
 * @param {HoldNotice} notice
 */
const isClearOwed = ({ raise, clear }) =>
	raise !== null &&
	raise.outcome !== "lost" &&
	(clear === null || clear.outcome === "dispatched");

/**
 * @param {string[]} roots
 * @param {Log} log
 * @returns {LiftedHold[]}
 */
function readLiftedHolds(roots, log) {
	return readStoreRoots(roots).flatMap((root) => {
		const base = path.join(holdsDir(root), LIFTED_DIR);
		return readLiftedNames(base, log).flatMap((name) => {
			const dir = path.join(base, name);
			const id = parseLiftedId(name);
			const recordJobs = readLiftedRecordJobs(
				path.join(dir, buildHoldFileName(id)),
				log,
			);
			if (recordJobs === null) return [];
			const attached = parseAttachedJobs(readLiftedNames(dir, log), id);
			return [
				{
					root,
					dir,
					id,
					recordJobs,
					jobs: [...new Set([...recordJobs, ...attached])],
					isClearNoticeOwed: isClearOwed(
						readNotice(path.join(dir, buildNoticeName(id))),
					),
				},
			];
		});
	});
}

/**
 * @param {string} file
 * @param {string[]} settled
 */
function dropRecordJobs(file, settled) {
	if (settled.length === 0) return;
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	writeFileAtomic(
		file,
		JSON.stringify({
			...record,
			sessions: record.sessions.filter(
				(/** @type {string} */ job) => !settled.includes(job),
			),
		}),
	);
}

/**
 * @param {LiftedHold} lifted
 * @returns {RepoHold|null}
 */
function readLiftedRecord({ dir, id }) {
	const name = buildHoldFileName(id);
	const read = readHoldFile(path.join(dir, name), name);
	return read && "hold" in read
		? { ...read.hold, notice: readNotice(path.join(dir, buildNoticeName(id))) }
		: null;
}

/**
 * @param {LiftedHold} hold
 * @param {string[]} settled
 * @param {Log} log
 */
function dropLiftedJobs(
	{ dir, id, recordJobs, jobs, isClearNoticeOwed },
	settled,
	log,
) {
	try {
		for (const job of settled)
			fs.rmSync(path.join(dir, `${buildAttachPrefix(id)}${job}`), {
				force: true,
			});
		if (!jobs.every((job) => settled.includes(job))) return;
		if (isClearNoticeOwed) {
			dropRecordJobs(path.join(dir, buildHoldFileName(id)), settled);
			return;
		}
		fs.rmSync(path.join(dir, buildNoticeName(id)), { force: true });
		if (recordJobs.every((job) => settled.includes(job)))
			fs.rmSync(path.join(dir, buildHoldFileName(id)), { force: true });
		fs.rmdirSync(dir);
	} catch (err) {
		log(`repo hold ${id}: lifted record kept: ${caught(err).message}`);
	}
}

/**
 * @param {string} root
 * @param {string} id
 * @returns {string|null}
 */
function liftHold(root, id) {
	if (!ID_PATTERN.test(id)) return null;
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (!removeHold(root, id)) return null;
	const line = `repo hold lifted by hand: ${hold ? buildHoldRef(hold) : id}`;
	const closeFailure =
		hold && closeProbeIssue(hold, "Its hold was lifted by hand.");
	return closeFailure ? `${line}; ${closeFailure}` : line;
}

/**
 * @param {RepoHold} hold
 * @param {string} command
 * @param {Log} log
 */
function isCommandPassed(hold, command, log) {
	const run = spawnChild(
		process.execPath,
		[
			RUN_BUDGETED,
			String(TICK_CALL_TIMEOUT_MS),
			String(CLEAR_CHECK_KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd: hold.checkout,
			env: buildCheckoutEnv(hold.checkout),
			timeout: CLEAR_CHECK_SPAWN_TIMEOUT_MS,
		},
	);
	if (run.error) {
		log(
			`repo hold ${hold.id}: clear check did not finish: ${run.error.message}`,
		);
		return false;
	}
	if (run.status === TIMEOUT_EXIT || run.status === KILLED_EXIT)
		log(
			`repo hold ${hold.id}: clear check outlived ${TICK_CALL_TIMEOUT_MS} ms`,
		);
	return run.status === 0;
}

/** @param {string} root */
function readTracker(root) {
	const tracker = resolveKey("tracker", { root });
	if (typeof tracker !== "string") throw new Error("no tracker configured");
	return tracker;
}

/**
 * @param {RepoHold} hold
 * @param {number} issue
 * @param {Log} log
 */
function isIssueClosed(hold, issue, log) {
	try {
		const state = gh(
			[
				"issue",
				"view",
				String(issue),
				"--repo",
				readTracker(hold.checkout),
				"--json",
				"state",
				"--jq",
				".state",
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		);
		return state.trim() === "CLOSED";
	} catch (e) {
		log(`repo hold ${hold.id}: could not read #${issue}: ${parseErrLine(e)}`);
		return false;
	}
}

/**
 * @param {RepoHold} hold
 * @param {string} why
 */
function closeProbeIssue(hold, why) {
	if (hold.kind !== "probe" || hold.issue === null) return null;
	return closeIncidentIssue(
		hold.checkout,
		hold.issue,
		`${why} The refill loop launches into ${hold.checkout} again unless it reads another failure.`,
	);
}

/**
 * @param {RepoHold} hold
 * @param {Probe} probe
 * @param {Log} log
 */
function isCheckPassed(hold, probe, log) {
	if ("probe" in hold.clearCheck)
		return (
			probe.readProbeFailure(hold.checkout) === null &&
			isEveryReplayPassed(
				hold,
				readHoldReplays(hold.checkout, hold.id),
				probe,
				log,
			)
		);
	return "command" in hold.clearCheck
		? isCommandPassed(hold, hold.clearCheck.command, log)
		: isIssueClosed(hold, hold.clearCheck.issueClosed, log);
}

/**
 * @param {string} root
 * @param {string} id
 * @returns {RefusedCall[]}
 */
function readHoldReplays(root, id) {
	const dir = holdsDir(root);
	return parseReplayNames(fs.readdirSync(dir), id).flatMap((name) => {
		const read = readText(path.join(dir, name));
		if (read.state === "absent") return [];
		if (read.state === "unreadable") throw read.error;
		try {
			const call = JSON.parse(read.data);
			return typeof call?.tool_name === "string" ? [call] : [];
		} catch {
			return [];
		}
	});
}

/**
 * @param {string} root
 * @param {string} job
 * @param {RefusedCall} call
 */
function keepProbeReplay(root, job, call) {
	if (!JOB_PATTERN.test(job)) throw new Error(`not a job id: ${job}`);
	try {
		fs.writeFileSync(
			path.join(holdsDir(root), `${buildReplayPrefix(PROBE_ID)}${job}`),
			JSON.stringify(call),
			{ flag: "wx" },
		);
	} catch (err) {
		if (caught(err).code !== "EEXIST") throw err;
	}
}

/**
 * @param {RepoHold} hold
 * @param {RefusedCall[]} replays
 * @param {Probe} probe
 * @param {Log} log
 */
function isEveryReplayPassed(hold, replays, probe, log) {
	return replays.every((call) => {
		const failure = probe.readReplayFailure(hold.checkout, call);
		if (failure !== null)
			log(`repo hold ${hold.id}: a kept call still fails: ${failure}`);
		return failure === null;
	});
}

/** @param {string[]} roots */
const readStoreRoots = (roots) => [
	...new Map(roots.map((root) => [holdsDir(root), root])).values(),
];

/**
 * @param {string} root
 * @param {RepoHold} hold
 * @param {Probe} probe
 * @param {Log} log
 */
function settleHold(root, hold, probe, log) {
	try {
		if (!isCheckPassed(hold, probe, log) || !removeHold(root, hold.id)) return;
		log(
			`repo hold cleared: ${buildHoldRef(hold)}; passed ${buildCheckText(hold.clearCheck)}`,
		);
		const closeFailure = closeProbeIssue(
			hold,
			"The probe of the main checkout passes again, so its hold has cleared.",
		);
		if (closeFailure) log(`repo hold ${hold.id}: ${closeFailure}`);
	} catch (err) {
		log(`repo hold ${hold.id}: not settled: ${caught(err).message}`);
	}
}

/**
 * @param {string} root
 * @returns {RepoHold|null}
 */
function readProbeHold(root) {
	const read = readHoldFile(holdFile(root, PROBE_ID), `${PROBE_ID}.json`);
	return read && "hold" in read ? read.hold : null;
}

/**
 * @param {string} root
 * @param {string} failure
 */
const buildProbeIssueBody = (root, failure) =>
	`The refill loop's probe of the main checkout \`${root}\` failed, so the loop launches nothing into that checkout until it passes.

**Failure:** ${failure}

**To clear:** repair the checkout. The loop re-runs the probe each tick, lifts its hold the tick it passes and closes this issue. Where \`node scripts/repo-hold.js list\` shows no \`probe\` hold for this checkout and this issue is still open, its close failed: close it.`;

/**
 * @param {string} root
 * @param {string} title
 * @returns {number|null}
 */
function readOpenIssueTitled(root, title) {
	const rows = /** @type {{number: number, title: string}[]} */ (
		ghJson(
			[
				"issue",
				"list",
				"--repo",
				readTracker(root),
				"--state",
				"open",
				"--search",
				`"${title}" in:title`,
				"--json",
				"number,title",
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		)
	);
	return rows.find((r) => r.title === title)?.number ?? null;
}

/**
 * @param {string} root
 * @param {{title: string, body: string, why: string}} issue
 * @returns {{number: number, isTakenUp: boolean}|string}
 */
function fileIncidentIssue(root, { title, body, why }) {
	try {
		const open = readOpenIssueTitled(root, title);
		if (open !== null) return { number: open, isTakenUp: true };
	} catch (e) {
		return `could not look for an open one: ${parseErrLine(e)}`;
	}
	const filed = fileThrough(
		buildScriptFilerArgv({
			title,
			labels: [takesLabel("triage")],
			placement: { standalone: why },
			origin: "incident",
		}),
		body,
		root,
	);
	const number = findFiledLine(filed.stdout ?? "")?.n;
	return number === undefined
		? (filed.stderr || filed.error?.message || "no reason given").trim()
		: { number, isTakenUp: false };
}

/**
 * @param {string} root
 * @param {number} n
 * @param {string} comment
 */
function closeIncidentIssue(root, n, comment) {
	try {
		gh(
			[
				"issue",
				"close",
				String(n),
				"--repo",
				readTracker(root),
				"--comment",
				comment,
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		);
		return null;
	} catch (e) {
		return `could not close #${n}: ${parseErrLine(e)}`;
	}
}

/**
 * @param {string} root
 * @param {RepoHold} hold
 * @param {string} failure
 * @param {Log} log
 */
function fileProbeIssue(root, hold, failure, log) {
	const filed = fileIncidentIssue(root, {
		title: `Refill loop probe: shared .git failing in ${path.basename(root)}`,
		body: buildProbeIssueBody(root, failure),
		why: PROBE_FILED_WHY,
	});
	if (typeof filed === "string") {
		log(
			`repo hold ${hold.id} in ${root}: issue not filed, the next tick retries: ${filed}`,
		);
		return;
	}
	writeHold(root, { ...hold, issue: filed.number });
	log(
		`repo hold ${hold.id} in ${root}: ${filed.isTakenUp ? "took up open" : "filed"} #${filed.number}`,
	);
}

/**
 * @param {string} file
 * @param {number} now
 * @param {Log} log
 */
function readOutageSince(file, now, log) {
	try {
		const { since, last } = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof since === "number" &&
			typeof last === "number" &&
			now - last <= OUTAGE_HOLD_AFTER_MS
			? since
			: now;
	} catch (err) {
		if (caught(err).code === "ENOENT") return now;
		if (!(err instanceof SyntaxError)) throw err;
		log(`outage record torn, begun anew: ${file}`);
		return now;
	}
}

/**
 * @param {string} root
 * @param {ProbeFailure|null} failure
 * @param {number} now
 * @param {Log} log
 * @returns {number}
 */
function tendOutage(root, failure, now, log) {
	const file = path.join(holdsDir(root), `${PROBE_ID}.outage`);
	try {
		if (!failure?.isOutage) {
			fs.rmSync(file, { force: true });
			return now;
		}
		const since = readOutageSince(file, now, log);
		writeFileAtomic(file, JSON.stringify({ since, last: now }), {
			mkdir: true,
		});
		return since;
	} catch (err) {
		log(`probe of ${root}: outage record unkept: ${caught(err).message}`);
		return now;
	}
}

/**
 * @param {string} root
 * @param {{failureText: string, isRaiseDue: boolean, repair?: string}} probed
 * @param {number} now
 * @param {Log} log
 */
function keepProbeHold(
	root,
	{ failureText, isRaiseDue, repair = "the main checkout" },
	now,
	log,
) {
	try {
		let hold = readProbeHold(root);
		if (hold === null) {
			if (!isRaiseDue) return;
			hold = raiseHold(root, {
				id: PROBE_ID,
				kind: "probe",
				act: `repair ${repair}: ${failureText}`,
				issue: null,
				clearCheck: { probe: true },
				session: null,
				now,
			});
			log(buildRaisedLine(hold));
		}
		if (hold.issue === null) fileProbeIssue(root, hold, failureText, log);
	} catch (err) {
		log(`repo hold ${PROBE_ID} in ${root}: not kept: ${caught(err).message}`);
	}
}

/**
 * @param {string[]} broken
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {Log} log
 */
function attachProbeParks(broken, launches, log) {
	for (const root of broken) {
		try {
			const hold = readProbeHold(root);
			if (hold === null) continue;
			for (const l of launches) {
				if (l.jobId === null || !isBlockedSinceRaise(l, hold)) continue;
				const attached = attachHold(root, PROBE_ID, l.jobId);
				if (attached?.isNew) log(buildAttachedLine(attached.hold, l.jobId));
			}
		} catch (err) {
			log(
				`repo hold ${PROBE_ID} in ${root}: parks not attached: ${caught(err).message}`,
			);
		}
	}
}

/**
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {RepoHold} hold
 */
function isBlockedSinceRaise(l, hold) {
	const since = l.block?.since;
	return (
		l.root === hold.checkout &&
		l.finishedAt === null &&
		since !== undefined &&
		since >= hold.raisedAt
	);
}

/**
 * @param {string} root
 * @param {{job: string, refusal: string, call: RefusedCall|null}} lockout
 * @param {number} now
 * @param {Log} log
 * @returns {{hold: RepoHold}|{why: string}}
 */
function holdLockedOut(root, { job, refusal, call }, now, log) {
	keepProbeHold(
		root,
		{
			failureText: `guard lockout: ${refusal}`,
			isRaiseDue: true,
			repair: LOCKOUT_REPAIR,
		},
		now,
		log,
	);
	try {
		if (readProbeHold(root) === null) return { why: "no probe hold stands" };
		if (call) keepProbeReplay(root, job, call);
		const attached = attachHold(root, PROBE_ID, job);
		if (attached === null) return { why: "no probe hold stands" };
		if (attached.hold.issue === null)
			return { why: "its probe hold has no issue filed yet" };
		if (attached.isNew) log(buildAttachedLine(attached.hold, job));
		return { hold: attached.hold };
	} catch (err) {
		return { why: caught(err).message };
	}
}

/**
 * @param {string[]} roots
 * @param {string[]} served
 * @param {number} now
 * @param {{log: Log, probe?: Probe}} with
 * @returns {string[]}
 */
function tendHolds(roots, served, now, { log, probe = guardProbe }) {
	/** @type {Map<string, ProbeFailure|null>} */
	const probed = new Map();
	/** @type {Probe} */
	const tickProbe = {
		readProbeFailure: (root) => {
			const known = probed.get(root);
			if (known !== undefined) return known;
			const failure = probe.readProbeFailure(root);
			probed.set(root, failure);
			return failure;
		},
		readReplayFailure: probe.readReplayFailure,
	};
	for (const root of readStoreRoots(roots)) {
		const { holds, unread } = readHolds(root);
		for (const why of unread)
			log(`repo holds unread, read as not open this tick: ${why}`);
		for (const hold of holds) settleHold(root, hold, tickProbe, log);
	}
	return served.filter((root) => {
		const failure = tickProbe.readProbeFailure(root);
		const lasted = now - tendOutage(root, failure, now, log);
		if (failure === null) return false;
		const isRaiseDue = !failure.isOutage || lasted >= OUTAGE_HOLD_AFTER_MS;
		log(
			`probe failed in ${root}: ${failure.text}${isRaiseDue ? "" : `; an outage for ${buildAgeText(lasted)}, a hold rises at ${buildAgeText(OUTAGE_HOLD_AFTER_MS)}`}`,
		);
		keepProbeHold(root, { failureText: failure.text, isRaiseDue }, now, log);
		return true;
	});
}

/**
 * @param {string[]} roots
 * @param {string[]} broken
 * @returns {{holds: import("./refill-decide.js").TickHold[],
 *   unread: {root: string, lines: string[]}[]}}
 */
const readTickHolds = (roots, broken) => {
	const reads = roots.map((root) => ({ root, ...readHolds(root) }));
	return {
		holds: [
			...broken.map((root) => ({
				root,
				kind: /** @type {const} */ ("probe"),
				issue: null,
				raisedAt: null,
			})),
			...reads.flatMap(({ root, holds }) =>
				holds.map(({ kind, issue, raisedAt }) => ({
					root,
					kind,
					issue,
					raisedAt,
				})),
			),
		],
		unread: reads
			.filter((r) => r.unread.length > 0)
			.map(({ root, unread }) => ({ root, lines: unread })),
	};
};

/**
 * @param {NoticePhase|null} phase
 */
function buildPhaseText(phase) {
	if (phase === null) return "not sent";
	return phase.outcome === "seen" ? "sent" : phase.outcome;
}

/** @param {HoldNotice} notice */
const buildNoticeText = ({ raise, clear }) =>
	`raise ${buildPhaseText(raise)}, clear ${buildPhaseText(clear)}`;

/**
 * @param {string[]} roots
 * @param {number} now
 * @returns {string[]}
 */
function buildHoldLines(roots, now) {
	const reads = readStoreRoots(roots).map(readHolds);
	const holds = reads.flatMap((r) => r.holds);
	return [
		holds.length === 0
			? "holds:     none open"
			: `holds:     ${holds.length} open`,
		...holds.map(
			(h) =>
				`  ${h.id} ${path.basename(h.checkout)}: ${h.act} — ${buildIssueText(h)}, age ${buildAgeText(now - h.raisedAt)}, sessions: ${h.sessions.join(", ") || "none"}, stops launches: ${h.kind === "probe" ? "yes" : "no"}, notice: ${buildNoticeText(h.notice)}`,
		),
		...reads.flatMap((r) => r.unread).map((why) => `  unread: ${why}`),
	];
}

module.exports = {
	closeIncidentIssue,
	fileIncidentIssue,
	attachHold,
	attachProbeParks,
	buildNoticeName,
	buildAttachedLine,
	buildHoldLines,
	buildNoticeText,
	buildProbePagedFile,
	buildRaisedLine,
	dropLiftedJobs,
	findOwnHold,
	holdLockedOut,
	holdsDir,
	isClearOwed,
	liftHold,
	raiseHold,
	readCheckout,
	readHolds,
	readLiftedHolds,
	readLiftedRecord,
	readNotice,
	readStoreRoots,
	readTickHolds,
	tendHolds,
	TICK_CALL_TIMEOUT_MS,
	withTickStores,
	writeNotice,
};
