// @vitest-environment node
/*
 * Pins that runInProcess hands a script what a real process would — exit
 * code, both streams, cwd, env, stdin, argv, a fresh module state — and
 * restores every global it patched.
 *
 * The only tests the seam has, so a hole here is a hole under every suite that
 * runs through it, which is why most cases below assert parity against a real
 * spawn of the same fixture rather than against a hand-written expectation
 * (mantahostels#1907).
 */

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEAKED } from "./fixtures/in-process-probe-modes";
import { runInProcess, runInProcessAsync } from "./run-in-process";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const PROBE = path.resolve(__dirname, "fixtures/in-process-probe.js");
const ASYNC_PROBE = path.resolve(
	__dirname,
	"fixtures/in-process-async-probe.js",
);
const UNGUARDED_PROBE = path.resolve(
	__dirname,
	"fixtures/in-process-unguarded-probe.js",
);

type RunOptions = Parameters<typeof runInProcess>[2];

/** The same call through a real `node`, for the parity assertions. */
const spawned = (args: string[], options: RunOptions = {}, script = PROBE) => {
	const r = spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv,
		input: options.stdin,
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout,
		stderr: r.stderr,
		restoreFailures: [],
	};
};

const dirs: string[] = [];
const tmpdir = () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "in-proc-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
	clearInterval((globalThis as Record<symbol, NodeJS.Timeout>)[LEAKED]);
});

type Result = ReturnType<typeof runInProcess>;

/* A thrown stack's frames differ by route — node's loader under a spawn, the
 * harness and vitest in-process — so the throw row compares its message line. */
const errorLine = (r: Result) => ({
	status: r.status,
	stdout: r.stdout,
	error: /^Error: .*$/m.exec(r.stderr)?.[0],
});

interface Row {
	behaviour: string;
	args: string[];
	options?: () => RunOptions;
	project?: (r: Result) => unknown;
}

/*
 * The probe contract (#2782): one row per behaviour run-in-process.js's
 * header says it reproduces. Options are built per run, since some need a
 * fresh tmpdir.
 */
const SHARED: Row[] = [
	{
		behaviour: "returns a bare process.exitCode set without exiting",
		args: ["exit-code", "4"],
	},
	{
		behaviour: "captures both write routes on both streams",
		args: ["streams"],
	},
	{
		behaviour: "runs in the cwd it is given",
		args: ["cwd"],
		options: () => ({ cwd: tmpdir() }),
	},
	{
		behaviour: "replaces the environment rather than adding to it",
		args: ["env"],
		options: () => ({ env: { PROBE: "set" } }),
	},
	{
		behaviour: "hands cwd and env to the child processes the script spawns",
		args: ["child"],
		options: () => ({
			cwd: tmpdir(),
			env: { ...process.env, PROBE: "inherited" },
		}),
	},
	{
		behaviour: "hands the script its stdin as a string off fd 0",
		args: ["stdin"],
		options: () => ({ stdin: '{"a":1}' }),
	},
	{
		behaviour: "hands the script its stdin as a buffer off fd 0",
		args: ["stdin-buffer"],
		options: () => ({ stdin: "raw" }),
	},
	{
		behaviour: "passes argv beyond the script name",
		args: ["argv", "one", "two"],
	},
	{
		behaviour: "lets an unref'd timer pass, as it lets a real process exit",
		args: ["leak-timer-unref"],
	},
	{
		behaviour: "lets a timer left behind a process.exit pass",
		args: ["leak-then-exit"],
	},
];

/* What only the sync entry point shares with a spawn: the async one's
 * require.main gap and rejection route are documented divergences, pinned in
 * its own describe below. */
const SYNC_ONLY: Row[] = [
	{
		behaviour:
			"returns the code the script exits with, and what it printed first",
		args: ["exit", "3"],
	},
	// runCheck catches everything spec.run() throws, and
	// `check-guard-registry.js --review` exits from inside it. A real process
	// was gone before that catch ever ran.
	{
		behaviour: "lets nothing take back an exit the script then catches",
		args: ["exit-in-try"],
	},
	// Returning normally after the swallow: the recorded code is then the only
	// record of the exit.
	{
		behaviour: "keeps an exit the script swallows outright",
		args: ["exit-swallowed"],
	},
	{
		behaviour: "reports an escaping throw as node does",
		args: ["throw"],
		project: errorLine,
	},
	// Every checker requires lib/check.js, whose uncaughtException listener
	// reports the crash as BROKEN and exits 2.
	{
		behaviour: "hands an uncaught throw to the handler the script registered",
		args: ["throw-handled"],
	},
	{
		behaviour: "makes the script its own entry module",
		args: ["entry-module"],
	},
	{
		behaviour: "lets a timer left behind a fatal throw pass",
		args: ["leak-then-throw"],
		project: errorLine,
	},
];

