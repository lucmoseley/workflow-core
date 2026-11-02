// @vitest-environment node
/*
 * The refill loop's commands (#2012) against a sandboxed WFC_REFILL_DIR:
 * `start` on a running loop rather than starting a second, `stop`
 * asking the loop to end, `set` pausing and resuming it (#3856), and the command
 * line. Driven in process, bar a command that must wait on a lock this test
 * frees; a command that spawns the real detached loop is refill-loop-run.test.ts's.
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
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { localDate } from "./lib/morning-review.js";
import { writeCheckout } from "./lib/refill-loop-fixture";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { buildUsageCache } from "./lib/usage-probe-fake";

const SCRIPT = path.resolve(__dirname, "refill-loop.js");

let dir: string;
let fakeLoop: ChildProcess | null = null;
let lockHolder: ChildProcess | null = null;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-"));
});

afterEach(() => {
	fakeLoop?.kill();
	fakeLoop = null;
	lockHolder?.kill();
	lockHolder = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

const commandEnv = (extra: Record<string, string> = {}) => ({
	...process.env,
	WFC_REFILL_DIR: dir,
	CLAUDE_PROJECT_DIR: dir,
	HOME: dir,
	CLAUDE_CONFIG_DIR: path.join(dir, ".claude3"),
	WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
	...extra,
});
const runEnv = (extra: Record<string, string>, ...argv: string[]) =>
	runInProcessAsync(SCRIPT, argv, { cwd: dir, env: commandEnv(extra) });
const run = (...argv: string[]) => runEnv({}, ...argv);

const readControl = () =>
	JSON.parse(
		fs.readFileSync(path.join(dir, ".refill-loop-control.json"), "utf8"),
	);

const spawnIdle = (name = "refill-loop.js") =>
	spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", name], {
		stdio: "ignore",
	});

function holdPidfile(name = "refill-loop.js") {
	fakeLoop = spawnIdle(name);
	fs.writeFileSync(path.join(dir, ".refill-loop.pid"), String(fakeLoop.pid));
	return fakeLoop.pid;
}

describe("start", () => {
	it("overtakes a pending stop, moving the no-progress count's start, rather than starting a second", async () => {
		const pid = holdPidfile();
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ noProgressFrom: 1, stopRequested: true, seats: [] }),
		);
		const before = Date.now();
		const r = await run("start");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`refill loop running: pid ${pid}`);
		expect(readControl().noProgressFrom).toBeGreaterThanOrEqual(before);
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

const checkout = (name: string, config: Record<string, unknown> = {}) =>
	writeCheckout(dir, name, config);

describe("start ensures a process runs (#3868)", () => {
	const controlFile = () => path.join(dir, ".refill-loop-control.json");
	const paused = { by: "founder", at: 7 };
	const goal = {
		form: "issues",
		text: "manta#5",
		refs: [{ repo: "manta", number: 5 }],
		setAt: 3,
	};
	let core: string;
	let manta: string;
	const writeStored = (extra: object = {}) =>
		fs.writeFileSync(
			controlFile(),
			JSON.stringify({
				noProgressFrom: 5,
				stopRequested: false,
				seats: ["/seat"],
				scope: { mode: "away", repos: [manta], goal },
				...extra,
			}),
		);
	const stubbedGh = () =>
		stubGhRoutes(dir, {
			"issue view 500 *": printed(JSON.stringify({ state: "CLOSED" })),
			"issue view *": printed(JSON.stringify({ state: "OPEN" })),
		}).env;
	/* From the core checkout, which writeStored leaves unticked. */
	const start = (...argv: string[]) =>
		runEnv({ ...stubbedGh(), CLAUDE_PROJECT_DIR: core }, "start", ...argv);
	const noProcessStarted = () =>
		expect(fs.existsSync(path.join(dir, ".refill-loop.log"))).toBe(false);
	const Unchecked =
		"core is unchecked on the panel: the loop does not serve it";

	beforeEach(() => {
		core = checkout("core");
		manta = checkout("manta");
	});

	it("writes a fresh control only where none exists: this checkout and each named", async () => {
		holdPidfile();
		const r = await start("--repo", "manta", "--goal", "core#116,manta#117");
		expect(r.status).toBe(0);
		expect(readControl().scope).toEqual({
			mode: "normal",
			repos: [core, manta],
			goal: {
				form: "issues",
				text: "core#116,manta#117",
				refs: [
					{ repo: "core", number: 116 },
					{ repo: "manta", number: 117 },
				],
				setAt: expect.any(Number),
			},
		});
		expect(r.stdout).toContain("mode:      normal");
		expect(r.stdout).not.toContain(Unchecked);
	});

	it.each([["start"], ["start --unless-stopped"]])(
		"%s on a live loop changes nothing, its own repo left unticked",
		async (typed) => {
			const pid = holdPidfile();
			writeStored({ paused });
			const before = fs.readFileSync(controlFile(), "utf8");
			const r = await start(...typed.split(" ").slice(1));
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`refill loop running: pid ${pid}`);
			expect(r.stdout).toContain("paused by founder at");
			expect(r.stdout).toContain("mode:      away");
			expect(r.stdout).toContain(Unchecked);
			expect(fs.readFileSync(controlFile(), "utf8")).toBe(before);
			expect(fs.existsSync(path.join(dir, ".refill-loop-wake"))).toBe(false);
		},
	);

	it("ticks what --repo names and replaces the goal with --goal, and nothing else", async () => {
		holdPidfile();
		writeStored({ paused });
		const r = await start(
			"--unless-stopped",
			"--repo",
			"core",
			"--goal",
			"core#9",
		);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain(Unchecked);
		expect(readControl()).toMatchObject({
			noProgressFrom: 5,
			paused,
			seats: ["/seat"],
			scope: {
				mode: "away",
				repos: [manta, core],
				goal: { refs: [{ repo: "core", number: 9 }] },
			},
		});
		expect(
			fs.readFileSync(path.join(dir, ".refill-loop-wake"), "utf8"),
		).toMatch(/^\d{13}/);
	});

	it("takes a walk as --goal, keeping its form", async () => {
		holdPidfile();
		writeStored({ paused });
		const r = await start("--repo", "core", "--goal", "drain core#9");
		expect(r.status).toBe(0);
		expect(readControl().scope.goal).toMatchObject({
			form: "drain",
			text: "drain core#9",
			refs: [{ repo: "core", number: 9 }],
		});
	});

	it("refuses what `set` refuses, naming it with the usage and writing nothing", async () => {
		checkout("books", { refillLoop: false });
		holdPidfile();
		writeStored();
		const before = fs.readFileSync(controlFile(), "utf8");
		for (const [argv, names] of [
			[["--repo", "nowhere"], "nowhere is no workflow-core checkout"],
			[["--repo", "../etc"], "../etc is no workflow-core checkout"],
			[["--repo", "books"], "books cannot be ticked: refillLoop: false"],
			[["--goal", "soon"], "--goal takes issue refs"],
			[["--goal", "manta#500"], "manta#500"],
			[["--goal", "core#9"], "tick core first"],
			[["--goal", "#9", "--repo", "core"], "write <repo>#9"],
		] as const) {
			const r = await start(...argv);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(names);
			expect(r.stderr).toContain("usage:");
			expect(fs.readFileSync(controlFile(), "utf8")).toBe(before);
		}
	});

	it("takes a bare #N where one repo is ticked", async () => {
		holdPidfile();
		writeStored();
		expect((await start("--goal", "#9")).status).toBe(0);
		expect(readControl().scope.goal.refs).toEqual([
			{ repo: "manta", number: 9 },
		]);
	});

	describe("--unless-stopped", () => {
		it("leaves a stopped loop stopped, and says so", async () => {
			writeStored({ stopRequested: true, stopRequestedAt: 6, paused });
			const before = fs.readFileSync(controlFile(), "utf8");
			const r = await start("--unless-stopped");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"refill loop stopped at 1970-01-01T00:00:00.006Z: left stopped",
			);
			expect(r.stdout).toContain(Unchecked);
			expect(fs.readFileSync(controlFile(), "utf8")).toBe(before);
			noProcessStarted();
		});

		it("takes its flags on a stopped loop, which stays stopped", async () => {
			writeStored({ stopRequested: true, stopRequestedAt: 6 });
			const r = await start("--unless-stopped", "--repo", "core");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("left stopped");
			expect(readControl()).toMatchObject({
				stopRequested: true,
				stopRequestedAt: 6,
				scope: { mode: "away", repos: [manta, core], goal },
			});
			noProcessStarted();
		});

		it("leaves a pending stop to end the loop, printing it", async () => {
			holdPidfile();
			writeStored({ stopRequested: true, stopRequestedAt: 6 });
			const r = await start("--unless-stopped");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("stops:     at its next tick, on request");
			expect(readControl().stopRequested).toBe(true);
		});

		it("names a no-progress pause, which stays", async () => {
			const noProgress = {
				by: "no-progress",
				at: 7,
				issues: [{ root: manta, number: 5 }],
			};
			holdPidfile();
			writeStored({ paused: noProgress });
			const r = await start("--unless-stopped");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("paused by no-progress");
			expect(readControl().paused).toEqual(noProgress);
		});

		it("refuses a damaged control, leaving its bytes", async () => {
			fs.writeFileSync(controlFile(), "{ garbled");
			const r = await start("--unless-stopped");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("is damaged");
			expect(fs.readFileSync(controlFile(), "utf8")).toBe("{ garbled");
			noProcessStarted();
		});

		it("refuses a stop with no control left, writing none", async () => {
			fs.writeFileSync(
				path.join(dir, ".refill-loop-state.json"),
				JSON.stringify({
					stopped: { at: 6, reason: "explicit", detail: "asked" },
				}),
			);
			const r = await start("--unless-stopped");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("holds no stored settings");
			expect(fs.existsSync(controlFile())).toBe(false);
			noProcessStarted();
		});
	});

	it("names a damaged control a plain start replaces", async () => {
		holdPidfile();
		fs.writeFileSync(controlFile(), "{ garbled");
		const r = await start();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/is damaged.*; fresh settings written/);
		expect(readControl().scope.repos).toEqual([core]);
	});

	describe("from a checkout opted out of the loop", () => {
		const startOptedOut = (...argv: string[]) =>
			runEnv(
				{
					...stubbedGh(),
					CLAUDE_PROJECT_DIR: checkout("books", { refillLoop: false }),
				},
				"start",
				...argv,
			);

		it("still sends its flags to a loop with stored settings", async () => {
			holdPidfile();
			writeStored();
			const r = await startOptedOut("--unless-stopped", "--repo", "core");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("refill loop running: pid");
			expect(readControl().scope.repos).toEqual([manta, core]);
		});

		it("writes no fresh control ticking itself", async () => {
			const r = await startOptedOut();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("this checkout is not served");
			expect(fs.existsSync(controlFile())).toBe(false);
		});
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

	const declareOverflowKey = () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			`${path.join(dir, ".claude3")}\n~/.claude2-api api key=WFC_TEST_KEY grant=200 cycle-day=20\n`,
		);
		fs.mkdirSync(path.join(dir, "docs", "data"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "docs", "data", "session-cost-table.json"),
			JSON.stringify({
				n: 2,
				meanUsd: 4,
				quantilesUsd: [1, 10],
				tailRemainderUsd: 9,
				landedByHours: [[1, 1]],
			}),
		);
	};

	const fillPlanSeat = () => {
		fs.mkdirSync(path.join(dir, ".claude3"));
		fs.writeFileSync(
			path.join(dir, ".claude3", ".claude.json"),
			JSON.stringify(buildUsageCache({ week: 100 }, Date.now())),
		);
	};

	it("carries each overflow key's budget and each plan seat's week in status --json", async () => {
		declareOverflowKey();
		fillPlanSeat();
		const json = JSON.parse((await run("status", "--json")).stdout);
		expect(json.overflow).toEqual([
			{
				seat: path.join(dir, ".claude2-api").replace(dir, "~"),
				spentUsd: 0,
				grantUsd: 200,
				headroomUsd: 200,
				exhausted: false,
				noLaunchLeft: false,
			},
		]);
		expect(json.seats.readings).toEqual([
			expect.objectContaining({ week: 100, weekFull: true }),
		]);
	});

	it("settles no key's ledger while a plan seat has room", async () => {
		declareOverflowKey();
		const json = JSON.parse((await run("status", "--json")).stdout);
		expect(json.seats.readings[0].weekFull).toBe(false);
		expect(json.overflow[0].why).toBe("a plan seat is not weekly-full");
	});

	it("carries no overflow key where the seat file declares none", async () => {
		expect(JSON.parse((await run("status", "--json")).stdout).overflow).toEqual(
			[],
		);
	});

	it("says why a key's budget or the seat file will not read", async () => {
		declareOverflowKey();
		fillPlanSeat();
		fs.rmSync(path.join(dir, "docs", "data", "session-cost-table.json"));
		const [key] = JSON.parse((await run("status", "--json")).stdout).overflow;
		expect(key.why).toBe("the session cost table is unreadable");
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude2-api api key=WFC_TEST_KEY grant=200\n",
		);
		const [refusal] = JSON.parse(
			(await run("status", "--json")).stdout,
		).overflow;
		expect(refusal.seat).toBe("the seat file");
		expect(refusal.why).toContain("missing cycle-day=");
	});

	it("prints each overflow seat's budget line", async () => {
		declareOverflowKey();
		const r = await run("status");
		const line = r.stdout
			.split("\n")
			.find((l) =>
				l.startsWith(`overflow ${path.join(dir, ".claude2-api")}: `),
			);
		expect(line?.slice(line.indexOf(": ") + 2)).toMatch(
			/^fits 50; headroom \$200\.00 \(\$0\.00 held by 0 running\); spent \$0\.00 of \$200\.00 since \d{4}-\d{2}-20; resets \d{4}-\d{2}-20$/,
		);
	});

	it("names the plan seats overflow rests on and the dirs the seat file omits (#3767)", async () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude2\n~/.claude2-api api key=WFC_TEST_KEY grant=200 cycle-day=20\n",
		);
		for (const name of [".claude2", ".claude3"]) {
			fs.mkdirSync(path.join(dir, name));
			fs.writeFileSync(path.join(dir, name, ".credentials.json"), "{}");
		}
		const now = Date.now();
		fs.writeFileSync(
			path.join(dir, ".claude2", ".claude.json"),
			JSON.stringify(buildUsageCache({ week: 40 }, now - 120_000)),
		);
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: now,
				stopRequested: false,
				seats: [path.join(dir, ".claude2")],
				scope: { mode: "normal", repos: [], goal: null },
			}),
		);
		const r = await run("status");
		expect(r.status).toBe(0);
		const lines = r.stdout.split("\n");
		const at = lines.indexOf("overflow rests on these plan seats:");
		expect(at).toBeGreaterThan(-1);
		expect(lines[at + 1]).toBe(
			"  ~/.claude2: 40% of the week, read 2m ago, not weekly-full",
		);
		expect(lines[at + 2]).toBe(
			"  credentials outside the seat file: ~/.claude3",
		);
	});

	it("prints no overflow basis where no overflow seat is declared (#3767)", async () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(path.join(dir, ".claude", "refill-seats"), "~/.claude2\n");
		const r = await run("status");
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("overflow rests on");
	});

	it("names a seat file that differs from the running loop's seats (#3767)", async () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude3\n~/.claude2-api api key=WFC_TEST_KEY grant=200 cycle-day=20\n",
		);
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: Date.now(),
				stopRequested: false,
				seats: [path.join(dir, ".claude2")],
				scope: { mode: "normal", repos: [], goal: null },
			}),
		);
		const { stdout } = await run("status");
		expect(stdout).toContain(
			"in the seat file, unread until a plain start restarts the loop: ~/.claude3",
		);
		expect(stdout).toContain(
			"read since the last start, gone from the seat file: ~/.claude2",
		);
	});

	describe("the seats: line off fixture seats (#3733)", () => {
		const seats = () => [".claude2", ".claude3"].map((n) => path.join(dir, n));
		const markerPath = () => path.join(dir, "typed-marker");
		const expectedLine =
			"~/.claude3 week 40% 5h 20%, ~/.claude2 week 98% 5h 95%; next ~/.claude3 (last typed on); passed over ~/.claude2 week 98% ≥ 97%, 5h 95% ≥ 90%";

		beforeEach(() => {
			fs.mkdirSync(path.join(dir, ".claude"));
			fs.writeFileSync(
				path.join(dir, ".claude", "refill-seats"),
				"~/.claude2\n~/.claude3\n",
			);
			const now = Date.now();
			const bars = [
				{ week: 98, session: 95 },
				{ week: 40, session: 20 },
			];
			seats().forEach((seat, i) => {
				fs.mkdirSync(seat);
				fs.writeFileSync(
					path.join(seat, ".claude.json"),
					JSON.stringify(buildUsageCache(bars[i] ?? {}, now)),
				);
			});
			fs.writeFileSync(
				markerPath(),
				`${new Date(now).toISOString()}\n${path.join(dir, ".claude3")}\n`,
			);
			fs.writeFileSync(
				path.join(dir, ".refill-loop-control.json"),
				JSON.stringify({
					noProgressFrom: now,
					stopRequested: false,
					seats: seats(),
					scope: { mode: "normal", repos: [], goal: null },
				}),
			);
		});

		const seatsLines = (stdout: string) =>
			stdout.split("\n").filter((l) => l.trim().startsWith("seats:"));

		it("prints it on status", async () => {
			const r = await runEnv({ WFC_PRESENCE_MARKER: markerPath() }, "status");
			expect(r.status).toBe(0);
			expect(seatsLines(r.stdout)).toEqual([`seats:     ${expectedLine}`]);
		});

		it("carries the same fields in status --json", async () => {
			const r = await runEnv(
				{ WFC_PRESENCE_MARKER: markerPath() },
				"status",
				"--json",
			);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("cap on");
			const { seats: view } = JSON.parse(r.stdout);
			expect(view.readings.map((s: { seat: string }) => s.seat)).toEqual([
				"~/.claude3",
				"~/.claude2",
			]);
			expect(view.readings[1]).toMatchObject({
				week: 98,
				session: 95,
				fresh: true,
			});
			expect(view.next).toEqual({
				seat: "~/.claude3",
				reason: "last typed on",
			});
			expect(view.passedOver).toEqual([
				{
					seat: "~/.claude2",
					limits: [
						{ bar: "week", percent: 98, ceiling: 97 },
						{ bar: "5h", percent: 95, ceiling: 90 },
					],
					hold: null,
				},
			]);
			expect(view.callerSeat).toBeNull();
		});

		it("prints one on start, naming the caller's seat", async () => {
			holdPidfile();
			const r = await runEnv(
				{
					WFC_PRESENCE_MARKER: markerPath(),
					CLAUDE_CONFIG_DIR: path.join(dir, ".claude2"),
				},
				"start",
			);
			expect(r.status).toBe(0);
			expect(seatsLines(r.stdout)).toEqual([
				`  seats:     ${expectedLine}; /pick-next's launches ~/.claude2 (its caller's seat)`,
			]);
		});
	});

	it("names a seat file that refuses and prints no basis on it (#3767)", async () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n~/.claude3-api api nope\n",
		);
		const { stdout } = await run("status");
		expect(stdout).toContain("seat file refuses: ");
		expect(stdout).not.toContain("overflow rests on");
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

