/*
 * surface-closure.js — does a rendered plugin tree carry the helper surface
 * whole? Every entry point and command scripts/lib/helper-surface.json lists
 * (#655), every file each one reaches, and nothing reached from outside the
 * tree (#464, spec #457).
 *
 * A PRESENCE CLOSURE, NOT A LOAD CLOSURE: a file loaded lazily, or run rather
 * than imported, still has to ship. The reach is code-edges.js's
 * `readRunReach`, a data file a script reads off its directory included, and
 * leaves out a path outside the tree or in a `node_modules`. A Python
 * module code-edges.js cannot place is a fault. A JS file's npm
 * package is not judged here: plugin-tree.js's scan already faults one in
 * every shipped file.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readRunReach } = require("./code-edges.js");

const MANIFEST = "scripts/lib/helper-surface.json";

/**
 * Each root the manifest declares, by its path in the rendered tree, to its
 * kind.
 * @param {string} manifest the manifest's path
 * @returns {Map<string, string>}
 */
function readSurfaceRoots(manifest) {
	const { entryPoints, commands } = JSON.parse(
		fs.readFileSync(manifest, "utf8"),
	);
	const roots = new Map();
	for (const rel of Object.keys(entryPoints ?? {}))
		roots.set(rel, "entry point");
	for (const rel of Object.keys(commands ?? {})) roots.set(rel, "command");
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
	const roots = readSurfaceRoots(manifest);
	const runReach = readRunReach(out);
	/** @type {Set<string>} */
	const faults = new Set();
	for (const [start, kind] of roots) {
		let reach;
		try {
			reach = runReach(start, (file, msg) =>
				faults.add(`helper surface: ${file} ${msg}`),
			);
		} catch (err) {
			faults.add(
				`helper surface: ${start} goes unjudged — ${caught(err).message}`,
			);
			continue;
		}
		for (const { file, from } of reach.missing)
			faults.add(
				from === null
					? `helper surface: ${kind} ${file} is missing from the render`
					: `helper surface: ${file}, reached from ${from}, is missing from the render`,
			);
	}
	return [...faults];
}

module.exports = { surfaceClosureFaults };
