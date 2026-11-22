// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keptSpawn } from "./kept-spawn.js";

const { runGrouped } = require("./grouped-child.js");

const LIB = path.resolve(__dirname, "grouped-child.js");

// guess, #2677
const HUNG_CAP_MS = 15_000;
// guess, #2677
const REAP_WAIT_MS = 20_000;
const REAP_POLL_MS = 100;

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "grouped-child-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const hungStub = (pgidFile: string) => {
	const stub = path.join(home, "hung.js");
	fs.writeFileSync(
		stub,
		`const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pgidFile)}, String(process.pid));
setTimeout(() => {}, 120000);
`,
	);
	return stub;
};

const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw e;
	}
};

const groupGone = async (pgid: number) => {
	const until = Date.now() + REAP_WAIT_MS;
	while (groupAlive(pgid) && Date.now() < until)
		await new Promise((r) => setTimeout(r, REAP_POLL_MS));
	return !groupAlive(pgid);
};

const opts = (over: Record<string, unknown> = {}) => ({
	cwd: home,
	env: process.env,
	timeoutMs: HUNG_CAP_MS,
	maxBuffer: 1e6,
	...over,
});

describe("a grouped child", () => {
	it("returns what a run that finishes printed, and its exit", async () => {
		const run = await runGrouped(
			process.execPath,
			["-e", "process.stdout.write('ok'); process.stderr.write('e\\n')"],
			opts(),
		);
		expect(run).toEqual({
			code: 0,
			signal: null,
			stdout: "ok",
			stderr: "e\n",
			killedFor: null,
			killedCode: null,
			unkilled: null,
			spawnCode: null,
		});
	});

	it("names the spawn code of a file that will not start", async () => {
		const run = await runGrouped(path.join(home, "no-such-file"), [], opts());
		expect(run.spawnCode).toBe("ENOENT");
		expect(run.code).toBeNull();
	});

	it("past its cap, settles timed out and kills the whole group, the grandchild with it", async () => {
		const pgidFile = path.join(home, "pgid");
		const run = await runGrouped(
			process.execPath,
			[hungStub(pgidFile)],
			opts(),
		);
		expect(run.killedFor).toBe(`timed out after ${HUNG_CAP_MS / 1000} s`);
		expect(await groupGone(Number(fs.readFileSync(pgidFile, "utf8")))).toBe(
			true,
		);
	});

	it("past its output cap, is killed rather than read on", async () => {
		const run = await runGrouped(
			process.execPath,
			[
				"-e",
				"process.stdout.write('x'.repeat(1000)); setTimeout(() => {}, 120000)",
			],
			opts({ maxBuffer: 100 }),
		);
		expect(run.killedFor).toBe("stdout past 100 bytes");
	});

	it("dies with a caller that exits while it runs", async () => {
		const pgidFile = path.join(home, "pgid");
		const caller = path.join(home, "caller.js");
		fs.writeFileSync(
			caller,
			`const { runGrouped } = require(${JSON.stringify(LIB)});
runGrouped(process.execPath, [${JSON.stringify(hungStub(pgidFile))}], {
	cwd: ${JSON.stringify(home)}, env: process.env, timeoutMs: 600000, maxBuffer: 1e6,
});
const wait = setInterval(() => {
	if (require("node:fs").existsSync(${JSON.stringify(pgidFile)})) process.exit(0);
}, 50);
`,
		);
		keptSpawn("concurrent").execFileSync(process.execPath, [caller], {
			stdio: "ignore",
		});
		expect(await groupGone(Number(fs.readFileSync(pgidFile, "utf8")))).toBe(
			true,
		);
	});
});
