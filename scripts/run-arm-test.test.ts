// @vitest-environment node
/*
 * The before/after test's runner (#2045, #2046): its plan, its launch into an
 * arm's config dir, its self-looping `run` with the hang ceiling and the CLI
 * pinned at plan time (#2289), its report, and the statistics. A break here mislabels which arm a session ran in,
 * starts more sessions than the machine holds, leaves a hung run holding its
 * slots all night, or sizes or reads the main run wrongly, each of which costs
 * a night's runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthStatusNodeBranch } from "./lib/auth-status-fake";
import { runInProcess } from "./lib/run-in-process";

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

const STUB_VERSION = "2.1.304";

/**
 * A `claude` stub: `agents` prints `agents`, `auth status` says signed in,
 * `--version` says `STUB_VERSION`, and anything else is a launch, logged to
 * `log` and answered with a job id.
 */
const claudeStub = (
	agents: { id: string; sessionId?: string; state: string }[],
	log = path.join(tmp, "claude.log"),
) => {
	const file = path.join(tmp, "claude");
	const listed = JSON.stringify(
		agents.map((a) => ({ kind: "background", ...a })),
	);
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==="--version"){console.log("${STUB_VERSION} (Claude Code)");process.exit(0)}if(a[0]==="agents"){console.log(${JSON.stringify(listed)});process.exit(0)}${buildAuthStatusNodeBranch()}require("fs").appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:a,cwd:process.cwd(),cfg:process.env.CLAUDE_CONFIG_DIR,path:process.env.PATH})+"\\n");console.log("backgrounded · job"+Math.random().toString(16).slice(2,8));\n`,
	);
	fs.chmodSync(file, 0o755);
	return file;
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
	WFC_ARM_CLAUDE_BIN: path.join(tmp, "claude"),
});

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
	it("pairs every task × run with one run per arm, the same for the same seed", () => {
		const one = path.join(tmp, "one");
		const two = path.join(tmp, "two");
		expect(run(planArgs(one, "7")).code).toBe(0);
		expect(run(planArgs(two, "7")).code).toBe(0);
		const runs = readPlan(one).runs;
		expect(runs).toHaveLength(12);
		for (let pair = 1; pair <= 6; pair++) {
			const members = runs.filter((r: { pair: number }) => r.pair === pair);
			expect(members.map((r: { arm: string }) => r.arm).sort()).toEqual([
				"A",
				"B",
			]);
			expect(new Set(members.map((r: { task: string }) => r.task)).size).toBe(
				1,
			);
		}
		expect(
			readPlan(two).runs.map((r: { id: string }) => r.id.replace("two", "")),
		).toEqual(runs.map((r: { id: string }) => r.id.replace("one", "")));
	});

	it("records the versioned binary PATH's claude links to, and its version (#2289)", () => {
		const versions = path.join(tmp, "versions");
		const bin = path.join(tmp, "bin");
		fs.mkdirSync(versions);
		fs.mkdirSync(bin);
		fs.renameSync(path.join(tmp, "claude"), path.join(versions, STUB_VERSION));
		fs.symlinkSync(path.join(versions, STUB_VERSION), path.join(bin, "claude"));
		const { WFC_ARM_CLAUDE_BIN: _, ...env } = process.env;
		const root = path.join(tmp, "p");
		expect(
			run(planArgs(root, "1"), {
				...env,
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			}).code,
		).toBe(0);
		expect(readPlan(root).cli).toEqual({
			path: fs.realpathSync(path.join(versions, STUB_VERSION)),
			version: STUB_VERSION,
		});
	});

	it("refuses a plan where no claude answers, naming why", () => {
		const silent = path.join(tmp, "silent");
		fs.writeFileSync(silent, "#!/bin/sh\nexit 1\n");
		fs.chmodSync(silent, 0o755);
		for (const [bin, why] of [
			["claude-absent", "no executable `claude-absent` on PATH"],
			[
				silent,
				`${fs.realpathSync(silent)} --version printed no version (exit 1)`,
			],
		]) {
			const root = path.join(tmp, path.basename(bin));
			const r = run(planArgs(root, "1"), {
				...process.env,
				WFC_ARM_CLAUDE_BIN: bin,
			});
			expect(r.code).toBe(2);
			expect(r.err).toContain(why);
			expect(fs.existsSync(path.join(root, "plan.json"))).toBe(false);
		}
	});

	it("refuses to overwrite a plan", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "1")).code).toBe(0);
		const again = run(planArgs(root, "2"));
		expect(again.code).toBe(2);
		expect(again.err).toContain("a plan is written once");
	});
});

describe("launch", () => {
	const admission = (slots: number) => {
		const file = path.join(tmp, `admission-${slots}.js`);
		fs.writeFileSync(file, `console.log(JSON.stringify({ slots: ${slots} }));`);
		return file;
	};

	/**
	 * Stubs: the builder makes `<to>/repo` and prints a task record, failing
	 * for a sandbox whose name ends in `-<WFC_STUB_FAIL_ARM>`; claude as
	 * `claudeStub`; the arms' config dirs logged in.
	 */
	const stubs = (agents: { id: string; state: string }[] = []) => {
		const builder = path.join(tmp, "builder.js");
		fs.writeFileSync(
			builder,
			`const fs=require("fs"),path=require("path");const a=process.argv.slice(2);const to=a[a.indexOf("--to")+1];if(process.env.WFC_STUB_FAIL_ARM&&to.endsWith("-"+process.env.WFC_STUB_FAIL_ARM)){console.error("stub build failure");process.exit(1)}fs.mkdirSync(path.join(to,"repo"),{recursive:true});fs.mkdirSync(path.join(to,"bin"),{recursive:true});process.stdout.write(JSON.stringify({prompt:"/implement 1",sandbox:{repo:path.join(to,"repo"),root:to}}));`,
		);
		for (const arm of ["cfg-a", "cfg-b"]) {
			fs.mkdirSync(path.join(tmp, arm), { recursive: true });
			fs.writeFileSync(path.join(tmp, arm, ".claude.json"), "{}");
		}
		const log = path.join(tmp, "claude.log");
		return {
			env: {
				...process.env,
				WFC_ARM_TASKS_CLI: builder,
				WFC_ARM_CLAUDE_BIN: claudeStub(agents, log),
				WFC_ADMISSION_CLI: admission(2),
			},
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

	it("starts no pair where admission has fewer than two slots", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, log } = stubs();
		const r = run(launchArgs(root, "1"), {
			...env,
			WFC_ADMISSION_CLI: admission(1),
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("a pair needs 2");
		expect(fs.existsSync(log)).toBe(false);
	});

	it("starts no pair while two pairs are still running", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const jobs = ["j1", "j2", "j3", "j4"];
		const { env, log } = stubs(jobs.map((id) => ({ id, state: "working" })));
		fs.mkdirSync(path.join(root, "launched"));
		for (const [i, job] of jobs.entries())
			fs.writeFileSync(
				path.join(root, "launched", `running-${i}.json`),
				JSON.stringify({ id: `running-${i}`, configDir: tmp, job }),
			);
		const r = run(launchArgs(root, "3"), env);
		expect(r.code).toBe(1);
		expect(r.err).toContain("4 session(s) still running");
		expect(fs.existsSync(log)).toBe(false);
	});

	it("counts a run blocked on an unanswered question as ended, freeing its pair's place", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const jobs = ["j1", "j2", "j3", "j4"];
		const { env, log } = stubs(
			jobs.map((id, i) => ({ id, state: i < 2 ? "blocked" : "working" })),
		);
		fs.mkdirSync(path.join(root, "launched"));
		for (const [i, job] of jobs.entries())
			fs.writeFileSync(
				path.join(root, "launched", `running-${i}.json`),
				JSON.stringify({ id: `running-${i}`, configDir: tmp, job }),
			);
		expect(run(launchArgs(root, "3"), env).code).toBe(0);
		expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("starts neither member of a pair when one sandbox fails to build", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, log } = stubs();
		const r = run(launchArgs(root, "1"), { ...env, WFC_STUB_FAIL_ARM: "B" });
		expect(r.code).toBe(1);
		expect(r.err).toContain("stub build failure");
		expect(fs.existsSync(log)).toBe(false);
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
	 * A `claude` stub that remembers what it launched: `agents` lists every
	 * launched job in `WFC_STUB_STATE` (`done` by default) and every job
	 * named in `WFC_STUB_EXTRA` as `working` — for its first
	 * `WFC_STUB_EXTRA_LISTINGS` listings, then `done`, where that is set —
	 * `stop` is logged, a launch runs `onLaunch` and answers a new id. Every
	 * call but `--version` and `auth` first runs `prelude`.
	 */
	const loopStub = ({
		file = path.join(tmp, "claude"),
		prelude = "",
		onLaunch = "",
	} = {}) => {
		const jobs = path.join(tmp, "jobs.log");
		const stops = path.join(tmp, "stops.log");
		const listings = path.join(tmp, "listings.log");
		fs.writeFileSync(
			file,
			`#!/usr/bin/env node
