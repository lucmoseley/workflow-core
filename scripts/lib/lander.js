/*
 * lander.js — the landing queue's lander (#2402, spec #2261): tests the tip of
 * the remote `landing` branch and fast-forwards `main` to it on a green
 * verdict at that exact sha. A red tip lands where its failing files pass on
 * one rerun; where they stay red, the lander bisects to the first red commit,
 * lands its parent once the culprit fails twice and the parent passes the
 * whole suite, reverts the culprit on `landing` and files its fix ticket, or
 * holds (#2404). A parent whose whole suite reaches no verdict is confirmed
 * on the culprit's failing files instead and stays off `main` (#2910); a
 * culprit or bisected commit whose whole suite reaches none holds (#3410). Files
 * red at `main` too are a known breakage: the bisect leaves them out, and a
 * culprit whose parent is `main` is confirmed there on its files alone, never
 * reverted where they fail (#3324); a red naming no file reruns nothing there
 * (#3493), but reads its CI jobs' newest state on `main`, holding where one
 * is red there and reverting where none is or it went unread (#3526). Where
 * the tip's red names no file, that read is taken before the bisect too:
 * where every failing job is red on `main` the lander holds with no bisect,
 * and otherwise bisects over the jobs not red there; a failing run there
 * older than the batch's base, or the culprit's parent, reads as unread
 * (#3586). Where `main` takes only a sha a CI run passed, a green read off no
 * run lands nothing: the flake check holds on it, and a confirmed culprit's
 * parent is reverted past (#3329). A push to `main` that is refused holds, so
 * no run retries it (#3329). A run resuming a red batch that `landing` was
 * pushed past tests that tip first, landing it in the batch's place where it
 * is landable (#3410). A run that holds on a batch `landing` has moved past
 * files the hold, then takes up that tip rather than exiting (#3769). A
 * confirmed culprit that is a merge has the side it merged in bisected on the
 * same files, and the first red commit there, failing twice, is reverted in
 * its place; the merge is reverted only where that side holds no such commit
 * (#3631), and a hold on that revert says why it holds none (#3932). Where
 * a tester names the failing tests, a red is the same red only where the
 * failure is: a file red at `main` on one test and at the tip on another is
 * searched for the second alone, and a commit red only on the first reads as
 * green; a tester naming none falls back to the file verdict (#3937).
 *
 * Its green ledger (one `<sha> <iso time>` line per sha it lands), its
 * no-verdict ledger (the same line per parent, culprit or bisected commit
 * whose whole suite reached no verdict, never run whole again), pidfile and heartbeat sit under the canonical checkout's markers directory,
 * machine-local and gitignored, so a worktree's lander shares them with the
 * main tree's.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught, parseErrorText } = require("./caught.js");
const { FULL_SHA } = require("./commit-sha.js");
const { parseFirstLine } = require("./first-line.js");
const { writeFileAtomic } = require("./atomic-write.js");
const {
	LANDING_BRANCH,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { execGit, gitBinary, gitSpawnOptions } = require("./git.js");
const { execGroupedSync } = require("./grouped-child.js");
const { writeFd } = require("./write-fd.js");
const {
	LANDER_REVERT_ENV,
	buildRevertLine,
	readKeptAnchors,
} = require("./clean-revert.js");

/* Untraced: a fraction of the stall check's 2 h, so a live lander is never
 * read as dead mid-suite. */
const HEARTBEAT_MS = 60 * 1000;
/* Untraced: room for a fetch over a slow link. */
const LANDER_GIT_TIMEOUT_MS = 120 * 1000;
/* Untraced: the push runs the checkout's pre-push hook, whose mod tests run
 * `claude plugin test` on a batch touching a mod. */
const PUSH_TIMEOUT_MS = 20 * 60 * 1000;
/* Measured on #3913: the gate stack fits this up to load 42-56, if time scales
 * with load, which no run measured. */
const REVERT_COMMIT_TIMEOUT_MS = 600 * 1000;
const REGISTRY_CHECK = path.join(__dirname, "..", "check-guard-registry.js");

/** A culprit `mergedSide` reads no side of: a plain commit's. */
const NO_SIDE = { base: null, range: [], merges: [] };

/* Untraced: of 25 merges on 14 days of `landing`, 20 nest at most 1 deep and 5
 * at 10 or more, so no figure from 2 to 9 reaches more of them. This only bounds
 * the wait, each merge searched costing its own reruns with the queue held
 * (#3936). */
const SIDE_MERGES_SEARCHED = 3;

/* Untraced: a revert racing that many session pushes in a row is a busier
 * `landing` than any seen. */
