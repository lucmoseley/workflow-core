#!/usr/bin/env node
/*
 * status-report.js — run the repo-health checkers that do not fire at
 * SessionStart, on demand.
 *
 * Usage:  npm run status  [-- --only <substring>] [-- --serial]
 *
 * TWO WERE KEPT ON SessionStart and are not listed here: `check-ci-status.js`,
 * a red `main` being a correctness signal, and `check-orphan-wait-loops.js`,
 * whose report names the `kill` for a shell holding memory against a 10 GB cap.
 * Four more run at SessionStart for other work but print their report only
 * here (workflow-core#2038): `check-orphaned-edits.js` files there, `audit-escape-lines.js`
 * starts its judging batch, `check-self-throttling.js` reads its state, and
 * `replay-notify-reports.js` injects every report but the ones `--status` shows.
 *
 * A HAND RUN IS NOT THE HOOK RUN, deliberately. Without `--notify` a checker
 * writes to stderr rather than stdout, prints its `OK:`/`SKIP:` summary line
 * instead of suppressing it, and exits non-zero on a fault (`lib/check.js`).
 * Two go further: `check-capture-drain.js` calls `gh` rather than reading its
 * state file, and `check-hook-liveness.js` adds its `settings` assertion.
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

/* Core content: every checker below ships beside this script, so its path is
 * named from THIS DIRECTORY (workflow-core#1) — a plugin install keeps it beside the
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
 * tag it asks about does not resolve until after the bump is committed (workflow-core#257).
 * `band-drift` (workflow-core#487), `citation-ceiling` (workflow-core#726), `orphaned-edits` (workflow-core#813),
 * `git-locks` (workflow-core#1193) and `output-style` (workflow-core#1944) were built for this surface.
 * `throttling` is a 10-19 s live sweep. `harness-canary` (workflow-core#2037)'s start hook
 * prints only a red verdict, and the agent_id probe's "fixed" (workflow-core#2819): here it
 * also shows a version not yet probed, a probe that could not run, and the
 * agent_id verdict.
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
	["pick-next-model", "check-pick-next-model.js"],
	["history-trim", "check-history-trim.js"],
	["gates", "check-gates.js"],
	["skill-body-size", "check-skill-body-size.js"],
	["marker-integrity", "check-marker-integrity.js"],
	["release-pin", "check-release-pin.js"],
	["band-drift", "check-band-drift.js"],
	["citation-ceiling", "check-citation-ceiling.js"],
	["orphaned-edits", "check-orphaned-edits.js"],
	["git-locks", "check-stale-git-locks.js"],
	["output-style", "check-output-style.js"],
	["held-reports", "replay-notify-reports.js", "--status"],
	["jev-flags", "check-jev-flags.js", "--notify"],
	["escape-audit", "audit-escape-lines.js"],
	["throttling", "check-self-throttling.js"],
	["config-links", "link-config-dirs.js", "--check"],
	["harness-canary", "check-harness-canary.js"],
];

/**
 * Checkers whose clean run IS the report — a standing to read, not a finding —
 * so their body is printed even under an `OK:` line.
 */
const STANDINGS = new Set(["escape-audit"]);

/**
 * @typedef {object} Result
 * @property {string} name
 * @property {number | null} code   exit status, or null where a signal killed it
 * @property {string | null} signal
 * @property {string} out           stdout and stderr, merged in arrival order
 */

/** @param {string} msg */
function fail(msg) {
	writeFd(2, `status-report: ${msg}\n`);
}

const { flags } = parseOrExit(process.argv.slice(2), {
	usage:
		`usage: node ${scriptPath("status-report.js")} [--only <substring>] [--serial]\n` +
		`  e.g. \`node ${scriptPath("status-report.js")} --only gates\``,
	flags: { "--only": "value", "--serial": "boolean" },
});
const onlyValue = flagValue(flags, "--only") ?? null;
const serial = flags["--serial"] === true;

const selected = onlyValue
	? CHECKS.filter(([name]) => name.includes(onlyValue))
	: CHECKS;

if (selected.length === 0) {
	fail(`no checker matches --only ${String(onlyValue)}`);
	process.exit(2);
}

/**
 * @param {readonly [string, string, ...string[]]} entry
 * @returns {Promise<Result>}
 */
function run(entry) {
	const [name, script, ...args] = entry;
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[path.join(CORE_SCRIPTS, script), ...args],
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

/**
 * @template T, R
 * @param {ReadonlyArray<T>} items
 * @param {number} width
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pool(items, width, fn) {
	/** @type {R[]} */
	const results = new Array(items.length);
	// One iterator shared by every worker, so each item is taken exactly once.
	const queue = items.entries();
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, async () => {
			for (const [i, item] of queue) results[i] = await fn(item);
		}),
	);
	return results;
}

/**
 * A checker whose last line is its own `OK:` or `SKIP:` summary found nothing,
 * and its body is dropped rather than printed. So did a `--notify` run that
 * printed nothing at all.
 *
 * @param {Result} r
 */
function verdict(r) {
	const last = r.out.split("\n").pop() ?? "";
	if (r.signal) return `killed by ${r.signal}`;
	if (r.code === 0 && r.out === "") return "OK";
	if (/^OK:/.test(last)) return "OK";
	if (/^SKIP:/.test(last)) return "SKIP";
	return null;
}

async function main() {
	/** @type {Result[]} */
	const results = [];
	if (serial) {
		for (const c of selected) results.push(await run(c));
	} else {
		results.push(...(await pool(selected, POOL_WIDTH, run)));
	}

	/** @type {string[]} */
	const clean = [];
	for (const r of results) {
		const v = verdict(r);
		if ((v === "OK" || v === "SKIP") && !STANDINGS.has(r.name)) {
			clean.push(`${r.name} (${v})`);
			continue;
		}
		console.log(`\n▸ ${r.name}${v ? `  — ${v}` : ""}`);
		console.log(r.out || "(no output)");
	}

	if (clean.length > 0)
		console.log(`\nnothing to report from: ${clean.join(", ")}`);
	console.log(
		`\n${results.length} checker(s) run, ${clean.length} clean. Nothing here is a ticket by itself.`,
	);
}

main().catch((err) => {
	fail(err.message);
	process.exitCode = 1;
});
