#!/usr/bin/env node
/*
 * check-stop-guard-outcomes.js — report a Stop guard that has stopped reading
 * the turn it is judging.
 *
 * Usage:  npm run check:stop-guards  [--days <n>] [--root <dir>] [--notify]
 *
 * The node `Stop` guards judge the turn they stop. Most read its outgoing
 * text, which mantahostels#1275 takes off the Stop payload's `last_assistant_message`;
 * guard-lost-deny and guard-session-ceiling read the transcript instead.
 *
 * This is the standing read (mantahostels#1254): a guard that goes blind again — a harness
 * that stops supplying the field, a regression in the seam — surfaces at the
 * next `npm run status` instead of at the next audit.
 *
 * WHAT IT READS: the `.hook-ran-<guard>-<session>` breadcrumbs in
 * `hook-record.js`'s `recordsDir` — `.hook-breadcrumbs/`, the repository root
 * until mantahostels#3382 and under `.claude/tmp/markers/` since F8
 * (mantahostels#3515, #2). One JSON line per invocation. Each line is
 * self-contained and names its own guard and session, so files are read whole
 * and never parsed for a name — the guard name sits between prefix and session
 * id and carries hyphens of its own.
 *
 * REPORTS ONLY. Not in `.husky/pre-commit` and not in
 * CI, which would find no breadcrumbs anyway — they exist only on the machine the
 * sessions ran on. Under --notify every outcome exits 0, BROKEN included (mantahostels#155
 * decision 3).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reads the Stop-guard breadcrumbs and reports the outcome distribution when a guard has stopped reaching a verdict.
 * JUSTIFIED: fail-safe — a Stop guard that reads nothing blocks nothing, and is byte-for-byte identical on disk to one finding no defect (mantahostels#1254).
 * DEFEAT:    none; --notify is silent while every guard reaches a verdict, and says a standing fault once per distribution rather than every session.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const deliveryStamp = require("./lib/delivery-stamp");
const hookRecord = require("./lib/hook-record");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { parseJsonl } = require("./lib/jsonl.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @typedef {import("./lib/check").CheckResult} CheckResult (mantahostels#1315) */

/**
 * One breadcrumb line, as this checker reads it.
 * @typedef {{guard?: unknown, session?: unknown, outcome?: unknown,
 *   source?: unknown, capped?: unknown, at?: unknown}} Crumb
 */

/**
 * How far back a run reads by default.
 *
 * Coupled to `MIN_SAMPLE` below: the floor is reachable only because this many
 * days at ~200 invocations per guard per day clears it several times over.
 */
const DEFAULT_DAYS = 2;

/**
 * Below this many lines a guard gets no verdict at all.
 *
 * Derivation, and what 20 cost: mantahostels#1254.
 */
const MIN_SAMPLE = 50;

/**
 * The share of invocations reaching no verdict that is reported.
 *
 * It sits between the 3.6% of turns that legitimately end with no text and the
 * 91.4% the defect ran at (mantahostels#1291).
 */
const BLIND_SHARE = 0.1;

const VERDICT_OUTCOMES = new Set(hookRecord.VERDICT_OUTCOMES);

/** @param {Crumb} line */
const isSentinel = (line) => line.capped === true;

/**
 * The names in the breadcrumb directory; none where it does not exist yet.
 * @param {string} dir
 * @returns {string[]}
 */
function listRecordNames(dir) {
	try {
		return fs.readdirSync(dir);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw new Error(`cannot read ${dir}: ${e}`, { cause: e });
	}
}

/**
 * Every object line of `raw`.
 * @param {string} raw
 * @returns {{crumbs: Crumb[], torn: number}} the lines, and how many would not
 *   parse
 */
function parseCrumbLines(raw) {
	const read = parseJsonl(raw);
	return {
		crumbs: /** @type {Crumb[]} */ (read.rows),
		torn: read.bad.length,
	};
}

/**
 * Every breadcrumb line at `root`, newest last within each file.
 *
 * A file that will not read and a line that will not parse are both counted and
 * reported rather than ending the read.
 * @param {string} root
 * @returns {{lines: Crumb[], files: number, unreadable: string[], torn: number,
 *   vanished: number}}
 */
