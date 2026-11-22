// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEAKED } from "./fixtures/in-process-probe-modes";
import { keptSpawn } from "./kept-spawn.js";
import { runInProcess, runInProcessAsync } from "./run-in-process";

const PROBE = path.resolve(__dirname, "fixtures/in-process-probe.js");
const ASYNC_PROBE = path.resolve(
	__dirname,
	"fixtures/in-process-async-probe.js",
);

type RunOptions = Parameters<typeof runInProcess>[2];

const spawned = (args: string[], options: RunOptions = {}, script = PROBE) => {
	const r = keptSpawn("boundary").spawnSync(
		process.execPath,
		[script, ...args],
		{
			encoding: "utf8",
			cwd: options.cwd,
			env: options.env as NodeJS.ProcessEnv,
			input: options.stdin,
		},
	);
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
		behaviour: "reads fd 0 empty where no stdin is given (#4072)",
		args: ["stdin"],
	},
	{
		behaviour:
			"reads fd 0 empty through readFdAll where no stdin is given (#4072)",
		args: ["stdin-read-fd"],
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

const SYNC_ONLY: Row[] = [
	{
		behaviour:
			"returns the code the script exits with, and what it printed first",
		args: ["exit", "3"],
	},
	{
		behaviour: "lets nothing take back an exit the script then catches",
		args: ["exit-in-try"],
	},
	{
		behaviour: "keeps an exit the script swallows outright",
		args: ["exit-swallowed"],
	},
	{
		behaviour: "reports an escaping throw as node does",
		args: ["throw"],
		project: errorLine,
	},
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
	{
		behaviour:
			"lets a watcher it closed pass, however long a loop turn stalls (#4108)",
		args: ["close-watcher-stalled"],
	},
];

// guess, #2782
const HANG_MS = 2000;

const hangs = (script: string, mode: string) =>
	new Promise<{ stdout: string; killed: boolean }>((resolve) => {
		keptSpawn("timeout").execFile(
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
		for (const r of await Promise.all(leaks.map(([s, m]) => hangs(s, m))))
			expect(r).toEqual({ stdout: "armed\n", killed: true });

		const refusal = /without ending the process.*Timeout x1/;
		expect(() => runInProcess(PROBE, ["leak-timer"])).toThrow(refusal);
		clearInterval((globalThis as Record<symbol, NodeJS.Timeout>)[LEAKED]);
		expect(() => runInProcess(PROBE, ["leak-then-handled-throw"])).toThrow(
			refusal,
		);
		clearInterval((globalThis as Record<symbol, NodeJS.Timeout>)[LEAKED]);
		await expect(
			runInProcessAsync(ASYNC_PROBE, ["leak-timer"]),
		).rejects.toThrow(refusal);
	});
});

describe("uptime (#4136)", () => {
	const timed = async (run: () => Result | Promise<Result>) => {
		const before = performance.now();
		const r = await run();
		return { r, wallS: (performance.now() - before) / 1000 };
	};
	const readUptime = (r: Result) => {
		expect(r.stderr).not.toContain("unknown mode");
		return Number(r.stdout.trim());
	};

	it.each([
		["spawned", () => spawned(["uptime"])],
		["runInProcess", () => runInProcess(PROBE, ["uptime"])],
		["runInProcessAsync", () => runInProcessAsync(ASYNC_PROBE, ["uptime"])],
	])(
		"%s reads uptime from the call's start, never past its end",
		async (_route, run) => {
			const { r, wallS } = await timed(run);
			const up = readUptime(r);
			expect(up).toBeGreaterThanOrEqual(0);
			expect(up).toBeLessThanOrEqual(wallS);
		},
	);
});
