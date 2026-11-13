// @vitest-environment node
/*
 * The before/after test runner's core, lib/run-arm.js (#2045, #2046; core
 * and shell, #5149): its plan, its launch into an arm's config dir, its
 * self-looping `run` with the hang ceiling, the whole-run limit and the CLI
 * pinned at plan time (#2289), and its report. A break here mislabels which
 * arm a session ran in, starts more sessions than the machine holds, leaves
 * a hung run holding its slots all night, or reads the main run wrongly,
 * each of which costs a night's runs.
 *
 * Module cases: `claude` is lib/arm-claude-fake.ts, held by
 * lib/arm-claude.contract.test.ts; the builder is lib/fixtures/arm-build.js,
 * held by scripts/arm-tasks.test.ts, and admission's answer
 * lib/admission-verdict-fake.ts, held by its contract, each run in-process;
 * the scorer and the acceptance check are the real programs, in-process.
 * `run`'s clocks and sleep are injected. scripts/run-arm-test.test.ts keeps
 * the program's boundary set.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./admission-verdict-fake";
import { buildJobRow, type Row } from "./agents-stop-fake";
import {
	type ArmClaudeOptions,
	createArmClaudeFake,
	FAKE_VERSION,
} from "./arm-claude-fake";
import { runInProcess } from "./run-in-process";

const arm = require("./run-arm.js");
const { parse } = require("./cli-args");
const { projectSlug } = require("./project-slug.js");

const ROOT = path.resolve(__dirname, "..", "..");
const BUILDER = path.join(ROOT, "scripts", "lib", "fixtures", "arm-build.js");
/** `run` reads its clock once a pass; a case past this many reads is a loop
 * that never ends, failed rather than left spinning, since a synchronous
 * loop outlasts vitest's timeout. */
