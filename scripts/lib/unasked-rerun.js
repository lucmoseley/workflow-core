/*
 * unasked-rerun.js — whether a bare `npm run test` or `npm run test:changed`
 * is an unasked re-run, the judgement the guard-unasked-rerun core refuses
 * on once a session (#815, ruled at #790 Q3 and Q7, spec #810), through its
 * core, lib/unasked-rerun-guard.js, which calls `judge` as a port.
 *
 * It does no I/O (#2913): the latch, the refusal log, git, the write ledger,
 * the own-work selection and the pass-marker store arrive as the `JudgeIO`
 * ports, which lib/unasked-rerun-io.js's `judgeIO` fills in production.
 *
 * A RE-RUN IS UNASKED where both hold: vitest certificates from any sessions
 * already attest what the run would test (`attestationOf`, ADR-0009) — vitest
 * alone, the one suite either script runs, so an unattested pytest range
 * refuses nothing; and this session has not been refused here before.
 *
 * A CLASSED RED STANDS IN FOR A CERTIFICATE HERE, AND ONLY HERE (#3633): a
 * red run whose every failure was already red on its base, which the
 * attestation port serves as a member carrying `alreadyRed`. The refusal
 * names it a red and each already-red file with its evidence. The push gate
 * and the `result:` gate stay certificate-only.
 *
 * WHAT THE RUN WOULD TEST IS READ WITH THE RUN'S OWN CODE, so the two cannot
 * disagree (#1218). Either run, given a session id, reads HEAD plus the
 * session's own uncommitted files in an overlay (#812, #1217); own-selection.js's
 * `ownSelection` writes that tree as an unreferenced commit, and attestation
 * is judged there. A bare run tests the range's paths less those only a
 * neighbour's commit touched (#1154's rule) — the whole range where none is
 * left out, as `readOwnWorkAt` rules, or where the commits cannot be told apart,
 * which `unread` says. `test:changed` tests the session's uncommitted files
 * alone. A run that would test nothing is allowed: there is no repeat to save.
 *
 * WHERE IT CANNOT JUDGE IT ALLOWS, AND SAYS WHY (mantahostels#103 §6): an
 * unreadable write ledger, marker store or git, or a git read that timed out,
 * answers `{why}`, which the guard logs through lib/guard-log.sh — as is an
 * unattested selection over a store holding malformed lines, which may be a
 * lost certificate, or over a red store that would not read, which may be a
 * lost classed red. An ABSENT store is no fault: it holds no certificate, so
 * only a classed red can refuse.
 *
 * EACH REFUSAL APPENDS ONE LINE to `.unasked-rerun-refusals.jsonl` in the
 * markers directory: the record #810's three-day post-change count reads to
 * name the wrong refusals. Never pruned. An unwritable log costs the record and
 * never the refusal, and the loss goes back as `note`, which the guard logs.
 *
 * THE LATCH is `.unasked-rerun-refused-<session>` beside it, written before the
 * refusal goes out: a hook cancelled after writing it refuses nothing. Keyed on
 * the session id alone, so a subagent, whose payload carries its parent's id,
 * shares its parent's one refusal. The marker sweep (arbiter-markers.js)
 * clears it 24 hours after the session stops, so a session resumed after that
 * can be refused once more.
 *
 * `judge` answers `{deny: text, note?: loss}`, `{why: reason}` or `{}`, any of
 * them with `unread` where its own work could not be read.
 */

const {
	DEFAULT_SUITE,
	attestationReading,
	isFullRun,
	shortSha,
} = require("./test-pass-marker.js");
const { caught } = require("./caught.js");
const { buildAlreadyRedLines } = require("./already-red.js");

