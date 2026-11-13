// @vitest-environment node
/*
 * The before/after test's runner (#2045, #2046) as a program: its boundary
 * set (§X11, #5149) — a plan pinning PATH's versioned claude (#2289), a launch
 * through the builder, admission and claude at their WFC_* vars, a run
 * stopping a hung run on the real clocks, a report through the real scorer
 * and acceptance check, and a refused report — and the statistics
 * lib/arm-stats.js gives it. Every other case is a module case on its core,
 * lib/run-arm.test.ts. A break here mislabels which arm a session ran in,
 * starts more sessions than the machine holds, leaves a hung run holding its
 * slots all night, or sizes or reads the main run wrongly, each of which
 * costs a night's runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
} from "./lib/agents-stop-fake";
import { FAKE_VERSION } from "./lib/arm-claude-fake";
import { writeLaunchAnswer } from "./lib/bg-launch-fake";
import {
	buildBgBranch,
	buildVersionBranch,
	writeClaudeStub,
} from "./lib/claude-stub";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const ROOT = path.resolve(__dirname, "..");
const cliPath = path.join(ROOT, "scripts", "run-arm-test.js");
const {
	geoMeanRatio,
	heterogeneity,
	mannWhitney,
	mantelHaenszel,
	poissonArm,
	runsPerArm,
	withinTask,
} = require("./lib/arm-stats.js");

const { projectSlug } = require("./lib/project-slug.js");

const STUB_JOB = "0000000a";

const VERSION_BRANCH = buildVersionBranch(FAKE_VERSION);

/**
 * A `claude` stub: `agents` lists `agents`, `auth status` says signed in,
 * `--version` says FAKE_VERSION, and a `--bg` launch is logged to `log` and
 * answered with the recorded launch naming STUB_JOB.
 */
const claudeStub = (
	agents: { id: string; sessionId?: string; state: string }[],
	log = path.join(tmp, "claude.log"),
) => {
	const answer = writeLaunchAnswer(tmp, STUB_JOB, "positional");
	const logLaunch = `node -e ${shellQuote('require("fs").appendFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),cfg:process.env.CLAUDE_CONFIG_DIR,path:process.env.PATH})+"\\n")')} ${shellQuote(log)} "$@"`;
	return writeClaudeStub(path.join(tmp, "claude"), [
		VERSION_BRANCH,
		buildAgentsBranch(
			agents.map(({ id, state, ...over }) => buildJobRow(id, state, over)),
		),
		buildBgBranch({ ...answer, onLaunch: logLaunch }),
	]);
};

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arm-run-"));
	claudeStub([]);
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** `plan` resolves the stub every case's `beforeEach` writes, which later stubs overwrite in place. */
const planEnv = () => ({
	...process.env,
	WFC_CLAUDE_BIN: path.join(tmp, "claude"),
});

const BUILDER = path.join(ROOT, "scripts", "lib", "fixtures", "arm-build.js");

/** The arms' config dirs, logged in. */
const loggedIn = () => {
	for (const arm of ["cfg-a", "cfg-b"]) {
		fs.mkdirSync(path.join(tmp, arm), { recursive: true });
		fs.writeFileSync(path.join(tmp, arm, ".claude.json"), "{}");
	}
};

/** The builder fake, and an admission stub answering `slots` slots. */
const stubEnv = (slots: number) => {
	const admission = path.join(tmp, "admission.js");
	fs.writeFileSync(
		admission,
		`console.log(${JSON.stringify(JSON.stringify({ ...ADMISSION_VERDICT, slots }))});`,
	);
	return {
		...process.env,
		WFC_ARM_TASKS_CLI: BUILDER,
		WFC_ADMISSION_CLI: admission,
	};
};

const run = (args: string[], env: NodeJS.ProcessEnv = planEnv()) => {
	const r = runInProcess(cliPath, args, { cwd: ROOT, env });
	return { out: r.stdout, err: r.stderr, code: r.status };
};

const planArgs = (root: string, seed: string) => [
	"plan",
	"--root",
	root,
	"--tasks",
	"t1,t2",
	"--runs",
	"3",
	"--arm",
	`A=revA@${path.join(tmp, "cfg-a")}`,
	"--arm",
	`B=revB@${path.join(tmp, "cfg-b")}`,
	"--seed",
	seed,
];

const readPlan = (root: string) =>
	JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));