const fs=require("fs");const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("${STUB_VERSION} (Claude Code)");process.exit(0)}
${buildAuthStatusNodeBranch()}
${prelude}
const read=(f)=>fs.existsSync(f)?fs.readFileSync(f,"utf8").trim().split("\\n").filter(Boolean):[];
if(a[0]==="agents"){const st=process.env.WFC_STUB_STATE||"done";const extra=(process.env.WFC_STUB_EXTRA||"").split(",").filter(Boolean);fs.appendFileSync(${JSON.stringify(listings)},"x");const n=fs.readFileSync(${JSON.stringify(listings)},"utf8").length;const lim=Number(process.env.WFC_STUB_EXTRA_LISTINGS||Infinity);const ex=n<=lim?"working":"done";console.log(JSON.stringify([...read(${JSON.stringify(jobs)}).map(id=>({id,kind:"background",state:st})),...extra.map(id=>({id,kind:"background",state:ex}))]));process.exit(0)}
if(a[0]==="stop"){fs.appendFileSync(${JSON.stringify(stops)},a[1]+"\\n");process.exit(0)}
${onLaunch}
const id="job"+Math.random().toString(16).slice(2,8);fs.appendFileSync(${JSON.stringify(jobs)},id+"\\n");console.log("backgrounded · "+id);
`,
		);
		fs.chmodSync(file, 0o755);
		const builder = path.join(tmp, "builder.js");
		fs.writeFileSync(
			builder,
			`const fs=require("fs"),path=require("path");const a=process.argv.slice(2);const to=a[a.indexOf("--to")+1];fs.mkdirSync(path.join(to,"repo"),{recursive:true});process.stdout.write(JSON.stringify({prompt:"/implement 1",sandbox:{repo:path.join(to,"repo")}}));`,
		);
		const admission = path.join(tmp, "admission.js");
		fs.writeFileSync(admission, "console.log(JSON.stringify({ slots: 8 }));");
		for (const arm of ["cfg-a", "cfg-b"]) {
			fs.mkdirSync(path.join(tmp, arm), { recursive: true });
			fs.writeFileSync(path.join(tmp, arm, ".claude.json"), "{}");
		}
		return {
			env: {
				...process.env,
				WFC_ARM_TASKS_CLI: builder,
				WFC_ARM_CLAUDE_BIN: file,
				WFC_ADMISSION_CLI: admission,
			},
			jobs,
			stops,
		};
	};

	const launchFirstArgs = (root: string) => [
		"launch",
		"1",
		"--root",
		root,
		"--issues",
		tmp,
		"--node-modules",
		tmp,
	];

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

	it("starts every pair by itself and exits once every run has ended", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, jobs } = loopStub();
		const r = run(runArgs(root), env);
		expect(r.code).toBe(0);
		expect(r.out).toContain("every pair started and every run ended");
		expect(fs.readFileSync(jobs, "utf8").trim().split("\n")).toHaveLength(12);
		expect(fs.readdirSync(path.join(root, "launched"))).toHaveLength(12);
	});

	it("is held by no session that started it and has since ended (#2046, the main run held after its first pair)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, jobs } = loopStub();
		fs.writeFileSync(
			env.WFC_ADMISSION_CLI as string,
			`console.log(JSON.stringify(process.env.CLAUDE_CODE_SESSION_ID ? { ok: false, error: "does not list this very session" } : { slots: 8 }));`,
		);
		const r = run(runArgs(root), {
			...env,
			CLAUDE_CODE_SESSION_ID: "ended-session",
		});
		expect(r.code).toBe(0);
		expect(fs.readFileSync(jobs, "utf8").trim().split("\n")).toHaveLength(12);
	});

	it("logs why it holds a pair, once until the reason changes", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env } = loopStub();
		const count = path.join(tmp, "admission-calls");
		// Above one, so a reason logged on every held pass would print it twice.
		const refusedPasses = 3;
		fs.writeFileSync(
			env.WFC_ADMISSION_CLI as string,
			`const fs=require("fs");fs.appendFileSync(${JSON.stringify(count)},"x");const n=fs.readFileSync(${JSON.stringify(count)},"utf8").length;console.log(JSON.stringify(n<=${refusedPasses}?{ok:false,error:"listing unreadable"}:{slots:8}));`,
		);
		const r = run(runArgs(root), env);
		expect(r.code).toBe(0);
		const held =
			"pair 1 held: admission has 0 slot(s), a pair needs 2; launch again when admission frees (listing unreadable)";
		expect(r.out.split("\n").filter((l) => l === held)).toHaveLength(1);
	});

	/**
	 * Every planned run recorded as launched `agoMin` minutes ago as job
	 * `j<i>`; the env lists those jobs. The ceiling cases leave a margin of a
	 * minute or more either side of the ceiling against the real clock, which
	 * the few seconds a run takes cannot cross.
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
			extra: runs.map((_: unknown, i: number) => `j${i}`).join(","),
		};
	};

	it("stops a run still going past the ceiling and records it hung, which ends it", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, stops } = loopStub();
		const { dir, runs, extra } = seedLaunched(root, 42);
		// No claude but the plan's, so the stop goes through it (#2289).
		const r = run(runArgs(root, "--ceiling-min", "40"), {
			...env,
			WFC_ARM_CLAUDE_BIN: path.join(tmp, "absent"),
			WFC_STUB_EXTRA: extra,
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

	it("stops every run still going once its whole-run limit passes, says so, and marks each record so a later run reads it ended (#3495)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, stops } = loopStub();
		const { dir, runs, extra } = seedLaunched(root, 0, 4);
		const r = run(runArgs(root, "--limit-min", "0"), {
			...env,
			WFC_STUB_EXTRA: extra,
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			"the run's limit of 0 minutes passed; stopped every run still going",
		);
		expect(r.out).toContain(`${runs[0].id}: stopped at the run's limit`);
		expect(fs.readFileSync(stops, "utf8").trim().split("\n").sort()).toEqual([
			"j0",
			"j1",
			"j2",
			"j3",
		]);
		for (const x of runs)
			expect(
				typeof JSON.parse(
					fs.readFileSync(path.join(dir, `${x.id}.json`), "utf8"),
				).limited,
			).toBe("string");
		// Still listed as working, yet none of them holds a pair under the default cap.
		const again = run(runArgs(root), { ...env, WFC_STUB_EXTRA: extra });
		expect(again.code).toBe(0);
		expect(again.out).not.toContain("still running");
	});

	it("stops a run its listing cannot read at the limit, so an unreadable listing leaves none going", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, stops } = loopStub({
			prelude: `if(a[0]==="agents"){process.exit(1)}`,
		});
		seedLaunched(root, 0, 2);
		const r = run(runArgs(root, "--limit-min", "0"), env);
		expect(r.code).toBe(1);
		expect(fs.readFileSync(stops, "utf8").trim().split("\n").sort()).toEqual([
			"j0",
			"j1",
		]);
	});

	it("tries a failed stop again at the limit, then names each run left and its job", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const tries = path.join(tmp, "stop-tries");
		const { env } = loopStub({
			prelude: `if(a[0]==="stop"){fs.appendFileSync(${JSON.stringify(tries)},"x");console.error("daemon unreachable");process.exit(1)}`,
		});
		const { runs, extra } = seedLaunched(root, 0, 2);
		const r = run(runArgs(root, "--limit-min", "0"), {
			...env,
			WFC_STUB_EXTRA: extra,
		});
		expect(r.code).toBe(1);
		expect(fs.readFileSync(tries, "utf8")).toHaveLength(6);
		expect(r.err).toContain(
			`stopped all but ${runs[0].id} (job j0 in ${runs[0].configDir}), ${runs[1].id} (job j1 in ${runs[1].configDir}), still running after 3 tries`,
		);
	});

	it("derives its whole-run limit from the plan where --limit-min is absent: 6 pairs at a 40-minute ceiling, 10 minutes each besides", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const r = run(runArgs(root, "--ceiling-min", "40"), loopStub().env);
		expect(r.code).toBe(0);
		expect(r.out).toContain("stops every run still going after 300 minutes");
	});

	it("refuses a negative whole-run limit, naming the flag, its floor and the value given", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const r = run(runArgs(root, "--limit-min", "-1"), loopStub().env);
		expect(r.code).toBe(2);
		expect(r.err).toContain("--limit-min takes minutes, at least 0, got -1");
	});

	it("leaves a run under the ceiling going until it ends", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, stops } = loopStub();
		const { extra } = seedLaunched(root, 0);
		const r = run(runArgs(root, "--ceiling-min", "90"), {
			...env,
			WFC_STUB_EXTRA: extra,
			WFC_STUB_EXTRA_LISTINGS: "3",
		});
		expect(r.code).toBe(0);
		expect(fs.existsSync(stops)).toBe(false);
	});

	it("holds the third pair behind two running ones by default, and starts it under --max-running 6", () => {
		for (const [extra, held] of [
			[[], true],
			[["--max-running", "6"], false],
		] as const) {
			const root = path.join(tmp, `cap-${held}`);
			expect(run(planArgs(root, "3")).code).toBe(0);
			const { env } = loopStub();
			const seeded = seedLaunched(root, 0, 4);
			const r = run(runArgs(root, ...extra), {
				...env,
				WFC_STUB_EXTRA: seeded.extra,
				// The first pass's four listings: two arms, read to reap and to hold.
				WFC_STUB_EXTRA_LISTINGS: "4",
			});
			expect(r.code).toBe(0);
			expect(r.out.includes("4 session(s) still running")).toBe(held);
		}
	});

	it("refuses a running cap under one pair or between pairs, naming the floor", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		for (const cap of ["1", "5"]) {
			const r = run(runArgs(root, "--max-running", cap), loopStub().env);
			expect(r.code).toBe(2);
			expect(r.err).toContain("at least one pair's 2");
		}
	});

	it("refuses a ceiling under F11's p75 of 40 minutes", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const r = run(runArgs(root, "--ceiling-min", "39"), loopStub().env);
		expect(r.code).toBe(2);
		expect(r.err).toContain("--ceiling-min");
	});

	it("starts and lists every pair through the plan's binary after PATH's claude moves to another version (#2289)", () => {
		const versions = path.join(tmp, "versions");
		const bin = path.join(tmp, "bin");
		fs.mkdirSync(versions);
		fs.mkdirSync(bin);
		const link = path.join(bin, "claude");
		const newer = path.join(versions, "2.1.305");
		const newerCalls = path.join(tmp, "newer.log");
		// A working stub, so a run that strays onto it still ends and fails.
		loopStub({
			file: newer,
			prelude: `fs.appendFileSync(${JSON.stringify(newerCalls)},a.join(" ")+"\\n");`,
		});
		const { env, jobs } = loopStub({
			file: path.join(versions, STUB_VERSION),
			// The update another session runs, landing after the first launch.
			onLaunch: `fs.rmSync(${JSON.stringify(link)});fs.symlinkSync(${JSON.stringify(newer)},${JSON.stringify(link)});`,
		});
		fs.symlinkSync(path.join(versions, STUB_VERSION), link);
		const { WFC_ARM_CLAUDE_BIN: _, ...rest } = env;
		const onPath = {
			...rest,
			PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		};
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3"), onPath).code).toBe(0);
		const r = run(runArgs(root), onPath);
		expect(r.code).toBe(0);
		expect(fs.readlinkSync(link)).toBe(newer);
		expect(fs.readFileSync(jobs, "utf8").trim().split("\n")).toHaveLength(12);
		expect(fs.existsSync(newerCalls)).toBe(false);
	});

	it("refuses to start a pair once the plan's binary is gone, naming it (#2289)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, jobs } = loopStub();
		const pinned = readPlan(root).cli.path;
		fs.rmSync(pinned);
		for (const args of [runArgs(root), launchFirstArgs(root)]) {
			const r = run(args, env);
			expect(r.code).toBe(2);
			expect(r.err).toContain(`${STUB_VERSION}, ${pinned}, is gone`);
			expect(r.err).toContain(
				"restore that version, or plan again under a new --root",
			);
		}
		expect(fs.existsSync(jobs)).toBe(false);
	});

	it("refuses a plan that records no CLI, written before #2289", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { cli: _, ...older } = readPlan(root);
		fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(older));
		const { env, jobs } = loopStub();
		for (const args of [runArgs(root), launchFirstArgs(root)]) {
			const r = run(args, env);
			expect(r.code).toBe(2);
			expect(r.err).toContain("plan.json records no CLI");
		}
		expect(fs.existsSync(jobs)).toBe(false);
	});

	it("refuses a half-launched pair, naming how to clear it, and stops its running member at the ceiling before exiting (#3503)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, jobs, stops } = loopStub();
		const { runs, extra } = seedLaunched(root, 42, 1);
		const r = run(runArgs(root, "--ceiling-min", "40"), {
			...env,
			WFC_STUB_EXTRA: extra,
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain("pair 1 is half-launched");
		expect(r.out).toContain(
			`${runs[0].id}: still going past the ceiling, stopped as hung`,
		);
		expect(r.err).toContain("every run started has ended");
		expect(fs.readFileSync(stops, "utf8").trim()).toBe("j0");
		expect(fs.existsSync(jobs)).toBe(false);
	});

	it("starts no more pairs after a build failure, waits for the runs already going to end, then exits saying so (#3503)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, jobs, stops } = loopStub();
		fs.writeFileSync(
			env.WFC_ARM_TASKS_CLI as string,
			`console.error("stub build failure");process.exit(1);`,
		);
		const { extra } = seedLaunched(root, 0, 2);
		// Two arms' listings each to reap and to hold on the failing pass, then
		// two each to reap and to check on the drain's first, which sees both working.
		const workingListings = 8;
		const r = run(runArgs(root), {
			...env,
			WFC_STUB_EXTRA: extra,
			WFC_STUB_EXTRA_LISTINGS: String(workingListings),
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("stub build failure");
		expect(r.err).toContain(
			"starts no more pairs; waits for every run started to end",
		);
		expect(r.err).toContain(
			"every run started has ended; clear the failure above and run again to start the pairs left",
		);
		expect(r.err.match(/starts no more pairs/g)).toHaveLength(1);
		// A drain pass after the working ones, so it waited for them to end.
		expect(
			fs.readFileSync(path.join(tmp, "listings.log"), "utf8").length,
		).toBeGreaterThan(workingListings);
		expect(fs.existsSync(stops)).toBe(false);
		expect(fs.existsSync(jobs)).toBe(false);
	});

	it("waits for the member a pair's failed second launch left going, then exits saying so (#3503)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const launches = path.join(tmp, "launches");
		const { env, jobs, stops } = loopStub({
			onLaunch: `fs.appendFileSync(${JSON.stringify(launches)},"x");if(fs.readFileSync(${JSON.stringify(launches)},"utf8").length===2){console.error("stub launch failure");process.exit(1)}`,
		});
		const r = run(runArgs(root), env);
		expect(r.code).toBe(1);
		expect(r.err).toContain("stub launch failure");
		expect(r.err).toContain(
			"every run started has ended; clear the failure above and run again to start the pairs left",
		);
		expect(fs.readFileSync(jobs, "utf8").trim().split("\n")).toHaveLength(1);
		expect(fs.existsSync(stops)).toBe(false);
	});

	it("stops a run it drains at the whole-run limit and keeps the failure's status and next step (#3503)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env, stops } = loopStub();
		// Unlisted, so neither the ceiling nor its end can stop the drain: only the limit.
		const { runs } = seedLaunched(root, 0, 1);
		// 60 ms: past by the second pass, since the first spawns the listings.
		const r = run(runArgs(root, "--limit-min", "0.001"), env);
		expect(r.code).toBe(2);
		expect(r.err).toContain("pair 1 is half-launched");
		expect(r.out).toContain(`${runs[0].id}: stopped at the run's limit`);
		expect(r.err).toContain(
			"stopped every run still going; clear the failure above and run again to start the pairs left",
		);
		expect(fs.readFileSync(stops, "utf8").trim()).toBe("j0");
	});

	it("names each run that may still be going and the stop that ends it once the plan's binary is gone (#3503)", () => {
		const root = path.join(tmp, "p");
		expect(run(planArgs(root, "3")).code).toBe(0);
		const { env } = loopStub();
		const { runs } = seedLaunched(root, 0, 2);
		const hung = path.join(root, "launched", `${runs[1].id}.json`);
		fs.writeFileSync(
			hung,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(hung, "utf8")),
				hung: "x",
			}),
		);
		fs.rmSync(readPlan(root).cli.path);
		const r = run(runArgs(root), env);
		expect(r.code).toBe(2);
		expect(r.err).toContain(
			`${runs[0].id} may still be going: CLAUDE_CONFIG_DIR=${runs[0].configDir} claude stop j0`,
		);
		expect(r.err).not.toContain(runs[1].id);
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
			WFC_ARM_CLAUDE_BIN: claudeStub(agents),
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

	it("counts every run whatever its CLI version under --every-version, the #2241 ruling, still listing the strays", () => {
		const root = path.join(tmp, "p");
		const agents = [
			launched(root, "r1", "2.1.302"),
			launched(root, "r2", "2.1.302"),
			launched(root, "r3", "2.1.303"),
		];
		const r = run(
			[
				"report",
				"--root",
				root,
				"--baseline",
				"A",
				"--json",
				"--every-version",
			],
			{ ...process.env, WFC_ARM_CLAUDE_BIN: claudeStub(agents) },
		);
		const { rows, summary } = JSON.parse(r.out);
		expect(summary.scored).toBe(3);
		expect(summary.offVersion).toEqual([{ id: "r3", versions: ["2.1.303"] }]);
		expect(summary.harness.oneVersion).toBe(false);
		expect(rows[0]).toMatchObject({ wallMs: 12 * 60_000, tokens: 1115 });
		expect(summary.speed.minutes.byArm.A).toBeCloseTo(12, 6);
	});

	it("splits runs by --periods' first pairs, each period's runs counted per arm", () => {
		const root = path.join(tmp, "p");
		const agents = [
			launched(root, "r1", "2.1.302", { pair: 1 }),
			launched(root, "r2", "2.1.302", { pair: 1, arm: "B" }),
			launched(root, "r3", "2.1.302", { pair: 2 }),
			launched(root, "r4", "2.1.302", { pair: 3, arm: "B" }),
		];
		const r = run(
			["report", "--root", root, "--baseline", "A", "--json", "--periods", "3"],
			{ ...process.env, WFC_ARM_CLAUDE_BIN: claudeStub(agents) },
		);
		const { periods, armByPeriod } = JSON.parse(r.out).summary.byPeriod;
		expect(periods.map((p: { fromPair: number }) => p.fromPair)).toEqual([
			1, 3,
		]);
		expect(periods[0].byArm.A.score.n).toBe(2);
		expect(periods[0].byArm.B.score.n).toBe(1);
		expect(periods[1].byArm.B.score.n).toBe(1);
		expect(periods[1].byArm.A.score.n).toBe(0);
		expect(armByPeriod).toMatchObject({ postHoc: true });
		expect(armByPeriod.error).toContain("every period");
	});

	it("counts each period's environment denies, blocked and hung runs per arm, and a hung run's time at the ceiling", () => {
		const root = path.join(tmp, "p");
		const suiteCapDeny = {
			type: "user",
			uuid: "d1",
			isSidechain: false,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						is_error: true,
						content:
							"PreToolUse:Bash hook error: This would be suite 4, which is past the last rung anything has ever been measured on. Wait for one to finish",
					},
				],
			},
		};
		const agents = [
			launched(root, "r1", "2.1.302", { pair: 1, extra: [suiteCapDeny] }),
			launched(root, "r2", "2.1.302", { pair: 1, arm: "B", state: "blocked" }),
			launched(root, "r3", "2.1.302", { pair: 2, arm: "B", hung: true }),
		];
		const r = run(
			[
				"report",
				"--root",
				root,
				"--baseline",
				"A",
				"--json",
				"--periods",
				"2",
				"--ceiling-min",
				"60",
			],
			{ ...process.env, WFC_ARM_CLAUDE_BIN: claudeStub(agents) },
		);
		const { summary } = JSON.parse(r.out);
		const [first, second] = summary.byPeriod.periods;
		expect(first.byArm.A).toMatchObject({ environmentDenies: 1, hung: 0 });
		expect(first.byArm.B).toMatchObject({ blocked: 1, hung: 0 });
		expect(second.byArm.B).toMatchObject({ blocked: 0, hung: 1 });
		expect(summary.speed.hungAtCeiling).toEqual(["r3"]);
		expect(summary.speed.minutes.byArm.B).toBeCloseTo(Math.sqrt(12 * 60), 6);
	});

	it("names each run a comparison leaves out for want of a positive value", () => {
		const root = path.join(tmp, "p");
		const agents = [
			launched(root, "r1", "2.1.302"),
			launched(root, "r2", "2.1.302", { arm: "B" }),
		];
		const transcript = path.join(
			tmp,
			"cfg-a",
			"projects",
			projectSlug(path.join(tmp, "r2", "repo")),
			"r2-session.jsonl",
		);
		fs.writeFileSync(
			transcript,
			fs
				.readFileSync(transcript, "utf8")
				.replace(/"usage":\{[^}]*\}/, '"usage":{}'),
		);
		const r = run(["report", "--root", root, "--baseline", "A", "--json"], {
			...process.env,
			WFC_ARM_CLAUDE_BIN: claudeStub(agents),
		});
		const { spend } = JSON.parse(r.out).summary;
		expect(spend.tokens.leftOut).toEqual([{ id: "r2", value: 0 }]);
		expect(spend.tokens.byArm.A).toBeCloseTo(1115, 6);
	});

	it("prints D3's lexical measures per arm beside the others, read off each run's transcript (#2175)", () => {
		const root = path.join(tmp, "p");
		const recorded = fs
			.readFileSync(
				path.join(
					ROOT,
					"scripts",
					"fixtures",
					"arm-secondary",
					"recorded-69f9fc0f.jsonl",
				),
				"utf8",
			)
			.split("\n")
			.filter(Boolean)
			.map((l) => ({ ...JSON.parse(l), version: "2.1.302" }));
		const agents = [
			launched(root, "r1", "2.1.302", { extra: recorded }),
			launched(root, "r2", "2.1.302", { arm: "B" }),
		];
		// The warn measure reads this repo's own guard registry, named here.
		const r = run(["report", "--root", root, "--baseline", "A", "--json"], {
			...process.env,
			CLAUDE_PROJECT_DIR: ROOT,
			WFC_ARM_CLAUDE_BIN: claudeStub(agents),
		});
		const { secondary } = JSON.parse(r.out).summary;
		expect(secondary.A).toMatchObject({
			warnsActedAgainst: { actedAgainst: 0, rewarned: 0, warnedCalls: 2 },
			commitGateRefusals: { byGate: { "citation-tracker": 1 } },
			finalMessage: { read: 1, identifiers: 1, glossed: 1 },
		});
		expect(secondary.A.concision).toBeDefined();
		expect(secondary.B).toMatchObject({
			warnsActedAgainst: { warnedCalls: 0 },
			commitGateRefusals: { byGate: {} },
			finalMessage: { read: 1, identifiers: 0 },
		});
	});

	it("refuses a period starting at pair 1 or a fraction, naming the value", () => {
		for (const bad of ["1", "2.5", "x"]) {
			const r = run([
				"report",
				"--root",
				path.join(tmp, "p"),
				"--baseline",
				"A",
				"--periods",
				bad,
			]);
			expect(r.code).toBe(2);
			expect(r.err).toContain(
				`--periods takes whole pair numbers above 1, got ${bad}`,
			);
		}
	});

	it("refuses a report that names no baseline arm", () => {
		const r = run(["report", "--root", path.join(tmp, "p")]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("--baseline <arm>");
	});
});