/**
 * @typedef {NonNullable<ReturnType<typeof import("./own-selection.js").ownSelection>>} Selection
 * @typedef {ReturnType<typeof import("./test-pass-marker.js").attestationOf>} Attestation
 * @typedef {import("./test-pass-marker.js").Marker
 *   & {alreadyRed: import("./already-red.js").Classing}} ClassedRed
 * @typedef {object} JudgeIO
 * @property {(sessionId: string) => boolean} latched
 * @property {(sessionId: string, at: string) => void} latch writes it; throws where it cannot
 * @property {(record: object) => void} logRefusal appends a refusal-log line; throws where it cannot
 * @property {(cwd: string) => { dir: string|null, timedOut: boolean }} gitDir
 *   the absolute git dir of the checkout holding `cwd`
 * @property {() => { dir: string|null, timedOut: boolean }} rootGitDir the repository root's
 * @property {() => { sha: string|null, timedOut: boolean }} head
 * @property {(sessionId: string) => { readable: boolean, timedOut: boolean }} ledger
 *   whether the session's write ledger reads
 * @property {(sessionId: string) => { selection: Selection|null, timedOut: boolean }} selection
 *   what the run would read, as `ownSelection` answers
 * @property {() => string|null} storeFault why the pass-marker store will not
 *   read, as an error code — `ENOENT` where it is absent — or null where it reads
 * @property {(tip: string, within: string[]|null) => { verdict: Attestation, timedOut: boolean, redFault: string|null }} attestation
 *   `attestationOf` at `tip` over the store and the classed reds, narrowed to
 *   `within`; `redFault` why the red store could not be read for them
 * @property {() => number} malformed
 * @property {() => string} now an ISO timestamp
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

	/* attributeDirty reads an unreadable ledger as "wrote nothing", so the
	 * fault is told apart here. */
	const ledger = io.ledger(sessionId);
	if (ledger.timedOut)
		return { why: "a git read timed out finding this session's write ledger" };
	if (!ledger.readable)
		return { why: "this session's write ledger could not be read" };
	/* A timed-out read leaves an answer built on unknowns, so it is not judged
	 * even where one came back. */
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
 * `{}` for a run in another checkout — a throwaway worktree — which reads
 * that tree's HEAD, no certificate in this store attesting it; `{why}` where
 * git cannot say; null for a run in the repository's own checkout.
 *
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
	const home = io.rootGitDir();
	if (home.dir === null)
		return {
			why: home.timedOut
				? "git timed out resolving the repository root"
				: "git could not resolve the repository root",
		};
	return run.dir === home.dir ? null : {};
}

/**
 * The paths the run would test, or null for the whole range.
 *
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
 * Refuse where certificates attest what the run would test at the overlay's
 * commit, latching and logging the refusal.
 *
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
	/* A red-store fault beside attesting certificates is not logged: it could
	 * only have hidden another member, never changed the refusal (#3632). */
	if (!vitest?.attested) return unattestedVerdict(io, redFault);

	/* Read before the latch, so a timed-out read leaves none. */
	const named = io.head();
	if (named.timedOut) return { why: "a git read timed out naming HEAD" };
	const head = named.sha ?? tip;
	try {
		io.latch(sessionId, io.now());
	} catch (e) {
		/* Unlatched, it would refuse every bare run, not one. */
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
		reading: attestationReading(
			tip,
			{ ...verdict, suites: [vitest] },
			{ ofRecord: reds.length > 0 },
		).text.trimEnd(),
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
 * An unattested selection: `{why}` where a malformed certificate line or an
 * unread red store may have hidden what attests it, else `{}`.
 *
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

/**
 * `{why}` where the pass-marker store is unreadable: readMarkers reads it as
 * empty, so the fault is told apart here, before it is read. Null where it
 * reads or is absent.
 *
 * @param {JudgeIO} io
 * @returns {{why: string} | null}
 */
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
 * @param {string[]|null} within the paths the run would test
 * @param {{reading: string, reds: ClassedRed[]}} attesting the attesting
 *   members, as attestationReading prints them, and those that are classed reds
 * @returns {string} the refusal the guard prints
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
					`The ${scoped.dropped.length} neighbour commit(s) in the range, ${scoped.dropped.map(shortSha).join(", ")}, are left to their own sessions' certificates and this run would not test them (#1216).`,
				]
			: []),
		reading,
		...reds.flatMap((m) => [
			`The verdict on record from the run at ${m.at ?? "unknown time"} on ${shortSha(m.sha)} is a red, not a certificate: it failed only on files already red on its base.`,
			...buildAlreadyRedLines(m.alreadyRed),
		]),
		...(reds.length > 0
			? [
					"A repeat re-rolls those flakes rather than testing this session's work.",
				]
			: []),
		"Type the same command again and it runs — this refuses once a session.",
	].join("\n");
}

module.exports = { judge };
