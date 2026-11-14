#!/usr/bin/env node
/*
 * throughput-readout.js — the throughput readout's command line (#5196):
 * total `COMPLETED` closes per hour over a window, banded by concurrent
 * sessions and by load1, beside the readings that judge admission's limits.
 *
 * THE READING IS NEVER A TARGET (#3212): no session, loop or filing rule aims
 * at it.
 *
 * IN NO FAMILY (code-standards §N3, §G4): it files nothing and gates nothing;
 * it prints a reading and exits 0, or 2 on a bad argument. A source
 * that will not read is named with the hours it lacks, never a failure. It
 * runs nowhere at session start: the transcript scan and the day-by-day
 * close fetch take minutes.
 *
 * Closes are fetched one UTC day at a time across the owner's repos, so the
 * 1,000-result search cap cannot truncate the window silently.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { childFailure, childVerdict } = require("./lib/child-failure.js");
const { citedIssues } = require("./lib/cited-issues.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { readTicks, tickLimb } = require("./lib/concurrency.js");
const { gh, parseErrLine, SEARCH_CAP } = require("./lib/gh.js");
const { gitOrNull } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	jobDirPath,
	jobStorePath,
	readJobRecordAt,
} = require("./lib/job-paths.js");
const { parseJsonl, readJsonl } = require("./lib/jsonl.js");
const { queueExitLogPath } = require("./lib/queue-exit-log.js");
const { scriptPath } = require("./lib/script-path.js");
const { seatsFrom } = require("./lib/seat-args.js");
const { readLogs, waitSpans } = require("./lib/suite-queue-replay.js");
const {
	LIMBS,
	MARGINAL_FROM_SESSIONS,
	THIN_HOURS,
	readout,
} = require("./lib/throughput-readout.js");
const { minuteLogPath } = require("./lib/windows-memory.js");
const { resolveKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("throughput-readout.js")} --since <utc> --until <utc> [options]
  --since, --until      the window, ISO UTC
  --era <label>=<utc>   split the bands where a change landed; repeatable
  --json                print the bands as JSON
  --owner <login>       whose repos' closes count (default: the tracker's owner)
  --checkout <owner/repo>=<dir>
                        a checkout whose commits cite that tracker's issues,
                        for reverts and commits per close; repeatable
                        (default: this checkout, for its tracker)
  --markers <dir>       the marker stores (default: the canonical checkout's)
  --config-dir <dir>    a seat whose job records to read; repeatable
                        (default: every seat)`;

const DAY_MS = 864e5;

/* Untraced: how far before the window the commit log is read, so a close's
 * commits landed before it are joined. */
const COMMIT_LOOKBACK_MS = 30 * DAY_MS;
/* Untraced: the transcript scan read a day of every seat in ~1 min at load
 * 6; the cap allows a month at load 30. */
const DENSE_TIMEOUT_MS = 60 * 60_000;
const REVERTS = /This reverts commit ([0-9a-f]{40})/;
/* A revert whose body line was edited out names its target by subject. */
const REVERT_SUBJECT = /^Revert "(.+)"$/;

/**
 * @param {string | undefined} s
 * @returns {number | null} null where `s` is no time
 */
