/*
 * pip-install-host.js — the production ports the dispatcher wires into the
 * guard-pip-install core, lib/pip-install.js (workflow-core#5232).
 *
 * THE SEAM. WFC_CURL names curl (lib/registry-call.js).
 *
 * THE TIMEOUTS. Each GET gets curl's own `--max-time` of 8 s and the
 * spawn's, two a package. pypistats rate-limits a burst (workflow-core#5232), so its 429
 * waits 1 s and retries once with 3 s: 8 + 8 + 1 + 3, the 20 s a package
 * lib/package-vetting.js's 30 s budget is sized against. PyPI's JSON is not
 * retried, which holds that 20 s. The 8 s is a guess carried from the npm
 * host.
 */

const { entryStartedAt } = require("./hook-deadline.js");
const { call, curlBin } = require("./registry-call.js");
const { sleepSync } = require("./sleep-sync.js");

const CURL_MAX_TIME_S = 8;
const RETRY_WAIT_MS = 1000;
const RETRY_MAX_TIME_S = 3;

/**
 * One GET through curl, a 429 waited out and asked again once.
 * @param {string} curl
 * @param {string} url
 * @returns {import("./pip-install.js").Http}
 */
function getRetrying(curl, url) {
	const first = getOnce(curl, url, CURL_MAX_TIME_S);
	if ("missing" in first || first.code !== 429) return first;
	sleepSync(RETRY_WAIT_MS);
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

/** The URL each port asks for a package. */
const URLS = {
	/** @param {string} name */
	pypi: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
	/** @param {string} name */
	stats: (name) =>
		`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
};

/**
 * @returns {import("./pip-install.js").PipInstallPorts
 *   & import("./package-vetting.js").VettingPorts}
 */
function buildHostPorts() {
	const curl = curlBin();
	return {
		pypi: (name) => getOnce(curl, URLS.pypi(name), CURL_MAX_TIME_S),
		stats: (name) => getRetrying(curl, URLS.stats(name)),
		now: () => Date.now(),
		startedAt: () => entryStartedAt() ?? Date.now(),
		allowNewPackage: Boolean(process.env.WFC_ALLOW_NEW_PACKAGE),
	};
}

module.exports = { URLS, buildHostPorts };
