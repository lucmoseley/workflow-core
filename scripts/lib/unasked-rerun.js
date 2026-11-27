const {
	DEFAULT_SUITE,
	EVIDENCE_NOT_LICENCE,
	FLAKE_NOTE,
	attestedReading,
	isFullRun,
	shortSha,
} = require("./test-pass-marker.js");
const { caught } = require("./caught.js");
const {
	ALL_ALREADY_RED,
	buildAlreadyRedFileLines,
} = require("./already-red.js");

/**
 * @typedef {NonNullable<ReturnType<typeof import("./own-selection.js").ownSelection>>} Selection
 * @typedef {ReturnType<typeof import("./test-pass-marker.js").attestationOf>} Attestation
 * @typedef {import("./test-pass-marker.js").Marker
 *   & {alreadyRed: import("./already-red.js").Classing}} ClassedRed
 * @typedef {object} JudgeIO
 * @property {(sessionId: string) => boolean} latched
 * @property {(sessionId: string, at: string) => void} latch
 * @property {(record: object) => void} logRefusal
 * @property {(cwd: string) => { dir: string|null, timedOut: boolean }} gitDir
 * @property {() => { dir: string|null, timedOut: boolean }} treeGitDir
 * @property {() => { sha: string|null, timedOut: boolean }} head
 * @property {(sessionId: string) => { readable: boolean, timedOut: boolean }} ledger
 * @property {(sessionId: string) => { selection: Selection|null, timedOut: boolean }} selection
 * @property {() => string|null} storeFault
 * @property {(tip: string, within: string[]|null) => { verdict: Attestation, timedOut: boolean, redFault: string|null }} attestation
 * @property {() => number} malformed
 * @property {() => string} now
 */

/**
 * @param {{sessionId: string, cwd?: string, command?: string}} input
 * @param {JudgeIO} io
 * @returns {({deny: string, note?: string} | {why: string} | {}) & {unread?: string}}
 */
function judge({ sessionId, cwd, command = "" }, io) {
	if (!sessionId) return {};
	if (io.latched(sessionId)) return {};
	if (cwd) {
		const elsewhere = checkoutVerdict(cwd, io);
		if (elsewhere) return elsewhere;
	}

	const ledger = io.ledger(sessionId);
	if (ledger.timedOut)
		return { why: "a git read timed out finding this session's write ledger" };
	if (!ledger.readable)
		return { why: "this session's write ledger could not be read" };
	const { selection, timedOut } = io.selection(sessionId);
	if (timedOut)
		return { why: "a git read timed out reading this session's own work" };
	if (selection === null)
		return {
			why: "git could not say which files are uncommitted, or write the overlay's tree",
		};
	const out = judgeAttestation(io, sessionId, command, selection);
	return selection.unread ? { ...out, unread: selection.unread } : out;
}

/**
 * @param {string} cwd
 * @param {JudgeIO} io
 * @returns {{why: string} | {} | null}
 */
function checkoutVerdict(cwd, io) {
	const run = io.gitDir(cwd);
	if (run.dir === null)
		return {
			why: run.timedOut
				? "git timed out resolving the run's working directory"
				: "git could not resolve the run's working directory",
		};
	const home = io.treeGitDir();
	if (home.dir === null)
		return {
			why: home.timedOut
				? "git timed out resolving the session's tree"
				: "git could not resolve the session's tree",
		};
	return run.dir === home.dir ? null : {};
}

/**
 * @param {string} command
 * @param {Selection} selection
 * @returns {string[]|null}
 */
function testedPaths(command, { uncommitted, scoped }) {
	return /\btest:changed\b/.test(command)
		? uncommitted
		: (scoped?.paths ?? null);
}

/**
 * @param {JudgeIO} io
 * @param {string} sessionId
 * @param {string} command
 * @param {Selection} selection
 * @returns {{deny: string, note?: string} | {why: string} | {}}
 */