const REVERT_PUSH_TRIES = 3;
/* git push's words for a refusal because the remote branch moved. */
const MOVED = /\[rejected\]|non-fast-forward|fetch first/;
const GIT_REFUSAL = /^(?:error|fatal):.*|^ ! \[.*/m;

/**
 * The line naming why a git call failed: git's own refusal where it printed
 * one, as a push's first line is the pre-push hook's, else the first line.
 * @param {string} text
 */
const parseRefusal = (text) =>
	GIT_REFUSAL.exec(text)?.[0] ?? parseFirstLine(text);
/* A gate's verdict line, as a commit hook's first line is npm's echo of the
 * script it runs. Residual: a gate that prints neither falls back to that
 * echo. */
const GATE_VERDICT = /^(?:FAIL|BROKEN): .*/m;

/**
 * What a failed call printed to stderr, else its error's message.
 * @param {unknown} err
 */
const readThrownText = (err) => {
	const e = caught(err);
	return String(e.stderr || e.message);
};

/**
 * What `call` printed to stderr where it threw, else null.
 * @param {() => unknown} call
 * @returns {string|null}
 */
function stderrIfThrown(call) {
	try {
		call();
		return null;
	} catch (err) {
		return readThrownText(err);
	}
}
/* Untraced: five tries over about a minute, outlasting a DNS or connection
 * blip (#2673); the backoff is exponential and randomised, as the Google SRE
 * book's "Addressing Cascading Failures" chapter sets for a retrying client. */
const REMOTE_TRIES = 5;
const REMOTE_BACKOFF_MS = 4 * 1000;
const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d/;

/**
 * @typedef {{file: string, test: string, message?: string,
 *   signature?: string}} Failure a failing test; where the runner printed its
 *   error, `message` to read and `signature` to compare, the same across runs
 *   of one failure
 * @typedef {{kind: "green", run?: number}
 *   | {kind: "red", files: string[], jobs?: string[], failures?: Failure[]}
 *   | {kind: "unknown", reason: string}} Verdict `run` the CI run that passed
 *   it and `jobs` the failing CI jobs, where the tester read a CI run;
 *   `failures` where it named the failing tests
 * @typedef {"flake" | "base" | "bisect" | "confirm" | "parent"
 *   | "parent-main"
 *   | "parent-files" | "side" | "side-confirm"} RerunWhy
 * @typedef {{kind: "test", sha: string} | {kind: "fast-forward", sha: string}
 *   | {kind: "rerun", sha: string, files: string[], why: RerunWhy}
 *   | {kind: "bisect", base: string|null, sha: string}
 *   | {kind: "read-side", merge: string, parent: string, bisectedParent?: string}
 *   | {kind: "read-main-jobs", jobs: string[],
 *       slot: "tipJobsOnMain" | "jobsOnMain", since: string}
 *   | {kind: "revert", culprit: string, parent: string|null, files: string[],
 *       jobs: string[], failures?: Failure[], parentIsMain: boolean}
 *   | {kind: "file-fix-ticket", culprit: string, parent: string|null,
 *       revert: string, files: string[], jobs: string[], failures?: Failure[],
 *       stale: RegistryRow[]|null}
 *   | {kind: "hold", reason: string, cause?: "already-red", ticket?: FixTicket}
 *   | {kind: "exit", reason: string}} Action
 * @typedef {Extract<Action, {kind: "exit"}> | Extract<Action, {kind: "hold"}>}
 *   End
 * @typedef {{kind: "read", red: string[], notRed: string[], shas: string[]}
 *   | {kind: "unread", reason: string}} JobsOnMain which of a set of CI jobs
 *   `main`'s newest run of each failed, the rest of them, and the shas the
 *   runs that failed them tested, or why that went unread
 * @typedef {object} Red a red batch while the lander clears it
 * @property {string} sha the batch's tip
 * @property {string|null} base `main` when the batch was tested
 * @property {string[]} files the failing files, every rerun's target; empty
 *   where the tester named none, which reruns the whole suite
 * @property {string[]} jobs the failing CI jobs, which name the red where
 *   `files` is empty; never a rerun's target
 * @property {Verdict|null} flake the one rerun at the tip
 * @property {Verdict|null} onMain the base check: the tip's red files run at
 *   `base`, where those that fail are a known breakage the bisect leaves out
 * @property {string[]|null} range the commits after `base` up to the tip,
 *   oldest first
 * @property {Record<string, Verdict>} bisect each bisected commit's verdict
 * @property {Record<string, Verdict>} confirm the culprit's second run and
 *   its parent's run, the whole suite or, where the parent is `main`, the
 *   culprit's failing files; apart from the bisect's so they never move the
 *   culprit it named
 * @property {Verdict|null} parentOnFiles the parent's run on `files`, taken
 *   only where its whole suite reached no verdict
 * @property {JobsOnMain|null} tipJobsOnMain the tip's failing CI jobs as
 *   `main` last ran them, read before the bisect where its red names no file:
 *   those red there are a known breakage the bisect leaves out
 * @property {JobsOnMain|null} jobsOnMain the culprit's failing CI jobs as
 *   `main` last ran them, read where its parent is `main` and its red names
 *   no file
 * @property {{sha: string, verdict: Verdict|null}|null} pushedPast the
 *   `landing` tip a read of the refs found pushed past `sha`, and its own
 *   test's verdict, null until taken
 * @property {Side|null} side the search of a merge culprit's merged side
 * @property {Revert|null} revert
 * @property {string|null} unfiled why the fix ticket was not filed
 * @typedef {{culprit: string, parent: string|null}} Culprit a commit the
 *   bisect named red, and the commit before it on the range it searched
 * @typedef {Culprit & {whyNoSideCommit?: string}} RevertTarget what to
 *   revert, and where that is a merge, why no commit on its side stands in
 * @typedef {{base: string|null, range: string[], merges: string[]}} SideRead
 * @typedef {object} Side the commits a merge culprit brought in from the
 *   parent the bisect did not step from, or, once `through` names merges, from
 *   the last one's other parent
 * @property {string} merge the culprit
 * @property {string[]} through the merges on its side the search went past,
 *   outermost first
 * @property {string|null} base the commit `range` starts from, null where
 *   the merge searched is no two-parent merge
 * @property {string[]} range the first-parent line the bisected parent lacks,
 *   oldest first, empty where the merge searched adds none
 * @property {string[]} merges those of `range` that are merges: a red first
 *   seen at one came in with its other parent, so its revert is no fix
 * @property {Record<string, Verdict>} bisect each run on the side, its base's
 *   included
 * @property {Verdict|null} confirm the side culprit's second run
 * @typedef {{row: string, forward: string}} RegistryRow a guard-registry
 *   row, and the fix-forward that clears it
 * @typedef {{sha: string, onto: string, stale?: RegistryRow[]|null} |
 *   {failed: string}} Revert the revert's sha, the `landing` tip it was
 *   committed on and the rows it left stale, null where they could not be
 *   read, or why it did not land: a conflict or a refused commit or push
 * @typedef {object} LanderState
 * @property {string|null} main `main`'s sha on the remote
 * @property {string|null} landing `landing`'s sha on the REMOTE, null where
 *   the branch is absent
 * @property {Relation} relation where `landing` stands against `main`
 * @property {(sha: string) => boolean} isGreen whether the ledger holds `sha`
 * @property {(sha: string) => boolean} isStuck whether the no-verdict ledger
 *   holds `sha`
 * @property {{sha: string, verdict: Exclude<Verdict, {kind: "red"}>}|null}
 *   tested the batch this run took and the tester's verdict on it, a red
 *   one becoming `red`
 * @property {Red|null} red
 * @property {{sha: string, reason: string}|null} refused the push to `main`
 *   this run made and the remote refused, with git's refusal line
 * @property {boolean} requiresRun whether `main` takes only a sha a CI run
 *   passed, the tester's `requiresRun`
 */

/** @typedef {"ahead" | "equal" | "behind" | "diverged"} Relation */
/** @typedef {{main: string|null, landing: string|null}} Refs the remote's
 *  `main` and `landing` shas, null where the branch is absent */

/** Untraced: 9 hex digits, two past git's default abbreviation, unique in any history this size.
 * @param {string} sha */
const short = (sha) => sha.slice(0, 9);

/** @param {string[]} files */
const filesLabel = (files) =>
	files.length > 0 ? files.join(", ") : "the whole suite";

/**
 * @typedef {{files: string[], jobs?: string[], failures?: Failure[]}} Failing
 *   what a red failed; `jobs` absent on a verdict read off no CI run, and
 *   `failures` where the tester named no test
 */

/**
 * @param {string[]} files
 * @param {Failure[]} [failures]
 * @returns {string[]}
 */
const failureLabels = (files, failures = []) =>
	failureRows(files, failures).map((row) => row.label);

/**
 * One row per failing test, or per file where the tester named none there.
 * @param {string[]} files
 * @param {Failure[]} failures
 * @returns {{label: string, message?: string}[]}
 */
const failureRows = (files, failures) =>
	files.flatMap((file) => {
		const named = failures.filter((f) => f.file === file);
		return named.length > 0
			? named.map((f) => ({
					label: `${file} > ${f.test}`,
					...(f.message ? { message: f.message } : {}),
				}))
			: [{ label: file }];
	});

/**
 * Runner text as a code span, so an issue body never reads it as a mention.
 * @param {string} text
 */
const codeSpan = (text) => `\`${text.replaceAll("`", "'")}\``;

/**
 * The names that say what a red failed: its files, else its failing CI jobs
 * (#3253), else none, the whole suite.
 * @param {Failing} f
 * @returns {{of: "files" | "jobs", names: string[]} | null}
 */
function failingNames({ files, jobs = [] }) {
	if (files.length > 0) return { of: "files", names: files };
	if (jobs.length > 0) return { of: "jobs", names: jobs };
	return null;
}

/** @param {Failing} f */
function failingLabel(f) {
	const named = failingNames(f);
	if (named?.of !== "jobs")
		return filesLabel(failureLabels(f.files, f.failures));
	return `the CI jobs ${named.names.map((j) => `'${j}'`).join(", ")}`;
}

/**
 * `failingLabel` as an issue body's list.
 * @param {Failing} f
 */
function failingList(f) {
	const named = failingNames(f);
	if (named === null)
		return "- the whole suite (the tester named no failing file)";
	if (named.of === "files")
		return failureRows(f.files, f.failures ?? [])
			.map(
				({ label, message }) =>
					`- ${codeSpan(label)}${message ? `: ${codeSpan(message)}` : ""}`,
			)
			.join("\n");
	return named.names
		.map((n) => `- CI job \`${n}\` (the tester named no failing file)`)
		.join("\n");
}

/**
 * The culprit the bisect has narrowed to, or the next commit to test: the
 * first red after the last green, `base` counting as green since `main` only
 * holds a sha the suite passed. A red on nothing searched counts green.
 * @param {{range: string[], base: string|null, bisect: Record<string, Verdict>}} r
 * @param {Search} search
 * @returns {Culprit | {next: string}}
 */
function bisectStep(r, search) {
	let bad = r.range.length - 1;
	r.range.forEach((sha, i) => {
		if (isSearchedRed(r.bisect[sha], search) && i < bad) bad = i;
	});
	let good = -1;
	r.range.forEach((sha, i) => {
		const v = r.bisect[sha];
		if (v && v.kind !== "unknown" && !isSearchedRed(v, search) && i < bad)
			good = i;
	});
	/** @param {number} i */
	const at = (i) => {
		const sha = r.range[i];
		if (sha === undefined)
			throw new Error(`bisect index ${i} outside its range`);
		return sha;
	};
	if (bad - good > 1) return { next: at(Math.floor((good + bad) / 2)) };
	return { culprit: at(bad), parent: bad === 0 ? r.base : at(bad - 1) };
}

/**
 * The next action on a red batch: test the tip `landing` was pushed past it
 * to and land that where it passes, else rerun the failing files at the tip,
 * and where they stay red, bisect to the first red commit, confirm it red
 * twice with its parent green, then land the parent, revert the culprit and
 * file its fix ticket. Anything short of that confirmation holds; a run with no
 * verdict exits.
 * @param {Red} r
 * @param {Pick<LanderState, "main" | "isGreen" | "isStuck" | "requiresRun">} s
 * @returns {Action}
 */
function redAction(r, s) {
	const pushed = pushedPastAction(r, s);
	if (pushed) return pushed;
	/** @type {[string|null, Verdict|null][]} */
	const runs = [
		[r.sha, r.flake],
		[r.base, r.onMain],
		...Object.entries(r.bisect),
	];
	for (const [sha, v] of runs)
		if (sha !== null && v?.kind === "unknown")
			return buildNoVerdictExit(sha, v);
	if (!r.flake)
		return { kind: "rerun", sha: r.sha, files: r.files, why: "flake" };
	/* Spec #2261's flake check. Residual: a flaky file outside `files` lands
	 * unseen, the whole suite having run once, red. */
	if (r.flake.kind === "green")
		return isLandable(r.flake, s.requiresRun)
			? { kind: "fast-forward", sha: r.sha }
			: {
					kind: "hold",
					reason: `${short(r.sha)} passed ${failingLabel(r)} on a rerun no CI run made, and main takes only a sha a CI run passed`,
				};
	const tip = namedOr(r.flake, r.files);
	const redJobs = redJobsRead(r.tipJobsOnMain);
	const mainCheck = mainCheckAction(r, tip, redJobs);
	if (mainCheck) return mainCheck;
	const known = redOnMain(r.onMain, tip, r.flake);
	const files = tip.filter((f) => !known.includes(f));
	if (known.length > 0 && files.length === 0) return buildAlreadyRedHold(known);
	const sought = soughtFailures(r.flake, r.onMain, files);
	const action = clearRed({ ...r, files }, { ...s, known, redJobs, sought });
	return withAlreadyRed(action, known, redJobs);
}

/**
 * `action`, where it is a hold for another cause, naming what the tip
 * failed that is red on `main` too.
 * @param {Action} action
 * @param {string[]} known the tip's files red on `main`
 * @param {RedJobs|null} redJobs the read that found its CI jobs red there
 * @returns {Action}
 */
function withAlreadyRed(action, known, redJobs) {
	if (action.kind !== "hold" || action.cause === "already-red") return action;
	const also = [
		...(known.length > 0 ? [buildAlreadyRedReason(known)] : []),
		...(redJobs ? [buildAlreadyRedJobsReason(redJobs)] : []),
	];
	return also.length === 0
		? action
		: { ...action, reason: [action.reason, ...also].join("; ") };
}

/**
 * The check of what the tip failed against `main`: its failing files rerun
 * at `base`, or where it names none, its failing CI jobs read there and the
 * hold where every one is red. Null once taken.
 * @param {Red} r
 * @param {string[]} tip the tip's failing files
 * @param {RedJobs|null} redJobs `r.tipJobsOnMain` where it found a job red
 * @returns {Action|null}
 */
function mainCheckAction(r, tip, redJobs) {
	if (redJobs?.notRed.length === 0) return buildAlreadyRedJobsHold(redJobs);
	/* Never once the bisect has begun: its verdicts were taken over `tip`. */
	if (r.range || r.base === null) return null;
	if (tip.length > 0)
		return r.onMain
			? null
			: { kind: "rerun", sha: r.base, files: tip, why: "base" };
	if (r.tipJobsOnMain) return null;
	const jobs = jobsOr(r.flake, r.jobs);
	return jobs.length > 0
		? { kind: "read-main-jobs", jobs, slot: "tipJobsOnMain", since: r.base }
		: null;
}

/**
 * The test of the tip `landing` was pushed past `r` to, or its landing where
 * the ledger holds it or it passed; null once it did not.
 * @param {Red} r
 * @param {Pick<LanderState, "isGreen" | "requiresRun">} s
 * @returns {Action|null}
 */
function pushedPastAction({ pushedPast }, { isGreen, requiresRun }) {
	if (!pushedPast) return null;
	const { sha, verdict } = pushedPast;
	if (isGreen(sha) || isLandable(verdict, requiresRun))
		return { kind: "fast-forward", sha };
	return verdict ? null : { kind: "test", sha };
}

/**
 * @typedef {Extract<JobsOnMain, {kind: "read"}>} RedJobs a read of the tip's
 *   failing CI jobs that found one red on `main`: `red` a known breakage,
 *   `notRed` the CI jobs the bisect searches, beside every file
 * @typedef {Pick<LanderState, "main" | "isGreen" | "isStuck" | "requiresRun">
 *   & Search & {known: string[]}} Clearing `known` the tip's red files that
 *   are red on `main` too
 * @typedef {{redJobs: RedJobs|null, sought: Failure[]}} Search what a bisect
 *   looks for: `redJobs` the read of the tip's CI jobs, null where it went
 *   unread, was not taken, or found none red there; `sought` the failures a
 *   commit must repeat, empty where the tester named no test
 */

/**
 * `read` where it found a job red on `main`, else null.
 * @param {JobsOnMain|null} read
 * @returns {RedJobs|null}
 */
const redJobsRead = (read) =>
	read?.kind === "read" && read.red.length > 0 ? read : null;

/**
 * @param {Failure} a
 * @param {Failure} b
 */
const isSameFailure = (a, b) =>
	a.file === b.file &&
	a.test === b.test &&
	(a.signature === undefined ||
		b.signature === undefined ||
		a.signature === b.signature);

/**
 * @param {Verdict|null|undefined} v
 * @param {string} file
 * @returns {Failure[]}
 */
const failuresIn = (v, file) =>
	v?.kind === "red" ? (v.failures ?? []).filter((f) => f.file === file) : [];

/**
 * Whether red `v` repeats a failure in `sought`.
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @param {Failure[]} sought
 */
const hasSoughtFailure = (v, sought) =>
	v.files.length === 0 ||
	v.files.some((file) => {
		const wanted = sought.filter((s) => s.file === file);
		const got = failuresIn(v, file);
		return (
			wanted.length === 0 ||
			got.length === 0 ||
			got.some((f) => wanted.some((s) => isSameFailure(f, s)))
		);
	});

/**
 * The failures the bisect looks for: those the tip's rerun names in `files`
 * that `main` did not fail.
 * @param {Verdict} flake
 * @param {Verdict|null} onMain
 * @param {string[]} files
 * @returns {Failure[]}
 */
const soughtFailures = (flake, onMain, files) =>
	files.flatMap((file) =>
		failuresIn(flake, file).filter(
			(f) => !failuresIn(onMain, file).some((m) => isSameFailure(f, m)),
		),
	);

/**
 * Whether `v` is red on what the bisect searches: a file, on a failure of
 * `sought` where it names them, or a job of `redJobs.notRed` where `redJobs`
 * is not null. Residual (#3586): a commit that breaks a job already red on
 * `main` again goes unfound, and a resumed bisect keeps the read it began with
 * though `main` may have gone green since.
 * @param {Verdict|undefined} v
 * @param {Search} search
 * @returns {v is Extract<Verdict, {kind: "red"}>}
 */
const isSearchedRed = (v, { redJobs, sought }) =>
	v?.kind === "red" &&
	(v.files.length > 0
		? hasSoughtFailure(v, sought)
		: redJobs === null ||
			(v.jobs ?? []).some((j) => isSearchedJob(j, redJobs)));

/**
 * Whether the bisect searches CI job `job`: every job where `redJobs` is
 * null, else those of `redJobs.notRed`.
 * @param {string} job
 * @param {RedJobs|null} redJobs
 */
const isSearchedJob = (job, redJobs) =>
	redJobs === null || redJobs.notRed.includes(job);

/**
 * Whether `main` may move to a sha `v` judged: green, and read off a CI run
 * where `main` takes only a sha a run passed.
 * @param {Verdict|null|undefined} v
 * @param {boolean} requiresRun
 */
const isLandable = (v, requiresRun) =>
	v?.kind === "green" && (!requiresRun || v.run !== undefined);

/**
 * The bisect, the culprit's confirmation and what follows it, over `r.files`:
 * the tip's red files that pass on `main`.
 * @param {Red} r
 * @param {Clearing} s
 * @returns {Action}
 */
function clearRed(r, s) {
	if (!r.range) return { kind: "bisect", base: r.base, sha: r.sha };
	const step = bisectStep({ ...r, range: r.range }, s);
	if ("next" in step && isWholeSuite(r.files) && s.isStuck(step.next))
		return {
			kind: "hold",
			reason: `bisect unfinished: ${short(step.next)}'s whole suite reached no verdict on a past run`,
		};
	if ("next" in step)
		return { kind: "rerun", sha: step.next, files: r.files, why: "bisect" };
	const byName = soughtByName(r, step, s);
	if (byName) return clearRed(r, { ...s, sought: byName });
	return confirmAction(r, step, s) ?? culpritAction(r, step, s);
}

/**
 * `sought` matched by file and test alone, where the bisected parent's whole
 * suite fails one of them on another message and `main` fails no test of
 * that name: a commit that rewords a broken test's message then reads red,
 * not as the break (#4336). Null where no signature would drop. Residual: a
 * test `main` fails by name keeps its signature, so its rewording still holds
 * at parentAction; and a commit turning a broken test into a truly different
 * failure is passed over for the one that first broke it.
 * @param {Red} r
 * @param {Culprit} bisected
 * @param {Pick<Clearing, "main" | "sought">} s
 * @returns {Failure[]|null}
 */
function soughtByName(r, { parent }, { main, sought }) {
	if (parent === null || parent === main) return null;
	const before = r.confirm[parent];
	/** @param {Failure} a @param {Failure} b */
	const isSameTest = (a, b) => a.test === b.test;
	const drops = sought.filter(
		(want) =>
			want.signature !== undefined &&
			failuresIn(before, want.file).some(
				(f) => isSameTest(want, f) && !isSameFailure(f, want),
			) &&
			!failuresIn(r.onMain, want.file).some((m) => isSameTest(want, m)),
	);
	if (drops.length === 0) return null;
	return sought.map((want) => {
		if (!drops.includes(want)) return want;
		const { signature: _, ...unsigned } = want;
		return unsigned;
	});
}

/**
 * Whether a rerun on `files` runs the whole suite: the no-verdict ledger's
 * one kind of run.
 * @param {string[]} files
 */
const isWholeSuite = (files) => files.length === 0;

/**
 * @param {Verdict|undefined} v
 * @param {string[]} files
 */
const namedOr = (v, files) =>
	v?.kind === "red" && v.files.length > 0 ? v.files : files;

/**
 * Null where either names no test in `file`.
 * @param {Verdict|null|undefined} v
 * @param {Verdict|null} onMain
 * @param {string} file
 * @returns {boolean|null}
 */
function isRepeatOfMain(v, onMain, file) {
	const got = failuresIn(v, file);
	const there = failuresIn(onMain, file);
	if (got.length === 0 || there.length === 0) return null;
	return got.every((f) => there.some((m) => isSameFailure(f, m)));
}

/**
 * The files of `checked` red on `main`: those a red run there named, or all
 * of them where it named none of them, less any where `v` fails a test `main`
 * did not.
 * @param {Verdict|null} onMain
 * @param {string[]} checked
 * @param {Verdict|null} [v]
 */
function redOnMain(onMain, checked, v) {
	if (onMain?.kind !== "red") return [];
	const named = checked.filter((f) => onMain.files.includes(f));
	return (named.length > 0 ? named : checked).filter(
		(f) => isRepeatOfMain(v, onMain, f) !== false,
	);
}

/**
 * What of red `v` is not red on `main`: its files outside `known`, and its
 * CI jobs the bisect searches, any job where `redJobs` is null (#3679).
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @param {string[]} known
 * @param {RedJobs|null} redJobs
 * @param {Verdict|null} onMain the base check, which names tests where it can
 * @returns {Required<Omit<Failing, "failures">>}
 */
const beyondMain = (v, known, redJobs, onMain) => ({
	files: v.files.filter(
		(f) => !(isRepeatOfMain(v, onMain, f) ?? known.includes(f)),
	),
	jobs: (v.jobs ?? []).filter((j) => isSearchedJob(j, redJobs)),
});

/**
 * Whether red `v` is red only on files red on `main`, and on no CI job the
 * bisect searches.
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @param {Required<Omit<Failing, "failures">>} beyond beyondMain's read of `v`
 */
const isRedOnlyOnMain = (v, beyond) =>
	v.files.length > 0 && beyond.files.length === 0 && beyond.jobs.length === 0;

/** @param {string[]} files */
const buildAlreadyRedReason = (files) =>
	`already red on \`main\`: ${filesLabel([...new Set(files)])}`;

/**
 * @param {string[]} files
 * @returns {Extract<Action, {kind: "hold"}>}
 */
const buildAlreadyRedHold = (files) => ({
	kind: "hold",
	reason: buildAlreadyRedReason(files),
	cause: "already-red",
});

/**
 * @param {string} sha
 * @param {Extract<Verdict, {kind: "unknown"}>} v
 * @returns {Action}
 */
const buildNoVerdictExit = (sha, v) => ({
	kind: "exit",
	reason: `no verdict at ${short(sha)}: ${v.reason}`,
});

/**
 * The culprit's confirming runs, or null once it failed twice and its parent
 * passed. A parent whose whole suite reached no verdict is run on `files`
 * alone, once, and a culprit whose whole suite reached none holds: rerunning
 * the whole suite would end the same way on every start.
 * @param {Red} r
 * @param {Culprit} bisected
 * @param {Clearing} s
 * @returns {Action|null}
 */
function confirmAction(r, { culprit, parent }, s) {
	const again = r.confirm[culprit];
	if (!isSearchedRed(again, s)) return secondRunAction(r, culprit, again, s);
	if (parent === null) return null;
	/* `main` only ever holds a sha the full suite passed. */
	if (parent === s.main) {
		const named = namedOr(again, r.files);
		if (named.length > 0) return mainConfirmAction(r, parent, named, s);
		return mainJobsAction(r, parent, culpritJobs(r, culprit, s.redJobs));
	}
	return parentAction(r, culprit, parent, s);
}

/**
 * @param {Red} r
 * @param {string} culprit
 * @param {string} parent
 * @param {Clearing} s
 * @returns {Action|null}
 */
function parentAction(r, culprit, parent, s) {
	const { isStuck, known, redJobs, sought } = s;
	const { files } = r;
	/* The whole suite, as the parent lands on `main`. */
	const before = r.confirm[parent];
	if (!before && !isStuck(parent))
		return { kind: "rerun", sha: parent, files: [], why: "parent" };
	/* A parent red only on files red on `main` — or, where the tip's read
	 * found a job red there (#3586), only on CI jobs red on `main` or
	 * outside that read — is reverted past, never landed: culpritAction
	 * fast-forwards a parent only where its whole suite passed. Unlike
	 * culpritJobs, a job outside the read counts as red on `main`: no read
	 * of `main` runs here to judge it. Any failure counts, not only those
	 * sought, as this parent would land. */
	if (isSearchedRed(before, { redJobs, sought: [] })) {
		const beyond = beyondMain(before, known, redJobs, r.onMain);
		if (!isRedOnlyOnMain(before, beyond))
			return {
				kind: "hold",
				reason: parentUnconfirmed(
					culprit,
					parent,
					`fails the whole suite: ${failingLabel(beyond)}`,
				),
			};
	}
	if (before && before.kind !== "unknown") return null;
	/* Residual (#2910): the revert then rests on `files` alone at the parent,
	 * so a parent red elsewhere in the suite goes unseen here. Bound:
	 * culpritAction fast-forwards only a parent whose whole suite passed, and
	 * the reverted tip is tested whole as its own batch, which bisects that
	 * red to the parent. Short of it: a red there whose files then pass one
	 * rerun reaches `main` by redAction's flake check (spec #2261). */
	const onFiles = r.parentOnFiles;
	if (!onFiles)
		return { kind: "rerun", sha: parent, files, why: "parent-files" };
	if (onFiles.kind === "unknown")
		return {
			kind: "hold",
			reason: parentUnconfirmed(
				culprit,
				parent,
				`reached no verdict on the whole suite or on ${filesLabel(files)}: ${onFiles.reason}`,
			),
		};
	if (onFiles.kind === "red" && hasSoughtFailure(onFiles, sought))
		return {
			kind: "hold",
			reason: parentUnconfirmed(
				culprit,
				parent,
				`fails ${failingLabel(onFiles)}`,
			),
		};
	return null;
}

/**
 * The culprit's second run, or the hold where it did not fail. One whose
 * whole suite reached no verdict, now or on a past run, holds.
 * @param {Red} r
 * @param {string} culprit
 * @param {Verdict|undefined} again its second run, red on nothing searched
 * @param {Pick<Clearing, "isStuck" | "redJobs" | "sought">} s
 * @returns {Action}
 */
function secondRunAction(r, culprit, again, { isStuck, redJobs, sought }) {
	const { files } = r;
	const whole = isWholeSuite(files);
	if (!again && !(whole && isStuck(culprit)))
		return { kind: "rerun", sha: culprit, files, why: "confirm" };
	if (again?.kind === "green" || again?.kind === "red")
		return {
			kind: "hold",
			reason: `culprit unconfirmed: ${short(culprit)} passed ${failingLabel({ files, jobs: culpritJobs(r, culprit, redJobs), failures: sought })} on its second run`,
		};
	if (again && !whole) return buildNoVerdictExit(culprit, again);
	return {
		kind: "hold",
		reason: `culprit unconfirmed: ${short(culprit)}'s whole suite reached no verdict on its second run${again ? `: ${again.reason}` : ""}`,
	};
}

/**
 * The confirm of a parent that is `main`: the culprit's failing files rerun
 * there, never the whole suite, as `main` lands nothing.
 * @param {Red} r
 * @param {string} main the culprit's parent
 * @param {string[]} files the culprit's failing files
 * @param {Pick<Clearing, "known" | "sought">} s
 * @returns {Action|null}
 */
function mainConfirmAction(r, main, files, { known, sought }) {
	const before = r.confirm[main];
	if (!before) return { kind: "rerun", sha: main, files, why: "parent-main" };
	if (before.kind === "unknown") return buildNoVerdictExit(main, before);
	if (before.kind === "red" && hasSoughtFailure(before, sought))
		return buildAlreadyRedHold([...known, ...redOnMain(before, files)]);
	return null;
}

/**
 * The read of the culprit's failing CI jobs on `main`, or the hold where one
 * is red there; null where `main` is the parent this batch landed, its whole
 * suite passed. Residual: a job already red on `main` that no recent run
 * there passed or failed reverts the culprit.
 * @param {Red} r
 * @param {string} main the culprit's parent
 * @param {string[]} jobs the culprit's failing CI jobs
 * @returns {Action|null}
 */
function mainJobsAction(r, main, jobs) {
	if (jobs.length === 0 || r.confirm[main]) return null;
	const read = r.jobsOnMain;
	if (!read)
		return { kind: "read-main-jobs", jobs, slot: "jobsOnMain", since: main };
	if (read.kind === "unread" || read.red.length === 0) return null;
	return buildAlreadyRedJobsHold(read);
}

/**
 * @param {RedJobs} read
 * @returns {Extract<Action, {kind: "hold"}>}
 */
const buildAlreadyRedJobsHold = (read) => ({
	kind: "hold",
	reason: buildAlreadyRedJobsReason(read),
	cause: "already-red",
});

/** @param {RedJobs} read */
const buildAlreadyRedJobsReason = ({ red, shas }) =>
	`already red on \`main\` in the run at ${shas.map(short).join(", ")}: ${failingLabel({ files: [], jobs: red })}`;

/**
 * The CI jobs the culprit's own red failed, less those red on `main`, which
 * differ from the tip's where `files` is empty and every rerun is the whole
 * suite. A job outside the tip's read is kept, unlike confirmAction's parent
 * hold: these name the culprit's own red in its hold and revert, and where
 * its parent is `main`, mainJobsAction reads them there afresh.
 * @param {Red} r
 * @param {string} culprit
 * @param {RedJobs|null} redJobs
 */
function culpritJobs(r, culprit, redJobs) {
	const known = redJobs?.red ?? [];
	/** @param {string[]} jobs */
	const unknown = (jobs) => jobs.filter((j) => !known.includes(j));
	const side = r.side?.range.includes(culprit) ? r.side : null;
	for (const v of [
		r.confirm[culprit],
		r.bisect[culprit],
		side?.confirm,
		side?.bisect[culprit],
	]) {
		const jobs = v?.kind === "red" ? unknown(v.jobs ?? []) : [];
		if (jobs.length > 0) return jobs;
	}
	return unknown(r.jobs);
}

/**
 * @param {Verdict|null|undefined} v
 * @param {string[]} jobs
 */
const jobsOr = (v, jobs) =>
	v?.kind === "red" && v.jobs?.length ? v.jobs : jobs;

/**
 * @param {string} culprit
 * @param {string} parent
 * @param {string} why
 */
const parentUnconfirmed = (culprit, parent, why) =>
	`culprit unconfirmed: ${short(culprit)}'s parent ${short(parent)} ${why}`;

/**
 * What follows a confirmed culprit: land its parent where it is ahead of
 * `main` and passed the whole suite, revert it, or the commit revertTarget
 * names in its place, on `landing`, then file its fix ticket. A parent no CI
 * run passed, where `main` requires one, is reverted past.
 * @param {Red} r
 * @param {Culprit} confirmed
 * @param {Pick<Clearing, "main" | "requiresRun" | "redJobs" | "isGreen" | "sought">} s
 * @returns {Action}
 */
function culpritAction(r, confirmed, s) {
	const { main, requiresRun, redJobs } = s;
	if (
		confirmed.parent !== null &&
		confirmed.parent !== main &&
		isLandable(r.confirm[confirmed.parent], requiresRun)
	)
		return { kind: "fast-forward", sha: confirmed.parent };
	const target = revertTarget(r, confirmed, s);
	if ("kind" in target) return target;
	const { culprit, parent, whyNoSideCommit } = target;
	const jobs = culpritJobs(r, culprit, redJobs);
	const sought = culpritSought(r, confirmed.culprit, s.sought);
	const files = r.files.filter(
		(f) =>
			sought.some((t) => t.file === f) || !s.sought.some((t) => t.file === f),
	);
	const failuresField = sought.length > 0 ? { failures: sought } : {};
	if (!r.revert)
		return {
			kind: "revert",
			culprit,
			parent,
			files,
			jobs,
			...failuresField,
			/* `main` both as the batch was tested and now: a parent landed
			 * since is `main` now but was confirmed on its own run, and a base
			 * `main` has moved off was confirmed as a parent (#3533). */
			parentIsMain: parent !== null && parent === r.base && parent === main,
		};
	if ("failed" in r.revert)
		return {
			kind: "hold",
			reason: `the revert of ${short(culprit)} did not land on landing: ${r.revert.failed}${whyNoSideCommit ? `; no commit on its merged side to revert instead: ${whyNoSideCommit}` : ""}`,
		};
	const ticket = {
		culprit,
		parent,
		revert: r.revert.sha,
		files,
		jobs,
		...failuresField,
		stale: r.revert.stale ?? null,
	};
	if (r.unfiled !== null)
		return {
			kind: "hold",
			reason: `${short(culprit)} is reverted in ${short(r.revert.sha)}, but its fix ticket is not filed: ${r.unfiled}`,
			ticket,
		};
	return { kind: "file-fix-ticket", ...ticket };
}

/**
 * Those of `sought` the confirmed culprit itself failed, all of them where its
 * second run named none: a later commit's failure at the tip is no part of it,
 * and a side's own red inherited from `landing` no break its merge brought in.
 * @param {Red} r
 * @param {string} culprit
 * @param {Failure[]} sought
 * @returns {Failure[]}
 */
function culpritSought(r, culprit, sought) {
	const v = r.confirm[culprit];
	const its = sought.filter((s) =>
		failuresIn(v, s.file).some((f) => isSameFailure(f, s)),
	);
	return its.length > 0 ? its : sought;
}

/**
 * culpritSought, each failure the merge's second run repeats carrying that
 * run's signature: a side's own red inherited from `landing` is often the
 * same test on another message, which a failure matched by name alone would
 * read as the break (#3926, #4336).
 * @param {Red} r
 * @param {string} merge
 * @param {Failure[]} sought
 * @returns {Failure[]}
 */
function mergeSigned(r, merge, sought) {
	const v = r.confirm[merge];
	return culpritSought(r, merge, sought).map(
		(s) => failuresIn(v, s.file).find((f) => isSameFailure(f, s)) ?? s,
	);
}

/**
 * The commit to revert for a confirmed culprit, or the run that finds it.
 * Reverting a merge undoes the whole side it merged in, so where the culprit
 * is one, the line of that side its parent lacks is bisected on `r.files`, and its
 * first red commit, red again on a second run, is reverted instead (#3631).
 * @param {Red} r
 * @param {Culprit} confirmed
 * @param {Pick<Clearing, "redJobs" | "isGreen" | "sought">} s
 * @returns {Action | RevertTarget}
 */
function revertTarget(r, confirmed, s) {
	if (confirmed.parent === null) return confirmed;
	const { side } = r;
	/* A revert a run before #3631 made read no side, and reverted the merge. */
	if (side?.merge !== confirmed.culprit)
		return r.revert
			? confirmed
			: {
					kind: "read-side",
					merge: confirmed.culprit,
					parent: confirmed.parent,
				};
	if (side.range.length === 0) {
		const passed = side.through.at(-1);
		return passed
			? {
					...confirmed,
					...endAtMerge(passed, "with nothing further to search"),
				}
			: confirmed;
	}
	const found = sideCulprit(r, side, confirmed.parent, s);
	if (!("whyNoSideCommit" in found)) return found;
	const passed = side.through.at(-1);
	return {
		...confirmed,
		whyNoSideCommit: `${passed ? `past ${short(passed)}: ` : ""}${found.whyNoSideCommit}`,
	};
}

/**
 * @param {string} merge
 * @param {string} why
 */
const endAtMerge = (merge, why) => ({
	whyNoSideCommit: `its first red commit ${short(merge)} is itself a merge ${why}`,
});

/**
 * The first commit on `side` red on `r.files`, red again on a second run, or
 * the run that finds it; else why the side holds none. Where that first red is
 * a merge, the search goes on down its other parent (#3936).
 * @param {Red} r
 * @param {Side} side
 * @param {string} bisectedParent the parent the culprit was bisected from
 * @param {Pick<Clearing, "redJobs" | "isGreen" | "sought">} s
 * @returns {Action | Culprit | {whyNoSideCommit: string}}
 */
function sideCulprit(r, side, bisectedParent, { redJobs, isGreen, sought }) {
	const search = { redJobs, sought: mergeSigned(r, side.merge, sought) };
	const tip = /** @type {string} */ (side.range.at(-1));
	const runs = [...Object.values(side.bisect), side.confirm];
	if (runs.some((v) => v?.kind === "unknown"))
		return { whyNoSideCommit: "a run on it reached no verdict" };
	/**
	 * @param {string} sha
	 * @param {RerunWhy} why
	 * @returns {Action}
	 */
	const rerun = (sha, why) => ({ kind: "rerun", sha, files: r.files, why });
	const tipRun = side.bisect[tip];
	if (!tipRun) return rerun(tip, "side");
	if (!isSearchedRed(tipRun, search))
		return { whyNoSideCommit: `its tip ${short(tip)} is not red` };
	const { base } = side;
	if (base !== null && base !== r.base && !isGreen(base)) {
		const baseRun = side.bisect[base];
		if (!baseRun) return rerun(base, "side");
		if (isSearchedRed(baseRun, search))
			return {
				whyNoSideCommit: `${short(base)}, which it starts from, is red too, so a red on it names no commit`,
			};
	}
	const step = bisectStep(side, search);
	if ("next" in step) return rerun(step.next, "side");
	if (side.merges.includes(step.culprit))
		return pastMerge(r, side, step, bisectedParent);
	if (!side.confirm) return rerun(step.culprit, "side-confirm");
	return isSearchedRed(side.confirm, search)
		? step
		: {
				whyNoSideCommit: `its first red commit ${short(step.culprit)} passed a second run`,
			};
}

/**
 * The read of the other parent of `merge`, a merge on the side the red was first
 * seen at; else why the search ends there. A revert tried is kept, its target
 * chosen already, so reads no further side.
 * @param {Red} r
 * @param {Side} side
 * @param {Culprit} merge
 * @param {string} bisectedParent the parent the culprit was bisected from
 * @returns {Action | {whyNoSideCommit: string}}
 */
function pastMerge(r, side, { culprit, parent }, bisectedParent) {
	if (side.through.length === SIDE_MERGES_SEARCHED)
		return endAtMerge(culprit, "where the search stops");
	if (r.revert) return endAtMerge(culprit, "found after that revert was tried");
	return {
		kind: "read-side",
		merge: culprit,
		parent: /** @type {string} */ (parent),
		bisectedParent,
	};
}

/**
 * @param {Red} r
 * @param {Extract<Action, {kind: "rerun"}>} action
 * @param {Verdict} verdict
 * @returns {Red}
 */
function recordRerun(r, action, verdict) {
	if (action.why === "side" || action.why === "side-confirm") {
		if (!r.side) throw new Error(`${action.why} rerun with no side read`);
		return {
			...r,
			side:
				action.why === "side"
					? { ...r.side, bisect: { ...r.side.bisect, [action.sha]: verdict } }
					: { ...r.side, confirm: verdict },
		};
	}
	if (action.why === "flake") return { ...r, flake: verdict };
	if (action.why === "base") return { ...r, onMain: verdict };
	if (action.why === "parent-files") return { ...r, parentOnFiles: verdict };
	const slot = action.why === "bisect" ? "bisect" : "confirm";
	return { ...r, [slot]: { ...r[slot], [action.sha]: verdict } };
}

/**
 * @param {string} sha
 * @param {string|null} base
 * @param {Extract<Verdict, {kind: "red"}>} verdict
 * @returns {Red}
 */
const redBatch = (sha, base, { files, jobs = [] }) => ({
	sha,
	base,
	files,
	jobs,
	flake: null,
	onMain: null,
	range: null,
	bisect: {},
	confirm: {},
	parentOnFiles: null,
	tipJobsOnMain: null,
	jobsOnMain: null,
	side: null,
	revert: null,
	unfiled: null,
	pushedPast: null,
});

/**
 * The batch `r`'s end hands on: its pushed-past tip's, where that tip's test
 * was red, started from that verdict rather than a second whole-suite run of
 * the tip (#3415). None once `r`'s revert landed, as `landing` moved to
 * the revert.
 * @param {Red} r
 * @param {string|null} main `main` as the next batch starts
 * @returns {Red|null}
 */
function buildHandedOnBatch({ pushedPast, revert }, main) {
	const verdict = pushedPast?.verdict;
	return pushedPast && verdict?.kind === "red" && !(revert && "sha" in revert)
		? redBatch(pushedPast.sha, main, verdict)
		: null;
}

/**
 * `r`'s side for a new run. Kept whole once a revert is made, as its target was
 * chosen on it and no rerun may change it. A heartbeat beaten before #3932
 * carried no merges and a range along `chain`, so one with no revert is read
 * again; one beaten before #3936 went through no merge.
 * @param {Red} r
 * @param {(runs: Record<string, Verdict>) => Record<string, Verdict>} reached
 * @returns {Side|null}
 */
function resumableSide({ side, revert }, reached) {
	if (!side) return null;
	const through = side.through ?? [];
	if (revert) return { ...side, merges: side.merges ?? [], through };
	if (!side.merges) return null;
	return {
		...side,
		through,
		bisect: reached(side.bisect),
		confirm: side.confirm?.kind === "unknown" ? null : side.confirm,
	};
}

/**
 * `r` with each run that reached no verdict dropped, so a run resuming it
 * reruns them rather than exiting on them again.
 * @param {Red} r
 * @returns {Red}
 */
function resumable(r) {
	/** @param {Record<string, Verdict>} runs */
	const reached = (runs) =>
		Object.fromEntries(
			Object.entries(runs).filter(([, v]) => v.kind !== "unknown"),
		);
	return {
		...r,
		/* A heartbeat beaten before #3253 carried no jobs. */
		jobs: r.jobs ?? [],
		/* Nor, before #3410, a pushed-past tip; one whose test was not red is
		 * tested again, as a no-verdict or a green off CI may not recur. */
		pushedPast:
			r.pushedPast && r.pushedPast.verdict?.kind !== "red"
				? { ...r.pushedPast, verdict: null }
				: (r.pushedPast ?? null),
		flake: r.flake?.kind === "unknown" ? null : r.flake,
		onMain: r.onMain?.kind === "unknown" ? null : (r.onMain ?? null),
		bisect: reached(r.bisect),
		confirm: reached(r.confirm),
		side: resumableSide(r, reached),
		/* Kept, as the bisect's verdicts were read against it; absent before
		 * #3586. */
		tipJobsOnMain: r.tipJobsOnMain ?? null,
		/* Read again, as `main`'s jobs may have run since. */
		jobsOnMain: null,
	};
}

/**
 * Whether a remote git call's failure is a network fault a retry can
 * outlast: git naming one, or the call timing out.
 * @param {unknown} err
 */
function isNetworkFault(err) {
	const e = caught(err);
	return e.code === "ETIMEDOUT" || NETWORK.test(e.stderr ?? "");
}

/**
 * The one action the lander takes next. A batch whose test was not red is
 * acted on before `landing` is read again, so commits pushed while it was
 * tested wait for the next batch rather than interrupting it; a red one is
 * put behind a tip pushed past it (#3486).
 * @param {LanderState} s
 * @returns {Action}
 */
function nextAction(s) {
	if (s.refused)
		return {
			kind: "hold",
			reason: `the push of ${short(s.refused.sha)} to main was refused: ${s.refused.reason}`,
		};
	if (s.red) return redAction(s.red, s);
	if (s.tested) {
		const { sha, verdict } = s.tested;
		if (isLandable(verdict, s.requiresRun))
			return { kind: "fast-forward", sha };
		return {
			kind: "exit",
			reason: `no verdict at ${short(sha)}: ${verdict.kind === "unknown" ? verdict.reason : "its green read no CI run"}`,
		};
	}
	if (s.landing === null)
		return { kind: "exit", reason: "the remote has no landing branch" };
	if (s.relation === "equal")
		return { kind: "exit", reason: "landing equals main" };
	if (s.relation === "behind")
		return { kind: "exit", reason: "landing is behind main" };
	if (s.relation === "diverged")
		return {
			kind: "exit",
			reason: `landing ${short(s.landing)} and main have diverged`,
		};
	if (s.isGreen(s.landing)) return { kind: "fast-forward", sha: s.landing };
	return { kind: "test", sha: s.landing };
}

/**
 * @typedef {object} LanderGit
 * @property {() => Refs & {relation: Relation}} refs the remote's two shas,
 *   each commit present locally, and where `landing` stands against `main`
 * @property {(sha: string) => void} pushMain a plain, non-forced push of
 *   `sha` to the remote's `main`
 * @property {(base: string|null, sha: string) => string[]} chain the commits
 *   after `base` up to `sha`, oldest first, along the parents that descend
 *   from `base`, so `main` at `base` can fast-forward to any of them: a
 *   reconcile merge's first parent is the session's side, which need not
 *   (#2996)
 * @property {(merge: string, parent: string, bisectedParent?: string) => SideRead|null}
 *   mergedSide where `merge` is a two-parent merge and `parent` one of its
 *   parents, the other's first-parent line `parent` and `bisectedParent` lack, oldest
 *   first, the commit it starts from and the merges on it; else null
 * @property {(culprit: string, parent: string|null, why: string) => Revert}
 *   revertOnLanding a revert of `culprit` against `parent`, committed on the
 *   remote's current `landing` tip and pushed there without force, `why`
 *   closing its message
 * @property {(tip: string, sha: string) => boolean} contains whether `sha`
 *   is `tip` or one of its ancestors
 * @typedef {{verdict: (sha: string, files?: string[], lands?: boolean) =>
 *   Promise<Verdict>, requiresRun?: boolean,
 *   readJobsOnMain?: (jobs: string[]) => Promise<JobsOnMain>}} Tester the
 *   whole suite at `sha`, or only `files` where they are given; `files`
 *   absent is a batch's own test, present (empty too) a rerun, `lands` where
 *   its green would move `main`. `requiresRun` where `main` takes only a sha
 *   a CI run passed, so only a green naming its `run` lands. `readJobsOnMain`
 *   where it reads CI runs, as only then does a red name jobs
 * @typedef {Omit<Extract<Action, {kind: "file-fix-ticket"}>, "kind">} FixTicket
 * @typedef {{batch: string|null, reason: string, failing: Failing|null,
 *   owed: FixTicket[]}} Held a hold, with its batch and what failed there,
 *   null where it held on a refused push and no red batch, and the fix tickets
 *   still owed
 * @typedef {{landing: string|null, reason: string, filed: string,
 *   owedCulprit?: string}} HoldNote the last hold a run filed: its tip as `heldTip`
 *   pins it, what the held-queue filing printed, and the culprit whose unfiled
 *   fix ticket is its cause
 * @typedef {{hold?: HoldNote, red?: Red, owed?: FixTicket[]}} BeatNote a
 *   heartbeat's hold, with the batch it hands the next run, or the red batch
 *   the run is clearing, and the fix tickets still owed
 * @typedef {object} LanderTracker
 * @property {(t: FixTicket) => string} fileFixTicket files the fix ticket,
 *   returning a line naming it
 * @property {(h: Held) => string} holdQueue files the held-queue issue, or
 *   refreshes the open one, returning a line naming it
 * @property {(sha: string, holds: (batch: string) => boolean) =>
 *   string|null} releaseQueue closes the open held-queue issue where `main`,
 *   moved to `sha`, holds its batch, returning a line naming it, else null
 * @typedef {object} Ledger
 * @property {(sha: string) => boolean} has
 * @property {(sha: string) => void} add
 * @typedef {object} LanderDeps
 * @property {LanderGit} git
 * @property {Tester} tester
 * @property {LanderTracker} tracker
 * @property {Ledger} ledger
 * @property {Ledger} noVerdict the parents whose whole suite reached no
 *   verdict
 * @property {{acquire: () => boolean, release: () => void}} lock
 * @property {(batch: string|null, note?: BeatNote, movedAt?: string|null) =>
 *   void} beat writes the heartbeat, with when this lander last moved `main`
 * @property {() => HoldNote|null} [lastHold]
 * @property {() => string|null} [lastMoved] when a lander last moved `main`,
 *   as the last run's final beat carried it
 * @property {() => Red|null} [lastRed] the red batch the last run's final
 *   beat carried
 * @property {() => FixTicket[]} [lastOwed] the fix tickets the last run's
 *   final beat still owed
 * @property {(ms: number) => Promise<void>} [wait] the backoff between
 *   tries of a remote call
 * @property {(action: Action) => void} [log]
 * @property {(line: string) => void} [say] reports what the fix-ticket and
 *   held-queue filers did
 * @property {() => void} [mainMoved] after each move of `main`: the guard
 *   code's adoption (lib/guard-code.js)
 */

/**
 * @typedef {Pick<LanderState, "tested" | "red" | "refused">} RunState what a
 *   run carries between actions
 * @typedef {Exclude<Action, {kind: "exit" | "hold"}>} Step
 */

/**
 * @param {LanderDeps} deps
 * @param {string} sha
 * @param {string[]} [files]
 * @param {boolean} [lands]
 */
async function verdictAt({ tester, beat }, sha, files, lands) {
	beat(sha);
	const timer = setInterval(() => beat(sha), HEARTBEAT_MS);
	try {
		return await tester.verdict(sha, files, lands);
	} finally {
		clearInterval(timer);
	}
}

/**
 * @param {LanderDeps} deps
 * @param {Step} action
 * @param {RunState} state
 * @param {string|null} main `main` when the action was chosen
 * @returns {Promise<RunState>}
 */
async function act(deps, action, state, main) {
	const { ledger } = deps;
	const { red } = state;
	if (action.kind === "fast-forward") {
		/* Ledgered first, so the pre-push check can tell this push from any
		 * other. Residual: a network fault that outlasts the retries leaves
		 * the sha ledgered, and the next run retries the push without a second
		 * test. */
		ledger.add(action.sha);
		const refusal = await pushRefusal(deps, action.sha);
		if (refusal !== null)
			return { ...state, refused: { sha: action.sha, reason: refusal } };
		deps.mainMoved?.();
		return {
			...state,
			tested: null,
			red:
				red && deps.git.contains(action.sha, red.sha)
					? buildHandedOnBatch(red, action.sha)
					: red,
		};
	}
	if (action.kind === "test") {
		const verdict = await verdictAt(deps, action.sha);
		/* While a red batch stands, nextAction hands it to redAction, whose one
		 * test is the tip `landing` was pushed past it to. */
		if (red)
			return {
				...state,
				red: { ...red, pushedPast: { sha: action.sha, verdict } },
			};
		return verdict.kind === "red"
			? { ...state, red: redBatch(action.sha, main, verdict) }
			: { ...state, tested: { sha: action.sha, verdict } };
	}
	if (red === null) throw new Error(`${action.kind} with no red batch`);
	return { ...state, red: await advanceRed(deps, action, red) };
}

/**
 * Git's line refusing the push of `sha` to `main`, or null where it landed.
 * Only a push git itself refused, a ruleset's, a pre-push hook's or a `main`
 * moved by hand, is one: pushed again, it is refused again (#3329). Any other
 * failure, a network fault the retries do not outlast or a timeout, throws.
 * @param {LanderDeps} deps
 * @param {string} sha
 * @returns {Promise<string|null>}
 */
async function pushRefusal(deps, sha) {
	try {
		await remote(deps, () => deps.git.pushMain(sha));
		return null;
	} catch (err) {
		const refusal = isNetworkFault(err)
			? null
			: GIT_REFUSAL.exec(String(caught(err).stderr ?? ""));
		if (!refusal) throw err;
		return refusal[0];
	}
}

/**
 * `r` with the side `action` reads as its search: the culprit's own, or, where
 * `bisectedParent` is given, the other parent of a merge on the side so far.
 * @param {LanderDeps} deps
 * @param {Extract<Action, {kind: "read-side"}>} action
 * @param {Red} r
 * @returns {Promise<Red>}
 */
async function readSide(deps, { merge, parent, bisectedParent }, r) {
	const read = await remote(deps, () =>
		deps.git.mergedSide(merge, parent, bisectedParent),
	);
	const outer = bisectedParent ? r.side : null;
	return {
		...r,
		side: {
			merge: outer ? outer.merge : merge,
			through: outer ? [...outer.through, merge] : [],
			...(read ?? NO_SIDE),
			bisect: {},
			confirm: null,
		},
	};
}

/**
 * `r` once `action`, one of the red path's own, has run; null once the fix
 * ticket is filed, or `r` naming why it was not, which holds.
 * @param {LanderDeps} deps
 * @param {Exclude<Step, {kind: "test" | "fast-forward"}>} action
 * @param {Red} r
 * @returns {Promise<Red|null>}
 */
async function advanceRed(deps, action, r) {
	const { git, tracker, noVerdict, say = () => undefined } = deps;
	if (action.kind === "rerun") {
		const verdict = await verdictAt(
			deps,
			action.sha,
			action.files,
			action.why === "flake" || action.why === "parent",
		);
		/* Ledgered, as a hold drops the red batch and the next push's bisect
		 * would name the same commit again. */
		if (
			(action.why === "parent" ||
				action.why === "confirm" ||
				action.why === "bisect") &&
			isWholeSuite(action.files) &&
			verdict.kind === "unknown"
		)
			noVerdict.add(action.sha);
		return recordRerun(r, action, verdict);
	}
	if (action.kind === "bisect")
		return {
			...r,
			range: await remote(deps, () => git.chain(action.base, action.sha)),
			/* The tip's rerun is the bisect's first red. */
			bisect: { [action.sha]: /** @type {Verdict} */ (r.flake) },
		};
	if (action.kind === "read-side") return readSide(deps, action, r);
	if (action.kind === "read-main-jobs")
		return {
			...r,
			[action.slot]: await readMainJobs(deps, action.jobs, action.since),
		};
	if (action.kind === "revert") {
		const unread =
			r.jobsOnMain?.kind === "unread"
				? ` Their state on \`main\` was unread: ${r.jobsOnMain.reason}.`
				: "";
		return {
			...r,
			revert: await remote(deps, () =>
				git.revertOnLanding(
					action.culprit,
					action.parent,
					`The lander found it red on ${failingLabel(action)}, twice, with its parent ${action.parent ? short(action.parent) : "(none)"} ${action.parentIsMain ? "at `main`" : "green"}.${unread}`,
				),
			),
		};
	}
	const { kind: _, ...ticket } = action;
	try {
		say(tracker.fileFixTicket(ticket));
		return null;
	} catch (err) {
		return { ...r, unfiled: caught(err).message };
	}
}

/**
 * `jobs` as `main` last ran them, unread where the tester reads no CI run or
 * a run that failed one predates `since`, which it then says nothing of.
 * @param {LanderDeps} deps
 * @param {string[]} jobs
 * @param {string} since
 * @returns {Promise<JobsOnMain>}
 */
async function readMainJobs({ tester, git }, jobs, since) {
	if (!tester.readJobsOnMain)
		return { kind: "unread", reason: "the tester reads no CI run" };
	const read = await tester.readJobsOnMain(jobs);
	const stale =
		read.kind === "read"
			? read.shas.find((sha) => !git.contains(sha, since))
			: undefined;
	return stale === undefined
		? read
		: {
				kind: "unread",
				reason: `the run at ${short(stale)} that failed them predates ${short(since)}`,
			};
}

/**
 * `call`'s result, retried with backoff while it fails on a network fault.
 * @template T
 * @param {LanderDeps} deps
 * @param {() => T} call
 * @returns {Promise<T>}
 */
async function remote({ wait = pause }, call) {
	for (let attempt = 1; ; attempt++) {
		try {
			return call();
		} catch (err) {
			if (attempt >= REMOTE_TRIES || !isNetworkFault(err)) throw err;
			await wait(
				REMOTE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random()),
			);
		}
	}
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One run: acts until it exits or holds on a tip `landing` has not moved past.
 * Any throw ends it as an exit naming the error (#2673), a broken invariant's
 * included. Every beat carries the
 * red batch, so a run that ends on one leaves it for the next to resume while
 * `landing` still descends from it, and the last run's hold until this one
 * has read the remote.
 * @param {LanderDeps} deps
 * @returns {Promise<End>}
 */
async function runLander(deps) {
	const {
		lock,
		log = () => undefined,
		lastHold = () => null,
		lastRed = () => null,
		lastOwed = () => [],
		lastMoved = () => null,
	} = deps;
	if (!lock.acquire()) {
		/** @type {End} */
		const held = { kind: "exit", reason: "another lander holds the lock" };
		log(held);
		return held;
	}
	/** @type {Carry} */
	const carry = {
		state: { tested: null, red: null, refused: null },
		held: lastHold(),
		unread: lastRed(),
		owed: lastOwed(),
		movedAt: lastMoved(),
	};
	/** @type {LanderDeps} */
	const run = {
		...deps,
		beat: (batch, note) =>
			deps.beat(
				batch,
				{
					...(note ?? carried(carry)),
					...(carry.owed.length > 0 ? { owed: carry.owed } : {}),
				},
				carry.movedAt,
			),
	};
	try {
		return await actUntilEnd(run, carry);
	} catch (err) {
		/** @type {End} */
		const end = {
			kind: "exit",
			reason: `stopped on an error: ${parseRefusal(parseErrorText(err))}`,
		};
		log(end);
		return end;
	} finally {
		lock.release();
	}
}

/**
 * @typedef {object} Carry
 * @property {RunState} state
 * @property {HoldNote|null} held the last run's hold, until the remote says
 *   whether its tip still stands
 * @property {Red|null} unread the last run's red batch, likewise
 * @property {FixTicket[]} owed the fix tickets that failed to file
 * @property {string|null} movedAt when a lander last moved `main`, which the
 *   stall check counts from (#2692)
 */

/**
 * What a beat carries where its caller names nothing: the red batch, or the
 * last run's hold or red batch while the remote is unread.
 * @param {Carry} carry
 * @returns {BeatNote|undefined}
 */
function carried({ state, held, unread }) {
	const red = state.red ?? unread;
	if (red) return { red };
	return held ? { hold: held } : undefined;
}

/**
 * @param {LanderDeps} run
 * @param {Carry} carry accumulator: the run's state, advanced by each action
 * @returns {Promise<End>}
 */
async function actUntilEnd(run, carry) {
	const { git, ledger, noVerdict, log = () => undefined } = run;
	const requiresRun = run.tester.requiresRun === true;
	const isGreen = (/** @type {string} */ sha) => ledger.has(sha);
	const isStuck = (/** @type {string} */ sha) => noVerdict.has(sha);
	await fileOwed(run, carry);
	for (;;) {
		run.beat(carry.state.red?.sha ?? carry.state.tested?.sha ?? null);
		const refs = await remote(run, () => git.refs());
		const prior = carry.held;
		/* A held tip is not tested again: the same batch holds again, and
		 * every session start would re-bisect it. A push moves the tip. */
		if (prior?.landing && refs.landing === prior.landing) {
			/** @type {End} */
			const end = {
				kind: "exit",
				reason: `landing ${short(prior.landing)} is held: ${prior.reason}`,
			};
			log(end);
			run.beat(null, { hold: prior });
			return end;
		}
		resume(git, carry, refs);
		markPushedPast(git, carry, refs.landing, requiresRun);
		const { state } = carry;
		const action = nextAction({
			...refs,
			isGreen,
			isStuck,
			requiresRun,
			...state,
		});
		log(action);
		if (action.kind === "exit") return action;
		if (action.kind === "hold") {
			if (!takeUpPastHold(run, carry, action, refs)) return action;
			continue;
		}
		carry.state = await act(run, action, state, refs.main);
		if (action.kind === "fast-forward") recordMove(run, carry, action.sha);
	}
}

/**
 * Notes a push of `sha` to `main` that was not refused, and closes the
 * held-queue issue unless it names a fix ticket still owed (#3777).
 * @param {LanderDeps} run
 * @param {Carry} carry accumulator: when `main` last moved
 * @param {string} sha
 */
function recordMove(run, carry, sha) {
	if (carry.state.refused) return;
	carry.movedAt = new Date().toISOString();
	if (carry.owed.length === 0) releaseQueue(run, sha);
}

/**
 * Tries each fix ticket a past run failed to file, once a run, as the filer
 * finds one already open (#3777). A filed ticket releases the hold it caused,
 * and the last one the held-queue issue that `main` has since passed.
 * Residual: a run starts only where `landing` is ahead of `main`, so once the
 * queue has drained the next try waits on the next push, and the filer does
 * not find a ticket filed and closed since, which it files again.
 * @param {LanderDeps} run
 * @param {Carry} carry accumulator: the tickets still owed and the last hold
 */
async function fileOwed(run, carry) {
	if (carry.owed.length === 0) return;
	const { git, tracker, say = () => undefined } = run;
	carry.owed = carry.owed.filter((t) => {
		try {
			say(tracker.fileFixTicket(t));
			return false;
		} catch (err) {
			/* Reported, not thrown: a broken filer must not stop the queue. */
			say(
				`fix ticket for ${short(t.culprit)} still owed: ${caught(err).message}`,
			);
			return true;
		}
	});
	const culprit = carry.held?.owedCulprit;
	if (culprit && !carry.owed.some((t) => t.culprit === culprit))
		carry.held = null;
	run.beat(null);
	if (carry.owed.length > 0) return;
	const { main } = await remote(run, () => git.refs());
	if (main !== null) releaseQueue(run, main);
}

/**
 * Owes the hold's fix ticket, files the hold, then, where `landing` has passed
 * it, sets the run on the batch it hands on; returns whether it did.
 * @param {LanderDeps} run
 * @param {Carry} carry accumulator: the run's state and the tickets still owed
 * @param {Extract<Action, {kind: "hold"}>} hold
 * @param {Refs} refs the remote when the hold was chosen
 */
function takeUpPastHold(run, carry, hold, refs) {
	const { state } = carry;
	const next = state.red && buildHandedOnBatch(state.red, refs.main);
	if (hold.ticket) carry.owed = [...carry.owed, hold.ticket];
	holdQueue(run, hold, carry, next);
	if (!isHoldPassed(run.git, state, refs.landing)) return false;
	carry.state = { tested: null, red: next, refused: null };
	return true;
}

/**
 * Closes the held-queue issue once `main` holds its batch (#3636). A failed
 * close reports rather than throws, as `main` has already moved; the next
 * move tries it again.
 * @param {LanderDeps} deps
 * @param {string} sha `main` once moved
 */
function releaseQueue({ tracker, git, say = () => undefined }, sha) {
	let line;
	try {
		line = tracker.releaseQueue(sha, (batch) => git.contains(sha, batch));
	} catch (err) {
		line = `held-queue issue not closed: ${caught(err).message}`;
	}
	if (line !== null) say(line);
}

/**
 * Settles what the last run left, once the remote is read: its hold is done
 * with, and its red batch taken up where it is still owed.
 * @param {LanderGit} git
 * @param {Carry} carry accumulator: the run's state
 * @param {Refs} refs
 */
function resume(git, carry, refs) {
	const red = carry.unread;
	carry.held = null;
	carry.unread = null;
	if (red && isStillOwed(git, red, refs))
		carry.state = { ...carry.state, red: resumable(red) };
}

/**
 * Puts the red batch, resumed or this run's own, behind a test of a
 * `landing` tip pushed past it since, which lands in its place where it
 * passes, so a run mid-bisect lands a fix pushed during it (#3486). Never
 * once the batch's culprit is reverted, as its fix ticket is still owed, nor
 * on a refused push, whose hold hands on the last pushed-past tip's red, nor
 * over a tip already landable.
 * @param {LanderGit} git
 * @param {Carry} carry accumulator: the run's state
 * @param {string|null} landing
 * @param {boolean} requiresRun
 */
function markPushedPast(git, carry, landing, requiresRun) {
	const { red: r, refused } = carry.state;
	if (
		r &&
		!refused &&
		r.revert === null &&
		r.pushedPast?.sha !== landing &&
		!isLandable(r.pushedPast?.verdict, requiresRun) &&
		/* A rewound `landing` holds no fix to the batch; its bisect goes on. */
		isPast(git, landing, r.sha)
	)
		carry.state = {
			...carry.state,
			red: { ...r, pushedPast: { sha: landing, verdict: null } },
		};
}

/**
 * Whether `landing` has moved on from `sha`, descending from it.
 * @param {LanderGit} git
 * @param {string|null} landing
 * @param {string} sha
 * @returns {landing is string}
 */
const isPast = (git, landing, sha) =>
	landing !== null && landing !== sha && git.contains(landing, sha);

/**
 * Whether a red batch a past run left is still this one's to clear: `landing`
 * descends from it and `main` does not, and its bisect range, where it has
 * one, steps from its base, so a parent it lands is one `main` can
 * fast-forward to (#2996).
 * @param {LanderGit} git
 * @param {Red} red
 * @param {Refs} refs
 */
function isStillOwed(git, red, { main, landing }) {
	const oldest = red.range?.[0];
	return (
		landing !== null &&
		git.contains(landing, red.sha) &&
		(main === null || !git.contains(main, red.sha)) &&
		(oldest === undefined ||
			red.base === null ||
			git.contains(oldest, red.base))
	);
}

/**
 * Files or refreshes the held-queue issue, then beats once more naming the
 * hold, so the stall check reads a held queue apart from a dead lander and
 * a later run leaves the held tip alone, taking up the batch its end hands on
 * instead.
 * @param {LanderDeps} deps
 * @param {Extract<Action, {kind: "hold"}>} hold
 * @param {Carry} carry its red batch, else its refused push, and the fix
 *   tickets still owed
 * @param {Red|null} next the batch the hold hands on
 */
function holdQueue(
	{ tracker, beat, say = () => undefined },
	hold,
	{ state: { red, refused }, owed },
	next,
) {
	/* A push refused while clearing a red batch, its culprit's parent's,
	 * pins the batch, so a push to `landing` releases it. */
	const batch = red?.sha ?? refused?.sha;
	if (batch === undefined)
		throw new Error("a hold with no red batch or refused push");
	let filed;
	try {
		filed = tracker.holdQueue({
			batch,
			reason: hold.reason,
			failing: red ? buildHeldFailing(red) : null,
			owed,
		});
	} catch (err) {
		/* The hold stands unfiled, named in the beat the stall check prints
		 * (#2406). */
		filed = `held-queue issue not filed: ${caught(err).message}`;
	}
	say(filed);
	beat(batch, {
		hold: {
			landing: red ? heldTip(red) : batch,
			reason: hold.reason,
			filed,
			...(hold.ticket ? { owedCulprit: hold.ticket.culprit } : {}),
		},
		...(next ? { red: next } : {}),
	});
}

/**
 * @param {Red} red
 * @returns {Failing}
 */
function buildHeldFailing({ files, jobs, flake }) {
	const failures = flake?.kind === "red" ? flake.failures : undefined;
	return { files, jobs, ...(failures?.length ? { failures } : {}) };
}

/**
 * Whether `landing` holds a tip past the one a hold pins, for the run to take
 * up (#3769). Never on a refused push, as the tip may be the sha refused
 * (#3329). An unfiled fix ticket does not stop it: the ticket stays owed in the
 * heartbeat and on the open held-queue issue, as a filer no push can mend would
 * otherwise stop the queue (#3777). Residual: a push made while the hold is
 * filed goes unread until a later run takes it up.
 * @param {LanderGit} git
 * @param {RunState} state
 * @param {string|null} landing
 */
function isHoldPassed(git, { red, refused }, landing) {
	if (!red || refused) return false;
	return isPast(git, landing, heldTip(red));
}

/**
 * The tip a hold pins: the red batch, or the lander's revert where it was
 * committed on that batch. Never `landing` as read at the hold, nor a revert
 * on a tip moved since: a commit pushed mid-run is still taken up, untested
 * or handed on red (#2477, #3415).
 * @param {Red} red
 */
function heldTip(red) {
	const r = red.revert;
	return r && "sha" in r && r.onto === red.sha ? r.sha : red.sha;
}

/**
 * @param {Action} a
 */
function buildActionLine(a) {
	switch (a.kind) {
		case "exit":
		case "hold":
			return `${a.kind} ${a.reason}`;
		case "rerun":
			return `rerun ${a.sha} (${a.why}): ${filesLabel(a.files)}`;
		case "bisect":
			return `bisect ${a.base ?? "(root)"}..${a.sha}`;
		case "read-side":
			return `read-side ${a.merge} (from ${a.parent})`;
		case "read-main-jobs":
			return `read-main-jobs ${failingLabel({ files: [], jobs: a.jobs })}`;
		case "revert":
			return `revert ${a.culprit} on landing`;
		case "file-fix-ticket":
			return `file-fix-ticket ${a.culprit}, reverted in ${a.revert}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

/**
 * @param {string} root the canonical checkout's root
 */
function landerFiles(root) {
	const dir = markersDir(root);
	return {
		ledger: path.join(dir, ".landing-green-ledger"),
		noVerdict: path.join(dir, ".landing-no-verdict-ledger"),
		pid: path.join(dir, ".lander.pid"),
		heartbeat: path.join(dir, ".lander-heartbeat.json"),
	};
}

/**
 * A file's text, or null where it cannot be read.
 * @param {string} file
 */
function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * @param {string} file
 * @returns {Ledger & {readShas: () => string[]}} with every sha it holds
 */
function fileLedger(file) {
	const readShas = () =>
		(readText(file) ?? "")
			.split("\n")
			.flatMap((line) => line.split(" ")[0] || []);
	return {
		readShas,
		has: (sha) => readShas().includes(sha),
		add: (sha) =>
			fs.appendFileSync(file, `${sha} ${new Date().toISOString()}\n`),
	};
}

/**
 * @typedef {{pid: number, at: string, batch: string|null, hold?: HoldNote,
 *   red?: Red, owed?: FixTicket[], movedAt?: string}} Heartbeat
 * @param {string} file
 * @returns {LanderDeps["beat"]}
 */
const heartbeatWriter = (file) => (batch, note, movedAt) =>
	writeFileAtomic(
		file,
		`${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), batch, ...note, ...(movedAt ? { movedAt } : {}) })}\n`,
	);

/**
 * The heartbeat, or null where it is absent or not a heartbeat; any other
 * read fault throws.
 * @param {string} file
 * @returns {Heartbeat|null}
 */
function readHeartbeat(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
	try {
		const beat = JSON.parse(text);
		return typeof beat?.pid === "number" && typeof beat.at === "string"
			? beat
			: null;
	} catch {
		/* Written whole by heartbeatWriter, so unparseable only by a hand
		 * edit, which no run wrote (#2406). */
		return null;
	}
}

/**
 * @typedef {LanderGit & {committedAt: (sha: string) => number}} RemoteGit
 *   with a local commit's committer time in ms
 */

/**
 * The lander's git, run in `root` against lib/landing-refs.js's remote. Both
 * branches are fetched, into their remote-tracking refs as a plain fetch
 * updates them, where either commit is not yet local, since the relation reads
 * both and a push names `landing` by sha.
 * @param {string} root
 * @param {number} [revertCommitTimeoutMs]
 * @returns {RemoteGit}
 */
function remoteGit(root, revertCommitTimeoutMs = REVERT_COMMIT_TIMEOUT_MS) {
	/**
	 * @param {string[]} args
	 * @param {number} [timeout]
	 * @param {NodeJS.ProcessEnv} [env]
	 * @param {{input?: string}} [stdin] where the command reads one
	 */
	const git = (
		args,
		timeout = LANDER_GIT_TIMEOUT_MS,
		env = process.env,
		{ input } = {},
	) =>
		execGit(args, {
			cwd: root,
			encoding: "utf8",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			timeout,
			env,
			input,
		});
	/**
	 * A push to the remote. Its timeout is the pre-push hook's run, which a
	 * retry would only repeat, so it throws as no network fault.
	 * @param {string} refspec
	 * @param {NodeJS.ProcessEnv} [env]
	 */
	const push = (refspec, env) => {
		try {
			git(["push", "--quiet", REMOTE, refspec], PUSH_TIMEOUT_MS, env);
		} catch (err) {
			if (caught(err).code !== "ETIMEDOUT") throw err;
			throw new Error(
				`git push ${refspec} timed out after ${PUSH_TIMEOUT_MS / 60_000} min`,
				{ cause: err },
			);
		}
	};
	/**
	 * Why a revert's push failed, or null where `landing` moved and the revert
	 * is made again on its new tip. A network fault throws, for runLander to
	 * retry the revert whole on the tip as it then stands.
	 * @param {unknown} err
	 * @param {number} attempt
	 * @returns {{failed: string} | null}
	 */
	const revertRefusal = (err, attempt) => {
		if (isNetworkFault(err)) throw err;
		const refused = String(caught(err).stderr ?? "");
		return MOVED.test(refused) && attempt < REVERT_PUSH_TRIES
			? null
			: { failed: parseRefusal(refused || caught(err).message) };
	};
	/**
	 * A revert of `culprit` already on `tip`, as a push that reached the
	 * remote before its connection dropped leaves one for the retry to find.
	 * @param {string} culprit
	 * @param {string} tip
	 * @returns {Revert|null}
	 */
	const readLandedRevert = (culprit, tip) => {
		const sha = git([
			"log",
			"-1",
			"--format=%H",
			"--fixed-strings",
			`--grep=${buildRevertLine(culprit)}`,
			`${culprit}..${tip}`,
		]).trim();
		if (!sha) return null;
		const onto = git(["rev-parse", `${sha}^`]).trim();
		return {
			sha,
			onto,
			stale:
				readRegistryRows(root, culprit, [onto, "--head", sha])?.exempted ??
				null,
		};
	};
	/** @param {string[]} args @returns {string[]} */
	const readLines = (args) => git(args).split("\n").filter(Boolean);
	/* A run asks the same pairs again on every poll, so a yes is kept for the
	 * run (#4326): no fetch can take it back. A no is asked again, since a
	 * deepened shallow clone can turn it to a yes. */
	/** @type {Set<string>} */
	const ancestors = new Set();
	/** @param {string} a @param {string} b */
	const isAncestor = (a, b) => {
		const key = `${a} ${b}`;
		if (ancestors.has(key)) return true;
		try {
			git(["merge-base", "--is-ancestor", a, b]);
		} catch {
			return false;
		}
		if (FULL_SHA.test(a) && FULL_SHA.test(b)) ancestors.add(key);
		return true;
	};
	/* A run never loses a local commit. */
	/** @type {Set<string>} */
	const localShas = new Set();
	/**
	 * An unanswered read is a no, so refs() fetches.
	 * @param {string[]} shas
	 */
	const areAllLocal = (shas) => {
		const unseen = shas.filter((sha) => !localShas.has(sha));
		if (unseen.length === 0) return true;
		let printed;
		try {
			printed = git(
				["cat-file", "--batch-check=%(objectname)"],
				LANDER_GIT_TIMEOUT_MS,
				process.env,
				{ input: unseen.map((sha) => `${sha}^{commit}\n`).join("") },
			);
		} catch {
			return false;
		}
		for (const line of printed.split("\n"))
			if (unseen.includes(line)) localShas.add(line);
		return unseen.every((sha) => localShas.has(sha));
	};
	/** @param {string|null} main @param {string} landing @returns {Relation} */
	const relationOf = (main, landing) => {
		if (main === landing) return "equal";
		if (main === null || isAncestor(main, landing)) return "ahead";
		return isAncestor(landing, main) ? "behind" : "diverged";
	};
	/**
	 * @param {string|null} base
	 * @param {string} sha
	 * @returns {string[]}
	 */
	function chain(base, sha) {
		/* With no `main`, every commit can land, so any parent will do. */
		if (base === null)
			return readLines(["rev-list", "--first-parent", "--reverse", sha]);
		const parentsOf = new Map(
			readLines([
				"rev-list",
				"--ancestry-path",
				"--parents",
				`${base}..${sha}`,
			]).map((line) => {
				const [commit, ...parents] = line.split(" ");
				if (commit === undefined)
					throw new Error(`rev-list printed no commit: ${line}`);
				return [commit, parents];
			}),
		);
		const commits = [];
		for (let at = sha; at !== base; ) {
			commits.push(at);
			const next = parentsOf
				.get(at)
				?.find((p) => p === base || parentsOf.has(p));
			if (next === undefined)
				throw new Error(`${short(at)} does not descend from ${short(base)}`);
			at = next;
		}
		return commits.reverse();
	}
	/** @param {string} commit @returns {string[]} */
	const readParents = (commit) =>
		git(["rev-list", "--parents", "-n", "1", commit])
			.trim()
			.split(" ")
			.slice(1);
	return {
		refs() {
			const listed = git([
				"ls-remote",
				REMOTE,
				`refs/heads/${VERIFIED_BRANCH}`,
				`refs/heads/${LANDING_BRANCH}`,
			]);
			/** @param {string} branch */
			const shaOf = (branch) =>
				listed
					.split("\n")
					.map((line) => line.split("\t"))
					.find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? null;
			const main = shaOf(VERIFIED_BRANCH);
			const landing = shaOf(LANDING_BRANCH);
			if (landing === null) return { main, landing, relation: "ahead" };
			if (!areAllLocal([main, landing].filter((sha) => sha !== null)))
				git([
					"fetch",
					"--quiet",
					REMOTE,
					trackingRefspec(VERIFIED_BRANCH),
					trackingRefspec(LANDING_BRANCH),
				]);
			return { main, landing, relation: relationOf(main, landing) };
		},
		pushMain(sha) {
			push(`${sha}:refs/heads/${VERIFIED_BRANCH}`);
		},
		contains: (tip, sha) => tip === sha || isAncestor(sha, tip),
		committedAt(sha) {
			const at = Number(git(["log", "-1", "--format=%ct", sha]).trim()) * 1000;
			if (!Number.isFinite(at) || at === 0)
				throw new Error(`git log printed no committer time for ${sha}`);
			return at;
		},
		chain,
		mergedSide(merge, parent, bisectedParent) {
			const parents = readParents(merge);
			const other = parents.find((p) => p !== parent);
			if (parents.length !== 2 || !parents.includes(parent) || !other)
				return null;
			/* Along first parents, not `chain`: a session's reconcile merges leave
			 * no descent from where its side forks to its own commits (#3932). */
			const sideLine = [
				"rev-list",
				"--first-parent",
				`${parent}..${other}`,
				...(bisectedParent ? [`^${bisectedParent}`] : []),
			];
			const range = readLines([...sideLine, "--reverse"]);
			const base = range[0] && readParents(range[0])[0];
			return base
				? { base, range, merges: readLines([...sideLine, "--merges"]) }
				: null;
		},
		revertOnLanding(culprit, parent, why) {
			/* A push refused because `landing` moved is retried on the new tip;
			 * any other refusal, a pre-push hook's among them, fails. */
			for (let attempt = 1; ; attempt++) {
				git(["fetch", "--quiet", REMOTE, trackingRefspec(LANDING_BRANCH)]);
				const tip = git(["rev-parse", "FETCH_HEAD"]).trim();
				const landed = readLandedRevert(culprit, tip);
				if (landed) return landed;
				const made = revertCommit(culprit, parent, tip, why);
				if ("failed" in made) return made;
				try {
					push(
						`${made.sha}:refs/heads/${LANDING_BRANCH}`,
						buildRevertEnv(culprit),
					);
					return { ...made, onto: tip };
				} catch (err) {
					const refused = revertRefusal(err, attempt);
					if (refused)
						return buildPushRefusal(
							root,
							{ culprit, tip, sha: made.sha },
							refused,
						);
				}
			}
		},
	};

	/**
	 * A revert of `culprit` on `tip`, made in a throwaway worktree, so the
	 * checkout's own tree and branch are never touched. `--no-verify` skips
	 * `pre-commit`, but `prepare-commit-msg` still runs the gate stack. The
	 * commit names the culprit in WFC_LANDER_REVERT, so the guard-registry
	 * gate lets the clean revert leave rows stale, which the fix ticket then
	 * names (#3127). Any other refusal holds the queue, naming the registry
	 * rows it refused on where it was that gate's (#3123). A conflict only in
	 * anchor files is settled by lib/clean-revert.js's rule (#3935); any other
	 * holds, naming the files.
	 * @param {string} culprit
	 * @param {string|null} parent
	 * @param {string} tip
	 * @param {string} why
	 * @returns {{sha: string, stale: RegistryRow[]|null} | {failed: string}}
	 */
	function revertCommit(culprit, parent, tip, why) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lander-revert-"));
		git(["worktree", "add", "--quiet", "--detach", dir, tip]);
		/** @param {string[]} args */
		const inTree = (args) =>
			execGit(args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: LANDER_GIT_TIMEOUT_MS,
			});
		try {
			const parents = readParents(culprit);
			/* A merge reverts against the parent the bisect stepped from. */
			const mainline = parents.indexOf(parent ?? "") + 1;
			if (parents.length > 1 && mainline === 0)
				return {
					failed: `${short(culprit)} is a merge, and ${parent ? short(parent) : "(none)"} is not one of its parents`,
				};
			const unreverted = stderrIfThrown(() =>
				inTree([
					"revert",
					"--no-commit",
					...(parents.length > 1 ? ["-m", String(mainline)] : []),
					culprit,
				]),
			);
			const settled = settleConflicts(inTree, unreverted, {
				dir,
				culprit,
				onto: tip,
				side: parents[Math.max(mainline - 1, 0)],
			});
			if ("failed" in settled) return settled;
			const subject = git(["log", "-1", "--format=%s", culprit]).trim();
			try {
				/* In a group of its own, so a kill at the timeout reaches the hooks, with
				 * a grace for their traps (#3923). */
				execGroupedSync(
					gitBinary(),
					["commit", "--quiet", "--no-verify", "-F", "-"],
					gitSpawnOptions({
						cwd: dir,
						input: `Revert "${subject}"\n\n${buildRevertLine(culprit)}\n\n${settled.note}${why}\n`,
						timeout: revertCommitTimeoutMs,
						env: buildRevertEnv(culprit),
					}),
				);
			} catch (err) {
				return {
					failed: buildCommitFailure(err, dir, culprit, revertCommitTimeoutMs),
				};
			}
			return {
				sha: inTree(["rev-parse", "HEAD"]).trim(),
				stale:
					readRegistryRows(dir, culprit, [tip, "--head", "HEAD"])?.exempted ??
					null,
			};
		} finally {
			/* Never replaces the return: a hook's child that left the commit's group
			 * outlives the kill and can still be writing in `dir`, and a throw here
			 * would lose the hold's reason (#3913). */
			const unremoved = stderrIfThrown(() =>
				git(["worktree", "remove", "--force", dir]),
			);
			if (unremoved !== null)
				writeFd(
					2,
					`lander: could not remove the revert's worktree ${dir}: ${parseRefusal(unremoved)}\n`,
				);
		}
	}
}

