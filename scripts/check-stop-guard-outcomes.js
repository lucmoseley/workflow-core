#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const deliveryStamp = require("./lib/delivery-stamp");
const hookRecord = require("./lib/hook-record");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { parseJsonl } = require("./lib/jsonl.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @typedef {import("./lib/check").CheckResult} CheckResult */

/**
 * @typedef {{guard?: unknown, session?: unknown, outcome?: unknown,
 *   source?: unknown, capped?: unknown, at?: unknown}} Crumb
 */

// guess: ~200 runs per guard a day clear MIN_SAMPLE, lucmoseley/mantahostels#1254
const DEFAULT_DAYS = 2;

// guess, lucmoseley/mantahostels#1254
const MIN_SAMPLE = 50;

// lucmoseley/mantahostels#1291 measured 3.6% healthy, 91.4% blind
const BLIND_SHARE = 0.1;

const VERDICT_OUTCOMES = new Set(hookRecord.VERDICT_OUTCOMES);

/** @param {Crumb} line */
const isSentinel = (line) => line.capped === true;

/**
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
 * @param {string} raw
 * @returns {{crumbs: Crumb[], torn: number, zeroed: number}}
 */
function parseCrumbLines(raw) {
	const read = parseJsonl(raw);
	return {
		crumbs: /** @type {Crumb[]} */ (read.rows),
		torn: read.bad.length,
		zeroed: read.zeroed.length,
	};
}

/**
 * @param {string} root
 * @returns {{lines: Crumb[], files: number, unreadable: string[], torn: number,
 *   zeroed: number, vanished: number}}
 */
function readBreadcrumbs(root) {
	/** @type {Crumb[]} */
	const lines = [];
	/** @type {string[]} */
	const unreadable = [];
	let torn = 0;
	let zeroed = 0;
	let vanished = 0;
	// lucmoseley/mantahostels#3382
	try {
		fs.readdirSync(root);
	} catch (e) {
		throw new Error(`cannot read ${root}: ${e}`, { cause: e });
	}
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
			if (caught(e).code === "ENOENT") vanished++;
			else unreadable.push(name);
			continue;
		}
		const parsed = parseCrumbLines(raw);
		for (const crumb of parsed.crumbs) lines.push(crumb);
		torn += parsed.torn;
		zeroed += parsed.zeroed;
	}
	return { lines, files, unreadable, torn, zeroed, vanished };
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
 * @param {Crumb[]} lines
 * @param {number} cutoff
 * @returns {Map<string, Stats>}
 */
function summarise(lines, cutoff) {
	/** @type {Map<string, Stats>} */
	const byGuard = new Map();
	for (const line of lines) {
		if (isSentinel(line)) continue;
		const guard = hookRecord.normaliseGuardName(
			typeof line.guard === "string" ? line.guard : "unknown-guard",
		);
		let s = byGuard.get(guard);
		if (!s) {
			s = emptyStats(guard);
			byGuard.set(guard, s);
		}
		s.everSeen = true;
		const at = Date.parse(String(line.at));
		if (!Number.isFinite(at) || at < cutoff) continue;
		tallyInWindow(s, line);
	}
	return byGuard;
}

/**
 * @param {Stats} s
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
 * @typedef {{severity: "fail"|"warn", tag: string, message: string,
 *   data: {guard?: string, name?: string, count?: number, share?: number,
 *     invocations?: number},
 *   stats?: Stats}} Pending
 */

/**
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
	if (read.zeroed)
		pending.push({
			severity: "warn",
			tag: "ZEROED",
			message: `${read.zeroed} breadcrumb record(s) zeroed by a crash, so the rates below are measured over fewer records than were written`,
			data: { count: read.zeroed },
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

/** @param {Pending[]} pending */
function faultSignature(pending) {
	return pending
		.map((f) =>
			[
				f.tag,
				f.data.guard ?? f.data.name ?? "",
				f.data.share === undefined
					? Math.floor(Math.log10((f.data.count ?? 0) + 1))
					: Math.round(f.data.share * 20),
			].join(":"),
		)
		.sort()
		.join("|");
}

/**
 * @param {Ctx} ctx
 * @param {Pending[]} pending
 * @param {{vanished: number, root: unknown}} opts
 */
function reportFaults(ctx, pending, { vanished, root }) {
	for (const f of pending) ctx[f.severity](f.tag, f.message, f.data);

	ctx.say("A Stop guard is not reading the turns it judges.\n");
	for (const f of pending) ctx.say(`  ${f.tag}  ${f.message}`);
	ctx.say("\nWhat each guard saw:\n");
	for (const s of new Set(pending.map((f) => f.stats).filter(Boolean)))
		ctx.say(distribution(/** @type {Stats} */ (s)));
	if (vanished)
		ctx.say(
			`\n(${vanished} breadcrumb(s) were swept between the listing and the read, and skipped.)`,
		);
	ctx.say(
		"\nEvery invocation reaching no verdict is a turn its guard let through unexamined (mantahostels#1254).\n" +
			`Records: ${path.join(hookRecord.recordsDir(String(root)), `${hookRecord.PREFIX}*`)}`,
	);
}

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
		const root = ctx.value("--root", hostRoot());

		let read;
		try {
			read = readBreadcrumbs(String(root));
		} catch (e) {
			return ctx.broken(errMessage(e));
		}
		const pending = breadcrumbReadFindings(read);

		if (read.lines.length === 0)
			return {
				okLine: `no Stop-guard breadcrumbs read at ${hookRecord.recordsDir(root)} — no guard has run here, or the sweep has taken them all${read.vanished ? ` (${read.vanished} vanished mid-read)` : ""}.`,
			};

		const byGuard = summarise(read.lines, Date.now() - days * 86_400_000);

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

		const signature = faultSignature(pending);
		if (deliveryStamp.alreadyDelivered(ctx, CHECKER, signature))
			return {
				okLine: "already reported; the distribution has not changed since.",
			};

		reportFaults(ctx, pending, { vanished: read.vanished, root });

		// lucmoseley/mantahostels#1975
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
