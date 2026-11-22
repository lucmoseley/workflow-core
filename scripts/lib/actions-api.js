// guess, #5529
const READ_TRIES = 4;
const RETRY_MS = 2000;

/**
 * @typedef {(path: string) => Promise<unknown>} Get
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
