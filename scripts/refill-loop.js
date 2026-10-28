#!/usr/bin/env node
/*
 * refill-loop.js — the refill loop (#2012, #2123, spec #1995): one detached
 * process per machine that, each time a session it launched ends and at
 * least every 5 minutes (lib/refill-wake.js), reaps finished sessions and
 * launches the next tickets into free slots across the repos its scope
 * serves (lib/refill-loop.js's Scope).
 *
 *   node scripts/refill-loop.js start …  start the loop, or renew a running
 *                                        loop's 24 hours; modes in USAGE
 *   node scripts/refill-loop.js stop     end launching before the next
 *                                        dispatch call; running sessions
 *                                        finish
 *   node scripts/refill-loop.js status   mode, repos, goal, stop time,
 *                                        launches, the last stop reason and
 *                                        each overflow seat's budget
 *   node scripts/refill-loop.js dry-run  one tick's decision, printed; reaps
 *                                        and launches nothing
 *
 * Each tick, and the seats it reads, are lib/refill-tick.js's; what `start`
 * and `status` print, lib/refill-commands.js's.
 *
 * UNION ORACLE: every listing the loop and its reaper read must span all its
 * seats, so the loop takes the union oracle as dispatch-sessions.sh does
 * where WFC_CLAUDE_BIN is unset. Without that wrapper, a launch on a seat
 * other than the loop's own is unlisted and judged finished once its grace
 * passes.
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
 * Exit codes: 0; 1 on a throw outside the loop; 2 on a command line or, at
 * `start`, a seat file it refuses.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const refillCode = require("./lib/refill-code.js");
const gates = require("./lib/gate-sweep.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const { hasConfig } = require("./lib/workflow-core-config.js");
const { RUN_MS } = require("./lib/refill-decide.js");
const { buildBudgetLine, seatBudget } = require("./lib/overflow-budget.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
} = require("./lib/refill-seats.js");
const wakes = require("./lib/refill-wake.js");
const { parseIssueNumbers } = require("./lib/issue-number.js");
const { checkoutEnv, exclusionOf, homeDir } = require("./lib/refill-repos.js");
const loop = require("./lib/refill-loop.js");
const refillBatch = require("./lib/refill-batch.js");
const { scriptPath } = require("./lib/script-path.js");
const { forgetSession } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");
const commands = require("./lib/refill-commands.js");
const { DISPATCHER, servedRoots, tick } = require("./lib/refill-tick.js");

/* Untraced: the loop's log is cut to its newer half past this. */
const LOG_MAX_BYTES = 1024 * 1024;

const SCRIPTS = __dirname;
const USAGE = `usage: node ${scriptPath("refill-loop.js")} start | stop | status | dry-run
  start [--repo <dir>]… [--goal 116,117]       normal mode: this checkout plus each named one
  start --away [--exclude <dir>]… [--goal …]   away mode: every included checkout but those named
  <dir> is a checkout's directory name in the home directory`;

const files = loop.loopFiles();
const lock = pidLock(files.pid, "refill-loop.js");

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const log = (line) => say(`${new Date().toISOString()} ${line}`);

/** @param {unknown} err */
const parseErrText = (err) =>
	err instanceof Error ? (err.stack ?? err.message) : String(err);

const readControl = () => loop.readControlFile(log);

/**
 * The listing oracle every seat's sessions show in: WFC_CLAUDE_BIN, else the
 * union wrapper where it is installed.
 * @param {NodeJS.ProcessEnv} env
 */
