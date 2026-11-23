// @vitest-environment node

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
	it("reports an escaping throw as node does — exit 1, stack on stderr", () => {
		const r = runInProcess(PROBE, ["throw"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("probe threw");
		expect(r.stderr).toContain("in-process-probe.js");
	});

	it("calls back a stream write in both its callback forms", () => {
		const r = runInProcess(PROBE, ["write-callbacks"]);
		expect([r.status, r.stdout]).toEqual([4, "xy"]);
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
		const r = await runInProcessAsync(ASYNC_PROBE, ["reject-with-listener"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("probe rejected");
		expect(r.stderr).not.toContain("FAILED:");
	});

	it("refuses a script with no require.main guard, before it can run for real", async () => {
		await expect(runInProcessAsync(UNGUARDED_PROBE)).rejects.toThrow(
			/carries no "require.main" guard/,
		);
	});

	it("passes main the argv beyond the script name, as a guard tail does", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["main-argv", "x"]);
		expect(r.stdout).toBe('["main-argv","x"]\n');
	});

	it("takes a number main resolves to as the exit status, as a guard tail does", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["returns", "4"]);
		expect(r.status).toBe(4);
	});

	it("keeps output in order across an await inside main", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["ordered"]);
		expect(r.stdout).toBe("first\nsecond\n");
	});

	it("cannot make require.main === module true inside main — a documented gap", async () => {
		const r = await runInProcessAsync(ASYNC_PROBE, ["entry-module"]);
		expect(r.stdout).toBe("false\n");
	});

	it("never lets the script's own require.main-gated tail run main a second time", async () => {
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

	it("reads a claim as live until the test ceiling plus a 5s margin has passed (mantahostels#2254, mantahostels#2262, mantahostels#2267)", async () => {
		const t0 = Date.now();
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
		await expect(runInProcessAsync(ASYNC_PROBE, ["exit", "0"])).rejects.toThrow(
			/not re-entrant/,
		);
		await first;
	});

	it("takes over a claim abandoned past staleMs, rather than refusing the next call (mantahostels#2254)", async () => {
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
			await abandoned;
		}
	});

	it("does not let an abandoned claim's late settle clobber the call that took it over (mantahostels#2254)", async () => {
		const abandoned = runInProcessAsync(ASYNC_PROBE, ["delay-silent", "30"]);
		await new Promise((resolve) => setTimeout(resolve, 15));
		const takenOver = runInProcessAsync(ASYNC_PROBE, ["delay", "120"], {
			staleMs: 5,
		});
		const [, result] = await Promise.all([abandoned, takenOver]);
		expect(result.stdout).toBe("delayed done\n");
		expect(result.restoreFailures).toEqual([]);
	});

	it("runs the stale claim's own restore on takeover, not just clears its slot (mantahostels#2254)", async () => {
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
