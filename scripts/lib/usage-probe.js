/*
 * usage-probe.js — the one `claude -p "/usage"` call, cache first, that both
 * `dispatch-sessions.sh`'s allowance gate (through `scripts/usage-probe.js`)
 * and the refill loop's stale-seat read make (#2306, from #2189's ruling).
 *
 * THE PROBE IS NEVER DROPPED: it is the seat's usage cache's only refresher.
 * What goes is the time it spends after the refresh, on a section of `/usage`
 * nothing here reads (#2189):
 *   - where both of the seat's cached bars read fresh (`lib/allowance.js`),
 *     no probe runs;
 *   - a probe that runs is stopped once the cache's `fetchedAtMs` moves past
 *     its start, and the caller reads the refreshed cache;
 *   - where the stamp never moves, the probe runs to its end and its printed
 *     bars are what the caller reads.
 * It runs with stdin on /dev/null and from `/`, outside any repo, so no
 * project's SessionStart hooks run; the seat is chosen by CLAUDE_CONFIG_DIR,
 * not the cwd. Not the temp dir: TMPDIR can sit inside a checkout.
 *
 * KNOWN RISKS, owned here:
 *   - a stopped probe skips its own `SessionEnd` hook;
 *   - that the probe rewrites the cache at all, and only once the cached stamp
 *     is 58-117 s old, is undocumented harness behaviour, measured at #2189;
 *   - the probe runs in its own process group, so only this routine stops
 *     it: a caller ending it uses `signal`, and one SIGKILLed orphans it.
 */

const { spawn } = require("node:child_process");
const { readAllowance } = require("./allowance.js");
const { killGroup } = require("./grouped-child.js");
const { readUsageCache } = require("./usage-cache.js");

/** The probe's ceiling. */
const PROBE_TIMEOUT_MS = 120_000;
/* The CLI's stderr line opens with this; the refill loop reads the outcome
 * after it (#2362). */
const OUTCOME_PREFIX = "usage probe: ";

/** How often the cache stamp is read while a probe runs; a guess, not measured. */
const STAMP_POLL_MS = 250;

/**
 * How the call ended: `cached`, no probe ran; `stopped`, the stamp moved and
 * the probe was stopped; `finished`, it exited by itself; `timed-out`, it was
 * stopped at the ceiling; `aborted`, the caller's `signal` stopped it;
 * `failed`, it would not start, or would not be stopped.
 * @typedef {"cached" | "stopped" | "finished" | "timed-out" | "aborted" | "failed"} ProbeOutcome
 */

/**
 * The seat's `/usage`, probing only where a cached bar is not fresh.
 * `text` is whatever the probe printed (empty where none ran, or where it was
 * stopped before printing), for `readAllowance`'s `usageText`.
 * @param {{ configDir: string, claudeBin: string, claudeArgs?: string[], timeoutMs?: number, signal?: AbortSignal }} opts
 *   `claudeArgs` go before `-p "/usage"`.
 * @returns {Promise<{ outcome: ProbeOutcome, text: string, error?: string }>}
 */
async function probeUsage({
	configDir,
	claudeBin,
	claudeArgs = [],
	timeoutMs = PROBE_TIMEOUT_MS,
	signal,
}) {
	const cached = readAllowance({ configDir });
	if (cached.session.trust === "fresh" && cached.weekly_all.trust === "fresh")
		return { outcome: "cached", text: "" };
	const startMs = Date.now();
	const child = spawn(
		claudeBin,
		[...claudeArgs, "-p", "/usage", "--permission-mode", "manual"],
		{
			cwd: "/",
			env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			stdio: ["ignore", "pipe", "ignore"],
			// Its own group, so a stop reaches the hooks and helpers it starts.
			detached: true,
		},
	);
	let text = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		text += chunk;
	});
	return new Promise((resolve) => {
		/** @type {ProbeOutcome | null} */
		let stoppedAs = null;
		const settle = (
			/** @type {{ outcome: ProbeOutcome, text: string, error?: string }} */ r,
		) => {
			clearInterval(poll);
			clearTimeout(ceiling);
			signal?.removeEventListener("abort", onAbort);
			resolve(r);
		};
		const stop = (/** @type {ProbeOutcome} */ outcome) => {
			if (stoppedAs) return;
			stoppedAs = outcome;
			// A probe at its ceiling is hung, and may not heed a TERM.
			const sig = outcome === "timed-out" ? "SIGKILL" : "SIGTERM";
			// A failure leaves it running, with no close to wait on.
			const failed = killGroup(/** @type {number} */ (child.pid), sig);
			if (failed) settle({ outcome: "failed", text, error: failed });
		};
		const onAbort = () => stop("aborted");
		const poll = setInterval(() => {
			const cache = readUsageCache(configDir);
			if (
				cache.state === "ok" &&
				cache.fetchedAtMs !== null &&
				cache.fetchedAtMs > startMs
			)
				stop("stopped");
		}, STAMP_POLL_MS);
		const ceiling = setTimeout(() => stop("timed-out"), timeoutMs);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort);
		child.on("error", (e) =>
			settle({ outcome: "failed", text, error: e.message }),
		);
		child.on("close", () => settle({ outcome: stoppedAs ?? "finished", text }));
	});
}

module.exports = { probeUsage, OUTCOME_PREFIX, PROBE_TIMEOUT_MS };
