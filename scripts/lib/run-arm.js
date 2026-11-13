/*
 * run-arm.js — the core of scripts/run-arm-test.js, the before/after test's
 * runner (#2045, `docs/research/startup-load-before-after-test.md` D2–D5;
 * core and shell, #5149). The program's header says what each subcommand
 * does; this module does it on the ports it is handed and returns the exit
 * status, and the shell wires the production adapters.
 *
 * Its lines go out through `out` and `err` as they happen, not returned at
 * the end: `run` loops for hours, and its log of each pair started, held or
 * stopped is read while it runs.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing and files no issue, and it
 * writes outside the repo.
 */

const fs = require("node:fs");
const { scriptPath } = require("./script-path.js");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { flagValue } = require("./cli-args");
const { launchAuthRefusal } = require("./launch-auth.js");
const { isTerminalAgent } = require("./agent-liveness.js");
const { forgetSession } = require("./session-id.js");
const { CHILD_ERROR_CHARS } = require("./child-buffer.js");
const { stopOn } = require("./claude-stop.js");
const { buildSeatEnv, runClaude } = require("./seat-claude.js");
const { claudeBin } = require("./claude-bin.js");
const { readClaudeVersionOrWhy } = require("./claude-version.js");
const { jobDirPath } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const {
	geoComparison,
	heterogeneity,
	mannWhitney,
	mantelHaenszel,
	meanVar,
	poissonArm,
	runsPerArm,
	withinTask,
} = require("./arm-stats.js");
const {
	DENY_GUARD_JOIN,
	INVENTORY,
	JOB_DIR,
	MIXED,
	MOVED,
	UNATTRIBUTED,
} = require("./breach-score-rule.js");
const { sessionSpendUsd, sessionTokens } = require("./session-spend.js");
const { projectSlug } = require("./project-slug.js");
const { throttleEnv } = require("./throttle-paths.js");
const { secondaryOf, summariseSecondary } = require("./arm-secondary.js");
const { readRegisteredGuardSubjects } = require("./guard-fires.js");
const { requiredGroup } = require("./regex-group.js");

const SCRIPTS = path.join(__dirname, "..");
/** `WFC_ARM_TASKS_CLI` stands a test's stub in for the task builder. */
const armTasksCli = (/** @type {NodeJS.ProcessEnv} */ env) =>
	env.WFC_ARM_TASKS_CLI || path.join(SCRIPTS, "arm-tasks.js");
/** `WFC_ADMISSION_CLI` stands a test's stub in for the admission check. */
const admissionCli = (/** @type {NodeJS.ProcessEnv} */ env) =>
	env.WFC_ADMISSION_CLI || path.join(SCRIPTS, "admission.js");
const SCORER = path.join(SCRIPTS, "score-session-breaches.js");
/** `A=<rev>@<config dir>`, as `--arm` takes it. */
const ARM_SPEC = /^([^=]+)=([^@]+)@(.+)$/;
/** What `run` says to do once every run started has ended. */
const RERUN = "run again to start the pairs left";
/** {@link RERUN}, once a failure stopped its pairs. */
const RERUN_LEFT = `clear the failure above and ${RERUN}`;
/**
 * `docs/effort-guide.md`'s standing default, named on the launch so both arms
 * run it whatever each config dir's settings say.
 */
const MODEL = "claude-opus-5-5[1m]";
const EFFORT = "medium";
/** D4's design target: a 30% drop. */
const DEFAULT_DROP = 0.3;
/** One run per arm; a running cap under it would hold every pair for ever. */
const PAIR_SIZE = 2;
/**
 * D5: at most 2 pairs, 4 sessions, at a time; raise it only where the
 * founder's own sessions are off the machine (#2046).
 */
const DEFAULT_MAX_RUNNING = 4;
/**
 * A run still going this long is stopped and recorded `hung` (#2046): three
 * times the pilot's longest run, 29.7 minutes, above F11's p75 of 40.
 */
const DEFAULT_CEILING_MIN = 90;
/** #2046: F11's p75 is the floor, so a slow run is never cut short as hung. */
const MIN_CEILING_MIN = 40;
/** D6: about 6 sessions an hour, so a pair every 20 minutes. */
const DEFAULT_PACE_MIN = 20;
const MS_PER_MIN = 60_000;
/** A guess: a pass is a few `claude agents` calls, and pairs start 20 minutes apart. */
const DEFAULT_POLL_SEC = 60;
/** Untraced, a guess: what one pair's two builds and its passes' calls add to the whole-run limit. */
const PAIR_ALLOWANCE_MIN = 10;
/** Untraced, a guess: a stop failing three times running will not pass on a fourth. */
const STOP_TRIES = 3;
/** Hang guards, not measurements: each call returns in seconds when well. */
const CALL_TIMEOUT_MS = 120_000;
/** A build, scorer or acceptance check reads a whole sandbox or transcript. */
const READ_TIMEOUT_MS = 900_000;

/** @type {import("./cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("run-arm-test.js")} (plan --root <dir> --tasks <ids> --runs <n> --arm A=<rev>@<dir> --arm B=<rev>@<dir> [--seed <n>] | launch <pair>… --root <dir> --issues <dir> --node-modules <dir> | run --root <dir> --issues <dir> --node-modules <dir> [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>] [--limit-min <n>] | report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>])`,
	commands: {
		plan: {
			usage: `Usage: node ${scriptPath("run-arm-test.js")} plan --root <dir> --tasks <ids> --runs <n> --arm A=<rev>@<dir> --arm B=<rev>@<dir> [--seed <n>]`,
			flags: {
				"--root": "value",
				"--tasks": "value",
				"--runs": "value",
				"--arm": "list",
				"--seed": "value",
			},
		},
		launch: {
			usage: `Usage: node ${scriptPath("run-arm-test.js")} launch <pair>… --root <dir> --issues <dir> --node-modules <dir>`,
			min: 1,
			max: Number.POSITIVE_INFINITY,
			flags: {
				"--root": "value",
				"--issues": "value",
				"--node-modules": "value",
			},
		},
		run: {
			usage: `Usage: node ${scriptPath("run-arm-test.js")} run --root <dir> --issues <dir> --node-modules <dir> [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>] [--limit-min <n>]`,
			flags: {
				"--root": "value",
				"--issues": "value",
				"--node-modules": "value",
				"--ceiling-min": "value",
				"--pace-min": "value",
				"--max-running": "value",
				"--poll-sec": "value",
				"--limit-min": "value",
			},
		},
		report: {
			usage: `Usage: node ${scriptPath("run-arm-test.js")} report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>]`,
			flags: {
				"--root": "value",
				"--baseline": "value",
				"--json": "boolean",
				"--drop": "value",
				"--every-version": "boolean",
				"--periods": "value",
				"--ceiling-min": "value",
			},
		},
	},
};

/**
 * @typedef {{ arm: string, rev: string, configDir: string }} Arm
 * @typedef {Arm & { id: string, pair: number, task: string, run: number, sandbox: string }} Run
 * @typedef {{ path: string, version: string }} Cli
 * @typedef {{ seed: number, cli: Cli, runs: Run[] }} Plan
 * @typedef {Run & { repo: string, job: string, launchedAt: string, hung?: string, limited?: string }} LaunchRecord `hung` is when the ceiling stopped it, `limited` when `run`'s whole-run limit did
 * @typedef {{ sessionId: string, state: string, kind: string }} Job
 * @typedef {Map<string, Job> | null} JobStates null where the listing cannot be read
 * @typedef {{ score: number, versions: string[], assistantMessages: number, stop: Record<string, number>, deny: Record<string, number>, families: { concision: number, environment: number } } | { error: string }} Score
 */