function readBreadcrumbs(root) {
	/** @type {Crumb[]} */
	const lines = [];
	/** @type {string[]} */
	const unreadable = [];
	let torn = 0;
	let vanished = 0;
	/* THE ROOT IS READ, and read FIRST, even though no breadcrumb sits there
	 * (mantahostels#3382): a `--root` that does not exist is a broken invocation —
	 * a typo, a path built wrong — and must stay BROKEN rather than reading as a
	 * clean tree. */
	try {
		fs.readdirSync(root);
	} catch (e) {
		throw new Error(`cannot read ${root}: ${e}`, { cause: e });
	}
	/* Their own directory (mantahostels#3382). Absent means no Stop guard has run in
	 * this tree yet — a fresh clone, or a checkout older than that directory — which is
	 * an empty sample, not a fault. Any other failure still is one. */
	const dir = hookRecord.recordsDir(root);
	const names = listRecordNames(dir);
	let files = 0;
	for (const name of names) {
		if (!name.startsWith(hookRecord.PREFIX)) continue;
		files++;
		let raw;
		try {
			raw = fs.readFileSync(path.join(dir, name), "utf8");
		} catch (e) {
			/* Gone between the readdir and the read. `prune-markers --detach`
			 * runs at every session start, and a session can start while this check
			 * walks the directory, so the two can race. Counted, not reported, so an epidemic — which would be
			 * something else — still shows (mantahostels#2545). */
			if (caught(e).code === "ENOENT") vanished++;
			else unreadable.push(name);
			continue;
		}
		const parsed = parseCrumbLines(raw);
		for (const crumb of parsed.crumbs) lines.push(crumb);
		torn += parsed.torn;
	}
	return { lines, files, unreadable, torn, vanished };
}

/**
 * @typedef {{guard: string, invocations: number, verdict: number,
 *   noVerdict: number, fallback: number, impossible: number,
 *   sessions: Set<string>, outcomes: Map<string, number>,
 *   everSeen: boolean}} Stats
 */

/**
 * @param {string} guard
 * @returns {Stats}
 */
const emptyStats = (guard) => ({
	guard,
	invocations: 0,
	verdict: 0,
	noVerdict: 0,
	fallback: 0,
	impossible: 0,
	sessions: new Set(),
	outcomes: new Map(),
	everSeen: false,
});

/**
 * Per-guard counts over the window, plus whether the guard has ever been seen
 * at all — a guard with a history and nothing inside the window is the shape a
 * guard silently unwired takes.
 *
 * @param {Crumb[]} lines
 * @param {number} cutoff epoch ms; a line stamped earlier counts only as history
 * @returns {Map<string, Stats>}
 */
function summarise(lines, cutoff) {
	/** @type {Map<string, Stats>} */
	const byGuard = new Map();
	for (const line of lines) {
		if (isSentinel(line)) continue;
		/* Normalised at read time, not only at write time: `guardName` has not
		 * always stripped the script suffix, so `guard-priced-options.js` and
		 * `guard-priced-options` are the same guard on disk (mantahostels#2545). */
		const guard = hookRecord.normaliseGuardName(
			typeof line.guard === "string" ? line.guard : "unknown-guard",
		);
		let s = byGuard.get(guard);
		if (!s) {
			s = emptyStats(guard);
			byGuard.set(guard, s);
		}
		s.everSeen = true;
		/* An unparseable stamp cannot be windowed, so the line is history. */
		const at = Date.parse(String(line.at));
		if (!Number.isFinite(at) || at < cutoff) continue;
		tallyInWindow(s, line);
	}
	return byGuard;
}

/**
 * Counts one in-window line into its guard's stats.
 * @param {Stats} s accumulator: the guard's counts, bumped for this line
 * @param {Crumb} line
 */
function tallyInWindow(s, line) {
	s.invocations++;
	if (typeof line.session === "string") s.sessions.add(line.session);
	const outcome = String(line.outcome);
	s.outcomes.set(outcome, (s.outcomes.get(outcome) || 0) + 1);
	if (VERDICT_OUTCOMES.has(outcome)) s.verdict++;
	else s.noVerdict++;
	if (line.source === hookRecord.SOURCE_TRANSCRIPT) s.fallback++;
	if (line.source === hookRecord.SOURCE_PAYLOAD && outcome === "empty-message")
		s.impossible++;
}

/** @param {Stats} s */
function distribution(s) {
	const parts = [...s.outcomes.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([outcome, n]) => `${outcome} ${n} (${pct(n / s.invocations)})`);
	return `  ${s.guard}: ${s.invocations} invocation(s) over ${s.sessions.size} session(s) — ${parts.join(", ")}`;
}

