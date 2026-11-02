#!/usr/bin/env node
/*
 * refill-loop.js — the refill loop (#2012, #2123, spec #1995): one detached
 * process per machine that, each time a session it launched ends and at
 * least every 5 minutes (lib/refill-wake.js), reaps finished sessions and
 * launches the next tickets into free slots across the repos its scope
 * serves (lib/refill-loop.js's Scope).
 *
 *   node scripts/refill-loop.js start …  ensure a process runs from the stored
 *                                        control, ending any stop, changing
 *                                        only what its flags name; with
 *                                        --unless-stopped a stop stands; flags
 *                                        in USAGE
 *   node scripts/refill-loop.js stop     record an explicit stop and end
 *                                        launching before the next dispatch
 *                                        call; running sessions finish
 *   node scripts/refill-loop.js set …    pause or resume launching, tick repos,
 *                                        switch the mode or set the goal with
 *                                        no restart: the
 *                                        running loop takes it at its next tick,
 *                                        and an idle loop within seconds;
 *                                        housekeeping carries on; `--resume` with
 *                                        no process starts one from the stored
 *                                        control; flags in USAGE
 *   node scripts/refill-loop.js status   pause, mode, repos, goal, launches with
 *                                        their seats, with no process the stop
 *                                        that ended it or that it died with none,
 *                                        open repo holds
 *                                        (lib/repo-holds.js), each overflow
 *                                        seat's budget and the plan seats
 *                                        overflow rests on; `--json` the code
 *                                        sha, the stop, the pause, the last tick, launches
 *                                        today, the mode, when away was switched
 *                                        on and the sessions handed off since,
 *                                        the goal, every candidate
 *                                        checkout, the launch rows, the
 *                                        `seats:` line's fields and burn mode
 *   node scripts/refill-loop.js dry-run  one tick's decision, printed; reaps
 *                                        and launches nothing
 *   node scripts/refill-loop.js boot-resume  the boot unit's: restart the loop
 *                                        where no stop ended it, writing no
 *                                        control (install-refill-boot-unit.js)
 *
 * Each tick is lib/refill-tick.js's; the seats it reads, lib/refill-seats.js's;
 * what `start` and `status` print, lib/refill-commands.js's.
 *
 * LISTING: every listing the loop and its reaper read must span all its
 * seats. lib/agent-liveness.js and lib/registry-agents.js both read
 * arbiter-core's sessionDirs() (#3512), so a launch on a seat outside them is
 * unlisted and judged finished once its grace passes; `start` warns of one.
 *
 * CODE: in a git checkout, the loop runs from a detached worktree of its own
 * at the verified ref's tip, never from the checkout `start` was typed in, and
 * between ticks adopts a newer tip that changes its code by re-exec under the
 * same pid, keeping its lock, control, state and gate store
 * (lib/refill-code.js, #2361). Not while a gate sweep it started runs or a
 * stop is pending. From a
 * plugin install it does neither: its code changes only with a release bump.
 *
 * Joins no §N3 family: it is a daemon, not a checker or a guard. A tick that
 * throws is logged and the next one runs.
 *
 * Exit codes: 0; 1 on a throw outside the loop, a control lock kept past its
 * wait or, at `set` and `start`, a goal ref the lock's fresh read refuses or, at
 * `set` and `start --unless-stopped`, no sound control to change; 2 on a command
 * line, a goal ref it refuses first or, at `start`, a seat file it refuses.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./lib/caught.js");
const { readBurnState } = require("./lib/burn-mode.js");
const refillCode = require("./lib/refill-code.js");
const gates = require("./lib/gate-sweep.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { localDate } = require("./lib/morning-review.js");
const { pidLock } = require("./lib/pid-lock.js");
const { readAllowance } = require("./lib/allowance.js");
const { buildBudgetLine, seatBudget } = require("./lib/overflow-budget.js");
const { planSeatBasisOf } = require("./lib/overflow-notice.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
	unlistedSeats,
} = require("./lib/refill-seats.js");
const wakes = require("./lib/refill-wake.js");
const { ghJson, parseErrLine } = require("./lib/gh.js");
const {
	buildGoalRefusal,
	parseAskedRefs,
	parseGoalForm,
} = require("./lib/refill-goal.js");
const { configDir, seatDir } = require("./lib/config-dir.js");
const { readLastTyped } = require("./lib/presence.js");
const {
	checkoutEnv,
	exclusionOf,
	homeDir,
	readCandidates,
	readCheckoutRefusal,
	readHostTracker,
	readTickRefusal,
} = require("./lib/refill-repos.js");
const loop = require("./lib/refill-loop.js");
const { bootVerdictOf } = require("./lib/refill-boot.js");
const {
	adoptControlFile,
	forgetRunHeld,
	recordRunHeld,
	readControlChecked,
	readControlFile,
	readStateFile,
	withControlLock,
	writeControlFile,
} = require("./lib/refill-files.js");
const refillBatch = require("./lib/refill-batch.js");
const { buildHoldLines, readCheckout } = require("./lib/repo-holds.js");
const { scriptPath } = require("./lib/script-path.js");
const { forgetSession } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");
const commands = require("./lib/refill-commands.js");
const {
	DISPATCHER,
	files,
	log,
	buildCapUnsizedLine,
	readCap,
	isReviewRunning,
	say,
	servedRoots,
	tick,
} = require("./lib/refill-tick.js");

/* Untraced: the loop's log is cut to its newer half past this. */
const LOG_MAX_BYTES = 1024 * 1024;