function parseUtc(s) {
	const t = Date.parse(s ?? "");
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {string} message
 * @returns {2}
 */
function refuse(message) {
	writeFd(2, `${message}\n\n${USAGE}\n`);
	return 2;
}

/**
 * `<left>=<right>` split at its last `=`; null where either side is empty.
 * @param {string} spec
 */
function pairOf(spec) {
	const i = spec.lastIndexOf("=");
	return i < 1 || i === spec.length - 1
		? null
		: { left: spec.slice(0, i), right: spec.slice(i + 1) };
}

/**
 * Each UTC day the window touches, `YYYY-MM-DD`.
 * @param {number} since
 * @param {number} until
 */
function daysOf(since, until) {
	const out = [];
	for (
		let d = Date.parse(
			`${new Date(since).toISOString().slice(0, 10)}T00:00:00Z`,
		);
		d < until;
		d += DAY_MS
	)
		out.push(new Date(d).toISOString().slice(0, 10));
	return out;
}

/**
 * One day's `COMPLETED` closes across `owner`'s repos.
 * @param {string} owner
 * @param {string} date
 * @returns {{ day: import("./lib/throughput-readout.js").DayRow,
 *   closes: import("./lib/throughput-readout.js").CloseRow[] }}
 */
function fetchDay(owner, date) {
	/** @type {unknown} */
	let rows;
	try {
		rows = JSON.parse(
			gh([
				"search",
				"issues",
				"reason:completed",
				"--owner",
				owner,
				"--state",
				"closed",
				"--closed",
				date,
				"--limit",
				String(SEARCH_CAP),
				"--json",
				"number,repository,closedAt",
			]),
		);
	} catch (e) {
		return {
			day: { date, state: "failed", why: parseErrLine(e) },
			closes: [],
		};
	}
	if (!Array.isArray(rows))
		return {
			day: { date, state: "failed", why: "gh printed no list of issues" },
			closes: [],
		};
	if (rows.length >= SEARCH_CAP)
		return { day: { date, state: "truncated" }, closes: [] };
	const closes = rows.flatMap(closeRow);
	if (closes.length < rows.length)
		return {
			day: {
				date,
				state: "failed",
				why: `${rows.length - closes.length} issue(s) lacked a repository, number or close time`,
			},
			closes: [],
		};
	return { day: { date, state: "read" }, closes };
}

/**
 * One searched issue as a close; none where gh's row lacks a field.
 * @param {unknown} r
 * @returns {import("./lib/throughput-readout.js").CloseRow[]}
 */
function closeRow(r) {
	if (typeof r !== "object" || r === null) return [];
	const { number, closedAt, repository } =
		/** @type {Record<string, unknown>} */ (r);
	const repo =
		typeof repository === "object" && repository !== null
			? /** @type {Record<string, unknown>} */ (repository).nameWithOwner
			: undefined;
	const t = typeof closedAt === "string" ? Date.parse(closedAt) : Number.NaN;
	if (typeof number !== "number" || typeof repo !== "string" || Number.isNaN(t))
		return [];
	return [{ repo, number, closedAt: t, reason: "COMPLETED" }];
}

/**
 * The commits on `dir`'s default branch since `from`, each citing `repo`'s
 * issues; null where git would not read it.
 * @param {string} repo
 * @param {string} dir
 * @param {number} from
 * @returns {import("./lib/throughput-readout.js").CommitRow[] | null}
 */
function readCommits(repo, dir, from) {
	const branch =
		gitOrNull(["rev-parse", "--abbrev-ref", "origin/HEAD"], {
			cwd: dir,
		})?.trim() || "HEAD";
	const out = gitOrNull(
		[
			"log",
			`--since=${new Date(from).toISOString()}`,
			"--format=%x1e%H%x1f%cI%x1f%B",
			branch,
		],
		{ cwd: dir },
	);
	if (out === null) return null;
	const rows = out
		.split("\x1e")
		.filter((x) => x.trim())
		.map((x) => {
			const [sha = "", at = "", message = ""] = x.split("\x1f");
			return {
				sha: sha.trim(),
				t: Date.parse(at),
				subject: message.split("\n", 1)[0] ?? "",
				message,
			};
		});
	/** @type {Map<string, string>} */
	const bySubject = new Map();
	for (const c of [...rows].reverse()) bySubject.set(c.subject, c.sha);
	return rows.map((c) => ({
		repo,
		sha: c.sha,
		t: c.t,
		cites: [...citedIssues(c.message)],
		reverts:
			REVERTS.exec(c.message)?.[1] ??
			bySubject.get(REVERT_SUBJECT.exec(c.subject)?.[1] ?? "") ??
			null,
	}));
}

/**
 * Each job on every seat whose life touches the window: from its creation to
 * its first terminal state, else its record's last update; a finished job's
 * record keeps updating after it ends. Null where no seat's job store would read.
 * @param {string[]} seats
 * @param {number} since
 */
function readJobs(seats, since) {
	let read = false;
	/** @type {import("./lib/throughput-readout.js").JobRow[]} */
	const out = [];
	for (const seat of seats) {
		let ids;
		try {
			ids = fs.readdirSync(jobStorePath(seat));
		} catch {
			/* A seat with no job store holds no job; the readout names a
			 * window where none read at all (#5196). */
			continue;
		}
		read = true;
		for (const id of ids) {
			const row = jobRow(seat, id);
			if (row && row.en >= since) out.push(row);
		}
	}
	return read ? out : null;
}

/**
 * One job's life and template; null where its record is absent, torn or
 * carries no time.
 * @param {string} seat
 * @param {string} id
 * @returns {import("./lib/throughput-readout.js").JobRow | null}
 */
function jobRow(seat, id) {
	const r = readJobRecordAt(jobDirPath(seat, id));
	if (r.state !== "read" || !r.data) return null;
	const st = Date.parse(r.data.createdAt);
	const en = Date.parse(r.data.firstTerminalAt ?? r.data.updatedAt);
	if (Number.isNaN(st) || Number.isNaN(en)) return null;
	const { template } = r.data;
	return {
		id,
		template: typeof template === "string" ? template : null,
		st,
		en,
	};
}

/**
 * dense_minute.py's per-minute Bash round-trips and hook-timeout refusals
 * over the window; null, and why, where it gave none.
 * @param {number} since
 * @param {number} until
 */
function readTranscripts(since, until) {
	const r = spawnSync(
		"python3",
		[
			path.join(__dirname, "dense_minute.py"),
			"--since",
			String(since / 1000),
			"--until",
			String(until / 1000),
		],
		{
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
			timeout: DENSE_TIMEOUT_MS,
		},
	);
	if (r.status !== 0)
		return { rows: null, why: childFailure(childVerdict(r)) || "no output" };
	const rows = parseJsonl(r.stdout).rows.map((m) => ({
		t: Date.parse(String(m.minute)),
		bash: Array.isArray(m.bash_s)
			? m.bash_s.filter((/** @type {unknown} */ x) => typeof x === "number")
			: [],
		hto: typeof m.hto === "number" ? m.hto : 0,
	}));
	return { rows, why: null };
}

/**
 * The minute log's load1 and session count per line; null where it would not
 * read.
 */
function readMinutes() {
	const read = readJsonl(minuteLogPath());
	return read
		? read.rows.map((m) => ({
				t: Date.parse(String(m.ts)),
				load1: typeof m.load1 === "number" ? m.load1 : null,
				sessions: typeof m.sessions === "number" ? m.sessions : null,
			}))
		: null;
}

/** The refill tick record's rows; null where it would not read. */
function readTickRows() {
	const { ticks, unreadable } = readTicks();
	if (unreadable.length > 0) return null;
	return ticks.map((t) => ({
		t: Date.parse(t.at),
		live: t.live ?? null,
		loop: t.binding?.limit ?? null,
		limb: tickLimb(t),
	}));
}

/**
 * The queue's wait spans over the window; null where the queue-exit log is
 * absent.
 * @param {string} markers
 * @param {number} since
 * @param {number} until
 */
function readQueue(markers, since, until) {
	const logs = readLogs({
		markers,
		memwatch: [],
		minuteLog: minuteLogPath(),
		since,
		until,
	});
	if (logs.unread.absent.some((f) => f.endsWith(".suite-queue-exits.jsonl")))
		return null;
	return waitSpans(logs, { since, until });
}

/** @param {number | null} x @param {number} [dp] */
const num = (x, dp = 2) => (x === null ? "—" : x.toFixed(dp));
/** @param {number | null} x */
const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);