/** @param {number} share */
const pct = (share) => `${(share * 100).toFixed(1)}%`;

/**
 * A finding waiting to be raised, or swallowed as already delivered.
 * @typedef {{severity: "fail"|"warn", tag: string, message: string,
 *   data: {guard?: string, name?: string, count?: number, share?: number,
 *     invocations?: number},
 *   stats?: Stats}} Pending
 */

/**
 * The findings about the breadcrumb read itself — torn lines and unreadable
 * files — before any guard is judged.
 * @param {ReturnType<typeof readBreadcrumbs>} read
 * @returns {Pending[]}
 */
function breadcrumbReadFindings(read) {
	/** @type {Pending[]} */
	const pending = [];
	if (read.torn)
		pending.push({
			severity: "warn",
			tag: "TORN",
			message: `${read.torn} breadcrumb line(s) would not parse, so the rates below are measured over fewer records than were written — a writer died mid-append, or is doing so repeatedly`,
			data: { count: read.torn },
		});
	for (const name of read.unreadable)
		pending.push({
			severity: "warn",
			tag: "UNREADABLE",
			message: `breadcrumb ${name} could not be read`,
			data: { name },
		});
	return pending;
}

/**
 * The findings about one guard over the window.
 * @param {Stats} s
 * @param {{days: number, someGuardRan: boolean}} opts
 * @returns {Pending[]}
 */
function guardFindings(s, { days, someGuardRan }) {
	/** @type {Pending[]} */
	const out = [];
	if (!s.invocations) {
		if (someGuardRan)
			out.push({
				severity: "warn",
				tag: "SILENT",
				message: `${s.guard} has recorded nothing in the last ${days} day(s) while its sibling recorded — the harness may no longer be firing it`,
				data: { guard: s.guard },
				stats: s,
			});
		return out;
	}
	if (s.impossible)
		out.push({
			severity: "fail",
			tag: "IMPOSSIBLE",
			message: `${s.guard}: ${s.impossible} invocation(s) took text off the payload and still read an empty message — the seam has diverged from mantahostels#1273`,
			data: { guard: s.guard, count: s.impossible },
			stats: s,
		});
	if (s.fallback)
		out.push({
			severity: "warn",
			tag: "FALLBACK",
			message: `${s.guard}: ${s.fallback} invocation(s) fell back to the transcript, the payload's last_assistant_message being absent, empty or whitespace-only — the field mantahostels#1275 relies on is going missing`,
			data: { guard: s.guard, count: s.fallback },
			stats: s,
		});
	if (s.invocations < MIN_SAMPLE) return out;
	const share = s.noVerdict / s.invocations;
	if (share > BLIND_SHARE)
		out.push({
			severity: "fail",
			tag: "BLIND",
			message: `${s.guard} reached no verdict on ${s.noVerdict} of ${s.invocations} invocations (${pct(share)}) in the last ${days} day(s) — it is judging turns it cannot read, and blocks nothing on them`,
			data: { guard: s.guard, share, invocations: s.invocations },
			stats: s,
		});
	return out;
}

/**
 * One key per pending condition, sorted, so the same faults give the same
 * signature.
 * @param {Pending[]} pending
 */
function faultSignature(pending) {
	return pending
		.map((f) =>
			[
				f.tag,
				f.data.guard ?? f.data.name ?? "",
				/* The count to its order of magnitude, as the share is to 5
				 * points — the bucketing run()'s comment explains where it calls
				 * this. */
				f.data.share === undefined
					? Math.floor(Math.log10((f.data.count ?? 0) + 1))
					: Math.round(f.data.share * 20),
			].join(":"),
		)
		.sort()
		.join("|");
}

/**
 * Raises every pending finding and says what each guard saw.
 * @param {Ctx} ctx
 * @param {Pending[]} pending
 * @param {{vanished: number, root: unknown}} opts
 */
