/*
 * unasked-rerun-io.js — the production `JudgeIO` lib/unasked-rerun.js's
 * `judge` decides over (workflow-core#2913): the latch and refusal log under the markers
 * directory, git, the write ledger, the own-work selection and the
 * pass-marker store, at one repository root.
 *
 * EVERY GIT CALL IS BOUNDED (ADR-0010): `ownSelection`'s and
 * `attestationOf`'s through the ExecFn they take, the arbiter store's under
 * its `withGitTimeout` — and every port that runs git says whether a call
 * overran, which `judge` allows on and logs.
 *
 * Its fake is lib/unasked-rerun-io-fake.js, held to it by
 * unasked-rerun-io.contract.test.ts (§G7).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ownSelection } = require("./own-selection.js");
const store = require("./arbiter-store");
const { markersDir } = require("./marker-root.js");
const {
	attestationOf,
	countMalformed,
	readMarkers,
	storePath,
} = require("./test-pass-marker.js");
const { caught } = require("./caught.js");
const { gitAnswer, HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/* arbiter-markers.js's sweep names the same prefix. */
const LATCH_PREFIX = ".unasked-rerun-refused-";
const REFUSAL_LOG = ".unasked-rerun-refusals.jsonl";

/** @param {string} sid */
const slug = (sid) => sid.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * @param {string} root
 * @param {{ timeoutMs?: number }} [options]
 * @returns {import("./unasked-rerun.js").JudgeIO}
 */
function judgeIO(root, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
	/** @param {string} sid */
	const latchPath = (sid) =>
		path.join(markersDir(root), LATCH_PREFIX + slug(sid));
	/** @param {string[]} args @param {string} cwd */
	const git = (args, cwd) => {
		const { out, timedOut } = gitAnswer(args, { cwd, timeout: timeoutMs });
		return { out: out?.trim() ?? null, timedOut };
	};
	/** @param {string} cwd */
	const gitDir = (cwd) => {
		const { out, timedOut } = git(["rev-parse", "--absolute-git-dir"], cwd);
		return { dir: out, timedOut };
	};
	const boundedExec = () => {
		const seen = { timedOut: false };
		const exec = /** @type {typeof execFileSync} */ (
			/** @type {import("./dirty-tree.js").ExecFn} */
			(file, args, options) => {
				try {
					return execFileSync(file, args, { ...options, timeout: timeoutMs });
				} catch (e) {
					if (caught(e).code === "ETIMEDOUT") seen.timedOut = true;
					throw e;
				}
			}
		);
		return { exec, seen };
	};

	return {
		latched: (sid) => fs.existsSync(latchPath(sid)),
		latch: (sid, at) => fs.writeFileSync(latchPath(sid), `${at}\n`),
		logRefusal: (record) =>
			fs.appendFileSync(
				path.join(markersDir(root), REFUSAL_LOG),
				`${JSON.stringify(record)}\n`,
			),
		gitDir,
		rootGitDir: () => gitDir(root),
		head: () => {
			const { out, timedOut } = git(["rev-parse", "HEAD"], root);
			return { sha: out, timedOut };
		},
		/* The ledger's path is found through the store's repo root, a git read. */
		ledger: (sid) => {
			const { value, overran } = store.withGitTimeout(timeoutMs, () =>
				store.readWritesBy(sid),
			);
			return { readable: value !== null, timedOut: overran };
		},
		selection: (sid) => {
			const { exec, seen } = boundedExec();
			const { value, overran } = store.withGitTimeout(timeoutMs, () =>
				ownSelection(root, sid, { execFn: exec }),
			);
			return { selection: value, timedOut: seen.timedOut || overran };
		},
		storeFault: () => {
			try {
				if (!fs.statSync(storePath(root)).isFile()) return "EISDIR";
				fs.accessSync(storePath(root), fs.constants.R_OK);
				return null;
			} catch (e) {
				return String(caught(e).code ?? e);
			}
		},
		attestation: (tip, within) => {
			const { exec, seen } = boundedExec();
			const verdict = attestationOf(tip, readMarkers({ root }), {
				root,
				execFn: exec,
				...(within ? { within } : {}),
			});
			return { verdict, timedOut: seen.timedOut };
		},
		malformed: () => countMalformed({ root }).malformed,
		now: () => new Date().toISOString(),
	};
}

module.exports = { judgeIO };
