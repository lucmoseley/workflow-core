const { spawnSync } = require("node:child_process");

const { brokenError } = require("./check");
const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	isRunnerFailure,
} = require("./run-budgeted.js");
const { caught } = require("./caught.js");
const { docPath, scriptPath } = require("./script-path");
const { gateOnOf, parseAddedGateLines } = require("./issue-gate.js");
const { hostRoot } = require("./host-root.js");
const { isSameRepo } = require("./issue-ref.js");
const {
	buildCheckoutEnv,
	homeDir,
	readCheckoutTracking,
	readHostTracker,
} = require("./refill-repos.js");

// guess, #2656
const DEFAULT_TIMEOUT_S = 60;

// guess, #2656
const MAX_BUFFER = 64e6;

// guess, #2855
const KILL_AFTER_MS = 5000;

const REPAIR_STATES = new Set([
	"NO-OUTPUT",
	"NOT-A-COMMAND",
	"DEAD",
	"OVER-BUDGET",
]);

/**
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
 * @param {string} command
 * @param {number} timeoutMs
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Reading}
 */
function runCheckCommand(command, timeoutMs, cwd, env) {
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
			env,
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const out = (r.stdout || "").trim();
	const err = (r.stderr || "").trim();
	const code = /** @type {{code?: string} | undefined} */ (r.error)?.code;
	if (isRunnerFailure(r))
		throw brokenError(
			`${err.split("\n")[0]}\n        Nothing was read. Run a single check by hand.`,
		);
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

/** @param {string} err */
function parseLastErrLine(err) {
	return err ? err.split("\n").pop() || null : null;
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {{ out: string, err: string, timeoutMs: number }} run
 * @returns {Reading}
 */
function classifyExit(r, { out, err, timeoutMs }) {
	const budgetS = Math.round(timeoutMs / 1000);
	const overBudget = r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT;
	if (overBudget)
		return {
			state: "OVER-BUDGET",
			reading: `killed at ${budgetS}s — run it by hand`,
			detail: out || null,
		};
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
 * @param {string} [repo]
 * @returns {{root: string, env?: NodeJS.ProcessEnv} | {why: string}}
 */
function readCheckTree(repo) {
	const host = hostRoot();
	if (!repo || isSameRepo(readHostTracker(host), repo)) return { root: host };
	const checkout = readCheckoutTracking(repo, homeDir());
	return "why" in checkout
		? checkout
		: { root: checkout.root, env: buildCheckoutEnv(checkout.root) };
}

/**
 * @param {string} before
 * @param {string} after
 * @param {{run: boolean, repo?: string, timeoutMs?: number}} opts
 * @returns {{refusals: string[], warnings: string[]}}
 */
function addedCheckVerdict(
	before,
	after,
	{ run, repo, timeoutMs = DEFAULT_TIMEOUT_S * 1000 },
) {
	/** @type {string[]} */
	const refusals = [];
	/** @type {string[]} */
	const warnings = [];
	/** @type {ReturnType<typeof readCheckTree> | undefined} */
	let where;
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
		where ??= readCheckTree(repo);
		if ("why" in where) {
			refusals.push(
				`the \`check:\` \`${u.command}\` on the \`**Gated on:**\` line was not run: ${where.why}. Clone ${repo} there with its \`.claude/workflow-core.json\`, or write the line from its checkout.`,
			);
			continue;
		}
		judgeRun(u.command, where, timeoutMs, { refusals, warnings });
	}
	return { refusals, warnings };
}

/**
 * @param {string} command
 * @param {{root: string, env?: NodeJS.ProcessEnv}} where
 * @param {number} timeoutMs
 * @param {{refusals: string[], warnings: string[]}} verdict
 */
function judgeRun(command, where, timeoutMs, { refusals, warnings }) {
	let r;
	try {
		r = runCheckCommand(command, timeoutMs, where.root, where.env);
	} catch (e) {
		warnings.push(
			`The \`check:\` \`${command}\` could not be run (${caught(e).message.split("\n")[0]}), so nothing says it prints a reading.`,
		);
		return;
	}
	if (r.state === "NO-OUTPUT" || r.state === "DEAD")
		refusals.push(buildSilentRefusal(command, r.reading, r.state));
	else if (r.state === "OVER-BUDGET")
		warnings.push(
			`The \`check:\` \`${command}\` ran past its ${Math.round(timeoutMs / 1000)} s budget, so the gate sweep will read it as OVER-BUDGET and its judge will run it by hand. Where it is not meant to run that long, make it print what it saw sooner.`,
		);
}

/**
 * @param {string} command
 * @param {string} what
 * @param {string} state
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
