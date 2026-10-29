#!/usr/bin/env node
/*
 * push-check.js — `npm run push:check` (#814, #790 Q2): whether certificates
 * from any sessions attest, between them, every commit the next push of `main`
 * would send (ADR-0009), each suite answering for itself (mantahostels#1256).
 * It never pushes and never runs tests.
 *
 * THE RANGE is merge-base(main, <pushed ref>)..main, `attestationOf`'s default
 * and the base the narrowed default resolves, the pushed ref being
 * lib/landing-refs.js's `pushedRef`; nothing is fetched, so a stale ref only
 * widens it.
 *
 * Exits 0 where every commit is attested, naming the certificates; 1 where a
 * run is owed, naming each unattested file, its commit and the command to run;
 * 2 where it could not judge, with the reason. Where lib/test-gate.js's
 * `pushGateState` skips — `suites` off, `landing` on, or the tests gated at
 * commit — it prints the pre-push check's skip line and exits 0.
 *
 * WHO ANSWERS FOR AN UNATTESTED COMMIT (#1213). A narrowed run selects only its
 * own session's commits (#1156), so `npm run test` is advised only for the
 * pusher's own commits and those no ledger names. A commit another session's
 * ledger names (#1154) is that session's to attest while the arbiter calls it
 * live; once it has ended, one `--adopt` run over its unattested paths attests
 * it.
 *
 * IN NO SCRIPT FAMILY (§N3): it gates nothing, so it takes neither `runCheck`
 * nor a `check-*` name.
 */

const core = require("./lib/arbiter-core.js");
const { readNeighbourCommits } = require("./lib/own-work.js");
const idSeam = require("./lib/session-id.js");
const {
	attestationOf,
	attestationReading,
	readMarkers,
	repoRoot,
	buildRerunLines,
	namesTests,
	shortSha,
	suiteMeta,
} = require("./lib/test-pass-marker.js");
/** @typedef {import("./lib/test-pass-marker.js").Unattested} Unattested */
const { pushGateState } = require("./lib/test-gate.js");
const { caught } = require("./lib/caught.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { pushedRef } = require("./lib/landing-refs.js");
const { execGit } = require("./lib/git.js");

/** @param {string} line */
const say = (line) => process.stdout.write(`${line}\n`);

/**
 * An owed vitest suite's advice by who made each unattested commit (#1213), or
 * null where `attestationReading`'s own advice stands: no session id, no main worktree git will
 * name, a ledger that will not read, or every unattested commit the pusher's
 * own or unledgered — each a case where the bare run does not narrow, or
 * selects every unattested commit anyway.
 *
 * A registry that will not read cannot call a session live, so its commits
 * are adopted: a needless run, where waiting on an ended owner waits forever.
 *
 * @param {import("./lib/test-pass-marker.js").SuiteAttestation & {attested: false}} s
 * @param {string} gate
 * @returns {string[]|null}
 */
function buildOwnerAdvice(s, gate) {
	const owners = readNeighbourCommits(
		s.unattested.flatMap((g) => (g.commit ? g.commit : [])),
		idSeam.fromEnv(),
	);
	if (!owners) return null;
	const live = core.readLiveSessionIds();
	const buckets = sortByOwner(s.unattested, owners, live);
	if (buckets.waiting.size === 0 && buckets.adopt.length === 0) return null;
	return buildOwnerAdviceLines(buckets, gate, live, core.registryNames());
}

/**
 * Each unattested file sorted by who answers for it: the pusher, a live
 * session, or an ended one whose commits are adopted.
 *
 * @param {Unattested[]} unattested
 * @param {Map<string, string>} owners
 * @param {Set<string>|null|undefined} live
 */
function sortByOwner(unattested, owners, live) {
	/** @type {Unattested[]} */
	const yours = [];
	/** @type {Map<string, Set<string>>} */
	const waiting = new Map();
	/** @type {Set<string>} */
	const orphans = new Set();
	/** @type {Unattested[]} */
	const adopt = [];
	for (const entry of unattested) {
		const { commit } = entry;
		const owner = commit ? owners.get(commit) : undefined;
		if (!commit || !owner) yours.push(entry);
		else if (live?.has(owner))
			waiting.set(owner, (waiting.get(owner) ?? new Set()).add(commit));
		else {
			orphans.add(commit);
			adopt.push(entry);
		}
	}
	return { yours, waiting, orphans, adopt };
}

/**
 * A file read by a test no run holds is answered by re-running that test
 * (#1860), whoever made its commit, unless a live session still owns it.
 *
 * @param {ReturnType<typeof sortByOwner>} buckets
 * @param {string} gate
 * @param {Set<string>|null|undefined} live
 * @param {(id: string) => string} nameOf
 * @returns {string[]}
 */
function buildOwnerAdviceLines(
	{ yours, waiting, orphans, adopt },
	gate,
	live,
	nameOf,
) {
	/** @param {Iterable<string>} shas */
	const list = (shas) => [...shas].map(shortSha).join(", ");
	const adopted = adopt.filter((u) => !namesTests(u));
	const rerun = [...yours, ...adopt.filter(namesTests)];
	return [
		...(rerun.length > 0
			? buildRerunLines(rerun, gate, ", from your own commits or no session's")
			: []),
		...[...waiting].map(
			([owner, shas]) =>
				`   ${list(shas)}: made by ${nameOf(owner)}, still live — its own certificate will attest them, so run nothing for them (#1213).`,
		),
		...(adopted.length > 0
			? [
					`   ${list(orphans)}: made by session(s) that have ended${live ? "" : ", or that an unreadable sessions registry cannot call live"} — adopt them with one run, then push (#1213):`,
					`     ${gate} -- --adopt ${adopted.map((u) => shellQuote(u.path)).join(" ")}`,
				]
			: []),
	];
}

/** @returns {number} the exit code */
function main() {
	const gate = pushGateState();
	if (gate.state === "broken") {
		say(`could not judge: ${gate.line}`);
		return 2;
	}
	if (gate.state === "skip") {
		say(`SKIP: ${gate.line}`);
		return 0;
	}
	const root = repoRoot();
	if (!root) {
		say("could not judge: no git repository to read");
		return 2;
	}
	let sha;
	try {
		sha = execGit(["rev-parse", "--verify", "-q", "main"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		say("could not judge: this checkout has no `main` branch to push");
		return 2;
	}
	const verdict = attestationOf(sha, readMarkers({ root }));
	/* attestationOf calls an empty range unattested, which is right for a gate and
	 * wrong for a push that sends nothing. */
	if (verdict.judged && verdict.base === sha) {
		say(
			`✓  nothing to push: main is at ${shortSha(sha)}, its merge-base with ${pushedRef({ root })}.`,
		);
		return 0;
	}
	const { state, text } = attestationReading(sha, verdict, {
		advise: (s) => {
			const suite = suiteMeta(s.suite);
			return suite.attestsFiltered ? buildOwnerAdvice(s, suite.gate) : null;
		},
	});
	if (state === "attested" && verdict.judged)
		say(
			`✓  every commit in ${shortSha(verdict.base)}..${shortSha(sha)} is attested — push.`,
		);
	process.stdout.write(text);
	return { attested: 0, owed: 1, unjudged: 2 }[state];
}

try {
	process.exitCode = main();
} catch (e) {
	say(`could not judge: ${caught(e).message}`);
	process.exitCode = 2;
}
