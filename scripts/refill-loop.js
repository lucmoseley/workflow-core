#!/usr/bin/env node

// #4337
const { handOff } = require("./lib/refill-control-code.js");

if (require.main === module) {
	const handedOff = handOff(process.argv.slice(2), __filename);
	if (handedOff !== null) process.exit(handedOff);
}

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./lib/caught.js");
const { readBurnState } = require("./lib/burn-mode.js");
const { readConcurrencyStatus } = require("./lib/concurrency.js");
const {
	readSeatAliases,
	withWaitingAliases,
} = require("./lib/seat-aliases.js");
const refillCode = require("./lib/refill-code.js");
const { now } = require("./lib/check.js");
const { runCommand } = require("./lib/run-command.js");
const gates = require("./lib/gate-sweep.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const {
	buildBudgetLine,
	shownSeatBudget,
} = require("./lib/overflow-budget.js");
const { readAgentsForDisplay } = require("./lib/agent-liveness.js");
const { planSeatBasisOf } = require("./lib/overflow-notice.js");
const {
	overflowSeatsOf,
	planSeatsOf,
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
const {
	buildNotice,
	buildNoticeText,
	isNotice,
} = require("./lib/refill-notice.js");
const { configDir, seatDir } = require("./lib/config-dir.js");
const { readLastTypedSeat } = require("./lib/presence.js");
const {
	buildCheckoutEnv,
	readExclusionWhy,
	isOptedOut,
	homeDir,
	readCandidates,
	readCheckoutRefusal,
	readHostTracker,
	readTickRefusal,
} = require("./lib/refill-repos.js");
const loop = require("./lib/refill-loop.js");
const seatReading = require("./lib/seat-reading.js");
const {
	awaitLoopHold,
	buildFetchFailedLine,
	holdRun,
	runBootResume,
	runWatch,
} = require("./lib/refill-boot.js");
const { readCurrentBootId, readProcStartOf } = require("./lib/arbiter-proc.js");
const { REAL_PROC } = require("./lib/proc-root.js");
const { HOLD_MAX_MINUTES } = require("./lib/launch-hold.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { systemctl } = require("./lib/systemd-bins.js");
const {
	appendLoopLog,
	readControlChecked,
	buildLoopLogLine,
	readControlFile,
	withControlLock,
	writeControlFile,
	writeManagerRestart,
} = require("./lib/refill-files.js");
const {
	readState,
	runForgotten,
	updateState,
} = require("./lib/refill-state.js");
const refillBatch = require("./lib/refill-batch.js");
const { buildHoldLines, readCheckout } = require("./lib/repo-holds.js");
const { scriptPath } = require("./lib/script-path.js");
const { forgetSession } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");
const commands = require("./lib/refill-commands.js");
const { files, log, say, servedRoots } = require("./lib/refill-io.js");

// #4821
const loadTick = () => require("./lib/refill-tick.js");

const LOG_MAX_BYTES = 1024 * 1024;

const SCRIPTS = __dirname;
const USAGE = `usage: node ${scriptPath("refill-loop.js")} start | stop | set | status | dry-run | boot-resume | watch
  start [--repo <dir>]… [--goal <goal>]        ensure a process runs, from the stored settings, ending any stop, its count starting again; a first start ticks this checkout. On a running loop it changes only what --repo ticks and --goal replaces, as set does
  start --unless-stopped [--repo <dir>]… [--goal <goal>]  the same, but an explicit stop stands and is printed, and otherwise the stored settings start as they were
  set --pause | --resume                       launch nothing, keeping housekeeping; or launch again, starting the loop from its stored settings where no process runs
  set --hold-launches <minutes> | --release-launches  launch nothing for this long, up to ${HOLD_MAX_MINUTES}, keeping housekeeping and leaving any pause as it is, while a manual /pick-next dispatches; or launch again now
  set --away | --normal                        hand a session at a question off to its issue, until set --normal or the panel's Away switch; or keep it open. The repos stay
  set [--repos <dir>]…                         the whole ticked set
  set [--tick <dir>]… [--untick <dir>]…        add to or take from the ticked set; a checkout found later stays unticked
  set --goal <ref,…>                           rank these issues first in every ticked repo, replacing the goal
  set --goal 'drain <ref>'                     the same for the ref's open descendants, worked out each tick
  set --goal 'unblock <ref>'                   the same for the ref and what holds it out across repos, worked out each tick
  set --goal-issues <ref,…> --goal-text <text> the same, for a confirmed topic: its issues, and the text they came from
  set --clear-goal                             run bare
  set --json <flags>                           print one object once its flags parse, whatever the exit: refused, null or its reason, remedy and box at fault; warning, the same for a change no process takes yet; and lines, what it says without --json
  status [--json]                              --json: the code sha, the stop and whether it died with none, the pause, a live launch hold, the last tick, the mode, when away was switched on and the sessions handed off since, the goal, every candidate checkout, the launch rows, each with its seat and why, the seats line's fields, each overflow key's budget, and burn mode's state
  <dir> is a checkout's directory name in the home directory; a <ref> is <dir>#N, or #N with one repo ticked, naming an open issue; set takes any of its flags together`;

/** @typedef {import("./lib/refill-notice.js").Notice} Notice */

const lock = pidLock(files.pid, "refill-loop.js");
const launchLock = pidLock(files.launch, "refill-loop.js");

/**
 * @param {string[]} names
 * @param {(name: string, home: string) => string|null} refusalOf
 * @returns {string[]|Notice}
 */
function rootsNamed(names, refusalOf) {
	for (const name of names) {
		const refusal = refusalOf(name, homeDir());
		if (refusal !== null) return buildNotice(refusal, null, name);
	}
	return names.map((name) => path.join(homeDir(), name));
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {string|null}
 */
function setConflictOf({ flags, lists }) {
	if (flags["--pause"] && flags["--resume"])
		return "set takes one of --pause and --resume";
	if (flags["--away"] && flags["--normal"])
		return "set takes one of --away and --normal";
	if (flags["--hold-launches"] !== undefined && flags["--release-launches"])
		return "set takes one of --hold-launches and --release-launches";
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
	const fields = Object.keys(flags).filter((flag) => flag !== "--json");
	return fields.length + Object.keys(lists).length === 0
		? "set names no field"
		: null;
}

/**
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @returns {import("./lib/refill-commands.js").GoalAsk|null|undefined|Notice}
 */
function parseGoalAsk(flags) {
	if (flags["--clear-goal"]) return null;
	if (flags["--goal"] !== undefined) {
		const typed = String(flags["--goal"]);
		const asked = parseGoalForm(typed);
		if (asked === null) return buildNotice(buildGoalRefusal(typed));
		const refs = asked.form === "issues" ? asked.refs : [asked.ref];
		return { form: asked.form, refs, text: typed };
	}
	const typed = flags["--goal-issues"];
	if (typed === undefined) return;
	const refs = parseAskedRefs(String(typed));
	if (refs === null)
		return buildNotice(`a goal takes issue refs, #N or <dir>#N: ${typed}`);
	const text = String(flags["--goal-text"]).trim();
	return text === ""
		? buildNotice("--goal-text is empty")
		: { form: "topic", text, refs };
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {import("./lib/refill-commands.js").SetAsk|Notice}
 */
function parseStartAsk({ flags, lists }) {
	const named = rootsNamed(lists["--repo"] ?? [], readTickRefusal);
	if (isNotice(named)) return named;
	const goal = parseGoalAsk(flags);
	if (isNotice(goal)) return goal;
	return {
		...(named.length > 0 ? { tick: named } : {}),
		...(goal === undefined ? {} : { goal }),
	};
}

/**
 * @param {string} typed
 * @returns {number|Notice}
 */
function parseHoldMinutes(typed) {
	const minutes = /^\d+$/.test(typed) ? Number(typed) : Number.NaN;
	return minutes >= 1 && minutes <= HOLD_MAX_MINUTES
		? minutes
		: buildNotice(
				`--hold-launches takes whole minutes, 1 to ${HOLD_MAX_MINUTES}: ${typed}`,
			);
}

/**
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @returns {import("./lib/refill-commands.js").SetAsk}
 */
function parseSwitchAsk(flags) {
	/** @type {import("./lib/refill-commands.js").SetAsk} */
	const ask = {};
	if (flags["--pause"]) ask.pause = true;
	if (flags["--resume"]) ask.pause = false;
	if (flags["--away"]) ask.mode = "away";
	if (flags["--normal"]) ask.mode = "normal";
	if (flags["--release-launches"]) ask.holdMinutes = null;
	return ask;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {import("./lib/refill-commands.js").SetAsk|Notice}
 */
function parseSetAsk(parsed) {
	const conflict = setConflictOf(parsed);
	if (conflict !== null) return buildNotice(conflict);
	const { flags, lists } = parsed;
	const ask = parseSwitchAsk(flags);
	if (flags["--hold-launches"] !== undefined) {
		const minutes = parseHoldMinutes(String(flags["--hold-launches"]));
		if (isNotice(minutes)) return minutes;
		ask.holdMinutes = minutes;
	}
	if (ask.holdMinutes !== undefined)
		ask.holder = process.env.CLAUDE_CODE_SESSION_ID || null;
	for (const [flag, field, refusalOf] of /** @type {const} */ ([
		["--repos", "repos", readTickRefusal],
		["--tick", "tick", readTickRefusal],
		["--untick", "untick", readCheckoutRefusal],
	])) {
		const names = lists[flag];
		if (!names) continue;
		const roots = rootsNamed(names, refusalOf);
		if (isNotice(roots)) return roots;
		ask[field] = roots;
	}
	const goal = parseGoalAsk(flags);
	if (isNotice(goal)) return goal;
	if (goal !== undefined) ask.goal = goal;
	return ask;
}

/**
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
			{ cwd: root, env: buildCheckoutEnv(root) },
		);
		return { state: String(state) };
	} catch (err) {
		return { unread: parseErrLine(err) };
	}
}

const readStoredControl = () => readControlChecked(() => undefined).control;

/**
 * @param {import("./lib/refill-commands.js").SetAsk|Notice} parsedAsk
 * @param {import("./lib/refill-loop.js").Control|null} unstored
 * @returns {import("./lib/refill-commands.js").SetAsk|Notice}
 */
function checkAsk(parsedAsk, unstored) {
	if (isNotice(parsedAsk)) return parsedAsk;
	return commands.checkGoalAsk(readStoredControl() ?? unstored, parsedAsk, {
		readIssue: readIssueState,
		readExclusionWhy,
	});
}

/** @param {string[]} served */
const sizingRoot = (served) => served[0] ?? hostRoot();

/**
 * @param {string[]} planSeats
 * @param {{root: string, budgetOf: BudgetOf, at: number, callerSeat?: string}} view
 */
function readSeatsView(planSeats, { root, budgetOf, at, callerSeat }) {
	const declared = readDeclaredSeats();
	const ceilings = seatReading.ceilingsOf(process.env);
	const sizeCap = seatReading.capSizer(
		root,
		(line) => writeFd(2, `${line}\n`),
		readAgentsForDisplay,
	);
	const seats = planSeats.map((seat) => {
		const { bars, reading } = seatReading.readSeat(seat, at);
		return commands.foreseeSeat({
			reading,
			bars,
			sizeCap: () => sizeCap(seat, 1),
			ceilings,
			now: at,
		});
	});
	return commands.buildSeatsView({
		seats,
		overflow: seatReading.overflowReadings(declared, seats, budgetOf),
		typedSeat: readLastTypedSeat(declared),
		ceilings,
		callerSeat,
	});
}

/**
 * @returns {{error: string} | {pid: number|undefined, fetchError: string|null|undefined}}
 */
function launchLoop() {
	launchLock.acquire();
	try {
		return launchHeld();
	} finally {
		launchLock.release();
	}
}

function launchHeld() {
	trimLog();
	const launch = refillCode.launchProgram({
		scriptsDir: SCRIPTS,
		codeDir: files.code,
		log,
	});
	if ("error" in launch) return { error: String(launch.error) };
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
	const error = awaitLoopHold({
		pid: child.pid,
		file: files.pid,
		holder: lock.holder,
		hasHeld: () => Boolean(readState(() => undefined).heldAt),
		isAlive: () => readProcStartOf(Number(child.pid), REAL_PROC) !== null,
		now: () => performance.now(),
		sleep: sleepSync,
	});
	if (error !== null) {
		child.kill();
		return { error: `${error}; log: ${files.log}` };
	}
	return { pid: child.pid, fetchError: launch.fetchError };
}

/** @param {(line: string) => void} write */
const bootPorts = (write) => ({
	readControl: readControlChecked,
	readState,
	holder: lock.holder,
	self: process.pid,
	updateState: (/** @type {import("./lib/refill-state.js").Transition} */ t) =>
		updateState(t, write),
});

function bootResume() {
	const at = now();
	const note = (/** @type {string} */ line) => {
		writeFd(1, buildLoopLogLine(line));
		appendLoopLog(line);
	};
	return runBootResume({
		...bootPorts(note),
		note,
		bootId: readCurrentBootId,
		now: () => at,
		writeManagerRestart,
		launch: launchLoop,
	});
}

function watch() {
	const outcome = runWatch({
		...bootPorts(() => undefined),
		launchHolder: launchLock.holder,
		restartBootUnit: () =>
			runCommand(systemctl(), [
				"--user",
				"restart",
				"refill-loop-boot.service",
			]),
	});
	if (outcome.code === 1) writeFd(2, `${outcome.message}\n`);
	return outcome.code;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function start(parsed) {
	const root = hostRoot();
	const excluded = readExclusionWhy(root);
	if (excluded !== null && readStoredControl() === null) {
		say(`refill loop not started: this checkout is not served (${excluded})`);
		return 0;
	}
	const parsedAsk = parseStartAsk(parsed);
	const ask = checkAsk(parsedAsk, commands.buildFreshControl(root, [], 0));
	if (isNotice(ask)) {
		refuseUsage(ask);
		return 2;
	}
	const written = withControlLock(() => {
		const at = now();
		const pid = lock.holder();
		const plan = commands.planStart(
			readControlChecked(() => undefined),
			ask,
			{
				pid,
				now: at,
				root,
				seats: readConfiguredSeats(),
				seatErrors: readDeclaredSeats().errors,
				stopped: readState(log).stopped,
				unlessStopped: parsed.flags["--unless-stopped"] === true,
				readExclusionWhy,
				isOptedOut,
			},
		);
		if ("refused" in plan) return { at, plan };
		if (plan.write) writeControlFile(plan.write);
		if (plan.action === "start") updateState(runForgotten(), log);
		return { at, plan };
	});
	if ("busy" in written)
		return refuseWrite("not started", buildBusyRefusal(written.busy));
	const { at, plan } = written.done;
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
				now: at,
				seatsLine: commands.buildSeatsLine(
					readSeatsView(control.seats, {
						root: sizingRoot(served),
						budgetOf: buildShownBudgets(sizingRoot(served)),
						at,
						callerSeat: seatDir(configDir(), homeDir()),
					}),
					at,
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
 * @param {import("./lib/refill-loop.js").Control} control
 * @param {string[]} scopeText
 * @returns {{error: string}|{lines: string[]}}
 */
function launchFrom(control, scopeText) {
	const launched = launchLoop();
	if ("error" in launched) {
		appendLoopLog(`refill loop not started: ${launched.error}`);
		return { error: launched.error };
	}
	return {
		lines: [
			...(launched.fetchError
				? [buildFetchFailedLine(launched.fetchError)]
				: []),
			`refill loop started: pid ${launched.pid}`,
			...scopeText,
			...unlistedSeats(control.seats).map(
				(seat) =>
					`WARNING: seat ${seat} is outside the dirs the agents listing reads, so its launches go unlisted and are judged finished early.`,
			),
			`log: ${files.log}`,
		],
	};
}

/**
 * @param {import("./lib/refill-loop.js").Control} control
 * @param {string[]} scopeText
 */
function startProcess(control, scopeText) {
	const started = launchFrom(control, scopeText);
	if ("error" in started) {
		writeFd(2, `refill loop not started: ${started.error}\n`);
		return 1;
	}
	for (const line of started.lines) say(line);
	return 0;
}

function stop() {
	const written = withControlLock(() => {
		const control = readControlFile(log);
		if (control && !control.stopRequested)
			writeControlFile({
				...control,
				stopRequested: true,
				stopRequestedAt: now(),
			});
	});
	if ("busy" in written)
		return refuseWrite("stop not recorded", buildBusyRefusal(written.busy));
	const pid = lock.holder();
	if (pid !== null) wakes.touchWake(files.wake);
	say(
		pid === null
			? "refill loop: not running"
			: `refill loop: stop requested; pid ${pid} makes no further dispatch call and exits when the tick in flight ends, or where none is, at the tick this stop wakes; a dispatch or the morning review can hold a tick for minutes. Running sessions finish.`,
	);
	return 0;
}

/** @param {string} line */
function noteSetSource(line) {
	try {
		appendLoopLog(line);
	} catch (e) {
		writeFd(2, `refill loop: not logged: ${line}: ${buildErrorText(e)}\n`);
	}
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function set(parsed) {
	const json = parsed.flags["--json"] === true;
	const ask = checkAsk(parseSetAsk(parsed), null);
	if (isNotice(ask)) {
		if (json) say(JSON.stringify(commands.buildSetJson({ refused: ask })));
		else refuseUsage(ask);
		return 2;
	}
	const written = withControlLock(() => {
		const plan = commands.planSet(
			readControlChecked(() => undefined),
			ask,
			{
				running: lock.holder() !== null,
				now: now(),
				readExclusionWhy,
				isOptedOut,
			},
		);
		if ("write" in plan && plan.write) {
			writeControlFile(plan.write);
			const line = commands.buildSetPauseLogLine(plan, process.env);
			if (line !== null) noteSetSource(line);
		}
		if ("startFrom" in plan && plan.startFrom) updateState(runForgotten(), log);
		return plan;
	});
	const plan =
		"busy" in written
			? { refused: buildBusyRefusal(written.busy) }
			: written.done;
	if ("refused" in plan) {
		if (!json) return refuseWrite("nothing set", plan.refused);
		say(JSON.stringify(commands.buildSetJson({ refused: plan.refused })));
		return 1;
	}
	wakes.touchWake(files.wake);
	return json ? sayPlanAsJson(plan) : sayPlan(plan);
}

/** @param {import("./lib/refill-commands.js").SetPlan} plan */
function sayPlan({ lines, warning, startFrom }) {
	for (const line of lines) say(line);
	if (warning) say(`refill loop: ${buildNoticeText(warning)}`);
	return startFrom ? startProcess(startFrom, []) : 0;
}

/** @param {import("./lib/refill-commands.js").SetPlan} plan */
function sayPlanAsJson(plan) {
	const started = plan.startFrom
		? launchFrom(plan.startFrom, [])
		: { lines: [] };
	say(JSON.stringify(commands.buildSetPlanJson(plan, started)));
	return "error" in started ? 1 : 0;
}

/** @param {string} busy */
const buildBusyRefusal = (busy) => buildNotice(busy, "re-run once it finishes");

/**
 * @param {string} what
 * @param {Notice} refusal
 */
function refuseWrite(what, refusal) {
	writeFd(2, `refill loop: ${what}: ${buildNoticeText(refusal)}\n`);
	return 1;
}

/** @param {Notice} refusal */
function refuseUsage(refusal) {
	writeFd(2, `${buildNoticeText(refusal)}\n\n${USAGE}\n`);
}

/**
 * @typedef {(seat: import("./lib/refill-seats.js").OverflowSeat) =>
 *   ReturnType<typeof shownSeatBudget>} BudgetOf
 */

/**
 * @param {string|undefined} root
 * @returns {BudgetOf}
 */
function buildShownBudgets(root) {
	/** @type {Map<string, ReturnType<typeof shownSeatBudget>>} */
	const read = new Map();
	return (seat) => {
		const budget = read.get(seat.keyVar) ?? shownSeatBudget(seat, root);
		read.set(seat.keyVar, budget);
		return budget;
	};
}

/** @param {BudgetOf} budgetOf */
function readOverflowStatus(budgetOf) {
	const declared = readDeclaredSeats();
	if (declared.errors.length > 0)
		return [
			{
				seat: null,
				why: `it refuses: ${declared.errors.join("; ")}`,
			},
		];
	return overflowSeatsOf(declared.seats).map((s) =>
		commands.buildOverflowStatus(s, budgetOf(s)),
	);
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function status({ flags }) {
	const note = flags["--json"]
		? (/** @type {string} */ line) => writeFd(2, `${line}\n`)
		: log;
	const at = now();
	const control = readControlFile(note);
	const served = control ? servedRoots(control.scope).roots : [];
	const pid = lock.holder();
	const state = readState(note);
	const root = sizingRoot(served);
	const budgetOf = buildShownBudgets(root);
	const seats = readSeatsView(control?.seats ?? readConfiguredSeats(), {
		root,
		budgetOf,
		at,
	});
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
					candidates: readCandidates(homeDir()),
					burnMode: readBurnState(),
					overflow: readOverflowStatus(budgetOf),
					concurrency: withWaitingAliases(
						readConcurrencyStatus(at),
						readSeatAliases(),
					),
					now: at,
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
		now: at,
	}))
		say(line);
	for (const line of buildHoldLines(
		served.length > 0
			? loop.landingRoots(served, state.launches)
			: [readCheckout(root)],
		at,
	))
		say(line);
	sayOverflowLines(control, state, budgetOf, at);
	return 0;
}

/**
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @param {import("./lib/refill-state.js").LoopState} state
 * @param {BudgetOf} budgetOf
 * @param {number} at
 */
function sayOverflowLines(control, state, budgetOf, at) {
	const declared = readDeclaredSeats();
	for (const error of declared.errors) say(`seat file refuses: ${error}`);
	const overflow = overflowSeatsOf(declared.seats);
	for (const seat of overflow) say(buildBudgetLine(seat, budgetOf(seat)));
	if (overflow.length > 0 && declared.errors.length === 0) {
		const lines = commands.buildOverflowBasisLines({
			planSeats: (control?.seats ?? readConfiguredSeats()).map((seat) =>
				planSeatBasisOf(seatReading.readSeat(seat, at).reading),
			),
			filePlanSeats: planSeatsOf(declared.seats).map((s) => s.dir),
			omitted: readOmittedDirs(declared),
			start: state.overflowStart,
			now: at,
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
	const { DISPATCHER, tick } = loadTick();
	const { decision: d, read } = await tick({ dryRun: true });
	say(`dry run: ${loop.summaryOf(d)}`);
	if (read) say(loop.buildFrontierReadText(read));
	const { reviewRunOn } = readState(log);
	say(
		`morning review: ${loop.isReviewRunDue(new Date(), reviewRunOn) ? "the filing is due, then reversals" : "reversals only"}`,
	);
	if ("stop" in d) return 0;
	for (const r of d.resumes) say(`would resume ${r.line}`);
	for (const batch of refillBatch.batchesOf(d.launches)) {
		say(
			refillBatch.buildWouldRunLine(
				refillBatch.dispatchCall(batch, DISPATCHER, process.env),
			),
		);
	}
	for (const s of d.skipped) say(`skipped ${loop.buildSkipText(s)}`);
	return 0;
}

// #2279
/** @param {ReturnType<typeof gates.gateSweeper>} sweeper */
function startGateSweep(sweeper) {
	const control = readControlFile(log);
	if (!control || control.stopRequested) return;
	const started = sweeper.startIfDue(
		servedRoots(control.scope).roots,
		Date.now(),
	);
	started?.catch((err) => log(`gate sweep failed: ${buildErrorText(err)}`));
}

async function run() {
	const { isReviewRunning, tick } = loadTick();
	process.on("exit", lock.release);
	const held = holdRun({
		acquire: lock.acquire,
		pidFile: files.pid,
		log,
		// #4710
		now: Date.now,
		bootId: readCurrentBootId,
		updateState: (t) => updateState(t, log),
	});
	if (!held) return 0;
	for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
		process.on(sig, () => process.exit(0));
	log(`refill loop running, pid ${process.pid}, from ${SCRIPTS}`);
	const sweeper = gates.gateSweeper({
		file: files.gates,
		runRoot: async (root) => {
			const env = buildCheckoutEnv(root);
			const read = await gates.runCheckGates(root, { env });
			const line = await gates.runReleaseDue(root, { env });
			if (line) log(line);
			return read;
		},
		log,
		cadenceMs: gates.GATE_SWEEP_MS,
	});
	const updater = refillCode.codeUpdater({
		program: __filename,
		codeDir: files.code,
		log,
	});
	const watcher = wakes.wakeWatcher(files.wake, { log });
	try {
		await wakes.runTicks(async (wake) => {
			if (wake.woken)
				log(
					`${wake.recheck ? "re-checking after wake" : "woken"}${wake.sessions.length > 0 ? ` by ${wake.sessions.join(", ")}` : ""}`,
				);
			try {
				// #3765
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
				// #2012
				const done =
					"stop" in decision &&
					!loop.isRestartedSince(readControlFile(log), noProgressFrom);
				return { done, agents };
			} catch (err) {
				log(`tick failed: ${buildErrorText(err)}`);
				return { done: false, agents: null };
			}
		}, watcher);
	} finally {
		watcher.close();
	}
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
				"--hold-launches": "value",
				"--release-launches": "boolean",
				"--repos": "list",
				"--tick": "list",
				"--untick": "list",
				"--goal": "value",
				"--goal-issues": "value",
				"--goal-text": "value",
				"--clear-goal": "boolean",
				"--json": "boolean",
			},
		},
		status: { usage: USAGE, flags: { "--json": "boolean" } },
		"dry-run": { usage: USAGE },
		run: { usage: USAGE },
		"boot-resume": { usage: USAGE },
		watch: { usage: USAGE },
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
	watch,
};

async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") {
		process.exitCode = parsed;
		return;
	}
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
