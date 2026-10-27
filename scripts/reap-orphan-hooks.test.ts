// @vitest-environment node
/*
 * Pins reap-orphan-hooks.js end to end against a synthetic /proc on
 * WFC_PROC_ROOT (lib/proc-fake.ts) and the core's real hook registry: it
 * names an orphaned hook run past the ceiling, leaves one inside it alone,
 * kills nothing under a fixture root, degrades to SKIP where /proc or its
 * uptime cannot be read, and is BROKEN on a hook file it cannot parse
 * (#2922).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRunningHooks } from "./lib/core-hooks.js";
import { readRegistry } from "./lib/orphan-hooks.js";
import { makeProcRoot } from "./lib/proc-fake";
import { readProcTable, USER_HZ } from "./lib/proc-table.js";
import {
	isGroupDead,
	orphansReapToInit,
	startOrphan,
	waitFor,
} from "./lib/process-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "reap-orphan-hooks.js");
const { ceilingS, invocations } = readRegistry(
	JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "..", "self-plugin/hooks/hooks.json"),
			"utf8",
		),
	).hooks,
);
/* A guard the registry runs with no arguments, from some other checkout. */
const guard = invocations.find(
	(i) => i.script.startsWith("guard-") && i.args.length === 0,
);
const GUARD = `node /elsewhere/scripts/${guard?.script}`;

let fixture: ReturnType<typeof makeProcRoot>;

beforeEach(() => {
	fixture = makeProcRoot();
});

afterEach(() => {
	fixture.remove();
});

function run(
	args: string[] = ["--json"],
	env: Record<string, string> = { WFC_PROC_ROOT: fixture.root },
	cwd?: string,
) {
	return runInProcess(SCRIPT, args, {
		env: { ...process.env, ...env },
		...(cwd ? { cwd } : {}),
	});
}

function json(env?: Record<string, string>) {
	const res = run(["--json"], env);
	return {
		status: res.status,
		...(JSON.parse(res.stdout) as {
			outcome: string;
			summary: string;
			reaps: { pid: number; scope: string; killed: number[] }[];
			young: number;
			ceilingS: number;
		}),
	};
}

