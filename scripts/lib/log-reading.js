/*
 * log-reading.js — what a session-start reporter reading a guard's decision
 * log shares: finding each repo's root, reading the log, pairing each logged
 * question with the founder's reply, placing the reading point, printing the
 * repo, point and fired-line summaries, walking the corpus at most daily, and
 * filing the reading once (#1708, #3220). Its
 * callers are report-close-check-reading.js, the round-check reporter (#1711)
 * and the flip-line reporter (#2331), each passing what they differ on as
 * parameters.
 *
 * `broken` exits 2, so a caller is a CLI reporter, never a guard.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { errMessage } = require("./check");
const { streamRecords } = require("./encoding-use");
const { markersDir } = require("./marker-root");
const { buildSkipLine, periodicReading } = require("./periodic-reading");
const { isFounderMessage, textOf } = require("./tool-calls-since");
const { createIssue, findTrackingIssue } = require("./tracking-issue");
const { writeFd } = require("./write-fd.js");
const { readAdopterCheckouts, homeDir } = require("./refill-repos");
const { readSessionHead, repoRootOf } = require("./session-head.js");

const DAY_MS = 86_400_000;
const CLAIM = "filing";
/* A claim this old belongs to a run that died mid-filing. A guess, not a
 * measurement: the walk took 51 to 55 s at a load of about 27 (#3220), so 10
 * minutes leaves wide margin. A live run slower than that is overwritten, and
 * the gh check alone then stands between it and a second filing. */
const CLAIM_STALE_MS = 10 * 60_000;

/**
 * @typedef {{ at: string, session: string, kind: string }} LimbLogLine
 * @typedef {{ at: string, text: string }} Reply
 * @typedef {{ state: "fires" | "undecided" | "holds", text: string }} Verdict
 */

/** @param {string} message */
function broken(message) {
	writeFd(2, `BROKEN: ${message}\n`);
	process.exit(2);
}

/** @returns {number} */
function now() {
	const raw = process.env.WFC_NOW;
	if (!raw) return Date.now();
	const t = Date.parse(raw);
	if (Number.isNaN(t)) broken(`WFC_NOW is not a date: ${raw}`);
	return t;
}

/**
 * A failure line's verdict, and the words the reading prints for it.
 * @param {Verdict["state"]} state
 * @param {string} text
 * @returns {Verdict}
 */
const verdict = (state, text) => ({ state, text });

/**
 * Every adopter's root on this laptop, by its directory name, in name order.
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
 * Whether n of d is at or over a failure line's share; never with d at 0.
 * @param {number} n
 * @param {number} d
 * @param {number} line
 */
const isOverLine = (n, d, line) => (d ? n / d >= line : false);

/**
 * Each repo's line in a reading: live since its first log line, or why not.
 * @param {string[]} repos
 * @param {Map<string, number>} live
 * @param {Map<string, string>} roots
 * @param {string} logName the log, as the reading names it
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
 * The summary of a reading's numbered failure lines: which fired, and which
 * wait on replies being classified.
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
 * Each repo's root, from the first transcript whose recorded cwd resolves to
 * a repo of that name. Only project directories whose slug names the repo are
 * opened, newest transcript first, so a scan stops within a few heads.
 *
 * @param {string[]} files every seat's transcripts
 * @param {string[]} repos
 * @returns {{ roots: Map<string, string>, unreadHeads: number }} repo name →
 *   root, and the transcripts whose head would not read
 */
function readRepoRoots(files, repos) {
	/** @type {Map<string, string>} */
	const roots = new Map();
	let unreadHeads = 0;
	const mtime = (/** @type {string} */ f) => {
		try {
			return fs.statSync(f).mtimeMs;
		} catch {
			/* Fails open to last place (#1103): its head read below fails too,
			 * and is counted there. */
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
			/* Fails open (#1103): one transcript of many, so the next gives the
			 * root; the count is printed. */
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
 * One log's lines. Absent is no lines: the repo is not live yet.
 *
 * @param {string} file
 * @returns {LimbLogLine[]}
 * @throws on a log that will not read or a line that is not JSON
 */
function readLog(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") return [];
		throw new Error(`${file} will not read — ${code || message}`, {
			cause: e,
		});
	}
	/** @type {LimbLogLine[]} */
	const events = [];
	const lines = text.split("\n");
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch (e) {
			throw new Error(`${file}:${i + 1} is not JSON — ${errMessage(e)}`, {
				cause: e,
			});
		}
		if (Number.isNaN(Date.parse(row?.at)))
			throw new Error(`${file}:${i + 1} has no readable "at"`);
		events.push(row);
	}
	return events;
}

/**
 * Every repo's log lines, and when each repo went live: its first line.
 *
 * @param {Map<string, string>} roots repo name → root
 * @param {(root: string) => string} logOf the log's path under a root
 * @returns {{ events: LimbLogLine[], live: Map<string, number> }}
 * @throws as readLog does
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
 * The founder's messages in one session's transcript, oldest first, or null
 * where the transcript is not on this machine or will not read.
 *
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
		/* Fails open (#1103): its questions count as unanswered, and the
		 * reporter prints how many sessions went unread. */
		return null;
	}
	return replies;
}

