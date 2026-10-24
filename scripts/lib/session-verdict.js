/*
 * session-verdict.js — whether a session's own work is attested, and what it
 * owes where it is not (workflow-core#1502): the question the `result:` gate asks
 * (guard-priced-options.js's eighth refusal, mantahostels#1253), answered beside
 * the suite certificate.
 *
 * THE SESSION'S COMMIT is the newest its commit ledger names that HEAD
 * contains (workflow-core#766), so one left in a throwaway worktree or on a `spike/*`
 * branch is passed over. THE WORK JUDGED is its own: the range narrows to
 * `ownPaths` (workflow-core#1156), or stays whole where that will not answer, which
 * over-selects (workflow-core#1154). The push gate judges every commit pushed and never
 * reads this (workflow-core#789 Q1 (C), ADR-0009).
 */

const path = require("node:path");
const arbiterLedger = require("./arbiter-ledger.js");
const { gitRead } = require("./dirty-tree.js");
const { ownPaths } = require("./own-work.js");
const markerLib = require("./test-pass-marker.js");
const { commandOrDefault } = require("./workflow-core-config.js");
const { pushedRef } = require("./landing-refs.js");

const { shortSha } = markerLib;

/** @typedef {import("./own-work.js").CommitLedger} CommitLedger */
/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/**
 * The owed refusal's parts, in the order they print. The `result:` gate puts
 * its own policy between `reap` and `run` — the two "not yours to fix"
 * exemptions (mantahostels#1842) — and `run` and `red` refer back to them.
 * @typedef {{unattested: string, reap: string, run: string, red: string}} OwedText
 * @typedef {{state: "attested", at: string|null}
 *   | {state: "owed", own: string, at: string, text: OwedText}
 *   | {state: "unjudged", why: string}} SessionVerdict
 */

/**
 * Whether green runs cover the session's own last commit, or a later one up to
 * HEAD that contains it (`sessionAttestation`). `attested` with `at: null` is a
 * session that committed nothing here, which owes nothing.
 *
 * @param {string} sessionId
 * @param {{root?: string|null, ledger?: CommitLedger, execFn?: ExecFn,
 *   log?: (what: string) => void}} [options] `log` hears what the red note
 *   could not read, which leaves the verdict standing
 * @returns {SessionVerdict}
 */
function sessionVerdict(
	sessionId,
	{
		root = markerLib.repoRoot(),
		ledger = arbiterLedger,
		execFn,
		log = () => {
			/* a caller with no log hears nothing */
		},
	} = {},
) {
	if (!root) return { state: "unjudged", why: "no git repository to read" };
	const ledgerRoot = ledger.ledgerRoot();
	/* null is "unavailable", never "committed nothing" (mantahostels#135). */
	const commits = ledgerRoot ? ledger.commitsBy(sessionId, ledgerRoot) : null;
	if (!commits) return { state: "unjudged", why: "commit ledger unreadable" };
	const own = newestContained(commits, root, execFn);
	if (!own) return { state: "attested", at: null };

	/* readMarkers() returns [] for an absent store, an unreadable one and one
	 * whose every line is torn alike, and none of those is evidence that the
	 * suite did not run. */
	const markers = markerLib.readMarkers({ root });
	if (markers.length === 0)
		return {
			state: "unjudged",
			why: "marker store missing, unreadable or holding no parseable marker",
		};
	const attestation = markerLib.sessionAttestation(own, markers, {
		root,
		within: ownWork(sessionId, root, ledger, execFn),
	});
	if (!attestation.judged)
		return {
			state: "unjudged",
			why: `could not judge the cover: ${attestation.why}`,
		};
	if (attestation.attested) return { state: "attested", at: attestation.at };
	return {
		state: "owed",
		own,
		at: attestation.at,
		text: owedText(root, attestation, log),
	};
}

/**
 * The newest of `commits` HEAD contains, or null. A commit git cannot name —
 * its worktree pruned and the object collected — is passed over with the rest.
 * @param {string[]} commits oldest first
 * @param {string} root
 * @param {ExecFn} [execFn]
 */
function newestContained(commits, root, execFn) {
	for (const sha of [...commits].reverse())
		if (
			gitRead(["merge-base", "--is-ancestor", sha, "HEAD"], root, execFn) !==
			null
		)
			return sha;
	return null;
}

