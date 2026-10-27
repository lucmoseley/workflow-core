/*
 * unasked-rerun.js — whether a bare `npm run test` or `npm run test:changed`
 * is an unasked re-run, the judgement `scripts/guard-unasked-rerun.js` refuses
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
 * lost certificate. An ABSENT store is no fault: nothing attests the
 * selection, so nothing is refused.
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

/**
 * @typedef {NonNullable<ReturnType<typeof import("./own-selection.js").ownSelection>>} Selection
 * @typedef {ReturnType<typeof import("./test-pass-marker.js").attestationOf>} Attestation
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
 * @property {(tip: string, within: string[]|null) => { verdict: Attestation, timedOut: boolean }} attestation
 *   `attestationOf` at `tip` over the store, narrowed to `within`
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
	const { verdict, timedOut } = io.attestation(tip, within);
	if (timedOut) return { why: "a git read timed out judging the certificates" };
	if (!verdict.judged) return { why: verdict.why };
	const vitest = verdict.suites.find((s) => s.suite === DEFAULT_SUITE);
	if (!vitest?.attested) {
		const malformed = io.malformed();
		return malformed
			? {
					why: `no certificate attests the run's selection and the pass-marker store holds ${malformed} malformed line(s)`,
				}
			: {};
	}

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
	}));
	const deny = buildRefusalText(
		head,
		selection,
		within,
		attestationReading(tip, { ...verdict, suites: [vitest] }).text.trimEnd(),
	);
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
 * Where the pass-marker store cannot be judged: `{}` where it is absent, which
 * allows, and `{why}` where it is unreadable. readMarkers reads an unreadable
 * store as empty, so a fault is told apart here, before it is read.
 *
 * @param {JudgeIO} io
 * @returns {{why: string} | {} | null} null where the store is readable
 */
function storeVerdict(io) {
	const fault = io.storeFault();
	if (fault === "ENOENT") return {};
	return fault
		? { why: `the pass-marker store could not be read (${fault})` }
		: null;
}

/**
 * @param {string} head
 * @param {Selection} selection
 * @param {string[]|null} within the paths the run would test
 * @param {string} reading the attesting certificates, as attestationReading prints them
 * @returns {string} the refusal the guard prints
 */
function buildRefusalText(head, { mine, scoped }, within, reading) {
	const tree =
		mine.length > 0
			? `HEAD ${shortSha(head)} plus this session's ${mine.length} uncommitted file(s)`
			: `HEAD ${shortSha(head)}`;
	return [
		`Not run: certificates already attest what this run would test at ${tree}, so it can only repeat their verdict.`,
		...(scoped && within === scoped.paths
			? [
					`The ${scoped.dropped.length} neighbour commit(s) in the range, ${scoped.dropped.map(shortSha).join(", ")}, are left to their own sessions' certificates and this run would not test them (#1216).`,
				]
			: []),
		reading,
		"Type the same command again and it runs — this refuses once a session.",
	].join("\n");
}

module.exports = { judge };