const MAX_CLOCK_READS = 10_000;
/** The wall clock every module case reads. */
const NOW = Date.parse("2026-11-13T00:00:00.000Z");

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arm-core-"));
	executable(path.join(tmp, "claude"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A file the plan can resolve and pin as a binary; nothing runs it, so its
 * exit 99 would show a call that strayed past the fake. */
function executable(file: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	return file;
}

/** Admission's `n`th answer, 1-based, to a check under `env`. */
type Admission = (env: NodeJS.ProcessEnv, n: number) => object;
const slots =
	(n: number): Admission =>
	() => ({ ...ADMISSION_VERDICT, slots: n });
const refusal = (error: string) => ({
	...ADMISSION_VERDICT,
	ok: false,
	slots: 0,
	error,
});

interface KitOpts extends Omit<ArmClaudeOptions, "listing"> {
	/** The `n`th listing's rows, given the jobs launched so far; none lists
	 * no job. */
	listing?: (n: number, jobs: string[]) => Row[] | null;
	/** None answers 8 slots. */
	admission?: Admission;
	/** Laid over the environment; an `undefined` value unsets the variable. */
	env?: Record<string, string | undefined>;
	/** How far `run`'s clock moves on each read; none holds it still. */
	clockStepMs?: number;
	/** The wall clock; none reads NOW throughout. */
	now?: () => number;
	/** `run`'s wait between passes; none returns at once. */
	sleep?: (ms: number) => void;
}

/**
 * The core on its fakes, and what they saw. `run` parses argv as the shell
 * does and calls the subcommand's entry.
 */
function kit(o: KitOpts = {}) {
	const admissionCli = path.join(tmp, "admission.js");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_CLAUDE_BIN: path.join(tmp, "claude"),
		WFC_ARM_TASKS_CLI: BUILDER,
		WFC_ADMISSION_CLI: admissionCli,
	};
	for (const [k, v] of Object.entries(o.env ?? {}))
		if (v === undefined) delete env[k];
		else env[k] = v;
	const fake = createArmClaudeFake({
		silent: o.silent,
		launch: o.launch,
		stop: o.stop,
		listing: (_seat, n) => (o.listing ? o.listing(n, fake.jobs) : []),
	});
	let admissions = 0;
	let reads = 0;
	let out = "";
	let err = "";
	const ports = {
		env,
		claude: fake.spawn,
		node: (cli: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
			if (cli === admissionCli)
				return {
					status: 0,
					stdout: JSON.stringify(
						(o.admission ?? slots(8))(opts.env, ++admissions),
					),
					stderr: "",
				};
			const r = runInProcess(cli, args, { cwd: ROOT, env: opts.env });
			return { status: r.status, stdout: r.stdout, stderr: r.stderr };
		},
		clock: () => {
			if (reads > MAX_CLOCK_READS)
				throw new Error(`run read its clock ${MAX_CLOCK_READS} times`);
			return (o.clockStepMs ?? 0) * reads++;
		},
		now: o.now ?? (() => NOW),
		sleep: o.sleep ?? (() => undefined),
		out: (text: string) => {
			out += text;
		},
		err: (text: string) => {
			err += text;
		},
		hostRoot: () => ROOT,
	};
	const run = (args: string[]) => {
		out = "";
		err = "";
		const parsed = parse(args, arm.CLI);
		const code: number = arm[parsed.command](ports, parsed);
		return { out, err, code };
	};
	return { fake, run, env };
}

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

/** A plan of 6 pairs at `root`, the arms' config dirs logged in. */
function planned(root: string, k = kit()) {
	expect(k.run(planArgs(root, "3")).code).toBe(0);
	for (const cfg of ["cfg-a", "cfg-b"]) {
		fs.mkdirSync(path.join(tmp, cfg), { recursive: true });
		fs.writeFileSync(path.join(tmp, cfg, ".claude.json"), "{}");
	}
	return root;
}

const rowsOf = (ids: string[], state: string) =>
	ids.map((id) => buildJobRow(id, state));

describe("plan", () => {
	it("pairs every task × run with one run per arm, the same for the same seed", () => {
		const one = path.join(tmp, "one");
		const two = path.join(tmp, "two");
		const k = kit();
		expect(k.run(planArgs(one, "7")).code).toBe(0);
		expect(k.run(planArgs(two, "7")).code).toBe(0);
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
		// The seed orders each pair's arms, so neither arm always starts first.
		const firsts = new Set(
			[1, 2, 3, 4, 5, 6].map(
				(pair) => runs.find((r: { pair: number }) => r.pair === pair).arm,
			),
		);
		expect(firsts).toEqual(new Set(["A", "B"]));
	});

	it("refuses a plan where no claude answers, naming why", () => {
		const silent = executable(path.join(tmp, "silent"));
		for (const [bin, why] of [
			["claude-absent", "no executable `claude-absent` on PATH"],
			[
				silent,
				`${fs.realpathSync(silent)} --version printed no version (exit 1)`,
			],
		]) {
			const root = path.join(tmp, path.basename(bin));
			const r = kit({
				silent: [fs.realpathSync(silent)],
				env: { WFC_CLAUDE_BIN: bin },
			}).run(planArgs(root, "1"));
			expect(r.code).toBe(2);
			expect(r.err).toContain(why);
			expect(fs.existsSync(path.join(root, "plan.json"))).toBe(false);
		}
	});

	it("refuses to overwrite a plan", () => {
		const root = path.join(tmp, "p");
		const k = kit();
		expect(k.run(planArgs(root, "1")).code).toBe(0);
		const again = k.run(planArgs(root, "2"));
		expect(again.code).toBe(2);
		expect(again.err).toContain("a plan is written once");
	});
});

describe("launch", () => {
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

	/** Four runs of earlier pairs recorded launched, as jobs j1 to j4. */
	const seedRunning = (root: string) => {
		fs.mkdirSync(path.join(root, "launched"));
		for (const [i, job] of ["j1", "j2", "j3", "j4"].entries())
			fs.writeFileSync(
				path.join(root, "launched", `running-${i}.json`),
				JSON.stringify({ id: `running-${i}`, configDir: tmp, job }),
			);
	};

	it("starts no pair where admission has fewer than two slots", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit({ admission: slots(1) });
		const r = k.run(launchArgs(root, "1"));
		expect(r.code).toBe(1);
		expect(r.err).toContain("a pair needs 2");
		expect(k.fake.launches).toHaveLength(0);
	});

	it("starts a pair where admission has exactly two slots", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit({ admission: slots(2) });
		expect(k.run(launchArgs(root, "1")).code).toBe(0);
		expect(k.fake.launches).toHaveLength(2);
	});

	it("refuses a pair already launched, naming its runs, and starts nothing", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit();
		expect(k.run(launchArgs(root, "1")).code).toBe(0);
		const again = k.run(launchArgs(root, "1"));
		expect(again.code).toBe(1);
		expect(again.err).toMatch(
			/✗ pair 1: \S+, \S+ already launched; drop the pair from the list/,
		);
		expect(k.fake.launches).toHaveLength(2);
	});

	it("starts no pair while two pairs are still running", () => {
		const root = planned(path.join(tmp, "p"));
		seedRunning(root);
		const k = kit({
			listing: () => rowsOf(["j1", "j2", "j3", "j4"], "working"),
		});
		const r = k.run(launchArgs(root, "3"));
		expect(r.code).toBe(1);
		expect(r.err).toContain("4 session(s) still running");
		expect(k.fake.launches).toHaveLength(0);
	});

	it("counts a run blocked on an unanswered question as ended, freeing its pair's place", () => {
		const root = planned(path.join(tmp, "p"));
		seedRunning(root);
		const k = kit({
			listing: () => [
				...rowsOf(["j1", "j2"], "blocked"),
				...rowsOf(["j3", "j4"], "working"),
			],
		});
		expect(k.run(launchArgs(root, "3")).code).toBe(0);
		expect(k.fake.launches).toHaveLength(2);
	});

	it("lists the running pairs through the plan's binary on a launch, not PATH's claude (#2289)", () => {
		const versions = path.join(tmp, "versions");
		const bin = path.join(tmp, "bin");
		const pinned = executable(path.join(versions, FAKE_VERSION));
		fs.mkdirSync(bin);
		fs.symlinkSync(pinned, path.join(bin, "claude"));
		const onPath = {
			WFC_CLAUDE_BIN: undefined,
			// claude-route-exempt: asserts the launch keeps the plan's pinned `claude`
			PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		};
		const root = planned(path.join(tmp, "p"), kit({ env: onPath }));
		fs.rmSync(path.join(bin, "claude"));
		fs.symlinkSync(
			executable(path.join(versions, "2.1.305")),
			path.join(bin, "claude"),
		);
		const k = kit({ env: onPath });
		expect(k.run(launchArgs(root, "1")).code).toBe(0);
		expect(k.run(launchArgs(root, "2")).code).toBe(0);
		expect(k.fake.calls.some((c) => c.args[0] === "agents")).toBe(true);
		expect(
			k.fake.calls.filter((c) => c.bin !== fs.realpathSync(pinned)),
		).toEqual([]);
	});

	it("starts neither member of a pair when one sandbox fails to build", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit({ env: { WFC_STUB_FAIL_ARM: "B" } });
		const r = k.run(launchArgs(root, "1"));
		expect(r.code).toBe(1);
		expect(r.err).toContain("stub build failure");
		expect(k.fake.launches).toHaveLength(0);
	});
});

