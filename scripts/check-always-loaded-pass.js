#!/usr/bin/env node
/*
 * check-always-loaded-pass.js — reports when the always-loaded pool is due a
 * concision pass (mantahostels#2500, the mechanism limb of mantahostels#2457's decision C3).
 *
 * Usage:
 *   node check-always-loaded-pass.js [--record <file>] [--root <dir>]
 *                                    [--headroom <bytes>] [--notify] [--json]
 *   (defaults: docs/always-loaded-passes.json, the repo root)
 *
 * WHY IT EXISTS. A pass over the pool pays back in tokens rather than in
 * readability, and recurringly (mantahostels#1085, mantahostels#619).
 *
 * TWO TRIGGERS, WHICHEVER COMES FIRST:
 *   1. CALENDAR — a month since the recorded pass.
 *   2. HEADROOM — the pool within MARGIN_BYTES of check-context-budget.js's cap.
 *
 * REPORT-ONLY. No FINDING here is ever a FAIL: the one severity that gates is
 * deliberately unreachable, so a pass this reports as due can never refuse a
 * commit. It is not a promise that the process always exits 0 — a BROKEN still
 * exits 2, as the alphabet requires, and what keeps that harmless is the
 * wiring: `npm run status`, which reports rather than gates.
 *
 * THE RECORD IS DURABLE, and that is the whole reason it is a committed
 * sidecar: a `.concision-pass-<sid>` marker is swept by
 * scripts/session-arbiter.js prune-markers, so a monthly cadence read off one
 * would reset itself.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), compares the recorded always-loaded-pool concision pass against a calendar month and the pool's remaining headroom, and injects a report when either says a pass is due.
 * JUSTIFIED: fail-safe — nothing else fires the pass, and its payback is recurring, so an unreported month is money spent every month thereafter.
 * DEFEAT:    none; the report is silent while no trigger fires.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck, now } = require("./lib/check");
const { getPoolFiles } = require("./lib/always-loaded-pool");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");

const RECORD_FILE = "docs/always-loaded-passes.json";

/* The name reported in every message — never joined onto `root`. */
const BUDGET_SCRIPT = "scripts/check-context-budget.js";

/* Where BUDGET_SCRIPT is actually SPAWNED from: the core's own copy, beside
 * this file, so a plugin install finds it wherever it is installed rather than
 * looking for it in the host's own (core-less) scripts/ (#36). `WFC_BUDGET_SCRIPT_FILE`
 * is the test-injection seam (`lib/host-root.js`'s header convention) — the
 * suite points this at a fixture script instead of writing one under --root. */
const BUDGET_SCRIPT_FILE =
	process.env.WFC_BUDGET_SCRIPT_FILE ||
	path.join(__dirname, "check-context-budget.js");

/* One calendar month, and a second one before the report changes its wording.
 * Calendar months rather than a day count so the due date lands on the same
 * day of the month a pass was run, which is what a reader can check by eye. */
const PERIOD_MONTHS = 1;
const OVERDUE_MONTHS = 2;

/*
 * The headroom below which the pool is reported as tight, in bytes: the median
 * growth of a commit that grows the pool, so the pool is tight exactly when it
 * can no longer absorb one more addition of the size this repo writes.
 *
 * Both readings behind it are on mantahostels#2500. RE-MEASURE rather than adjust by feel,
 * on a cap change as well as on drift — and enumerate the commits with
 * `git rev-list --full-history HEAD -- <the pool files>`, never `git log --`, whose
 * history simplification hides two thirds of them and is what produced this
 * ticket's first, wrong figure.
 */
const MARGIN_BYTES = 268;

/* Reported as scope, and excluded from it, per mantahostels#1085: the pool is what
 * check-context-budget.js counts under POOL, and docs/doc-map.md is not in it
 * until a ruling lifts its exclusion. */
const SCOPE_TAIL = "this repo's own skill, command and agent descriptions";
const EXCLUDED = "docs/doc-map.md";

/** @param {string} s */
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** @param {string} s */
const isSha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

/**
 * `date` advanced by `months`, as a YYYY-MM-DD string.
 *
 * Day-of-month overflow is left to Date's own normalisation: 31 January plus a
 * month is 3 March, which is later than a reader would guess but never
 * earlier, so the report can only be late rather than premature.
 *
 * @param {string} date
 * @param {number} months
 */
function addMonths(date, months) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString().slice(0, 10);
}