describe("set (#3856)", () => {
	const controlFile = () => path.join(dir, ".refill-loop-control.json");
	const lockFile = () => `${controlFile()}.lock`;
	const wakeFile = () => path.join(dir, ".refill-loop-wake");
	const plainControl = {
		noProgressFrom: 5,
		stopRequested: false,
		seats: ["/seat"],
		scope: { mode: "normal", repos: ["/repo"], goal: null },
	};
	const writeControl = (over: Record<string, unknown> = {}) =>
		fs.writeFileSync(
			controlFile(),
			JSON.stringify({ ...plainControl, ...over }),
		);
	const paused = { by: "founder", at: 7 };

	/* A live process the lock names as its holder; kill it to free the lock. */
	function holdLock() {
		const holder = spawnIdle();
		lockHolder = holder;
		fs.writeFileSync(lockFile(), String(holder.pid));
		return holder;
	}
	function spawnCommand(...argv: string[]) {
		/* spawn-kept: the command waits on a lock this test frees, which an
		 * in-process run would block it from freeing. */
		const child = spawn(process.execPath, [SCRIPT, ...argv], {
			cwd: dir,
			env: commandEnv(),
			stdio: "ignore",
		});
		return new Promise<number | null>((resolve) => child.on("close", resolve));
	}
	/* A guess: long enough for a spawned command to reach the lock; a command
	 * that had not would pass the "still waiting" checks without testing them. */
	const settle = () => new Promise((r) => setTimeout(r, 500));

	it("pauses, writing only the pause, touching the wake and printing it", async () => {
		writeControl();
		const before = Date.now();
		const r = await run("set", "--pause");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^paused by founder at \S+Z$/m);
		const { paused: written, ...rest } = readControl();
		expect(rest).toEqual(plainControl);
		expect(written.by).toBe("founder");
		expect(written.at).toBeGreaterThanOrEqual(before);
		expect(fs.existsSync(wakeFile())).toBe(true);
		expect(fs.existsSync(lockFile())).toBe(false);
	});

	it("resumes, dropping the pause and moving only the no-progress count's point", async () => {
		writeControl({ paused });
		holdPidfile();
		const before = Date.now();
		const r = await run("set", "--resume");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("not paused");
		expect(r.stdout).toContain("counting:  no-progress count from ");
		const { noProgressFrom, ...rest } = readControl();
		const { noProgressFrom: _n, ...kept } = plainControl;
		expect(rest).toEqual(kept);
		expect(noProgressFrom).toBeGreaterThanOrEqual(before);
		/* The pidfile's holder is the one process: nothing started a second. */
		expect(r.stdout).not.toContain("refill loop started");
		expect(fs.readFileSync(path.join(dir, ".refill-loop.pid"), "utf8")).toBe(
			String(fakeLoop?.pid),
		);
	});

	it("leaves a stop pending on a running loop standing through a resume", async () => {
		writeControl({ paused, stopRequested: true, stopRequestedAt: 6 });
		holdPidfile();
		expect((await run("set", "--resume")).status).toBe(0);
		expect(readControl()).toMatchObject({
			stopRequested: true,
			stopRequestedAt: 6,
		});
		expect(readControl().paused).toBeUndefined();
	});

	it("changes nothing asked for twice, but still wakes the loop", async () => {
		writeControl({ paused });
		const repeat = await run("set", "--pause");
		expect(repeat.status).toBe(0);
		expect(repeat.stdout).toContain("unchanged: paused by founder at");
		expect(readControl().paused).toEqual(paused);
		expect(fs.existsSync(wakeFile())).toBe(true);

		writeControl();
		holdPidfile();
		const idle = await run("set", "--resume");
		expect(idle.status).toBe(0);
		expect(idle.stdout).toContain("unchanged: not paused");
		expect(readControl().noProgressFrom).toBe(5);
	});

	it("says a change to a stopped loop holds from its next start", async () => {
		writeControl();
		const r = await run("set", "--pause");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("not running; this holds from its next start");
	});

	it("never undoes a stop that landed while it waited on the lock", async () => {
		writeControl();
		const holder = holdLock();
		const done = spawnCommand("set", "--pause");
		await settle();
		expect(readControl()).not.toHaveProperty("paused");
		writeControl({ stopRequested: true });
		holder.kill();
		expect(await done).toBe(0);
		expect(readControl().stopRequested).toBe(true);
		expect(readControl().paused.by).toBe("founder");
	});

	it("makes stop wait on the same lock, losing neither change", async () => {
		writeControl({ paused });
		const holder = holdLock();
		const done = spawnCommand("stop");
		await settle();
		expect(readControl().stopRequested).toBe(false);
		holder.kill();
		expect(await done).toBe(0);
		expect(readControl().stopRequested).toBe(true);
		expect(readControl().paused).toEqual(paused);
	});

	it("makes start wait on the same lock, keeping the pause", async () => {
		holdPidfile();
		writeControl({ paused, stopRequested: true });
		const holder = holdLock();
		const done = spawnCommand("start");
		await settle();
		expect(readControl().stopRequested).toBe(true);
		holder.kill();
		expect(await done).toBe(0);
		expect(readControl().stopRequested).toBe(false);
		expect(readControl().paused).toEqual(paused);
	});

	it("takes over a dead holder's lock", async () => {
		writeControl();
		const holder = holdLock();
		holder.kill();
		await new Promise((resolve) => holder.on("close", resolve));
		expect((await run("set", "--pause")).status).toBe(0);
		expect(readControl().paused.by).toBe("founder");
		expect(fs.existsSync(lockFile())).toBe(false);
	});

	it("keeps a pause across a start, after a stop too", async () => {
		writeControl({ paused, stopRequested: true });
		fs.mkdirSync(path.join(dir, "code"));
		holdPidfile();
		const r = await run("start");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("paused by founder at");
		expect(readControl().paused).toEqual(paused);
		expect(readControl().stopRequested).toBe(false);
	});

	it("carries what the panel reads in status --json, and no code with no process", async () => {
		writeControl();
		const at = new Date(2026, 10, 2, 9).getTime();
		fs.writeFileSync(
			path.join(dir, ".refill-loop-state.json"),
			JSON.stringify({
				lastTick: { at, summary: "idle: no free slot", idle: "no free slot" },
				launchDay: { day: localDate(new Date()), count: 3 },
			}),
		);
		const json = JSON.parse((await run("status", "--json")).stdout);
		expect(json).toMatchObject({
			running: false,
			codeSha: null,
			paused: null,
			stopRequested: false,
			lastTick: {
				at,
				summary: "idle: no free slot",
				idle: "no free slot",
				paused: false,
			},
			launchesToday: 3,
		});
	});

	it("carries burn mode's state in status --json, off the marker the script writes", async () => {
		writeControl();
		const marker = path.join(dir, ".burn-mode");
		const burnMode = async () => {
			const r = await runEnv({ WFC_BURN_MARKER: marker }, "status", "--json");
			expect(r.status).toBe(0);
			return JSON.parse(r.stdout).burnMode;
		};
		expect((await burnMode()).on).toBe(false);
		fs.writeFileSync(marker, "{}");
		expect((await burnMode()).on).toBe(true);
	});

	it("shows the pause in status and status --json", async () => {
		writeControl({ paused });
		const r = await run("status");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`paused by founder at ${new Date(7).toISOString()}; launches nothing until \`set --resume\``,
		);
		expect(JSON.parse((await run("status", "--json")).stdout).paused).toEqual(
			paused,
		);
		writeControl();
		expect(
			JSON.parse((await run("status", "--json")).stdout).paused,
		).toBeNull();
	});

	it.each([
		["no flag", [], "set names no field"],
		["both flags", ["--pause", "--resume"], "one of --pause and --resume"],
	])("refuses %s as a usage error on stderr", async (_name, flags, why) => {
		writeControl();
		const r = await run("set", ...flags);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(why);
		expect(r.stderr).toContain("usage:");
		expect(readControl()).toEqual(plainControl);
	});

	it("refuses with exit 1 where the loop was never started, writing nothing", async () => {
		const r = await run("set", "--pause");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("never started; run `start` first");
		expect(fs.existsSync(controlFile())).toBe(false);
	});

	it("refuses with exit 1 on a damaged control, leaving its bytes", async () => {
		fs.writeFileSync(controlFile(), "{ not json");
		const r = await run("set", "--pause");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("is damaged");
		expect(r.stderr).toContain("`start` rewrites it");
		expect(fs.readFileSync(controlFile(), "utf8")).toBe("{ not json");
	});
});

