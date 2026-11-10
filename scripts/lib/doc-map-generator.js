/*
 * doc-map-generator.js — the CLI argv parser and the claim/release stanza
 * shared by generate-doc-map-section-a.js and register-doc.js. mantahostels#1596: each carried its own near-verbatim
 * copy, so a correction to the fail-open wording or the claim command landed
 * in one and read as done everywhere.
 *
 * Each generator keeps its own derivation and its own DATA_FILES key; only
 * the argv handling and the claim move here.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { claimByArbiter } = require("./arbiter-claim.js");
const { writeFd } = require("./write-fd.js");

/** Flags every generator accepts that take a value, so the positional-arg
 * filter skips both the flag and what follows it. */
const VALUE_FLAGS = ["--data-dir", "--claim-cmd", "--release-cmd"];

/**
 * `extraValueFlags` names value-taking flags this caller adds. Without it a
 * caller's own `--x <value>` leaves `<value>` in `args`, so a flags-first
 * invocation makes a flag's value the first positional (mantahostels#1848 review, S2 —
 * `register-doc.js --class free-edit docs/x.md` registered `free-edit` as
 * the path).
 *
 * @param {string[]} argv
 * @param {string[]} [extraValueFlags]
 * @returns {{args: string[], flag: (name: string) => boolean, value: (name: string) => string | null}}
 */
function parseCliArgs(argv, extraValueFlags = []) {
	const valueFlags = [...VALUE_FLAGS, ...extraValueFlags];
	const args = argv.filter((a, i) => {
		const prev = argv[i - 1];
		return (
			!a.startsWith("--") && (prev === undefined || !valueFlags.includes(prev))
		);
	});
	const flag = (/** @type {string} */ name) => argv.includes(name);
	const value = (/** @type {string} */ name) => {
		const i = argv.indexOf(name);
		return i === -1 ? null : (argv[i + 1] ?? null);
	};
	return { args, flag, value };
}

/**
 * Claims `dataFile` before it is overwritten. The PreToolUse claim hook
 * watches Write/Edit only, so a script writing a guarded docs/ path is
 * invisible to it — this is what records the bytes about to be replaced.
 *
 * Fails open (mantahostels#1194): a claim the arbiter refuses costs the
 * content record and nothing else, and is never grounds to stop the write. A
 * claim on a file a live neighbour also holds succeeds, and the arbiter's
 * warning of the likely merge conflict is passed on (#4249, #4403).
 *
 * `generator: true` marks the caller as the §A generator, which is what lets a
 * claim on docs/doc-map.md's derived §A through (mantahostels#2422, and
 * doc-map-regions.js's `isGeneratorOnlyRegion`). It rides AFTER the subject so
 * the subject stays `$1` for a stub standing in for the arbiter.
 *
 * `claimed` says the arbiter exited 0, which a contended claim does too, though
 * it took nothing: a caller releases only on `claimed`, and the arbiter refuses
 * to release a subject a neighbour holds (mantahostels#2422).
 *
 * @param {string} dataFile
 * @param {{claimCmd?: string | null, generator?: boolean}} [opts]
 * @returns {{claimed: boolean}}
 */
function claimDataFile(dataFile, { claimCmd, generator = false } = {}) {
	const claim = claimByArbiter(dataFile, { claimCmd, generator });
	if (claim.claimed) {
		if (claim.warning) writeFd(2, `${claim.warning}\n`);
		return { claimed: true };
	}
	writeFd(
		2,
		`could not claim ${dataFile} — ${claim.why}. Writing anyway; the overwritten bytes were not recorded.\n`,
	);
	return { claimed: false };
}

/**
 * Releases a claim `claimDataFile` took, so a run that ends does not strand one
 * on a file it is no longer writing (mantahostels#1848 review S3, mantahostels#2422).
 *
 * BEST-EFFORT, and silent: a release that fails costs a claim outliving its run,
 * never the run's own exit code.
 *
 * `generator: true` passes `--generator`, which waives the dirty refusal a §A
 * subject would otherwise earn from its own generator's write (mantahostels#2428). It rides
 * AFTER the subject, for claimDataFile's reason.
 *
 * @param {string} subject
 * @param {string | null} [releaseCmd] a stand-in for the arbiter, for tests
 * @param {{generator?: boolean}} [opts]
 */
function releaseClaim(subject, releaseCmd, { generator = false } = {}) {
	const extra = generator ? ["--generator"] : [];
	const [cmd, cmdArgs] = releaseCmd
		? [releaseCmd, [subject, ...extra]]
		: [
				process.execPath,
				[
					path.join(__dirname, "..", "session-arbiter.js"),
					"release",
					subject,
					...extra,
				],
			];
	spawnSync(cmd, cmdArgs, { encoding: "utf8" });
}

module.exports = { parseCliArgs, claimDataFile, releaseClaim };
