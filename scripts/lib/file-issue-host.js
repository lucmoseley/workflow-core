/*
 * file-issue-host.js — the production ports scripts/file-issue.js wires into
 * lib/file-issue-core.js (#5150).
 */

const fs = require("node:fs");
const { gh } = require("./gh.js");
const { runLinkSync } = require("./link-writer.js");
const { readGateWrite } = require("./gate-judge.js");
const { now } = require("./check.js");
const { readFdAll } = require("./read-fd.js");

/**
 * The sub-issue link through lib/link-writer.js.
 * @type {import("./file-issue-core.js").FileIssuePorts["link"]}
 */
function link(repo, parent, child) {
	const r = runLinkSync("sub-issue", [String(parent), String(child)], {
		repo,
	});
	if (r.code === 0) return { ok: r.out.trim(), warning: r.warning };
	return { error: r.err || "no output" };
}

/** @returns {import("./file-issue-core.js").FileIssuePorts} */
const buildHostPorts = () => ({
	gh,
	link,
	judge: (body) => readGateWrite(body, { route: "file-issue" }),
	readBody: (file) =>
		file === "-"
			? readFdAll(0).toString("utf8")
			: fs.readFileSync(file, "utf8"),
	/* A stray WFC_NOW in the session's env skews this durable stamp (check.js `now`). */
	now,
});

module.exports = { buildHostPorts, link };
