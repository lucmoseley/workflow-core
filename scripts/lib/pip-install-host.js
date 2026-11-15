/*
 * pip-install-host.js — the production ports the dispatcher wires into the
 * guard-pip-install core, lib/pip-install.js (#5232).
 *
 * THE SEAM. WFC_CURL names curl, never PATH (#2266, #2422).
 *
 * THE TIMEOUTS. Each GET gets curl's own `--max-time` of 8 s and the
 * spawn's, two a package. pypistats rate-limits a burst with a 429 and
 * `retry-after: 1` (60 a window, measured 2026-11-15, #5232), so a 429 waits
 * 1 s and retries once with 3 s: 8 + 8 + 1 + 3, the 20 s a package
 * lib/package-vetting.js's 30 s budget is sized against. The 8 s is a guess
 * carried from the npm host; PyPI's JSON answered in under a second for
 * boto3's 3.3 MB and pypistats in under 1.5 s (measured 2026-11-15).
 */

const { entryStartedAt } = require("./hook-deadline.js");
const { call } = require("./registry-call.js");

const CURL_MAX_TIME_S = 8;
const RETRY_WAIT_MS = 1000;
const RETRY_MAX_TIME_S = 3;

/**
 * One GET through curl, its status code written after the body; a 429
 * waited out and asked again once.
 * @param {string} curl
 * @param {string} url
 * @returns {import("./pip-install.js").Http}
 */
function get(curl, url) {
	const first = getOnce(curl, url, CURL_MAX_TIME_S);
	if ("missing" in first || first.code !== 429) return first;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS);
	return getOnce(curl, url, RETRY_MAX_TIME_S);
}

/**
 * @param {string} curl
 * @param {string} url
 * @param {number} maxTimeS
 * @returns {import("./pip-install.js").Http}
 */
function getOnce(curl, url, maxTimeS) {
	const r = call(
		curl,
		["-sS", "--max-time", String(maxTimeS), "-w", "\n%{http_code}", url],
		maxTimeS * 1000,
	);
	if ("missing" in r) return r;
	if (r.status !== 0) return { code: null, body: "" };
	const at = r.stdout.lastIndexOf("\n");
	const code = Number(r.stdout.slice(at + 1));
	return {
		code: Number.isInteger(code) && code > 0 ? code : null,
		body: at < 0 ? "" : r.stdout.slice(0, at),
	};
}

/**
 * @returns {import("./pip-install.js").PipInstallPorts
 *   & import("./package-vetting.js").VettingPorts}
 */
function buildHostPorts() {
	const curl = process.env.WFC_CURL || "curl";
	return {
		pypi: (name) =>
			get(curl, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`),
		stats: (name) =>
			get(
				curl,
				`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
			),
		now: () => Date.now(),
		startedAt: () => entryStartedAt() ?? Date.now(),
		allowNewPackage: Boolean(process.env.WFC_ALLOW_NEW_PACKAGE),
	};
}

module.exports = { buildHostPorts };