describe("plan", () => {
	it("records the versioned binary PATH's claude links to, and its version (#2289)", () => {
		const versions = path.join(tmp, "versions");
		const bin = path.join(tmp, "bin");
		fs.mkdirSync(versions);
		fs.mkdirSync(bin);
		fs.renameSync(path.join(tmp, "claude"), path.join(versions, FAKE_VERSION));
		fs.symlinkSync(path.join(versions, FAKE_VERSION), path.join(bin, "claude"));
		const { WFC_CLAUDE_BIN: _, ...env } = process.env;
		const root = path.join(tmp, "p");
		expect(
			run(planArgs(root, "1"), {
				...env,
				// claude-route-exempt: asserts the plan pins PATH's versioned `claude`
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			}).code,
		).toBe(0);
		expect(readPlan(root).cli).toEqual({
			path: fs.realpathSync(path.join(versions, FAKE_VERSION)),
			version: FAKE_VERSION,
		});
	});
});

describe("launch", () => {
	/** The arms' config dirs logged in, claude as `claudeStub`, logging each
	 * launch to `log`. */
	const stubs = () => {
		loggedIn();
		const log = path.join(tmp, "claude.log");
		return {
			env: { ...stubEnv(2), WFC_CLAUDE_BIN: claudeStub([], log) },
			log,
		};
	};

	const launchArgs = (root: string, pair: string) => [
		"launch",
		pair,
		"--root",
		root,
		"--issues",
		tmp,
		"--node-modules",
		tmp,
	];

	it("starts each pair member in its arm's config dir, trusted, with the sandbox's env written where a --bg job reads it", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, log } = stubs();
		const r = run(launchArgs(root, "1"), env);
		expect(r.code).toBe(0);
		const calls = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const pair = readPlan(root).runs.filter(
			(x: { pair: number }) => x.pair === 1,
		);
		expect(calls.map((c) => c.cfg)).toEqual(
			pair.map((x: { configDir: string }) => x.configDir),
		);
		for (const [i, c] of calls.entries()) {
			const repo = fs.realpathSync(path.join(pair[i].sandbox, "repo"));
			expect(c.cwd).toBe(repo);
			expect(c.argv.slice(0, 3)).toEqual([
				"--bg",
				"--model",
				"claude-opus-5-5[1m]",
			]);
			expect(c.argv.at(-1)).toBe("/implement 1");
			expect(c.path.split(":")[0]).toBe(path.join(pair[i].sandbox, "bin"));
			const local = JSON.parse(
				fs.readFileSync(
					path.join(repo, ".claude", "settings.local.json"),
					"utf8",
				),
			);
			expect(local.env.WFC_GH).toBe(path.join(pair[i].sandbox, "bin", "gh"));
			const state = JSON.parse(
				fs.readFileSync(path.join(pair[i].configDir, ".claude.json"), "utf8"),
			);
			expect(state.projects[repo].hasTrustDialogAccepted).toBe(true);
		}
		const again = run(launchArgs(root, "1"), env);
		expect(again.code).toBe(1);
		expect(again.err).toContain("already launched");
	});
});

describe("the pilot's statistics", () => {
	it("gives D4's 54 runs per arm at the baseline mean with Poisson dispersion", () => {
		expect(runsPerArm({ m0: 2.78, dispersion: 1, drop: 0.3 })).toBe(54);
	});

	it("scales the runs by the measured dispersion", () => {
		expect(runsPerArm({ m0: 2.78, dispersion: 0.5, drop: 0.3 })).toBe(27);
	});

	it("pools variance within each task and arm, so a gap between tasks is not counted as noise", () => {
		const scored = [
			{ task: "t1", arm: "A", score: 1 },
			{ task: "t1", arm: "A", score: 3 },
			{ task: "t2", arm: "A", score: 10 },
			{ task: "t2", arm: "A", score: 12 },
		];
		const w = withinTask(scored);
		expect(w.pooled).toBe(2);
		expect(w.df).toBe(2);
		expect(w.dispersion).toBeCloseTo(2 / 6.5);
	});
});

