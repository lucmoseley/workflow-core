#!/usr/bin/env node
/*
 * check-gates.js — runs each open `**Gated on:**` issue's own `check:` command
 * and prints the reading it produced, one row per conditioned issue.
 *
 * WHY IT EXISTS (mantahostels#2656). A condition gate holds an issue out of pick-next.js's
 * shortlist by existing and parsing; the condition itself is never evaluated,
 * ruled deliberately at mantahostels#1329 and mantahostels#1330 because evaluating one in the selection
 * run means running every gated ticket's instrument on every selection. The
 * discharge the design names — "the session that takes the ticket judges the
 * condition itself" — gets its moment through two callers (workflow-core#2279): /pick-next
 * runs `--issue <n>` on each condition gate its GATED block lists and judges
 * the reading, and the refill loop runs this sweep on its own cadence outside
 * every tick (lib/gate-sweep.js), launching a `/triage <n>` judge wherever an
 * issue's reading changed. Neither runs inside selection (mantahostels#1329).
 *
 * IT DECIDES NOTHING, and that is the whole contract (mantahostels#1332). `check:` names a
 * command that prints a reading, never one whose exit code is a verdict, so no
 * row here says met or unmet, nothing is labelled, commented or unmarked, and a
 * non-zero exit that still printed is a reading like any other. A session
 * reads the table and judges. Anything stronger needs mantahostels#1332 reversed
 * first.
 *
 * WHY LOCAL, NEVER A CI WORKFLOW. Several `check:` commands read
 * machine-local, gitignored state — `.test-pass-markers.jsonl` (mantahostels#1979), a
 * scratch census script under `.claude/tmp/` (mantahostels#2316), a `python3` measurement
 * tree (mantahostels#1897, mantahostels#1972). An Actions runner holds none of it, so a CI run of this
 * sweep would print a table of false readings, which is worse than no table.
 *
 * IT EXECUTES COMMAND TEXT OUT OF ISSUE BODIES, through a shell. That is only
 * safe because the tracker is private and written by the founder and this
 * repo's own sessions, and because this never runs in CI, where a token with
 * write scope is in the environment. Do not wire it anywhere either of those
 * stops being true.
 *
 * THE BUDGET IS PER CHECK, 60 SECONDS BY DEFAULT — `--timeout <seconds>` to
 * raise it. One live check (mantahostels#2491) takes ~22 minutes, and is meant to come back
 * OVER-BUDGET and be run by hand when its reading is actually wanted. Checks run
 * in series, so the worst case is the budget times the conditioned issues.
 *
 * THE BUDGET IS SPENT THROUGH coreutils `timeout`, NOT node's own. `spawnSync`'s
 * `timeout` kills the shell it spawned and nothing the shell spawned, so mantahostels#2491's
 * check — which is meant to hit the budget on every sweep — would leave a
 * ~22-minute node process orphaned on a 10 GB machine, once per sweep.
 * `timeout` puts the command in a process group of its own and signals the
 * group.
 *
 * Usage: node check-gates.js [--timeout <seconds>] [--issue <n>] [--notify] [--json]
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP, any other gh failure BROKEN. Nothing here ever FAILs — a
 * reading is not a verdict, so the only findings are WARNs: a segment that
 * owes a repair, or a gate with no `check:` at all (workflow-core#1246).
 */

const { spawnSync } = require("node:child_process");

const { runCheck, brokenError } = require("./lib/check");
const { errLine, ghJson, ghOpenIssues, raiseGhFailure } = require("./lib/gh");
const { resolveGate } = require("./lib/issue-gate");
const { hostRoot } = require("./lib/host-root.js");

/* Per check, not per sweep. Wide enough for every reading but mantahostels#2491's, which is
 * meant to come back OVER-BUDGET (see the header). */
const DEFAULT_TIMEOUT_S = 60;

/* A reading is for a human to read, and a `gh run list` one runs to hundreds of
 * lines. Both figures are a judgement, not a measurement. The whole reading is in
 * the --json envelope either way, which is what makes truncating here safe. */
const ROW_LINES = 3;
const ROW_WIDTH = 160;

/* A quarter of lib/gh.js's own 256 MB ceiling, which is sized for a whole-tracker
 * GraphQL read: no `check:` command is that. */