/**
 * Each logged question of an answerable kind the founder replied to, paired
 * with that reply, his first message after it. A reply answers the last turn
 * let through before it: an earlier one the session overtook without his
 * speaking — a background job woken again — would count his one reply twice.
 * One Stop's events share `at`.
 *
 * @template {LimbLogLine} E
 * @param {E[]} events
 * @param {Map<string, string>} transcripts session id → transcript
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

/* Both readings' point figures, #1068 Q3 (A), which #1691 carried over to
 * the round reading. */
const POINT_FIGURES = {
	clockDays: 7,
	countTarget: 40,
	ceilingDays: 21,
	quorum: 1,
};

/**
 * The point is `clockDays` after the clock starts or the `countTarget`th
 * counted event, whichever is later, and at most `ceilingDays` after the first
 * repo went live. The clock starts when the `quorum`th repo goes live: for
 * POINT_FIGURES the first, so a repo going live later moves neither (#2115).
 *
 * @typedef {{ clockDays: number, countTarget: number, ceilingDays: number,
 *   quorum: number }} PointFigures
 * @typedef {{ point: number, ceiling: number, fixed: boolean, clock: number }} Point
 * `fixed` is false while the point can still move earlier than the ceiling;
 * `clock` is the first repo's live time until the quorum is met.
 */

/* Both readings' band about a baseline rate, a 95% normal interval (#1068,
 * #1691). */
const BAND_Z = 1.96;

/**
 * @param {number} p the baseline rate
 * @param {number} n questions read
 * @returns {number} the band's half-width, as a rate
 */
const bandHalfWidth = (p, n) => BAND_Z * Math.sqrt((p * (1 - p)) / n);

/**
 * When the reading is due, or null while no repo is live.
 *
 * @param {Map<string, number>} live repo → its first log line's time
 * @param {number[]} countedTimes each counted event's time, sorted
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
 * Whether the point is reached at `nowMs`, and the time figures are read up
 * to: the point once reached, else now.
 *
 * @param {Point | null} point
 * @param {number} nowMs
 * @returns {ReadingAt}
 */
function readingAt(point, nowMs) {
	const reached = point !== null && nowMs >= point.point;
	return { reached, cutoff: reached ? point.point : nowMs, nowMs };
}

/**
 * Whether an event stamped `stamp` falls inside the reading's window.
 *
 * @param {ReadingAt} at
 * @param {string} stamp
 * @returns {boolean}
 */
const isRead = (at, stamp) => Date.parse(stamp) <= at.cutoff;

/**
 * A reading's point section: the reporter's own "Reading point:" sentence,
 * which names its clock, then whether the point is reached.
 *
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
 * Take `file` as this run's claim. False where another run holds a live claim
 * or the issue is already recorded.
 *
 * @param {string} file
 * @returns {boolean}
 */
function claim(file) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, CLAIM, { flag: "wx" });
			return true;
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
		}
		let held;
		try {
			held = {
				text: fs.readFileSync(file, "utf8").trim(),
				age: Date.now() - fs.statSync(file).mtimeMs,
			};
		} catch (e) {
			/* Removed between the two calls: try the create again. */
			if (caught(e).code === "ENOENT") continue;
			throw e;
		}
		if (held.text !== CLAIM || held.age < CLAIM_STALE_MS) return false;
		fs.rmSync(file, { force: true });
	}
	return false;
}

/**
 * File the reading, unless its issue already exists, open or closed.
 *
 * @param {string} file the filed-once record
 * @param {{ title: string, label: string }} issue
 * @param {string} body
 * @returns {string} what happened, for the run to print
 * @throws where `gh` refuses; the claim is dropped so the next run retries
 */
