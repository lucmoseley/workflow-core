/*
 * file-claim-host.js — the production port lib/file-claim.js reads through
 * the dispatcher (#2788): the arbiter's `check`, run as its own process.
 *
 * A PROCESS, NOT A REQUIRE. The arbiter's subcommands are its whole production
 * interface (mantahostels#158), and a hang inside it — the store under an
 * unreadable /proc path blocks in mkdirSync on this kernel — is only killable
 * from outside (mantahostels#175). ARBITER_TIMEOUT_MS bounds it, cut to what
 * the entry's budget leaves (lib/hook-deadline.js), far above the ~80 ms a
 * real check takes.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { caught } = require("./caught.js");
const { budgetMs } = require("./hook-deadline.js");

const ARBITER = path.join(__dirname, "..", "session-arbiter.js");

const ARBITER_TIMEOUT_MS = 5000;

/**
 * @param {string} _root
 * @param {(what: string) => void} _log
 * @param {{ arbiter?: string }} [opts] `arbiter` stands a script in for the
 *   real one, so a case can make it hang or exit non-zero
 * @returns {{ arbiterCheck: (args: string[]) => import("./file-claim.js").ArbiterAnswer }}
 */
function buildHostPorts(_root, _log, { arbiter = ARBITER } = {}) {
	return {
		arbiterCheck: (args) => {
			let r;
			try {
				r = spawnSync(process.execPath, [arbiter, ...args], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: budgetMs(ARBITER_TIMEOUT_MS),
					killSignal: "SIGKILL",
				});
			} catch (e) {
				// An argument holding a NUL byte — an Edit's old_string can — is
				// refused before any process starts.
				return { ok: false, why: caught(e).message, stdout: "" };
			}
			const stdout = r.stdout ?? "";
			if (
				r.error &&
				/** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT"
			)
				return { ok: false, why: "timed out", stdout };
			if (r.status === 0) return { ok: true, stdout };
			return {
				ok: false,
				why: `exited ${r.status ?? r.signal ?? r.error?.message}`,
				stdout,
			};
		},
	};
}

module.exports = { buildHostPorts };
