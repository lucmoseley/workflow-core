const { absolute } = require("./shell-words.js");
const { isUnder, relativeUnder } = require("./is-under.js");

/** @typedef {{ pwd: string, jobDir: string }} Where */

const SHAPE_RE = /\/\.claude.*\/jobs\/.*\//s;
const VAR_REL_RE = /\$\{?CLAUDE_JOB_DIR\}?\/(.+)$/s;
const SHAPE_REL_RE = /\/\.claude[^/]*\/jobs\/[^/]+\/(.+)$/s;

/** @param {string} dir */
const trimSlash = (dir) => dir.replace(/\/$/, "");

/**
 * @param {string} p
 * @param {Where} where
 */
function isJobDir(p, { pwd, jobDir }) {
	if (p.includes("CLAUDE_JOB_DIR")) return true;
	if (!p.includes("/")) return false;
	const abs = absolute(p, pwd);
	if (jobDir && isUnder(abs, [trimSlash(jobDir)])) return true;
	return SHAPE_RE.test(abs);
}

/**
 * lucmoseley/mantahostels#103
 * @param {string} p
 * @param {Where} where
 * @returns {string | null}
 */
function jobRel(p, { pwd, jobDir }) {
	const byVar = VAR_REL_RE.exec(p);
	if (byVar) return byVar[1] ?? null;
	if (!p.includes("/")) return null;
	const abs = absolute(p, pwd);
	const rel = jobDir ? relativeUnder(jobDir, abs) : null;
	if (rel) return rel;
	return SHAPE_REL_RE.exec(abs)?.[1] ?? null;
}

module.exports = { isJobDir, jobRel };
