const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/**
 * @param {string[]} argv
 * @param {string} tree
 * @returns {{ plain: boolean } | { fault: string }}
 */
function readFullLaunchPlain(argv, tree) {
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
			JSON.parse(fs.readFileSync(path.join(tree, OUT), "utf8"));
			render(tree);
		}
		return { plain: seam === "" || seam === "1" };
	} catch (e) {
		return { fault: caught(e).message };
	}
}

module.exports = { readFullLaunchPlain };