const SCRIPTS = __dirname;
const USAGE = `usage: node ${scriptPath("refill-loop.js")} start | stop | set | status | dry-run | boot-resume
  start [--repo <dir>]… [--goal <goal>]        ensure a process runs, from the stored settings, ending any stop, its count starting again; a first start ticks this checkout. On a running loop it changes only what --repo ticks and --goal replaces, as set does
  start --unless-stopped [--repo <dir>]… [--goal <goal>]  the same, but an explicit stop stands and is printed, and otherwise the stored settings start as they were
  set --pause | --resume                       launch nothing, keeping housekeeping; or launch again, starting the loop from its stored settings where no process runs
  set --away | --normal                        hand a session at a question off to its issue, until a tick reads the founder back after one read him absent; or keep it open. The repos stay
  set [--repos <dir>]…                         the whole ticked set
  set [--tick <dir>]… [--untick <dir>]…        add to or take from the ticked set; a checkout found later stays unticked
  set --goal <ref,…>                           rank these issues first in every ticked repo, replacing the goal
  set --goal 'drain <ref>'                     the same for the ref's open descendants, worked out each tick
  set --goal 'unblock <ref>'                   the same for the ref and what holds it out across repos, worked out each tick
  set --goal-issues <ref,…> --goal-text <text> the same, for a confirmed topic: its issues, and the text they came from
  set --clear-goal                             run bare
  status [--json]                              --json: the code sha, the stop and whether it died with none, the pause, the last tick, launches today, the mode, when away was switched on and the sessions handed off since, the goal, every candidate checkout, the launch rows, each with its seat and why, the seats line's fields, and burn mode's state
  <dir> is a checkout's directory name in the home directory; a <ref> is <dir>#N, or #N with one repo ticked, naming an open issue; set takes any of its flags together`;

const lock = pidLock(files.pid, "refill-loop.js");

/**
 * The checkout roots `names` give, or a string saying why one is refused.
 * @param {string[]} names
 * @param {(name: string, home: string) => string|null} refusalOf
 * @returns {string[]|string}
 */
function rootsNamed(names, refusalOf) {
	for (const name of names) {
		const refusal = refusalOf(name, homeDir());
		if (refusal !== null) return refusal;
	}
	return names.map((name) => path.join(homeDir(), name));
}

/**
 * Why `set`'s flags cannot go together, null where they can.
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {string|null}
 */
