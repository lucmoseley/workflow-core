#!/usr/bin/env node
/*
 * refill-loop.js — the refill loop (workflow-core#2012, workflow-core#2123, spec workflow-core#1995): one detached
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
 * A TICK: reap (the reaper's --not-a-session mode, since the loop has no
 * session id), stop each job that never started, judge the loop's finished
 * launches for progress, read
 * admission, the allowance per seat and what its cap would launch, and
 * founder presence, ask lib/refill-decide.js, and launch each repo's picks
 * through one dispatch-sessions.sh call in its checkout, so that repo's ledger,
 * duplicate drop, memory re-read and allowance cap apply. The decision core
 * is asked first with an empty frontier: the per-repo shortlists cost GitHub
 * calls, so they are read only on a tick that could launch. Last, the
 * morning review generator runs: in full on the first tick after 07:00,
 * answering reversals only on every other (workflow-core#2017).
 *
 * SEATS, in failover order, are the plan seats `~/.claude/refill-seats`
 * declares (lib/refill-seats.js), else the seat `start` ran on alone. Host
 * configuration, not code, because the plugin ships to adopters. Every
 * listing the loop and its reaper read must span them all, so the loop takes
 * the union oracle as dispatch-sessions.sh does where WFC_CLAUDE_BIN is
 * unset. Without that wrapper, a launch on a seat other than the loop's own
 * is unlisted and judged finished once its grace passes.
 *
 * CODE: in a git checkout, the loop runs from a detached worktree of its own
 * at the verified ref's tip, never from the checkout `start` was typed in, and
 * between ticks adopts a newer tip that changes its code by re-exec under the
 * same pid, keeping its lock, control, state and gate store
 * (lib/refill-code.js, workflow-core#2361). Not while a gate sweep it started runs or a
 * stop is pending. From a
 * plugin install it does neither: its code changes only with a release bump.
 *
 * Joins no §N3 family: it is a daemon, not a checker or a guard. A failed
 * read inside a tick is logged and the tick carries on with what it has; a
 * tick that throws is logged and the next one runs.
 *
 * Exit codes: 0; 1 on a throw outside the loop; 2 on a command line or, at
 * `start`, a seat file it refuses.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedAgents } = require("./lib/agent-liveness.js");
const { driftLines, registryAgents } = require("./lib/registry-agents.js");
const { actsBy } = require("./lib/arbiter-store.js");
const { PROBE_TIMEOUT_MS } = require("./lib/usage-probe.js");
const { readAllowance } = require("./lib/allowance.js");
const { caught } = require("./lib/caught.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const refillCode = require("./lib/refill-code.js");
const gates = require("./lib/gate-sweep.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { recentEntries } = require("./lib/dispatch-ledger.js");
const { hostRoot } = require("./lib/host-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const { readJobs } = require("./lib/hung-jobs.js");
const { stopOn } = require("./lib/claude-stop.js");
const { lastTypedAt } = require("./lib/presence.js");
const {
	NOTHING_LAUNCHABLE,
	RUN_MS,
	decideTick,
} = require("./lib/refill-decide.js");
const { refillFrontier } = require("./lib/refill-frontier.js");
const { budgetLine, seatBudget } = require("./lib/overflow-budget.js");
const { declaredSeats } = require("./lib/refill-seats.js");
const wakes = require("./lib/refill-wake.js");
const {
	checkoutEnv,
	discoverRepos,
	exclusionOf,
	homeDir,
} = require("./lib/refill-repos.js");
const loop = require("./lib/refill-loop.js");
const { localDate } = require("./lib/morning-review.js");
const { scriptPath } = require("./lib/script-path.js");
const { forgetSession } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");

/* Every child but the review and the `/usage` probe; untraced. */
const CHILD_TIMEOUT_MS = 120 * 1000;
/* The probe's ceiling plus node's start, so the probe meets its own ceiling
 * and stops its group before this one kills the wrapper; the 15 s is a guess. */
const PROBE_CHILD_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15 * 1000;
/* Untraced: room for the full review's reads of every included repo's closes
 * with their comments, kept under the dispatch ceiling since it holds the tick. */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
