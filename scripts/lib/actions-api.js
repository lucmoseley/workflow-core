/*
 * actions-api.js — GitHub's REST API from inside an Actions job, for the
 * checks that run off the machine (main-lag-alarm.js, alarm-notice.js;
 * #4939). Reads GITHUB_API_URL and GH_TOKEN, as Actions sets them. No `gh`,
 * so a sparse checkout needs no install.
 *
 * A read retries READ_TRIES times, RETRY_MS apart, and throws the last
 * failure: an off-machine alarm that reads one dropped call as an answer is
 * wrong exactly when nobody can look. A write is tried once, as a lost reply
 * to a comment that landed would post it twice.
 */

/* Guesses: one read's tries and the pause between them. */
const READ_TRIES = 4;
const RETRY_MS = 2000;

/**
 * @typedef {(path: string) => Promise<unknown>} Get the parsed JSON at a path
 *   under the API root, throwing on any failure
 * @typedef {(path: string, body: unknown) => Promise<unknown>} Post
 */

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{get: Get, post: Post}}
 */
function buildActionsApi(env) {
	/**
	 * @param {string} path
	 * @param {RequestInit} init
	 * @param {number} tries
	 */
	const call = async (path, init, tries) => {
		let last;
		for (let i = 0; i < tries; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
			try {
				const res = await fetch(`${env.GITHUB_API_URL}${path}`, {
					...init,
					headers: {
						Authorization: `Bearer ${env.GH_TOKEN}`,
						Accept: "application/vnd.github+json",
					},
				});
				if (res.ok) return await res.json();
				last = new Error(`${path}: HTTP ${res.status}`);
			} catch (e) {
				last = e;
			}
		}
		throw last;
	};
	return {
		get: (path) => call(path, {}, READ_TRIES),
		post: (path, body) =>
			call(path, { method: "POST", body: JSON.stringify(body) }, 1),
	};
}

module.exports = { buildActionsApi };
