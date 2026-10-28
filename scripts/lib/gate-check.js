/*
 * gate-check.js — running one `**Gated on:**` issue's `check:` command and
 * classifying what came back (mantahostels#1332): check-gates.js runs every
 * open gate's, and the write routes run a gate line's own once before writing
 * it (#3487).
 */

const { spawnSync } = require("node:child_process");

const { brokenError } = require("./check");
const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
} = require("./run-budgeted.js");
const { caught } = require("./caught.js");
const { docPath, scriptPath } = require("./script-path");
const { gateOnOf, parseAddedGateLines } = require("./issue-gate.js");
const { hostRoot } = require("./host-root.js");

/* Per check, not per sweep. Wide enough for every reading but mantahostels#2491's, which is
 * meant to come back OVER-BUDGET (check-gates.js's header). */
const DEFAULT_TIMEOUT_S = 60;

/* A quarter of lib/gh.js's own 256 MB ceiling, which is sized for a whole-tracker
 * GraphQL read: no `check:` command is that. */
const MAX_BUFFER = 64e6;

/* How long run-budgeted.js waits after its TERM before sending a KILL. A guess,
 * unmeasured: long enough for a check to flush a reading it was writing. */
const KILL_AFTER_MS = 5000;

/* The states a `check:` that printed no reading comes back in. */
const REPAIR_STATES = new Set([
	"NO-OUTPUT",
	"NOT-A-COMMAND",
	"DEAD",
	"OVER-BUDGET",
]);

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
 * @param {string} cwd
 * @returns {Reading}
 */
