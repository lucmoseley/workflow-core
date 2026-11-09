#!/usr/bin/env node
/*
 * status-report.js — run the repo-health checkers that do not fire at
 * SessionStart, on demand.
 *
 * Usage:  npm run status  [-- --only <substring>] [-- --serial] [-- --write]
 *
 * `--serial` runs the checkers one at a time; a checker's own children are its
 * own, and check-primitives.js still counts four checks at once.
 *
 * TWO WERE KEPT ON SessionStart and are not listed here: `check-ci-status.js`,
 * a red `main` being a correctness signal, and `check-orphan-wait-loops.js`,
 * whose report names the `kill` for a shell holding memory against a 10 GB cap.
 * Four more run at SessionStart for other work but print their report only
 * here (#2038): `check-orphaned-edits.js` files there, `audit-escape-lines.js`
 * starts its judging batch, `check-self-throttling.js` reads its state, and
 * `replay-notify-reports.js` injects every report but the ones `--status` shows.
 *
 * A HAND RUN IS NOT THE HOOK RUN, deliberately. Without `--notify` a checker
 * writes to stderr rather than stdout, prints its `OK:`/`SKIP:` summary line
 * instead of suppressing it, and exits non-zero on a fault (`lib/check.js`).
 * Two go further: `check-capture-drain.js` calls `gh` rather than reading its
 * state file, and `check-hook-liveness.js` adds its `settings` assertion.
 *
 * READ-ONLY UNLESS `--write` (#4449). No checker here writes to the tracker
 * or the tree on a bare run; `--write` is passed on to the checkers in
 * WRITERS, which then file, refresh or record as their own headers say.
 *
 * EXIT CODE. Always 0 for any checker's own verdict — this reports, a human
 * decides — so a fault never breaks a caller. Only this runner crashing exits
 * 1, and it names itself when it does.
 */

const { spawn } = require("node:child_process");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { hostRoot } = require("./lib/host-root.js");
const { pool } = require("./lib/pool.js");
const { render } = require("./lib/status-render.js");

/* Core content: every checker below ships beside this script, so its path is
 * named from THIS DIRECTORY (#1) — a plugin install keeps it beside the
 * caller. */
const CORE_SCRIPTS = __dirname;

/*
 * Concurrency: several of these shell out to `gh`, and the machine caps at
 * 10 GB across every live session (CLAUDE.md §Machine limits). Four is a first
 * guess, not a measurement — nothing has profiled this fan-out.
 */
const POOL_WIDTH = 4;

/**
 * Every on-demand checker. check-seat-utilisation.js is absent: it runs at
 * SessionStart, and running in both places doubles its daily recording
 * (mantahostels#2680). `history-trim`: a checker that reports a corpus shrink no
 * session can repair belongs on the same on-demand surface as the rest
 * (mantahostels#2617). `gates` is here rather than at SessionStart because its
 * readings drift on every run — a growing sample count, a wall-clock time — so
 * it has no silence condition to be quiet on, and because it costs up to a
 * minute per over-budget check (mantahostels#2656). `skill-body-size` fires in
 * .husky/pre-commit scoped to the bodies a commit touches and here censuses
 * them all (mantahostels#3136). `release-pin` cannot be a commit gate at all: the
 * tag it asks about does not resolve until after the bump is committed (#257).
 * `band-drift` (#487), `citation-ceiling` (#726), `orphaned-edits` (#813),
 * `git-locks` (#1193), `output-style` (#1944) and `husky-shim` (#3172) were
 * built for this surface. `primitives` (#3451) runs at commit with
 * `--paths-only`, and here prints the count line.
 * `throttling` is a 10-19 s live sweep. `harness-canary` (#2037)'s start hook
 * prints only a red verdict, and the agent_id probe's "fixed" (#2819): here it
 * also shows a version not yet probed, a probe that could not run, and the
 * agent_id verdict. `concurrency` (#3317) prints a standing, never a fault.
 * `interop-latency` (#3564) also runs at SessionStart, which prints only a
 * degraded bridge: here a healthy one prints its latency. `kernel-stall` (#4092)
 * also runs at SessionStart, silent on a clock it cannot read: here that is a WARN.
 * `file-ci-time` (#4292) also runs in the scheduled sweep, and downloads the
 * last few sweeps' vitest reports, ~11 MB each. `compaction-backstop` (#4410)
 * reads one comment page per ticket closed in its window, so it is among the
 * slowest. `release-lag` (#4448) also runs at SessionStart, which prints only a
 * lag past its threshold: here every reading is a standing.
 * `landing-switch-on` (#4688) also runs at SessionStart, which prints only a
 * FAIL: here an OK or SKIP shows too.
 * `orphan-reaps` (#4342) reads the reaper's kill logs rather than running the
 * reaper, which kills.
 *
 * `jev-flags` takes `--notify`, the one hook-style run here: it shows only the
 * flags logged since the last one it showed, and records them — a hand run
 * would list every flag ever logged.
 *
 * @type {ReadonlyArray<readonly [string, string, ...string[]]>}
 */
