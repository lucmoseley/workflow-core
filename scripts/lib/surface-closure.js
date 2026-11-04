/*
 * surface-closure.js — does a rendered plugin tree carry the helper surface
 * whole? Every entry point and command scripts/lib/helper-surface.json lists
 * (#655), every file each one reaches, and nothing reached from outside the
 * tree (#464, spec #457).
 *
 * A PRESENCE CLOSURE, NOT A LOAD CLOSURE: a file loaded lazily, or run rather
 * than imported, still has to ship. The edges are code-edges.js's. A Python
 * module neither stdlib nor beside its importer is a fault. A JS file's npm
 * package is not judged here: plugin-tree.js's scan already faults one in
 * every shipped file.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { edgesOf } = require("./code-edges.js");

const MANIFEST = "scripts/lib/helper-surface.json";

/**
 * Each root the manifest declares, by its absolute path in `out`, to its kind.
 * @param {string} manifest the manifest's path
 * @param {string} out the rendered tree
 * @returns {Map<string, string>}
 */
function readSurfaceRoots(manifest, out) {
	const { entryPoints, commands } = JSON.parse(
		fs.readFileSync(manifest, "utf8"),
	);
	const roots = new Map();
	for (const rel of Object.keys(entryPoints ?? {}))
		roots.set(path.join(out, rel), "entry point");
	for (const rel of Object.keys(commands ?? {}))
		roots.set(path.join(out, rel), "command");
	return roots;
}

/**
 * Faults in the rendered tree `out` against the helper surface `root`
 * declares; none where `root` declares no surface.
 * @param {string} root the source the tree was rendered from
 * @param {string} out the rendered tree
 * @returns {string[]}
 */
function surfaceClosureFaults(root, out) {
	const manifest = path.join(root, MANIFEST);
	if (!fs.existsSync(manifest)) return [];
	const roots = readSurfaceRoots(manifest, out);
	/** @type {string[]} */
	const faults = [];
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {[string, string | null][]} path, and the file that reached it */
	const queue = [...roots.keys()].map((abs) => [abs, null]);
	const relOf = (/** @type {string} */ abs) => path.relative(out, abs);
	while (queue.length > 0) {
		const [abs, from] = /** @type {[string, string | null]} */ (queue.shift());
		if (seen.has(abs)) continue;
		seen.add(abs);
		if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) {
			faults.push(
				from === null
					? `helper surface: ${roots.get(abs)} ${relOf(abs)} is missing from the render`
					: `helper surface: ${relOf(abs)}, reached from ${relOf(from)}, is missing from the render`,
			);
			continue;
		}
		const report = (/** @type {string} */ msg) =>
			faults.push(`helper surface: ${relOf(abs)} ${msg}`);
		try {
			for (const edge of edgesOf(abs, fs.readFileSync(abs, "utf8"), report))
				queue.push([edge, abs]);
		} catch (err) {
			report(`goes unjudged — ${caught(err).message}`);
		}
	}
	return faults;
}

module.exports = { surfaceClosureFaults };