/**
 * The paths the session's own commits carry from the pushed ref to HEAD, or
 * null — the whole range — where git or the ledger will not answer. `tip`
 * keeps the shared tree's uncommitted files out: a commit is what is judged.
 * @param {string} sessionId
 * @param {string} root
 * @param {CommitLedger} ledger
 * @param {ExecFn} [execFn]
 */
function ownWork(sessionId, root, ledger, execFn) {
	const head = gitRead(["rev-parse", "HEAD"], root, execFn)?.trim();
	const base = gitRead(
		["merge-base", "HEAD", pushedRef({ root })],
		root,
		execFn,
	)?.trim();
	if (!head || !base) return null;
	return (
		ownPaths(root, base, { sessionId, execFn, ledger, tip: head })?.paths ??
		null
	);
}

/**
 * ORDER IS LOAD-BEARING (mantahostels#2194, mantahostels#1843, mantahostels#2206),
 * so a reflow of these strings is a behaviour change, and the tests pin it. The
 * reap clause sits immediately above the machine-limits exemption it
 * qualifies, so it names both commands in full rather than referring forward
 * to them. The first prescription is the bare `npm run test`
 * (mantahostels#3210), which is the narrowed run (mantahostels#3208) and
 * escalates by itself.
 *
 * @param {string} root
 * @param {{at: string, verdict: ReturnType<typeof markerLib.attestationOf>}} attestation
 * @param {(what: string) => void} log
 * @returns {OwedText}
 */
function owedText(root, { at, verdict }, log) {
	const own = verdict.judged && verdict.within;
	const pushed = pushedRef({ root });
	return {
		unattested:
			"no set of green runs in `" +
			markerLib.STORE +
			"` covers it, or any later commit up to HEAD that contains it. A commit " +
			"counts as tested when whole-suite or ADMISSIBLE `npm run test` greens, " +
			"from any sessions, cover between them every file " +
			(own
				? `this session's own commits change in its range from \`${pushed}\``
				: `its range from \`${pushed}\` changes`) +
			", each still holding at the commit (ADR-0009). At " +
			shortSha(at) +
			":\n" +
			unattestedLines(at, verdict) +
			`\n\`${commandOrDefault("push_check")}\`` +
			(own
				? " judges every commit the next push sends, so it may also name a " +
					"neighbour's, which is not this session's to cover."
				: " prints the same."),
		reap:
			"A PRE-RUN `free -m` READ IS NOT THE TEST (mantahostels#1843): when it is short, " +
			"the run reaps finished-but-resident sessions on its way in " +
			"(scripts/pretest-reap.js, mantahostels#1840) and prints the headroom left afterwards, " +
			"so memory that read counts as gone may " +
			"be about to come back. THAT REAP IS npm's `pretest` AND `pretest:changed` " +
			"HOOKS, SO `npm run test` AND `npm run test:changed` BOTH PAY IT, each " +
			"against the rung the run needs, and its line names that rung (workflow-core#633). ",
		run:
			retestRun(verdict) ??
			"npm run test\n\n`npm run test` is the run that covers a " +
				"commit already made, and a green run now counts for your commit " +
				"because HEAD contains it. `npm run test:changed` is not its equal: it " +
				"selects only your uncommitted files, so after a commit it selects " +
				"nothing from it (workflow-core#1217). `scripts/run-vitest.js` SELECTS FROM YOUR DIFF " +
				`AGAINST \`merge-base(HEAD, ${pushed})\` AND ESCALATES TO THE WHOLE SUITE ` +
				"ITSELF where `docs/test-read-edges.json` is stale or unreadable, the diff " +
				"touches a dependency-graph root, or the expansion failed — so whichever " +
				"certificate it records clears this, and the run says which you got " +
				"(mantahostels#2146). ",
		red: lastRedNote(root, log),
	};
}

/**
 * The re-run of only the tests no green holds at the commit (workflow-core#1860), where
 * that is all the commit owes — every owed suite vitest and every uncovered
 * file naming its tests — else null.
 *
 * @param {ReturnType<typeof markerLib.attestationOf>} verdict
 */
