/*
 * review-comment-host.js — the production ports the dispatcher wires into the
 * guard-review-comment core, lib/review-comment.js (#4492).
 */

const fs = require("node:fs");
const os = require("node:os");

/** @returns {import("./review-comment.js").ReviewCommentPorts} */
const buildHostPorts = () => ({
	home: os.homedir(),
	readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined),
});

module.exports = { buildHostPorts };
