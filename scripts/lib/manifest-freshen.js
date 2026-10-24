/*
 * manifest-freshen.js — the read-edge manifest an overlay run's tree should
 * carry, written before the run is planned wherever the graph that tree
 * renders differs from it (#1860).
 *
 * The plan then selects the manifest's readers and names it among the paths
 * the green covers, so the commit gate does not regenerate it after the
 * green.
 *
 * THE SHARED TREE'S COPY IS WRITTEN TOO, so the commit carries it: under the
 * session's own claim, as a script writing a tracked doc must take, and only
 * where that copy still holds what the overlay was given, so a neighbour's
 * uncommitted manifest is never written over. Either refusal leaves the shared copy
 * alone and says so.
 *
 * A shared-tree run writes nothing: its render reads every neighbour's
 * uncommitted test, which the session's commit will not carry.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { EDGES_FILE } = require("./test-pass-marker.js");
const { manifestText } = require("../generate-test-read-edges.js");

// A guess, never measured: a claim is one arbiter call, and a slow one leaves
// the shared copy alone, said.
const CLAIM_TIMEOUT_MS = 5000;

/**
 * A claim taken on `file` for `session`, by the arbiter's own CLI, or why not.
 * @typedef {(file: string, session: string|null, cwd: string) => { ok: true } | { ok: false, why: string }} ClaimFn
 * @type {ClaimFn}
 */
function claimWithArbiter(file, session, cwd) {
	const claim = spawnSync(
		process.execPath,
		[
			path.join(__dirname, "..", "session-arbiter.js"),
			"claim",
			file,
			...(session ? [session] : []),
		],
		{ cwd, encoding: "utf8", timeout: CLAIM_TIMEOUT_MS },
	);
	return claim.status === 0
		? { ok: true }
		: {
				ok: false,
				why:
					`${claim.stderr ?? ""}${claim.stdout ?? ""}`.trim() ||
					`the arbiter exited ${claim.status}`,
			};
}

/**
 * The manifest under `dir`: its text, null where there is none, or an Error
 * where it would not read — which leaves the shared copy alone, since nothing
 * then says whose edit it holds.
 *
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
 * The shared tree's manifest written, or why it was left alone: it holds an
 * edit the overlay was not `given`, a live session holds it, or the write
 * failed.
 *
 * @param {string} home
 * @param {string} text
 * @param {{ given: string|null, session: string|null, claimFn: ClaimFn }} by
 * @returns {string|null}
 */
function writeShared(home, text, { given, session, claimFn }) {
	const shared = readManifest(home);
	if (shared instanceof Error) return `it would not read (${shared.message})`;
	if (shared !== given) return "it holds an edit this run was not given";
	const file = path.join(home, EDGES_FILE);
	const claim = claimFn(file, session, home);
	if (!claim.ok) return claim.why;
	try {
		fs.writeFileSync(file, text);
		return null;
	} catch (error) {
		return caught(error).message;
	}
}

/**
 * `rendered` written to the overlay at `root`, then to the shared tree at
 * `home` by `writeShared`'s rules — each step said on `out` or `err`.
 *
 * @param {Record<string, string[]>} rendered
 * @param {{ root: string, home: string, session: string|null, claimFn?: ClaimFn,
 *   out: { write: (s: string) => unknown }, err: { write: (s: string) => unknown } }} at
 */
function freshenManifest(
	rendered,
	{ root, home, session, claimFn = claimWithArbiter, out, err },
) {
	const text = manifestText(rendered);
	const given = readManifest(root);
	if (given === text) return;
	if (given instanceof Error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${given.message}) — the commit gate will ask for it after your green (#1860).\n`,
		);
		return;
	}
	try {
		fs.writeFileSync(path.join(root, EDGES_FILE), text);
	} catch (error) {
		err.write(
			`${EDGES_FILE} not brought up to date before the run (${caught(error).message}) — the commit gate will ask for it after your green (#1860).\n`,
		);
		return;
	}
	if (home === root || readManifest(home) === text) return;
	const why = writeShared(home, text, { given, session, claimFn });
	if (why) {
		err.write(
			`${EDGES_FILE}: the shared tree's copy is left alone — ${why}. Regenerate it before you commit: npm run gen:test-read-edges (#1860).\n`,
		);
		return;
	}
	out.write(
		`${EDGES_FILE} brought up to date from the read graph this tree renders, before the run (#1860) — commit it with your work.\n`,
	);
}

module.exports = { freshenManifest };
