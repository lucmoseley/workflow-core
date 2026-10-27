/*
 * job-dir.js — is a path under the background job's scratch tree, and where
 * under it does it sit? The predicate the job-dir-scratch and tracker-rules
 * dispatcher cores share (#2789, #2792), and jobRel beside it.
 *
 * Purely textual: the file need not exist. `pwd` is the directory a relative
 * path resolves against, `jobDir` the CLAUDE_JOB_DIR the caller sees, "" where
 * it is unset.
 */

const { absolute } = require("./shell-words.js");

/** @typedef {{ pwd: string, jobDir: string }} Where */

/** The `<config>/jobs/<id>/` shape, anchored on a dot-prefixed config
 * directory so an ordinary `jobs/` directory in a repo is not read as one. */
const SHAPE_RE = /\/\.claude.*\/jobs\/.*\//s;
const VAR_REL_RE = /\$\{?CLAUDE_JOB_DIR\}?\/(.+)$/s;
const SHAPE_REL_RE = /\/\.claude[^/]*\/jobs\/[^/]+\/(.+)$/s;

/** @param {string} dir */
const trimSlash = (dir) => dir.replace(/\/$/, "");

/**
 * Is `p` under the job directory? Only a path-shaped word — one holding a `/`
 * — is resolved (#1731): a bare relative filename is never under it, so a
 * caller judging one resolves it first.
 * @param {string} p
 * @param {Where} where
 */
function isJobDir(p, { pwd, jobDir }) {
	/* The unexpanded spelling, as the preamble prints it. */
	if (p.includes("CLAUDE_JOB_DIR")) return true;
	if (!p.includes("/")) return false;
	const abs = absolute(p, pwd);
	/* A trailing slash on both sides keeps a sibling sharing the prefix out. */
	if (jobDir && `${abs}/`.startsWith(`${trimSlash(jobDir)}/`)) return true;
	/* The shape, for a hook environment that did not carry the variable. */
	return SHAPE_RE.test(abs);
}

/**
 * Where `p` sits inside the job directory, relative to its root (`tmp/a.md`);
 * null where it is not under one, or names
 * it with no path below. NARROWER THAN isJobDir ON PURPOSE: a path its looser
 * tests take with no one place to cut gets no answer, so its caller warns where
 * it would refuse (mantahostels#103).
 * @param {string} p
 * @param {Where} where
 * @returns {string | null}
 */
function jobRel(p, { pwd, jobDir }) {
	const byVar = VAR_REL_RE.exec(p);
	if (byVar) return byVar[1] ?? null;
	if (!p.includes("/")) return null;
	const abs = absolute(p, pwd);
	const root = `${trimSlash(jobDir)}/`;
	if (jobDir && abs.startsWith(root) && abs.length > root.length)
		return abs.slice(root.length);
	return SHAPE_REL_RE.exec(abs)?.[1] ?? null;
}

module.exports = { isJobDir, jobRel };
