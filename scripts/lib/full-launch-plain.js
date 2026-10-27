/*
 * full-launch-plain.js — guard-suite-concurrency.js's port for the
 * plain-`--full` limb (workflow-core#181). Apart from lib/suite-concurrency-host.js, which
 * the suite queue requires: this one requires run-vitest.js, which requires the
 * queue.
 *
 * THE SEAM. WFC_READ_GRAPH_RENDERS, `1` or `0`, stands in for the read-graph
 * render — unset, it runs for real, and on a healthy tree it always succeeds,
 * so the limb could never be shown silent.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { coreRoot } = require("./script-path.js");

/**
 * Whether a `--full` launch's argv is plain — nothing narrows it past the
 * whole suite, no `--project` — and the read graph renders from this tree
 * (workflow-core#181, workflow-core#998). Both halves are the launch's and the generator's own
 * (lib/launch-route.js, lib/read-edges-render.js), required here rather than
 * re-read. Required lazily.
 * @param {string[]} argv
 * @returns {{ plain: boolean } | { fault: string }}
 */
function readFullLaunchPlain(argv) {
	const seam = process.env.WFC_READ_GRAPH_RENDERS ?? "";
	try {
		const { isFullRunArgv, stripWrapperFlags } = require("./launch-route.js");
		const rest = stripWrapperFlags(argv.filter((w) => w !== "--"));
		const project = rest.some(
			(/** @type {string} */ w) =>
				w === "--project" || w.startsWith("--project="),
		);
		if (project || !isFullRunArgv(rest)) return { plain: false };
		if (seam === "") {
			const { render, OUT } = require("./read-edges-render.js");
			JSON.parse(fs.readFileSync(path.join(coreRoot(), OUT), "utf8"));
			render(coreRoot());
		}
		return { plain: seam === "" || seam === "1" };
	} catch (e) {
		return { fault: caught(e).message };
	}
}

module.exports = { readFullLaunchPlain };
