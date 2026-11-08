// @vitest-environment node
/* A test run's pids-capped scope (#3401). */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSystemdRun } from "./systemd-run-fake";

const require = createRequire(import.meta.url);
const { forgetSession } = require("./session-id.js");
const {
	OUTLIVE_CEILING_S,
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

/*
 * The outliving launch's Node face (#4706), driven in a fresh node so its
 * probe of the user manager is its own, against a stand-in systemd-run that
 * records what reaches it.
 */
describe("the outliving launch", () => {
	function launch(answers: boolean, opts: string) {
		const dir = scratch();
		const rec = path.join(dir, "rec.log");
		const recorder = path.join(dir, "rec.sh");
		fs.writeFileSync(
			recorder,
			`#!/bin/sh\nprintf '%s\\n' "$* sid=\${CLAUDE_CODE_SESSION_ID-} job=\${CLAUDE_JOB_DIR-} owner=\${WFC_REPORT_OWNER-}" >> "${rec}"\n`,
			{ mode: 0o755 },
		);
		const fake = writeSystemdRun(dir, { answers });
		const driver = `const { spawnOutliving } = require(${JSON.stringify(path.join(__dirname, "user-scope.js"))});
spawnOutliving(${JSON.stringify(recorder)}, ["job"], { stdio: "ignore", ...${opts} }).on("exit", () => {});`;
		const r = spawnSync(process.execPath, ["-e", driver], {
			encoding: "utf8",
			env: {
				...process.env,
				WFC_SYSTEMD_RUN: fake.bin,
				CLAUDE_CODE_SESSION_ID: "starter",
				CLAUDE_JOB_DIR: "/the/job",
				WFC_REPORT_OWNER: "inherited",
			},
		});
		expect(r.status, r.stderr).toBe(0);
		return {
			ran: fs.readFileSync(rec, "utf8").trim(),
			scoped: fake.calls().map(({ words, owner }) => ({ words, owner })),
			recorder,
		};
	}

	it("starts the job in a capped user scope, as no session, naming the owner it is given", () => {
		const { ran, scoped } = launch(
			true,
			'{ owner: "starter", ceilingS: 2700 }',
		);
		expect(scoped).toEqual([
			{
				words: "--user --scope --quiet -p RuntimeMaxSec=2700 --",
				owner: "starter",
			},
		]);
		expect(ran).toBe("job sid= job= owner=starter");
	});

	it("starts it unscoped, still stripped and owner-tagged, where no manager answers", () => {
		const { ran, scoped } = launch(
			false,
			'{ owner: "starter", ceilingS: 2700 }',
		);
		expect(scoped).toEqual([]);
		expect(ran).toBe("job sid= job= owner=starter");
	});

	/* lib/detach.sh's `outlive` is this face's twin: drift, and the shell
	 * launcher's jobs keep a key the sweep reads as a session's. */
	it("strips the same keys and stops at the same ceiling as its shell twin", () => {
		const r = spawnSync(
			"bash",
			[
				"-c",
				`source "$1"; printf "%s\\n" "\${OUTLIVE_STRIPPED[*]}" "$OUTLIVE_CEILING_S"`,
				"_",
				path.join(__dirname, "detach.sh"),
			],
			{ encoding: "utf8" },
		);
		const [shellKeys = "", shellCeiling] = r.stdout.trim().split("\n");
		const stripped = shellKeys.split(" ");
		const env: Record<string, string> = { ...process.env, CLAUDE_PID: "1" };
		for (const key of [
			...stripped,
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_JOB_DIR",
			"WFC_REPORT_OWNER",
		])
			env[key] = "x";
		const before = Object.keys(env);
		forgetSession(env);
		expect(before.filter((k) => !(k in env)).sort()).toEqual(
			[...stripped].sort(),
		);
		expect(stripped).toContain("WFC_REPORT_OWNER");
		expect(shellCeiling).toBe(String(OUTLIVE_CEILING_S));
	});

	it("names no owner and sets no ceiling where it is given neither", () => {
		const { ran, scoped } = launch(true, "{}");
		expect(scoped).toEqual([{ words: "--user --scope --quiet --", owner: "" }]);
		expect(ran).toBe("job sid= job= owner=");
	});
});