/**
 * The revert's anchor-file conflicts staged as lib/clean-revert.js settles them,
 * with the commit message's line saying so; else why the revert did not apply.
 * @param {(args: string[]) => string} inTree git in the revert's worktree
 * @param {string|null} stderr the revert's, null where it applied
 * @param {{dir: string, culprit: string, onto: string, side: string|undefined}} revert
 * @returns {{note: string} | {failed: string}}
 */
function settleConflicts(inTree, stderr, { dir, culprit, onto, side }) {
	if (stderr === null) return { note: "" };
	const conflicted = inTree(["diff", "--name-only", "--diff-filter=U"]);
	const kept =
		side === undefined
			? null
			: readKeptAnchors(
					dir,
					{ culprit, onto, side },
					conflicted.split("\n").filter(Boolean),
				);
	if (kept === null)
		return { failed: buildConflictFailure(stderr, conflicted) };
	for (const [file, bytes] of kept) {
		fs.writeFileSync(path.join(dir, file), bytes);
		inTree(["add", "--", file]);
	}
	/* Every hunk kept: a culprit that touched only those files reverts to nothing. */
	return inTree(["diff", "--cached", "--name-only"]).trim() === ""
		? { failed: buildConflictFailure(stderr, conflicted) }
		: {
				note: `Conflicts in ${[...kept.keys()].join(", ")} kept this branch's side where both sides moved, so their rows may read stale.\n\n`,
			};
}

