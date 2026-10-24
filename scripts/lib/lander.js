/*
 * lander.js — the landing queue's lander (#2402, spec #2261): tests the tip of
 * the remote `landing` branch and fast-forwards `main` to it on a green
 * verdict at that exact sha. A red tip lands where its failing files pass on
 * one rerun; where they stay red, the lander bisects to the first red commit,
 * lands its parent once the culprit fails twice and the parent passes the
 * whole suite, reverts the culprit on `landing` and files its fix ticket, or
 * holds (#2404).
 *
 * Its green ledger (one `<sha> <iso time>` line per sha it lands),
 * pidfile and heartbeat sit under the canonical checkout's markers directory,
 * machine-local and gitignored, so a worktree's lander shares them with the
 * main tree's.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught, errorText } = require("./caught.js");
const { firstLine } = require("./first-line.js");
const { writeFileAtomic } = require("./atomic-write.js");
const {
	LANDING_BRANCH,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");

/* Untraced: a fraction of the stall check's 90 min, so a live lander is never
 * read as dead mid-suite. */
const HEARTBEAT_MS = 60 * 1000;
/* Untraced: room for a fetch over a slow link. */
const GIT_TIMEOUT_MS = 120 * 1000;
/* Untraced: the push runs the checkout's pre-push hook, whose mod tests run
 * `claude plugin test` on a batch touching a mod. */
const PUSH_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The line a revert's message names its culprit by: git's own, which
 * lib/landing-status.js searches `landing` for.
 * @param {string} sha
 */
const revertLine = (sha) => `This reverts commit ${sha}.`;
/* Untraced: a revert racing that many session pushes in a row is a busier
 * `landing` than any seen. */
const REVERT_PUSH_TRIES = 3;
/* git push's words for a refusal because the remote branch moved. */
const MOVED = /\[rejected\]|non-fast-forward|fetch first/;
/* Untraced: five tries over about a minute, outlasting a DNS or connection
 * blip (#2673); the backoff is exponential and randomised, as the Google SRE
 * book's "Addressing Cascading Failures" chapter sets for a retrying client. */
const REMOTE_TRIES = 5;
const REMOTE_BACKOFF_MS = 4 * 1000;
const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d/;

/**
 * @typedef {{kind: "green"} | {kind: "red", files: string[]}
 *   | {kind: "unknown", reason: string}} Verdict
 * @typedef {"flake" | "bisect" | "confirm"} RerunWhy
 * @typedef {{kind: "test", sha: string} | {kind: "fast-forward", sha: string}
 *   | {kind: "rerun", sha: string, files: string[], why: RerunWhy}
 *   | {kind: "bisect", base: string|null, sha: string}
 *   | {kind: "revert", culprit: string, parent: string|null, files: string[]}
 *   | {kind: "file-fix-ticket", culprit: string, parent: string|null,
 *       revert: string, files: string[]}
 *   | {kind: "hold", reason: string}
 *   | {kind: "exit", reason: string}} Action
 * @typedef {Extract<Action, {kind: "exit"}> | Extract<Action, {kind: "hold"}>}
 *   End
 * @typedef {object} Red a red batch while the lander clears it
 * @property {string} sha the batch's tip
 * @property {string|null} base `main` when the batch was tested
 * @property {string[]} files the failing files, every rerun's target; empty
 *   where the tester named none, which reruns the whole suite
 * @property {Verdict|null} flake the one rerun at the tip
 * @property {string[]|null} range the first-parent commits after `base` up to
 *   the tip, oldest first
 * @property {Record<string, Verdict>} bisect each bisected commit's verdict
 * @property {Record<string, Verdict>} confirm the culprit's second run and
 *   its parent's run, apart from the bisect's so they never move the culprit
 *   it named
 * @property {Revert|null} revert
 * @property {string|null} unfiled why the fix ticket was not filed
 * @typedef {{sha: string, onto: string} | {failed: string}} Revert the
 *   revert's sha and the `landing` tip it was committed on, or why it did not
 *   land: a conflict or a refused push
 * @typedef {object} LanderState
 * @property {string|null} main `main`'s sha on the remote
 * @property {string|null} landing `landing`'s sha on the REMOTE, null where
 *   the branch is absent
 * @property {Relation} relation where `landing` stands against `main`
 * @property {(sha: string) => boolean} isGreen whether the ledger holds `sha`
 * @property {{sha: string, verdict: Exclude<Verdict, {kind: "red"}>}|null}
 *   tested the batch this run took and the tester's verdict on it, a red
 *   one becoming `red`
 * @property {Red|null} red
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
 * The culprit the bisect has narrowed to, or the next commit to test: the
 * first red after the last green, `base` counting as green since `main` only
 * holds a sha the suite passed.
 * @param {Red & {range: string[]}} r
 * @returns {{culprit: string, parent: string|null} | {next: string}}
 */
