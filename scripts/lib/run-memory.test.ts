// @vitest-environment node
/*
 * A run's memory record (#5183), sampled off a real process tree: a stand-in
 * vitest main that forks two workers, one holding far more memory. Break it
 * and a memory kill cannot be tied to its launch, nor admission's charges
 * checked against what runs draw.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const memory = require("./run-memory.js");

/* Each child allocates and touches `mb` MiB, prints its pid, then idles. */
const STAND_IN = `
const { fork } = require("node:child_process");
const mb = Number(process.argv[2] ?? 0);
const held = Buffer.alloc(mb * 1024 * 1024, 1);
if (process.argv[3] === "main") {
	const big = fork(__filename, ["96"], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
	const small = fork(__filename, ["8"], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
	let ready = 0;
	for (const c of [big, small]) c.on("message", () => { if (++ready === 2) console.log(JSON.stringify({ big: big.pid, small: small.pid })); });
} else process.send?.("up");
setInterval(() => held[0], 1000);
`;

let dir: string;
let main: ChildProcess | null = null;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-memory-"));
});
afterEach(() => {
	if (main?.pid) {
		try {
			process.kill(-main.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	main = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The stand-in main, once both workers are up, and their pids. */
async function startTree(): Promise<{
	main: number;
	big: number;
	small: number;
}> {
	const script = path.join(dir, "stand-in.js");
	fs.writeFileSync(script, STAND_IN);
	/* spawn-kept: three processes at once, a main and its two forked
	 * workers, whose pids and RSS the sampler reads off the real /proc. */
	main = spawn(process.execPath, [script, "4", "main"], {
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	const line = await new Promise<string>((resolve, reject) => {
		main?.stdout?.once("data", (b: Buffer) => resolve(b.toString()));
		main?.once("exit", () => reject(new Error("stand-in exited")));
	});
	return { main: Number(main.pid), ...JSON.parse(line) };
}

const launch = {
	session: "abcd1234-0000",
	kind: "named",
	argv: ["scripts/a.test.ts"],
	files: ["scripts/a.test.ts"],
	fileCount: 1,
	repo: "workflow-core",
};

describe("startSampler (#5183)", () => {
	it("records the wrapper, main and worker pids, the four peaks and the largest worker's file", async () => {
		const tree = await startTree();
		const store = path.join(dir, "store");
		const sampler = memory.startSampler(
			{ ...launch, main: tree.main },
			{ dir: store, intervalMs: 60_000, bootId: "b-1" },
		);
		memory.claimFile(path.join(dir, "scripts/big.test.ts"), {
			cwd: dir,
			env: { [memory.MEMORY_ENV]: sampler.file },
			pid: tree.big,
		});
		sampler.sample();
		const got = sampler.stop();

		expect(got.pids).toEqual({
			wrapper: process.pid,
			main: tree.main,
			workers: expect.arrayContaining([tree.big, tree.small]),
		});
		expect(got.peaksMiB.worker).toBeGreaterThanOrEqual(90);
		expect(got.peaksMiB.main).toBeGreaterThan(0);
		expect(got.peaksMiB.wrapper).toBeGreaterThan(0);
		expect(got.peaksMiB.sum).toBeGreaterThanOrEqual(
			got.peaksMiB.worker + got.peaksMiB.main,
		);
		expect(got.workerFile).toBe("scripts/big.test.ts");

		const [file] = memory.readRunFiles(store);
		expect(file).toMatchObject({
			...launch,
			bootId: "b-1",
			pids: got.pids,
			endedAt: expect.any(String),
		});
		expect(fs.existsSync(`${sampler.file}.files`)).toBe(false);
		expect(memory.readRunMemory({ [memory.MEMORY_ENV]: sampler.file })).toEqual(
			got,
		);
	});

	it("writes the run's pids at the start, before any sample a kill could cut short", () => {
		const store = path.join(dir, "store");
		const sampler = memory.startSampler(
			{ ...launch, main: 999_999_999 },
			{ dir: store, intervalMs: 60_000, bootId: null },
		);
		const [file] = memory.readRunFiles(store);
		expect(file.pids).toEqual({
			wrapper: process.pid,
			main: 999_999_999,
			workers: [],
		});
		expect(file.endedAt).toBeUndefined();
		sampler.stop();
	});

	it("sweeps a run file older than the retention on the next start", () => {
		const store = path.join(dir, "store");
		fs.mkdirSync(store);
		const old = path.join(store, "1-1.json");
		fs.writeFileSync(old, "{}");
		const past = (Date.now() - memory.RETAIN_MS - 60_000) / 1000;
		fs.utimesSync(old, past, past);
		memory
			.startSampler(
				{ ...launch, main: null },
				{ dir: store, intervalMs: 60_000 },
			)
			.stop();
		expect(fs.existsSync(old)).toBe(false);
		expect(memory.readRunFiles(store)).toHaveLength(1);
	});
});
