#!/usr/bin/env node
/*
 * run-arm-test.js — runs the before/after test's sessions and reads their
 * result (#2045, `docs/research/startup-load-before-after-test.md` D2–D5).
 *
 *   node scripts/run-arm-test.js plan --root <dir> --tasks <id,id…> --runs <n>
 *       --arm A=<rev>@<config dir> --arm B=<rev>@<config dir> [--seed <n>]
 *   node scripts/run-arm-test.js launch <pair>… --root <dir> --issues <dir> --node-modules <dir>
 *   node scripts/run-arm-test.js run --root <dir> --issues <dir> --node-modules <dir>
 *       [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>]
 *   node scripts/run-arm-test.js report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>]
 *
 * `plan` writes `<root>/plan.json`: every task × run × arm, grouped into pairs
 * of one run per arm on the same task, the pairs shuffled and the arm order
 * inside each pair drawn by coin, from `--seed` so a plan can be rebuilt. It
 * records the CLI as its versioned binary and version: `claude` on PATH is a
 * link any session's update moves, so `launch` and `run` start, list and stop
 * every run through the recorded binary, and refuse once it is gone (#2289).
 *
 * `launch` builds both sandboxes of each named pair through `arm-tasks.js
 * build`, then starts each as a `claude --bg` job in its arm's config dir, in
 * the pair's order, so neither member starts while the other is still being
 * built. A pair starts only where admission has a slot for each member and no
 * more than D5's two pairs would then be running; `run --max-running` raises
 * that cap (#2046), leaving admission the only check on the machine's memory.
 * A `--bg` job keeps the
 * launcher's PATH, which reaches the gh stub, but drops other variables
 * (#2045), so the sandbox's own variables go in its
 * `.claude/settings.local.json` `env`, which is gitignored and the same in
 * both arms. A `--bg` launch refuses a folder never trusted, so the sandbox
 * is trusted in the arm's `.claude.json` first.
 *
 * `run` is `launch` in a loop (#2046): it takes the plan's pairs in order,
 * starts the next once `--pace-min` has passed since the last start and
 * `launch` would admit it, stops a run still going past `--ceiling-min` and
 * records it `hung`, and exits once every pair has started and every run has
 * ended. A build or launch failure exits, since the next pass would repeat
 * it. It drops the starting session's id, which would outlive that session,
 * and logs why a pair is held each time the reason changes (#2046).
 *
 * `report` scores each launched run that has ended (`score-session-
 * breaches.js`), judges its sandbox (`arm-tasks.js accept`), checks the
 * harness assumptions — the live seat still signed in, each transcript and
 * job dir under its arm's own config dir, one CLI version — and prints each
 * arm's mean and within-task variance with the runs per arm a main run needs
 * against `--baseline`. A run on any CLI version but the most common is
 * listed and left out of the statistics, unless `--every-version`, the
 * founder's ruling for #2046's main run (#2241), counts it. Beside D3's
 * score it compares acceptance, wall time and spend within task (#2241),
 * prints D3's lexical secondary measures per arm (`lib/arm-secondary.js`), and
 * `--periods` names the first pair of each period after the first, for a
 * per-period split and a post hoc arm × period check. A hung run's wall time
 * counts at `--ceiling-min`, the run's ceiling.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing and files no issue, and it
 * writes outside the repo.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { spawnSync } = require("node:child_process");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { isTerminalAgent } = require("./lib/agent-liveness.js");
const { forgetSession } = require("./lib/session-id.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { stopOn } = require("./lib/claude-stop.js");
const { jobDirPath } = require("./lib/job-paths.js");
const {
	geoComparison,
	heterogeneity,
	mannWhitney,
	mantelHaenszel,
	meanVar,
	poissonArm,
	runsPerArm,
	withinTask,
} = require("./lib/arm-stats.js");
const {
	DENY_GUARD_JOIN,
	INVENTORY,
	JOB_DIR,
	MIXED,
	MOVED,
	UNATTRIBUTED,
} = require("./lib/breach-score-rule.js");
const { sessionSpendUsd, sessionTokens } = require("./lib/session-spend.js");
const { projectSlug } = require("./lib/project-slug.js");
const { throttleEnv } = require("./lib/throttle-paths.js");
const { secondaryOf, summariseSecondary } = require("./lib/arm-secondary.js");
const { readRegisteredGuardSubjects } = require("./lib/guard-fires.js");
const { hostRoot } = require("./lib/host-root.js");

/** `WFC_ARM_TASKS_CLI` stands a test's stub in for the task builder. */
const armTasksCli = () =>
	process.env.WFC_ARM_TASKS_CLI || path.join(__dirname, "arm-tasks.js");
