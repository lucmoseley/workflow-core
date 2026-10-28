// @vitest-environment node
/* A test run's pids-capped scope (#3401). */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	probeUserScope,
	spawnInRunScope,
	endRunScope,
	hasOwnScopeHitCap,
} = require("./user-scope.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const scratch = () => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "uscope-")),
	);
	dirs.push(dir);
	return dir;
};

const exited = (child: ReturnType<typeof spawnInRunScope>) =>
	new Promise<string>((done) => {
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk;
		});
		child.on("exit", () => done(out));
	});

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("a test run's scope", () => {
	it("reads no cap hit outside a test-run scope", () => {
		expect(hasOwnScopeHitCap()).toBe(false);
	});

	it.skipIf(probeUserScope().length === 0)(
		"tells the process inside it, and the wrapper, that it refused a fork at the cap",
		async () => {
			const dir = scratch();
			const inside = path.join(dir, "inside.js");
			/* node alone holds ~11 tasks in threads; 32 leaves room for it and
			 * then refuses the sleeps. */
			fs.writeFileSync(
				inside,
				`const { spawn } = require("node:child_process");
const { hasOwnScopeHitCap } = require(${JSON.stringify(path.join(__dirname, "user-scope.js"))});
let left = 64;
const next = () => {
	const c = spawn("sleep", ["30"], { stdio: "ignore" });
	c.on("error", () => { process.stdout.write(String(hasOwnScopeHitCap())); process.exit(0); });
	c.on("spawn", () => (--left > 0 ? next() : process.exit(0)));
};
next();
`,
			);
			const child = spawnInRunScope(process.execPath, [inside], {
				stdio: ["ignore", "pipe", "inherit"],
				env: { ...process.env, WFC_RUN_TASKS_MAX: "32" },
			});
			const out = await exited(child);

			expect(out).toBe("true");
			expect(endRunScope(child)).toContain("cap at 32 tasks");
		},
	);

	it.skipIf(probeUserScope().length === 0)(
		"kills what a child left behind though the child exited before it was seen in its scope",
		async () => {
			const dir = scratch();
			const left = path.join(dir, "left.sh");
			fs.writeFileSync(left, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
			const child = spawnInRunScope("setsid", ["-f", left], {
				stdio: "ignore",
			});
			await exited(child);
			const running = () =>
				spawnSync("pgrep", ["-f", left], { encoding: "utf8" }).stdout.trim();

			expect(endRunScope(child)).toBeNull();
			/* SIGKILL lands asynchronously; 5 s is a guess. */
			for (let i = 0; i < 50 && running(); i++) await pause(100);
			expect(running()).toBe("");
		},
	);
});
