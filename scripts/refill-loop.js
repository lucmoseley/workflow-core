#!/usr/bin/env node
/*
 * refill-loop.js — the refill loop (#2012, #2123, spec #1995): one detached
 * process per machine that, each time a session it launched ends and at
 * least every 5 minutes (lib/refill-wake.js), reaps finished sessions and
 * launches the next tickets into free slots across the repos its scope
 * serves (lib/refill-loop.js's Scope).
 *
 *   node scripts/refill-loop.js start …  start the loop, or widen a running
 *                                        loop's scope; modes in USAGE
 *   node scripts/refill-loop.js stop     end launching before the next
 *                                        dispatch call; running sessions
 *                                        finish
 *   node scripts/refill-loop.js set --pause | --resume  pause or resume launching
 *                                        with no restart: the running loop takes
 *                                        it at its next tick, and an idle loop
 *                                        within seconds; housekeeping carries on
 *   node scripts/refill-loop.js status   pause, mode, repos, goal, launches with
 *                                        their seats, the
 *                                        last stop reason, open repo holds
 *                                        (lib/repo-holds.js), each overflow
 *                                        seat's budget and the plan seats
 *                                        overflow rests on; `--json` the launch
 *                                        rows and the `seats:` line's fields
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
 * wait or, at `set`, no sound control to change; 2 on a command line or, at
 * `start`, a seat file it refuses.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./lib/caught.js");
const refillCode = require("./lib/refill-code.js");
const gates = require("./lib/gate-sweep.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const { hasConfig } = require("./lib/workflow-core-config.js");
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
const { parseIssueNumbers } = require("./lib/issue-number.js");
const { configDir, seatDir } = require("./lib/config-dir.js");
const { readLastTyped } = require("./lib/presence.js");
const { checkoutEnv, exclusionOf, homeDir } = require("./lib/refill-repos.js");
const loop = require("./lib/refill-loop.js");
const { bootVerdictOf } = require("./lib/refill-boot.js");
const {
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
  start [--repo <dir>]… [--goal 116,117]       normal mode: this checkout plus each named one
  start --away [--exclude <dir>]… [--goal …]   away mode: every included checkout but those named
  set --pause | --resume                       launch nothing, keeping housekeeping; or launch again
  status [--json]                              --json: the launch rows, each with its seat and why, and the seats line's fields
  <dir> is a checkout's directory name in the home directory`;

const lock = pidLock(files.pid, "refill-loop.js");

/**
 * The checkout roots `names` give, each a directory in the home directory
 * carrying a workflow-core config: discovery's own reach (lib/refill-repos.js),
 * so a checkout elsewhere is never served (#2123).
 * @param {string[]} names
 */
function checkoutsNamed(names) {
	const roots = [];
	for (const name of names) {
		const root = path.join(homeDir(), name);
		if (name.includes("/") || !hasConfig(root))
			return `${name} is no workflow-core checkout in ${homeDir()}`;
		roots.push(root);
	}
	return roots;
}

/**
 * The scope `start`'s flags ask for from `root`, or a string refusal.
 * @param {import("./lib/cli-args").Parsed} parsed
 * @param {string} root
 * @returns {import("./lib/refill-loop.js").Scope|string}
 */
function parseStartScope(parsed, root) {
	const away = parsed.flags["--away"] === true;
	const repos = parsed.lists["--repo"] ?? [];
	const exclude = parsed.lists["--exclude"] ?? [];
	if (away && repos.length > 0)
		return "--repo is normal mode's; away mode serves every included checkout";
	if (!away && exclude.length > 0) return "--exclude needs --away";
	const goalText = String(parsed.flags["--goal"] ?? "");
	const words = parseIssueNumbers(goalText);
	const goal = words.flatMap((n) => (n !== null && n > 0 ? [n] : []));
	if (goal.length < words.length)
		return `--goal takes issue numbers: ${goalText}`;
	const named = checkoutsNamed(away ? exclude : repos);
	if (typeof named === "string") return named;
	const goals = goal.length > 0 ? { [root]: goal } : {};
	return away
		? { mode: "away", repos: [], exclude: named, goals }
		: { mode: "normal", repos: [root, ...named], exclude: [], goals };
}

/**
 * The control `start` writes.
 * @param {number|null} pid the running loop's
 * @param {import("./lib/refill-loop.js").Scope} asked
 * @param {string} root
 */