/**
 * One band dimension's table, an era at a time.
 * @param {string} title
 * @param {import("./lib/throughput-readout.js").Band[]} bands
 */
function renderBands(title, bands) {
	const head = [
		"band",
		"hours",
		"closes/h",
		"per sess-h",
		"reverted",
		"commits/close",
		"queued",
		"bash p50 s",
		"hto/h",
		`limb ${LIMBS.join("/")}`,
		"hand/dispatched h",
	];
	const lines = [];
	for (const era of [...new Set(bands.map((b) => b.era))]) {
		lines.push(`${title} — era ${era}`, `  ${head.join(" | ")}`);
		for (const b of bands.filter((x) => x.era === era))
			lines.push(
				`  ${[
					b.band + (b.thin ? " (thin)" : ""),
					num(b.hours, 1),
					num(b.closesPerHour),
					num(b.closesPerSessionHour),
					`${b.reverted} (${pct(b.revertRate)})`,
					num(b.commitsPerClose, 1),
					pct(b.queueShare),
					num(b.bashMedianS),
					num(b.refusalsPerHour),
					b.limbShare
						? LIMBS.map((l) => pct(b.limbShare?.[l] ?? 0)).join("/")
						: "—",
					`${num(b.handOpenedHours, 1)}/${num(b.dispatchedHours, 1)}`,
				].join(" | ")}`,
			);
	}
	return lines;
}

