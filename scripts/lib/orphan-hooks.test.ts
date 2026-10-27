// @vitest-environment node
/*
 * Pins lib/orphan-hooks.js's judgement — which processes are orphaned hook
 * runs and what each kill takes — against synthetic process tables, and its
 * kill against a real orphaned guard whose forked subshell outlives it
 * (#2922).
 *
 * Loosen a case and either a live hook, a deliberately detached sweep or a
 * neighbour's process is SIGKILLed, or a spinning orphan times out every
 * session's hooks unnamed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOrphanHooks, killReaps, readRegistry } from "./orphan-hooks.js";
import { makeProcRoot, statLine } from "./proc-fake";
import { readProcTable, readUptime, USER_HZ } from "./proc-table.js";
import {
	isGroupDead,
	orphansReapToInit,
	startOrphan,
	waitFor,
} from "./process-fixture";

const BOOT_AGO = 100_000;
const GUARD = "/repo/scripts/guard-cpu-load.sh";

type Proc = import("./proc-table.js").Proc;

const hooks = {
	PreToolUse: [
		{
			hooks: [
				{
					type: "command",
					command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-cpu-load.sh',
					timeout: 10,
				},
				{
					type: "command",
					command:
						'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/audit-escape-lines.js --notify || true',
				},
			],
		},
	],
};
const { invocations, ceilingS } = readRegistry(hooks);

function proc(
	pid: number,
	argv: string | string[],
	{ ppid = 1, pgid = pid, ageS = 3600 } = {},
): Proc {
	return {
		pid,
		ppid,
		pgid,
		startTicks: Math.round((BOOT_AGO - ageS) * USER_HZ),
		argv: Array.isArray(argv) ? argv : argv.split(" "),
	};
}

function find(procs: Proc[], mine = new Set<number>([999_999])) {
	return findOrphanHooks(new Map(procs.map((p) => [p.pid, p])), {
		invocations,
		ceilingS,
		bootAgo: BOOT_AGO,
		mine,
	});
}

const targetsOf = (r: { targets: Proc[] }) =>
	r.targets.map((t) => t.pid).sort((a, b) => a - b);

describe("readRegistry", () => {
	it("takes the longest timeout, a hook with none at Claude Code's 600 s default, plus the margin", () => {
		expect(ceilingS).toBe(660);
		expect(
			readRegistry({
				X: [{ hooks: [{ command: "scripts/a.sh", timeout: 10 }] }],
			}).ceilingS,
		).toBe(70);
	});

	it("reads each command's script and its own arguments, stopping at the shell's operators", () => {
		expect(invocations).toEqual([
			{ script: "guard-cpu-load.sh", args: [] },
			{ script: "audit-escape-lines.js", args: ["--notify"] },
		]);
	});
});

describe("findOrphanHooks", () => {
	it("takes an orphaned guard's forked subshells, whose group leader is gone, as one group (#2922)", () => {
		const { reaps } = find([
			proc(201, `bash ${GUARD}`, { pgid: 100 }),
			proc(202, `bash ${GUARD}`, { pgid: 100 }),
			proc(203, "sleep 1", { ppid: 202, pgid: 100 }),
		]);
		expect(reaps).toHaveLength(1);
		expect(reaps[0]?.scope).toBe("group");
		expect(targetsOf(reaps[0] as { targets: Proc[] })).toEqual([201, 202, 203]);
	});

	it("takes a group leader's whole group", () => {
		const { reaps } = find([
			proc(300, `/bin/bash ${GUARD}`),
			proc(301, "node x.js", { ppid: 999, pgid: 300 }),
		]);
		expect(reaps).toHaveLength(1);
		expect(reaps[0]?.scope).toBe("group");
		expect(targetsOf(reaps[0] as { targets: Proc[] })).toEqual([300, 301]);
	});

	it("takes only the orphan's own tree from a group that holds anything else", () => {
		const { reaps } = find([
			proc(400, "node harness.js", { ppid: 50 }),
			proc(401, `bash ${GUARD}`, { pgid: 400 }),
			proc(402, "sleep 1", { ppid: 401, pgid: 400 }),
		]);
		expect(reaps[0]?.scope).toBe("tree");
		expect(targetsOf(reaps[0] as { targets: Proc[] })).toEqual([401, 402]);
	});

	it("matches a compound hook command running as `sh -c`", () => {
		const { reaps } = find([
			proc(500, [
				"/bin/sh",
				"-c",
				'command -v node >/dev/null 2>&1 && node "/repo"/scripts/audit-escape-lines.js --notify || true',
			]),
		]);
		expect(reaps.map((r) => r.pid)).toEqual([500]);
	});

	it("reads WSL's session /init and a systemd as init", () => {
		const { reaps } = find([
			proc(352, "/init", { ppid: 1 }),
			proc(600, `bash ${GUARD}`, { ppid: 352 }),
			proc(700, "/lib/systemd/systemd --user", { ppid: 1 }),
			proc(701, `bash ${GUARD}`, { ppid: 700 }),
		]);
		expect(reaps.map((r) => r.pid).sort()).toEqual([600, 701]);
	});

	it("never touches a hook whose Claude process still parents it", () => {
		const { reaps } = find([
			proc(800, "claude", { ppid: 1 }),
			proc(801, `bash ${GUARD}`, { ppid: 800 }),
		]);
		expect(reaps).toEqual([]);
	});

	it("never touches a hook run inside the ceiling, and counts it", () => {
		const { reaps, young } = find([
			proc(900, `bash ${GUARD}`, { ageS: ceilingS - 1 }),
		]);
		expect(reaps).toEqual([]);
		expect(young).toBe(1);
	});

	it("takes any orphaned guard by path, registered or not and whatever its arguments (#2922)", () => {
		const { reaps } = find([
			proc(1300, "bash /old/checkout/scripts/guard-retired.sh --probe x"),
			proc(1301, [
				"/bin/sh",
				"-c",
				'node "/repo"/scripts/guard-other.js --flag',
			]),
		]);
		expect(reaps.map((r) => r.pid).sort()).toEqual([1300, 1301]);
	});

	it("spares a hook script's detached child, whose arguments are not the registered ones", () => {
		const { reaps } = find([
			proc(
				1000,
				"node /repo/scripts/audit-escape-lines.js --judge --root /repo",
			),
			proc(1002, "node /repo/scripts/not-a-hook.js"),
		]);
		expect(reaps).toEqual([]);
	});

	it("never matches or kills its own process tree", () => {
		const { reaps } = find(
			[
				proc(1100, `bash ${GUARD}`),
				proc(1101, "node reap-orphan-hooks.js", { ppid: 1100, pgid: 1100 }),
				proc(1200, `bash ${GUARD}`, { pgid: 1300 }),
				proc(1201, "node mine.js", { ppid: 50, pgid: 1300 }),
			],
			new Set([1100, 1101, 1201]),
		);
		expect(reaps).toHaveLength(1);
		expect(reaps[0]?.scope).toBe("tree");
		expect(targetsOf(reaps[0] as { targets: Proc[] })).toEqual([1200]);
	});
});

describe("killReaps", () => {
	let fake: ReturnType<typeof makeProcRoot>;
	afterEach(() => fake.remove());

	it("kills by pgid when every target holds its start time, else each that does, and logs the reap", () => {
		fake = makeProcRoot();
		const stat = (pid: number, startTicks: number) =>
			fake.proc(pid, { stat: statLine(pid, { startTicks }) });
		const group = proc(10, `bash ${GUARD}`);
		const recycled = proc(20, `bash ${GUARD}`);
		const child = proc(21, "sleep 1", { ppid: 20, pgid: 20 });
		stat(10, group.startTicks);
		stat(20, 1);
		stat(21, child.startTicks);

		const kills: number[] = [];
		const lines: Record<string, unknown>[] = [];
		const done = killReaps(
			[
				{
					pid: 10,
					pgid: 10,
					scope: "group",
					ageS: 3600,
					argv: group.argv,
					targets: [group],
				},
				{
					pid: 20,
					pgid: 20,
					scope: "group",
					ageS: 3600,
					argv: recycled.argv,
					targets: [recycled, child],
				},
			],
			{
				root: fake.root,
				kill: (pid) => kills.push(pid),
				log: (e) => lines.push(e) > 0,
			},
		);

		expect(kills).toEqual([-10, 21]);
		expect(done.map((d) => d.killed)).toEqual([[10], [21]]);
		expect(lines[1]).toMatchObject({
			pid: 20,
			scope: "group",
			gone: 1,
			killed: [21],
			argv: `bash ${GUARD}`,
			byPgid: false,
			targets: [{ pid: 21, argv: "sleep 1" }],
		});
		expect(lines[0]).toMatchObject({ byPgid: true, killed: [10] });
	});
});

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
		"is killed with the subshell it forked (#2922)",
		() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-hooks-real-"));
			const name = `guard-reap-fixture-${process.pid}.sh`;
			const script = path.join(dir, "scripts", name);
			fs.mkdirSync(path.dirname(script));
			fs.writeFileSync(script, "( while :; do sleep 1; done ) &\nsleep 300\n");
			pid = startOrphan(script);
			const forked = () =>
				[...(readProcTable("/proc")?.procs.values() ?? [])].some(
					(p) => p.pgid === pid && p.pid !== pid && p.argv[0] === "bash",
				);
			expect(waitFor(forked)).toBe(true);

			const { reaps } = findOrphanHooks(
				readProcTable("/proc")?.procs ?? new Map(),
				{
					invocations: readRegistry({
						X: [{ hooks: [{ command: `scripts/${name}` }] }],
					}).invocations,
					ceilingS: 0,
					bootAgo: readUptime("/proc") ?? 0,
					mine: new Set([process.pid, process.ppid]),
				},
			);
			expect(reaps.map((r) => [r.pid, r.scope])).toEqual([[pid, "group"]]);
			expect(reaps[0]?.targets.length).toBeGreaterThanOrEqual(2);

			killReaps(reaps, {
				root: "/proc",
				kill: (p, s) => process.kill(p, s),
				log: () => true,
			});
			expect(waitFor(() => isGroupDead(pid))).toBe(true);
		},
	);
});