function setConflictOf({ flags, lists }) {
	if (flags["--pause"] && flags["--resume"])
		return "set takes one of --pause and --resume";
	if (flags["--away"] && flags["--normal"])
		return "set takes one of --away and --normal";
	if (lists["--repos"] && (lists["--tick"] || lists["--untick"]))
		return "--repos is the whole set; it takes no --tick or --untick";
	const both = lists["--tick"]?.find((n) => lists["--untick"]?.includes(n));
	if (both) return `${both} is both ticked and unticked`;
	const goalFlags = ["--goal", "--goal-issues", "--clear-goal"].filter(
		(flag) => flags[flag] !== undefined,
	);
	if (goalFlags.length > 1)
		return `set takes one of ${goalFlags.join(" and ")}`;
	if (
		(flags["--goal-issues"] === undefined) !==
		(flags["--goal-text"] === undefined)
	)
		return "--goal-issues and --goal-text go together";
	return Object.keys(flags).length + Object.keys(lists).length === 0
		? "set names no field"
		: null;
}

/**
 * The goal `set`'s flags ask for: undefined where they name none, null to clear
 * it, or a string refusal.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @returns {import("./lib/refill-commands.js").GoalAsk|null|undefined|string}
 */
function parseGoalAsk(flags) {
	if (flags["--clear-goal"]) return null;
	if (flags["--goal"] !== undefined) {
		const typed = String(flags["--goal"]);
		const asked = parseGoalForm(typed);
		return asked ? { ...asked, text: typed } : buildGoalRefusal(typed);
	}
	const typed = flags["--goal-issues"];
	if (typed === undefined) return;
	const refs = parseAskedRefs(String(typed));
	if (refs === null) return `a goal takes issue refs, #N or <dir>#N: ${typed}`;
	const text = String(flags["--goal-text"]).trim();
	return text === "" ? "--goal-text is empty" : { form: "topic", text, refs };
}

/**
 * What `start`'s flags ask, or a string refusal.
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {import("./lib/refill-commands.js").SetAsk|string}
 */
function parseStartAsk({ flags, lists }) {
	const named = rootsNamed(lists["--repo"] ?? [], readTickRefusal);
	if (typeof named === "string") return named;
	const goal = parseGoalAsk(flags);
	if (typeof goal === "string") return goal;
	return {
		...(named.length > 0 ? { tick: named } : {}),
		...(goal === undefined ? {} : { goal }),
	};
}

/**
 * What `set`'s flags ask, or a string refusal.
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {import("./lib/refill-commands.js").SetAsk|string}
 */
function parseSetAsk(parsed) {
	const conflict = setConflictOf(parsed);
	if (conflict !== null) return conflict;
	const { flags, lists } = parsed;
	/** @type {import("./lib/refill-commands.js").SetAsk} */
	const ask = {};
	if (flags["--pause"]) ask.pause = true;
	if (flags["--resume"]) ask.pause = false;
	if (flags["--away"]) ask.mode = "away";
	if (flags["--normal"]) ask.mode = "normal";
	/* An untick takes one since opted out, so an opt-out never strands a tick. */
	for (const [flag, field, refusalOf] of /** @type {const} */ ([
		["--repos", "repos", readTickRefusal],
		["--tick", "tick", readTickRefusal],
		["--untick", "untick", readCheckoutRefusal],
	])) {
		const names = lists[flag];
		if (!names) continue;
		const roots = rootsNamed(names, refusalOf);
		if (typeof roots === "string") return roots;
		ask[field] = roots;
	}
	const goal = parseGoalAsk(flags);
	if (typeof goal === "string") return goal;
	if (goal !== undefined) ask.goal = goal;
	return ask;
}

/**
 * The state of the issue `ref` names, or why it would not read.
 * @param {import("./lib/refill-goal.js").GoalRef} ref
 * @returns {import("./lib/refill-goal.js").IssueRead}
 */
function readIssueState(ref) {
	const root = path.join(homeDir(), ref.repo);
	const tracker = readHostTracker(root);
	try {
		const { state } = ghJson(
			[
				"issue",
				"view",
				String(ref.number),
				...(tracker ? ["--repo", tracker] : []),
				"--json",
				"state",
			],
			{ cwd: root, env: checkoutEnv(root) },
		);
		return { state: String(state) };
	} catch (err) {
		return { unread: parseErrLine(err) };
	}
}

/** The control as stored, null where none will read; its planner reports why. */
const readStoredControl = () => readControlChecked(() => undefined).control;