function reportFaults(ctx, pending, { vanished, root }) {
	for (const f of pending) ctx[f.severity](f.tag, f.message, f.data);

	ctx.say("A Stop guard is not reading the turns it judges.\n");
	/* Said in the body as well as raised: --notify injects this text and
	 * nothing else, so a report of counts alone would not say what is wrong. */
	for (const f of pending) ctx.say(`  ${f.tag}  ${f.message}`);
	ctx.say("\nWhat each guard saw:\n");
	for (const s of new Set(pending.map((f) => f.stats).filter(Boolean)))
		ctx.say(distribution(/** @type {Stats} */ (s)));
	/* Said, never raised: the sweep taking a file mid-read is the machinery
	 * working. */
	if (vanished)
		ctx.say(
			`\n(${vanished} breadcrumb(s) were swept between the listing and the read, and skipped.)`,
		);
	ctx.say(
		"\nEvery invocation reaching no verdict is a turn its guard let through unexamined (mantahostels#1254).\n" +
			`Records: ${path.join(hookRecord.recordsDir(String(root)), `${hookRecord.PREFIX}*`)}`,
	);
}

/** This checker's name, shared with its delivery-stamp file. */
const CHECKER = "stop-guard-outcomes";

runCheck({
	name: CHECKER,
	usage:
		"node check-stop-guard-outcomes.js [--days <n>] [--root <dir>] [--notify]",
	valueFlags: ["--days", "--root"],
	/** @returns {CheckResult|undefined} */
	run(/** @type {Ctx} */ ctx) {
		const days = ctx.has("--days") ? Number(ctx.value("--days")) : DEFAULT_DAYS;
		if (!Number.isFinite(days) || days <= 0)
			ctx.usageError("--days must be a positive number.");
		/* The breadcrumbs sit at the repository root, and nothing guarantees a
		 * caller runs this from there, so cwd alone is not enough. */
		const root = ctx.value("--root", hostRoot());

		let read;
		try {
			read = readBreadcrumbs(String(root));
		} catch (e) {
			/* The repository root itself: apparatus, not subject (mantahostels#155). */
			return ctx.broken(errMessage(e));
		}
		const pending = breadcrumbReadFindings(read);

		/* Lines, not files: `files` counts every breadcrumb the listing named,
		 * including those the read then lost. */
		if (read.lines.length === 0)
			return {
				okLine: `no Stop-guard breadcrumbs read at ${hookRecord.recordsDir(root)} — no guard has run here, or the sweep has taken them all${read.vanished ? ` (${read.vanished} vanished mid-read)` : ""}.`,
			};

		const byGuard = summarise(read.lines, Date.now() - days * 86_400_000);

		/* A machine nobody worked on for two days has every guard silent, which is
		 * not news. One guard silent while another recorded is. */
		const someGuardRan = [...byGuard.values()].some((s) => s.invocations);

		for (const s of byGuard.values())
			pending.push(...guardFindings(s, { days, someGuardRan }));

		if (pending.length === 0)
			return {
				okLine:
					`every Stop guard reached a verdict on every invocation worth judging in the last ${days} day(s)` +
					(read.vanished
						? `, over ${read.vanished} breadcrumb(s) fewer than were listed — the sweep took them mid-read`
						: "") +
					".",
			};

		/* One entry per condition, so a standing fault is said once and a changed
		 * one is said again (mantahostels#1254). The share is bucketed to 5 points: a rate
		 * drifting inside a bucket is the same news.
		 *
		 * **Residual:** a genuinely new fault sharing tag, guard and bucket with
		 * one already reported is swallowed outright, and a share crossing a
		 * bucket boundary re-notifies saying nothing new. Both are accepted over
		 * repeating the same line into 10-12 sessions a day. */
		const signature = faultSignature(pending);
		/* Raising nothing, so the run is OK and --notify stays silent: the founder
		 * has already been told this, in this shape. Never true under persist
		 * mode (mantahostels#1975). */
		if (deliveryStamp.alreadyDelivered(ctx, CHECKER, signature))
			return {
				okLine: "already reported; the distribution has not changed since.",
			};

		reportFaults(ctx, pending, { vanished: read.vanished, root });

		/* Stamped only after the report is out, so a process killed in between
		 * repeats the notice rather than swallowing it. A no-op under persist
		 * mode (mantahostels#1975). */
		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			noun: "Stop-guard reading fault(s)",
			stamp: signature,
			data: {
				days,
				vanished: read.vanished,
				guards: [...byGuard.values()].map((s) => ({
					guard: s.guard,
					invocations: s.invocations,
					verdict: s.verdict,
					noVerdict: s.noVerdict,
					fallback: s.fallback,
					impossible: s.impossible,
					sessions: s.sessions.size,
					outcomes: Object.fromEntries(s.outcomes),
				})),
			},
		};
	},
});