/**
 * Why a revert did not apply, naming the files it conflicted in.
 * @param {string} stderr
 * @param {string} conflicted the conflicted paths, one a line
 */
function buildConflictFailure(stderr, conflicted) {
	const paths = conflicted.trim().replaceAll("\n", ", ");
	return `${parseFirstLine(stderr)}${paths ? ` (conflicts in ${paths})` : ""}`;
}

/**
 * Why a revert's commit failed. A commit killed at its timeout was refused by
 * no gate, so it names the last line printed.
 * @param {unknown} err
 * @param {string} dir
 * @param {string} culprit
 * @param {number} timeoutMs
 */
function buildCommitFailure(err, dir, culprit, timeoutMs) {
	const e = caught(err);
	if (e.code !== "ETIMEDOUT")
		return `its commit was refused: ${buildCommitRefusal(dir, culprit, readThrownText(err))}`;
	const last = String(e.stderr ?? "")
		.trim()
		.split("\n")
		.at(-1);
	return `its commit timed out after ${Math.round(timeoutMs / 1000)} s${last ? `, last printing: ${last}` : ""}`;
}

/**
 * Why a revert's commit was refused: each guard-registry row the gate refused
 * it on, with its fix-forward, read off the index still holding the revert;
 * else the gate's verdict line.
 * @param {string} dir
 * @param {string} culprit
 * @param {string} stderr the commit's
 */
