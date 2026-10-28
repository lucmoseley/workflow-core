// @vitest-environment node
/*
 * The refill loop's commands (#2012) against a sandboxed WFC_REFILL_DIR:
 * `start` renewing a running loop rather than starting a second, `stop`
 * asking the loop to end, and the command line. Driven in process; `start`
 * with no loop running spawns the real detached loop, so it is left to the
 * manual dry run.
 *
 * The running loop is a second process whose command line names the script,
 * holding the pidfile: liveness is read off /proc, which only another process
 * can stand in for.
 *
 * Loosen one and `start` can spawn a second loop beside a running one, or
 * `stop` fail to reach it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "refill-loop.js");

let dir: string;
let fakeLoop: ChildProcess | null = null;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-"));
});

afterEach(() => {
	fakeLoop?.kill();
	fakeLoop = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

const runEnv = (extra: Record<string, string>, ...argv: string[]) =>
	runInProcessAsync(SCRIPT, argv, {
		cwd: dir,
		env: {
			...process.env,
			WFC_REFILL_DIR: dir,
			CLAUDE_PROJECT_DIR: dir,
			HOME: dir,
			CLAUDE_CONFIG_DIR: path.join(dir, ".claude3"),
			WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
			...extra,
		},
	});
const run = (...argv: string[]) => runEnv({}, ...argv);

const readControl = () =>
	JSON.parse(
		fs.readFileSync(path.join(dir, ".refill-loop-control.json"), "utf8"),
	);

function holdPidfile(name = "refill-loop.js") {
	fakeLoop = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", name],
		{
			stdio: "ignore",
		},
	);
	fs.writeFileSync(path.join(dir, ".refill-loop.pid"), String(fakeLoop.pid));
	return fakeLoop.pid;
}

describe("start", () => {
	it("renews a running loop's 24 hours rather than starting a second", async () => {
		const pid = holdPidfile();
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ startedAt: 1, stopRequested: true, seats: [] }),
		);
		const before = Date.now();
		const r = await run("start");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`refill loop renewed: pid ${pid}`);
		expect(readControl().startedAt).toBeGreaterThanOrEqual(before);
		expect(readControl().stopRequested).toBe(false);
		expect(fs.existsSync(path.join(dir, ".refill-loop.log"))).toBe(false);
	});

	it("takes its seats from ~/.claude/refill-seats, in order", async () => {
		holdPidfile();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"# failover order\n/s/.claude3\n\n/s/.claude2\n",
		);
		await run("start");
		expect(readControl().seats).toEqual(["/s/.claude3", "/s/.claude2"]);
	});

	it("lists only the plan seats, overflow seats being read each tick", async () => {
		holdPidfile();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n",
		);
		await run("start");
		expect(readControl().seats).toEqual([path.join(dir, ".claude2")]);
	});

	it("refuses a malformed overflow line, naming it, and writes no control", async () => {
		holdPidfile();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude2\n~/.claude2-api api key=K grant=200\n",
		);
		const r = await run("start");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`${path.join(dir, ".claude", "refill-seats")}:2: missing cycle-day=`,
		);
		expect(fs.existsSync(path.join(dir, ".refill-loop-control.json"))).toBe(
			false,
		);
	});

	it("falls back to the seat it ran on alone", async () => {
		holdPidfile();
		const r = await run("start");
		expect(r.status).toBe(0);
		expect(readControl().seats).toEqual([path.join(dir, ".claude3")]);
	});

	it("falls back to ~/.claude where CLAUDE_CONFIG_DIR is unset", async () => {
		holdPidfile();
		const r = await runInProcessAsync(SCRIPT, ["start"], {
			cwd: dir,
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(
						([k]) => k !== "CLAUDE_CONFIG_DIR",
					),
				),
				WFC_REFILL_DIR: dir,
				CLAUDE_PROJECT_DIR: dir,
				HOME: dir,
				WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
			},
		});
		expect(r.status).toBe(0);
		expect(readControl().seats).toEqual([path.join(dir, ".claude")]);
	});

	it("takes an empty CLAUDE_CONFIG_DIR as set, as Claude Code reads it (#2095)", async () => {
		holdPidfile();
		const r = await runEnv({ CLAUDE_CONFIG_DIR: "" }, "start");
		expect(r.status).toBe(0);
		expect(readControl().seats).toEqual([""]);
	});
});

function checkout(name: string) {
	fs.mkdirSync(path.join(dir, name, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, name, ".claude", "workflow-core.json"),
		"{}\n",
	);
	return path.join(dir, name);
}

describe("the scope start writes (#2123)", () => {
	it("serves this checkout plus each named one, its goal ranked first", async () => {
		holdPidfile();
		const mh = checkout("mantahostels");
		const r = await run(
			"start",
			"--repo",
			"mantahostels",
			"--goal",
			"116,#117",
		);
		expect(r.status).toBe(0);
		expect(readControl().scope).toEqual({
			mode: "normal",
			repos: [dir, mh],
			exclude: [],
			goals: { [dir]: [116, 117] },
		});
		expect(r.stdout).toContain("mode:      normal");
		expect(r.stdout).toContain("stops by:");
	});

	it("serves every included checkout but those named in away mode", async () => {
		holdPidfile();
		const dv = checkout("design-vault");
		const r = await run("start", "--away", "--exclude", "design-vault");
		expect(r.status).toBe(0);
		expect(readControl().scope).toMatchObject({ mode: "away", exclude: [dv] });
		expect(r.stdout).toContain("mode:      away");
	});

	it("leaves a running away mode's scope and stop time to a normal start", async () => {
		holdPidfile();
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				startedAt: 1,
				seats: [],
				scope: { mode: "away", exclude: [], goals: {} },
			}),
		);
		const r = await run("start", "--goal", "9");
		expect(r.stdout).toContain("away mode is running and is left as it is");
		expect(readControl().startedAt).toBe(1);
		expect(readControl().scope).toMatchObject({
			mode: "away",
			goals: { [dir]: [9] },
		});
	});

	it("refuses a name that is no checkout, a mode's flag in the other, or a bad goal, naming it with the usage", async () => {
		checkout("etc");
		for (const [argv, names] of [
			[["start", "--repo", "nowhere"], "nowhere is no workflow-core checkout"],
			[["start", "--repo", "../etc"], "../etc is no workflow-core checkout"],
			[["start", "--exclude", "x"], "--exclude needs --away"],
			[["start", "--away", "--repo", "etc"], "--repo is normal mode's"],
			[["start", "--goal", "soon"], "--goal takes issue numbers: soon"],
		] as const) {
			const r = await run(...argv);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(names);
			expect(r.stderr).toContain("usage:");
			expect(fs.existsSync(path.join(dir, ".refill-loop-control.json"))).toBe(
				false,
			);
		}
	});
});

describe("the wake file (#2313)", () => {
	const readWakeLines = () =>
		fs.readFileSync(path.join(dir, ".refill-loop-wake"), "utf8").split("\n");

	it("start touches it", async () => {
		holdPidfile();
		await run("start");
		expect(readControl().stopRequested).toBe(false);
		expect(readWakeLines()[0]).toMatch(/^\d{13}$/);
	});

	it("stop touches it", async () => {
		holdPidfile();
		await run("start");
		await run("stop");
		expect(readControl().stopRequested).toBe(true);
		expect(readWakeLines().filter(Boolean)).toHaveLength(2);
	});

	it("stop touches it for a running loop with no control file", async () => {
		holdPidfile();
		await run("stop");
		expect(readWakeLines()[0]).toMatch(/^\d{13}$/);
	});
});

describe("stop and status", () => {
	it("asks a running loop to stop, and status says so", async () => {
		holdPidfile();
		await run("start");
		const r = await run("stop");
		expect(r.stdout).toContain("stop requested");
		/* #2126: a dispatch or the review in flight holds the exit for minutes. */
		expect(r.stdout).toContain(
			"exits when the tick in flight ends, or where none is, at the tick this stop wakes; a dispatch or the morning review can hold a tick for minutes",
		);
		expect(readControl().stopRequested).toBe(true);
		expect((await run("status")).stdout).toContain(
			"at its next tick, on request",
		);
	});

	it("prints each overflow seat's budget line", async () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			`${path.join(dir, ".claude3")}\n~/.claude2-api api key=WFC_TEST_KEY grant=200 cycle-day=20\n`,
		);
		const table = path.join(dir, "table.json");
		fs.writeFileSync(
			table,
			JSON.stringify({
				n: 2,
				meanUsd: 4,
				quantilesUsd: [1, 10],
				tailRemainderUsd: 9,
				landedByHours: [[1, 1]],
			}),
		);
		const r = await runEnv({ WFC_SESSION_COST_TABLE: table }, "status");
		const line = r.stdout
			.split("\n")
			.find((l) =>
				l.startsWith(`overflow ${path.join(dir, ".claude2-api")}: `),
			);
		expect(line?.slice(line.indexOf(": ") + 2)).toMatch(
			/^fits 50; headroom \$200\.00 \(\$0\.00 held by 0 running\); spent \$0\.00 of \$200\.00 since \d{4}-\d{2}-20; resets \d{4}-\d{2}-20$/,
		);
	});

	it("names a damaged state file (#3380)", async () => {
		const state = path.join(dir, ".refill-loop-state.json");
		fs.writeFileSync(state, "{ not json");
		const r = await run("status");
		expect(r.status).toBe(0);
		const line = r.stdout.split("\n").find((l) => l.includes(state));
		expect(line).toContain(`${state} is damaged (`);
		expect(line).toMatch(/JSON.*\); read as absent/);
	});

	it("names a damaged control file and reads it as no start (#3380)", async () => {
		const control = path.join(dir, ".refill-loop-control.json");
		fs.writeFileSync(control, "{ not json");
		const r = await run("stop");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${control} is damaged (`);
		expect(r.stdout).toContain("refill loop: not running");
		expect(fs.readFileSync(control, "utf8")).toBe("{ not json");
	});

	it("treats a pidfile whose process is not the loop as no loop", async () => {
		holdPidfile("something-else.js");
		expect((await run("stop")).stdout).toContain("refill loop: not running");
	});
});

describe("the command line", () => {
	it("refuses an unknown command, naming it, with the usage", async () => {
		const r = await run("go");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown command: go");
		expect(r.stderr).toContain("start | stop | status | dry-run");
	});

	it("refuses a stray flag or no command at all", async () => {
		expect((await run("status", "--now")).status).toBe(2);
		expect((await run()).status).toBe(2);
	});
});
