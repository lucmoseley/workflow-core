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
const { execProgram, gitAnswer, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { budgetMs } = require("./hook-deadline.js");

const LATCH_PREFIX = ".unasked-rerun-refused-";
const REFUSAL_LOG = ".unasked-rerun-refusals.jsonl";

/** @param {string} sid */
const slug = (sid) => sid.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * @param {string} root
 * @param {{ tree?: string, timeoutMs?: number }} [options]
 * @returns {import("./unasked-rerun.js").JudgeIO}
 */
function judgeIO(root, { tree = root, timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
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
		const exec =
			/** @type {typeof import("node:child_process").execFileSync} */ (
				/** @type {import("./dirty-tree.js").ExecFn} */
				(file, args, options) => {
					try {
						return execProgram(file, args, {
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
		treeGitDir: () => gitDir(tree),
		head: () => {
			const { out, timedOut } = git(["rev-parse", "HEAD"], tree);
			return { sha: out, timedOut };
		},
		ledger: (sid) => {
			const { value, overran } = store.withGitTimeout(timeoutMs, () =>
				store.readWritesBy(sid),
			);
			return { readable: value !== null, timedOut: overran };
		},
		selection: (sid) => {
			const { exec, seen } = boundedExec();
			const { value, overran } = store.withGitTimeout(timeoutMs, () =>
				ownSelection(tree, sid, { execFn: exec }),
			);
			return { selection: value, timedOut: seen.timedOut || overran };
		},
		storeFault: () => readStoreFault(storePath(root)),
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
 * @param {string} root
 * @param {typeof import("node:child_process").execFileSync} exec
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

/** @param {string} at @returns {string|null} */
function readStoreFault(at) {
	try {
		if (!fs.statSync(at).isFile()) return "EISDIR";
		fs.accessSync(at, fs.constants.R_OK);
		return null;
	} catch (e) {
		return String(caught(e).code ?? e);
	}
}

/** @param {string} root */
function readRedStoreFault(root) {
	const code = readStoreFault(storePath(root, FAIL_STORE));
	if (code) return code === "ENOENT" ? null : code;
	const { malformed } = countMalformed({ root, store: FAIL_STORE });
	return malformed > 0 ? `${malformed} malformed line(s)` : null;
}

/** @param {ReturnType<typeof attestationOf>} verdict */
const isSettled = (verdict) =>
	!verdict.judged ||
	verdict.suites.some((s) => s.suite === DEFAULT_SUITE && s.attested);

/** @param {Marker} m */
const isClassable = (m) =>
	suiteOf(m) === DEFAULT_SUITE &&
	Boolean(m.base) &&
	m.scope?.errors === 0 &&
	(isFullRun(m) || isAdmissibleRun(m));

/**
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