function retestRun(verdict) {
	if (!verdict.judged) return null;
	const owed = verdict.suites.flatMap((s) =>
		s.attested ? [] : [{ suite: s.suite, unattested: s.unattested }],
	);
	const named = owed.every(
		(s) =>
			s.suite === markerLib.DEFAULT_SUITE &&
			s.unattested.length > 0 &&
			s.unattested.every(markerLib.namesTests),
	);
	const command = named
		? markerLib.retestCommand(
				owed.flatMap((s) => s.unattested),
				markerLib.suiteMeta(markerLib.DEFAULT_SUITE).gate,
			)
		: null;
	return command
		? `${command}\n\n\`--retest\` re-runs only the test(s) whose own reads changed since their green, which is all this commit owes (workflow-core#1860). `
		: null;
}

/**
 * The owed suites as the push gate renders them, less its advice: the refusal
 * prescribes its own commands.
 *
 * @param {string} at
 * @param {ReturnType<typeof markerLib.attestationOf>} verdict
 */
function unattestedLines(at, verdict) {
	if (!verdict.judged) return "";
	const owed = {
		...verdict,
		suites: verdict.suites.filter((s) => !s.attested),
	};
	return markerLib.attestationReading(at, owed, { advise: () => [] }).text;
}

/**
 * How old a red is, in the coarsest unit that still reads as a duration. The
 * session is deciding whether a red predates it, so minutes matter under an
 * hour and nothing finer ever does.
 *
 * @param {string|null|undefined} at an ISO timestamp off the marker
 */
function redAge(at) {
	const ms = Date.now() - Date.parse(String(at));
	if (!Number.isFinite(ms) || ms < 0) return "of unknown age";
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return `${mins} min old`;
	const hours = ms / 3_600_000;
	/* A guess: under two days a session still counts in hours. */
	if (hours < 48) return `${hours.toFixed(1)} h old`;
	return `${Math.round(hours / 24)} days old`;
}

/**
 * The last wide red already on record, so a session can check the second "not
 * yours to fix" exemption against its own diff instead of running a suite to
 * discover the same list (mantahostels#2205).
 *
 * EVIDENCE, NEVER A LICENCE — the constraint on anything added here.
 * mantahostels#2195 refuted every route from this record to whose work the
 * failures are, and a red's failing set only half repeats between runs, so a
 * file absent from the list can still be red now. The cause claim stays with
 * the session, which knows its diff; mantahostels#1842 declined to automate it.
 *
 * FAILS OPEN TO "": an absent, unreadable or all-torn red store leaves the
 * refusal reading as it would with no red note at all. All three go through
 * `readFailures`, which answers [] for each, and each is LOGGED, because a
 * red store nobody can read is the same class of silent unprotection as an
 * unreadable green store.
 *
 * @param {string} root
 * @param {(what: string) => void} log
 */
function lastRedNote(root, log) {
	const markers = markerLib.readFailures({ root });
	/* Logged where the STORE could not be read, never where it simply holds no
	 * wide red. */
	if (markers.length === 0) {
		log(
			"red store missing, unreadable or holding no parseable marker — " +
				"the result: refusal names no red to check a diff against",
		);
		return "";
	}
	const red = markerLib.lastFullRed(markers);
	if (!red) return "";
	/* Repo-relative, because that is the shape the session's own diff is in. A
	 * path outside the root, or already relative, is printed as it stands. */
	const files = red.files.map((f) => {
		if (!path.isAbsolute(f)) return f;
		const rel = path.relative(root, f);
		return rel && !rel.startsWith("..") ? rel : f;
	});
	const shown = files.slice(0, markerLib.MAX_LISTED_FILES);
	const more = files.length - shown.length;
	return (
		"\n\nBEFORE YOU RUN ANYTHING, THE SECOND EXEMPTION IS ALREADY CHECKABLE " +
		"(mantahostels#2205). `" +
		markerLib.FAIL_STORE +
		"` records the last red that collected at least " +
		Math.round(markerLib.FULL_RED_RATIO * 100) +
		"% of the suite's modules, " +
		"on commit " +
		shortSha(red.sha) +
		", " +
		redAge(red.at) +
		", failing in:\n\n" +
		shown.map((f) => `  ${f}`).join("\n") +
		(more ? `\n  ...and ${more} more` : "") +
		"\n\nCheck that against your own diff. Where the two do not intersect, " +
		"the red predates you: take the exemption, say which one and name these " +
		"files, write `result:` and stop again — no suite. Where they do " +
		"intersect, run it. THIS IS EVIDENCE, NOT A LICENCE: it says what was " +
		"red, never whose work it is, and a red's failing set repeats only about " +
		"half the time between runs (mantahostels#2195), so a file absent here can be red now."
	);
}

module.exports = { sessionVerdict };
