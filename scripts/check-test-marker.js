#!/usr/bin/env node
/*
 * The pre-push half of mantahostels#987's warn-only gate: do certificates from any
 * sessions attest every commit being pushed, between them (ADR-0009, workflow-core#814)?
 *
 * git feeds a pre-push hook `<local ref> <local sha> <remote ref> <remote sha>`
 * per ref on stdin. A delete pushes the all-zero local sha and has no bytes to
 * test, so it is skipped.
 *
 * THE RANGE starts at the remote sha git passes — `attestationOf` falls back to the
 * merge-base with the pushed ref where the remote has no tip — and each suite
 * the range reaches answers for itself (mantahostels#1256).
 *
 * SKIP where the adopter has not switched the `suites` module on (workflow-core#2;
 * mantahostels#3515 F19): a repo with no suite has no certificate to show, and
 * would be warned on every push. The same where its test command writes no
 * marker (workflow-core#740) — pre-commit runs that one instead (lib/test-gate.js) — and
 * where the `landing` module is on: the lander runs the full suite, so no push
 * owes a certificate (workflow-core#2929).
 *
 * The modules are read from the config at the pushing tree's HEAD, as
 * landing-push-gate.js reads them, and the markers from the canonical
 * checkout (workflow-core#3128, workflow-core#3132).
 *
 * EVERY FINDING IS AN INTRINSIC WARN: mantahostels#908 ruled the gate warns and
 * never refuses a push. Its own failure is BROKEN at exit 2 like any checker's,
 * printed rather than swallowed; that it still refuses no push is the hook's
 * `|| :`, in `.husky/pre-push` and so in every adopter's copy (workflow-core#1444).
 */

const fs = require("node:fs");
const { runCheck } = require("./lib/check.js");
const {
	attestationOf,
	attestationReading,
	readMarkers,
	repoRoot,
} = require("./lib/test-pass-marker.js");
const { parsePushes } = require("./lib/push-refs.js");
const { pushGateState } = require("./lib/test-gate.js");
const { readTopLevel } = require("./lib/git-tree.js");
const { caught } = require("./lib/caught.js");

runCheck({
	name: "test-marker",
	usage: "printf '%s\\n' \"$refs\" | node scripts/check-test-marker.js",
	run(ctx) {
		let stdin = "";
		try {
			stdin = fs.readFileSync(0, "utf8");
		} catch (e) {
			ctx.broken(
				`could not read the pushed refs on stdin: ${caught(e).message}`,
			);
		}
		const pushes = parsePushes(stdin);
		if (pushes.length === 0) return { okLine: "no pushed ref to judge." };
		const tree = readTopLevel(process.cwd());
		if (tree === null)
			return ctx.skip("no pushing tree here, so no config to read.");
		const gate = pushGateState({ root: tree, rev: "HEAD" });
		if (gate.state === "broken") ctx.broken(gate.line);
		if (gate.state === "skip") ctx.skip(gate.line);
		const markers = readMarkers({ root: repoRoot() });
		for (const { sha, remoteSha } of pushes) {
			const verdict = attestationOf(sha, markers, {
				remoteSha: remoteSha ?? null,
			});
			const { state, text } = attestationReading(sha, verdict, {
				pushing: true,
			});
			if (text) ctx.say(text.trimEnd());
			// An attested reading's text is a note, its dirty-tree line included,
			// as push-check.js reads it.
			if (state !== "attested") ctx.warn(state, text.trim(), { sha }, sha);
		}
		return {
			okLine: "certificates attest every pushed commit.",
			noun: "pushed commit(s) no certificate is shown to attest",
		};
	},
});