/**
 * A parsed ask with its goal judged on the stored control, else on `unstored`, or
 * a string refusal.
 * @param {import("./lib/refill-commands.js").SetAsk|string} parsedAsk
 * @param {import("./lib/refill-loop.js").Control|null} unstored
 * @returns {import("./lib/refill-commands.js").SetAsk|string}
 */
function checkAsk(parsedAsk, unstored) {
	if (typeof parsedAsk === "string") return parsedAsk;
	return commands.checkGoalAsk(
		readStoredControl() ?? unstored,
		parsedAsk,
		readIssueState,
	);
}

/**
 * The checkout a command sizes caps and budgets in: the tick's root
 * (refill-tick.js), so it prints the figure the tick sizes; with no loop
 * serving, this checkout's.
 * @param {string[]} served
 */
const sizingRoot = (served) => served[0] ?? hostRoot();

/**
 * What the `seats:` line says now, off each seat's cache with no `/usage`
 * probe, a tick being the one to refresh it (#3733).
 * @param {string[]} planSeats
 * @param {string} root
 * @param {string} [callerSeat] for `start`
 */
function readSeatsView(planSeats, root, callerSeat) {
	const now = Date.now();
	const declared = readDeclaredSeats();
	const ceilings = loop.ceilingsOf(process.env);
	const seats = planSeats.map((seat) => {
		const bars = readAllowance({ configDir: seat, now });
		const reading = loop.seatReadingOf(seat, bars, now);
		return commands.foreseeSeat({
			reading,
			bars,
			sizeCap: () => {
				const cap = readCap(root, seat, 1, "");
				if (cap.fits === null)
					writeFd(2, `${buildCapUnsizedLine(seat, cap)}\n`);
				return cap.fits;
			},
			ceilings,
			now,
		});
	});
	return commands.buildSeatsView({
		seats,
		overflow: loop.overflowReadings(declared, seats, (seat) =>
			seatBudget(seat, root),
		),
		typedSeat: readLastTyped(declared).seat,
		ceilings,
		callerSeat,
	});
}

/**
 * Spawn the detached loop from its verified code.
 * @returns {{error: string} | {pid: number|undefined, fetchError: string|null|undefined}}
 */
function launchLoop() {
	const launch = refillCode.launchProgram({
		scriptsDir: SCRIPTS,
		codeDir: files.code,
	});
	if ("error" in launch) return { error: String(launch.error) };
	trimLog();
	const out = fs.openSync(files.log, "a");
	const env = { ...process.env };
	forgetSession(env);
	const child = spawn(process.execPath, [launch.program, "run"], {
		detached: true,
		stdio: ["ignore", out, out],
		cwd: homeDir(),
		env,
	});
	child.unref();
	return { pid: child.pid, fetchError: launch.fetchError };
}

/** @param {string} why */
const buildFetchFailedLine = (why) =>
	`fetch failed, starting on the last fetched tip: ${why}`;

/**
 * What a boot's user unit runs (lib/refill-boot.js): this process's stdout is
 * the journal, so its lines also go to the loop's log.
 */
