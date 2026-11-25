const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { errMessage, now: checkNow } = require("./check");
const { streamRecords } = require("./encoding-use");
const { readJsonl } = require("./jsonl.js");
const { scriptPath } = require("./script-path.js");
const { markersDir } = require("./marker-root");
const { pidLock } = require("./pid-lock.js");
const { buildSkipLine, periodicReading } = require("./periodic-reading");
const { isFounderMessage, textOf } = require("./tool-calls-since");
const { createIssue, findTrackingIssue } = require("./tracking-issue");
const { writeFd } = require("./write-fd.js");
const { readAdopterCheckouts, homeDir } = require("./refill-repos");
const { readSessionHead, repoRootOf } = require("./session-head.js");

const DAY_MS = 86_400_000;
const OLD_CLAIM = "filing";

/**
 * @typedef {{ at: string, session: string, kind: string }} LimbLogLine
 * @typedef {{ at: string, text: string }} Reply
 * @typedef {{ state: "fires" | "undecided" | "holds", text: string }} Verdict
 */

/**
 * @param {string} message
 * @returns {never}
 */
function broken(message) {
	writeFd(2, `BROKEN: ${message}\n`);
	process.exit(2);
}

/** @returns {number} */
function now() {
	try {
		return checkNow();
	} catch (e) {
		return broken(errMessage(e));
	}
}

/**
 * @param {Verdict["state"]} state
 * @param {string} text
 * @returns {Verdict}
 */
const verdict = (state, text) => ({ state, text });

/**
 * @returns {Map<string, string>}
 */
const readAdopterRoots = () =>
	new Map(
		readAdopterCheckouts(homeDir())
			.included.map(
				(root) => /** @type {[string, string]} */ ([path.basename(root), root]),
			)
			.sort(([a], [b]) => a.localeCompare(b)),
	);

/** @param {number} t */
const minute = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

/**
 * @param {number} n
 * @param {number} d
 */
const ratio = (n, d) =>
	d ? `${n} of ${d} (${Math.round((n / d) * 100)}%)` : `${n} of 0`;

/**
 * @param {number} n
 * @param {number} d
 * @param {number} line
 */
const isOverLine = (n, d, line) => (d ? n / d >= line : false);

/**
 * @param {string[]} repos
 * @param {Map<string, number>} live
 * @param {Map<string, string>} roots
 * @param {string} logName
 * @returns {string[]}
 */
function buildRepoLines(repos, live, roots, logName) {
	return repos.map((name) => {
		const first = live.get(name);
		return first === undefined
			? `- ${name}: ${roots.has(name) ? `no ${logName} log line yet` : "no transcript records its working directory"}`
			: `- ${name}: live since ${minute(first)}`;
	});
}

/**
 * @param {{ state: "fires" | "undecided" | "holds" }[]} verdicts
 * @returns {string}
 */
function buildFiredLine(verdicts) {
	const linesIn = (/** @type {string} */ state) => {
		const ns = verdicts.flatMap((v, i) => (v.state === state ? [i + 1] : []));
		return ns.length > 0
			? `line${ns.length > 1 ? "s" : ""} ${ns.join(" and ")}`
			: "";
	};
	return `Fired: ${linesIn("fires") || "none"}.${linesIn("undecided") ? ` Undecided until the listed replies are classified: ${linesIn("undecided")}.` : ""}`;
}

/**
 * @param {string[]} files
 * @param {string[]} repos
 * @returns {{ roots: Map<string, string>, unreadHeads: number }}
 */
function readRepoRoots(files, repos) {
	/** @type {Map<string, string>} */
	const roots = new Map();
	let unreadHeads = 0;
	const mtime = (/** @type {string} */ f) => {
		try {
			return fs.statSync(f).mtimeMs;
		} catch {
			return 0;
		}
	};
	const named = files
		.filter((f) =>
			repos.some((r) => path.basename(path.dirname(f)).includes(r)),
		)
		.sort((a, b) => mtime(b) - mtime(a));
	for (const file of named) {
		if (roots.size === repos.length) break;
		let cwd;
		try {
			cwd = readSessionHead(file).cwd;
		} catch {
			unreadHeads++;
			continue;
		}
		const root = cwd && repoRootOf(cwd);
		const name = root && path.basename(root);
		if (name && repos.includes(name) && !roots.has(name)) roots.set(name, root);
	}
	return { roots, unreadHeads };
}

/**
 * @param {string} file
 * @returns {LimbLogLine[]}
 */
