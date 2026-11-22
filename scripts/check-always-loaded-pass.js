#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck, now } = require("./lib/check");
const { getPoolFiles } = require("./lib/always-loaded-pool");
const { worktreeRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const { FULL_SHA } = require("./lib/commit-sha.js");

const RECORD_FILE = "docs/always-loaded-passes.json";

const BUDGET_SCRIPT = "scripts/check-context-budget.js";

const BUDGET_SCRIPT_FILE =
	process.env.WFC_BUDGET_SCRIPT_FILE ||
	path.join(__dirname, "check-context-budget.js");

const PERIOD_MONTHS = 1;
const OVERDUE_MONTHS = 2;

// measured median growth of a pool-growing commit, lucmoseley/mantahostels#2500
const MARGIN_BYTES = 268;

const SCOPE_TAIL = "this repo's own skill, command and agent descriptions";
const EXCLUDED = "docs/doc-map.md";

/** @param {string} s */
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** @param {string} s */
const isSha = (s) => typeof s === "string" && FULL_SHA.test(s);

/**
 * @param {string} date
 * @param {number} months
 */
function addMonths(date, months) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + months);
	return d.toISOString().slice(0, 10);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ headroom: number, cap: number }}
 */
function readBudget(ctx, root) {
	let out;
	try {
		out = execFileSync(
			process.execPath,
			[BUDGET_SCRIPT_FILE, "--json", "--root", root],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (e) {
		const err = caught(e);
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
 * @param {Ctx} ctx
 * @param {string} file
 */
function readPass(ctx, file) {
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
	if (data.passes.length === 0) return null;
	const p = data.passes[0];
	const extra = Object.keys(p ?? {}).filter(
		(k) => !["date", "sha", "issue"].includes(k),
	);
	if (extra.length > 0)
		ctx.broken(
			`${file}: a pass carries date, sha and issue alone, got ${extra.join(", ")}`,
		);
	if (!p || !isDate(p.date))
		ctx.broken(
			`${file}: the pass needs a "date" of the form YYYY-MM-DD, got ${JSON.stringify(p?.date)}`,
		);
	if (!isSha(p.sha))
		ctx.broken(
			`${file}: pass ${p.date} needs a full-sha "sha", got ${JSON.stringify(p.sha)}`,
		);
	return /** @type {Pass} */ (p);
}

/** @typedef {{ date: string, sha: string, issue?: string }} Pass */

/** @param {Ctx} ctx @param {string} label @param {string} msg */
function sayLine(ctx, label, msg) {
	ctx.say(`  ${`${label}:`.padEnd(12)}${msg}`);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ headroom: number, cap: number | null }}
 */
function resolveHeadroom(ctx, root) {
	const override = ctx.value("--headroom");
	if (override === null) return readBudget(ctx, root);
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
	valueFlags: ["--record", "--root", "--headroom"],
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		const file = path.resolve(root, ctx.value("--record", RECORD_FILE));
		if (!ctx.has("--record") && !fs.existsSync(file))
			ctx.skip(
				`this repo has no ${RECORD_FILE} — no pool-pass cadence to check`,
			);

		const last = readPass(ctx, file);
		const today = new Date(now()).toISOString().slice(0, 10);

		const { headroom, cap } = resolveHeadroom(ctx, root);

		const due = last ? addMonths(last.date, PERIOD_MONTHS) : null;
		const overdueFrom = last ? addMonths(last.date, OVERDUE_MONTHS) : null;

		const calendar = due !== null && today >= due;
		const tight = headroom < MARGIN_BYTES;
		const overdue = overdueFrom !== null && today >= overdueFrom;

		/** @type {(label: string, msg: string) => void} */
		const ok = ctx.notify
			? noop
			: (/** @type {string} */ label, /** @type {string} */ msg) =>
					sayLine(ctx, label, msg);

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
