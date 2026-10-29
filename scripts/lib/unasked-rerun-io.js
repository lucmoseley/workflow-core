/*
 * unasked-rerun-io.js — the production `JudgeIO` lib/unasked-rerun.js's
 * `judge` decides over (#2913): the latch and refusal log under the markers
 * directory, git, the write ledger, the own-work selection, the
 * pass-marker store and the red store, at one repository root.
 *
 * A CLASSED RED STANDS BESIDE THE CERTIFICATES (#3633), asked only where
 * certificates alone do not attest: a red-store run whose every failure
 * lib/already-red.js classes as already red on its base. A torn or
 * unreadable red store, or a classing that throws, costs the classed reds
 * alone and goes back as `redFault`.
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
	DEFAULT_SUITE,
	FAIL_STORE,
	isAdmissibleRun,
	isFullRun,
	readMarkers,
	storePath,
	suiteOf,
} = require("./test-pass-marker.js");
const { classifyFailures, readRedEvidence } = require("./already-red.js");
const { caught } = require("./caught.js");
const { gitAnswer, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { budgetMs } = require("./hook-deadline.js");

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
					return execFileSync(file, args, {
						...options,
						timeout: budgetMs(timeoutMs),
					});
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
			const certificates = readMarkers({ root });
			/** @param {Marker[]} markers */
			const judgeOver = (markers) =>
				attestationOf(tip, markers, {
					root,
					execFn: exec,
					...(within ? { within } : {}),
				});
			const alone = judgeOver(certificates);
			if (seen.timedOut || isSettled(alone))
				return { verdict: alone, timedOut: seen.timedOut, redFault: null };
			const { reds, redFault } = readClassedReds(root, exec, seen);
			const verdict =
				reds.length === 0 ? alone : judgeOver(byAge(certificates, reds));
			return { verdict, timedOut: seen.timedOut, redFault };
		},
		malformed: () => countMalformed({ root }).malformed,
		now: () => new Date().toISOString(),
	};
}

/**
 * @typedef {import("./test-pass-marker.js").Marker} Marker
 * @typedef {import("./unasked-rerun.js").ClassedRed} ClassedRed
 */

/**
 * The red store's runs that class as already red, oldest first, or why the
 * store could not be read for them.
 *
 * @param {string} root
 * @param {typeof execFileSync} exec
 * @param {{timedOut: boolean}} seen
 * @returns {{reds: ClassedRed[], redFault: string|null}}
 */
function readClassedReds(root, exec, seen) {
	const fault = readRedStoreFault(root);
	if (fault)
		return { reds: [], redFault: `the red store could not be read (${fault})` };
	try {
		const record = readRedEvidence(root);
		/** @type {ClassedRed[]} */
		const reds = [];
		for (const m of [...record.reds].reverse()) {
			if (!isClassable(m)) continue;
			const classing = classifyFailures(m, record, { root, execFn: exec });
			if (seen.timedOut) break;
			if (classing?.allAlreadyRed) reds.unshift({ ...m, alreadyRed: classing });
		}
		return { reds, redFault: null };
	} catch (e) {
		return {
			reds: [],
			redFault: `already-red runs could not be judged (${caught(e).message ?? e})`,
		};
	}
}

/**
 * Why the red store will not read whole, or null where it does or is absent.
 * @param {string} root
 */
function readRedStoreFault(root) {
	const at = storePath(root, FAIL_STORE);
	try {
		if (!fs.statSync(at).isFile()) return "EISDIR";
		fs.accessSync(at, fs.constants.R_OK);
	} catch (e) {
		const code = String(caught(e).code ?? e);
		return code === "ENOENT" ? null : code;
	}
	const { malformed } = countMalformed({ root, store: FAIL_STORE });
	return malformed > 0 ? `${malformed} malformed line(s)` : null;
}

/**
 * Unjudged, or vitest attested: nothing a classed red could add.
 * @param {ReturnType<typeof attestationOf>} verdict
 */
const isSettled = (verdict) =>
	!verdict.judged ||
	verdict.suites.some((s) => s.suite === DEFAULT_SUITE && s.attested);

/**
 * A red that could hold, and whose every error a failing test names.
 * @param {Marker} m
 */
const isClassable = (m) =>
	suiteOf(m) === DEFAULT_SUITE &&
	Boolean(m.base) &&
	m.scope?.errors === 0 &&
	(isFullRun(m) || isAdmissibleRun(m));

/**
 * Certificates and classed reds in one store order, oldest first, so
 * `attestationOf` asks the newest first whichever store it came from.
 * @param {Marker[]} certificates
 * @param {ClassedRed[]} reds
 * @returns {Marker[]}
 */
const byAge = (certificates, reds) =>
	reds.length === 0
		? certificates
		: [...certificates, ...reds].sort((a, b) =>
				String(a.at ?? "").localeCompare(String(b.at ?? "")),
			);

module.exports = { judgeIO };