describe("a stop told from a crash (#3861)", () => {
	const control = {
		noProgressFrom: 5,
		stopRequested: false,
		seats: [],
		scope: { mode: "normal", repos: [], goals: {} },
	};
	const writeControl = (over: Record<string, unknown> = {}) =>
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ ...control, ...over }),
		);
	const writeState = (state: Record<string, unknown>) =>
		fs.writeFileSync(
			path.join(dir, ".refill-loop-state.json"),
			JSON.stringify(state),
		);
	const status = async () => ({
		json: JSON.parse((await run("status", "--json")).stdout),
		text: (await run("status")).stdout,
	});
	const noProgress = { at: 9, reason: "no-progress", detail: "no act" };

	it("reads a live loop as neither, showing no stop older than its run", async () => {
		writeControl();
		writeState({ stopped: noProgress, heldAt: 8 });
		holdPidfile();
		const { json, text } = await status();
		expect(json).toMatchObject({ running: true, stop: null, crashed: false });
		expect(text).not.toContain("last stop:");
		expect(text).not.toContain("died:");
	});

	it("records the time of a stop, keeping the first through a repeat", async () => {
		writeControl();
		const before = Date.now();
		expect((await run("stop")).status).toBe(0);
		const { stopRequestedAt } = readControl();
		expect(stopRequestedAt).toBeGreaterThanOrEqual(before);
		expect((await run("stop")).status).toBe(0);
		expect(readControl().stopRequestedAt).toBe(stopRequestedAt);
	});

	it("reads a dead loop a `stop` reached as stopped, before any tick recorded it", async () => {
		writeControl({ stopRequested: true, stopRequestedAt: 7 });
		const { json, text } = await status();
		expect(json).toMatchObject({
			running: false,
			stop: { at: 7, reason: "explicit", detail: "stop was requested" },
			crashed: false,
		});
		expect(text).toContain(
			`last stop: ${new Date(7).toISOString()}  explicit — stop was requested`,
		);
	});

	it("reads a dead loop that ended itself as stopped, with the loop's reason", async () => {
		writeControl();
		writeState({ stopped: noProgress, heldAt: 8 });
		const { json, text } = await status();
		expect(json).toMatchObject({ stop: noProgress, crashed: false });
		expect(text).toContain("no-progress — no act");
		expect(text).not.toContain("died:");
	});

	it("reads a dead loop with no stop recorded as crashed", async () => {
		writeControl();
		writeState({ stopped: null, heldAt: 8 });
		const { json, text } = await status();
		expect(json).toMatchObject({ running: false, stop: null, crashed: true });
		expect(text).toContain(
			"died:      with no stop recorded since its last start",
		);
		expect(text).not.toContain("last stop:");
	});

	it("does not read a loop never started as crashed", async () => {
		const { json, text } = await status();
		expect(json).toMatchObject({ stop: null, crashed: false });
		expect(text).not.toContain("died:");
	});

	it("does not read a start whose process has not held the pidfile as crashed", async () => {
		writeControl();
		writeState({ stopped: null, heldAt: null });
		const { json, text } = await status();
		expect(json).toMatchObject({ stop: null, crashed: false });
		expect(text).not.toContain("died:");
	});
});