describe("run", () => {
	/**
	 * The loop's listing: every job it launched, done, and each of `extra`
	 * working for the first `workingListings` listings, then done; no
	 * `workingListings` keeps them working.
	 */
	const loop = (
		extra: string[] = [],
		workingListings = Number.POSITIVE_INFINITY,
	) => ({
		listing: (n: number, jobs: string[]) => [
			...rowsOf(jobs, "done"),
			...rowsOf(extra, n <= workingListings ? "working" : "done"),
		],
	});

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

	/**
	 * The first `only` planned runs, every one where absent, recorded as
	 * launched `agoMin` minutes before NOW as job `j<i>`.
	 */
	const seedLaunched = (root: string, agoMin: number, only?: number) => {
		const dir = path.join(root, "launched");
		fs.mkdirSync(dir, { recursive: true });
		const runs = readPlan(root).runs.slice(0, only);
		const at = new Date(NOW - agoMin * 60_000).toISOString();
		for (const [i, x] of runs.entries())
			fs.writeFileSync(
				path.join(dir, `${x.id}.json`),
				JSON.stringify({ ...x, repo: tmp, job: `j${i}`, launchedAt: at }),
			);
		return {
			dir,
			runs,
			extra: runs.map((_: unknown, i: number) => `j${i}`),
		};
	};

	it("starts every pair by itself and exits once every run has ended", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit(loop());
		const r = k.run(runArgs(root));
		expect(r.code).toBe(0);
		expect(r.out).toContain("every pair started and every run ended");
		expect(k.fake.jobs).toHaveLength(12);
		expect(fs.readdirSync(path.join(root, "launched"))).toHaveLength(12);
	});

	it("is held by no session that started it and has since ended (#2046, the main run held after its first pair)", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit({
			...loop(),
			env: { CLAUDE_CODE_SESSION_ID: "ended-session" },
			admission: (env) =>
				env.CLAUDE_CODE_SESSION_ID
					? refusal("does not list this very session")
					: slots(8)(env, 0),
		});
		const r = k.run(runArgs(root));
		expect(r.code).toBe(0);
		expect(k.fake.jobs).toHaveLength(12);
	});

	it("logs why it holds a pair, once until the reason changes", () => {
		const root = planned(path.join(tmp, "p"));
		// Above one, so a reason logged on every held pass would print it twice.
		const refusedPasses = 3;
		const r = kit({
			...loop(),
			admission: (env, n) =>
				n <= refusedPasses ? refusal("listing unreadable") : slots(8)(env, n),
		}).run(runArgs(root));
		expect(r.code).toBe(0);
		const held =
			"pair 1 held: admission has 0 slot(s), a pair needs 2; launch again when admission frees (listing unreadable)";
		expect(r.out.split("\n").filter((l) => l === held)).toHaveLength(1);
	});

	it("waits a poll between passes on its injected sleep, and a pair's pace on its wall clock", () => {
		const root = planned(path.join(tmp, "p"));
		const slept: number[] = [];
		let wall = NOW;
		const k = kit({
			...loop(),
			now: () => wall,
			sleep: (ms) => {
				slept.push(ms);
				wall += ms;
			},
		});
		const r = k.run([
			"run",
			"--root",
			root,
			"--issues",
			tmp,
			"--node-modules",
			tmp,
			"--pace-min",
			"20",
			"--poll-sec",
			"60",
		]);
		expect(r.code).toBe(0);
		expect(k.fake.jobs).toHaveLength(12);
		// Pairs 2 to 6 each wait out the 20-minute pace in 60 s polls.
		expect(slept).toEqual(new Array(5 * 20).fill(60_000));
	});

	it("stops every run still going once its whole-run limit passes, says so, and marks each record so a later run reads it ended (#3495)", () => {
		const root = planned(path.join(tmp, "p"));
		const { dir, runs, extra } = seedLaunched(root, 0, 4);
		const k = kit(loop(extra));
		const r = k.run(runArgs(root, "--limit-min", "0"));
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			"the run's limit of 0 minutes passed; stopped every run still going",
		);
		expect(r.out).toContain(`${runs[0].id}: stopped at the run's limit`);
		expect([...k.fake.stopped].sort()).toEqual(["j0", "j1", "j2", "j3"]);
		for (const x of runs)
			expect(
				typeof JSON.parse(
					fs.readFileSync(path.join(dir, `${x.id}.json`), "utf8"),
				).limited,
			).toBe("string");
		// Still listed as working, yet none of them holds a pair under the default cap.
		const again = kit(loop(extra)).run(runArgs(root));
		expect(again.code).toBe(0);
		expect(again.out).not.toContain("still running");
	});

	it("stops a run its listing cannot read at the limit, so an unreadable listing leaves none going", () => {
		const root = planned(path.join(tmp, "p"));
		seedLaunched(root, 0, 2);
		const k = kit({ listing: () => null });
		const r = k.run(runArgs(root, "--limit-min", "0"));
		expect(r.code).toBe(1);
		expect([...k.fake.stopped].sort()).toEqual(["j0", "j1"]);
	});

	it("tries a failed stop again at the limit, then names each run left and its job", () => {
		const root = planned(path.join(tmp, "p"));
		const { runs, extra } = seedLaunched(root, 0, 2);
		const k = kit({
			...loop(extra),
			stop: () => ({ fail: "daemon unreachable" }),
		});
		const r = k.run(runArgs(root, "--limit-min", "0"));
		expect(r.code).toBe(1);
		expect(k.fake.stopped).toHaveLength(6);
		expect(r.err).toContain(
			`stopped all but ${runs[0].id} (job j0 in ${runs[0].configDir}), ${runs[1].id} (job j1 in ${runs[1].configDir}), still running after 3 tries`,
		);
	});

	it("derives its whole-run limit from the plan where --limit-min is absent: 6 pairs at a 40-minute ceiling, 10 minutes each besides", () => {
		const root = planned(path.join(tmp, "p"));
		const r = kit(loop()).run(runArgs(root, "--ceiling-min", "40"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("stops every run still going after 300 minutes");
	});

	it("refuses a negative whole-run limit, naming the flag, its floor and the value given", () => {
		const root = planned(path.join(tmp, "p"));
		const r = kit(loop()).run(runArgs(root, "--limit-min", "-1"));
		expect(r.code).toBe(2);
		expect(r.err).toContain("--limit-min takes minutes, at least 0, got -1");
	});

	it("leaves a run under the ceiling going until it ends", () => {
		const root = planned(path.join(tmp, "p"));
		const { extra } = seedLaunched(root, 0);
		const k = kit(loop(extra, 3));
		const r = k.run(runArgs(root, "--ceiling-min", "90"));
		expect(r.code).toBe(0);
		expect(k.fake.stopped).toHaveLength(0);
	});

	it("stops a run still going past the ceiling and records it hung, which ends it", () => {
		const root = planned(path.join(tmp, "p"));
		const { dir, runs, extra } = seedLaunched(root, 41);
		const k = kit(loop(extra));
		const r = k.run(runArgs(root, "--ceiling-min", "40"));
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			`${runs[0].id}: still going past the ceiling, stopped as hung`,
		);
		expect(k.fake.stopped).toHaveLength(12);
		const rec = JSON.parse(
			fs.readFileSync(path.join(dir, `${runs[0].id}.json`), "utf8"),
		);
		expect(rec.hung).toBe(new Date(NOW).toISOString());
	});

	it("leaves a run at the ceiling to the minute going, stopping it only past it", () => {
		const root = planned(path.join(tmp, "p"));
		const { extra } = seedLaunched(root, 40);
		const k = kit(loop(extra, 3));
		const r = k.run(runArgs(root, "--ceiling-min", "40"));
		expect(r.code).toBe(0);
		expect(k.fake.stopped).toHaveLength(0);
	});

	it("holds the third pair behind two running ones by default, and starts it under --max-running 6", () => {
		for (const [extra, held] of [
			[[], true],
			[["--max-running", "6"], false],
		] as const) {
			const root = planned(path.join(tmp, `cap-${held}`));
			const seeded = seedLaunched(root, 0, 4);
			// The first pass's four listings: two arms, read to reap and to hold.
			const r = kit(loop(seeded.extra, 4)).run(runArgs(root, ...extra));
			expect(r.code).toBe(0);
			expect(r.out.includes("4 session(s) still running")).toBe(held);
		}
	});

	it("refuses a running cap under one pair or between pairs, naming the floor", () => {
		const root = planned(path.join(tmp, "p"));
		for (const cap of ["1", "5"]) {
			const r = kit(loop()).run(runArgs(root, "--max-running", cap));
			expect(r.code).toBe(2);
			expect(r.err).toContain("at least one pair's 2");
		}
	});

	it("refuses a ceiling under F11's p75 of 40 minutes", () => {
		const root = planned(path.join(tmp, "p"));
		const r = kit(loop()).run(runArgs(root, "--ceiling-min", "39"));
		expect(r.code).toBe(2);
		expect(r.err).toContain("--ceiling-min");
	});

	it("starts and lists every pair through the plan's binary after PATH's claude moves to another version (#2289)", () => {
		const versions = path.join(tmp, "versions");
		const bin = path.join(tmp, "bin");
		const link = path.join(bin, "claude");
		const pinned = executable(path.join(versions, FAKE_VERSION));
		const newer = executable(path.join(versions, "2.1.305"));
		fs.mkdirSync(bin);
		fs.symlinkSync(pinned, link);
		const onPath = {
			WFC_CLAUDE_BIN: undefined,
			// claude-route-exempt: asserts the plan pins PATH's versioned `claude`
			PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		};
		const root = planned(path.join(tmp, "p"), kit({ env: onPath }));
		const k = kit({
			...loop(),
			env: onPath,
			// The update another session runs, landing after the first launch.
			launch: (n) => {
				if (n === 1) {
					fs.rmSync(link);
					fs.symlinkSync(newer, link);
				}
				return "ok";
			},
		});
		const r = k.run(runArgs(root));
		expect(r.code).toBe(0);
		expect(fs.readlinkSync(link)).toBe(newer);
		expect(k.fake.jobs).toHaveLength(12);
		expect(
			k.fake.calls.filter((c) => c.bin !== fs.realpathSync(pinned)),
		).toEqual([]);
	});

	it("refuses to start a pair once the plan's binary is gone, naming it (#2289)", () => {
		const root = planned(path.join(tmp, "p"));
		const pinned = readPlan(root).cli.path;
		fs.rmSync(pinned);
		for (const args of [runArgs(root), launchFirstArgs(root)]) {
			const k = kit(loop());
			const r = k.run(args);
			expect(r.code).toBe(2);
			expect(r.err).toContain(`${FAKE_VERSION}, ${pinned}, is gone`);
			expect(r.err).toContain(
				"restore that version, or plan again under a new --root",
			);
			expect(k.fake.launches).toHaveLength(0);
		}
	});

	it("refuses a plan that records no CLI, written before #2289", () => {
		const root = planned(path.join(tmp, "p"));
		const { cli: _, ...older } = readPlan(root);
		fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(older));
		for (const args of [runArgs(root), launchFirstArgs(root)]) {
			const k = kit(loop());
			const r = k.run(args);
			expect(r.code).toBe(2);
			expect(r.err).toContain("plan.json records no CLI");
			expect(k.fake.launches).toHaveLength(0);
		}
	});

	it("refuses a half-launched pair, naming how to clear it, and stops its running member at the ceiling before exiting (#3503)", () => {
		const root = planned(path.join(tmp, "p"));
		const { runs, extra } = seedLaunched(root, 42, 1);
		const k = kit(loop(extra));
		const r = k.run(runArgs(root, "--ceiling-min", "40"));
		expect(r.code).toBe(2);
		expect(r.err).toContain("pair 1 is half-launched");
		expect(r.out).toContain(
			`${runs[0].id}: still going past the ceiling, stopped as hung`,
		);
		expect(r.err).toContain("every run started has ended");
		expect(k.fake.stopped).toEqual(["j0"]);
		expect(k.fake.launches).toHaveLength(0);
	});

	it("starts no more pairs after a build failure, waits for the runs already going to end, then exits saying so (#3503)", () => {
		const root = planned(path.join(tmp, "p"));
		const { extra } = seedLaunched(root, 0, 2);
		// Two arms' listings each to reap and to hold on the failing pass, then
		// two each to reap and to check on the drain's first, which sees both working.
		const workingListings = 8;
		const k = kit({
			...loop(extra, workingListings),
			env: { WFC_STUB_FAIL_ARM: "*" },
		});
		const r = k.run(runArgs(root));
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
		expect(k.fake.listings).toBeGreaterThan(workingListings);
		expect(k.fake.stopped).toHaveLength(0);
		expect(k.fake.launches).toHaveLength(0);
	});

	it("waits for the member a pair's failed second launch left going, then exits saying so (#3503)", () => {
		const root = planned(path.join(tmp, "p"));
		const k = kit({
			...loop(),
			launch: (n) => (n === 2 ? { fail: "stub launch failure" } : "ok"),
		});
		const r = k.run(runArgs(root));
		expect(r.code).toBe(1);
		expect(r.err).toContain("stub launch failure");
		expect(r.err).toContain(
			"every run started has ended; clear the failure above and run again to start the pairs left",
		);
		expect(k.fake.jobs).toHaveLength(1);
		expect(k.fake.stopped).toHaveLength(0);
	});

	it("stops a run it drains at the whole-run limit and keeps the failure's status and next step (#3503)", () => {
		const root = planned(path.join(tmp, "p"));
		// Unlisted, so neither the ceiling nor its end can stop the drain: only the limit.
		const { runs } = seedLaunched(root, 0, 1);
		// Half the limit a read, so it passes at the second pass's check.
		const k = kit({ ...loop(), clockStepMs: 30_000 });
		const r = k.run(runArgs(root, "--limit-min", "1"));
		expect(r.code).toBe(2);
		expect(r.err).toContain("pair 1 is half-launched");
		expect(r.out).toContain(`${runs[0].id}: stopped at the run's limit`);
		expect(r.err).toContain(
			"stopped every run still going; clear the failure above and run again to start the pairs left",
		);
		expect(k.fake.stopped).toEqual(["j0"]);
	});

	it("names each run that may still be going and the stop that ends it once the plan's binary is gone (#3503)", () => {
		const root = planned(path.join(tmp, "p"));
		const { runs } = seedLaunched(root, 0, 2);
		const hung = path.join(root, "launched", `${runs[1].id}.json`);
		fs.writeFileSync(
			hung,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(hung, "utf8")),
				hung: "x",
			}),
		);
		const bad = path.join(root, "launched", "broken.json");
		fs.writeFileSync(bad, "{}");
		fs.rmSync(readPlan(root).cli.path);
		const r = kit(loop()).run(runArgs(root));
		expect(r.code).toBe(2);
		expect(r.err).toContain(`${bad} does not name its run`);
		expect(r.err).toContain(
			`${runs[0].id} may still be going: CLAUDE_CONFIG_DIR=${runs[0].configDir} claude stop j0`,
		);
		expect(r.err).not.toContain(runs[1].id);
	});

	it("names each run still going, and a record that will not parse by its file, once its loop throws (#3506)", () => {
		const root = planned(path.join(tmp, "p"));
		const { dir, runs } = seedLaunched(root, 0, 1);
		const bad = path.join(dir, "broken.json");
		fs.writeFileSync(bad, "{");
		const k = kit(loop());
		const r = k.run(runArgs(root));
		expect(r.code).toBe(1);
		expect(r.err).toContain("run threw:");
		expect(r.err).toContain(
			`${runs[0].id} may still be going: CLAUDE_CONFIG_DIR=${runs[0].configDir} claude stop j0`,
		);
		expect(r.err).toContain(
			`${bad} does not name its run, which may still be going: find its job in its arm's \`claude agents\` and \`claude stop\` it`,
		);
		expect(k.fake.stopped).toHaveLength(0);
	});
});