describe("run", () => {
	/**
	 * A `claude` stub whose `agents` lists each of `jobs` as working, and
	 * whose `stop` appends its argv to `stops`.
	 */
	const loopStub = (jobs: string[]) => {
		const stops = path.join(tmp, "stops.log");
		const file = writeClaudeStub(path.join(tmp, "claude"), [
			VERSION_BRANCH,
			buildAgentsBranch(jobs.map((id) => buildJobRow(id, "working"))),
			buildStopBranch(stops),
		]);
		loggedIn();
		return { env: { ...stubEnv(8), WFC_CLAUDE_BIN: file }, stops };
	};

	const runArgs = (root: string, ...extra: string[]) => [
		"run",
		"--root",
		root,
		"--issues",
		tmp,
		"--node-modules",
		tmp,
		"--pace-min",
		"0",
		"--poll-sec",
		"0",
		...extra,
	];

	/**
	 * Every planned run recorded as launched `agoMin` minutes ago as job
	 * `j<i>`. The ceiling case leaves a margin of two
	 * minutes past the ceiling against the real clock, which the few seconds
	 * a run takes cannot cross.
	 */
	const seedLaunched = (root: string, agoMin: number, only?: number) => {
		const dir = path.join(root, "launched");
		fs.mkdirSync(dir, { recursive: true });
		const runs = readPlan(root).runs.slice(0, only);
		const at = new Date(Date.now() - agoMin * 60_000).toISOString();
		for (const [i, x] of runs.entries())
			fs.writeFileSync(
				path.join(dir, `${x.id}.json`),
				JSON.stringify({ ...x, repo: tmp, job: `j${i}`, launchedAt: at }),
			);
		return {
			dir,
			runs,
			jobs: runs.map((_: unknown, i: number) => `j${i}`),
		};
	};

	it("stops a run still going past the ceiling and records it hung, which ends it", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { dir, runs, jobs } = seedLaunched(root, 42);
		const { env, stops } = loopStub(jobs);
		// No claude but the plan's, so the stop goes through it (#2289).
		const r = run(runArgs(root, "--ceiling-min", "40"), {
			...env,
			WFC_CLAUDE_BIN: path.join(tmp, "absent"),
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			`${runs[0].id}: still going past the ceiling, stopped as hung`,
		);
		expect(fs.readFileSync(stops, "utf8").trim().split("\n")).toHaveLength(12);
		const rec = JSON.parse(
			fs.readFileSync(path.join(dir, `${runs[0].id}.json`), "utf8"),
		);
		expect(typeof rec.hung).toBe("string");
	});
});

describe("D3's analysis", () => {
	const scored = [3, 2, 4, 1, 3, 4, 5, 6, 4, 5, 3, 6].map((score, i) => ({
		task: i % 6 < 3 ? "t1" : "t2",
		arm: i < 6 ? "A" : "B",
		score,
	}));

	it("reads the arm's rate ratio with task strata and robust errors, as statsmodels' GLM with HC0 does", () => {
		const r = poissonArm(scored, "A");
		expect(r.rateRatio).toBeCloseTo(29 / 17, 6);
		expect(r.ci95[0]).toBeCloseTo(1.2077, 3);
		expect(r.ci95[1]).toBeCloseTo(2.4096, 3);
	});

	it("gives no ratio where an arm scored 0 in every run", () => {
		const zero = scored.map((s) => ({ ...s, score: s.arm === "A" ? 0 : 1 }));
		expect(poissonArm(zero, "A").error).toContain("arm A scored 0");
	});

	it("cross-checks with Mann-Whitney U as scipy's asymptotic test without continuity does", () => {
		const r = mannWhitney([3, 2, 4, 1, 3, 4], [5, 6, 4, 5, 3, 6]);
		expect(r.u).toBe(4);
		expect(r.p).toBeCloseTo(0.022_487, 5);
	});
});