describe("the ticked set and the mode (#3862)", () => {
	const writeControl = (scope: Record<string, unknown>) =>
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ noProgressFrom: 1, seats: [], scope }),
		);
	const reposOf = async () => {
		const { repos } = JSON.parse((await run("status", "--json")).stdout);
		return repos as {
			name: string;
			root: string;
			ticked: boolean;
			disabled: string | null;
		}[];
	};
	const namesTicked = async () =>
		(await reposOf()).filter((r) => r.ticked).map((r) => r.name);

	let core: string;
	let manta: string;
	beforeEach(() => {
		core = checkout("core");
		manta = checkout("manta");
		writeControl({ mode: "normal", repos: [core], goal: null });
	});

	it("flips the mode either way, leaving the ticked repos and printing only the change", async () => {
		const away = await run("set", "--away");
		expect(away.status).toBe(0);
		expect(away.stdout).toContain("mode:      away");
		expect(away.stdout).not.toContain("repos:");
		expect(readControl().scope).toMatchObject({
			mode: "away",
			repos: [core],
		});
		expect(await namesTicked()).toEqual(["core"]);
		await run("set", "--normal");
		expect(readControl().scope).toEqual({
			mode: "normal",
			repos: [core],
			goal: null,
		});
	});

	it("records when away was switched on, a repeat keeping it, and drops it on normal", async () => {
		const before = Date.now();
		const switched = await run("set", "--away");
		expect(switched.status).toBe(0);
		expect(switched.stdout).toContain("mode:      away");
		const { away } = readControl();
		expect(away.since).toBeGreaterThanOrEqual(before);
		expect(away.absentSeen).toBe(false);

		await run("set", "--away");
		expect(readControl().away).toEqual(away);

		await run("set", "--normal");
		expect(readControl().away).toBeUndefined();
		expect(
			JSON.parse((await run("status", "--json")).stdout).awaySince,
		).toBeNull();
	});

	it("re-arms a repeat --away, so the prompt behind the ask reads as no return", async () => {
		await run("set", "--away");
		const control = readControl();
		const { since } = control.away;
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ ...control, away: { since, absentSeen: true } }),
		);
		const r = await run("set", "--away");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("unchanged: mode away");
		expect(readControl().away).toEqual({ since, absentSeen: false });
	});

	it("reads in status --json the sessions handed off since this switch", async () => {
		await run("set", "--away");
		const { since } = readControl().away;
		const state = path.join(dir, ".refill-loop-state.json");
		const status = async () =>
			JSON.parse((await run("status", "--json")).stdout);
		fs.writeFileSync(
			state,
			JSON.stringify({ launches: [], handedOff: { from: since, count: 2 } }),
		);
		expect(await status()).toMatchObject({
			mode: "away",
			awaySince: since,
			handedOffSinceAway: 2,
		});

		fs.writeFileSync(
			state,
			JSON.stringify({
				launches: [],
				handedOff: { from: since - 1, count: 2 },
			}),
		);
		expect((await status()).handedOffSinceAway).toBe(0);

		await run("set", "--normal");
		expect((await status()).handedOffSinceAway).toBe(0);
	});

	it("keeps a running away mode's switch across a start", async () => {
		await run("set", "--away");
		const { away } = readControl();
		holdPidfile();
		const r = await run("start");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("refill loop running: pid");
		expect(readControl().away).toEqual(away);
	});

	it("ticks, unticks and replaces the set in either mode, the mode untouched", async () => {
		for (const mode of ["normal", "away"]) {
			writeControl({
				mode,
				repos: [core],
				goal: {
					form: "issues",
					text: "9",
					refs: [{ repo: "core", number: 9 }],
					setAt: 1,
				},
			});
			const r = await run("set", "--tick", "manta");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("repos:     core, manta");
			expect(readControl().scope).toMatchObject({
				mode,
				repos: [core, manta],
				goal: { refs: [{ repo: "core", number: 9 }] },
			});
			expect((await run("set", "--untick", "core")).status).toBe(0);
			expect(readControl().scope.repos).toEqual([manta]);
			const whole = await run("set", "--repos", "core", "--repos", "manta");
			expect(whole.status).toBe(0);
			expect(readControl().scope.repos).toEqual([core, manta]);
			expect(readControl().scope.mode).toBe(mode);
		}
	});

	it("says a tick already held changes nothing, and touches the wake", async () => {
		const r = await run("set", "--tick", "core");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("unchanged: repos core");
		expect(
			fs.readFileSync(path.join(dir, ".refill-loop-wake"), "utf8"),
		).toMatch(/^\d{13}/);
	});

	it("takes a pause, a mode and a tick in one call", async () => {
		const r = await run("set", "--pause", "--away", "--tick", "manta");
		expect(r.status).toBe(0);
		const control = readControl();
		expect(control.paused.by).toBe("founder");
		expect(control.scope).toMatchObject({
			mode: "away",
			repos: [core, manta],
		});
	});

	it("says a change holds from the next start on a loop with no process", async () => {
		const r = await run("set", "--tick", "manta");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("not running; this holds from its next start");
	});

	it("refuses a tick of what is no candidate or is opted out, naming why and writing nothing", async () => {
		checkout("books", { refillLoop: false });
		fs.mkdirSync(path.join(dir, "linked", ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, "linked", ".git"), "gitdir: /x\n");
		fs.writeFileSync(
			path.join(dir, "linked", ".claude", "workflow-core.json"),
			"{}\n",
		);
		const before = readControl();
		for (const [flag, name, why] of [
			["--tick", "nowhere", "nowhere is no workflow-core checkout"],
			["--tick", "../core", "../core is no workflow-core checkout"],
			["--tick", "books", "books cannot be ticked: refillLoop: false"],
			["--tick", "linked", "linked is not a main checkout"],
			["--repos", "books", "books cannot be ticked: refillLoop: false"],
			["--untick", "nowhere", "nowhere is no workflow-core checkout"],
		]) {
			const r = await run("set", flag, name);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(why);
			expect(r.stderr).toContain("usage:");
			expect(readControl()).toEqual(before);
		}
	});

	it("unticks a ticked checkout that has since opted out", async () => {
		const books = checkout("books");
		writeControl({ mode: "normal", repos: [core, books], goal: null });
		fs.writeFileSync(
			path.join(books, ".claude", "workflow-core.json"),
			`${JSON.stringify({ refillLoop: false })}\n`,
		);
		expect((await run("set", "--untick", "books")).status).toBe(0);
		expect(readControl().scope.repos).toEqual([core]);
	});

	it("refuses flags that contradict, or none", async () => {
		for (const [argv, why] of [
			[["set"], "set names no field"],
			[["set", "--away", "--normal"], "one of --away and --normal"],
			[
				["set", "--repos", "core", "--tick", "manta"],
				"--repos is the whole set",
			],
			[["set", "--tick", "core", "--untick", "core"], "core is both"],
		] as const) {
			const r = await run(...argv);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(why);
			expect(r.stderr).toContain("usage:");
		}
	});

	it("lists every candidate in status --json, with why any is disabled, and leaves a later one unticked and unserved", async () => {
		checkout("books", { refillLoop: false });
		expect((await run("set", "--away")).status).toBe(0);
		checkout("later");
		const rows = await reposOf();
		expect(rows).toEqual(
			expect.arrayContaining([
				{ name: "core", root: core, ticked: true, disabled: null },
				{ name: "manta", root: manta, ticked: false, disabled: null },
				{
					name: "books",
					root: path.join(dir, "books"),
					ticked: false,
					disabled: "refillLoop: false",
				},
				{
					name: "later",
					root: path.join(dir, "later"),
					ticked: false,
					disabled: null,
				},
			]),
		);
		expect(JSON.parse((await run("status", "--json")).stdout).mode).toBe(
			"away",
		);
		expect((await run("status")).stdout).toContain("repos:     core\n");
	});

	it("adopts the live control's away shape as the checkouts it serves now", async () => {
		checkout("books", { refillLoop: false });
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: 1,
				stopRequested: false,
				seats: [],
				scope: { mode: "away", repos: [], exclude: [manta], goal: null },
			}),
		);
		expect(await namesTicked()).toEqual(["core"]);
		const r = await run("set", "--tick", "manta");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("repos:     core, manta");
		checkout("later");
		expect(await namesTicked()).toEqual(["core", "manta"]);
		expect(readControl().scope.mode).toBe("away");
	});

	it("repeats every other included checkout as exclude in away mode, for a loop on older code", async () => {
		checkout("books", { refillLoop: false });
		const r = await run("set", "--away");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("mode:      away");
		expect(readControl().scope.exclude).toEqual([manta]);
		expect((await run("set", "--normal")).status).toBe(0);
		expect(readControl().scope.exclude).toBeUndefined();
	});

	it("keeps an emptied away set empty when a checkout appears later", async () => {
		writeControl({ mode: "away", repos: [core], goal: null });
		expect((await run("set", "--untick", "core")).status).toBe(0);
		checkout("later");
		expect(await namesTicked()).toEqual([]);
		expect((await run("status")).stdout).toContain("repos:     none\n");
	});
});