function readLog(file) {
	let read;
	try {
		read = readJsonl(file);
	} catch (e) {
		const { code, message } = caught(e);
		throw new Error(`${file} will not read — ${code || message}`, {
			cause: e,
		});
	}
	if (!read) return [];
	const [bad] = read.bad;
	if (bad !== undefined) throw new Error(`${file}:${bad} is not a JSON object`);
	for (const { row, line } of read.entries)
		if (Number.isNaN(Date.parse(String(row.at))))
			throw new Error(`${file}:${line} has no readable "at"`);
	return /** @type {LimbLogLine[]} */ (read.rows);
}

/**
 * @param {Map<string, string>} roots
 * @param {(root: string) => string} logOf
 * @returns {{ events: LimbLogLine[], live: Map<string, number> }}
 */
function readLogs(roots, logOf) {
	/** @type {LimbLogLine[]} */
	const events = [];
	/** @type {Map<string, number>} */
	const live = new Map();
	for (const [name, root] of roots) {
		const logged = readLog(logOf(root));
		const [first] = logged;
		if (first !== undefined) live.set(name, Date.parse(first.at));
		events.push(...logged);
	}
	return { events, live };
}

/**
 * @param {string | undefined} file
 * @returns {Reply[] | null}
 */
function founderReplies(file) {
	if (!file) return null;
	/** @type {Reply[]} */
	const replies = [];
	try {
		for (const rec of streamRecords(file, "main"))
			if (isFounderMessage(rec))
				replies.push({ at: rec.timestamp, text: textOf(rec) });
	} catch {
		return null;
	}
	return replies;
}

/**
 * @template {LimbLogLine} E
 * @param {E[]} events
 * @param {Map<string, string>} transcripts
 * @param {(kind: E["kind"]) => boolean} answerable
 * @returns {{ answered: { event: E, reply: Reply }[], unreadSessions: number }}
 */
function pairReplies(events, transcripts, answerable) {
	/** @type {Map<string, Reply[] | null>} */
	const repliesBySession = new Map();
	/** @type {{ event: E, reply: Reply }[]} */
	const paired = [];
	let unreadSessions = 0;
	for (const event of events) {
		if (!answerable(event.kind)) continue;
		if (!repliesBySession.has(event.session)) {
			const replies = founderReplies(transcripts.get(event.session));
			if (!replies) unreadSessions++;
			repliesBySession.set(event.session, replies);
		}
		const t = Date.parse(event.at);
		const reply = repliesBySession
			.get(event.session)
			?.find((r) => Date.parse(r.at) > t);
		if (reply) paired.push({ event, reply });
	}
	/** @type {Map<string, number>} */
	const lastTurn = new Map();
	const key = (/** @type {{ event: E, reply: Reply }} */ a) =>
		`${a.event.session} ${a.reply.at}`;
	for (const a of paired)
		lastTurn.set(
			key(a),
			Math.max(lastTurn.get(key(a)) ?? 0, Date.parse(a.event.at)),
		);
	return {
		answered: paired.filter(
			(a) => Date.parse(a.event.at) === lastTurn.get(key(a)),
		),
		unreadSessions,
	};
}

// guess, workflow-core#1068
const POINT_FIGURES = {
	clockDays: 7,
	countTarget: 40,
	ceilingDays: 21,
	quorum: 1,
};

/**
 * @typedef {{ clockDays: number, countTarget: number, ceilingDays: number,
 *   quorum: number }} PointFigures
 * @typedef {{ point: number, ceiling: number, fixed: boolean, clock: number }} Point
 */

const Z_FOR_95_PERCENT = 1.96;

/**
 * @param {number} p
 * @param {number} n
 * @returns {number}
 */
const bandHalfWidth = (p, n) => Z_FOR_95_PERCENT * Math.sqrt((p * (1 - p)) / n);

/**
 * @param {Map<string, number>} live
 * @param {number[]} countedTimes
 * @param {PointFigures} [figures]
 * @returns {Point | null}
 */
function readingPoint(live, countedTimes, figures = POINT_FIGURES) {
	const starts = [...live.values()].sort((a, b) => a - b);
	const [first] = starts;
	if (first === undefined) return null;
	const ceiling = first + figures.ceilingDays * DAY_MS;
	const clock = starts[figures.quorum - 1];
	const target = countedTimes[figures.countTarget - 1];
	if (clock === undefined || target === undefined)
		return { point: ceiling, ceiling, fixed: false, clock: clock ?? first };
	const point = Math.min(
		ceiling,
		Math.max(clock + figures.clockDays * DAY_MS, target),
	);
	return { point, ceiling, fixed: true, clock };
}