/**
 * The readout as text.
 * @param {import("./lib/throughput-readout.js").Readout} r
 */
function render(r) {
	const out = [
		`Throughput readout, ${r.since} to ${r.until} UTC — a reading, never a target (#3212).`,
		`Closes are COMPLETED only, reverted closes subtracted. A band under ${THIN_HOURS} hours is thin and states no plateau.`,
		"",
		...renderBands("By sessions", r.sessions),
		"",
		...renderBands("By load1", r.load),
		"",
	];
	for (const p of r.plateau)
		out.push(
			p.none
				? `Plateau, era ${p.era}: none stated — ${p.none}.`
				: `Plateau, era ${p.era}: closes per hour peak at ${p.peak} sessions; the fewest sessions whose interval reaches it: ${p.from}.`,
		);
	for (const m of r.marginalQueueWait)
		out.push(
			m.slope === null
				? `Marginal queue wait, era ${m.era}: none — ${m.none}.`
				: `Marginal queue wait, era ${m.era}: ${num(m.slope)} queued min/h per added session, 95% [${num(m.ci?.[0] ?? null)}, ${num(m.ci?.[1] ?? null)}], over ${m.hours} hour(s) at ${MARGINAL_FROM_SESSIONS}+ sessions${m.thin ? `, thin: under ${THIN_HOURS} hours, no plateau read from it` : ""}.`,
		);
	for (const x of r.lacking)
		out.push(`Lacking — ${x.source}: ${num(x.hours, 1)} h, ${x.why}.`);
	if (r.truncatedDays.length > 0)
		out.push(
			`Truncated — ${r.truncatedDays.join(", ")} hit the ${SEARCH_CAP}-result search cap; their closes are not counted.`,
		);
	for (const d of r.failedDays)
		out.push(`Unread — closes on ${d.date}: ${d.why}`);
	for (const c of r.commitsUnread)
		out.push(
			`No commit log — ${c.repo}: ${c.closes} close(s) left out of reverts and commits per close; pass --checkout.`,
		);
	return out.join("\n");
}

/**
 * @typedef {{ since: number, until: number, json: boolean,
 *   eras: { label: string, from: number }[], owner: string,
 *   checkouts: { repo: string, dir: string }[], markers: string,
 *   seats: string[] }} Options
 */

/**
 * `<label>=<right>` pairs off a list flag, or the refusal of the first that
 * `check` rejects.
 * @template T
 * @param {string[] | undefined} specs
 * @param {(p: { left: string, right: string }) => T | null} check
 * @param {string} shape
 * @returns {T[] | 2}
 */
function pairsOf(specs, check, shape) {
	const out = [];
	for (const spec of specs ?? []) {
		const p = pairOf(spec);
		const v = p && check(p);
		if (v === null) return refuse(`${spec} is not ${shape}`);
		out.push(v);
	}
	return out;
}

/**
 * The owner whose closes count and the marker stores, from the flags or this
 * checkout; a checkout for its tracker is added where none was given.
 * @param {Record<string, string | true>} flags
 * @param {{ repo: string, dir: string }[]} checkouts  accumulator
 * @returns {{ owner: string, markers: string } | 2}
 */