/**
 * mulberry32, a seeded generator.
 * @param {number} seed
 */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d_2b_79_f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * @param {{ tasks: string[], runs: number, arms: Arm[], seed: number, root: string }} opts
 * @returns {Omit<Plan, "cli">}
 */
function buildPlan({ tasks, runs, arms, seed, root }) {
	const rand = seeded(seed);
	const cells = tasks.flatMap((task) =>
		Array.from({ length: runs }, (_, i) => ({ task, run: i + 1 })),
	);
	for (let i = cells.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const a = cells[i];
		const b = cells[j];
		if (!a || !b) throw new Error(`shuffle index out of range: ${i}, ${j}`);
		cells[i] = b;
		cells[j] = a;
	}
	/** @type {Run[]} */
	const out = [];
	for (const [pair, { task, run }] of cells.entries()) {
		const order = rand() < 0.5 ? arms : [...arms].reverse();
		for (const { arm, rev, configDir } of order) {
			const id = `p${pair + 1}-${task}-r${run}-${arm}`;
			out.push({
				id,
				pair: pair + 1,
				task,
				run,
				arm,
				rev,
				configDir,
				sandbox: path.join(root, "sandboxes", id),
			});
		}
	}
	return { seed, runs: out };
}

/**
 * @param {string} spec `A=<rev>@<config dir>`
 * @returns {Arm | null}
 */
function parseArm(spec) {
	const m = ARM_SPEC.exec(spec);
	if (!m) return null;
	return {
		arm: requiredGroup(m, 1, ARM_SPEC),
		rev: requiredGroup(m, 2, ARM_SPEC),
		configDir: path.resolve(requiredGroup(m, 3, ARM_SPEC)),
	};
}

/**
 * Why no pair may start through the plan's CLI, or null where it is there.
 * @param {Cli | undefined} cli
 */
function cliGone(cli) {
	if (!cli)
		return "plan.json records no CLI to start pairs on; plan again under a new --root";
	return fs.existsSync(cli.path)
		? null
		: `the plan's CLI ${cli.version}, ${cli.path}, is gone, so no pair starts on it; restore that version, or plan again under a new --root`;
}

/**
 * @param {string} root
 * @returns {Plan}
 */
const readPlan = (root) =>
	JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));

/**
 * @param {string} root
 * @returns {LaunchRecord[]}
 */
const readLaunched = (root) =>
	launchedFiles(root).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

/** @param {string} root */
function launchedFiles(root) {
	const dir = path.join(root, "launched");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(dir, f));
}

/**
 * Mark `dir` trusted in the config dir's `.claude.json`, written atomically so
 * a session reading it never sees half a file.
 * @param {string} configDir
 * @param {string} dir
 */
function trust(configDir, dir) {
	const file = path.join(configDir, ".claude.json");
	const state = JSON.parse(fs.readFileSync(file, "utf8"));
	state.projects ??= {};
	state.projects[dir] = {
		...state.projects[dir],
		hasTrustDialogAccepted: true,
	};
	writeFileAtomic(file, JSON.stringify(state, null, 2));
}

/**
 * The throttling paths are pinned because an arm's revision may predate #2098,
 * where the sweep's state still defaults per repo root and each sandbox would
 * kick a full transcript sweep of its own.
 *
 * @param {string} sandbox
 * @param {NodeJS.ProcessEnv} env
 */
function sandboxEnv(sandbox, env) {
	return {
		WFC_GH: path.join(sandbox, "bin", "gh"),
		GH_HOST: "gh-stub.invalid",
		GIT_ALLOW_PROTOCOL: "file",
		DISABLE_AUTOUPDATER: "1",
		...throttleEnv(env),
	};
}

/**
 * Whether `run` stopped `rec` and marked it, at the ceiling or its limit.
 * @param {LaunchRecord} rec
 */
const stoppedByRun = (rec) => Boolean(rec.hung || rec.limited);

/**
 * Whether a launched run has ended: done, failed or stopped, `blocked` on a
 * question, which nobody answers in either arm (#2045), or stopped at the
 * ceiling (#2046) or `run`'s limit (#3495). A
 * run whose job the listing does not show counts as running, so an
 * unreadable listing never admits another pair.
 * @param {LaunchRecord} rec
 * @param {Map<string, JobStates>} states
 */
function ended(rec, states) {
	if (stoppedByRun(rec)) return true;
	const job = states.get(rec.configDir)?.get(rec.job);
	if (job === undefined) return false;
	return isTerminalAgent(job) || job.state === "blocked";
}

/**
 * A minute or second flag as milliseconds, or null where it is not a number
 * at least `min`.
 * @param {import("./cli-args").Parsed["flags"]} flags
 * @param {string} name
 * @param {{ fallback: number, unitMs: number, min: number }} spec
 */
function durationFlag(flags, name, { fallback, unitMs, min }) {
	const n = Number(flagValue(flags, name) ?? fallback);
	return Number.isFinite(n) && n >= min ? n * unitMs : null;
}

/**
 * A whole-number flag, or null where it is not an integer at least `min`.
 * @param {import("./cli-args").Parsed["flags"]} flags
 * @param {string} name
 * @param {{ fallback: number, min: number }} spec
 */
function countFlag(flags, name, { fallback, min }) {
	const n = Number(flagValue(flags, name) ?? fallback);
	return Number.isInteger(n) && n >= min ? n : null;
}

/**
 * `run`'s flags, or the refusal where one is missing or malformed.
 * @param {import("./cli-args").Parsed["flags"]} flags
 */
function runOptions(flags) {
	const root = flagValue(flags, "--root");
	const issues = flagValue(flags, "--issues");
	const nodeModules = flagValue(flags, "--node-modules");
	const ceilingMs = durationFlag(flags, "--ceiling-min", {
		fallback: DEFAULT_CEILING_MIN,
		unitMs: MS_PER_MIN,
		min: MIN_CEILING_MIN,
	});
	const paceMs = durationFlag(flags, "--pace-min", {
		fallback: DEFAULT_PACE_MIN,
		unitMs: MS_PER_MIN,
		min: 0,
	});
	const pollMs = durationFlag(flags, "--poll-sec", {
		fallback: DEFAULT_POLL_SEC,
		unitMs: 1000,
		min: 0,
	});
	const maxRunning = countFlag(flags, "--max-running", {
		fallback: DEFAULT_MAX_RUNNING,
		min: PAIR_SIZE,
	});
	const usage = CLI.commands?.run?.usage ?? CLI.usage;
	if (!root || !issues || !nodeModules) return usage;
	if (ceilingMs === null || paceMs === null || pollMs === null) return usage;
	if (maxRunning === null || maxRunning % PAIR_SIZE !== 0)
		return `--max-running takes a whole number of pairs' sessions, at least one pair's ${PAIR_SIZE}`;
	return {
		root: path.resolve(root),
		build: {
			issues: path.resolve(issues),
			nodeModules: path.resolve(nodeModules),
		},
		ceilingMs,
		paceMs,
		maxRunning,
		pollMs,
	};
}