function fileOnce(file, { title, label }, body) {
	if (!claim(file))
		return "Another run is filing the reading, or has filed it; nothing filed.";
	try {
		const existing = findTrackingIssue({ title }, "all");
		if (existing) {
			fs.writeFileSync(file, `#${existing.number}`);
			return `Already filed as #${existing.number}; nothing filed.`;
		}
		const url = createIssue({ title, labels: [label], body });
		fs.writeFileSync(file, url);
		return `Filed ${url}.`;
	} catch (e) {
		fs.rmSync(file, { force: true });
		throw e;
	}
}

/**
 * The filing half of a reporter that files one issue, once. Once its issue
 * exists, open or closed, it never files again: `record`, in the markers
 * directory, holds the issue and is the lock two session starts filing at
 * once contend for, and a `gh` check by title across open and closed issues
 * covers a record that is gone or was never written here (a worktree or
 * another clone). By title alone, since the session that takes the issue may
 * relabel it.
 *
 * @param {{ title: string, label: string, record: string, script: string,
 *   buildIssueBody: (reading: string) => string }} spec `record` is the marker's
 *   name, outside every marker sweep family; `script` is the command a failed
 *   filing tells the reader to retry
 */
function buildFiler({ title, label, record, script, buildIssueBody }) {
	const recordPath = () => path.join(markersDir(), record);
	const stampPath = () => `${recordPath()}-read-at`;
	const lockPath = () => `${recordPath()}-read.lock`;

	/** The issue the record holds, or null where none is recorded. */
	function readFiledAs() {
		try {
			const held = fs.readFileSync(recordPath(), "utf8").trim();
			return held && held !== CLAIM ? held : null;
		} catch {
			/* Fails open to "not recorded" (#1104): the claim and the gh check
			 * still stop a second filing. */
			return null;
		}
	}

	/**
	 * Print the reading, and file it where the point is reached and this is
	 * no dry run.
	 *
	 * @param {string} reading
	 * @param {{ reached: boolean, dryRun: boolean, filed: string | null }} at
	 */
	function publish(reading, { reached, dryRun, filed }) {
		/* Written synchronously: broken() exits straight after a failed filing,
		 * and a piped console.log could be lost with it. */
		writeFd(1, `${reading}\n`);
		if (!reached) return;
		if (dryRun) {
			console.log(
				filed
					? `\nDry run: the reading is filed as ${filed}.`
					: `\nDry run: the reading point is reached, so a plain run files this as "${title}".`,
			);
			return;
		}
		let outcome;
		try {
			outcome = fileOnce(
				recordPath(),
				{ title, label },
				buildIssueBody(reading),
			);
		} catch (e) {
			/* Unstamped, so the retry the message promises is not held off. */
			fs.rmSync(stampPath(), { force: true });
			return broken(
				`the reading would not file — ${errMessage(e)}\nNothing is recorded as filed, so the next session start tries again; run \`${script}\` to retry now.`,
			);
		}
		console.log(`\n${outcome}`);
	}

	/**
	 * Run `read`, the full walk of the logs and transcripts: at once on a dry
	 * run, otherwise at most daily and never beside another plain run's
	 * (#3220). A walk that exits through `broken` skips `finally`, so the lock
	 * drops on process exit; the stamp, written first, holds the next walk off
	 * for the day, except after a failed filing, which `publish` unstamps. One
	 * stamp serves every `--config-dir` set, so a hand run over other seats
	 * holds the session-start walk off too.
	 *
	 * @param {{ nowMs: number, dryRun: boolean }} run
	 * @param {() => void} read
	 */
	function readDaily({ nowMs, dryRun }, read) {
		if (dryRun) return read();
		const lock = lockPath();
		const release = () => fs.rmSync(lock, { force: true });
		let gate;
		try {
			gate = periodicReading(
				{ stamp: stampPath(), lock, nowMs, everyMs: DAY_MS },
				() => {
					process.once("exit", release);
					try {
						read();
					} finally {
						process.removeListener("exit", release);
					}
				},
			);
		} catch (e) {
			return broken(`the daily gate would not read — ${errMessage(e)}`);
		}
		if (!gate.ran) console.log(buildSkipLine(gate, "a day"));
	}

	return { readFiledAs, publish, readDaily };
}

module.exports = {
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
	pairReplies,
	POINT_FIGURES,
	bandHalfWidth,
	readingPoint,
	readingAt,
	isRead,
	buildPointLines,
	buildFiler,
};