function homeOf(flags, checkouts) {
	const root = hostRoot();
	const given = flagValue(flags, "--owner");
	const tracker =
		checkouts.length > 0 && given ? null : resolveKey("tracker", { root });
	if (checkouts.length === 0 && typeof tracker === "string")
		checkouts.push({ repo: tracker, dir: root });
	const owner =
		given ?? (typeof tracker === "string" ? tracker.split("/")[0] : undefined);
	if (!owner) return refuse("no tracker resolves an owner; pass --owner");
	const named = flagValue(flags, "--markers");
	const exitLog = named ? null : queueExitLogPath(root);
	const markers = named ?? (exitLog && path.dirname(exitLog));
	if (!markers)
		return refuse("git names no canonical checkout; pass --markers");
	return { owner, markers };
}

/**
 * The options argv gives, defaults resolved, or the exit code of a refusal.
 * @param {string[]} argv
 * @returns {Options | 0 | 2}
 */
function readArgs(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: {
			"--since": "value",
			"--until": "value",
			"--era": "list",
			"--json": "boolean",
			"--owner": "value",
			"--checkout": "list",
			"--markers": "value",
			"--config-dir": "list",
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags, lists } = parsed;
	const since = parseUtc(flagValue(flags, "--since"));
	const until = parseUtc(flagValue(flags, "--until"));
	if (since === null || until === null || since >= until)
		return refuse("--since and --until must each be a time, --since first");
	const eras = pairsOf(
		lists["--era"],
		(p) => {
			const from = parseUtc(p.right);
			return from === null ? null : { label: p.left, from };
		},
		"<label>=<utc>",
	);
	if (eras === 2) return 2;
	const checkouts = pairsOf(
		lists["--checkout"],
		(p) => (p.left.includes("/") ? { repo: p.left, dir: p.right } : null),
		"<owner/repo>=<dir>",
	);
	if (checkouts === 2) return 2;
	const home = homeOf(flags, checkouts);
	if (home === 2) return 2;
	return {
		since,
		until,
		json: flags["--json"] === true,
		eras,
		...home,
		checkouts,
		seats: seatsFrom(lists["--config-dir"]),
	};
}

/**
 * Every source read over the window.
 * @param {Options} o
 */
function readRecords(o) {
	const fetched = daysOf(o.since, o.until).map((d) => fetchDay(o.owner, d));
	/** @type {import("./lib/throughput-readout.js").CommitRow[]} */
	const commits = [];
	const logRepos = [];
	for (const c of o.checkouts) {
		const rows = readCommits(c.repo, c.dir, o.since - COMMIT_LOOKBACK_MS);
		if (!rows) continue;
		commits.push(...rows);
		logRepos.push(c.repo);
	}
	const transcripts = readTranscripts(o.since, o.until);
	const dispatchLog = readJsonl(
		path.join(o.markers, ".pick-next", "dispatched.jsonl"),
	);
	/** @type {import("./lib/throughput-readout.js").Records} */
	const records = {
		since: o.since,
		until: o.until,
		cores: os.cpus().length,
		eras: o.eras,
		minutes: readMinutes(),
		ticks: readTickRows(),
		closes: fetched.flatMap((f) => f.closes),
		days: fetched.map((f) => f.day),
		commits,
		logRepos,
		queue: readQueue(o.markers, o.since, o.until),
		transcripts: transcripts.rows,
		jobs: readJobs(o.seats, o.since),
		dispatched: (dispatchLog?.rows ?? []).flatMap((x) =>
			typeof x.jobId === "string" ? [x.jobId] : [],
		),
	};
	if (transcripts.why)
		records.transcriptsWhy = `dense_minute.py gave no per-minute output: ${transcripts.why}`;
	return records;
}

/** @returns {0 | 2} */
function main() {
	const o = readArgs(process.argv.slice(2));
	if (typeof o === "number") return o;
	const r = readout(readRecords(o));

	writeFd(1, `${o.json ? JSON.stringify(r, null, "\t") : render(r)}\n`);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