describe("the goal (#3864)", () => {
	const writeControl = (scope: object) =>
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ noProgressFrom: 1, seats: [], scope }),
		);
	/* 404 is unknown and 500 closed; any other issue is open. */
	const fakeGh = () =>
		stubGhRoutes(dir, {
			"issue view 404 *": {
				status: 1,
				stdout: "",
				stderr: "GraphQL: Could not resolve to an issue\n",
			},
			"issue view 500 *": printed(JSON.stringify({ state: "CLOSED" })),
			"issue view *": printed(JSON.stringify({ state: "OPEN" })),
		}).env;
	const setGoal = (...argv: string[]) => runEnv(fakeGh(), "set", ...argv);
	const ref = (repo: string, number: number) => ({ repo, number });

	let core: string;
	let manta: string;
	beforeEach(() => {
		core = writeCheckout(dir, "core");
		manta = writeCheckout(dir, "manta");
		writeControl({ mode: "normal", repos: [core], goal: null });
	});

	it("stores bare numbers against the one ticked repo, with the text as typed", async () => {
		const before = Date.now();
		const r = await setGoal("--goal", "2518,#2520");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'goal:      issues "2518,#2520": core#2518, core#2520',
		);
		const { goal } = readControl().scope;
		expect(goal).toMatchObject({
			form: "issues",
			text: "2518,#2520",
			refs: [ref("core", 2518), ref("core", 2520)],
		});
		expect(goal.setAt).toBeGreaterThanOrEqual(before);
	});

	it("takes a goal joined to its flag, as the panel sends it, so typed words reach no other flag", async () => {
		const stored = await setGoal("--goal=drain #5");
		expect(stored.status).toBe(0);
		expect(readControl().scope.goal).toMatchObject({
			form: "drain",
			text: "drain #5",
		});
		for (const typed of ["--pause", "--help", "--", ""]) {
			const r = await setGoal(`--goal=${typed}`);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("--goal takes issue refs");
		}
		expect(readControl().paused).toBeUndefined();
		expect(readControl().scope.goal).toMatchObject({ text: "drain #5" });
	});

	it("stores refs in two ticked repos and carries them on status --json", async () => {
		writeControl({ mode: "normal", repos: [core, manta], goal: null });
		expect((await setGoal("--goal", "core#1,manta#2")).status).toBe(0);
		const { goal } = JSON.parse((await run("status", "--json")).stdout);
		expect(goal).toMatchObject({
			form: "issues",
			text: "core#1,manta#2",
			refs: [ref("core", 1), ref("manta", 2)],
		});
	});

	it("reports the last read's set and counts, and when the goal finished (#3866)", async () => {
		writeControl({ mode: "normal", repos: [core], goal: null });
		expect((await setGoal("--goal", "drain #5")).status).toBe(0);
		const { setAt } = readControl().scope.goal;
		const write = (goalProgress: object) =>
			fs.writeFileSync(
				path.join(dir, ".refill-loop-state.json"),
				JSON.stringify({ goalProgress }),
			);
		const fresh = JSON.parse((await run("status", "--json")).stdout).goal;
		expect(fresh).toMatchObject({ form: "drain", open: null, doneAt: null });
		const set = [{ repo: "o/core", number: 6, title: "t" }];
		write({ setAt, set, takeable: 1, running: 0, readAt: 1, doneAt: null });
		expect(
			JSON.parse((await run("status", "--json")).stdout).goal,
		).toMatchObject({
			set,
			open: 1,
			takeable: 1,
			running: 0,
			readAt: 1,
			doneAt: null,
		});
		expect((await run("status")).stdout).toContain(
			"— 1 open, 1 takeable, 0 running",
		);
		write({ setAt, set: [], takeable: 0, running: 0, readAt: 2, doneAt: 2 });
		expect(
			JSON.parse((await run("status", "--json")).stdout).goal,
		).toMatchObject({ open: 0, doneAt: 2, form: "drain" });
		expect((await run("status")).stdout).toContain(
			"— done 1970-01-01T00:00:00.002Z; running bare",
		);
	});

	it("judges a ref on the set the same call leaves", async () => {
		const r = await setGoal("--tick", "manta", "--goal", "manta#2");
		expect(r.status).toBe(0);
		expect(readControl().scope).toMatchObject({
			repos: [core, manta],
			goal: { refs: [ref("manta", 2)] },
		});
		const refused = await setGoal("--untick", "manta", "--goal", "manta#3");
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("manta, which is not ticked");
		expect(readControl().scope.repos).toEqual([core, manta]);
	});

	it.each([
		[
			"a bare #N with two repos ticked",
			"#5",
			"#5 names no repo with 2 repos ticked: write <repo>#5",
		],
		[
			"an unticked repo's ref",
			"books#5",
			"books, which is not ticked: tick books first",
		],
		["a closed issue", "core#500", "core#500 is closed"],
		["an unknown issue", "core#404", "Could not resolve to an issue"],
		["no ref at all", "drain", "--goal takes issue refs"],
		["a walk of two", "drain core#1,core#2", "drain or unblock with one"],
		["a walk in an unticked repo", "drain books#5", "tick books first"],
	])("refuses %s, naming why and writing nothing", async (_, typed, why) => {
		writeControl({ mode: "normal", repos: [core, manta], goal: null });
		const before = readControl();
		const r = await setGoal("--goal", typed);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(why);
		expect(readControl()).toEqual(before);
	});

	it.each(["drain", "unblock"])(
		"stores a %s as its form and ref, not its numbers",
		async (form) => {
			writeControl({ mode: "normal", repos: [core], goal: null });
			const r = await setGoal("--goal", `${form} #2518`);
			expect(r.status).toBe(0);
			expect(readControl().scope.goal).toMatchObject({
				form,
				text: `${form} #2518`,
				refs: [ref("core", 2518)],
			});
		},
	);

	it("refuses the same way on a confirmed topic's issues", async () => {
		const r = await setGoal(
			"--goal-issues",
			"manta#5",
			"--goal-text",
			"faster tests",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("manta, which is not ticked");
	});

	it("stores a confirmed topic's set with the text it came from", async () => {
		const r = await setGoal(
			"--goal-issues",
			"core#7,#8",
			"--goal-text",
			"issues that make the test suite faster",
		);
		expect(r.status).toBe(0);
		expect(readControl().scope.goal).toMatchObject({
			form: "topic",
			text: "issues that make the test suite faster",
			refs: [ref("core", 7), ref("core", 8)],
		});
	});

	it("refuses goal flags that do not go together", async () => {
		for (const [argv, why] of [
			[["--goal", "1", "--clear-goal"], "one of --goal and --clear-goal"],
			[
				["--goal", "1", "--goal-issues", "2", "--goal-text", "t"],
				"one of --goal and --goal-issues",
			],
			[["--goal-issues", "1"], "--goal-issues and --goal-text go together"],
			[["--goal-text", "t"], "--goal-issues and --goal-text go together"],
			[["--goal-issues", "1", "--goal-text", " "], "--goal-text is empty"],
		] as const) {
			const r = await setGoal(...argv);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(why);
		}
	});

	it("leaves the loop bare on --clear-goal, and says a repeat changes nothing", async () => {
		await setGoal("--goal", "1");
		const cleared = await setGoal("--clear-goal");
		expect(cleared.status).toBe(0);
		expect(cleared.stdout).toContain("goal:      none");
		expect(readControl().scope.goal).toBeNull();
		expect(readControl().scope.repos).toEqual([core]);
		expect((await setGoal("--clear-goal")).stdout).toContain(
			"unchanged: goal none",
		);
	});

	it("names a garbled goal on stderr at status --json, its stdout still one object", async () => {
		writeControl({ mode: "normal", repos: [core], goal: "soon" });
		const r = await run("status", "--json");
		expect(JSON.parse(r.stdout).goal).toBeNull();
		expect(r.stderr).toContain("goal is garbled");
	});

	it("keeps a repeated goal's time", async () => {
		const goal = {
			form: "issues",
			text: "1",
			refs: [ref("core", 1)],
			setAt: 7,
		};
		writeControl({ mode: "normal", repos: [core], goal });
		const r = await setGoal("--goal", "1");
		expect(r.stdout).toContain("unchanged: goal:");
		expect(readControl().scope.goal.setAt).toBe(7);
	});

	it("rewrites a control in the shape before it as one goal on any set", async () => {
		writeControl({ mode: "normal", repos: [core], goals: { [core]: [9] } });
		expect((await run("set", "--away")).status).toBe(0);
		const { scope } = readControl();
		expect(scope).not.toHaveProperty("goals");
		expect(scope.goal).toMatchObject({
			form: "issues",
			refs: [ref("core", 9)],
		});
	});
});

describe("the command line", () => {
	it("refuses an unknown command, naming it, with the usage", async () => {
		const r = await run("go");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown command: go");
		expect(r.stderr).toContain("start | stop | set | status | dry-run");
	});

	it("refuses a stray flag or no command at all", async () => {
		expect((await run("status", "--now")).status).toBe(2);
		expect((await run()).status).toBe(2);
	});
});
