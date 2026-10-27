/*
 * lander.js — the landing queue's lander (#2402, spec #2261): tests the tip of
 * the remote `landing` branch and fast-forwards `main` to it on a green
 * verdict at that exact sha. A red tip lands where its failing files pass on
 * one rerun; where they stay red, the lander bisects to the first red commit,
 * lands its parent once the culprit fails twice and the parent passes the
 * whole suite, reverts the culprit on `landing` and files its fix ticket, or
 * holds (#2404). A parent whose whole suite reaches no verdict is confirmed
 * on the culprit's failing files instead and stays off `main` (#2910).
 *
 * Its green ledger (one `<sha> <iso time>` line per sha it lands), its
 * no-verdict ledger (the same line per parent whose whole suite reached no
 * verdict, never run whole again), pidfile and heartbeat sit under the canonical checkout's markers directory,
 * machine-local and gitignored, so a worktree's lander shares them with the
 * main tree's.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught, parseErrorText } = require("./caught.js");
const { parseFirstLine } = require("./first-line.js");
const { writeFileAtomic } = require("./atomic-write.js");
const {
	LANDING_BRANCH,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { execGit } = require("./git.js");
const { LANDER_REVERT_ENV, buildRevertLine } = require("./clean-revert.js");

/* Untraced: a fraction of the stall check's 2 h, so a live lander is never
 * read as dead mid-suite. */
const HEARTBEAT_MS = 60 * 1000;
/* Untraced: room for a fetch over a slow link. */
const LANDER_GIT_TIMEOUT_MS = 120 * 1000;
/* Untraced: the push runs the checkout's pre-push hook, whose mod tests run
 * `claude plugin test` on a batch touching a mod. */
const PUSH_TIMEOUT_MS = 20 * 60 * 1000;
const REGISTRY_CHECK = path.join(__dirname, "..", "check-guard-registry.js");

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
 * What `call` printed to stderr where it threw, else null.
 * @param {() => unknown} call
 * @returns {string|null}
 */