const MAX_BUFFER = 64e6;

/* GNU `timeout`'s two exit codes for a command it killed: 124 for the TERM it
 * sends at the budget, 137 (128+9) where `-k` had to follow it with a KILL. */
const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;

/* How long `timeout` waits after its TERM before sending a KILL. */
const KILL_AFTER_S = 5;

/* Each issue's `check:` command runs against the host repo (workflow-core#1), never the
 * core checkout — a plugin install's own files sit outside the tree the
 * command means to read. */
const REPO_ROOT = hostRoot();

/**
 * The command as written, unwrapped from the backticks the tracker's own
 * examples put round it — six of the eight live commands carry a pair.
 *
 * ANY SEGMENT THAT OPENS WITH A BACKTICK AND IS NOT EXACTLY ONE PAIR ROUND ONE
 * COMMAND COMES BACK AS A REPAIR, because there is no honest way to run one.
 * mantahostels#2065's segment trails prose past the closing backtick ("(see its header;
 * mantahostels#1985 landed it)"), and taking the backticked span alone would be a guess at
 * which part was meant — the silent mis-split mantahostels#1435 already accepted one of. A
 * segment carrying a second pair INSIDE the outer one is worse than a guess:
 * unwrapped and run, the inner pair becomes shell command substitution, so a
 * citation in prose executes.
 *
 * @param {string} raw
 * @returns {{ ok: true, command: string } | { ok: false, why: string }}
 */
function unwrap(raw) {
	const s = raw.trim();
	if (!s.startsWith("`")) return { ok: true, command: s };
	if (!s.endsWith("`") || s.length === 1)
		return {
			ok: false,
			why: "opens with a backtick it never closes — prose wrapped round the command",
		};
	const inner = s.slice(1, -1).trim();
	if (!inner) return { ok: false, why: "an empty pair of backticks" };
	if (inner.includes("`"))
		return {
			ok: false,
			why: "carries a second pair of backticks inside the first — the inner pair would run as shell command substitution",
		};
	return { ok: true, command: inner };
}

/**
 * @typedef {{ state: string, reading: string, detail: string | null }} Reading
 */

/**
 * Run one `check:` command and classify what came back. The exit code is
 * deliberately not read as a verdict (mantahostels#1332): stdout is the reading whatever it
 * was, and the code only distinguishes a command that printed nothing because
 * it died from one that printed nothing because it had nothing to say.
 *
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Reading}
 */
