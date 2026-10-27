/*
 * commit-check.js — the arbiter store's two answers about a commit (workflow-core#2882):
 * which named paths hold a live neighbour's unsaved claimed work, and what
 * this session wrote.
 */

const { caught } = require("./caught.js");
const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/**
 * The require sits inside the try so a store that will not load fails this
 * advisory check open, as mantahostels#3278 has it, rather than reaching
 * refuse-on-throw's deny. Each git read in the store carries the hook's git
 * timeout, and an overrun fails the sweep check open too (workflow-core#2891).
 * commit-paths.js has no hook budget; it takes the same per-read ceiling
 * because the check is advisory either way, and an overrun only skips it.
 * @type {import("./commit-form.js").CommitFormPorts["commitCheck"]}
 */
function readCommitCheck(paths, sessionId) {
	try {
		const store = require("./arbiter-store.js");
		const {
			value: { sweeps, written },
			overran,
		} = store.withGitTimeout(HOOK_GIT_TIMEOUT_MS, () => {
			const rels = paths
				.map((p) => store.relativeToRepo(p))
				.filter((r) => r !== null);
			return {
				sweeps: store.sweepRisk(rels, sessionId),
				written: store.readWritesBy(sessionId),
			};
		});
		if (overran)
			return {
				sweeps: null,
				written,
				fault: `a git read in the arbiter store overran ${HOOK_GIT_TIMEOUT_MS} ms`,
			};
		return {
			sweeps,
			written,
			fault: written === null ? "the write ledger could not be read" : "",
		};
	} catch (e) {
		return {
			sweeps: null,
			written: null,
			fault: `the arbiter store threw: ${caught(e).message}`,
		};
	}
}

module.exports = { readCommitCheck };
