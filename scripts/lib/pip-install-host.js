const { entryStartedAt } = require("./hook-deadline.js");
const { call, curlBin } = require("./registry-call.js");
const { sleepSync } = require("./sleep-sync.js");

// guess, #5232
const CURL_MAX_TIME_S = 8;
// guess, #5232
const RETRY_WAIT_MS = 1000;
// guess, #5232
const RETRY_MAX_TIME_S = 3;

/**
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
 * @param {string[]} [headers]
 * @returns {import("./pip-install.js").Http}
 */
function getOnce(curl, url, maxTimeS, headers = []) {
	const r = call(
		curl,
		[
			"-sS",
			"--max-time",
			String(maxTimeS),
			...headers.flatMap((h) => ["-H", h]),
			"-w",
			"\n%{http_code}",
			url,
		],
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

// https://peps.python.org/pep-0792/#json-index
const SIMPLE_JSON = "Accept: application/vnd.pypi.simple.v1+json";

const URLS = {
	/** @param {string} name */
	pypi: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
	/** @param {string} name */
	status: (name) => `https://pypi.org/simple/${encodeURIComponent(name)}/`,
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
		status: (name) =>
			getOnce(curl, URLS.status(name), CURL_MAX_TIME_S, [SIMPLE_JSON]),
		stats: (name) => getRetrying(curl, URLS.stats(name)),
		now: () => Date.now(),
		startedAt: () => entryStartedAt() ?? Date.now(),
		allowNewPackage: Boolean(process.env.WFC_ALLOW_NEW_PACKAGE),
	};
}

module.exports = { URLS, buildHostPorts };
