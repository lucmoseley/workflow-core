const { spawn } = require("node:child_process");
const { readAllowance, isTrustworthy } = require("./allowance.js");
const { killGroup } = require("./grouped-child.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { buildSeatEnv } = require("./seat-claude.js");
const { readUsageCache } = require("./usage-cache.js");

/** The probe's ceiling: the dispatcher's `timeout 120` it replaced, itself a guess (#2306). */
const PROBE_TIMEOUT_MS = 120_000;
const OUTCOME_PREFIX = "usage probe: ";

const PROBE_ARGV = ["-p", "/usage", "--permission-mode", "manual"];
const PROBE_CWD = "/";

// #2306 guess
const STAMP_POLL_MS = 250;

/**
 * @typedef {"cached" | "stopped" | "finished" | "timed-out" | "aborted" | "failed"} ProbeOutcome
 */

/**
 * @param {{ configDir: string, claudeBin: string, claudeArgs?: string[], timeoutMs?: number, signal?: AbortSignal, now?: number }} opts
 * @returns {Promise<{ outcome: ProbeOutcome, text: string, error?: string }>}
 */
async function probeUsage({
	configDir,
	claudeBin,
	claudeArgs = [],
	timeoutMs = PROBE_TIMEOUT_MS,
	signal,
	now = Date.now(),
}) {
	const cached = readAllowance({ configDir, now });
	if (isTrustworthy(cached)) return { outcome: "cached", text: "" };
	const env = buildSeatEnv(process.env, configDir);
	const refusal = launchAuthRefusal({
		bin: claudeBin,
		env,
		cwd: PROBE_CWD,
		bg: false,
	});
	if (refusal) return { outcome: "failed", text: "", error: refusal };
	const startMs = Date.now();
	const child = spawn(claudeBin, [...claudeArgs, ...PROBE_ARGV], {
		cwd: PROBE_CWD,
		env,
		stdio: ["ignore", "pipe", "ignore"],
		detached: true,
	});
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
			const sig = outcome === "timed-out" ? "SIGKILL" : "SIGTERM";
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

module.exports = {
	probeUsage,
	OUTCOME_PREFIX,
	PROBE_ARGV,
	PROBE_CWD,
	PROBE_TIMEOUT_MS,
};