function buildCommitRefusal(dir, culprit, stderr) {
	const refused = readRegistryRows(dir, culprit, ["HEAD"])?.refused ?? [];
	if (refused.length === 0)
		return GATE_VERDICT.exec(stderr)?.[0] ?? parseRefusal(stderr);
	return buildRowsLine(refused);
}

/**
 * A refused revert push, naming each guard-registry row the landing gate
 * refused it on where it was that gate's.
 * @param {string} root
 * @param {{culprit: string, tip: string, sha: string}} pushed the revert
 *   `sha` of `culprit`, pushed onto `tip`
 * @param {{failed: string}} refused
 * @returns {{failed: string}}
 */
function buildPushRefusal(root, { culprit, tip, sha }, refused) {
	const rows = readRegistryRows(root, culprit, [tip, "--head", sha])?.refused;
	return rows?.length
		? { failed: `its push was refused: ${buildRowsLine(rows)}` }
		: refused;
}

/** @param {RegistryRow[]} rows */
const buildRowsLine = (rows) =>
	rows.map((r) => `${r.row} (fix forward: ${r.forward})`).join("; ");

/**
 * The environment a revert of `culprit` is committed and pushed in.
 * @param {string} culprit
 */
const buildRevertEnv = (culprit) => ({
	...process.env,
	[LANDER_REVERT_ENV]: culprit,
});