function buildNextControl(pid, asked, root) {
	const prior = readControlFile(log);
	/* A loop whose stop is pending is ending: this start begins afresh,
	 * dropping its scope (#2123). */
	const running = pid !== null && prior && !prior.stopRequested ? prior : null;
	/** @type {import("./lib/refill-loop.js").Control} */
	return {
		noProgressFrom: running?.noProgressFrom ?? Date.now(),
		stopRequested: false,
		/* A start never undoes a pause: `set --resume` is its one way off (#3856). */
		...(prior?.paused ? { paused: prior.paused } : {}),
		seats: readConfiguredSeats(),
		scope: commands.mergedScope(running?.scope ?? null, asked, root),
	};
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
	if (excluded !== null) {
		say(`refill loop not started: this checkout is not served (${excluded})`);
		return 0;
	}
	const asked = parseStartScope(parsed, root);
	if (typeof asked === "string") {
		writeFd(2, `${asked}\n\n${USAGE}\n`);
		return 2;
	}
	const { errors } = readDeclaredSeats();
	if (errors.length > 0) {
		writeFd(
			2,
			`refill loop not started: the seat file refuses\n${errors.map((e) => `  ${e}\n`).join("")}`,
		);
		return 2;
	}
	const written = withControlLock(() => {
		const pid = lock.holder();
		const control = buildNextControl(pid, asked, root);
		writeControlFile(control);
		return { pid, control };
	});
	if ("busy" in written) return refuseWrite("not started", written.busy);
	const { pid, control } = written.done;
	wakes.touchWake(files.wake);
	const served = servedRoots(control.scope).roots;
	const scopeText = commands
		.buildScopeLines(control, {
			served,
			running: true,
			seatsLine: commands.buildSeatsLine(
				readSeatsView(
					control.seats,
					sizingRoot(served),
					seatDir(configDir(), homeDir()),
				),
				Date.now(),
			),
		})
		.map((l) => `  ${l}`);
	if (pid !== null) {
		say(commands.buildRunningLine(asked.mode, control.scope.mode, pid));
		for (const line of scopeText) say(line);
		return 0;
	}
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
		if (control) writeControlFile({ ...control, stopRequested: true });
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
 * `set`: the named field changed on a fresh read under the control lock, then
 * the wake touched.
 * @param {import("./lib/cli-args").Parsed} parsed
 */
function set({ flags }) {
	const pause = flags["--pause"] === true;
	if (pause === (flags["--resume"] === true)) {
		writeFd(2, `set takes one of --pause and --resume\n\n${USAGE}\n`);
		return 2;
	}
	const written = withControlLock(() => {
		const plan = commands.planSet(
			readControlChecked(() => undefined),
			{
				pause,
				running: lock.holder() !== null,
				now: Date.now(),
			},
		);
		if ("write" in plan && plan.write) writeControlFile(plan.write);
		return plan;
	});
	if ("busy" in written) return refuseWrite("nothing set", written.busy);
	if ("refused" in written.done) {
		return refuseWrite("nothing set", written.done.refused);
	}
	wakes.touchWake(files.wake);
	for (const line of written.done.lines) say(line);
	return 0;
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
	const control = readControlFile(log);
	const served = control ? servedRoots(control.scope).roots : [];
	const pid = lock.holder();
	const state = readStateFile(log);
	const root = sizingRoot(served);
	const seats = readSeatsView(control?.seats ?? readConfiguredSeats(), root);
	if (flags["--json"]) {
		say(
			JSON.stringify(commands.buildStatusJson({ control, state, pid, seats })),
		);
		return 0;
	}
	for (const line of commands.buildStatusLines({
		control,
		state,
		pid,
		codeSha: pid === null ? null : refillCode.readRunningCode(pid, files.code),
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
			 * spawned nothing, so that stop must not end the loop. Residual: one
			 * landing on a no-progress or allowance stop moves nothing, so it prints
			 * `running` and the loop still exits, until #3859 removes those stops. */
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
				"--away": "boolean",
				"--repo": "list",
				"--exclude": "list",
				"--goal": "value",
			},
		},
		stop: { usage: USAGE },
		set: {
			usage: USAGE,
			flags: { "--pause": "boolean", "--resume": "boolean" },
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
