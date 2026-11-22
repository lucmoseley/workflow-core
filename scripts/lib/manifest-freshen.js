const fs = require("node:fs");
const path = require("node:path");
const { claimByArbiter } = require("./script-claim.js");
const { caught } = require("./caught.js");
const { EDGES_FILE } = require("./test-pass-marker.js");
const { buildManifestText } = require("./read-edges-render.js");

// guess, #1860
const CLAIM_TIMEOUT_MS = 5000;

/**
 * @typedef {(file: string, session: string|null, cwd: string) => import("./script-claim.js").ClaimResult} ClaimFn
 * @type {ClaimFn}
 */
function claimWithArbiter(file, session, cwd) {
	return claimByArbiter(file, { session, cwd, timeoutMs: CLAIM_TIMEOUT_MS });
}

/**
 * @param {string} dir
 * @returns {string|null|Error}
 */
function readManifest(dir) {
	try {
		return fs.readFileSync(path.join(dir, EDGES_FILE), "utf8");
	} catch (error) {
		return caught(error).code === "ENOENT"
			? null
			: new Error(caught(error).message);
	}
}

/**
 * @param {string} home
 * @param {string} text
 * @param {{ given: string|null, session: string|null, claimFn: ClaimFn,
 *   err: { write: (s: string) => unknown } }} by
 * @returns {string|null}
 */
function writeShared(home, text, { given, session, claimFn, err }) {
	const shared = readManifest(home);
	if (shared instanceof Error) return `it would not read (${shared.message})`;
	if (shared !== given) return "it holds an edit this run was not given";
	const file = path.join(home, EDGES_FILE);
	const claim = claimFn(file, session, home);
	if (!claim.claimed) return claim.why;
	if (claim.warning) err.write(`${claim.warning}\n`);
	try {
		fs.writeFileSync(file, text);
		return null;
	} catch (error) {
		return caught(error).message;
	}
}

/**
 * @param {Record<string, string[]>} rendered
 * @param {{ root: string, home: string, session: string|null, claimFn?: ClaimFn,
 *   out: { write: (s: string) => unknown }, err: { write: (s: string) => unknown } }} at
 */
function freshenManifest(
	rendered,
	{ root, home, session, claimFn = claimWithArbiter, out, err },
) {
	const text = buildManifestText(rendered);
	const given = readManifest(root);
	if (given === text) return;
	if (given instanceof Error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${given.message}) — the commit gate will ask for it after your run passes (#1860).\n`,
		);
		return;
	}
	try {
		fs.writeFileSync(path.join(root, EDGES_FILE), text);
	} catch (error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${caught(error).message}) — the commit gate will ask for it after your run passes (#1860).\n`,
		);
		return;
	}
	if (home === root || readManifest(home) === text) return;
	const why = writeShared(home, text, { given, session, claimFn, err });
	if (why) {
		err.write(
			`${EDGES_FILE}: the working tree's copy is left alone — ${why}. Regenerate it before you commit: npm run gen:test-read-edges (#1860).\n`,
		);
		return;
	}
	out.write(
		`${EDGES_FILE} brought up to date from the read graph this tree renders, before the run (#1860) — commit it with your work.\n`,
	);
}

module.exports = { freshenManifest };