const ASYNC_ONLY: Row[] = [
	{
		behaviour: "returns the code main exits with after an await",
		args: ["exit", "3"],
	},
	{
		behaviour: "keeps output in order across an await inside main",
		args: ["ordered"],
	},
	{ behaviour: "runs main once", args: ["ran"] },
];

/* Unmeasured guess: long enough for node to start and print "armed" on a
 * loaded machine. Too short fails the "armed" assertion loudly rather than
 * passing. */
const HANG_MS = 2000;

/* A leaked ref'd timer's spawned side: only a real process's timeout can show
 * that it never exits, which is what the in-process refusal stands in for. */
const hangs = (script: string, mode: string) =>
	new Promise<{ stdout: string; killed: boolean }>((resolve) => {
		execFile(
			process.execPath,
			[script, mode],
			{ timeout: HANG_MS },
			(error, stdout) => resolve({ stdout, killed: error?.killed === true }),
		);
	});

const parity = (
	r: Result,
	spawnedResult: Result,
	project = (x: Result) => x as unknown,
) => {
	// A renamed mode fails alike both ways, which parity alone would pass.
	expect(spawnedResult.stderr).not.toContain("unknown mode");
	expect(project(r)).toEqual(project(spawnedResult));
};

describe("probe contract: spawned and in-process agree (#2782)", () => {
	it.each([...SHARED, ...SYNC_ONLY])(
		"runInProcess $behaviour",
		({ args, options, project }) => {
			const opts = options?.();
			parity(runInProcess(PROBE, args, opts), spawned(args, opts), project);
		},
	);

	it.each([...SHARED, ...ASYNC_ONLY])(
		"runInProcessAsync $behaviour",
		async ({ args, options, project }) => {
			const opts = options?.();
			parity(
				await runInProcessAsync(ASYNC_PROBE, args, opts),
				spawned(args, opts, ASYNC_PROBE),
				project,
			);
		},
	);

	it("refuses in-process each leak that hangs a spawned run", async () => {
		const leaks = [
			[PROBE, "leak-timer"],
			[ASYNC_PROBE, "leak-timer"],
			[PROBE, "leak-then-handled-throw"],
		] as const;
		// "armed" proves the probe reached the leak, so the timeout is the
		// timer's doing and not a slow start.
		for (const r of await Promise.all(leaks.map(([s, m]) => hangs(s, m))))
			expect(r).toEqual({ stdout: "armed\n", killed: true });

		const refusal = /without ending the process.*Timeout x1/;
		expect(() => runInProcess(PROBE, ["leak-timer"])).toThrow(refusal);
		clearInterval((globalThis as Record<symbol, NodeJS.Timeout>)[LEAKED]);
		expect(() => runInProcess(PROBE, ["leak-then-handled-throw"])).toThrow(
			refusal,
		);
		clearInterval((globalThis as Record<symbol, NodeJS.Timeout>)[LEAKED]);
		// The async form checks once main has settled: the probe arms its
		// timer after an await.
		await expect(
			runInProcessAsync(ASYNC_PROBE, ["leak-timer"]),
		).rejects.toThrow(refusal);
	});
});

