#!/usr/bin/env node

const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check");
const {
	parseErrLine,
	ghClosedIssuesWithLabel,
	ghJson,
	ghOpenIssues,
	raiseGhFailure,
} = require("./lib/gh");
const { resolveGate } = require("./lib/issue-gate");
const { worktreeRoot } = require("./lib/host-root.js");
const {
	DEFAULT_TIMEOUT_S,
	NOT_STATED,
	REPAIR_STATES,
	runCheckCommand,
	unwrap,
} = require("./lib/gate-check.js");
const { appendReading } = require("./lib/gate-projection.js");
const { readHostTracker } = require("./lib/refill-repos.js");
const { WATCH_CLOSED_LABEL } = require("./lib/watch-label.js");

// guess, lucmoseley/mantahostels#2656
const ROW_LINES = 3;
// guess, lucmoseley/mantahostels#2656
const ROW_WIDTH = 160;

const REPO_ROOT = worktreeRoot();

/** @param {{labels?: ({name: string}|string)[]}} iss */
const carriesWatchLabel = (iss) =>
	(iss.labels ?? []).some(
		(l) => (typeof l === "string" ? l : l.name) === WATCH_CLOSED_LABEL,
	);

/** @param {string} reading */
function buildRowLines(reading) {
	const lines = reading.split("\n");
	const shown = lines
		.slice(0, ROW_LINES)
		.map((l) => (l.length > ROW_WIDTH ? `${l.slice(0, ROW_WIDTH - 1)}…` : l));
	if (lines.length > ROW_LINES)
		shown.push(`… +${lines.length - ROW_LINES} more line(s)`);
	return shown;
}

const REPAIRS = new Set([...REPAIR_STATES, "GATES-NOTHING"]);
const WARNED = new Set([...REPAIRS, NOT_STATED]);

/**
 * @typedef {{number: number, title: string, url: string, closed: boolean, condition: string|null, command: string|null, abandonIf: string|null, state: string, reading: string, detail: string|null}} GateRow
 */

/**
 * @param {{number: number, title: string, html_url: string, body: string, state: string}} iss
 * @param {number} timeoutMs
 * @returns {GateRow | null}
 */
