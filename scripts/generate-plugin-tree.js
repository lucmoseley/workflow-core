#!/usr/bin/env node
/*
 * generate-plugin-tree.js — writes the plugin tree an adopter installs into a
 * directory, from the working tree (#4). What ships and why: lib/plugin-tree.js.
 * A release renders from HEAD instead, through release-plugin.js.
 *
 * Usage:
 *   node scripts/generate-plugin-tree.js <out-dir>
 *
 * <out-dir> must not exist yet. Exits 1, naming the reason on stderr, where the
 * tree cannot be rendered.
 */

const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { buildTree } = require("./lib/plugin-tree.js");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");

const USAGE = "usage: node scripts/generate-plugin-tree.js <out-dir>";

function main() {
	const parsed = parseOrCode(process.argv.slice(2), { usage: USAGE, max: 1 });
	/* A usage refusal is 2 from cli-args; a generator exits 0 or 1 (base §N3). */
	if (typeof parsed === "number") return parsed === 0 ? 0 : 1;
	const [out] = parsed.positionals;
	if (!out) {
		writeFd(2, `generate-plugin-tree: no output directory — ${USAGE}\n`);
		return 1;
	}
	try {
		buildTree(hostRoot(), path.resolve(out));
	} catch (err) {
		writeFd(2, `generate-plugin-tree: ${caught(err).message}\n`);
		return 1;
	}
	return 0;
}

if (require.main === module) process.exit(main());
