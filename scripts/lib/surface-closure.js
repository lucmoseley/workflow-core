const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readRunReach } = require("./code-edges.js");

const MANIFEST = "scripts/lib/helper-surface.json";

/**
 * @param {string} manifest
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
 * @param {string} root
 * @param {string} out
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
		for (const { file, from } of reach.outside)
			faults.add(
				`helper surface: ${file}, reached from ${from}, lies outside the render`,
			);
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