function gateRow(iss, timeoutMs) {
	const resolved = resolveGate(iss.body);
	const gateOn = resolved.gateOn;
	const closed = iss.state === "closed";
	const base = {
		number: iss.number,
		title: iss.title,
		url: iss.html_url,
		closed,
		condition: null,
		command: null,
		abandonIf: null,
		detail: null,
	};
	if (!gateOn) {
		if (!closed) return null;
		return {
			...base,
			state: "GATES-NOTHING",
			reading: `carries \`${WATCH_CLOSED_LABEL}\` but no \`**Gated on:**\` line, so nothing can reopen it: add one, or remove the label`,
		};
	}

	if (gateOn.malformed) {
		return {
			...base,
			state: "GATES-NOTHING",
			reading: `malformed marker (${gateOn.reason}): ${gateOn.raw}`,
		};
	}
	if (resolved.conflict) {
		return {
			...base,
			condition: gateOn.condition,
			command: gateOn.command,
			abandonIf: gateOn.abandonIf,
			state: "GATES-NOTHING",
			reading:
				"carries both `Gated until:` and `Gated on:` — one gate line per issue",
		};
	}

	const row = {
		...base,
		condition: gateOn.condition,
		command: gateOn.command,
		abandonIf: gateOn.abandonIf,
	};
	if (!gateOn.command) {
		return {
			...row,
			state: NOT_STATED,
			reading: "no `check:` — judge the condition by hand",
		};
	}
	const u = unwrap(gateOn.command);
	if (!u.ok) {
		return { ...row, state: "NOT-A-COMMAND", reading: u.why };
	}
	return {
		...row,
		command: u.command,
		...runCheckCommand(u.command, timeoutMs, REPO_ROOT),
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {GateRow[]} rows
 * @param {GateRow[]} warned
 */
function printTable(ctx, rows, warned) {
	const shown = ctx.notify ? warned : rows;
	if (shown.length > 0) {
		ctx.say(
			ctx.notify
				? `\nGATE SWEEP — ${warned.length} conditioned issue(s) owe a repair to their\n` +
						"`check:` segment, or carry none. Nothing here is a verdict on the condition.\n"
				: `\nGATE SWEEP — ${rows.length} open or \`${WATCH_CLOSED_LABEL}\` issue(s) carrying \`**Gated on:**\`, each with\n` +
						"the reading its own `check:` command produced. NOTHING BELOW SAYS MET OR\n" +
						"UNMET (mantahostels#1332): read the reading against the condition and judge it.\n",
		);
		for (const r of shown) sayRow(ctx, r);
		ctx.say(
			"  A met condition is discharged by the session that judges it — /pick-next\n" +
				"  on its GATED rows, or the /triage the refill loop launches on a changed\n" +
				"  reading: comment the evidence, strip the marker, and the issue re-enters\n" +
				`  the batch, a closed one reopened and its \`${WATCH_CLOSED_LABEL}\` stripped first. A DEAD, NO-OUTPUT,\n` +
				"  OVER-BUDGET or NOT-A-COMMAND segment is repaired or deleted, and is never\n" +
				"  itself the blocker in either direction (mantahostels#1332).\n",
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {GateRow} r
 */
function sayRow(ctx, r) {
	ctx.say(
		`  #${r.number}  [${r.state}]${r.closed ? " (closed watch)" : ""} ${r.title}`,
	);
	if (r.condition) ctx.say(`      condition: ${r.condition}`);
	for (const line of buildRowLines(r.reading)) ctx.say(`      ${line}`);
	if (r.detail) ctx.say(`      (${r.detail})`);
	if (r.abandonIf) ctx.say(`      abandon if: ${r.abandonIf}`);
	ctx.say("");
}

/**
 * @param {GateRow[]} rows
 * @param {number | null} only
 */
function okLineFor(rows, only) {
	/** @type {string} */
	let okLine;
	if (rows.length > 0)
		okLine = `${rows.length} conditioned issue(s) read; every \`check:\` segment ran.`;
	else if (only === null)
		okLine = `no open or \`${WATCH_CLOSED_LABEL}\` issue carries a \`**Gated on:**\` marker.`;
	else
		okLine = `#${only} is not an open or \`${WATCH_CLOSED_LABEL}\` issue carrying a \`**Gated on:**\` marker.`;
	return okLine;
}

/**
 * @param {number | null} only
 * @returns {any[]}
 */
function readIssues(only) {
	if (only === null)
		return [...ghOpenIssues(), ...ghClosedIssuesWithLabel(WATCH_CLOSED_LABEL)];
	let iss;
	try {
		iss = ghJson(["api", `repos/{owner}/{repo}/issues/${only}`]);
	} catch (e) {
		if (/HTTP (404|410)/.test(parseErrLine(e))) return [];
		throw e;
	}
	return iss.state === "open" || carriesWatchLabel(iss) ? [iss] : [];
}

/**
 * #5861
 * @param {import("./lib/check").Ctx} ctx
 * @param {GateRow[]} rows
 */
function recordReadings(ctx, rows) {
	const repo = readHostTracker(REPO_ROOT) ?? "";
	for (const r of rows) {
		if (r.state !== "READING" || r.command === null) continue;
		try {
			appendReading({
				repo,
				issue: r.number,
				command: r.command,
				reading: r.reading,
			});
		} catch (e) {
			ctx.say(
				`  #${r.number}: reading not added to the gate history (${caught(e).message.split("\n")[0]})`,
			);
		}
	}
}

runCheck({
	name: "gates",
	usage:
		"node check-gates.js [--timeout <seconds>] [--issue <n>] [--notify] [--json]",
	valueFlags: ["--timeout", "--issue"],
	run(ctx) {
		const timeoutS = Number(ctx.value("--timeout", String(DEFAULT_TIMEOUT_S)));
		if (!Number.isFinite(timeoutS) || timeoutS <= 0)
			ctx.usageError("--timeout takes a positive number of seconds.");
		const onlyRaw = ctx.value("--issue");
		const only = onlyRaw === null ? null : Number(onlyRaw);
		if (only !== null && !Number.isInteger(only))
			ctx.usageError("--issue takes an issue number.");

		let issues;
		try {
			issues = readIssues(only);
		} catch (e) {
			return raiseGhFailure(e, "No gate was read.");
		}

		/** @type {GateRow[]} */
		const rows = [];
		for (const iss of issues) {
			if (iss.pull_request) continue;
			const row = gateRow(iss, timeoutS * 1000);
			if (row) rows.push(row);
		}
		recordReadings(ctx, rows);

		rows.sort((a, b) => a.number - b.number);
		const repairs = rows.filter((r) => REPAIRS.has(r.state));
		const warned = rows.filter((r) => WARNED.has(r.state));

		for (const r of warned)
			ctx.warn(
				r.state,
				`#${r.number} — ${r.reading.split("\n")[0]}`,
				r,
				`${r.state}\t#${r.number}`,
			);

		printTable(ctx, rows, warned);

		return {
			okLine: okLineFor(rows, only),
			noun: "conditioned issue(s) whose `check:` segment owes a repair or is missing",
			data: {
				rows,
				conditioned: rows.length,
				repairs: repairs.length,
				unstated: warned.length - repairs.length,
				timeoutSeconds: timeoutS,
			},
		};
	},
});
