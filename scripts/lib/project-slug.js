const path = require("node:path");
const { hostRoot } = require("./host-root.js");

/**
 * @param {string} [cwd]
 * @returns {string}
 */
const projectSlug = (cwd = process.cwd()) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const UNRESOLVED_ROOT_SLUG = "unresolved-root";

/** @returns {string} */
const slugForRepo = () => projectSlug(hostRoot());

/**
 * @param {string} seat
 * @param {string} cwd
 * @param {string} sessionId
 */
const transcriptPath = (seat, cwd, sessionId) =>
	path.join(seat, "projects", projectSlug(cwd), `${sessionId}.jsonl`);

module.exports = {
	projectSlug,
	slugForRepo,
	transcriptPath,
	UNRESOLVED_ROOT_SLUG,
};