const CHECKS = [
	["guard-errors", "check-guard-errors.js"],
	["hook-liveness", "check-hook-liveness.js"],
	["stop-guards", "check-stop-guard-outcomes.js"],
	["issue-labels", "check-issue-labels.js"],
	["file-claims", "check-stranded-file-claims.js"],
	["suite-queue", "check-stale-suite-queue.js"],
	["ghost-jobs", "check-ghost-jobs.js"],
	["tracker-sweep", "check-tracker-sweep.js"],
	["stray-scratch", "check-stray-scratch.js"],
	["manual-freshness", "check-manual-freshness.js"],
	["captures", "check-capture-drain.js"],
	["cleared-trackers", "check-cleared-trackers.js"],
	["context-budget", "check-context-budget.js"],
	["always-loaded-pass", "check-always-loaded-pass.js"],
	["scripts-typecheck", "check-scripts-typecheck.js"],
	["suite-size", "check-suite-size-drift.js"],
	["suite-margin", "check-suite-margin.js"],
	["file-ci-time", "check-file-ci-time.js"],
	["pick-next-model", "check-pick-next-model.js"],
	["history-trim", "check-history-trim.js"],
	["gates", "check-gates.js"],
	["skill-body-size", "check-skill-body-size.js"],
	["marker-integrity", "check-marker-integrity.js"],
	["release-pin", "check-release-pin.js"],
	["release-lag", "check-release-lag.js"],
	["landing-switch-on", "check-landing-switch-on.js"],
	["band-drift", "check-band-drift.js"],
	["citation-ceiling", "check-citation-ceiling.js"],
	["orphaned-edits", "check-orphaned-edits.js"],
	["git-locks", "check-stale-git-locks.js"],
	["orphan-reaps", "check-orphan-reaps.js"],
	["husky-shim", "check-husky-shim.js"],
	["primitives", "check-primitives.js"],
	["output-style", "check-output-style.js"],
	["held-reports", "replay-notify-reports.js", "--status"],
	["jev-flags", "check-jev-flags.js", "--notify"],
	["escape-audit", "audit-escape-lines.js"],
	["throttling", "check-self-throttling.js"],
	["config-links", "link-config-dirs.js", "--check"],
	["harness-canary", "check-harness-canary.js"],
	["concurrency", "concurrency-readout.js"],
	["interop-latency", "check-interop-latency.js"],
	["kernel-stall", "check-kernel-stall.js"],
	["wsl-currency", "check-wsl-currency.js"],
	["retry-watchdog", "check-retry-watchdog.js"],
	["idle-efforts", "check-idle-efforts.js"],
	["unclosed-launches", "check-unclosed-launches.js"],
	["compaction-backstop", "check-compaction-backstop.js"],
];

/**
 * The checkers that write under `--write`, and only then. harness-canary
 * takes `--write` too but is absent: only its `--probe` runs comment, never
 * the hand run listed here.
 */
const WRITERS = new Set(["band-drift", "history-trim", "orphaned-edits"]);

/** @typedef {import("./lib/status-render.js").Result} Result */

/** @param {string} msg */
function fail(msg) {
	writeFd(2, `status-report: ${msg}\n`);
}

/**
 * @param {readonly [string, string, ...string[]]} entry
 * @param {boolean} write  pass `--write` on to a checker in WRITERS
 * @returns {Promise<Result>}
 */
function run(entry, write) {
	const [name, script, ...args] = entry;
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				path.join(CORE_SCRIPTS, script),
				...args,
				...(write && WRITERS.has(name) ? ["--write"] : []),
			],
			{
				cwd: hostRoot(),
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let out = "";
		/*
		 * setEncoding, not string concatenation of raw Buffers: checker output
		 * carries `—`, `▸` and `…`, and a multibyte character split across a
		 * chunk boundary decodes to U+FFFD without it.
		 */
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("error", (err) =>
			resolve({
				name,
				code: null,
				signal: null,
				out: `did not run: ${err.message}`,
			}),
		);
		child.on("close", (code, signal) =>
			resolve({ name, code, signal, out: out.trim() }),
		);
	});
}

async function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage:
			`usage: node ${scriptPath("status-report.js")} [--only <substring>] [--serial] [--write]\n` +
			`  e.g. \`node ${scriptPath("status-report.js")} --only gates\``,
		flags: { "--only": "value", "--serial": "boolean", "--write": "boolean" },
	});
	const onlyValue = flagValue(flags, "--only") ?? null;
	const write = flags["--write"] === true;
	const selected = onlyValue
		? CHECKS.filter(([name]) => name.includes(onlyValue))
		: CHECKS;
	if (selected.length === 0) {
		fail(`no checker matches --only ${String(onlyValue)}`);
		process.exit(2);
	}

	/** @type {Result[]} */
	const results = [];
	if (flags["--serial"] === true) {
		for (const c of selected) results.push(await run(c, write));
	} else {
		results.push(...(await pool(selected, POOL_WIDTH, (c) => run(c, write))));
	}
	writeFd(1, render(results));
}

module.exports = { main };
if (require.main === module)
	main().catch((err) => {
		fail(err.message);
		process.exitCode = 1;
	});