/**
 * `run`'s default whole-run limit, in minutes: the longest a plan of `pairs`
 * takes where admission never holds it. Under the least `--max-running`, one
 * pair at a time, each pair starts within the pace, or the ceiling and a poll
 * of the one before ending, whichever is later; running more at once only
 * shortens it. Each pair also gets PAIR_ALLOWANCE_MIN for its builds and the
 * passes' calls.
 * @param {number} pairs
 * @param {{ ceilingMs: number, paceMs: number, pollMs: number }} o
 */
const derivedLimitMin = (pairs, { ceilingMs, paceMs, pollMs }) =>
	Math.ceil(
		(pairs * (Math.max(paceMs, ceilingMs + pollMs) + pollMs)) / MS_PER_MIN,
	) +
	pairs * PAIR_ALLOWANCE_MIN;

/**
 * A transcript's first to last timestamp, or null where it has fewer than two.
 * @param {string} file
 */
function readWallMs(file) {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const row of parseJsonl(fs.readFileSync(file, "utf8")).rows) {
		const at = Date.parse(String(row.timestamp));
		if (!Number.isFinite(at)) continue;
		first = Math.min(first, at);
		last = Math.max(last, at);
	}
	return last > first ? last - first : null;
}

/**
 * The CLI version most scored runs ran on.
 * @param {string[][]} versionsPerRun
 */
