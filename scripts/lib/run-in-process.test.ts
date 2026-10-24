// @vitest-environment node
/*
 * Pins that runInProcess hands a script what a real process would — exit
 * code, both streams, cwd, env, stdin, argv, a fresh module state — and
 * restores every global it patched.
 *
 * The only tests the seam has. Five suites now run every case through
 * scripts/lib/run-in-process.js, so a hole here is a hole under all of them —
 * which is why most cases below assert parity against a real spawn of the same
 * fixture rather than against a hand-written expectation (mantahostels#1907).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** The same call through a real `node`, for the parity assertions. */
const spawned = (
	args: string[],
	options: Parameters<typeof runInProcess>[2] = {},
) => {
	const r = spawnSync(process.execPath, [PROBE, ...args], {
		encoding: "utf8",
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv,
	});
	// restoreFailures is empty on a real spawn by definition: there is nothing
	// in this process to put back.
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
});

describe("runInProcess", () => {
	it("returns the code the script exits with, and what it printed first", () => {
		const r = runInProcess(PROBE, ["exit", "3"]);
		expect(r.status).toBe(3);
		expect(r.stdout).toBe("before exit\n");
		expect(r).toEqual(spawned(["exit", "3"]));
	});

	it("lets nothing take back an exit the script has already asked for", () => {
		// runCheck catches everything spec.run() throws, and
		// `check-guard-registry.js --review` exits from inside it. A real process
		// was gone before that catch ever ran.
		const r = runInProcess(PROBE, ["exit-in-try"]);
		expect(r.status).toBe(5);
		expect(r.stdout).toBe("before exit\n");
		expect(r).toEqual(spawned(["exit-in-try"]));

		// The same swallow, but returning normally afterwards rather than
		// throwing again: the recorded code is then the only record of the exit.
		const quiet = runInProcess(PROBE, ["exit-swallowed"]);
		expect(quiet.status).toBe(6);
		expect(quiet).toEqual(spawned(["exit-swallowed"]));
	});

	it("returns a bare process.exitCode, set without exiting", () => {
		expect(runInProcess(PROBE, ["exit-code", "4"]).status).toBe(4);
	});

	it("reports an escaping throw as node does — exit 1, stack on stderr", () => {
		const r = runInProcess(PROBE, ["throw"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("probe threw");
		expect(r.stderr).toContain("in-process-probe.js");
	});

	it("captures both write routes on both streams", () => {
		const r = runInProcess(PROBE, ["streams"]);
		expect(r.stdout).toBe("fd1\nstdout-write\nconsole-log\n");
		expect(r.stderr).toBe("fd2\nconsole-error\n");
		expect(r).toEqual(spawned(["streams"]));
	});

	it("runs in the cwd it is given", () => {
		const dir = tmpdir();
		expect(runInProcess(PROBE, ["cwd"], { cwd: dir }).stdout).toBe(`${dir}\n`);
	});

	it("replaces the environment rather than adding to it", () => {
		const r = runInProcess(PROBE, ["env"], {
			env: { PROBE: "set" },
		});
		expect(r.stdout).toBe("set|false\n");
	});

	it("hands cwd and env to the child processes the script spawns", () => {
		const dir = tmpdir();
		const r = runInProcess(PROBE, ["child"], {
			cwd: dir,
			env: { ...process.env, PROBE: "inherited" },
		});
		expect(r.stdout).toBe(`${dir}|inherited\n`);
	});

	it("hands the script its stdin off fd 0, as a hook payload arrives", () => {
		expect(runInProcess(PROBE, ["stdin"], { stdin: '{"a":1}' }).stdout).toBe(
			'{"a":1}\n',
		);
		expect(runInProcess(PROBE, ["stdin-buffer"], { stdin: "raw" }).stdout).toBe(
			"raw\n",
		);
	});

	it("leaves a read of any real file alone while stdin is stubbed", () => {
		const file = path.join(tmpdir(), "real.txt");
		fs.writeFileSync(file, "on disk");
		const r = runInProcess(PROBE, ["read-file", file], { stdin: "ignored" });
		expect(r.stdout).toBe("on disk\n");
	});

	it("passes argv beyond the script name", () => {
		expect(runInProcess(PROBE, ["argv", "one", "two"]).stdout).toBe(
			"argv,one,two\n",
		);
	});

	it("makes the script its own entry module, so require.main === module holds", () => {
		expect(runInProcess(PROBE, ["entry-module"]).stdout).toBe("true\n");
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

	it("hands an uncaught throw to the handler the script registered", () => {
		// Every checker requires lib/check.js, whose uncaughtException listener
		// reports the crash as BROKEN and exits 2. Swallowing the throw here would
		// report a checker's own crash as a plain failure.
		const r = runInProcess(PROBE, ["throw-handled"]);
		expect(r.status).toBe(7);
		expect(r.stderr).toContain("handled: probe threw");
		expect(r).toEqual(spawned(["throw-handled"]));
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
		// Reached through a fixture that calls back into the seam: the guard
		// exists for a caller running two of these at once.
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
	// a future ceiling change can't leave this behind it the way mantahostels#2262 left
	// the old bare 2000 (mantahostels#2267).
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
		// No staleMs override: the claim above is microseconds old, nowhere
		// near even the default (TEST_TIMEOUT_MS plus a 5s margin).
		await expect(runInProcessAsync(ASYNC_PROBE, ["exit", "0"])).rejects.toThrow(
			/not re-entrant/,
		);
		await first;
	});

	it("takes over a claim abandoned past staleMs, rather than refusing the next call (mantahostels#2254)", async () => {
		// Simulates what a vitest test timeout leaves behind: nothing here
		// cancels the promise below, so its claim stays live — held by an
		// `await` that is still pending — exactly as an `await main()` a
		// timed-out test abandoned stays pending after that test is marked
		// failed.
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "50"]);
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			// At this same 20ms mark, the default staleMs still reads the
			// claim above as live.
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
