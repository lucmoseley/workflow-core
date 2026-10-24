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
 * Fails open by default (mantahostels#1194): a claim the arbiter refuses costs the
 * content record and nothing else, and is never grounds to stop the write.
 * `failClosed: true` is register-doc.js's case — the row it writes is
 * authored, not a derived count, so a held file is refused rather than
 * overwritten.
 *
 * `generator: true` marks the caller as the §A generator, which is what lets a
 * claim on docs/doc-map.md's derived §A through (mantahostels#2422, and
 * doc-map-regions.js's `isGeneratorOnlyRegion`). It rides AFTER the subject so
 * the subject stays `$1` for a stub standing in for the arbiter.
 *
 * `claimed` says whether the arbiter actually took it, which `ok` cannot: a
 * fail-open refusal is `ok: true` by design, and a caller that released on that
 * would ask the arbiter to drop a claim it never granted (mantahostels#2422).
 *
 * @param {string} dataFile
 * @param {{claimCmd?: string | null, failClosed?: boolean, generator?: boolean}} [opts]
 * @returns {{ok: boolean, claimed: boolean}}
 */
function claimDataFile(
	dataFile,
	{ claimCmd, failClosed = false, generator = false } = {},
) {
	const extra = generator ? ["--generator"] : [];
	const [cmd, cmdArgs] = claimCmd
		? [claimCmd, [dataFile, ...extra]]
		: [
				process.execPath,
				[
					path.join(__dirname, "..", "session-arbiter.js"),
					"claim",
					dataFile,
					...extra,
				],
			];
	const r = spawnSync(cmd, cmdArgs, { encoding: "utf8" });
	if (r.status === 0) return { ok: true, claimed: true };

	const reason = (r.stderr || r.stdout || "").trim();
	if (failClosed) {
		console.error(
			`cannot claim ${dataFile} — ${reason || "held by another session"}`,
		);
		return { ok: false, claimed: false };
	}
	console.error(
		`could not claim ${dataFile} — ${reason || "no reason given"}. Writing anyway; the overwritten bytes were not recorded.`,
	);
	return { ok: true, claimed: false };
}

/**
 * Releases a claim `claimDataFile` took, so a run that ends does not strand one
 * on a file it is no longer writing (mantahostels#1848 review S3, widened to every generator
 * at mantahostels#2422).
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
