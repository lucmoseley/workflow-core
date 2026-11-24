const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { caught } = require("./caught.js");
const { budgetMs } = require("./hook-deadline.js");

const ARBITER = path.join(__dirname, "..", "session-arbiter.js");

/* guess, workflow-core#2788 */
const ARBITER_TIMEOUT_MS = 5000;

/**
 * @param {unknown} _env
 * @param {{ arbiter?: string }} [opts]
 * @returns {{ arbiterCheck: (args: string[], cwd: string) => import("./file-claim.js").ArbiterAnswer }}
 */
function buildHostPorts(_env, { arbiter = ARBITER } = {}) {
	return {
		arbiterCheck: (args, cwd) => {
			let r;
			try {
				r = spawnSync(process.execPath, [arbiter, ...args], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: budgetMs(ARBITER_TIMEOUT_MS),
					killSignal: "SIGKILL",
				});
			} catch (e) {
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
