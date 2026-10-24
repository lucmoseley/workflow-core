/*
 * unasked-rerun.js — whether a bare `npm run test` or `npm run test:changed`
 * is an unasked re-run, the judgement `scripts/guard-unasked-rerun.sh` refuses
 * on once a session (#815, ruled at #790 Q3 and Q7, spec #810).
 *
 * A RE-RUN IS UNASKED where both hold: green vitest runs from any sessions
 * already cover what the run would test (`attestationOf`, ADR-0009) — vitest alone,
 * the one suite either script runs, so an uncovered pytest range refuses
 * nothing; and this session has not been refused here before.
 *
 * WHAT THE RUN WOULD TEST IS READ WITH THE RUN'S OWN CODE, so the two cannot
 * disagree (#1218). Either run, given a session id, reads HEAD plus the
 * session's own uncommitted files in an overlay (#812, #1217); own-selection.js's
 * `ownSelection` writes that tree as an unreferenced commit, and cover is
 * judged there. A bare run tests the range's paths less those only a
 * neighbour's commit touched (#1154's rule) — the whole range where none is
 * left out, as `ownWorkAt` rules, or where the commits cannot be told apart,
 * which `unread` says. `test:changed` tests the session's uncommitted files
 * alone. A run that would test nothing is allowed: there is no repeat to save.
 *
 * WHERE IT CANNOT JUDGE IT ALLOWS, AND SAYS WHY (mantahostels#103 §6): an
 * unreadable write ledger, marker store or git answers `{why}`, which the
 * guard logs through lib/guard-log.sh — as is an uncovered selection over a
 * store holding malformed lines, which may be the cover lost. An ABSENT store
 * is no fault: nothing covers the selection, so nothing is refused.
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
 * CLI, for the guard: `node unasked-rerun.js <session-id> <cwd> <command>`.
 * Prints one JSON line — `{"deny": text, "note"?: loss}`, `{"why": reason}` or
 * `{}`, any of them with `unread` where its own work could not be read — and
 * exits 0.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ownSelection } = require("./own-selection.js");
const store = require("./arbiter-store");
const { hostRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const {
	DEFAULT_SUITE,
	countMalformed,
	attestationOf,
	attestationReading,
	isFullRun,
	readMarkers,
	shortSha,
	storePath,
} = require("./test-pass-marker.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const LATCH_PREFIX = ".unasked-rerun-refused-";
const REFUSAL_LOG = ".unasked-rerun-refusals.jsonl";

/** @param {string} sid */
const slug = (sid) => sid.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function git(args, cwd) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * @param {{sessionId: string, cwd?: string, command?: string, root?: string}} input
 * @returns {({deny: string, note?: string} | {why: string} | {}) & {unread?: string}}
 */
function judge({ sessionId, cwd, command = "", root = hostRoot() }) {
	if (!sessionId) return {};
	const markers = markersDir(root);
	const latch = path.join(markers, LATCH_PREFIX + slug(sessionId));
	if (fs.existsSync(latch)) return {};

	/* A run in another checkout — a throwaway worktree — reads that tree's HEAD,
	 * which this store's cover says nothing about. */
	if (cwd) {
		const gitDir = git(["rev-parse", "--absolute-git-dir"], cwd);
		if (gitDir === null)
			return { why: "git could not resolve the run's working directory" };
		const rootGitDir = git(["rev-parse", "--absolute-git-dir"], root);
		if (rootGitDir === null)
			return { why: "git could not resolve the repository root" };
		if (gitDir !== rootGitDir) return {};
	}

	/* attributeDirty reads an unreadable ledger as "wrote nothing", so the
	 * fault is told apart here. */
	if (store.writesBy(sessionId) === null)
		return { why: "this session's write ledger could not be read" };
	const selection = ownSelection(root, sessionId);
	if (selection === null)
		return {
			why: "git could not say which files are uncommitted, or write the overlay's tree",
		};
	const out = judgeAttestation({
		root,
		latch,
		sessionId,
		command,
		selection,
	});
	return selection.unread ? { ...out, unread: selection.unread } : out;
}