function runCommand(command, timeoutMs) {
	const budgetS = Math.round(timeoutMs / 1000);
	const startedAt = Date.now();
	/* No `shell: true`: `timeout` runs `sh -c <command>` itself, so the command
	 * still gets a shell — pipes, `&&` and quoting all work — but the process
	 * group `timeout` signals is the shell's own, not this checker's. */
	const r = spawnSync(
		"timeout",
		["-k", String(KILL_AFTER_S), String(budgetS), "sh", "-c", command],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const elapsedMs = Date.now() - startedAt;
	const out = (r.stdout || "").trim();
	const err = (r.stderr || "").trim();
	const code = /** @type {{code?: string} | undefined} */ (r.error)?.code;
	/* No `timeout` on PATH is the apparatus failing, not a fact about the gate,
	 * so it is BROKEN rather than a row saying the command is dead (§N4). */
	if (code === "ENOENT")
		throw brokenError(
			"coreutils `timeout` is not on PATH, and it is what bounds each check.\n" +
				"        Nothing was read. Install coreutils, or run a single check by hand.",
		);
	/* An overrun is the reading being too big to hold, not the command failing —
	 * and the ceiling is this script's, so it says which constant to raise, the
	 * way gh.js does for its own. */
	if (code === "ENOBUFS")
		return {
			state: "DEAD",
			reading: `printed more than ${MAX_BUFFER / 1e6} MB — raise MAX_BUFFER in scripts/check-gates.js, or narrow the command`,
			detail: null,
		};
	if (r.error)
		return {
			state: "DEAD",
			reading: `could not run: ${r.error.message.split("\n")[0]}`,
			detail: null,
		};
	return classifyExit(r, { out, err, elapsedMs, timeoutMs });
}

/**
 * The last line of a command's stderr, or null where it printed none.
 *
 * @param {string} err
 */
function lastErrLine(err) {
	return err ? err.split("\n").pop() || null : null;
}

/**
 * Classify a `check:` command that ran to an exit or a signal.
 *
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {{ out: string, err: string, elapsedMs: number, timeoutMs: number }} run
 * @returns {Reading}
 */
function classifyExit(r, { out, err, elapsedMs, timeoutMs }) {
	const budgetS = Math.round(timeoutMs / 1000);
	/* THE BUDGET IS READ OFF THE CLOCK, NOT OFF THE SIGNAL. 124 is `timeout`'s
	 * own code for the TERM it sent; but where `-k` has to follow with a KILL,
	 * that KILL goes to the whole group and takes `timeout` with it, so the run
	 * comes back as a signal death with no code at all. A signal death inside
	 * the budget is something else killing the check — earlyoom, on this
	 * machine — and stays DEAD. Residual: an earlyoom kill landing after the
	 * budget reads as over budget, and nothing here can tell them apart. */
	const overBudget =
		r.status === TIMEOUT_EXIT ||
		r.status === KILLED_EXIT ||
		(r.status === null && elapsedMs >= timeoutMs);
	if (overBudget)
		return {
			state: "OVER-BUDGET",
			reading: `killed at ${budgetS}s — run it by hand`,
			detail: out || null,
		};
	/* `status` is null where a signal killed it, and `exit null` reads as a bug
	 * in this script rather than as what happened to the command. */
	if (r.status === null && !out)
		return {
			state: "DEAD",
			reading: `killed by ${r.signal}, nothing on stdout`,
			detail: lastErrLine(err),
		};
	if (out)
		return {
			state: "READING",
			reading: out,
			/* Carried, never promoted: a command that prints its reading and exits
			 * non-zero is common (a `grep` finding nothing to filter), and reading
			 * the code as a verdict is what mantahostels#1332 forbids. */
			detail: r.status === 0 ? null : `exit ${r.status}`,
		};
	if (r.status !== 0)
		return {
			state: "DEAD",
			reading: `exit ${r.status}, nothing on stdout`,
			detail: lastErrLine(err),
		};
	return {
		state: "NO-OUTPUT",
		reading: "exit 0, nothing on stdout",
		detail: lastErrLine(err),
	};
}

/** @param {string} reading */
function rowLines(reading) {
	const lines = reading.split("\n");
	const shown = lines
		.slice(0, ROW_LINES)
		.map((l) => (l.length > ROW_WIDTH ? `${l.slice(0, ROW_WIDTH - 1)}…` : l));
	if (lines.length > ROW_LINES)
		shown.push(`… +${lines.length - ROW_LINES} more line(s)`);
	return shown;
}

/* Every state a row can carry, and whether it owes a repair. A repair is a WARN
 * finding; a reading is a row to read, not a fault. NOT-STATED is no repair
 * either, but is warned all the same (workflow-core#1246): its condition is judged by hand,
 * and an OK summary hides it from everyone who never asks for this table. */
const REPAIRS = new Set([
	"DEAD",
	"NO-OUTPUT",
	"OVER-BUDGET",
	"NOT-A-COMMAND",
	"GATES-NOTHING",
]);
const WARNED = new Set([...REPAIRS, "NOT-STATED"]);

/**
 * @typedef {{number: number, title: string, url: string, condition: string|null, command: string|null, abandonIf: string|null, state: string, reading: string, detail: string|null}} GateRow
 */

/**
 * One open issue's row: its `Gated on:` marker judged, and its `check:`
 * command run where it states one. Null where it carries no marker.
 *
 * @param {{number: number, title: string, html_url: string, body: string}} iss
 *   one REST issue row, the fields read here. GitHub sends a null `body` for
 *   an empty one, which `resolveGate` reads as "" though it declares `string`.
 * @param {number} timeoutMs
 * @returns {GateRow | null}
 */
function gateRow(iss, timeoutMs) {
	const resolved = resolveGate(iss.body);
	const gateOn = resolved.gateOn;
	if (!gateOn) return null;
	const base = {
		number: iss.number,
		title: iss.title,
		url: iss.html_url,
		condition: null,
		command: null,
		abandonIf: null,
		detail: null,
	};

	if (gateOn.malformed) {
		return {
			...base,
			state: "GATES-NOTHING",
			reading: `malformed marker (${gateOn.reason}): ${gateOn.raw}`,
		};
	}
	/* Both markers gates nothing and is reported, matching pick-next.js's
	 * own reading of the pair (docs/agents/issue-tracker.md §Gating an
	 * issue). The condition is still printed — it is what the repair is
	 * judged against. */
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
			state: "NOT-STATED",
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
		...runCommand(u.command, timeoutMs),
	};
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {GateRow[]} rows
 * @param {GateRow[]} warned
 */
function printTable(ctx, rows, warned) {
	/* Under --notify stdout is injected into every session that starts, so
	 * only the warned rows go out there; the full table is for a run someone
	 * asked for. */
	const shown = ctx.notify ? warned : rows;
	if (shown.length > 0) {
		ctx.say(
			ctx.notify
				? `\nGATE SWEEP — ${warned.length} conditioned issue(s) owe a repair to their\n` +
						"`check:` segment, or carry none. Nothing here is a verdict on the condition.\n"
				: `\nGATE SWEEP — ${rows.length} open issue(s) carrying \`**Gated on:**\`, each with\n` +
						"the reading its own `check:` command produced. NOTHING BELOW SAYS MET OR\n" +
						"UNMET (mantahostels#1332): read the reading against the condition and judge it.\n",
		);
		for (const r of shown) sayRow(ctx, r);
		ctx.say(
			"  A met condition is discharged by the session that judges it — /pick-next\n" +
				"  on its GATED rows, or the /triage the refill loop launches on a changed\n" +
				"  reading: comment the evidence, strip the marker, and the issue re-enters\n" +
				"  the batch. A DEAD, NO-OUTPUT,\n" +
				"  OVER-BUDGET or NOT-A-COMMAND segment is repaired or deleted, and is never\n" +
				"  itself the blocker in either direction (mantahostels#1332).\n",
		);
	}
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {GateRow} r
 */
function sayRow(ctx, r) {
	ctx.say(`  #${r.number}  [${r.state}] ${r.title}`);
	if (r.condition) ctx.say(`      condition: ${r.condition}`);
	for (const line of rowLines(r.reading)) ctx.say(`      ${line}`);
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
		okLine = "no open issue carries a `**Gated on:**` marker.";
	else
		okLine = `#${only} is not an open issue carrying a \`**Gated on:**\` marker.`;
	return okLine;
}

/**
 * The issues the sweep reads: `only` fetched on its own, else every open one.
 * `--issue` never searches the list, which has come back without an open
 * issue it should carry (workflow-core#2565).
 * @param {number | null} only
 * @returns {any[]}
 */
function readIssues(only) {
	if (only === null) return ghOpenIssues();
	let iss;
	try {
		iss = ghJson(["api", `repos/{owner}/{repo}/issues/${only}`]);
	} catch (e) {
		// No such issue, or a deleted one: not an open issue, as the OK line says.
		if (/HTTP (404|410)/.test(errLine(e))) return [];
		throw e;
	}
	return iss.state === "open" ? [iss] : [];
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
			raiseGhFailure(e, "No gate was read.");
		}

		/** @type {GateRow[]} */
		const rows = [];
		for (const iss of issues) {
			if (iss.pull_request) continue; // one number space, two kinds of thing
			const row = gateRow(iss, timeoutS * 1000);
			if (row) rows.push(row);
		}

		rows.sort((a, b) => a.number - b.number);
		const repairs = rows.filter((r) => REPAIRS.has(r.state));
		const warned = rows.filter((r) => WARNED.has(r.state));

		for (const r of warned)
			ctx.warn(
				r.state,
				`#${r.number} — ${r.reading.split("\n")[0]}`,
				r,
				// The condition and the command both get rewritten in place; the
				// issue and what is wrong with its segment are the identity.
				`${r.state}\t#${r.number}`,
			);

		printTable(ctx, rows, warned);

		/* OK means every segment RAN, never that a condition is met — the
		 * readings are above, and judging them is the reader's (mantahostels#1332). */
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