function modalVersion(versionsPerRun) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const vs of versionsPerRun)
		if (vs.length === 1 && vs[0])
			counts.set(vs[0], (counts.get(vs[0]) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const FAMILIES = /** @type {const} */ ([
	"moved",
	"kept",
	"mixed",
	"inventory",
	"jobDir",
	"unattributed",
]);

/**
 * One run's score split into D3's families: `inventory` and `jobDir`, the
 * two near-constant guards (F8), then `moved`, `mixed` and `kept` by `breach-score-rule.js`, and
 * `unattributed` a deny no guard's needle names.
 * @param {{ stop: Record<string, number>, deny: Record<string, number> }} score
 * @returns {Record<(typeof FAMILIES)[number], number>}
 */
function familiesOf({ stop, deny }) {
	const f = {
		moved: 0,
		kept: 0,
		mixed: 0,
		inventory: 0,
		jobDir: 0,
		unattributed: 0,
	};
	/** @param {string[]} guards @param {number} n */
	const add = (guards, n) => {
		if (guards.includes(INVENTORY)) f.inventory += n;
		else if (guards.includes(JOB_DIR)) f.jobDir += n;
		else if (guards.some((g) => MOVED.has(g))) f.moved += n;
		else if (guards.some((g) => MIXED.has(g))) f.mixed += n;
		else if (guards.includes(UNATTRIBUTED)) f.unattributed += n;
		else f.kept += n;
	};
	for (const [g, n] of Object.entries(stop)) add([g], n);
	for (const [k, n] of Object.entries(deny)) add(k.split(DENY_GUARD_JOIN), n);
	return f;
}

/**
 * D3's primary analysis and cross-check on one score per run.
 * @param {import("./arm-stats.js").Scored[]} scored
 * @param {string} baseline
 */
function compare(scored, baseline) {
	const other = scored.find((s) => s.arm !== baseline)?.arm;
	const of = (/** @type {string | undefined} */ arm) =>
		scored.filter((s) => s.arm === arm).map((s) => s.score);
	return {
		poisson: poissonArm(scored, baseline),
		mannWhitney: mannWhitney(of(baseline), of(other)),
	};
}

/**
 * `--periods`' first pairs, ascending, with pair 1 first; null where one is
 * not a whole number above 1.
 * @param {string | undefined} value
 */
function parsePeriods(value) {
	if (value === undefined) return [1];
	const starts = value.split(",").map(Number);
	if (starts.some((n) => !Number.isInteger(n) || n < 2)) return null;
	return [1, ...[...new Set(starts)].sort((a, b) => a - b)];
}

/**
 * @param {ReturnType<typeof readRun>[]} rows
 * @param {(r: ReturnType<typeof readRun>) => boolean} p
 */
const countByArm = (rows, p) =>
	Object.fromEntries(
		[...new Set(rows.map((r) => r.arm))]
			.sort()
			.map((a) => [a, rows.filter((r) => r.arm === a && p(r)).length]),
	);

/**
 * #2241's split by period, every count over the scored runs.
 * @param {{ row: ReturnType<typeof readRun>, score: number, environment: number }[]} scored
 * @param {number[]} starts
 * @param {string} baseline
 */
function byPeriod(scored, starts, baseline) {
	const periodOf = (/** @type {number} */ pair) =>
		starts.filter((s) => s <= pair).length - 1;
	const arms = [...new Set(scored.map((s) => s.row.arm))].sort();
	const periods = starts.map((from, i) => {
		const inP = scored.filter((s) => periodOf(s.row.pair) === i);
		return {
			fromPair: from,
			toPair: (starts[i + 1] ?? Number.POSITIVE_INFINITY) - 1,
			byArm: Object.fromEntries(
				arms.map((a) => {
					const mine = inP.filter((s) => s.row.arm === a);
					return [
						a,
						{
							score: meanVar(mine.map((s) => s.score)),
							environmentDenies: mine.reduce((t, s) => t + s.environment, 0),
							blocked: mine.filter((s) => s.row.state === "blocked").length,
							hung: mine.filter((s) => s.row.state === "hung").length,
						},
					];
				}),
			),
			poisson: poissonArm(
				inP.map((s) => ({ task: s.row.task, arm: s.row.arm, score: s.score })),
				baseline,
			),
		};
	});
	const fits = periods.flatMap((p) =>
		"rateRatio" in p.poisson && p.poisson.logSe > 0 ? [p.poisson] : [],
	);
	return {
		periods,
		armByPeriod: {
			postHoc: true,
			...(fits.length === periods.length && fits.length > 1
				? heterogeneity(fits)
				: { error: "needs a rate ratio in every period, and two periods" }),
		},
	};
}

/**
 * @typedef {object} Ports
 * @property {NodeJS.ProcessEnv} env  the environment every child reads; `run`
 *   forgets the starting session's id on it
 * @property {import("./seat-claude.js").Spawn} claude  each `claude` call
 * @property {(cli: string, args: string[], opts: { env: NodeJS.ProcessEnv, timeout: number }) => { status: number | null, stdout: string, stderr: string }} node
 *   a Node program run to its end: the builder, admission, the scorer and the
 *   acceptance check
 * @property {() => number} clock  `run`'s monotonic clock, in ms, so a
 *   wall-clock step neither fires the limit early nor holds it off
 * @property {() => number} now  the wall clock, in epoch ms, which the launch
 *   records stamp and the ceiling and pace read
 * @property {(ms: number) => void} sleep  `run`'s wait between passes
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {() => string} hostRoot  the repo whose guard registry the warn
 *   measure reads
 */

/**
 * @param {Ports} p
 * @param {string} msg
 */
function refuse(p, msg) {
	p.err(`✗ ${msg}\n`);
	return 2;
}

/**
 * `claudeBin(p.env)` found on PATH and followed through every link to its
 * versioned binary, with the version that binary reports; the reason where
 * none answers.
 * @param {Ports} p
 * @returns {Cli | string}
 */
function resolveCli(p) {
	const name = claudeBin(p.env);
	const candidates = name.includes("/")
		? [name]
		: (p.env.PATH ?? "")
				.split(path.delimiter)
				.filter(Boolean)
				.map((dir) => path.join(dir, name));
	const found = candidates.find((c) => {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	if (!found) return `no executable \`${name}\` on PATH`;
	const real = fs.realpathSync(found);
	const v = readClaudeVersionOrWhy(real, p.claude);
	if ("why" in v) return `${real} --version printed no version (${v.why})`;
	return { path: real, version: v.version };
}

/**
 * @param {Ports} p
 * @param {import("./cli-args").Parsed} parsed
 */
function plan(p, { flags, lists }) {
	const root = flagValue(flags, "--root");
	const tasks = (flagValue(flags, "--tasks") ?? "").split(",").filter(Boolean);
	const runs = Number(flagValue(flags, "--runs"));
	/** @type {Arm[]} */
	const arms = [];
	for (const spec of lists["--arm"] ?? []) {
		const arm = parseArm(spec);
		if (arm) arms.push(arm);
	}
	const seed = Number(flagValue(flags, "--seed") ?? p.now() % 2 ** 31);
	if (!root || tasks.length === 0 || !Number.isInteger(runs) || runs < 1)
		return refuse(p, CLI.usage);
	if (arms.length !== PAIR_SIZE || (lists["--arm"] ?? []).length !== PAIR_SIZE)
		return refuse(
			p,
			"--arm takes <name>=<rev>@<config dir>, exactly twice: one per arm",
		);
	const file = path.join(path.resolve(root), "plan.json");
	if (fs.existsSync(file))
		return refuse(
			p,
			`${file} exists; a plan is written once, so give a new --root`,
		);
	const cli = resolveCli(p);
	if (typeof cli === "string") return refuse(p, cli);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const made = buildPlan({
		tasks,
		runs,
		arms,
		seed,
		root: path.resolve(root),
	});
	fs.writeFileSync(file, `${JSON.stringify({ ...made, cli }, null, 2)}\n`);
	p.out(`${made.runs.map((r) => r.id).join("\n")}\n`);
	return 0;
}

/**
 * Build one run's sandbox and ready it for a `--bg` job: its env file, and
 * its repo trusted in the arm's config dir.
 * @param {Ports} p
 * @param {Run} run
 * @param {{ issues: string, nodeModules: string }} opts
 * @returns {{ ok: true, repo: string, prompt: string } | { ok: false, why: string }}
 */
function prepare(p, run, { issues, nodeModules }) {
	if (!fs.existsSync(path.join(run.configDir, ".claude.json")))
		return {
			ok: false,
			why: `${run.configDir} holds no .claude.json: log it in first (CLAUDE_CONFIG_DIR=${run.configDir} claude auth login)`,
		};
	const built = p.node(
		armTasksCli(p.env),
		[
			"build",
			run.task,
			"--at",
			run.rev,
			"--to",
			run.sandbox,
			"--issues",
			issues,
			"--node-modules",
			nodeModules,
			"--config-dir",
			run.configDir,
		],
		{ env: p.env, timeout: READ_TIMEOUT_MS },
	);
	if (built.status !== 0)
		return {
			ok: false,
			why: `build failed, fix it and launch again: ${built.stderr.trim()}`,
		};
	/** @type {{ prompt: string, sandbox: { repo: string } }} */
	let task;
	try {
		task = JSON.parse(built.stdout);
	} catch {
		// A builder that exits 0 without its record is a builder bug (#2045).
		return {
			ok: false,
			why: `the builder printed no task record: ${built.stdout.slice(0, CHILD_ERROR_CHARS)}`,
		};
	}
	const repo = fs.realpathSync(task.sandbox.repo);
	const local = path.join(repo, ".claude", "settings.local.json");
	fs.mkdirSync(path.dirname(local), { recursive: true });
	fs.writeFileSync(
		local,
		`${JSON.stringify({ env: sandboxEnv(run.sandbox, p.env) }, null, 2)}\n`,
	);
	trust(run.configDir, repo);
	return { ok: true, repo, prompt: task.prompt };
}

/**
 * Start one prepared run as a `claude --bg` job in its arm's config dir.
 * @param {Ports} p
 * @param {Run} run
 * @param {{ repo: string, prompt: string }} ready
 * @param {string} bin
 * @returns {{ ok: true, record: LaunchRecord } | { ok: false, why: string }}
 */
function start(p, run, { repo, prompt }, bin) {
	const env = {
		...p.env,
		...sandboxEnv(run.sandbox, p.env),
		CLAUDE_CONFIG_DIR: run.configDir,
		PATH: `${path.join(run.sandbox, "bin")}:${p.env.PATH}`,
	};
	const refusal = launchAuthRefusal({ bin, env, cwd: repo, spawn: p.claude });
	if (refusal) return { ok: false, why: refusal };
	const launched = p.claude(
		bin,
		[
			"--bg",
			"--model",
			MODEL,
			"--effort",
			EFFORT,
			"--permission-mode",
			"auto",
			prompt,
		],
		{ cwd: repo, timeout: CALL_TIMEOUT_MS, env },
	);
	const job = /backgrounded\s+·\s+(\S+)/.exec(launched.stdout)?.[1];
	if (launched.status !== 0 || !job)
		return {
			ok: false,
			why: `launch failed (${launched.status}), check \`CLAUDE_CONFIG_DIR=${run.configDir} claude agents\` before relaunching: ${`${launched.stdout}${launched.stderr}`.trim()}`,
		};
	return {
		ok: true,
		record: {
			...run,
			repo,
			job,
			launchedAt: new Date(p.now()).toISOString(),
		},
	};
}

/**
 * Free session slots by `admission.js`, or 0 with the reason where it cannot
 * say (#2045).
 * @param {Ports} p
 * @returns {{ slots: number, why?: string }}
 */
function readAdmissionSlots(p) {
	const r = p.node(admissionCli(p.env), ["--json"], {
		env: p.env,
		timeout: CALL_TIMEOUT_MS,
	});
	try {
		const reading = JSON.parse(r.stdout);
		const slots = Number(reading.slots) || 0;
		return typeof reading.error === "string"
			? { slots, why: reading.error }
			: { slots };
	} catch {
		return {
			slots: 0,
			why: `admission printed no reading (exit ${r.status}): ${r.stderr.trim().slice(0, CHILD_ERROR_CHARS)}`,
		};
	}
}

/**
 * Each job's record from `claude agents --json --all` in one config dir,
 * keyed by the job id `--bg` printed. A `--bg` launch ignores `--session-id`
 * (#2045), so the listing is the one map from job to
 * transcript.
 * @param {Ports} p
 * @param {string} configDir
 * @param {string} bin
 * @returns {JobStates}
 */
function readJobStates(p, configDir, bin) {
	const r = runClaude(["agents", "--json", "--all"], {
		env: buildSeatEnv(p.env, configDir),
		timeout: CALL_TIMEOUT_MS,
		bin,
		spawn: p.claude,
	});
	try {
		/** @type {(Job & { id: string })[]} */
		const rows = JSON.parse(r.stdout);
		return new Map(rows.map((j) => [j.id, j]));
	} catch {
		// An unreadable listing is reported per run as `state unknown` (#2045).
		return null;
	}
}

/**
 * Every launched record's job, read once per config dir.
 * @param {Ports} p
 * @param {LaunchRecord[]} recs
 * @param {string} bin
 * @returns {Map<string, JobStates>}
 */
function readStatesByConfigDir(p, recs, bin) {
	/** @type {Map<string, JobStates>} */
	const states = new Map();
	for (const r of recs)
		if (!states.has(r.configDir))
			states.set(r.configDir, readJobStates(p, r.configDir, bin));
	return states;
}

/**
 * Why a pair of `size` cannot start now, or null where it can: the running
 * cap first, then admission.
 * @param {Ports} p
 * @param {string} root
 * @param {{ size: number, bin: string, maxRunning?: number }} pair
 */
function heldBack(p, root, { size, bin, maxRunning = DEFAULT_MAX_RUNNING }) {
	const launched = readLaunched(root);
	const states = readStatesByConfigDir(p, launched, bin);
	const running = launched.filter((r) => !ended(r, states)).length;
	if (running + size > maxRunning)
		return `${running} session(s) still running, the cap is ${maxRunning}; launch again when a pair ends`;
	const { slots, why } = readAdmissionSlots(p);
	if (slots < size)
		return `admission has ${slots} slot(s), a pair needs ${size}; launch again when admission frees${why ? ` (${why})` : ""}`;
	return null;
}

/**
 * Build both of a pair's sandboxes, then start both; neither starts when
 * either build fails. Whether every member started.
 * @param {Ports} p
 * @param {Run[]} members
 * @param {{ dir: string, opts: { issues: string, nodeModules: string }, bin: string }} into
 *   `dir` the `launched` dir
 */
function launchPair(p, members, { dir, opts, bin }) {
	/** @type {{ run: Run, ready: { repo: string, prompt: string } }[]} */
	const prepared = [];
	for (const run of members) {
		const ready = prepare(p, run, opts);
		if (!ready.ok) {
			p.err(`✗ ${run.id}: ${ready.why}\n`);
			return false;
		}
		prepared.push({ run, ready });
	}
	let ok = true;
	for (const { run, ready } of prepared) {
		const s = start(p, run, ready, bin);
		if (!s.ok) {
			p.err(`✗ ${run.id}: ${s.why}\n`);
			ok = false;
			continue;
		}
		fs.writeFileSync(
			path.join(dir, `${run.id}.json`),
			`${JSON.stringify(s.record, null, 2)}\n`,
		);
		p.out(`${run.id}: job ${s.record.job}\n`);
	}
	return ok;
}

/**
 * @param {Ports} p
 * @param {import("./cli-args").Parsed} parsed
 */
function launch(p, { flags, positionals }) {
	const root = flagValue(flags, "--root");
	const issues = flagValue(flags, "--issues");
	const nodeModules = flagValue(flags, "--node-modules");
	if (!root || !issues || !nodeModules) return refuse(p, CLI.usage);
	const at = path.resolve(root);
	const { cli, runs } = readPlan(at);
	const pairs = positionals.map(Number);
	const last = Math.max(...runs.map((r) => r.pair));
	if (runs.filter((r) => pairs.includes(r.pair)).length !== pairs.length * 2)
		return refuse(
			p,
			`no such pair among ${positionals.join(", ")}: pairs run 1 to ${last}`,
		);
	const dir = path.join(at, "launched");
	fs.mkdirSync(dir, { recursive: true });
	const opts = {
		issues: path.resolve(issues),
		nodeModules: path.resolve(nodeModules),
	};
	let failed = 0;
	for (const pair of pairs) {
		const gone = cliGone(cli);
		if (gone) return refuse(p, `pair ${pair} and after: ${gone}`);
		const members = runs.filter((r) => r.pair === pair);
		const done = members.filter((r) =>
			fs.existsSync(path.join(dir, `${r.id}.json`)),
		);
		if (done.length > 0) {
			p.err(
				`✗ pair ${pair}: ${done.map((r) => r.id).join(", ")} already launched; drop the pair from the list\n`,
			);
			failed++;
			continue;
		}
		const held = heldBack(p, at, { size: members.length, bin: cli.path });
		if (held) {
			p.err(`✗ pair ${pair} and after: ${held}\n`);
			return 1;
		}
		if (!launchPair(p, members, { dir, opts, bin: cli.path })) failed++;
	}
	return failed === 0 ? 0 : 1;
}

/**
 * Stop `rec`'s job and stamp its record with `mark`, the time, so it reads
 * ended from then on. Null where the stop held, a job the daemon no longer
 * holds being already stopped; else why it failed.
 * @param {Ports} p
 * @param {LaunchRecord} rec
 * @param {{ root: string, bin: string, mark: "hung" | "limited" }} how
 */
function stopAndMark(p, rec, { root, bin, mark }) {
	const r = stopOn(rec.configDir, rec.job, bin, {
		env: p.env,
		spawn: p.claude,
	});
	if (!r.ok && !r.noJob) return r.why;
	fs.writeFileSync(
		path.join(root, "launched", `${rec.id}.json`),
		`${JSON.stringify({ ...rec, [mark]: new Date(p.now()).toISOString() }, null, 2)}\n`,
	);
	return null;
}

/**
 * Stop each run the listing shows still going past `ceilingMs`, and record it
 * `hung`. A run the listing does not
 * show is left: an unreadable listing stops nothing.
 * @param {Ports} p
 * @param {string} root
 * @param {number} ceilingMs
 * @param {string} bin
 */
function reapHung(p, root, ceilingMs, bin) {
	const recs = readLaunched(root);
	const states = readStatesByConfigDir(p, recs, bin);
	for (const rec of recs) {
		if (ended(rec, states) || !states.get(rec.configDir)?.has(rec.job))
			continue;
		if (p.now() - Date.parse(rec.launchedAt) <= ceilingMs) continue;
		const why = stopAndMark(p, rec, { root, bin, mark: "hung" });
		if (why !== null) {
			p.err(
				`✗ ${rec.id}: past the ceiling but \`claude stop ${rec.job}\` failed (${why}); tried again next pass\n`,
			);
			continue;
		}
		p.out(`${rec.id}: still going past the ceiling, stopped as hung\n`);
	}
}

/**
 * `--limit-min` as milliseconds, derived from the plan where absent, said on
 * stdout; the refusal where it is not a number at least 0.
 * @param {Ports} p
 * @param {import("./cli-args").Parsed["flags"]} flags
 * @param {Plan} plan
 * @param {Exclude<ReturnType<typeof runOptions>, string>} o
 */
function runLimitMs(p, flags, { runs }, o) {
	const pairs = new Set(runs.map((r) => r.pair)).size;
	const ms = durationFlag(flags, "--limit-min", {
		fallback: derivedLimitMin(pairs, o),
		unitMs: MS_PER_MIN,
		min: 0,
	});
	if (ms === null)
		return `--limit-min takes minutes, at least 0, got ${flagValue(flags, "--limit-min")}`;
	p.out(
		`stops every run still going after ${Math.round(ms / MS_PER_MIN)} minutes\n`,
	);
	return ms;
}

/**
 * Stop every launched run not yet ended, the unlisted included, since an
 * unreadable listing must not leave one going, trying a failed stop again
 * after a poll up to STOP_TRIES times. Say what is left and return `run`'s
 * exit status: `failed`, a failure that had stopped further pairs, else 1.
 * @param {Ports} p
 * @param {string} root
 * @param {string} bin
 * @param {{ limitMs: number, pollMs: number, failed: number }} o
 */
function stopAtLimit(p, root, bin, { limitMs, pollMs, failed }) {
	const recs = readLaunched(root);
	const states = readStatesByConfigDir(p, recs, bin);
	let left = recs.filter((rec) => !ended(rec, states));
	for (let tries = 0; tries < STOP_TRIES && left.length > 0; tries++) {
		if (tries > 0) p.sleep(pollMs);
		left = left.filter((rec) => {
			const why = stopAndMark(p, rec, { root, bin, mark: "limited" });
			if (why === null) {
				p.out(`${rec.id}: stopped at the run's limit\n`);
				return false;
			}
			p.err(`✗ ${rec.id}: \`claude stop ${rec.job}\` failed (${why})\n`);
			return true;
		});
	}
	const minutes = Math.round(limitMs / MS_PER_MIN);
	const stopped =
		left.length === 0
			? `stopped every run still going; ${failed === 0 ? RERUN : RERUN_LEFT}`
			: `stopped all but ${left.map((r) => `${r.id} (job ${r.job} in ${r.configDir})`).join(", ")}, still running after ${STOP_TRIES} tries: stop each by hand`;
	p.err(`✗ the run's limit of ${minutes} minutes passed; ${stopped}\n`);
	return failed || 1;
}

/**
 * Where the plan's CLI is gone, so nothing can list or stop a run: name each
 * launched run not recorded ended with the `claude stop` that ends it, and
 * return `run`'s exit status; else null.
 * @param {Ports} p
 * @param {Cli | undefined} cli
 * @param {string} root
 */
function refuseGoneCli(p, cli, root) {
	const gone = cliGone(cli);
	if (!gone) return null;
	nameStillGoing(p, root);
	return refuse(p, gone);
}

/**
 * Name each launched run not recorded ended with the `claude stop` that ends
 * it, and each record that will not parse by its file, since it cannot name
 * its own run.
 * @param {Ports} p
 * @param {string} root
 */
function nameStillGoing(p, root) {
	for (const file of launchedFiles(root)) {
		/** @type {LaunchRecord | undefined} */
		let rec;
		try {
			rec = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			// Left undefined, so it is named by its file below (#3506).
		}
		if (!rec?.id || !rec.configDir || !rec.job) {
			p.err(
				`✗ ${file} does not name its run, which may still be going: find its job in its arm's \`claude agents\` and \`claude stop\` it\n`,
			);
			continue;
		}
		if (!stoppedByRun(rec))
			p.err(
				`✗ ${rec.id} may still be going: CLAUDE_CONFIG_DIR=${rec.configDir} claude stop ${rec.job}\n`,
			);
	}
}

/**
 * Say how `run` ended once every run started has, and return its exit
 * status: `failed`, the failure that stopped further pairs, or 0.
 * @param {Ports} p
 * @param {number} failed
 */
function reportEnd(p, failed) {
	if (failed === 0) {
		p.out("every pair started and every run ended\n");
		return 0;
	}
	p.err(`✗ every run started has ended; ${RERUN_LEFT}\n`);
	return failed;
}

/**
 * `done` where every launched run has ended, else `wait`.
 * @param {Ports} p
 * @param {string} root
 * @param {string} bin
 * @returns {"done" | "wait"}
 */
function allEnded(p, root, bin) {
	const launched = readLaunched(root);
	const states = readStatesByConfigDir(p, launched, bin);
	return launched.every((r) => ended(r, states)) ? "done" : "wait";
}

/**
 * A pass of `run` once a failure stops further pairs: stop the hung, and
 * `done` once every run started has ended.
 * @param {Ports} p
 * @param {string} bin
 * @param {Exclude<ReturnType<typeof runOptions>, string>} o
 */
function drainPass(p, bin, o) {
	reapHung(p, o.root, o.ceilingMs, bin);
	return allEnded(p, o.root, bin);
}

/**
 * One pass of `run`: stop the hung, then start the next pair where the pace
 * and `launch`'s own checks allow. `done` once every pair has started and
 * every run ended; a number is the exit status of a failure.
 * @param {Ports} p
 * @param {Plan} plan
 * @param {Exclude<ReturnType<typeof runOptions>, string>} o
 * @returns {"done" | "launched" | "wait" | { held: string } | number}
 */
function runPass(p, { cli, runs }, o) {
	reapHung(p, o.root, o.ceilingMs, cli.path);
	const launched = readLaunched(o.root);
	const started = new Set(launched.map((r) => r.id));
	const pending = runs.filter((r) => !started.has(r.id));
	if (pending.length === 0) return allEnded(p, o.root, cli.path);
	const next = Math.min(...pending.map((r) => r.pair));
	const members = runs.filter((r) => r.pair === next);
	if (members.some((r) => started.has(r.id)))
		return refuse(
			p,
			`pair ${next} is half-launched; once its running member has ended, remove its record from ${path.join(o.root, "launched")} and run again`,
		);
	const last = Math.max(0, ...launched.map((r) => Date.parse(r.launchedAt)));
	if (p.now() - last < o.paceMs) return "wait";
	const held = heldBack(p, o.root, {
		size: members.length,
		bin: cli.path,
		maxRunning: o.maxRunning,
	});
	if (held) return { held: `pair ${next} held: ${held}` };
	const dir = path.join(o.root, "launched");
	return launchPair(p, members, { dir, opts: o.build, bin: cli.path })
		? "launched"
		: 1;
}

/**
 * `run`'s options, plan and whole-run limit, or the refusal where a flag is
 * missing or malformed.
 * @param {Ports} p
 * @param {import("./cli-args").Parsed["flags"]} flags
 */
function runSetup(p, flags) {
	const o = runOptions(flags);
	if (typeof o === "string") return o;
	// Every child the loop spawns reads this environment, the launches included.
	forgetSession(p.env);
	const planned = readPlan(o.root);
	fs.mkdirSync(path.join(o.root, "launched"), { recursive: true });
	const limitMs = runLimitMs(p, flags, planned, o);
	if (typeof limitMs === "string") return limitMs;
	return { o, planned, limitMs };
}

/**
 * Log why `step` holds a pair where the reason differs from `lastHeld`, and
 * return the reason, or "" where it holds none.
 * @param {Ports} p
 * @param {ReturnType<typeof runPass>} step
 * @param {string} lastHeld
 */
function logHeld(p, step, lastHeld) {
	const held = typeof step === "object" ? step.held : "";
	if (held && held !== lastHeld) p.out(`${held}\n`);
	return held;
}

/**
 * `run`, naming each run left going where its loop throws (#3506).
 * @param {Ports} p
 * @param {import("./cli-args").Parsed} parsed
 */
function runAll(p, parsed) {
	const setup = runSetup(p, parsed.flags);
	if (typeof setup === "string") return refuse(p, setup);
	try {
		return runLoop(p, setup);
	} catch (e) {
		p.err(`✗ run threw: ${e instanceof Error ? e.stack : e}\n`);
		try {
			nameStillGoing(p, setup.o.root);
		} catch (listing) {
			p.err(
				`✗ cannot list ${path.join(setup.o.root, "launched")} (${listing instanceof Error ? listing.message : listing}), so any run started may still be going: check each arm's \`claude agents\`\n`,
			);
		}
		return 1;
	}
}

/**
 * @param {Ports} p
 * @param {Exclude<ReturnType<typeof runSetup>, string>} setup
 */
function runLoop(p, { o, planned, limitMs }) {
	const now = p.clock;
	const startedAt = now();
	let lastHeld = "";
	/** The failure's exit status once one stops further pairs, else 0. */
	let failed = 0;
	for (;;) {
		const exit = refuseGoneCli(p, planned.cli, o.root);
		if (exit !== null) return exit;
		if (now() - startedAt >= limitMs)
			return stopAtLimit(p, o.root, planned.cli.path, {
				...o,
				limitMs,
				failed,
			});
		const step =
			failed === 0 ? runPass(p, planned, o) : drainPass(p, planned.cli.path, o);
		if (typeof step === "number") {
			failed = step;
			p.err(
				"✗ starts no more pairs; waits for every run started to end, stopping any past the ceiling or the run's limit\n",
			);
			continue;
		}
		if (step === "done") return reportEnd(p, failed);
		lastHeld = logHeld(p, step, lastHeld);
		if (step !== "launched") p.sleep(o.pollMs);
	}
}

/**
 * Whether the launcher's own seat is still signed in, so the arms' logins
 * did not sign it out; null where `claude auth status` cannot say
 * (#2045).
 * @param {Ports} p
 */
function liveSeatSignedIn(p) {
	const r = p.claude(claudeBin(p.env), ["auth", "status"], {
		env: p.env,
		timeout: CALL_TIMEOUT_MS,
	});
	try {
		return JSON.parse(r.stdout).loggedIn === true;
	} catch {
		return null;
	}
}

/**
 * @param {Ports} p
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number | null, json: any, err?: string }} `any`: each caller's JSON has its own shape, the scorer's rows or the accept verdict
 */
function runJson(p, cmd, args) {
	const r = p.node(cmd, args, { env: p.env, timeout: READ_TIMEOUT_MS });
	// A crash or a refusal leaves the run reported, not scored (#2045). Exit 2
	// is a refusal even where JSON was printed first, as the scorer prints it
	// before refusing an unclassed Stop guard (#3761).
	const refused = { status: r.status, json: null, err: r.stderr.trim() };
	if (r.status === 2) return refused;
	try {
		return { status: r.status, json: JSON.parse(r.stdout) };
	} catch {
		return refused;
	}
}

/**
 * One launched run's row.
 * @param {Ports} p
 * @param {LaunchRecord} rec
 * @param {Map<string, JobStates>} states
 * @param {import("./guard-fires").Subject[]} subjects the registered guards, for the warn measure
 */
function readRun(p, rec, states, subjects) {
	const job = states.get(rec.configDir)?.get(rec.job);
	const transcript = path.join(
		rec.configDir,
		"projects",
		projectSlug(rec.repo),
		`${job?.sessionId ?? rec.job}.jsonl`,
	);
	const stoppedAs = rec.hung ? "hung" : rec.limited && "limited";
	/** @type {{ id: string, pair: number, task: string, arm: string, job: string, state: string, ended: boolean, transcriptInArmDir: boolean, jobDirInArmDir: boolean, score: Score | null, accept: boolean | { error: string } | null, spendUsd: number | null, tokens: number | null, wallMs: number | null, secondary: ReturnType<typeof secondaryOf> | null }} */
	const row = {
		id: rec.id,
		pair: rec.pair,
		task: rec.task,
		arm: rec.arm,
		job: rec.job,
		state: stoppedAs || (job?.state ?? "unknown"),
		ended: ended(rec, states),
		transcriptInArmDir: fs.existsSync(transcript),
		jobDirInArmDir: fs.existsSync(jobDirPath(rec.configDir, rec.job)),
		score: null,
		accept: null,
		spendUsd: null,
		tokens: null,
		wallMs: null,
		secondary: null,
	};
	// A run cut off at `run`'s limit did an arbitrary share of its work, so it is no measure of its arm.
	if (!row.ended || rec.limited || !row.transcriptInArmDir) return row;
	row.spendUsd = sessionSpendUsd(transcript);
	row.tokens = sessionTokens(transcript);
	row.wallMs = readWallMs(transcript);
	row.secondary = secondaryOf(fs.readFileSync(transcript, "utf8"), subjects);
	const s = runJson(p, SCORER, ["--file", transcript, "--json"]);
	row.score = s.json?.[0] ?? { error: s.err || `exit ${s.status}` };
	const a = runJson(p, armTasksCli(p.env), [
		"accept",
		rec.task,
		"--sandbox",
		rec.sandbox,
		"--json",
	]);
	row.accept = a.json ? a.json.pass : { error: a.err || `exit ${a.status}` };
	return row;
}

/**
 * @param {Ports} p
 * @param {import("./cli-args").Parsed} parsed
 */
function report(p, { flags }) {
	const root = flagValue(flags, "--root");
	const baseline = flagValue(flags, "--baseline");
	const drop = Number(flagValue(flags, "--drop") ?? DEFAULT_DROP);
	const periodsFlag = flagValue(flags, "--periods");
	const periods = parsePeriods(periodsFlag);
	const ceilingMs = durationFlag(flags, "--ceiling-min", {
		fallback: DEFAULT_CEILING_MIN,
		unitMs: MS_PER_MIN,
		min: MIN_CEILING_MIN,
	});
	const usage = CLI.commands?.report?.usage ?? CLI.usage;
	if (!root || !baseline || !(drop > 0 && drop < 1)) return refuse(p, usage);
	if (!periods)
		return refuse(
			p,
			`--periods takes whole pair numbers above 1, got ${periodsFlag}\n${usage}`,
		);
	if (ceilingMs === null)
		return refuse(
			p,
			`--ceiling-min takes minutes, at least ${MIN_CEILING_MIN}, got ${flagValue(flags, "--ceiling-min")}\n${usage}`,
		);
	const recs = readLaunched(path.resolve(root));
	// PATH's CLI, not the plan's: reading starts no run, so its version
	// splits none, and the report still reads once an update removes the
	// plan's binary.
	const states = readStatesByConfigDir(p, recs, claudeBin(p.env));
	const subjects = readRegisteredGuardSubjects(p.hostRoot());
	const rows = recs.map((r) => readRun(p, r, states, subjects));
	/** @type {{ row: (typeof rows)[number], score: number, versions: string[], messages: number, families: ReturnType<typeof familiesOf>, concision: number, environment: number }[]} */
	const withScore = [];
	for (const row of rows)
		if (row.score && "score" in row.score)
			withScore.push({
				row,
				score: row.score.score,
				versions: row.score.versions,
				messages: row.score.assistantMessages,
				families: familiesOf(row.score),
				concision: row.score.families.concision,
				environment: row.score.families.environment,
			});
	const version = modalVersion(withScore.map((s) => s.versions));
	const isModal = (/** @type {(typeof withScore)[number]} */ s) =>
		s.versions.length === 1 && s.versions[0] === version;
	const onVersion = withScore.filter(
		(s) => flags["--every-version"] === true || isModal(s),
	);
	const offVersion = withScore
		.filter((s) => !isModal(s))
		.map((s) => ({ id: s.row.id, versions: s.versions }));
	const scored = onVersion.map((s) => ({
		task: s.row.task,
		arm: s.row.arm,
		score: s.score,
	}));
	const perArm = (
		/** @type {string} */ a,
		/** @type {(s: (typeof onVersion)[number]) => number | null} */ pick,
	) =>
		meanVar(
			onVersion
				.filter((s) => s.row.arm === a)
				.map(pick)
				.filter((v) => v !== null),
		);
	const arms = [...new Set(scored.map((s) => s.arm))].sort();
	const byArm = Object.fromEntries(
		arms.map((a) => [
			a,
			meanVar(scored.filter((s) => s.arm === a).map((s) => s.score)),
		]),
	);
	/** Runs that ended on a question or at the ceiling; they did less work, so a gap here confounds the breach means. */
	const blockedByArm = countByArm(rows, (r) => r.state === "blocked");
	const hungByArm = countByArm(rows, (r) => r.state === "hung");
	const within = withinTask(scored);
	const m0 = byArm[baseline]?.mean ?? 0;
	/**
	 * A geometric comparison of `pick`'s value over the runs where it is above
	 * 0, naming each run left out: no value, or one with no logarithm.
	 * @param {(s: (typeof onVersion)[number]) => number | null} pick
	 */
	const compareGeo = (pick) => {
		const kept = onVersion.flatMap((s) => {
			const v = pick(s);
			return v !== null && v > 0 ? [{ s, v }] : [];
		});
		return {
			...geoComparison(
				kept.map(({ s, v }) => ({
					task: s.row.task,
					arm: s.row.arm,
					score: v,
				})),
				baseline,
			),
			leftOut: onVersion
				.filter((s) => !kept.some((k) => k.s === s))
				.map((s) => ({ id: s.row.id, value: pick(s) })),
		};
	};
	const judged = onVersion.filter((s) => typeof s.row.accept === "boolean");
	const summary = {
		launched: rows.length,
		ended: rows.filter((r) => r.ended).length,
		scored: scored.length,
		version,
		offVersion,
		harness: {
			liveSeatSignedIn: liveSeatSignedIn(p),
			transcriptsInArmDir: rows.every((r) => r.transcriptInArmDir),
			jobDirsInArmDir: rows.every((r) => r.jobDirInArmDir),
			oneVersion: offVersion.length === 0,
		},
		byArm,
		blockedByArm,
		hungByArm,
		analysis: {
			total: compare(scored, baseline),
			byFamily: Object.fromEntries(
				FAMILIES.map((f) => {
					const fam = onVersion.map((s) => ({
						task: s.row.task,
						arm: s.row.arm,
						score: s.families[f],
					}));
					return [
						f,
						{
							byArm: Object.fromEntries(
								arms.map((a) => [a, perArm(a, (s) => s.families[f])]),
							),
							...compare(fam, baseline),
						},
					];
				}),
			),
		},
		secondary: Object.fromEntries(
			arms.map((a) => [
				a,
				{
					ratePer100Messages: perArm(a, (s) =>
						s.messages > 0 ? (100 * s.score) / s.messages : null,
					),
					acceptancePassed: onVersion.filter(
						(s) => s.row.arm === a && s.row.accept === true,
					).length,
					acceptanceJudged: onVersion.filter(
						(s) => s.row.arm === a && typeof s.row.accept === "boolean",
					).length,
					spendUsd: perArm(a, (s) => s.row.spendUsd),
					/** D3: a demanded step, reported beside the score, never in it. */
					concision: perArm(a, (s) => s.concision),
					/** D3's lexical measures (#2175): reported, never tested. */
					...summariseSecondary(
						onVersion.flatMap((s) =>
							s.row.arm === a && s.row.secondary ? [s.row.secondary] : [],
						),
					),
				},
			]),
		),
		performance: {
			mantelHaenszel: mantelHaenszel(
				judged.map((s) => ({
					task: s.row.task,
					arm: s.row.arm,
					pass: s.row.accept === true,
				})),
				baseline,
			),
		},
		/** Not pre-registered, so exploratory. */
		speed: {
			hungAtCeiling: onVersion
				.filter((s) => s.row.state === "hung")
				.map((s) => s.row.id),
			minutes: compareGeo((s) => {
				const ms = s.row.state === "hung" ? ceilingMs : s.row.wallMs;
				return ms === null ? null : ms / MS_PER_MIN;
			}),
		},
		spend: {
			usd: compareGeo((s) => s.row.spendUsd),
			tokens: compareGeo((s) => s.row.tokens),
		},
		byPeriod: byPeriod(onVersion, periods, baseline),
		withinTask: within,
		runsPerArm: {
			drop,
			baselineArm: baseline,
			poisson: runsPerArm({ m0, dispersion: 1, drop }),
			measured: runsPerArm({ m0, dispersion: within.dispersion, drop }),
		},
	};
	if (flags["--json"] === true)
		p.out(`${JSON.stringify({ rows, summary }, null, 2)}\n`);
	else {
		const lines = rows.map(
			(r) =>
				`${r.id}  ${r.state}  score=${r.score && "score" in r.score ? r.score.score : "-"}  accept=${JSON.stringify(r.accept)}  transcript=${r.transcriptInArmDir ? "arm" : "MISSING"}  jobdir=${r.jobDirInArmDir ? "arm" : "MISSING"}`,
		);
		p.out(`${lines.join("\n")}\n\n${JSON.stringify(summary, null, 2)}\n`);
	}
	return 0;
}

module.exports = {
	CLI,
	launch,
	plan,
	readJobStates,
	refuse,
	report,
	run: runAll,
	start,
};