/**
 * The paths the run would test, or null for the whole range.
 *
 * @param {string} command
 * @param {NonNullable<ReturnType<typeof ownSelection>>} selection
 * @returns {string[]|null}
 */
function testedPaths(command, { uncommitted, scoped }) {
	return /\btest:changed\b/.test(command)
		? uncommitted
		: (scoped?.paths ?? null);
}

/**
 * Refuse where green runs cover what the run would test at the overlay's
 * commit, latching and logging the refusal.
 *
 * @param {{ root: string, latch: string, sessionId: string, command: string,
 *   selection: NonNullable<ReturnType<typeof ownSelection>> }} input
 * @returns {{deny: string, note?: string} | {why: string} | {}}
 */
function judgeAttestation({ root, latch, sessionId, command, selection }) {
	const early = earlyStoreVerdict(root);
	if (early) return early;

	const { tip, mine, scoped } = selection;
	const within = testedPaths(command, selection);
	if (within && within.length === 0) return {};
	const verdict = attestationOf(tip, readMarkers({ root }), {
		root,
		...(within ? { within } : {}),
	});
	if (!verdict.judged) return { why: verdict.why };
	const vitest = verdict.suites.find((s) => s.suite === DEFAULT_SUITE);
	if (!vitest?.attested) {
		const { malformed } = countMalformed({ root });
		return malformed
			? {
					why: `the run's selection is uncovered and the pass-marker store holds ${malformed} malformed line(s)`,
				}
			: {};
	}

	try {
		fs.writeFileSync(latch, `${new Date().toISOString()}\n`);
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
	const head = git(["rev-parse", "HEAD"], root) ?? tip;
	const deny = buildRefusalText(
		head,
		selection,
		within,
		attestationReading(tip, { ...verdict, suites: [vitest] }).text.trimEnd(),
	);
	try {
		fs.appendFileSync(
			path.join(markersDir(root), REFUSAL_LOG),
			`${JSON.stringify({
				at: new Date().toISOString(),
				session: sessionId,
				command,
				head,
				members,
				own: {
					uncommitted: mine,
					paths: within,
					dropped: scoped?.dropped ?? [],
				},
			})}\n`,
		);
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
 * @param {string} root
 * @returns {{why: string} | {} | null} null where the store is readable
 */
function earlyStoreVerdict(root) {
	try {
		if (!fs.statSync(storePath(root)).isFile())
			return { why: "the pass-marker store could not be read (EISDIR)" };
		fs.accessSync(storePath(root), fs.constants.R_OK);
	} catch (e) {
		const { code } = caught(e);
		if (code === "ENOENT") return {};
		return {
			why: `the pass-marker store could not be read (${code ?? e})`,
		};
	}
	return null;
}

/**
 * @param {string} head
 * @param {NonNullable<ReturnType<typeof ownSelection>>} selection
 * @param {string[]|null} within the paths the run would test
 * @param {string} reading the covering runs, as attestationReading prints them
 * @returns {string} the refusal the guard prints
 */
function buildRefusalText(head, { mine, scoped }, within, reading) {
	const tree =
		mine.length > 0
			? `HEAD ${shortSha(head)} plus this session's ${mine.length} uncommitted file(s)`
			: `HEAD ${shortSha(head)}`;
	return [
		`Not run: what this run would test at ${tree} is already covered by green runs, so it can only repeat their verdict.`,
		...(scoped && within === scoped.paths
			? [
					`The ${scoped.dropped.length} neighbour commit(s) in the range, ${scoped.dropped.map(shortSha).join(", ")}, are left to their own sessions' greens and this run would not test them (#1216).`,
				]
			: []),
		reading,
		"Type the same command again and it runs — this refuses once a session.",
	].join("\n");
}

if (require.main === module) {
	const [sessionId = "", cwd = "", command = ""] = process.argv.slice(2);
	let out;
	try {
		out = judge({ sessionId, ...(cwd ? { cwd } : {}), command });
	} catch (e) {
		out = { why: `the judge threw: ${caught(e).message}` };
	}
	writeFd(1, `${JSON.stringify(out)}\n`);
}

/* guard-unasked-rerun.test.ts reads the log by it. */
module.exports = { REFUSAL_LOG };