function runCheckCommand(command, timeoutMs, cwd) {
	/* No `shell: true`: run-budgeted.js runs `sh -c <command>` itself, so the
	 * command still gets a shell — pipes, `&&` and quoting all work — but the
	 * process group it signals is the shell's own, not this checker's. */
	const r = spawnSync(
		process.execPath,
		[
			RUN_BUDGETED,
			String(timeoutMs),
			String(KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const out = (r.stdout || "").trim();
	const err = (r.stderr || "").trim();
	const code = /** @type {{code?: string} | undefined} */ (r.error)?.code;
	/* The runner failing is the apparatus failing, not a fact about the gate,
	 * so it is BROKEN rather than a row saying the command is dead (§N4). */
	if (r.status === APPARATUS_EXIT && err.startsWith(APPARATUS_PREFIX))
		throw brokenError(
			`${err.split("\n")[0]}\n        Nothing was read. Run a single check by hand.`,
		);
	/* An overrun is the reading being too big to hold, not the command failing —
	 * and the ceiling is this script's, so it says which constant to raise, the
	 * way gh.js does for its own. */
	if (code === "ENOBUFS")
		return {
			state: "DEAD",
			reading: `printed more than ${MAX_BUFFER / 1e6} MB — raise MAX_BUFFER in scripts/lib/gate-check.js, or narrow the command`,
			detail: null,
		};
	if (r.error)
		return {
			state: "DEAD",
			reading: `could not run: ${r.error.message.split("\n")[0]}`,
			detail: null,
		};
	return classifyExit(r, { out, err, timeoutMs });
}

/**
 * The last line of a command's stderr, or null where it printed none.
 *
 * @param {string} err
 */
function parseLastErrLine(err) {
	return err ? err.split("\n").pop() || null : null;
}

/**
 * Classify a `check:` command that ran to an exit or a signal.
 *
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {{ out: string, err: string, timeoutMs: number }} run
 * @returns {Reading}
 */
function classifyExit(r, { out, err, timeoutMs }) {
	const budgetS = Math.round(timeoutMs / 1000);
	/* A signal death is something else killing the check — earlyoom, on this
	 * machine — and stays DEAD: run-budgeted.js reports its own kills as 124
	 * and 137, never as a signal. RESIDUAL: a command that exits 124 or 137 on
	 * its own inside the budget, as `sh -c 'a && b'` does where earlyoom kills
	 * `a`, reads as over budget, and nothing here can tell them apart. */
	const overBudget = r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT;
	if (overBudget)
		return {
			state: "OVER-BUDGET",
			reading: `killed at ${budgetS}s — run it by hand`,
			detail: out || null,
		};
	/* `status` is null where a signal killed it, and `exit null` reads as a bug
	 * in check-gates.js rather than as what happened to the command. */
	if (r.status === null && !out)
		return {
			state: "DEAD",
			reading: `killed by ${r.signal}, nothing on stdout`,
			detail: parseLastErrLine(err),
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
			detail: parseLastErrLine(err),
		};
	return {
		state: "NO-OUTPUT",
		reading: "exit 0, nothing on stdout",
		detail: parseLastErrLine(err),
	};
}

const PRINTING_FIX =
	'`git merge-base --is-ancestor X origin/main && echo "on main" || echo "not on main"`';

/**
 * What each `check:` on a `**Gated on:**` line the write adds will read as
 * (#3487). A repair state the sweep cannot draw a reading from is refused:
 * NOT-A-COMMAND parsed, NO-OUTPUT or DEAD run once under the sweep's budget.
 * OVER-BUDGET is warned, since a check can be meant to run long
 * (mantahostels#2491), and so is a check `run: false` leaves unrun or the
 * runner could not run.
 *
 * @param {string} before the body before the write, "" for a create
 * @param {string} after the body the write leaves
 * @param {{run: boolean, cwd?: string, timeoutMs?: number}} opts `run: false`
 *   for a route with no time to spend the budget: the parse alone is judged
 * @returns {{refusals: string[], warnings: string[]}}
 */
function addedCheckVerdict(
	before,
	after,
	{ run, cwd = hostRoot(), timeoutMs = DEFAULT_TIMEOUT_S * 1000 },
) {
	/** @type {string[]} */
	const refusals = [];
	/** @type {string[]} */
	const warnings = [];
	for (const line of parseAddedGateLines(before, after)) {
		const gateOn = gateOnOf(line);
		if (!gateOn || gateOn.malformed || !gateOn.command) continue;
		const u = unwrap(gateOn.command);
		if (!u.ok) {
			refusals.push(buildSilentRefusal(gateOn.command, u.why, "NOT-A-COMMAND"));
			continue;
		}
		if (!run) {
			warnings.push(
				`The \`check:\` \`${u.command}\` was not run here, so nothing says it prints a reading. Run \`node ${scriptPath("check-gates.js")} --issue <n>\` once it is filed; a NO-OUTPUT or DEAD row there is a check to rewrite so that it prints what it saw, for example ${PRINTING_FIX}.`,
			);
			continue;
		}
		let r;
		try {
			r = runCheckCommand(u.command, timeoutMs, cwd);
		} catch (e) {
			// A runner failure is advice here, so the write goes ahead (#3487).
			warnings.push(
				`The \`check:\` \`${u.command}\` could not be run (${caught(e).message.split("\n")[0]}), so nothing says it prints a reading.`,
			);
			continue;
		}
		if (r.state === "NO-OUTPUT" || r.state === "DEAD")
			refusals.push(buildSilentRefusal(u.command, r.reading, r.state));
		else if (r.state === "OVER-BUDGET")
			warnings.push(
				`The \`check:\` \`${u.command}\` ran past its ${Math.round(timeoutMs / 1000)} s budget, so the gate sweep will read it as OVER-BUDGET and its judge will run it by hand. Where it is not meant to run that long, make it print what it saw sooner.`,
			);
	}
	return { refusals, warnings };
}

/**
 * @param {string} command as written
 * @param {string} what what came back, or why it could not run
 * @param {string} state the row check-gates.js would give it
 */
const buildSilentRefusal = (command, what, state) =>
	`the \`check:\` \`${command}\` on the \`**Gated on:**\` line reads as ${state} (${what}), so the gate sweep gets no reading to judge (#3487). Make the command print what it saw, for example ${PRINTING_FIX}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;

module.exports = {
	DEFAULT_TIMEOUT_S,
	PRINTING_FIX,
	REPAIR_STATES,
	addedCheckVerdict,
	runCheckCommand,
	unwrap,
};