describe("report", () => {
	/**
	 * Run `id` recorded launched and ended in arm A's config dir, its
	 * transcript two messages twelve minutes apart on CLI `version`, then
	 * `extra`'s rows; its listing row, in `state`.
	 */
	const launched = (
		root: string,
		id: string,
		version: string,
		{
			pair = 1,
			arm: armName = "A",
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
				arm: armName,
				configDir: cfg,
				repo,
				sandbox: path.join(tmp, id),
				job: id,
				...(hung ? { hung: "2026-10-20T11:30:00.000Z" } : {}),
			}),
		);
		return buildJobRow(id, state, { sessionId });
	};

	/** The report of `rows`' runs, the acceptance check the real one. */
	const report = (rows: Row[], args: string[]) =>
		kit({ listing: () => rows, env: { WFC_ARM_TASKS_CLI: undefined } }).run([
			"report",
			"--root",
			path.join(tmp, "p"),
			"--baseline",
			"A",
			"--json",
			...args,
		]);

	it("counts every run whatever its CLI version under --every-version, the #2241 ruling, still listing the strays", () => {
		const root = path.join(tmp, "p");
		const r = report(
			[
				launched(root, "r1", "2.1.302"),
				launched(root, "r2", "2.1.302"),
				launched(root, "r3", "2.1.303"),
			],
			["--every-version"],
		);
		expect(r.code).toBe(0);
		const { rows, summary } = JSON.parse(r.out);
		expect(summary.scored).toBe(3);
		expect(summary.offVersion).toEqual([{ id: "r3", versions: ["2.1.303"] }]);
		expect(summary.harness.oneVersion).toBe(false);
		expect(rows[0]).toMatchObject({ wallMs: 12 * 60_000, tokens: 1115 });
		expect(summary.speed.minutes.byArm.A).toBeCloseTo(12, 6);
	});

	it("splits runs by --periods' first pairs, each period's runs counted per arm", () => {
		const root = path.join(tmp, "p");
		const r = report(
			[
				launched(root, "r1", "2.1.302", { pair: 1 }),
				launched(root, "r2", "2.1.302", { pair: 1, arm: "B" }),
				launched(root, "r3", "2.1.302", { pair: 2 }),
				launched(root, "r4", "2.1.302", { pair: 3, arm: "B" }),
			],
			["--periods", "3"],
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
		const r = report(
			[
				launched(root, "r1", "2.1.302", { pair: 1, extra: [suiteCapDeny] }),
				launched(root, "r2", "2.1.302", {
					pair: 1,
					arm: "B",
					state: "blocked",
				}),
				launched(root, "r3", "2.1.302", { pair: 2, arm: "B", hung: true }),
			],
			["--periods", "2", "--ceiling-min", "60"],
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
		const rows = [
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
		const { spend } = JSON.parse(report(rows, []).out).summary;
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
		// The warn measure reads this repo's own guard registry, the host root.
		const r = report(
			[
				launched(root, "r1", "2.1.302", { extra: recorded }),
				launched(root, "r2", "2.1.302", { arm: "B" }),
			],
			[],
		);
		const { secondary } = JSON.parse(r.out).summary;
		expect(secondary.A).toMatchObject({
			warnsActedAgainst: { actedAgainst: 0, rewarned: 0, warnedCalls: 1 },
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

	it("reports, not scores, a run the scorer refuses for an unclassed Stop guard, naming the guard (#3761)", () => {
		const root = path.join(tmp, "p");
		const unclassed = [
			{
				type: "attachment",
				uuid: "a-unclassed",
				isSidechain: false,
				timestamp: "2026-10-20T10:13:00.000Z",
				attachment: {
					type: "hook_blocking_error",
					hookName: "Stop",
					hookEvent: "Stop",
					toolUseID: "t1",
					blockingError: {
						blockingError: "New.",
						command:
							'command -v node >/dev/null && node "$CLAUDE_PROJECT_DIR"/scripts/guard-renamed-thing.js',
					},
				},
			},
		];
		const { rows, summary } = JSON.parse(
			report(
				[
					launched(root, "r1", "2.1.302", { extra: unclassed }),
					launched(root, "r2", "2.1.302"),
				],
				[],
			).out,
		);
		expect(rows[0].ended).toBe(true);
		expect(rows[0].score.error).toContain("guard-renamed-thing");
		expect(rows[1].score.score).toBe(0);
		expect(summary.scored).toBe(1);
	});

	it("refuses a --drop outside (0, 1) with the usage, and reads one inside it", () => {
		for (const bad of ["0", "1", "x"]) {
			const r = report([], ["--drop", bad]);
			expect(r.code).toBe(2);
			expect(r.err).toContain("report --root <dir> --baseline <arm>");
		}
		expect(report([], ["--drop", "0.5"]).code).toBe(0);
	});

	it("refuses a period starting at pair 1 or a fraction, naming the value", () => {
		for (const bad of ["1", "2.5", "x"]) {
			const r = report([], ["--periods", bad]);
			expect(r.code).toBe(2);
			expect(r.err).toContain(
				`--periods takes whole pair numbers above 1, got ${bad}`,
			);
		}
	});
});
