/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
function fromEnv(env = process.env) {
	return env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * @param {{session_id?: string}|null|undefined} input
 * @returns {string|null}
 */
function fromPayload(input) {
	return input?.session_id || null;
}

const REPORT_OWNER = "WFC_REPORT_OWNER";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
function reportOwner(env = process.env) {
	return env[REPORT_OWNER] || fromEnv(env);
}

const LANDER_RUN = "WFC_LANDER_RUN";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isLanderRun(env = process.env) {
	return env[LANDER_RUN] === "1";
}

const FORGOTTEN_KEYS = Object.freeze([
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_JOB_DIR",
	REPORT_OWNER,
]);

/** @param {Record<string, string|undefined>} env */
function forgetSession(env) {
	for (const key of FORGOTTEN_KEYS) delete env[key];
}

module.exports = {
	fromEnv,
	fromPayload,
	reportOwner,
	forgetSession,
	REPORT_OWNER,
	isLanderRun,
	LANDER_RUN,
};