describe("runInProcess", () => {
	it("reports an escaping throw as node does — exit 1, stack on stderr", () => {
		const r = runInProcess(PROBE, ["throw"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("probe threw");
		expect(r.stderr).toContain("in-process-probe.js");
	});

	it("leaves a read of any real file alone while stdin is stubbed", () => {
		const file = path.join(tmpdir(), "real.txt");
		fs.writeFileSync(file, "on disk");
		const r = runInProcess(PROBE, ["read-file", file], { stdin: "ignored" });
		expect(r.stdout).toBe("on disk\n");
	});

	it("purges repo module state between calls, as a fresh process would", () => {
		expect(runInProcess(PROBE, ["state"]).stdout).toBe("1\n");
		expect(runInProcess(PROBE, ["state"]).stdout).toBe("1\n");
	});

	it("purges a fixture copy's modules too, not only this repo's", () => {
		// Several suites run a checker out of a copy of the tree in a temp dir.
		const dir = tmpdir();
		fs.writeFileSync(path.join(dir, "state.js"), "module.exports={n:0};\n");
		const script = path.join(dir, "counter.js");
		fs.writeFileSync(
			script,
			'const s=require("./state.js");s.n+=1;' +
				'require("node:fs").writeSync(1,String(s.n));\n',
		);
		expect(runInProcess(script).stdout).toBe("1");
		expect(runInProcess(script).stdout).toBe("1");
	});

	it("takes off every process listener the script registered", () => {
		const before = {
			uncaught: process.listenerCount("uncaughtException"),
			signal: process.listenerCount("SIGUSR2"),
		};
		runInProcess(PROBE, ["add-listener"]);
		runInProcess(PROBE, ["add-listener"]);
		expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
		expect(process.listenerCount("SIGUSR2")).toBe(before.signal);
	});

	it("restores every global it patched", () => {
		const before = {
			cwd: process.cwd(),
			argv: process.argv,
			exit: process.exit,
			writeSync: fs.writeSync,
			stdout: process.stdout.write,
			stderr: process.stderr.write,
			readFileSync: fs.readFileSync,
			console: globalThis.console,
			exitCode: process.exitCode,
			mainModule: process.mainModule,
			env: { ...process.env },
		};
		const r = runInProcess(PROBE, ["streams"], {
			cwd: tmpdir(),
			env: { PROBE: "x", CARRIED: "y" },
			stdin: "unused",
		});
		expect(process.cwd()).toBe(before.cwd);
		expect(process.argv).toBe(before.argv);
		expect(process.exit).toBe(before.exit);
		expect(fs.writeSync).toBe(before.writeSync);
		expect(process.stdout.write).toBe(before.stdout);
		expect(process.stderr.write).toBe(before.stderr);
		expect(r.restoreFailures).toEqual([]);
		expect(fs.readFileSync).toBe(before.readFileSync);
		expect(globalThis.console).toBe(before.console);
		expect(process.exitCode).toBe(before.exitCode);
		expect(process.mainModule).toBe(before.mainModule);
		expect({ ...process.env }).toEqual(before.env);
	});

	it("restores them after a script that threw, not only a clean one", () => {
		const exit = process.exit;
		const writeSync = fs.writeSync;
		runInProcess(PROBE, ["throw"]);
		expect(process.exit).toBe(exit);
		expect(fs.writeSync).toBe(writeSync);
	});

	it("refuses a re-entrant call rather than interleaving two captures", () => {
		const nested = path.join(tmpdir(), "nested.js");
		fs.writeFileSync(
			nested,
			`require(${JSON.stringify(path.resolve(__dirname, "run-in-process.js"))})` +
				`.runInProcess(${JSON.stringify(PROBE)}, ["cwd"]);\n`,
		);
		const r = runInProcess(nested);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not re-entrant");
	});

	it("leaves a write to any other fd alone", () => {
		const file = path.join(tmpdir(), "out.txt");
		const fd = fs.openSync(file, "w");
		const script = path.join(tmpdir(), "fd.js");
		fs.writeFileSync(
			script,
			`require("node:fs").writeSync(${fd}, "elsewhere");\n`,
		);
		runInProcess(script);
		fs.closeSync(fd);
		expect(fs.readFileSync(file, "utf8")).toBe("elsewhere");
	});
});

describe("runInProcessAsync", () => {
	it("awaits the exported main rather than returning before it starts", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["exit", "3"]);
		expect(r.status).toBe(3);
		expect(r.stdout).toBe("before exit\n");
	});

	it("captures a rejection the way node reports an escaping throw", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["reject"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("probe rejected");
	});

	it("hands a rejection to a script's own uncaughtException listener instead of its require.main tail (mantahostels#1996)", async () => {
		// pick-next.js's actual shape: it requires lib/gh.js, which requires
		// lib/check.js, which installs an uncaughtException listener at require
		// time. That listener — not the never-invoked
		// `main().catch((e) => { … process.exit(1) })` tail — is what a rejected
		// main() reaches here, and it reports BROKEN/exit 2, not FAILED/exit 1.
		const r = await runInProcessAsync(ASYNC_PROBE, ["reject-with-listener"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("probe rejected");
		expect(r.stderr).not.toContain("FAILED:");
	});

	it("refuses a script with no require.main guard, before it can run for real", async () => {
		// wayfinder-frontier.js's shape: an unconditional top-level call would
		// otherwise fire, unawaited, the moment entry.load reaches it — before
		// this seam ever looks for an export.
		await expect(runInProcessAsync(UNGUARDED_PROBE)).rejects.toThrow(
			/carries no "require.main" guard/,
		);
	});

	it("keeps output in order across an await inside main", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["ordered"]);
		expect(r.stdout).toBe("first\nsecond\n");
	});

	it("cannot make require.main === module true inside main — a documented gap", async () => {
		// Why this reads false rather than true: run-in-process.js's
		// runInProcessAsync header.
		const r = await runInProcessAsync(ASYNC_PROBE, ["entry-module"]);
		expect(r.stdout).toBe("false\n");
	});

	it("never lets the script's own require.main-gated tail run main a second time", async () => {
		// If the auto-invoke also fired, "ran once" would be written twice.
		const r = await runInProcessAsync(ASYNC_PROBE, ["ran"]);
		expect(r.stdout).toBe("ran once\n");
	});

	it("refuses a script with no exported main, as a harness misuse", async () => {
		await expect(runInProcessAsync(PROBE, ["cwd"])).rejects.toThrow(
			/exports no "main" function/,
		);
	});

	it("restores every global it patched, same as the sync seam", async () => {
		const before = {
			cwd: process.cwd(),
			exit: process.exit,
			mainModule: process.mainModule,
			env: { ...process.env },
		};
		const r = await runInProcessAsync(ASYNC_PROBE, ["exit", "0"], {
			cwd: tmpdir(),
			env: { PROBE: "x" },
		});
		expect(process.cwd()).toBe(before.cwd);
		expect(process.exit).toBe(before.exit);
		expect(process.mainModule).toBe(before.mainModule);
		expect({ ...process.env }).toEqual(before.env);
		expect(r.restoreFailures).toEqual([]);
	});

	// Pins the default against the ceiling it derives from (why: run-in-process.js's
	// DEFAULT_STALE_MS header). Both sides read scripts/lib/test-ceiling.js, so
	// a future ceiling change can't leave this behind it.
	it("reads a claim as live until the test ceiling plus a 5s margin has passed (mantahostels#2254, mantahostels#2262, mantahostels#2267)", async () => {
		const t0 = Date.now();
		// No real seam reaches a claim 95 s old: the claim reads Date.now, and
		// waiting that long would outlast the suite's own ceiling.
		const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "50"]);
		try {
			clock.mockReturnValue(t0 + TEST_TIMEOUT_MS + 4999);
			await expect(
				runInProcessAsync(ASYNC_PROBE, ["exit", "0"]),
			).rejects.toThrow(/not re-entrant/);
			clock.mockReturnValue(t0 + TEST_TIMEOUT_MS + 5000);
			const r = await runInProcessAsync(ASYNC_PROBE, ["exit", "0"]);
			expect(r.status).toBe(0);
		} finally {
			clock.mockRestore();
			await abandoned;
		}
	});

	it("still refuses a genuinely concurrent async call regardless of staleMs (mantahostels#2254)", async () => {
		const first = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "30"]);
		// The default staleMs applies.
		await expect(runInProcessAsync(ASYNC_PROBE, ["exit", "0"])).rejects.toThrow(
			/not re-entrant/,
		);
		await first;
	});

	it("takes over a claim abandoned past staleMs, rather than refusing the next call (mantahostels#2254)", async () => {
		// Simulates what a vitest test timeout leaves behind: nothing here
		// cancels the promise below, so its claim stays live — held by an
		// `await` that is still pending.
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "50"]);
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await expect(
				runInProcessAsync(ASYNC_PROBE, ["exit", "0"]),
			).rejects.toThrow(/not re-entrant/);

			const r = await runInProcessAsync(ASYNC_PROBE, ["exit", "0"], {
				staleMs: 10,
			});
			expect(r.status).toBe(0);
		} finally {
			await abandoned; // let it settle so it cannot leak into a later case
		}
	});

	it("does not let an abandoned claim's late settle clobber the call that took it over (mantahostels#2254)", async () => {
		// "delay-silent" writes nothing itself, so this isolates whether
		// `abandoned`'s own finally disturbs `takenOver` from whatever
		// `abandoned`'s script writes while it is still running.
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "30"]);
		await new Promise((resolve) => setTimeout(resolve, 15));
		// Still running when `abandoned` settles at ~30ms: its own finally
		// must not restore over these patches out from under it, or
		// `takenOver`'s own later write is lost to the real fd instead of
		// being captured.
		const takenOver = runInProcessAsync(ASYNC_PROBE, ["delay", "120"], {
			staleMs: 5,
		});
		const [, result] = await Promise.all([abandoned, takenOver]);
		expect(result.stdout).toBe("delayed done\n");
		expect(result.restoreFailures).toEqual([]);
	});

	it("runs the stale claim's own restore on takeover, not just clears its slot (mantahostels#2254)", async () => {
		// A takeover that skips this leaves whatever `abandoned` replaced
		// (env, here) standing as
		// the baseline every later call, `takenOver` included, restores back
		// to, rather than the real value from before `abandoned` ran.
		const originalEnv = { ...process.env };
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "30"], {
			env: { ...process.env, WFC_TAKEOVER_PROBE: "abandoned" },
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 15));
			const takenOver = await runInProcessAsync(ASYNC_PROBE, ["exit", "0"], {
				staleMs: 5,
			});
			expect(takenOver.status).toBe(0);
			expect(process.env.WFC_TAKEOVER_PROBE).toBeUndefined();
		} finally {
			await abandoned;
		}
		expect({ ...process.env }).toEqual(originalEnv);
	});
});
