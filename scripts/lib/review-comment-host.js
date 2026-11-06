/*
 * review-comment-host.js — the production ports the dispatcher wires into the
 * guard-review-comment core, lib/review-comment.js (#4492).
 */

const { readBodyFile } = require("./body-file.js");
const os = require("node:os");

/** @returns {import("./review-comment.js").ReviewCommentPorts} */
const buildHostPorts = () => ({
	home: os.homedir(),
	readFile: readBodyFile,
});

module.exports = { buildHostPorts };