function bootResume() {
	const note = (/** @type {string} */ line) => {
		const stamped = `${new Date().toISOString()} ${line}\n`;
		writeFd(1, stamped);
		fs.mkdirSync(path.dirname(files.log), { recursive: true });
		fs.appendFileSync(files.log, stamped);
	};
	const { control, damaged } = readControlChecked(note);
	const verdict = bootVerdictOf({
		control,
		damaged,
		stopped: readStateFile(note).stopped,
		pid: lock.holder(),
		self: process.pid,
	});
	if (!verdict.resume) {
		note(verdict.line);
		return 0;
	}
	const launched = launchLoop();
	if ("error" in launched) {
		note(`boot resume: not resumed: ${launched.error}`);
		return 1;
	}
	if (launched.fetchError)
		note(`boot resume: ${buildFetchFailedLine(launched.fetchError)}`);
	note(`${verdict.line}, pid ${launched.pid}`);
	return 0;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function start(parsed) {
	const root = hostRoot();
	const excluded = exclusionOf(root);
	if (excluded !== null && readStoredControl() === null) {
		say(`refill loop not started: this checkout is not served (${excluded})`);
		return 0;
	}
	const parsedAsk = parseStartAsk(parsed);
	const ask = checkAsk(parsedAsk, commands.buildFreshControl(root, [], 0));
	if (typeof ask === "string") {
		writeFd(2, `${ask}\n\n${USAGE}\n`);
		return 2;
	}
	const written = withControlLock(() => {
		const pid = lock.holder();
		const plan = commands.planStart(
			readControlChecked(() => undefined),
			ask,
			{
				pid,
				now: Date.now(),
				root,
				seats: readConfiguredSeats(),
				seatErrors: readDeclaredSeats().errors,
				stopped: readStateFile(log).stopped,
				unlessStopped: parsed.flags["--unless-stopped"] === true,
			},
		);
		if ("refused" in plan) return plan;
		if (plan.write) writeControlFile(plan.write);
		if (plan.action === "start") forgetRunHeld(log);
		return plan;
	});
	if ("busy" in written) return refuseWrite("not started", written.busy);
	const plan = written.done;
	if ("refused" in plan) {
		refuseWrite("nothing set", plan.refused);
		return plan.exitCode;
	}
	if (plan.write) wakes.touchWake(files.wake);
	const { control, action } = plan;
	const served = servedRoots(control.scope).roots;
	const scopeText = [
		...commands
			.buildScopeLines(control, {
				served,
				running: action !== "stopped",
				seatsLine: commands.buildSeatsLine(
					readSeatsView(
						control.seats,
						sizingRoot(served),
						seatDir(configDir(), homeDir()),
					),
					Date.now(),
				),
			})
			.map((l) => `  ${l}`),
		...commands.buildUntickedLines(control, root),
	];
	for (const line of plan.lines) say(line);
	if (action === "start") return startProcess(control, scopeText);
	for (const line of scopeText) say(line);
	return 0;
}

/**
 * Spawn the loop on a control already written, and say so.
 * @param {import("./lib/refill-loop.js").Control} control
 * @param {string[]} scopeText
 */
function startProcess(control, scopeText) {
	const launched = launchLoop();
	if ("error" in launched) {
		writeFd(2, `refill loop not started: ${launched.error}\n`);
		return 1;
	}
	if (launched.fetchError) say(buildFetchFailedLine(launched.fetchError));
	say(`refill loop started: pid ${launched.pid}`);
	for (const line of scopeText) say(line);
	for (const seat of unlistedSeats(control.seats))
		say(
			`WARNING: seat ${seat} is outside the dirs the agents listing reads, so its launches go unlisted and are judged finished early.`,
		);
	say(`log: ${files.log}`);
	return 0;
}

function stop() {
	const written = withControlLock(() => {
		const control = readControlFile(log);
		/* A repeat stop keeps the time of the first. */
		if (control && !control.stopRequested)
			writeControlFile({
				...control,
				stopRequested: true,
				stopRequestedAt: Date.now(),
			});
	});
	if ("busy" in written) return refuseWrite("stop not recorded", written.busy);
	const pid = lock.holder();
	if (pid !== null) wakes.touchWake(files.wake);
	say(
		pid === null
			? "refill loop: not running"
			: `refill loop: stop requested; pid ${pid} makes no further dispatch call and exits when the tick in flight ends, or where none is, at the tick this stop wakes; a dispatch or the morning review can hold a tick for minutes. Running sessions finish.`,
	);
	return 0;
}

/**
 * `set`: the named fields changed on a fresh read under the control lock, then
 * the wake touched, and where a resume found no process, one started.
 * @param {import("./lib/cli-args").Parsed} parsed
 */
function set(parsed) {
	const ask = checkAsk(parseSetAsk(parsed), null);
	if (typeof ask === "string") {
		writeFd(2, `${ask}\n\n${USAGE}\n`);
		return 2;
	}
	const written = withControlLock(() => {
		const plan = commands.planSet(
			readControlChecked(() => undefined),
			ask,
			{
				running: lock.holder() !== null,
				now: Date.now(),
			},
		);
		if ("write" in plan && plan.write) writeControlFile(plan.write);
		if ("startFrom" in plan && plan.startFrom) forgetRunHeld(log);
		return plan;
	});
	if ("busy" in written) return refuseWrite("nothing set", written.busy);
	if ("refused" in written.done) {
		return refuseWrite("nothing set", written.done.refused);
	}
	wakes.touchWake(files.wake);
	for (const line of written.done.lines) say(line);
	return written.done.startFrom ? startProcess(written.done.startFrom, []) : 0;
}

/**
 * @param {string} what
 * @param {string} why
 */
function refuseWrite(what, why) {
	writeFd(2, `refill loop: ${what}: ${why}\n`);
	return 1;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function status({ flags }) {
	/* `--json`'s stdout is the one object, so a read's complaint goes to stderr. */
	const note = flags["--json"]
		? (/** @type {string} */ line) => writeFd(2, `${line}\n`)
		: log;
	const control = readControlFile(note);
	const served = control ? servedRoots(control.scope).roots : [];
	const pid = lock.holder();
	const state = readStateFile(note);
	const root = sizingRoot(served);
	const seats = readSeatsView(control?.seats ?? readConfiguredSeats(), root);
	const codeSha =
		pid === null ? null : refillCode.readRunningCode(pid, files.code);
	if (flags["--json"]) {
		say(
			JSON.stringify(
				commands.buildStatusJson({
					control,
					state,
					pid,
					seats,
					codeSha,
					today: localDate(new Date()),
					candidates: readCandidates(homeDir()),
					burnMode: readBurnState(),
				}),
			),
		);
		return 0;
	}
	for (const line of commands.buildStatusLines({
		control,
		state,
		pid,
		codeSha,
		served,
		seats,
		now: Date.now(),
	}))
		say(line);
	for (const line of buildHoldLines(
		served.length > 0
			? loop.landingRoots(served, state.launches)
			: [readCheckout(root)],
		Date.now(),
	))
		say(line);
	sayOverflowLines(control, state, root);
	return 0;
}

/**
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @param {import("./lib/refill-loop.js").LoopState} state
 * @param {string} root
 */
function sayOverflowLines(control, state, root) {
	const declared = readDeclaredSeats();
	for (const error of declared.errors) say(`seat file refuses: ${error}`);
	const overflow = declared.seats.flatMap((s) =>
		s.kind === "overflow" ? [s] : [],
	);
	for (const seat of overflow)
		say(buildBudgetLine(seat, seatBudget(seat, root)));
	if (overflow.length > 0 && declared.errors.length === 0) {
		const now = Date.now();
		const lines = commands.buildOverflowBasisLines({
			planSeats: (control?.seats ?? readConfiguredSeats()).map((seat) =>
				planSeatBasisOf(
					loop.seatReadingOf(
						seat,
						readAllowance({ configDir: seat, now }),
						now,
					),
				),
			),
			filePlanSeats: declared.seats
				.filter((s) => s.kind === "plan")
				.map((s) => s.dir),
			omitted: readOmittedDirs(declared),
			start: state.overflowStart,
			now,
		});
		for (const line of lines) say(line);
	}
}

function trimLog() {
	let text;
	try {
		text = fs.readFileSync(files.log, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return;
		throw err;
	}
	if (text.length > LOG_MAX_BYTES)
		fs.writeFileSync(files.log, text.slice(-LOG_MAX_BYTES / 2));
}

async function printDryRun() {
	const { decision: d, read } = await tick({ dryRun: true });
	say(`dry run: ${loop.summaryOf(d)}`);
	if (read) say(loop.buildFrontierReadText(read));
	const { reviewRunOn } = readStateFile(log);
	say(
		`morning review: ${loop.isReviewRunDue(new Date(), reviewRunOn) ? "the filing is due, then reversals" : "reversals only"}`,
	);
	if ("stop" in d) return 0;
	for (const r of d.resumes) say(`would resume ${r.line}`);
	const overflow = new Set(
		readDeclaredSeats()
			.seats.filter((s) => s.kind === "overflow")
			.map((s) => s.dir),
	);
	for (const batch of refillBatch.batchesOf(d.launches)) {
		say(
			refillBatch.buildWouldRunLine(
				refillBatch.dispatchCall(batch, DISPATCHER, process.env),
				overflow,
			),
		);
	}
	for (const s of d.skipped) say(`skipped ${loop.buildSkipText(s)}`);
	return 0;
}

/**
 * Start the gate sweep where it is due, never waiting on it: one `check:` may
 * run to its budget, which no tick may wait out (#2279).
 * @param {ReturnType<typeof gates.gateSweeper>} sweeper
 */
function startGateSweep(sweeper) {
	const control = readControlFile(log);
	if (!control || control.stopRequested) return;
	const started = sweeper.startIfDue(
		servedRoots(control.scope).roots,
		Date.now(),
	);
	/* A sweep that fails leaves the readings of the checkout it failed on, and
	 * any after it, as they were, and the next due sweep runs afresh (#2279). */
	started?.catch((err) => log(`gate sweep failed: ${buildErrorText(err)}`));
}

async function run() {
	if (!lock.acquire()) {
		log(`another refill loop holds ${files.pid}; exiting`);
		return 0;
	}
	process.on("exit", lock.release);
	recordRunHeld(log);
	adoptControlFile(log);
	for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
		process.on(sig, () => process.exit(0));
	log(`refill loop running, pid ${process.pid}, from ${SCRIPTS}`);
	const sweeper = gates.gateSweeper({
		file: files.gates,
		runRoot: (root) => gates.runCheckGates(root, { env: checkoutEnv(root) }),
		log,
		cadenceMs: gates.GATE_SWEEP_MS,
	});
	const updater = refillCode.codeUpdater({
		program: __filename,
		codeDir: files.code,
		log,
	});
	const watcher = wakes.wakeWatcher(files.wake, { log });
	await wakes.runTicks(async (wake) => {
		if (wake.woken)
			log(
				`${wake.recheck ? "re-checking after wake" : "woken"}${wake.sessions.length > 0 ? ` by ${wake.sessions.join(", ")}` : ""}`,
			);
		try {
			/* Before the sweep starts, so the image it replaces has no child.
			 * A review runner runs from this image's worktree too (#3765). */
			updater?.adoptIfMoved({
				hold:
					sweeper.busy() ||
					isReviewRunning() ||
					readControlFile(log)?.stopRequested === true,
			});
			startGateSweep(sweeper);
			const { decision, noProgressFrom, agents } = await tick({
				dryRun: false,
			});
			updater?.afterTick();
			/* A `start` that overtook a pending stop mid-tick saw this pid and
			 * spawned nothing, so that stop must not end the loop. */
			const done =
				"stop" in decision &&
				!loop.isRestartedSince(readControlFile(log), noProgressFrom);
			return { done, agents };
		} catch (err) {
			log(`tick failed: ${buildErrorText(err)}`);
			return { done: false, agents: null };
		}
	}, watcher);
	watcher.close();
	return 0;
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: {
		start: {
			usage: USAGE,
			flags: {
				"--repo": "list",
				"--goal": "value",
				"--unless-stopped": "boolean",
			},
		},
		stop: { usage: USAGE },
		set: {
			usage: USAGE,
			flags: {
				"--pause": "boolean",
				"--resume": "boolean",
				"--away": "boolean",
				"--normal": "boolean",
				"--repos": "list",
				"--tick": "list",
				"--untick": "list",
				"--goal": "value",
				"--goal-issues": "value",
				"--goal-text": "value",
				"--clear-goal": "boolean",
			},
		},
		status: { usage: USAGE, flags: { "--json": "boolean" } },
		"dry-run": { usage: USAGE },
		run: { usage: USAGE },
		"boot-resume": { usage: USAGE },
	},
};

const COMMANDS = {
	start,
	stop,
	set,
	status,
	"dry-run": printDryRun,
	run,
	"boot-resume": bootResume,
};

async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") {
		process.exitCode = parsed;
		return;
	}
	/* cli-args.js refuses a command not declared, so one is always named. */
	const command = /** @type {keyof typeof COMMANDS} */ (parsed.command);
	process.exitCode = await COMMANDS[command](parsed);
}

module.exports = { main };

if (require.main === module)
	main().then(
		() => process.exit(),
		(err) => {
			writeFd(2, `${buildErrorText(err)}\n`);
			process.exit(1);
		},
	);