function judgeAttestation(io, sessionId, command, selection) {
	const unreadable = storeVerdict(io);
	if (unreadable) return unreadable;

	const { tip, mine, scoped } = selection;
	const within = testedPaths(command, selection);
	if (within && within.length === 0) return {};
	const { verdict, timedOut, redFault } = io.attestation(tip, within);
	if (timedOut) return { why: "a git read timed out judging the certificates" };
	if (!verdict.judged) return { why: verdict.why };
	const vitest = verdict.suites.find((s) => s.suite === DEFAULT_SUITE);
	if (!vitest?.attested) return unattestedVerdict(io, redFault);

	const named = io.head();
	if (named.timedOut) return { why: "a git read timed out naming HEAD" };
	const head = named.sha ?? tip;
	try {
		io.latch(sessionId, io.now());
	} catch (e) {
		return {
			why: `the refusal latch could not be written (${caught(e).code ?? e})`,
		};
	}
	const members = vitest.members.map(({ marker: m, match }) => ({
		suite: vitest.suite,
		sha: m.sha,
		at: m.at ?? null,
		full: isFullRun(m),
		by: match.by,
		red: Boolean(classedRed(m)),
	}));
	const reds = vitest.members.flatMap(({ marker }) => {
		const red = classedRed(marker);
		return red ? [red] : [];
	});
	const deny = buildRefusalText(head, selection, within, {
		reading: attestedReading(tip, vitest, {
			narrowed: Boolean(verdict.within),
			redsAmongMembers: reds.length > 0,
		}).trimEnd(),
		reds,
	});
	try {
		io.logRefusal({
			at: io.now(),
			session: sessionId,
			command,
			head,
			members,
			own: {
				uncommitted: mine,
				paths: within,
				dropped: scoped?.dropped ?? [],
			},
		});
	} catch (e) {
		return {
			deny,
			note: `the refusal log could not be written (${caught(e).code ?? e})`,
		};
	}
	return { deny };
}

/**
 * @param {JudgeIO} io
 * @param {string|null} redFault
 * @returns {{why: string} | {}}
 */
function unattestedVerdict(io, redFault) {
	const malformed = io.malformed();
	if (malformed)
		return {
			why: `no certificate attests the run's selection and the pass-marker store holds ${malformed} malformed line(s)`,
		};
	return redFault
		? {
				why: `no certificate attests the run's selection and ${redFault}`,
			}
		: {};
}

/** @param {JudgeIO} io @returns {{why: string} | null} */
function storeVerdict(io) {
	const fault = io.storeFault();
	return fault && fault !== "ENOENT"
		? { why: `the pass-marker store could not be read (${fault})` }
		: null;
}

/**
 * @param {import("./test-pass-marker.js").Marker} m
 * @returns {ClassedRed|null}
 */
const classedRed = (m) =>
	"alreadyRed" in m ? /** @type {ClassedRed} */ (m) : null;

/**
 * @param {string} head
 * @param {Selection} selection
 * @param {string[]|null} within
 * @param {{reading: string, reds: ClassedRed[]}} attesting
 * @returns {string}
 */
function buildRefusalText(head, { mine, scoped }, within, { reading, reds }) {
	const tree =
		mine.length > 0
			? `HEAD ${shortSha(head)} plus this session's ${mine.length} uncommitted file(s)`
			: `HEAD ${shortSha(head)}`;
	return [
		reds.length > 0
			? `Not run: runs on record already give the verdict on what this run would test at ${tree}, so it can only repeat it.`
			: `Not run: certificates already attest what this run would test at ${tree}, so it can only repeat their verdict.`,
		...(scoped && within === scoped.paths
			? [
					`The ${scoped.dropped.length} neighbour commit(s) in the range, ${scoped.dropped.map(shortSha).join(", ")}, are left to their own sessions' certificates and this run would not test them (workflow-core#1216).`,
				]
			: []),
		reading,
		...reds.flatMap((m) => [
			`The verdict on record from the run at ${m.at ?? "unknown time"} on ${shortSha(m.sha)} is a red, not a certificate: it failed only on files already red on its base.`,
			...buildAlreadyRedFileLines(m.alreadyRed),
			`${ALL_ALREADY_RED}.`,
		]),
		...(reds.length > 0
			? [
					`${EVIDENCE_NOT_LICENCE.charAt(0).toUpperCase()}${EVIDENCE_NOT_LICENCE.slice(1)}: ${FLAKE_NOTE}, so a repeat re-rolls those flakes rather than testing this session's work.`,
				]
			: []),
		"Type the same command again and it runs — this refuses once a session.",
	].join("\n");
}

module.exports = { judge };