/**
 * @typedef {{ reached: boolean, cutoff: number, nowMs: number }} ReadingAt
 */

/**
 * @param {Point | null} point
 * @param {number} nowMs
 * @returns {ReadingAt}
 */
function readingAt(point, nowMs) {
	const reached = point !== null && nowMs >= point.point;
	return { reached, cutoff: reached ? point.point : nowMs, nowMs };
}

/**
 * @param {ReadingAt} at
 * @param {string} stamp
 * @returns {boolean}
 */
const isRead = (at, stamp) => Date.parse(stamp) <= at.cutoff;

/**
 * @param {string} sentence
 * @param {ReadingAt} at
 * @returns {string[]}
 */
const buildPointLines = (sentence, { reached, cutoff, nowMs }) => [
	"",
	sentence,
	reached
		? `Reached: figures are read up to ${minute(cutoff)}.`
		: `Not reached at ${minute(nowMs)}: figures so far.`,
];

/**
 * @param {string} file
 */
function readFiledRecord(file) {
	let held;
	try {
		held = fs.readFileSync(file, "utf8").trim();
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	return held && held !== OLD_CLAIM ? held : null;
}

/**
 * @param {{ file: string, script: string }} at
 * @param {{ title: string, label: string }} issue
 * @param {string} body
 * @returns {string}
 */
function fileOnce({ file, script }, { title, label }, body) {
	const elsewhere =
		"Another run is filing the reading, or has filed it; nothing filed.";
	const lock = pidLock(`${file}.lock`, script);
	if (!lock.acquire()) return elsewhere;
	try {
		if (readFiledRecord(file)) return elsewhere;
		const existing = findTrackingIssue({ title }, "all");
		if (existing) {
			fs.writeFileSync(file, `#${existing.number}`);
			return `Already filed as #${existing.number}; nothing filed.`;
		}
		const url = createIssue({ title, labels: [label], body });
		fs.writeFileSync(file, url);
		return `Filed ${url}.`;
	} finally {
		lock.release();
	}
}

/**
 * @param {{ title: string, label: string, record: string, script: string,
 *   buildIssueBody: (reading: string) => string }} spec
 */
function buildFiler({ title, label, record, script, buildIssueBody }) {
	const recordPath = () => path.join(markersDir(), record);
	const stampPath = () => `${recordPath()}-read-at`;
	const lockPath = () => `${recordPath()}-read.lock`;

	function readFiledAs() {
		try {
			return readFiledRecord(recordPath());
		} catch {
			return null;
		}
	}

	/**
	 * @param {string} reading
	 * @param {{ reached: boolean, dryRun: boolean, filed: string | null }} at
	 */
	function publish(reading, { reached, dryRun, filed }) {
		writeFd(1, `${reading}\n`);
		if (!reached) return;
		if (dryRun) {
			writeFd(
				1,
				`${
					filed
						? `\nDry run: the reading is filed as ${filed}.`
						: `\nDry run: the reading point is reached, so a plain run files this as "${title}".`
				}\n`,
			);
			return;
		}
		let outcome;
		try {
			outcome = fileOnce(
				{ file: recordPath(), script },
				{ title, label },
				buildIssueBody(reading),
			);
		} catch (e) {
			fs.rmSync(stampPath(), { force: true });
			return broken(
				`the reading would not file — ${errMessage(e)}\nNothing is recorded as filed, so the next session start tries again; run \`node ${scriptPath(script)}\` to retry now.`,
			);
		}
		writeFd(1, `\n${outcome}\n`);
	}

	/**
	 * @param {{ nowMs: number, dryRun: boolean }} run
	 * @param {() => void} read
	 */
	function readDaily({ nowMs, dryRun }, read) {
		if (dryRun) return read();
		let gate;
		try {
			gate = periodicReading(
				{
					stamp: stampPath(),
					lock: lockPath(),
					script,
					nowMs,
					everyMs: DAY_MS,
				},
				read,
			);
		} catch (e) {
			return broken(`the daily gate would not read — ${errMessage(e)}`);
		}
		if (!gate.ran) writeFd(1, `${buildSkipLine(gate, "a day")}\n`);
	}

	return { readFiledAs, publish, readDaily };
}

module.exports = {
	DAY_MS,
	broken,
	now,
	verdict,
	readAdopterRoots,
	minute,
	ratio,
	isOverLine,
	readRepoRoots,
	readLogs,
	buildRepoLines,
	buildFiredLine,
	founderReplies,
	pairReplies,
	POINT_FIGURES,
	bandHalfWidth,
	readingPoint,
	readingAt,
	isRead,
	buildPointLines,
	buildFiler,
};