function bisectStep(r) {
	let bad = r.range.length - 1;
	r.range.forEach((sha, i) => {
		if (r.bisect[sha]?.kind === "red" && i < bad) bad = i;
	});
	let good = -1;
	r.range.forEach((sha, i) => {
		if (r.bisect[sha]?.kind === "green" && i < bad) good = i;
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
 * The next action on a red batch: rerun the failing files at the tip, and
 * where they stay red, bisect to the first red commit, confirm it red twice
 * with its parent green, then land the parent, revert the culprit and file
 * its fix ticket. Anything short of that confirmation holds; a run with no
 * verdict exits.
 * @param {Red} r
 * @param {string|null} main
 * @returns {Action}
 */
function redAction(r, main) {
	const { files } = r;
	/** @type {[string, Verdict|null][]} */
	const runs = [
		[r.sha, r.flake],
		...Object.entries(r.bisect),
		...Object.entries(r.confirm),
	];
	for (const [sha, v] of runs)
		if (v?.kind === "unknown")
			return {
				kind: "exit",
				reason: `no verdict at ${short(sha)}: ${v.reason}`,
			};
	if (!r.flake) return { kind: "rerun", sha: r.sha, files, why: "flake" };
	/* Spec #2261's flake check. Residual: a flaky file outside `files` lands
	 * unseen, the whole suite having run once, red. */
	if (r.flake.kind === "green") return { kind: "fast-forward", sha: r.sha };
	if (!r.range) return { kind: "bisect", base: r.base, sha: r.sha };
	const step = bisectStep({ ...r, range: r.range });
	if ("next" in step)
		return { kind: "rerun", sha: step.next, files, why: "bisect" };
	return confirmAction(r, step) ?? culpritAction(r, step, main);
}

/**
 * The culprit's confirming runs, or null once it failed twice and its parent
 * passed.
 * @param {Red} r
 * @param {{culprit: string, parent: string|null}} bisected
 * @returns {Action|null}
 */
function confirmAction(r, { culprit, parent }) {
	const { files } = r;
	const again = r.confirm[culprit];
	if (!again) return { kind: "rerun", sha: culprit, files, why: "confirm" };
	if (again.kind === "green")
		return {
			kind: "hold",
			reason: `culprit unconfirmed: ${short(culprit)} passed ${filesLabel(files)} on its second run`,
		};
	if (parent === null) return null;
	/* The whole suite, as the parent lands on `main`, which only ever holds a
	 * sha the full suite passed. */
	const before = r.confirm[parent];
	if (!before) return { kind: "rerun", sha: parent, files: [], why: "confirm" };
	if (before.kind === "red")
		return {
			kind: "hold",
			reason: `culprit unconfirmed: ${short(culprit)}'s parent ${short(parent)} fails the whole suite: ${filesLabel(before.files)}`,
		};
	return null;
}

/**
 * What follows a confirmed culprit: land its parent where it is ahead of
 * `main`, revert it on `landing`, then file its fix ticket.
 * @param {Red} r
 * @param {{culprit: string, parent: string|null}} confirmed
 * @param {string|null} main
 * @returns {Action}
 */
function culpritAction(r, { culprit, parent }, main) {
	const { files } = r;
	if (parent !== null && parent !== main)
		return { kind: "fast-forward", sha: parent };
	if (!r.revert) return { kind: "revert", culprit, parent, files };
	if ("failed" in r.revert)
		return {
			kind: "hold",
			reason: `the revert of ${short(culprit)} did not land on landing: ${r.revert.failed}`,
		};
	if (r.unfiled !== null)
		return {
			kind: "hold",
			reason: `${short(culprit)} is reverted in ${short(r.revert.sha)}, but its fix ticket is not filed: ${r.unfiled}`,
		};
	return {
		kind: "file-fix-ticket",
		culprit,
		parent,
		revert: r.revert.sha,
		files,
	};
}

/**
 * @param {Red} r
 * @param {Extract<Action, {kind: "rerun"}>} action
 * @param {Verdict} verdict
 * @returns {Red}
 */
function recordRerun(r, action, verdict) {
	if (action.why === "flake") return { ...r, flake: verdict };
	const slot = action.why === "bisect" ? "bisect" : "confirm";
	return { ...r, [slot]: { ...r[slot], [action.sha]: verdict } };
}

/**
 * @param {string} sha
 * @param {string|null} base
 * @param {string[]} files
 * @returns {Red}
 */
const redBatch = (sha, base, files) => ({
	sha,
	base,
	files,
	flake: null,
	range: null,
	bisect: {},
	confirm: {},
	revert: null,
	unfiled: null,
});

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
		flake: r.flake?.kind === "unknown" ? null : r.flake,
		bisect: reached(r.bisect),
		confirm: reached(r.confirm),
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
 * The one action the lander takes next. A batch already tested is acted on
 * before `landing` is read again, so commits pushed while it was tested wait
 * for the next batch rather than interrupting it.
 * @param {LanderState} s
 * @returns {Action}
 */
function nextAction(s) {
	if (s.red) return redAction(s.red, s.main);
	if (s.tested) {
		const { sha, verdict } = s.tested;
		if (verdict.kind === "green") return { kind: "fast-forward", sha };
		return {
			kind: "exit",
			reason: `no verdict at ${short(sha)}: ${verdict.reason}`,
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
 * @property {(base: string|null, sha: string) => string[]} firstParents the
 *   first-parent commits after `base` up to `sha`, oldest first
 * @property {(culprit: string, why: string) => Revert} revertOnLanding a
 *   revert of `culprit` committed on the remote's current `landing` tip and
 *   pushed there without force, `why` closing its message
 * @property {(tip: string, sha: string) => boolean} contains whether `sha`
 *   is `tip` or one of its ancestors
 * @typedef {{verdict: (sha: string, files?: string[]) => Promise<Verdict>}}
 *   Tester the whole suite at `sha`, or only `files` where they are given
 * @typedef {Omit<Extract<Action, {kind: "file-fix-ticket"}>, "kind">} FixTicket
 * @typedef {{batch: string|null, reason: string, files: string[]}} Held a
 *   hold, with the batch and failing files of the red batch it held on
 * @typedef {{landing: string|null, reason: string, filed: string}} HoldNote
 *   the hold a run ended on: its tip as `heldTip` pins it, and what the
 *   held-queue filing printed
 * @typedef {{hold: HoldNote} | {red: Red}} BeatNote a heartbeat's hold, or
 *   the red batch the run is clearing
 * @typedef {object} LanderTracker
 * @property {(t: FixTicket) => string} fileFixTicket files the fix ticket,
 *   returning a line naming it
 * @property {(h: Held) => string} holdQueue files the held-queue issue, or
 *   refreshes the open one, returning a line naming it
 * @typedef {object} Ledger
 * @property {(sha: string) => boolean} has
 * @property {(sha: string) => void} add
 * @typedef {object} LanderDeps
 * @property {LanderGit} git
 * @property {Tester} tester
 * @property {LanderTracker} tracker
 * @property {Ledger} ledger
 * @property {{acquire: () => boolean, release: () => void}} lock
 * @property {(batch: string|null, note?: BeatNote) => void} beat writes the
 *   heartbeat
 * @property {() => HoldNote|null} [lastHold]
 * @property {() => Red|null} [lastRed] the red batch the last run's final
 *   beat carried
 * @property {(ms: number) => Promise<void>} [wait] the backoff between
 *   tries of a remote call
 * @property {(action: Action) => void} [log]
 * @property {(line: string) => void} [say] reports what the fix-ticket and
 *   held-queue filers did
 */

/**
 * @typedef {Pick<LanderState, "tested" | "red">} RunState what a run carries
 *   between actions
 * @typedef {Exclude<Action, {kind: "exit" | "hold"}>} Step
 */

/**
 * @param {LanderDeps} deps
 * @param {string} sha
 * @param {string[]} [files]
 */
async function verdictAt({ tester, beat }, sha, files) {
	beat(sha);
	const timer = setInterval(() => beat(sha), HEARTBEAT_MS);
	try {
		return await tester.verdict(sha, files);
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
async function act(deps, action, { tested, red }, main) {
	const { git, ledger } = deps;
	if (action.kind === "fast-forward") {
		/* Ledgered first, so the pre-push check can tell this push from any
		 * other. Residual: a push that then fails leaves the sha ledgered, and
		 * the next run retries the push without a second test. A culprit's
		 * parent is ledgered on its failing files' run alone, as spec #2261
		 * lands it. */
		ledger.add(action.sha);
		await remote(deps, () => git.pushMain(action.sha));
		return { tested: null, red: red?.sha === action.sha ? null : red };
	}
	if (action.kind === "test") {
		const verdict = await verdictAt(deps, action.sha);
		return verdict.kind === "red"
			? { tested, red: redBatch(action.sha, main, verdict.files) }
			: { tested: { sha: action.sha, verdict }, red };
	}
	if (red === null) throw new Error(`${action.kind} with no red batch`);
	return { tested, red: await advanceRed(deps, action, red) };
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
	const { git, tracker, say = () => undefined } = deps;
	if (action.kind === "rerun")
		return recordRerun(
			r,
			action,
			await verdictAt(deps, action.sha, action.files),
		);
	if (action.kind === "bisect")
		return {
			...r,
			range: await remote(deps, () =>
				git.firstParents(action.base, action.sha),
			),
			/* The tip's rerun is the bisect's first red. */
			bisect: { [action.sha]: /** @type {Verdict} */ (r.flake) },
		};
	if (action.kind === "revert")
		return {
			...r,
			revert: await remote(deps, () =>
				git.revertOnLanding(
					action.culprit,
					`The lander found it red on ${filesLabel(action.files)}, twice, with its parent ${action.parent ? short(action.parent) : "(none)"} green.`,
				),
			),
		};
	const { kind: _, ...ticket } = action;
	try {
		say(tracker.fileFixTicket(ticket));
		return null;
	} catch (err) {
		return { ...r, unfiled: caught(err).message };
	}
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
 * One run: acts until it exits or holds. Any throw ends it as an exit naming
 * the error (#2673), a broken invariant's included. Every beat carries the
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
	} = deps;
	if (!lock.acquire()) {
		/** @type {End} */
		const held = { kind: "exit", reason: "another lander holds the lock" };
		log(held);
		return held;
	}
	/** @type {Carry} */
	const carry = {
		state: { tested: null, red: null },
		held: lastHold(),
		unread: lastRed(),
	};
	/** @type {LanderDeps} */
	const run = {
		...deps,
		beat: (batch, note) => deps.beat(batch, note ?? carried(carry)),
	};
	try {
		return await actUntilEnd(run, carry);
	} catch (err) {
		/** @type {End} */
		const end = {
			kind: "exit",
			reason: `stopped on an error: ${firstLine(errorText(err))}`,
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
	const { git, ledger, log = () => undefined } = run;
	const isGreen = (/** @type {string} */ sha) => ledger.has(sha);
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
		const { state } = carry;
		const action = nextAction({ ...refs, isGreen, ...state });
		log(action);
		if (action.kind === "hold") {
			if (!state.red) throw new Error("a hold with no red batch");
			holdQueue(run, action, state.red);
		}
		if (action.kind === "exit" || action.kind === "hold") return action;
		carry.state = await act(run, action, state, refs.main);
	}
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
 * Whether a red batch a past run left is still this one's to clear: `landing`
 * descends from it and `main` does not.
 * @param {LanderGit} git
 * @param {Red} red
 * @param {Refs} refs
 */
function isStillOwed(git, red, { main, landing }) {
	return (
		landing !== null &&
		git.contains(landing, red.sha) &&
		(main === null || !git.contains(main, red.sha))
	);
}

/**
 * Files or refreshes the held-queue issue, then beats once more naming the
 * hold, so the stall check reads a held queue apart from a dead lander and
 * the next run leaves the held tip alone.
 * @param {LanderDeps} deps
 * @param {Extract<Action, {kind: "hold"}>} hold
 * @param {Red} red
 */
function holdQueue({ tracker, beat, say = () => undefined }, hold, red) {
	const batch = red.sha;
	let filed;
	try {
		filed = tracker.holdQueue({ batch, reason: hold.reason, files: red.files });
	} catch (err) {
		/* The hold stands unfiled, named in the beat the stall check prints
		 * (#2406). */
		filed = `held-queue issue not filed: ${caught(err).message}`;
	}
	say(filed);
	beat(batch, {
		hold: { landing: heldTip(red), reason: hold.reason, filed },
	});
}

/**
 * The tip a hold pins: the red batch, or the lander's revert where it was
 * committed on that batch. Never `landing` as read at the hold, nor a revert
 * on a tip moved since: a commit pushed mid-run is untested and must reach
 * the next run (#2477).
 * @param {Red} red
 */
function heldTip(red) {
	const r = red.revert;
	return r && "sha" in r && r.onto === red.sha ? r.sha : red.sha;
}

/**
 * @param {Action} a
 */
function actionLine(a) {
	switch (a.kind) {
		case "exit":
		case "hold":
			return `${a.kind} ${a.reason}`;
		case "rerun":
			return `rerun ${a.sha} (${a.why}): ${filesLabel(a.files)}`;
		case "bisect":
			return `bisect ${a.base ?? "(root)"}..${a.sha}`;
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
 * @returns {Ledger}
 */
function fileLedger(file) {
	return {
		has: (sha) =>
			(readText(file) ?? "")
				.split("\n")
				.some((line) => line.split(" ")[0] === sha),
		add: (sha) =>
			fs.appendFileSync(file, `${sha} ${new Date().toISOString()}\n`),
	};
}

/**
 * @typedef {{pid: number, at: string, batch: string|null, hold?: HoldNote,
 *   red?: Red}} Heartbeat
 * @param {string} file
 * @returns {LanderDeps["beat"]}
 */
const heartbeatWriter = (file) => (batch, note) =>
	writeFileAtomic(
		file,
		`${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), batch, ...note })}\n`,
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
 * The lander's git, run in `root` against lib/landing-refs.js's remote. Both
 * branches are fetched, into their remote-tracking refs as a plain fetch
 * updates them, where either commit is not yet local, since the relation reads
 * both and a push names `landing` by sha.
 * @param {string} root
 * @returns {LanderGit}
 */
function remoteGit(root) {
	/** @param {string[]} args @param {number} [timeout] */
	const git = (args, timeout = GIT_TIMEOUT_MS) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
		});
	/** @param {string[]} args */
	const succeeds = (args) => {
		try {
			git(args);
			return true;
		} catch {
			return false;
		}
	};
	/**
	 * A push to the remote. Its timeout is the pre-push hook's run, which a
	 * retry would only repeat, so it throws as no network fault.
	 * @param {string} refspec
	 */
	const push = (refspec) => {
		try {
			git(["push", "--quiet", REMOTE, refspec], PUSH_TIMEOUT_MS);
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
			: { failed: firstLine(refused || caught(err).message) };
	};
	/**
	 * A revert of `culprit` already on `tip`, as a push that reached the
	 * remote before its connection dropped leaves one for the retry to find.
	 * @param {string} culprit
	 * @param {string} tip
	 * @returns {Revert|null}
	 */
	const landedRevert = (culprit, tip) => {
		const sha = git([
			"log",
			"-1",
			"--format=%H",
			"--fixed-strings",
			`--grep=${revertLine(culprit)}`,
			`${culprit}..${tip}`,
		]).trim();
		return sha ? { sha, onto: git(["rev-parse", `${sha}^`]).trim() } : null;
	};
	/** @param {string} a @param {string} b */
	const isAncestor = (a, b) => succeeds(["merge-base", "--is-ancestor", a, b]);
	/** @param {string|null} main @param {string} landing @returns {Relation} */
	const relationOf = (main, landing) => {
		if (main === landing) return "equal";
		if (main === null || isAncestor(main, landing)) return "ahead";
		return isAncestor(landing, main) ? "behind" : "diverged";
	};
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
			if (
				[main, landing].some(
					(sha) =>
						sha !== null && !succeeds(["cat-file", "-e", `${sha}^{commit}`]),
				)
			)
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
		firstParents(base, sha) {
			return git([
				"rev-list",
				"--first-parent",
				"--reverse",
				...(base === null ? [sha] : [`${base}..${sha}`]),
			])
				.split("\n")
				.filter(Boolean);
		},
		revertOnLanding(culprit, why) {
			/* A push refused because `landing` moved is retried on the new tip;
			 * any other refusal, a pre-push hook's among them, fails. */
			for (let attempt = 1; ; attempt++) {
				git(["fetch", "--quiet", REMOTE, trackingRefspec(LANDING_BRANCH)]);
				const tip = git(["rev-parse", "FETCH_HEAD"]).trim();
				const landed = landedRevert(culprit, tip);
				if (landed) return landed;
				const made = revertCommit(culprit, tip, why);
				if ("failed" in made) return made;
				try {
					push(`${made.sha}:refs/heads/${LANDING_BRANCH}`);
					return { ...made, onto: tip };
				} catch (err) {
					const refused = revertRefusal(err, attempt);
					if (refused) return refused;
				}
			}
		},
	};

	/**
	 * A revert of `culprit` on `tip`, made in a throwaway worktree, so the
	 * checkout's own tree and branch are never touched. `--no-verify`: the
	 * commit hooks gate a session's own commits, and this undoes one they
	 * passed.
	 * @param {string} culprit
	 * @param {string} tip
	 * @param {string} why
	 * @returns {{sha: string} | {failed: string}}
	 */
	function revertCommit(culprit, tip, why) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lander-revert-"));
		git(["worktree", "add", "--quiet", "--detach", dir, tip]);
		/** @param {string[]} args @param {string} [input] */
		const inTree = (args, input) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				input,
				stdio: ["pipe", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			});
		try {
			const parents = git(["rev-list", "--parents", "-n", "1", culprit])
				.trim()
				.split(" ");
			const mainline = parents.length > 2 ? ["-m", "1"] : [];
			try {
				inTree(["revert", "--no-commit", ...mainline, culprit]);
			} catch (err) {
				const e = caught(err);
				return { failed: firstLine(String(e.stderr || e.message)) };
			}
			const subject = git(["log", "-1", "--format=%s", culprit]).trim();
			inTree(
				["commit", "--quiet", "--no-verify", "-F", "-"],
				`Revert "${subject}"\n\n${revertLine(culprit)}\n\n${why}\n`,
			);
			return { sha: inTree(["rev-parse", "HEAD"]).trim() };
		} finally {
			git(["worktree", "remove", "--force", dir]);
		}
	}
}

module.exports = {
	GIT_TIMEOUT_MS,
	HEARTBEAT_MS,
	revertLine,
	short,
	actionLine,
	runLander,
	landerFiles,
	fileLedger,
	heartbeatWriter,
	readHeartbeat,
	remoteGit,
};