function withUnionOracle(env) {
	if (env.WFC_CLAUDE_BIN) return env;
	const wrapper =
		env.WFC_UNION_WRAPPER ||
		path.join(homeDir(), ".local", "bin", "claude-agents-union");
	return fs.existsSync(wrapper) ? { ...env, WFC_CLAUDE_BIN: wrapper } : env;
}

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
	const prior = readControl();
	/* A loop whose stop is pending is ending: this start begins afresh,
	 * dropping its scope (#2123). */
	const running = pid !== null && prior && !prior.stopRequested ? prior : null;
	const { scope, renew } = commands.mergedScope(
		running?.scope ?? null,
		asked,
		root,
	);
	/** @type {import("./lib/refill-loop.js").Control} */
	const control = {
		startedAt: running && !renew ? running.startedAt : Date.now(),
		stopRequested: false,
		seats: readConfiguredSeats(),
		scope,
	};
	return { control, renewed: renew };
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
	const pid = lock.holder();
	const { control, renewed } = buildNextControl(pid, asked, root);
	loop.writeJson(files.control, control);
	wakes.touchWake(files.wake);
	const scopeText = commands
		.buildScopeLines(control, {
			runMs: RUN_MS,
			served: servedRoots(control.scope).roots,
			running: true,
		})
		.map((l) => `  ${l}`);
	if (pid !== null) {
		say(
			renewed
				? `refill loop renewed: pid ${pid}`
				: `refill loop: away mode is running and is left as it is, bar this checkout's goal; pid ${pid}`,
		);
		for (const line of scopeText) say(line);
		return 0;
	}
	const launch = refillCode.launchProgram({
		scriptsDir: SCRIPTS,
		codeDir: files.code,
	});
	if ("error" in launch) {
		writeFd(2, `refill loop not started: ${launch.error}\n`);
		return 1;
	}
	if (launch.fetchError)
		say(`fetch failed, starting on the last fetched tip: ${launch.fetchError}`);
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
	say(`refill loop started: pid ${child.pid}`);
	for (const line of scopeText) say(line);
	if (!env.WFC_CLAUDE_BIN && control.seats.length > 1)
		say(
			"WARNING: no union oracle, so launches on a seat other than this one go unlisted and are judged finished early.",
		);
	say(`log: ${files.log}`);
	return 0;
}

function stop() {
	const control = readControl();
	const pid = lock.holder();
	if (control)
		loop.writeJson(files.control, { ...control, stopRequested: true });
	if (pid !== null) wakes.touchWake(files.wake);
	say(
		pid === null
			? "refill loop: not running"
			: `refill loop: stop requested; pid ${pid} makes no further dispatch call and exits when the tick in flight ends, or where none is, at the tick this stop wakes; a dispatch or the morning review can hold a tick for minutes. Running sessions finish.`,
	);
	return 0;
}

function status() {
	const control = readControl();
	const pid = lock.holder();
	for (const line of commands.buildStatusLines({
		control,
		state: loop.parseState(loop.readJson(files.state, log)),
		pid,
		codeSha: pid === null ? null : refillCode.readRunningCode(pid, files.code),
		runMs: RUN_MS,
		served: control ? servedRoots(control.scope).roots : [],
	}))
		say(line);
	for (const seat of readDeclaredSeats().seats)
		if (seat.kind === "overflow") say(buildBudgetLine(seat, seatBudget(seat)));
	return 0;
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
	const { reviewRunOn } = loop.parseState(loop.readJson(files.state, log));
	say(
		`morning review: ${loop.isReviewRunDue(new Date(), reviewRunOn) ? "the filing is due, then reversals" : "reversals only"}`,
	);
	if ("stop" in d) return 0;
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
	const control = readControl();
	if (!control || control.stopRequested) return;
	const started = sweeper.startIfDue(
		servedRoots(control.scope).roots,
		Date.now(),
	);
	/* A sweep that fails leaves the readings of the checkout it failed on, and
	 * any after it, as they were, and the next due sweep runs afresh (#2279). */
	started?.catch((err) => log(`gate sweep failed: ${parseErrText(err)}`));
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
			/* Before the sweep starts, so the image it replaces has no child. */
			updater?.adoptIfMoved({
				hold: sweeper.busy() || readControl()?.stopRequested === true,
			});
			startGateSweep(sweeper);
			const { decision, startedAt, agents } = await tick({ dryRun: false });
			updater?.afterTick();
			/* A `start` that landed mid-tick saw this pid and spawned nothing,
			 * so the stop it overtook must not end the loop. */
			const done =
				"stop" in decision && !loop.isRenewedSince(readControl(), startedAt);
			return { done, agents };
		} catch (err) {
			log(`tick failed: ${parseErrText(err)}`);
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
		status: { usage: USAGE },
		"dry-run": { usage: USAGE },
		run: { usage: USAGE },
	},
};

const COMMANDS = {
	start,
	stop,
	status,
	"dry-run": printDryRun,
	run,
};

async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") {
		process.exitCode = parsed;
		return;
	}
	Object.assign(process.env, withUnionOracle(process.env));
	/* cli-args.js refuses a command not declared, so one is always named. */
	const command = /** @type {keyof typeof COMMANDS} */ (parsed.command);
	process.exitCode = await COMMANDS[command](parsed);
}

module.exports = { main };

if (require.main === module)
	main().then(
		() => process.exit(),
		(err) => {
			writeFd(2, `${parseErrText(err)}\n`);
			process.exit(1);
		},
	);