describe("#2241's within-task comparisons", () => {
	it("reads a ratio of geometric means with task strata and HC0 errors, as statsmodels' OLS on the log does", () => {
		const values = [12, 15, 9, 20, 11, 14, 18, 25, 16, 30, 13, 22];
		const r = geoMeanRatio(
			values.map((score, i) => ({
				task: i % 6 < 3 ? "t1" : "t2",
				arm: i < 6 ? "A" : "B",
				score,
			})),
			"A",
		);
		expect(r.ratio).toBeCloseTo(1.520_988, 5);
		expect(r.ci95[0]).toBeCloseTo(1.136_731, 5);
		expect(r.ci95[1]).toBeCloseTo(2.035_138, 5);
		expect(r.p).toBeCloseTo(0.004_765, 4);
	});

	it("refuses a geometric mean over a value at 0", () => {
		const r = geoMeanRatio(
			[
				{ task: "t", arm: "A", score: 0 },
				{ task: "t", arm: "B", score: 1 },
			],
			"A",
		);
		expect(r.error).toContain("no logarithm");
	});

	it("pools acceptance odds over tasks as statsmodels' StratifiedTable does, uncorrected", () => {
		const cells = (task: string, arm: string, pass: number, fail: number) => [
			...Array.from({ length: pass }, () => ({ task, arm, pass: true })),
			...Array.from({ length: fail }, () => ({ task, arm, pass: false })),
		];
		const r = mantelHaenszel(
			[
				...cells("t1", "B", 4, 1),
				...cells("t1", "A", 2, 3),
				...cells("t2", "B", 3, 1),
				...cells("t2", "A", 2, 3),
			],
			"A",
		);
		expect(r.oddsRatio).toBeCloseTo(5.210_526, 5);
		expect(r.ci95[0]).toBeCloseTo(0.692_656, 5);
		expect(r.ci95[1]).toBeCloseTo(39.196_33, 3);
		expect(r.p).toBeCloseTo(0.116_664, 5);
	});

	it("tests the arm effect's spread over periods by Cochran's Q on k - 1 df", () => {
		const r = heterogeneity([
			{ rateRatio: 2, logSe: 0.2 },
			{ rateRatio: 1, logSe: 0.3 },
			{ rateRatio: 1.5, logSe: 0.25 },
		]);
		expect(r.q).toBeCloseTo(3.757_175, 5);
		expect(r.df).toBe(2);
		expect(r.p).toBeCloseTo(0.152_806, 5);
	});
});

describe("report", () => {
	const launched = (
		root: string,
		id: string,
		version: string,
		{
			pair = 1,
			arm = "A",
			task = "t1",
			state = "done",
			hung = false,
			extra = [] as object[],
		} = {},
	) => {
		const cfg = path.join(tmp, "cfg-a");
		const repo = path.join(tmp, id, "repo");
		const sessionId = `${id}-session`;
		const projects = path.join(cfg, "projects", projectSlug(repo));
		fs.mkdirSync(projects, { recursive: true });
		fs.mkdirSync(path.join(cfg, "jobs", id), { recursive: true });
		fs.writeFileSync(
			path.join(projects, `${sessionId}.jsonl`),
			`${JSON.stringify({ type: "user", uuid: "u0", parentUuid: null, version, timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "go" } })}\n${JSON.stringify({ type: "assistant", uuid: "u1", parentUuid: "u0", version, timestamp: "2026-10-20T10:12:00.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } })}\n${extra.map((e) => `${JSON.stringify(e)}\n`).join("")}`,
		);
		fs.mkdirSync(path.join(root, "launched"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "launched", `${id}.json`),
			JSON.stringify({
				id,
				pair,
				task,
				arm,
				configDir: cfg,
				repo,
				sandbox: path.join(tmp, id),
				job: id,
				...(hung ? { hung: "2026-10-20T11:30:00.000Z" } : {}),
			}),
		);
		return { id, sessionId, state };
	};

	it("scores each ended run from its arm's own dirs, and leaves a run on a stray CLI version out of the statistics", () => {
		const root = path.join(tmp, "p");
		const agents = [
			launched(root, "r1", "2.1.302"),
			launched(root, "r2", "2.1.302"),
			launched(root, "r3", "2.1.303"),
		];
		const r = run(["report", "--root", root, "--baseline", "A", "--json"], {
			...process.env,
			WFC_CLAUDE_BIN: claudeStub(agents),
		});
		expect(r.code).toBe(0);
		const { rows, summary } = JSON.parse(r.out);
		expect(rows[0]).toMatchObject({
			state: "done",
			ended: true,
			transcriptInArmDir: true,
			jobDirInArmDir: true,
		});
		expect(rows[0].score.score).toBe(0);
		expect(summary.harness).toEqual({
			liveSeatSignedIn: true,
			transcriptsInArmDir: true,
			jobDirsInArmDir: true,
			oneVersion: false,
		});
		expect(summary.version).toBe("2.1.302");
		expect(summary.offVersion).toEqual([{ id: "r3", versions: ["2.1.303"] }]);
		expect(summary.scored).toBe(2);
		expect(summary.runsPerArm.baselineArm).toBe("A");
		expect(summary.blockedByArm).toEqual({ A: 0 });
		expect(summary.hungByArm).toEqual({ A: 0 });
	});

	it("refuses a report that names no baseline arm", () => {
		const r = run(["report", "--root", path.join(tmp, "p")]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("--baseline <arm>");
	});
});