/**
 * The guard-registry rows the gate refuses and exempts on a revert of
 * `culprit` in `dir`, judged `--against` the `against` arguments; null where
 * the gate cannot answer, which the fix ticket then says rather than reading
 * as no row owed (#3127).
 * @param {string} dir
 * @param {string} culprit
 * @param {string[]} against
 * @returns {{refused: RegistryRow[], exempted: RegistryRow[]}|null}
 */
function readRegistryRows(dir, culprit, against) {
	const r = spawnSync(
		process.execPath,
		[REGISTRY_CHECK, "--json", "--against", ...against],
		{
			cwd: dir,
			encoding: "utf8",
			env: buildRevertEnv(culprit),
			timeout: LANDER_GIT_TIMEOUT_MS,
		},
	);
	if (r.error || (r.status !== 0 && r.status !== 1)) return null;
	try {
		const { refused, exempted } = JSON.parse(r.stdout);
		return Array.isArray(refused) && Array.isArray(exempted)
			? { refused, exempted }
			: null;
	} catch {
		return null;
	}
}

module.exports = {
	LANDER_GIT_TIMEOUT_MS,
	HEARTBEAT_MS,
	buildRevertLine,
	failingList,
	short,
	buildActionLine,
	runLander,
	landerFiles,
	fileLedger,
	heartbeatWriter,
	readHeartbeat,
	remoteGit,
};
