const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { buildPauseIssueText } = require("./refill-decide.js");
const { NO_PROGRESS_RUN } = require("./launch-room.js");
const { refillPath } = require("./refill-dir.js");
const {
	buildNoticeBody,
	readNoticeConfig,
	tendPhase,
} = require("./repo-hold-notices.js");
const {
	closeIncidentIssue,
	fileIncidentIssue,
	isClearOwed,
	readNotice,
	writeNotice,
} = require("./repo-holds.js");
const { scriptPath } = require("./script-path.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {import("./refill-decide.js").Pause} Pause
 * @typedef {import("./refill-decide.js").PauseIssue} PauseIssue
 * @typedef {import("./repo-holds.js").Log} Log
 * @typedef {import("./repo-hold-notices.js").NoticeName} NoticeName
 * @typedef {{now: number, log: Log, filer: PauseFiler}} Tend
 * @typedef {object} PauseRecord
 * @property {number} pausedAt
 * @property {string} root
 * @property {string[]} issues
 * @property {PauseIssue|null} target
 * @property {number} [filed]
 * @typedef {object} PauseFiler
 * @property {string} home
 * @property {(title: string, body: string) => number|string} file
 * @property {(n: number, comment: string) => string|null} close
 */

const NOTICE_SUFFIX = ".notice";

const noticeDir = () => refillPath("pause-notices");

/**
 * @param {number} pausedAt
 * @param {string} root
 */
const buildNoticeKey = (pausedAt, root) =>
	`${pausedAt}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)}`;

/** @param {string} key */
const buildNoticeFile = (key) =>
	path.join(noticeDir(), `${key}${NOTICE_SUFFIX}`);

/**
 * @param {PauseIssue[]} issues
 * @returns {PauseIssue|null}
 */
function findTarget(issues) {
	for (const issue of issues) {
		const config = readNoticeConfig(issue.root);
		const tracker = resolveKey("tracker", { root: issue.root });
		if (
			config !== null &&
			typeof tracker === "string" &&
			tracker.toLowerCase() === config.repo.toLowerCase()
		)
			return issue;
	}
	return null;
}

/**
 * @param {string} file
 * @returns {PauseRecord|"absent"|"torn"}
 */
function readPauseRecord(file) {
	const read = readText(file);
	if (read.state === "absent") return "absent";
	if (read.state === "unreadable") return "torn";
	try {
		const value = JSON.parse(read.data);
		const target = value?.target;
		return typeof value?.pausedAt === "number" &&
			typeof value.root === "string" &&
			Array.isArray(value.issues) &&
			(target === null ||
				(typeof target?.root === "string" && typeof target.number === "number"))
			? {
					pausedAt: value.pausedAt,
					root: value.root,
					issues: value.issues,
					target,
					...(typeof value.filed === "number" ? { filed: value.filed } : {}),
				}
			: "torn";
	} catch (err) {
		if (err instanceof SyntaxError) return "torn";
		throw err;
	}
}

/** @param {string} key */
const buildPauseName = (key) => `no-progress pause ${key}`;

/**
 * @param {PauseRecord & {target: PauseIssue}} record
 * @param {string} key
 * @returns {import("./repo-hold-notices.js").NoticeCause}
 */
function buildPauseCause({ pausedAt, root, issues, target }, key) {
	const repo = path.basename(root);
	const name = `no-progress pause of ${repo} at ${new Date(pausedAt).toISOString()}`;
	/** @param {NoticeName} phase */
	const marker = (phase) => `refill-pause-notice ${key} ${phase}`;
	return {
		name,
		ref: `${name} in ${target.root}`,
		issue: target.number,
		marker,
		message: (phase) =>
			buildNoticeBody(
				phase === "raise"
					? `The refill loop paused ${repo}: no act from ${issues.join(", ")}. It launches nothing there until \`node ${scriptPath("refill-loop.js")} set --resume\`.`
					: `The refill loop's ${name}, on no act from ${issues.join(", ")}, has ended: it launches there again.`,
				marker(phase),
			),
	};
}

/** @param {string} root */
const buildFiledTitle = (root) =>
	`Refill loop: no-progress pause in ${path.basename(root)}`;

/**
 * @param {string} root
 * @param {string[]} issues
 */
const buildFiledBody = (root, issues) =>
	`The refill loop paused \`${root}\`: ${NO_PROGRESS_RUN} of its launches in a row finished with no act, from ${issues.join(", ")}. It launches nothing there until the founder resumes the loop. That checkout's tracker sets no \`founderNotice\`, so this issue carries the page.

**To clear:** look at those issues, then run \`node ${scriptPath("refill-loop.js")} set --resume\`. The loop closes this issue once the pause ends.`;

/**
 * @param {string} home
 * @returns {PauseFiler}
 */
const buildPauseFiler = (home) => ({
	home,
	file: (title, body) => {
		const filed = fileIncidentIssue(home, {
			title,
			body,
			why: "a no-progress pause is raised by the refill loop, with no asking session to hold its question (#5273)",
		});
		return typeof filed === "string" ? filed : filed.number;
	},
	close: (n, comment) => closeIncidentIssue(home, n, comment),
});

/**
 * @param {string} root
 * @param {Pause} pause
 * @param {PauseFiler} filer
 * @param {Log} log
 * @returns {PauseRecord|null}
 */
function startRecord(root, pause, filer, log) {
	const issues = pause.issues ?? [];
	const record = {
		pausedAt: pause.at,
		root,
		issues: issues.map(buildPauseIssueText),
	};
	const target = findTarget(issues);
	if (target !== null) return { ...record, target };
	const filed = filer.file(
		buildFiledTitle(root),
		buildFiledBody(root, record.issues),
	);
	const name = buildPauseName(buildNoticeKey(pause.at, root));
	if (typeof filed === "string") {
		log(
			`${name}: workflow-core issue not filed, the next tick retries: ${filed}`,
		);
		return null;
	}
	log(
		`${name}: filed #${filed}, ${path.basename(root)}'s tracker paging no one`,
	);
	return {
		...record,
		target: { root: filer.home, number: filed },
		filed,
	};
}

/**
 * @param {string} root
 * @param {Pause} pause
 * @param {Tend} tend
 */
function tendRaise(root, pause, { now, log, filer }) {
	const key = buildNoticeKey(pause.at, root);
	const file = buildNoticeFile(key);
	let record = readPauseRecord(file);
	if (record === "torn") {
		record = {
			pausedAt: pause.at,
			root,
			issues: (pause.issues ?? []).map(buildPauseIssueText),
			target: null,
		};
		writeNotice(file, {
			...record,
			raise: null,
			clear: null,
			isUnsetLogged: true,
		});
		log(`${buildPauseName(key)}: notice record torn, read as sent: ${file}`);
	}
	if (record === "absent") {
		const started = startRecord(root, pause, filer, log);
		if (started === null) return;
		record = started;
		writeNotice(file, {
			...record,
			raise: null,
			clear: null,
			isUnsetLogged: false,
		});
	}
	const { target } = record;
	if (target === null) return;
	const config = readNoticeConfig(target.root);
	if (config === null) return;
	tendPhase({
		cause: buildPauseCause({ ...record, target }, key),
		phase: "raise",
		file,
		config,
		paged: null,
		now,
		log,
	});
}

/**
 * @param {string} file
 * @param {string} key
 * @param {Tend} tend
 */
function tendClear(file, key, { now, log, filer }) {
	const record = readPauseRecord(file);
	if (record === "torn")
		log(
			`${buildPauseName(key)}: clear notice lost: its record will not read: ${file}`,
		);
	const target = typeof record === "string" ? null : record.target;
	const config = target === null ? null : readNoticeConfig(target.root);
	if (
		typeof record !== "string" &&
		target !== null &&
		config !== null &&
		isClearOwed(readNotice(file))
	) {
		tendPhase({
			cause: buildPauseCause({ ...record, target }, key),
			phase: "clear",
			file,
			config,
			paged: null,
			now,
			log,
		});
		return;
	}
	if (typeof record !== "string" && record.filed !== undefined) {
		const failed = filer.close(
			record.filed,
			`The refill loop's pause of \`${record.root}\` has ended: it launches there again.`,
		);
		if (failed) log(`${buildPauseName(key)}: ${failed}`);
	}
	fs.rmSync(file, { force: true });
}

/**
 * @param {Log} log
 * @returns {{file: string, key: string}[]}
 */
function readNoticeFiles(log) {
	try {
		return fs
			.readdirSync(noticeDir())
			.filter((name) => name.endsWith(NOTICE_SUFFIX))
			.map((name) => ({
				file: path.join(noticeDir(), name),
				key: name.slice(0, -NOTICE_SUFFIX.length),
			}));
	} catch (err) {
		if (caught(err).code !== "ENOENT")
			log(`pause notices unread: ${caught(err).message}`);
		return [];
	}
}

/**
 * @param {Record<string, Pause>} repoPaused
 * @param {number} now
 * @param {Log} log
 * @param {PauseFiler} filer
 */
function tendPauseNotices(repoPaused, now, log, filer) {
	const live = new Map(
		Object.entries(repoPaused).map(([root, pause]) => [
			buildNoticeKey(pause.at, root),
			{ root, pause },
		]),
	);
	/** @param {string} key @param {() => void} act */
	const guarded = (key, act) => {
		try {
			act();
		} catch (err) {
			log(`${buildPauseName(key)}: notice not tended: ${caught(err).message}`);
		}
	};
	for (const { file, key } of readNoticeFiles(log))
		if (!live.has(key))
			guarded(key, () => tendClear(file, key, { now, log, filer }));
	for (const [key, { root, pause }] of live)
		guarded(key, () => tendRaise(root, pause, { now, log, filer }));
}

module.exports = { buildPauseFiler, tendPauseNotices };