describe("reap-orphan-hooks", () => {
	it("names an orphaned guard past the ceiling, and kills nothing under a fixture root", () => {
		fixture.proc(4242, { argv: GUARD, ageS: ceilingS + 1 });

		const out = json();

		expect(out.status).toBe(0);
		expect(out.outcome).toBe("WARN");
		expect(out.ceilingS).toBe(ceilingS);
		expect(out.reaps).toEqual([
			expect.objectContaining({ pid: 4242, scope: "group", killed: [] }),
		]);
	});

	it("reports on stdout under --notify, the channel its SessionStart registration reads", () => {
		fixture.proc(4242, { argv: GUARD, ageS: ceilingS + 1 });

		const res = run(["--notify"]);

		expect(res.status).toBe(0);
		expect(res.stdout).toContain("ORPHAN-HOOK (1)");
		expect(res.stdout).toContain("pid 4242");
		expect(res.stdout).toContain("nothing was killed or logged");
	});

	it("leaves a hook run inside the ceiling alone, and says nothing under --notify", () => {
		fixture.proc(4243, { argv: GUARD, ageS: ceilingS - 1 });

		const out = json();

		expect(out.outcome).toBe("OK");
		expect(out.young).toBe(1);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("skips, never all-clear, where /proc will not list", () => {
		const out = json({ WFC_PROC_ROOT: path.join(fixture.root, "absent") });

		expect(out.status).toBe(0);
		expect(out.outcome).toBe("SKIP");
		expect(out.summary).toContain("could not be enumerated");
	});

	it("skips where /proc lists pids of which not one reads, the hidepid shape", () => {
		fs.mkdirSync(path.join(fixture.root, "4244"));

		const out = json();

		expect(out.outcome).toBe("SKIP");
		expect(out.summary).toContain("not one of them would read");
	});

	it("skips, killing nothing, where uptime will not read", () => {
		fixture.proc(4242, { argv: GUARD, ageS: ceilingS + 1 });
		fs.rmSync(path.join(fixture.root, "uptime"));

		const out = json();

		expect(out.status).toBe(0);
		expect(out.outcome).toBe("SKIP");
		expect(out.summary).toContain("no process's age can be derived");
	});

	it("is BROKEN, never all-clear, where a hook file will not parse", () => {
		const host = fs.mkdtempSync(path.join(os.tmpdir(), "reap-broken-host-"));
		try {
			fs.mkdirSync(path.join(host, ".claude"));
			fs.writeFileSync(path.join(host, ".claude", "settings.json"), "{");

			const out = json({
				WFC_PROC_ROOT: fixture.root,
				CLAUDE_PROJECT_DIR: host,
			});

			expect(out.status).toBe(2);
			expect(out.outcome).toBe("BROKEN");
			expect(out.summary).toContain("settings.json is not valid JSON");
		} finally {
			fs.rmSync(host, { recursive: true, force: true });
		}
	});
});

/* The real kill and log, against a fake root that links in only this test's
 * orphan, so no other process on the machine is in its table. */
describe("a real orphaned guard", () => {
	let dir: string;
	let pid = 0;
	afterEach(() => {
		if (pid && !isGroupDead(pid))
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* gone */
			}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it.runIf(orphansReapToInit())(
		"is killed with its group and logged in the canonical checkout's markers",
		() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-orphan-hooks-real-"));
			spawnSync("git", ["init", "-q", dir]);
			fs.mkdirSync(path.join(dir, ".claude"));
			/* Registered, not a guard: any guard-* orphan is reaped by name, so
			 * orphan-hooks.test.ts's real case would take this one too. */
			const name = `reap-fixture-${process.pid}.sh`;
			fs.writeFileSync(
				path.join(dir, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{ hooks: [{ type: "command", command: `bash scripts/${name}` }] },
						],
					},
				}),
			);
			const script = path.join(dir, "scripts", name);
			fs.mkdirSync(path.dirname(script));
			fs.writeFileSync(script, "sleep 300\n");
			pid = startOrphan(script);
			/* Until setsid execs, its argv is no hook run's. */
			expect(
				waitFor(
					() => readProcTable("/proc")?.procs.get(pid)?.argv[0] === "bash",
				),
			).toBe(true);

			/* A machine up long enough that the orphan is past the ceiling of
			 * the registry this run reads: an adopter's, not the core's. */
			const live = readProcTable("/proc")?.procs ?? new Map();
			const start = live.get(pid)?.startTicks ?? 0;
			const adopter = readRegistry(readRunningHooks(dir, { quiet: true }));
			const fake = makeProcRoot(start / USER_HZ + adopter.ceilingS + 1);
			try {
				for (const p of live.values()) if (p.pgid === pid) fake.real(p.pid);
				/* WSL's session /init, read by argv where it is not pid 1. */
				const ppid = live.get(pid)?.ppid ?? 0;
				if (ppid > 1) fake.real(ppid);

				const res = run(
					["--json"],
					{
						WFC_PROC_ROOT: fake.root,
						WFC_REAP_FAKE_ROOT: "kill",
						CLAUDE_PROJECT_DIR: dir,
					},
					dir,
				);

				expect(res.status).toBe(0);
				expect(waitFor(() => isGroupDead(pid))).toBe(true);
			} finally {
				fake.remove();
			}
			const log = path.join(
				dir,
				".claude/tmp/markers/.orphan-hook-reaps.jsonl",
			);
			const lines = fs
				.readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(lines).toEqual([
				expect.objectContaining({
					pid,
					pgid: pid,
					scope: "group",
					byPgid: true,
					killed: expect.arrayContaining([pid]),
				}),
			]);
		},
	);
});