/* Untraced: the loop's log is cut to its newer half past this. */
const LOG_MAX_BYTES = 1024 * 1024;
/* The ledger's own hour, ample for one dispatcher call. */
const LEDGER_WINDOW_HOURS = 1;

const SCRIPTS = __dirname;
/* The checkout the loop's own scripts sit in, workflow-core's, whose tracker
 * spec workflow-core#1995 files the review on. A plugin install has no config there and
 * runs no review. */
const REVIEW_ROOT = path.dirname(SCRIPTS);
const DISPATCHER = path.join(SCRIPTS, "dispatch-sessions.sh");
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

/** @param {string} text */
const indented = (text) => text.replace(/\n/g, "\n  ");

/** @param {unknown} err */
const errText = (err) =>
	err instanceof Error ? (err.stack ?? err.message) : String(err);

const readControl = () => loop.parseControl(loop.readJson(files.control));

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 */
function runChild(file, args, opts = {}) {
	const r = spawnSync(file, args, {
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
		...opts,
	});
	const failed = r.error ? ` (${r.error.message})` : "";
	return {
		status: r.status,
		stdout: String(r.stdout ?? ""),
		stderr: String(r.stderr ?? ""),
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
		failed: r.status === 0 ? null : `exit ${r.status}${failed}`,
	};
}

/**
 * The plan seats lib/refill-seats.js reads, else the seat this runs on, as
 * where the seat file refuses. An overflow seat is declared but not yet
 * launched on, so it is not listed.
 */