function stderrIfThrown(call) {
	try {
		call();
		return null;
	} catch (err) {
		const e = caught(err);
		return String(e.stderr || e.message);
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
 * @typedef {{kind: "green"} | {kind: "red", files: string[], jobs?: string[]}
 *   | {kind: "unknown", reason: string}} Verdict `jobs` the failing CI jobs,
 *   where the tester read a CI run
 * @typedef {"flake" | "bisect" | "confirm" | "parent" | "parent-files"}
 *   RerunWhy
 * @typedef {{kind: "test", sha: string} | {kind: "fast-forward", sha: string}
 *   | {kind: "rerun", sha: string, files: string[], why: RerunWhy}
 *   | {kind: "bisect", base: string|null, sha: string}
 *   | {kind: "revert", culprit: string, parent: string|null, files: string[]}
 *   | {kind: "file-fix-ticket", culprit: string, parent: string|null,
 *       revert: string, files: string[], stale: RegistryRow[]|null}
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
 * @property {string[]|null} range the commits after `base` up to the tip,
 *   oldest first
 * @property {Record<string, Verdict>} bisect each bisected commit's verdict
 * @property {Record<string, Verdict>} confirm the culprit's second run and
 *   its parent's whole-suite run, apart from the bisect's so they never move
 *   the culprit it named
 * @property {Verdict|null} parentOnFiles the parent's run on `files`, taken
 *   only where its whole suite reached no verdict
 * @property {Revert|null} revert
 * @property {string|null} unfiled why the fix ticket was not filed
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
 * @param {Pick<LanderState, "main" | "isStuck">} s
 * @returns {Action}
 */
function redAction(r, { main, isStuck }) {
	const { files } = r;
	/** @type {[string, Verdict|null][]} */
	const runs = [[r.sha, r.flake], ...Object.entries(r.bisect)];
	for (const [sha, v] of runs)
		if (v?.kind === "unknown") return buildNoVerdictExit(sha, v);
	if (!r.flake) return { kind: "rerun", sha: r.sha, files, why: "flake" };
	/* Spec #2261's flake check. Residual: a flaky file outside `files` lands
	 * unseen, the whole suite having run once, red. */
	if (r.flake.kind === "green") return { kind: "fast-forward", sha: r.sha };
	if (!r.range) return { kind: "bisect", base: r.base, sha: r.sha };
	const step = bisectStep({ ...r, range: r.range });
	if ("next" in step)
		return { kind: "rerun", sha: step.next, files, why: "bisect" };
	return confirmAction(r, step, isStuck) ?? culpritAction(r, step, main);
}

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
 * alone, once: rerunning the whole suite would end the same way on every
 * start.
 * @param {Red} r
 * @param {{culprit: string, parent: string|null}} bisected
 * @param {(sha: string) => boolean} isStuck
 * @returns {Action|null}
 */
function confirmAction(r, { culprit, parent }, isStuck) {
	const { files } = r;
	const again = r.confirm[culprit];
	if (!again) return { kind: "rerun", sha: culprit, files, why: "confirm" };
	if (again.kind === "unknown") return buildNoVerdictExit(culprit, again);
	if (again.kind === "green")
		return {
			kind: "hold",
			reason: `culprit unconfirmed: ${short(culprit)} passed ${filesLabel(files)} on its second run`,
		};
	if (parent === null) return null;
	/* The whole suite, as the parent lands on `main`, which only ever holds a
	 * sha the full suite passed. */
	const before = r.confirm[parent];
	if (!before && !isStuck(parent))
		return { kind: "rerun", sha: parent, files: [], why: "parent" };
	if (before?.kind === "red")
		return {
			kind: "hold",
			reason: parentUnconfirmed(
				culprit,
				parent,
				`fails the whole suite: ${filesLabel(before.files)}`,
			),
		};
	if (before?.kind === "green") return null;
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
	if (onFiles.kind === "red")
		return {
			kind: "hold",
			reason: parentUnconfirmed(
				culprit,
				parent,
				`fails ${filesLabel(onFiles.files)}`,
			),
		};
	return null;
}

/**
 * @param {string} culprit
 * @param {string} parent
 * @param {string} why
 */
const parentUnconfirmed = (culprit, parent, why) =>
	`culprit unconfirmed: ${short(culprit)}'s parent ${short(parent)} ${why}`;

/**
 * What follows a confirmed culprit: land its parent where it is ahead of
 * `main` and passed the whole suite, revert it on `landing`, then file its
 * fix ticket.
 * @param {Red} r
 * @param {{culprit: string, parent: string|null}} confirmed
 * @param {string|null} main
 * @returns {Action}
 */
function culpritAction(r, { culprit, parent }, main) {
	const { files } = r;
	if (parent !== null && parent !== main && r.confirm[parent]?.kind === "green")
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
		stale: r.revert.stale ?? null,
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
	if (action.why === "parent-files") return { ...r, parentOnFiles: verdict };
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
	parentOnFiles: null,
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
	if (s.red) return redAction(s.red, s);
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
 * @property {(base: string|null, sha: string) => string[]} chain the commits
 *   after `base` up to `sha`, oldest first, along the parents that descend
 *   from `base`, so `main` at `base` can fast-forward to any of them: a
 *   reconcile merge's first parent is the session's side, which need not
 *   (#2996)
 * @property {(culprit: string, parent: string|null, why: string) => Revert}
 *   revertOnLanding a revert of `culprit` against `parent`, committed on the
 *   remote's current `landing` tip and pushed there without force, `why`
 *   closing its message
 * @property {(tip: string, sha: string) => boolean} contains whether `sha`
 *   is `tip` or one of its ancestors
 * @typedef {{verdict: (sha: string, files?: string[]) => Promise<Verdict>}}
 *   Tester the whole suite at `sha`, or only `files` where they are given;
 *   `files` absent is a batch's own test, present (empty too) a rerun
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
		 * the next run retries the push without a second test. */
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
	const { git, tracker, noVerdict, say = () => undefined } = deps;
	if (action.kind === "rerun") {
		const verdict = await verdictAt(deps, action.sha, action.files);
		/* Ledgered, as a hold drops the red batch and the next push's bisect
		 * would name the same parent again. */
		if (action.why === "parent" && verdict.kind === "unknown")
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
	if (action.kind === "revert")
		return {
			...r,
			revert: await remote(deps, () =>
				git.revertOnLanding(
					action.culprit,
					action.parent,
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
		state: { tested: null, red: null },
		held: lastHold(),
		unread: lastRed(),
		movedAt: lastMoved(),
	};
	/** @type {LanderDeps} */
	const run = {
		...deps,
		beat: (batch, note) =>
			deps.beat(batch, note ?? carried(carry), carry.movedAt),
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
	const isGreen = (/** @type {string} */ sha) => ledger.has(sha);
	const isStuck = (/** @type {string} */ sha) => noVerdict.has(sha);
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
		const action = nextAction({ ...refs, isGreen, isStuck, ...state });
		log(action);
		if (action.kind === "hold") {
			if (!state.red) throw new Error("a hold with no red batch");
			holdQueue(run, action, state.red);
		}
		if (action.kind === "exit" || action.kind === "hold") return action;
		carry.state = await act(run, action, state, refs.main);
		/* act throws where the push fails, so this is a move of `main`. */
		if (action.kind === "fast-forward")
			carry.movedAt = new Date().toISOString();
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
function buildActionLine(a) {
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
 *   red?: Red, movedAt?: string}} Heartbeat
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
 * @returns {RemoteGit}
 */
function remoteGit(root) {
	/**
	 * @param {string[]} args
	 * @param {number} [timeout]
	 * @param {NodeJS.ProcessEnv} [env]
	 */
	const git = (args, timeout = LANDER_GIT_TIMEOUT_MS, env = process.env) =>
		execGit(args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
			env,
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
		committedAt(sha) {
			const at = Number(git(["log", "-1", "--format=%ct", sha]).trim()) * 1000;
			if (!Number.isFinite(at) || at === 0)
				throw new Error(`git log printed no committer time for ${sha}`);
			return at;
		},
		chain(base, sha) {
			/* With no `main`, every commit can land, so any parent will do. */
			if (base === null)
				return git(["rev-list", "--first-parent", "--reverse", sha])
					.split("\n")
					.filter(Boolean);
			const parentsOf = new Map(
				git(["rev-list", "--ancestry-path", "--parents", `${base}..${sha}`])
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [commit, ...parents] = line.split(" ");
						if (commit === undefined)
							throw new Error(`rev-list printed no commit: ${line}`);
						return [commit, parents];
					}),
			);
			const chain = [];
			for (let at = sha; at !== base; ) {
				chain.push(at);
				const next = parentsOf
					.get(at)
					?.find((p) => p === base || parentsOf.has(p));
				if (next === undefined)
					throw new Error(`${short(at)} does not descend from ${short(base)}`);
				at = next;
			}
			return chain.reverse();
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
	 * rows it refused on where it was that gate's (#3123).
	 * @param {string} culprit
	 * @param {string|null} parent
	 * @param {string} tip
	 * @param {string} why
	 * @returns {{sha: string, stale: RegistryRow[]|null} | {failed: string}}
	 */
	function revertCommit(culprit, parent, tip, why) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lander-revert-"));
		git(["worktree", "add", "--quiet", "--detach", dir, tip]);
		/**
		 * @param {string[]} args
		 * @param {string} [input]
		 * @param {NodeJS.ProcessEnv} [env]
		 */
		const inTree = (args, input, env) =>
			execGit(args, {
				cwd: dir,
				encoding: "utf8",
				input,
				stdio: ["pipe", "pipe", "pipe"],
				timeout: LANDER_GIT_TIMEOUT_MS,
				env,
			});
		try {
			const parents = git(["rev-list", "--parents", "-n", "1", culprit])
				.trim()
				.split(" ")
				.slice(1);
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
			if (unreverted !== null) return { failed: parseFirstLine(unreverted) };
			const subject = git(["log", "-1", "--format=%s", culprit]).trim();
			const uncommitted = stderrIfThrown(() =>
				inTree(
					["commit", "--quiet", "--no-verify", "-F", "-"],
					`Revert "${subject}"\n\n${buildRevertLine(culprit)}\n\n${why}\n`,
					buildRevertEnv(culprit),
				),
			);
			if (uncommitted !== null)
				return {
					failed: `its commit was refused: ${buildCommitRefusal(dir, culprit, uncommitted)}`,
				};
			return {
				sha: inTree(["rev-parse", "HEAD"]).trim(),
				stale:
					readRegistryRows(dir, culprit, [tip, "--head", "HEAD"])?.exempted ??
					null,
			};
		} finally {
			git(["worktree", "remove", "--force", dir]);
		}
	}
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
	short,
	buildActionLine,
	runLander,
	landerFiles,
	fileLedger,
	heartbeatWriter,
	readHeartbeat,
	remoteGit,
};