/**
 * The pool's remaining headroom and its cap, read from the checker that owns
 * both — never re-derived here, which would leave two definitions of the pool
 * to drift apart.
 *
 * SPAWNED, not required: the figures are what a run computes, and
 * check-context-budget.js exports only its pathspecs.
 *
 * BROKEN, never null, on every failure: that script is tracked, and it is what
 * this checker reads the pool WITH, so its silence is apparatus rather than
 * subject (scripts/lib/check.js's header). Answering "no pass is due" because
 * the reading apparatus broke is the one failure this checker exists to
 * prevent.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ headroom: number, cap: number }}
 */
function budget(ctx, root) {
	let out;
	try {
		out = execFileSync(
			process.execPath,
			[BUDGET_SCRIPT_FILE, "--json", "--root", root],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (e) {
		const err = caught(e);
		/* Exit 1 is how that checker reports a cap breach and exit 2 how it
		 * reports its own BROKEN; both print the envelope, so read stdout before
		 * treating a non-zero exit as no answer. */
		out = String(err.stdout ?? "");
		if (!out.trim())
			ctx.broken(
				`${BUDGET_SCRIPT} did not answer — ${err.message}` +
					`${err.stderr ? `\n${String(err.stderr).trim()}` : ""}`,
			);
	}
	let d;
	try {
		d = JSON.parse(out);
	} catch (e) {
		ctx.broken(
			`cannot parse ${BUDGET_SCRIPT}'s --json envelope — ${caught(e).message}`,
		);
	}
	if (typeof d.headroom !== "number" || typeof d.cap !== "number")
		ctx.broken(
			`${BUDGET_SCRIPT}'s --json envelope carries no numeric headroom and cap`,
		);
	return { headroom: d.headroom, cap: d.cap };
}

/**
 * The recorded pass, as a one-entry array.
 *
 * The file is tracked, so anything wrong with its bytes is BROKEN rather than a
 * finding.
 *
 * @param {Ctx} ctx
 * @param {string} file
 */
function passes(ctx, file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read the pool-pass record at ${file} — ${caught(e).message}. ` +
				"It is tracked; restore it rather than recreating it, so the " +
				"cadence is not reset by the repair.",
		);
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		ctx.broken(`cannot parse ${file} — ${caught(e).message}`);
	}
	if (!data || !Array.isArray(data.passes))
		ctx.broken(`${file} has no "passes" array`);
	if (data.passes.length > 1)
		ctx.broken(
			`${file} records ${data.passes.length} passes; it holds the newest alone, so replace the entry rather than appending one`,
		);
	for (const p of data.passes) {
		const extra = Object.keys(p ?? {}).filter(
			(k) => !["date", "sha", "issue"].includes(k),
		);
		if (extra.length > 0)
			ctx.broken(
				`${file}: a pass carries date, sha and issue alone, got ${extra.join(", ")}`,
			);
		if (!p || !isDate(p.date))
			ctx.broken(
				`${file}: every pass needs a "date" of the form YYYY-MM-DD, got ${JSON.stringify(p?.date)}`,
			);
		if (!isSha(p.sha))
			ctx.broken(
				`${file}: pass ${p.date} needs a 40-hex "sha", got ${JSON.stringify(p.sha)}`,
			);
	}
	return /** @type {Pass[]} */ (data.passes);
}

/** @typedef {{ date: string, sha: string, issue?: string }} Pass */

/** @param {Ctx} ctx @param {string} label @param {string} msg */
function sayLine(ctx, label, msg) {
	ctx.say(`  ${`${label}:`.padEnd(12)}${msg}`);
}

/**
 * The headroom the trigger turns on, and the cap it is quoted against.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ headroom: number, cap: number | null }}
 */
function resolveHeadroom(ctx, root) {
	const override = ctx.value("--headroom");
	/* An overridden headroom has no cap to quote: the seam supplies the one
	 * number the trigger turns on and nothing else. */
	if (override === null) return budget(ctx, root);
	const n = Number(override);
	if (!Number.isFinite(n))
		ctx.usageError(`--headroom needs a number, got ${override}`);
	return { headroom: n, cap: null };
}

/**
 * @param {{ last: Pass | null, calendar: boolean, overdue: boolean, due: string | null, today: string, tight: boolean, headroom: number, cap: number | null }} t
 */
function triggerWhy({
	last,
	calendar,
	overdue,
	due,
	today,
	tight,
	headroom,
	cap,
}) {
	const calendarWhy =
		calendar &&
		(overdue
			? `${daysBetween(/** @type {string} */ (due), today)} days past due (${due}), a full period missed`
			: `due since ${due}`);
	return [
		last ? calendarWhy : "no pass has ever been recorded",
		tight &&
			`headroom ${headroom} B, under the ${MARGIN_BYTES} B margin${cap === null ? "" : ` of the ${cap} B cap`}`,
	]
		.filter(Boolean)
		.join("; ");
}

/**
 * The due report's detail lines.
 *
 * @param {Ctx} ctx
 * @param {{ why: string, last: Pass | null, due: string | null, headroom: number, cap: number | null, root: string, file: string }} r
 */
function reportDue(ctx, { why, last, due, headroom, cap, root, file }) {
	ctx.say("ALWAYS-LOADED POOL — a concision pass is due.");
	sayLine(ctx, "trigger", why);
	sayLine(
		ctx,
		"last pass",
		last
			? `${last.date}, sha ${last.sha.slice(0, 8)}${last.issue ? ` (${last.issue})` : ""}`
			: "none recorded",
	);
	sayLine(ctx, "due", due ?? "now — there is no pass to count a month from");
	sayLine(
		ctx,
		"headroom",
		`${headroom} B${cap === null ? "" : ` of a ${cap} B cap`}, margin ${MARGIN_BYTES} B`,
	);
	sayLine(ctx, "in scope", `${getPoolFiles().join(", ")}, and ${SCOPE_TAIL}`);
	sayLine(
		ctx,
		"excluded",
		`${EXCLUDED} (mantahostels#1085, until its per-section read frequency is priced)`,
	);
	ctx.say(
		`  Run the concision-pass skill over those files, then record the pass in ${path.relative(root, file)}.`,
	);
	ctx.say("");
}

const SPEC = {
	name: "always-loaded-pass",
	usage:
		"node check-always-loaded-pass.js [--record <file>] [--root <dir>] [--headroom <bytes>] [--notify] [--json]",
	/* --headroom is the test seam: the live figure moves with every commit, so
	 * a test asserting the headroom trigger cannot read it from this repo. */
	valueFlags: ["--record", "--root", "--headroom"],
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const file = path.resolve(root, ctx.value("--record", RECORD_FILE));
		// An adopter that keeps no pool-pass record has no cadence to hold (#2,
		// #33); a --record naming a missing file is still BROKEN below.
		if (!ctx.has("--record") && !fs.existsSync(file))
			ctx.skip(
				`this repo has no ${RECORD_FILE} — no pool-pass cadence to check`,
			);

		const recorded = passes(ctx, file);
		const today = new Date(now()).toISOString().slice(0, 10);

		const { headroom, cap } = resolveHeadroom(ctx, root);

		const last = recorded[0] ?? null;
		const due = last ? addMonths(last.date, PERIOD_MONTHS) : null;
		const overdueFrom = last ? addMonths(last.date, OVERDUE_MONTHS) : null;

		/* Both triggers are evaluated, both are reported: which one fired tells
		 * the reader whether the pass is cadence or pressure, and they answer
		 * differently about how much there is to cut. */
		const calendar = due !== null && today >= due;
		const tight = headroom < MARGIN_BYTES;
		const overdue = overdueFrom !== null && today >= overdueFrom;

		/* Under --notify a passing run is not news, so the detail lines are
		 * withheld with the finding — check.js already withholds the summary. */
		/** @type {(label: string, msg: string) => void} */
		const ok = ctx.notify
			? () => {
					/* a pass is withheld under --notify */
				}
			: (/** @type {string} */ label, /** @type {string} */ msg) =>
					sayLine(ctx, label, msg);

		/* The trigger sentence is built once and printed in the report: check.js
		 * prints a finding's TAG and the run's count, never the message, so a
		 * reason that lives only in the finding reaches nobody. */
		const why = triggerWhy({
			last,
			calendar,
			overdue,
			due,
			today,
			tight,
			headroom,
			cap,
		});

		if (!last || calendar || tight)
			ctx.warn(
				"POOL-PASS",
				`the always-loaded pool is due a concision pass — ${why}`,
			);

		if (ctx.findings.length > 0) {
			reportDue(ctx, { why, last, due, headroom, cap, root, file });
		} else {
			ok("last pass", `${last?.date} (sha ${last?.sha.slice(0, 8)})`);
			ok("due", String(due));
			ok("headroom", `${headroom} B, margin ${MARGIN_BYTES} B`);
		}

		return {
			okLine: `always-loaded pool passed ${last?.date}, next due ${due}.`,
			noun: "pool-pass report",
			data: {
				record: path.relative(root, file),
				last,
				due,
				today,
				headroom,
				cap,
				margin: MARGIN_BYTES,
				triggers: { calendar, headroom: tight, overdue },
				scope: [...getPoolFiles(), SCOPE_TAIL],
				excluded: [EXCLUDED],
			},
		};
	},
};

/**
 * Whole days from `from` to `to`, both YYYY-MM-DD.
 *
 * @param {string} from
 * @param {string} to
 */
function daysBetween(from, to) {
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
			86_400_000,
	);
}

if (require.main === module) runCheck(SPEC);