function configuredSeats() {
	const { seats, errors } = declaredSeats();
	const listed =
		errors.length > 0
			? []
			: seats.filter((s) => s.kind === "plan").map((s) => s.dir);
	if (listed.length > 0) return listed;
	return [process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), ".claude")];
}

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
 * so a checkout elsewhere is never served (workflow-core#2123).
 * @param {string[]} names
 */
function checkoutsNamed(names) {
	const roots = [];
	for (const name of names) {
		const root = path.join(homeDir(), name);
		if (
			name.includes("/") ||
			!fs.existsSync(path.join(root, ".claude", "workflow-core.json"))
		)
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
	const goal = goalText
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((s) => Number(s.replace(/^#/, "")));
	if (goal.some((n) => !Number.isInteger(n) || n <= 0))
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
	 * dropping its scope (workflow-core#2123). */
	const running = pid !== null && prior && !prior.stopRequested ? prior : null;
	const { scope, renew } = loop.mergedScope(
		running?.scope ?? null,
		asked,
		root,
	);
	/** @type {import("./lib/refill-loop.js").Control} */
	const control = {
		startedAt: running && !renew ? running.startedAt : Date.now(),
		stopRequested: false,
		seats: configuredSeats(),
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
	const { errors } = declaredSeats();
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
	const scopeText = loop
		.scopeLines(control, {
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

/**
 * The roots a scope serves now.
 * @param {import("./lib/refill-loop.js").Scope} scope
 */
const servedRoots = (scope) =>
	loop.scopeRoots(scope, () => discoverRepos(homeDir()).included, exclusionOf);

function status() {
	const control = readControl();
	const pid = lock.holder();
	for (const line of loop.statusLines({
		control,
		state: loop.parseState(loop.readJson(files.state)),
		pid,
		codeSha: pid === null ? null : refillCode.runningCode(pid, files.code),
		runMs: RUN_MS,
		served: control ? servedRoots(control.scope).roots : [],
	}))
		say(line);
	for (const seat of declaredSeats().seats)
		if (seat.kind === "overflow") say(budgetLine(seat, seatBudget(seat)));
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

/** @param {boolean} dryRun */
function reapFinished(dryRun) {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "reap-finished-sessions.js"),
		"--not-a-session",
		...(dryRun ? ["--dry-run"] : []),
	]);
	if (r.out) log(indented(r.out));
	if (r.failed) log(`reap: ${r.failed}`);
}

/**
 * Stop the working jobs with no live process and no transcript past the grace
 * (lib/refill-loop.js's stopNeverStarted, workflow-core#2467): admission charges each a
 * full session until it goes. The log lines.
 * @param {import("./lib/registry-agents.js").RegistryListing} registry
 */
function stopNeverStarted(registry) {
	return loop.stopNeverStarted(registry, readJobs(), (j) => {
		const r = stopOn(j.seat, j.job);
		return r.ok ? null : r.why;
	});
}

/**
 * Admission's free slots, read as the dispatcher's re-read reads them
 * (lib/refill-loop.js's FREE_SLOT_ARGS); 0 where it could not judge, so a
 * broken read launches nothing (workflow-core#2012).
 */
function freeSlots() {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "admission.js"),
		...loop.FREE_SLOT_ARGS,
	]);
	try {
		const verdict = JSON.parse(r.stdout);
		return verdict.ok ? Number(verdict.slots) || 0 : 0;
	} catch {
		log(`admission unreadable: ${r.failed ?? ""} ${r.out.split("\n")[0]}`);
		return 0;
	}
}

/**
 * Each seat's reading (lib/refill-loop.js's seatReadingOf). `usage` maps a
 * seat to a printed `/usage`, the fallback when its cache is stale.
 * @param {string[]} seats
 * @param {Map<string, string>} [usage]
 * @returns {import("./lib/refill-loop.js").SeatReading[]}
 */
function seatReadings(seats, usage = new Map()) {
	const now = Date.now();
	return seats.map((seat) =>
		loop.seatReadingOf(
			seat,
			readAllowance({ configDir: seat, usageText: usage.get(seat), now }),
			now,
		),
	);
}

/**
 * A printed `/usage` per seat named, through the dispatcher's own probe
 * (scripts/usage-probe.js, workflow-core#2306): empty where it found the cache fresh or
 * stopped once it refreshed it, with each probe's outcome. A failed one is
 * logged and leaves that seat unread, so the tick waits on it. Timed out, the
 * wrapper's SIGTERM stops the probe's group too.
 * @param {string[]} seats
 */
function printedUsage(seats) {
	const usage = new Map();
	/** @type {import("./lib/refill-loop.js").Probe[]} */
	const probes = [];
	for (const seat of seats) {
		const r = runChild(
			process.execPath,
			[path.join(SCRIPTS, "usage-probe.js"), "--config-dir", seat],
			{ timeout: PROBE_CHILD_TIMEOUT_MS },
		);
		// Exit 3 is the probe's "none ran, the cache being fresh".
		if (r.failed && r.status !== 3) log(`/usage on ${seat}: ${r.failed}`);
		usage.set(seat, r.stdout);
		probes.push({ seat, outcome: loop.parseProbeOutcome(r.stderr, r.failed) });
	}
	return { usage, probes };
}

/**
 * How many of `members` the dispatcher's allowance cap launches on `seat`,
 * read through the `allowance.js --cap` call it makes, fed the seat's printed
 * `/usage` as the dispatcher feeds its probe's; null, logged, where it cannot
 * be sized.
 * @param {string} seat
 * @param {number} members
 * @param {string} usageText
 */
function capFits(seat, members, usageText) {
	const r = runChild(
		process.execPath,
		[
			path.join(SCRIPTS, "allowance.js"),
			...loop.capArgs(seat, members, loop.ceilingsOf(process.env)),
		],
		{ input: usageText, env: { ...process.env, CLAUDE_CONFIG_DIR: seat } },
	);
	const cap = loop.capFitsOf(r.stdout);
	if (cap.fits === null)
		log(
			`cap on ${seat} unsized: ${cap.why}${r.failed ? ` (${r.failed})` : ""}`,
		);
	return cap.fits;
}

/**
 * Each seat's reading, refreshed and sized for this tick by
 * lib/refill-loop.js's readSizedSeats; with the refreshing probes' outcomes.
 * @param {string[]} seats
 * @param {number} slots
 */
function readSeats(seats, slots) {
	return loop.readSizedSeats(slots, {
		read: (usage) => seatReadings(seats, usage),
		probe: printedUsage,
		sizeOf: capFits,
	});
}

/**
 * Launch one repo's picks through one dispatcher call (lib/refill-loop.js's
 * launchBatch), logged; the records of those it launched and the reasons for
 * those it refused, with each it tried taken off the gate-judgement queue.
 * @param {import("./lib/refill-decide.js").Launch[]} batch
 */
function launchBatch(batch) {
	const r = loop.launchBatch(batch, {
		dispatcher: DISPATCHER,
		env: process.env,
		run: (call) =>
			runChild(call.file, call.args, {
				cwd: call.cwd,
				env: call.env,
				timeout: call.timeout,
			}),
		entriesOf: (root) => recentEntries(root, LEDGER_WINDOW_HOURS).entries,
	});
	log(
		`dispatch ${loop.launchesLine(batch)}: ${r.failed ?? "exit 0"}\n  ${indented(r.out)}`,
	);
	gates.dropTried(files.gates, r.tried);
	return { launched: r.launched, refused: r.refused };
}

/**
 * Run the morning review generator: in full where due, else for reversals
 * only, returning the date of the last full run (lib/refill-loop.js's
 * reviewRunRecorded). A missing config at REVIEW_ROOT is logged once a day.
 * @param {string|null} lastRunOn
 * @param {number} now
 */
function runReview(lastRunOn, now) {
	const due = loop.isReviewRunDue(new Date(now), lastRunOn);
	const today = localDate(new Date(now));
	if (!fs.existsSync(path.join(REVIEW_ROOT, ".claude", "workflow-core.json"))) {
		if (due)
			log(
				`morning review: not run, ${REVIEW_ROOT} has no workflow-core config`,
			);
		return due ? today : lastRunOn;
	}
	const r = runChild(
		process.execPath,
		[
			path.join(SCRIPTS, "file-morning-review.js"),
			...(due ? [] : ["--reversals-only"]),
		],
		{
			cwd: REVIEW_ROOT,
			env: checkoutEnv(REVIEW_ROOT),
			timeout: REVIEW_TIMEOUT_MS,
		},
	);
	if (due || r.out || r.failed)
		log(
			`morning review${due ? "" : " reversals"}: ${r.failed ?? "exit 0"}\n  ${indented(r.out)}`,
		);
	return loop.reviewRunRecorded({ due, status: r.status, lastRunOn, today });
}

/**
 * The launches judged against this tick's listing (lib/refill-loop.js's
 * judgedLaunches), each newly finished one's acts read from every served
 * repo's store and its own, and logged.
 * @param {import("./lib/refill-loop.js").LoopLaunch[]} launches
 * @param {import("./lib/agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {string[]} served
 */
function judgeFinished(launches, agents, now, served) {
	return loop.judgedLaunches(launches, agents, now, (l) => {
		const progress = loop.actsOf(l, [...new Set([...served, l.root])], actsBy);
		log(loop.finishLine({ ...l, ...progress }));
		return progress;
	});
}

/**
 * The decision, reading the shortlists only where the tick could launch, and
 * that read's size and time, null where it was not read.
 * @param {import("./lib/refill-decide.js").TickInput} input
 * @param {import("./lib/refill-loop.js").Scope} scope
 * @returns {Promise<{decision: import("./lib/refill-decide.js").Decision,
 *   read: import("./lib/refill-loop.js").FrontierRead|null}>}
 */
async function decide(input, scope) {
	const first = decideTick(input);
	/* A tick launching gate judgements alone may still have slots for the
	 * ranking, so it reads the shortlists too. */
	if (
		"stop" in first ||
		(first.idle !== null && first.idle !== NOTHING_LAUNCHABLE)
	)
		return { decision: first, read: null };
	const served = servedRoots(scope);
	for (const d of served.dropped) log(`not served: ${d.root} (${d.why})`);
	const readStart = Date.now();
	const merged = await refillFrontier(served.roots, scope.goals);
	const read = { rows: merged.frontier.length, ms: Date.now() - readStart };
	for (const f of merged.failed)
		log(`shortlist failed in ${f.root}: ${f.error}`);
	for (const h of merged.held)
		log(
			`held outside the loop: ${h.ref} (${h.why}), holding ${h.holds.join(", ")}`,
		);
	const decision = decideTick({
		...input,
		frontier: /** @type {import("./lib/refill-decide.js").MergedRow[]} */ (
			merged.frontier
		),
		retroBundles: merged.retroBundles,
	});
	return { decision, read };
}

/**
 * One tick: its decision and the start it judged against. Under `dryRun`
 * nothing is reaped, launched or written.
 * @param {{dryRun: boolean}} opts
 */
async function tick({ dryRun }) {
	const now = Date.now();
	const control = readControl() ?? {
		startedAt: now,
		/* No control file is a loop nobody started: a real tick stops. */
		stopRequested: !dryRun,
		seats: configuredSeats(),
		scope: loop.parseScope(null),
	};
	reapFinished(dryRun);
	const state = loop.parseState(loop.readJson(files.state));
	const served = servedRoots(control.scope).roots;
	/* Relief first, off the registry alone: the CLI listing below can outrun
	 * its caps under the very pressure relief exists for (workflow-core#2665). */
	const registry = registryAgents();
	if (!dryRun) for (const line of stopNeverStarted(registry)) log(line);
	const agents = listedAgents({ requireSelf: false }).agents ?? null;
	/* Read side by side here anyway, so the undocumented registry the relief
	 * steps trust is checked against the documented listing every tick. */
	if (agents) for (const line of driftLines(agents, registry.agents)) log(line);
	const judged = judgeFinished(state.launches, agents, now, served);
	const slots = freeSlots();
	const { seats, probes } = readSeats(control.seats, slots);
	/** @type {import("./lib/refill-decide.js").TickInput} */
	const input = {
		now,
		startedAt: control.startedAt,
		stopRequested: control.stopRequested,
		frontier: [],
		retroBundles: [],
		running: loop.runningOf(judged),
		freeSlots: slots,
		lastPromptAt: lastTypedAt(),
		seats,
		history: judged,
		judgements: gates
			.readGateStore(files.gates)
			.pending.filter((j) => served.includes(j.root)),
	};
	const { decision, read } = await decide(input, control.scope);
	if (dryRun) return { decision, read, startedAt: control.startedAt, agents };
	const settled = loop.settleTick(
		{ input, decision, state, judged, probes, read },
		{
			readControl,
			launchBatch,
			runReview,
			writeState: (next) => loop.writeJson(files.state, next),
			log,
		},
	);
	return { decision: settled, startedAt: control.startedAt, agents };
}

async function printDryRun() {
	const { decision: d, read } = await tick({ dryRun: true });
	say(`dry run: ${loop.summaryOf(d)}`);
	if (read) say(loop.frontierReadText(read));
	const { reviewRunOn } = loop.parseState(loop.readJson(files.state));
	say(
		`morning review: ${loop.isReviewRunDue(new Date(), reviewRunOn) ? "the full run is due" : "reversals only"}`,
	);
	if ("stop" in d) return 0;
	for (const batch of loop.batchesOf(d.launches)) {
		const call = loop.dispatchCall(batch, DISPATCHER, process.env);
		say(
			`would run in ${call.cwd} on ${call.env.CLAUDE_CONFIG_DIR}: ${call.file} ${call.args.join(" ")}`,
		);
	}
	for (const s of d.skipped) say(`skipped ${loop.skipText(s)}`);
	return 0;
}

/**
 * Start the gate sweep where it is due, never waiting on it: one `check:` may
 * run to its budget, which no tick may wait out (workflow-core#2279).
 * @param {ReturnType<typeof gates.gateSweeper>} sweeper
 */
function startGateSweep(sweeper) {
	const control = readControl();
	if (!control || control.stopRequested) return;
	const started = sweeper.startIfDue(
		servedRoots(control.scope).roots,
		Date.now(),
	);
	/* Logged, never thrown: a sweep that fails leaves the stored readings as
	 * they were, and the next due sweep runs afresh (workflow-core#2279). */
	started?.catch((err) => log(`gate sweep failed: ${errText(err)}`));
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
			log(`tick failed: ${errText(err)}`);
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
			writeFd(2, `${errText(err)}\n`);
			process.exit(1);
		},
	);