/** `WFC_ADMISSION_CLI` stands a test's stub in for the admission check. */
const admissionCli = () =>
	process.env.WFC_ADMISSION_CLI || path.join(__dirname, "admission.js");
const SCORER = path.join(__dirname, "score-session-breaches.js");
/**
 * `WFC_ARM_CLAUDE_BIN` stands a test's stub in for `claude`, which `plan`
 * resolves and `report` runs. Not
 * agent-liveness's `claudeBin`: its `WFC_CLAUDE_BIN` is set on this machine to
 * a wrapper that unions every plan's listing, and an arm's jobs must be read
 * from that arm's config dir alone (#2045).
 */
const claudeBin = () => process.env.WFC_ARM_CLAUDE_BIN || "claude";
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
/** Hang guards, not measurements: each call returns in seconds when well. */
const CALL_TIMEOUT_MS = 120_000;
/** A scorer or acceptance check reads a whole sandbox or transcript. */
const READ_TIMEOUT_MS = 900_000;

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage:
		"Usage: node scripts/run-arm-test.js (plan --root <dir> --tasks <ids> --runs <n> --arm A=<rev>@<dir> --arm B=<rev>@<dir> [--seed <n>] | launch <pair>… --root <dir> --issues <dir> --node-modules <dir> | run --root <dir> --issues <dir> --node-modules <dir> [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>] | report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>])",
	commands: {
		plan: {
			usage:
				"Usage: node scripts/run-arm-test.js plan --root <dir> --tasks <ids> --runs <n> --arm A=<rev>@<dir> --arm B=<rev>@<dir> [--seed <n>]",
			flags: {
				"--root": "value",
				"--tasks": "value",
				"--runs": "value",
				"--arm": "list",
				"--seed": "value",
			},
		},
		launch: {
			usage:
				"Usage: node scripts/run-arm-test.js launch <pair>… --root <dir> --issues <dir> --node-modules <dir>",
			min: 1,
			max: Number.POSITIVE_INFINITY,
			flags: {
				"--root": "value",
				"--issues": "value",
				"--node-modules": "value",
			},
		},
		run: {
			usage:
				"Usage: node scripts/run-arm-test.js run --root <dir> --issues <dir> --node-modules <dir> [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>]",
			flags: {
				"--root": "value",
				"--issues": "value",
				"--node-modules": "value",
				"--ceiling-min": "value",
				"--pace-min": "value",
				"--max-running": "value",
				"--poll-sec": "value",
			},
		},
		report: {
			usage:
				"Usage: node scripts/run-arm-test.js report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>]",
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
 * @typedef {Run & { repo: string, job: string, launchedAt: string, hung?: string }} LaunchRecord `hung` is when the ceiling stopped it
 * @typedef {{ sessionId: string, state: string, kind: string }} Job
 * @typedef {Map<string, Job> | null} JobStates null where the listing cannot be read
 * @typedef {{ score: number, versions: string[], assistantMessages: number, stop: Record<string, number>, deny: Record<string, number>, families: { concision: number, environment: number } } | { error: string }} Score
 */

/** @param {string} msg */
function refuse(msg) {
	writeFd(2, `✗ ${msg}\n`);
	return 2;
}

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
	const m = /^([^=]+)=([^@]+)@(.+)$/.exec(spec);
	if (!m) return null;
	const [, arm = "", rev = "", dir = ""] = m;
	return { arm, rev, configDir: path.resolve(dir) };
}

/**
 * `claudeBin()` found on PATH and followed through every link to its
 * versioned binary, with the version that binary reports; the reason where
 * none answers.
 * @returns {Cli | string}
 */
function resolveCli() {
	const name = claudeBin();
	const candidates = name.includes("/")
		? [name]
		: (process.env.PATH ?? "")
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
	const r = spawnSync(real, ["--version"], {
		encoding: "utf8",
		timeout: CALL_TIMEOUT_MS,
	});
	const version = /^\S+/.exec((r.stdout ?? "").trim())?.[0];
	if (r.status !== 0 || !version)
		return `${real} --version printed no version (exit ${r.status}${r.error ? `, ${r.error.message}` : ""})`;
	return { path: real, version };
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

/** @param {import("./lib/cli-args").Parsed} parsed */
function plan({ flags, lists }) {
	const root = flagValue(flags, "--root");
	const tasks = (flagValue(flags, "--tasks") ?? "").split(",").filter(Boolean);
	const runs = Number(flagValue(flags, "--runs"));
	/** @type {Arm[]} */
	const arms = [];
	for (const spec of lists["--arm"] ?? []) {
		const arm = parseArm(spec);
		if (arm) arms.push(arm);
	}
	const seed = Number(flagValue(flags, "--seed") ?? Date.now() % 2 ** 31);
	if (!root || tasks.length === 0 || !Number.isInteger(runs) || runs < 1)
		return refuse(CLI.usage);
	if (arms.length !== PAIR_SIZE || (lists["--arm"] ?? []).length !== PAIR_SIZE)
		return refuse(
			"--arm takes <name>=<rev>@<config dir>, exactly twice: one per arm",
		);
	const file = path.join(path.resolve(root), "plan.json");
	if (fs.existsSync(file))
		return refuse(
			`${file} exists; a plan is written once, so give a new --root`,
		);
	const cli = resolveCli();
	if (typeof cli === "string") return refuse(cli);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const made = buildPlan({
		tasks,
		runs,
		arms,
		seed,
		root: path.resolve(root),
	});
	fs.writeFileSync(file, `${JSON.stringify({ ...made, cli }, null, 2)}\n`);
	writeFd(1, `${made.runs.map((r) => r.id).join("\n")}\n`);
	return 0;
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
function readLaunched(root) {
	const dir = path.join(root, "launched");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
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
 */
function sandboxEnv(sandbox) {
	return {
		WFC_GH: path.join(sandbox, "bin", "gh"),
		GH_HOST: "gh-stub.invalid",
		GIT_ALLOW_PROTOCOL: "file",
		DISABLE_AUTOUPDATER: "1",
		...throttleEnv(),
	};
}

/**
 * Build one run's sandbox and ready it for a `--bg` job: its env file, and
 * its repo trusted in the arm's config dir.
 * @param {Run} run
 * @param {{ issues: string, nodeModules: string }} opts
 * @returns {{ ok: true, repo: string, prompt: string } | { ok: false, why: string }}
 */
function prepare(run, { issues, nodeModules }) {
	if (!fs.existsSync(path.join(run.configDir, ".claude.json")))
		return {
			ok: false,
			why: `${run.configDir} holds no .claude.json: log it in first (CLAUDE_CONFIG_DIR=${run.configDir} claude auth login)`,
		};
	const built = spawnSync(
		process.execPath,
		[
			armTasksCli(),
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
		{ encoding: "utf8", maxBuffer: CHILD_MAX_BUFFER },
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
			why: `the builder printed no task record: ${built.stdout.slice(0, 200)}`,
		};
	}
	const repo = fs.realpathSync(task.sandbox.repo);
	const local = path.join(repo, ".claude", "settings.local.json");
	fs.mkdirSync(path.dirname(local), { recursive: true });
	fs.writeFileSync(
		local,
		`${JSON.stringify({ env: sandboxEnv(run.sandbox) }, null, 2)}\n`,
	);
	trust(run.configDir, repo);
	return { ok: true, repo, prompt: task.prompt };
}

/**
 * Start one prepared run as a `claude --bg` job in its arm's config dir.
 * @param {Run} run
 * @param {{ repo: string, prompt: string }} ready
 * @param {string} bin
 * @returns {{ ok: true, record: LaunchRecord } | { ok: false, why: string }}
 */
function start(run, { repo, prompt }, bin) {
	const launched = spawnSync(
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
		{
			cwd: repo,
			encoding: "utf8",
			timeout: CALL_TIMEOUT_MS,
			env: {
				...process.env,
				...sandboxEnv(run.sandbox),
				CLAUDE_CONFIG_DIR: run.configDir,
				PATH: `${path.join(run.sandbox, "bin")}:${process.env.PATH}`,
			},
		},
	);
	const job = /backgrounded\s+·\s+(\S+)/.exec(launched.stdout)?.[1];
	if (launched.status !== 0 || !job)
		return {
			ok: false,
			why: `launch failed (${launched.status}), check \`CLAUDE_CONFIG_DIR=${run.configDir} claude agents\` before relaunching: ${`${launched.stdout}${launched.stderr}`.trim()}`,
		};
	return {
		ok: true,
		record: { ...run, repo, job, launchedAt: new Date().toISOString() },
	};
}

/**
 * Free session slots by `admission.js`, or 0 with the reason where it cannot
 * say (#2045).
 * @returns {{ slots: number, why?: string }}
 */
function readAdmissionSlots() {
	const r = spawnSync(process.execPath, [admissionCli(), "--json"], {
		encoding: "utf8",
		timeout: CALL_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
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
			why: `admission printed no reading (exit ${r.status}): ${r.stderr.trim().slice(0, 200)}`,
		};
	}
}

/**
 * Each job's record from `claude agents --json --all` in one config dir,
 * keyed by the job id `--bg` printed. A `--bg` launch ignores `--session-id`
 * (#2045), so the listing is the one map from job to
 * transcript.
 * @param {string} configDir
 * @param {string} bin
 * @returns {JobStates}
 */
function readJobStates(configDir, bin) {
	const r = spawnSync(bin, ["agents", "--json", "--all"], {
		encoding: "utf8",
		timeout: CALL_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
		env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
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
 * @param {LaunchRecord[]} recs
 * @param {string} bin
 * @returns {Map<string, JobStates>}
 */
function readStatesByConfigDir(recs, bin) {
	/** @type {Map<string, JobStates>} */
	const states = new Map();
	for (const r of recs)
		if (!states.has(r.configDir))
			states.set(r.configDir, readJobStates(r.configDir, bin));
	return states;
}

/**
 * Whether a launched run has ended: done, failed or stopped, `blocked` on a
 * question, which nobody answers in either arm (#2045), or stopped at the
 * ceiling (#2046). A
 * run whose job the listing does not show counts as running, so an
 * unreadable listing never admits another pair.
 * @param {LaunchRecord} rec
 * @param {Map<string, JobStates>} states
 */
function ended(rec, states) {
	if (rec.hung) return true;
	const job = states.get(rec.configDir)?.get(rec.job);
	if (job === undefined) return false;
	return isTerminalAgent(job) || job.state === "blocked";
}

/**
 * Why a pair of `size` cannot start now, or null where it can: the running
 * cap first, then admission.
 * @param {string} root
 * @param {number} size
 * @param {string} bin
 * @param {number} maxRunning
 */
function heldBack(root, size, bin, maxRunning = DEFAULT_MAX_RUNNING) {
	const launched = readLaunched(root);
	const states = readStatesByConfigDir(launched, bin);
	const running = launched.filter((r) => !ended(r, states)).length;
	if (running + size > maxRunning)
		return `${running} session(s) still running, the cap is ${maxRunning}; launch again when a pair ends`;
	const { slots, why } = readAdmissionSlots();
	if (slots < size)
		return `admission has ${slots} slot(s), a pair needs ${size}; launch again when admission frees${why ? ` (${why})` : ""}`;
	return null;
}

/**
 * Build both of a pair's sandboxes, then start both; neither starts when
 * either build fails. Whether every member started.
 * @param {Run[]} members
 * @param {string} dir the `launched` dir
 * @param {{ issues: string, nodeModules: string }} opts
 * @param {string} bin
 */
function launchPair(members, dir, opts, bin) {
	/** @type {{ run: Run, ready: { repo: string, prompt: string } }[]} */
	const prepared = [];
	for (const run of members) {
		const p = prepare(run, opts);
		if (!p.ok) {
			writeFd(2, `✗ ${run.id}: ${p.why}\n`);
			return false;
		}
		prepared.push({ run, ready: p });
	}
	let ok = true;
	for (const { run, ready } of prepared) {
		const s = start(run, ready, bin);
		if (!s.ok) {
			writeFd(2, `✗ ${run.id}: ${s.why}\n`);
			ok = false;
			continue;
		}
		fs.writeFileSync(
			path.join(dir, `${run.id}.json`),
			`${JSON.stringify(s.record, null, 2)}\n`,
		);
		writeFd(1, `${run.id}: job ${s.record.job}\n`);
	}
	return ok;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function launch({ flags, positionals }) {
	const root = flagValue(flags, "--root");
	const issues = flagValue(flags, "--issues");
	const nodeModules = flagValue(flags, "--node-modules");
	if (!root || !issues || !nodeModules) return refuse(CLI.usage);
	const at = path.resolve(root);
	const { cli, runs } = readPlan(at);
	const pairs = positionals.map(Number);
	const last = Math.max(...runs.map((r) => r.pair));
	if (runs.filter((r) => pairs.includes(r.pair)).length !== pairs.length * 2)
		return refuse(
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
		if (gone) return refuse(`pair ${pair} and after: ${gone}`);
		const members = runs.filter((r) => r.pair === pair);
		const done = members.filter((r) =>
			fs.existsSync(path.join(dir, `${r.id}.json`)),
		);
		if (done.length > 0) {
			writeFd(
				2,
				`✗ pair ${pair}: ${done.map((r) => r.id).join(", ")} already launched; drop the pair from the list\n`,
			);
			failed++;
			continue;
		}
		const held = heldBack(at, members.length, cli.path);
		if (held) {
			writeFd(2, `✗ pair ${pair} and after: ${held}\n`);
			return 1;
		}
		if (!launchPair(members, dir, opts, cli.path)) failed++;
	}
	return failed === 0 ? 0 : 1;
}

/** @param {number} ms */
const sleep = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Stop each run the listing shows still going past `ceilingMs`, and record it
 * `hung`. A run the listing does not
 * show is left: an unreadable listing stops nothing.
 * @param {string} root
 * @param {number} ceilingMs
 * @param {string} bin
 */
function reapHung(root, ceilingMs, bin) {
	const recs = readLaunched(root);
	const states = readStatesByConfigDir(recs, bin);
	for (const rec of recs) {
		if (ended(rec, states) || !states.get(rec.configDir)?.has(rec.job))
			continue;
		if (Date.now() - Date.parse(rec.launchedAt) <= ceilingMs) continue;
		const r = stopOn(rec.configDir, rec.job, bin);
		if (!r.ok) {
			writeFd(
				2,
				`✗ ${rec.id}: past the ceiling but \`claude stop ${rec.job}\` failed (${r.why}); tried again next pass\n`,
			);
			continue;
		}
		fs.writeFileSync(
			path.join(root, "launched", `${rec.id}.json`),
			`${JSON.stringify({ ...rec, hung: new Date().toISOString() }, null, 2)}\n`,
		);
		writeFd(1, `${rec.id}: still going past the ceiling, stopped as hung\n`);
	}
}

/**
 * A minute or second flag as milliseconds, or null where it is not a number
 * at least `min`.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @param {string} name
 * @param {{ fallback: number, unitMs: number, min: number }} spec
 */
function durationFlag(flags, name, { fallback, unitMs, min }) {
	const n = Number(flagValue(flags, name) ?? fallback);
	return Number.isFinite(n) && n >= min ? n * unitMs : null;
}

/**
 * A whole-number flag, or null where it is not an integer at least `min`.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @param {string} name
 * @param {{ fallback: number, min: number }} spec
 */
function countFlag(flags, name, { fallback, min }) {
	const n = Number(flagValue(flags, name) ?? fallback);
	return Number.isInteger(n) && n >= min ? n : null;
}

/**
 * `run`'s flags, or the refusal where one is missing or malformed.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
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
 * One pass of `run`: stop the hung, then start the next pair where the pace
 * and `launch`'s own checks allow. `done` once every pair has started and
 * every run ended; a number is the exit status of a failure.
 * @param {Plan} plan
 * @param {Exclude<ReturnType<typeof runOptions>, string>} o
 * @returns {"done" | "launched" | "wait" | { held: string } | number}
 */
function runPass({ cli, runs }, o) {
	const gone = cliGone(cli);
	if (gone) return refuse(gone);
	reapHung(o.root, o.ceilingMs, cli.path);
	const launched = readLaunched(o.root);
	const started = new Set(launched.map((r) => r.id));
	const pending = runs.filter((r) => !started.has(r.id));
	if (pending.length === 0) {
		const states = readStatesByConfigDir(launched, cli.path);
		return launched.every((r) => ended(r, states)) ? "done" : "wait";
	}
	const next = Math.min(...pending.map((r) => r.pair));
	const members = runs.filter((r) => r.pair === next);
	if (members.some((r) => started.has(r.id)))
		return refuse(
			`pair ${next} is half-launched; stop its running member and remove its record from ${path.join(o.root, "launched")}, then run again`,
		);
	const last = Math.max(0, ...launched.map((r) => Date.parse(r.launchedAt)));
	if (Date.now() - last < o.paceMs) return "wait";
	const held = heldBack(o.root, members.length, cli.path, o.maxRunning);
	if (held) return { held: `pair ${next} held: ${held}` };
	return launchPair(members, path.join(o.root, "launched"), o.build, cli.path)
		? "launched"
		: 1;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function runAll({ flags }) {
	const o = runOptions(flags);
	if (typeof o === "string") return refuse(o);
	// Every child the loop spawns reads this environment, the launches included.
	forgetSession(process.env);
	const planned = readPlan(o.root);
	fs.mkdirSync(path.join(o.root, "launched"), { recursive: true });
	let lastHeld = "";
	for (;;) {
		const step = runPass(planned, o);
		if (typeof step === "number") return step;
		if (step === "done") {
			writeFd(1, "every pair started and every run ended\n");
			return 0;
		}
		const held = typeof step === "object" ? step.held : "";
		if (held && held !== lastHeld) writeFd(1, `${held}\n`);
		lastHeld = held;
		if (step !== "launched") sleep(o.pollMs);
	}
}

/**
 * Whether the launcher's own seat is still signed in, so the arms' logins
 * did not sign it out; null where `claude auth status` cannot say
 * (#2045).
 */
function liveSeatSignedIn() {
	const r = spawnSync(claudeBin(), ["auth", "status"], {
		encoding: "utf8",
		timeout: CALL_TIMEOUT_MS,
	});
	try {
		return JSON.parse(r.stdout).loggedIn === true;
	} catch {
		return null;
	}
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function runJson(cmd, args) {
	const r = spawnSync(process.execPath, [cmd, ...args], {
		encoding: "utf8",
		timeout: READ_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	try {
		return { status: r.status, json: JSON.parse(r.stdout) };
	} catch {
		// A crash or a refusal leaves no JSON; the run is reported, not scored (#2045).
		return { status: r.status, json: null, err: r.stderr.trim() };
	}
}

/**
 * A transcript's first to last timestamp, or null where it has fewer than two.
 * @param {string} file
 */
function readWallMs(file) {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		let at;
		try {
			at = Date.parse(JSON.parse(line).timestamp);
		} catch {
			// A blank or torn line carries no time.
			continue;
		}
		if (!Number.isFinite(at)) continue;
		first = Math.min(first, at);
		last = Math.max(last, at);
	}
	return last > first ? last - first : null;
}

/**
 * One launched run's row.
 * @param {LaunchRecord} rec
 * @param {Map<string, JobStates>} states
 * @param {import("./lib/guard-fires").Subject[]} subjects the registered guards, for the warn measure
 */
function readRun(rec, states, subjects) {
	const job = states.get(rec.configDir)?.get(rec.job);
	const transcript = path.join(
		rec.configDir,
		"projects",
		projectSlug(rec.repo),
		`${job?.sessionId ?? rec.job}.jsonl`,
	);
	/** @type {{ id: string, pair: number, task: string, arm: string, job: string, state: string, ended: boolean, transcriptInArmDir: boolean, jobDirInArmDir: boolean, score: Score | null, accept: boolean | { error: string } | null, spendUsd: number | null, tokens: number | null, wallMs: number | null, secondary: ReturnType<typeof secondaryOf> | null }} */
	const row = {
		id: rec.id,
		pair: rec.pair,
		task: rec.task,
		arm: rec.arm,
		job: rec.job,
		state: rec.hung ? "hung" : (job?.state ?? "unknown"),
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
	if (!row.ended || !row.transcriptInArmDir) return row;
	row.spendUsd = sessionSpendUsd(transcript);
	row.tokens = sessionTokens(transcript);
	row.wallMs = readWallMs(transcript);
	row.secondary = secondaryOf(fs.readFileSync(transcript, "utf8"), subjects);
	const s = runJson(SCORER, ["--file", transcript, "--json"]);
	row.score = s.json?.[0] ?? { error: s.err ?? `exit ${s.status}` };
	const a = runJson(armTasksCli(), [
		"accept",
		rec.task,
		"--sandbox",
		rec.sandbox,
		"--json",
	]);
	row.accept = a.json ? a.json.pass : { error: a.err ?? `exit ${a.status}` };
	return row;
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
 * @param {import("./lib/arm-stats.js").Scored[]} scored
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

/** @param {import("./lib/cli-args").Parsed} parsed */
function report({ flags }) {
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
	if (!root || !baseline || !(drop > 0 && drop < 1)) return refuse(usage);
	if (!periods)
		return refuse(
			`--periods takes whole pair numbers above 1, got ${periodsFlag}\n${usage}`,
		);
	if (ceilingMs === null)
		return refuse(
			`--ceiling-min takes minutes, at least ${MIN_CEILING_MIN}, got ${flagValue(flags, "--ceiling-min")}\n${usage}`,
		);
	const recs = readLaunched(path.resolve(root));
	// PATH's CLI, not the plan's: reading starts no run, so its version
	// splits none, and the report still reads once an update removes the
	// plan's binary.
	const states = readStatesByConfigDir(recs, claudeBin());
	const subjects = readRegisteredGuardSubjects(hostRoot());
	const rows = recs.map((r) => readRun(r, states, subjects));
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
			liveSeatSignedIn: liveSeatSignedIn(),
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
		writeFd(1, `${JSON.stringify({ rows, summary }, null, 2)}\n`);
	else {
		const lines = rows.map(
			(r) =>
				`${r.id}  ${r.state}  score=${r.score && "score" in r.score ? r.score.score : "-"}  accept=${JSON.stringify(r.accept)}  transcript=${r.transcriptInArmDir ? "arm" : "MISSING"}  jobdir=${r.jobDirInArmDir ? "arm" : "MISSING"}`,
		);
		writeFd(1, `${lines.join("\n")}\n\n${JSON.stringify(summary, null, 2)}\n`);
	}
	return 0;
}

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrExit(argv, CLI);
	if (parsed.command === "plan") return plan(parsed);
	if (parsed.command === "launch") return launch(parsed);
	if (parsed.command === "run") return runAll(parsed);
	if (parsed.command === "report") return report(parsed);
	return refuse(CLI.usage);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
