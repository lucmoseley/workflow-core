#!/usr/bin/env node
/*
 * check-refill-loop-stop.js — name, at the next session start, a refill loop
 * that stopped on no progress, on the allowance cut or on a damaged control
 * file (#2014, spec #1995 story 32; #3389).
 *
 * Usage:  node scripts/check-refill-loop-stop.js [--notify] [--json]
 *
 * READS the loop's state file (lib/refill-loop.js) for its last stop. An
 * expiry or an explicit stop is not named.
 *
 * ONCE PER STOP. A `--notify` run records the stop's time in the stop-seen
 * stamp beside the state file, and names no stop at or before it. A plain run
 * names it and records nothing. A compaction is no session start: its hook
 * payload's `source` is `compact`, and it prints and records nothing. The
 * stamp is per machine, as the loop is, so whichever session starts first on
 * any seat or repo spends it — a background job's start included.
 *
 * THE RESTART MATCHES THE STOPPED SCOPE (#3371): `/pick-next` restarts normal
 * mode only, naming the loop's other repos and goals (#3390). An away-mode
 * stop names `refill-loop.js start --away` with its exclusions, one command
 * per goal's checkout. `start` files a goal under CLAUDE_PROJECT_DIR before
 * the working directory (lib/host-root.js), so each away command sets it, and
 * names the script absolute. A loop started again since names no restart.
 *
 * Severity is WARN: a notice for the founder. An absent or damaged state
 * file is no stop. A damaged state file is its own WARN, named at every
 * session start until the loop's next tick rewrites it; a damaged control
 * file, read only beside a fresh stop, is named with it, until a `start`
 * rewrites it (#3380); beside the stop it caused, the stop line names it.
 *
 * IMPLICIT:  at every session start, prints the refill loop's last stop where it was no progress, the allowance cut or a damaged control file and is newer than the stamp, then stamps it; and names a damaged state or control file.
 * JUSTIFIED: fail-safe — the loop runs outside any session, so nothing else reports its stopping.
 * DEFEAT:    none needed — it never blocks; deleting the stamp names the last stop again.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const hookMessage = require("./lib/hook-message");
const loop = require("./lib/refill-loop.js");
const {
	expandPastePaths,
	scriptPath,
	shellWord,
} = require("./lib/script-path.js");

/** @type {Partial<Record<import("./lib/refill-decide.js").StopReason, string>>} */
const STOP_REASON_WORDS = {
	"no-progress": "no progress",
	allowance: "the allowance cut",
	"control-damaged": "a damaged control file",
};

/** @param {string} file */
function readSeen(file) {
	try {
		const at = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isFinite(at) ? at : 0;
	} catch {
		/* Absent on the first run; unreadable only repeats the notice (#2014). */
		return 0;
	}
}

const PICK_NEXT = "Restart it with /pick-next.";

const STATUS = `node ${scriptPath("refill-loop.js")} status`;

/**
 * The restart for a stopped loop's scope: `/pick-next` where it was normal
 * mode or is unknown, else an away start per goal's checkout (#3371).
 * Residual: an away loop whose control file is lost after its stop is named
 * `/pick-next`, which restarts it as normal mode.
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @returns {string[]}
 */
function buildRestartLines(control) {
	if (control === null) return [PICK_NEXT];
	if (control.scope.mode === "normal") return buildPickNextLines(control.scope);
	const { exclude, goals } = control.scope;
	const away = `node ${expandPastePaths("{script:refill-loop.js}", "")} start --away${exclude
		.map((r) => ` --exclude ${path.basename(r)}`)
		.join("")}`;
	const perGoal = Object.entries(goals).map(
		([root, issues]) =>
			`  CLAUDE_PROJECT_DIR=${shellWord(root)} ${away} --goal ${issues.join(",")}`,
	);
	return perGoal.length === 0
		? [`Restart away mode: ${away}`]
		: ["Restart away mode, one start per goal's checkout:", ...perGoal];
}

/**
 * A normal loop's restart: the checkout that started it names the other repos
 * and its goal, and each other goal's checkout its own goal, since `/pick-next`
 * resolves a goal against the tracker it runs in (#3390). The starter leads
 * `repos`: `start` writes it first and the union keeps the first start's
 * order; a scope with no repos leads with its first goal's checkout.
 * @param {import("./lib/refill-loop.js").Scope} scope
 * @returns {string[]}
 */
function buildPickNextLines({ repos, goals }) {
	const lead = repos[0] ?? Object.keys(goals)[0];
	if (lead === undefined) return [PICK_NEXT];
	const extras = repos.filter((r) => r !== lead);
	const goalRoots = Object.keys(goals).filter((r) => r !== lead);
	if (extras.length === 0 && goalRoots.length === 0 && !goals[lead])
		return [PICK_NEXT];
	/** @param {string} root */
	const command = (root) =>
		[
			"/pick-next",
			...(goals[root] ?? []).map((n) => `#${n}`),
			...(root === lead ? extras.map((r) => path.basename(r)) : []),
		].join(" ");
	/* No trailing period: §1 of the skill would read `repo.` as no checkout. */
	if (goalRoots.length === 0)
		return [`Restart it in ${path.basename(lead)}: ${command(lead)}`];
	return [
		"Restart it with /pick-next, one per goal's checkout:",
		...[lead, ...goalRoots].map(
			(r) => `  in ${path.basename(r)}: ${command(r)}`,
		),
	];
}

runCheck({
	name: "refill-loop-stop",
	usage: "node check-refill-loop-stop.js [--notify] [--json]",
	run(ctx) {
		/* Read under --notify alone: a plain run's stdin may be a terminal. */
		if (ctx.notify && hookMessage.readPayload()?.source === "compact")
			ctx.skip("a compaction is no session start.");
		const files = loop.loopFiles();
		/** @param {string} line */
		const reportDamaged = (line) => {
			ctx.warn("REFILL-LOOP-FILE-DAMAGED", line);
			ctx.say(`REFILL-LOOP-FILE-DAMAGED — ${line}.`);
		};
		const { stopped } = loop.parseState(
			loop.readJson(files.state, reportDamaged),
		);
		const why = stopped
			? STOP_REASON_WORDS[
					/** @type {import("./lib/refill-decide.js").StopReason} */ (
						stopped.reason
					)
				]
			: undefined;
		const fresh =
			stopped !== null &&
			why !== undefined &&
			stopped.at > readSeen(files.stopSeen);
		if (fresh) {
			const at = new Date(stopped.at).toISOString();
			/* A control-damaged stop's line names the damage already. */
			const control = loop.readControlFile(
				stopped.reason === "control-damaged" ? () => undefined : reportDamaged,
			);
			const renewed = loop.isRenewedSince(control, stopped.at);
			const since = renewed
				? " It has been started again since."
				: " Running sessions finish; nothing new launches.";
			const lines = [
				...(renewed ? [] : buildRestartLines(control)),
				`Its status: ${STATUS}`,
			];
			ctx.warn(
				"REFILL-LOOP-STOPPED",
				`the refill loop stopped on ${why} at ${at}`,
				{ reason: stopped.reason, at, detail: stopped.detail },
			);
			ctx.say(
				`REFILL-LOOP-STOPPED — the refill loop stopped on ${why} at ${at}: ${stopped.detail}.${since}\n` +
					lines.map((l) => `  ${l}\n`).join(""),
			);
			if (ctx.notify) fs.writeFileSync(files.stopSeen, `${stopped.at}\n`);
		}
		return {
			okLine: "no refill loop stop to name.",
			noun: "refill loop stop(s) or damaged file(s)",
			data: { stopped },
		};
	},
});
