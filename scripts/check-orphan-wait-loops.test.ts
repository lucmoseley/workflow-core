// @vitest-environment node
/*
 * Pins that check-orphan-wait-loops.js names a `while`/`until`-and-`sleep`
 * shell reparented to init past its age threshold, with its `kill`, and never
 * this session's own tree.
 *
 * Every test drives the real script end to end through lib/run-in-process.js,
 * against a synthetic /proc tree on WFC_PROC (lib/proc-fake.ts).
 *
 * The fixture shape is the ruling (mantahostels#2017): parent an init (pid 1, or
 * a `/init` at another pid, #3055), an argv carrying a `while`/`until` and a
 * `sleep`, and an elapsed time over the threshold. Nothing
 * here tests boundedness — a bounded loop exits on its own, so elapsed time does
 * that work from the sweep's vantage point.
 *
 * Running in-process is also what makes the own-tree cases testable at all: the
 * check's pid is this test's pid, so a fixture entry can be written for it and
 * for its parent before the run.
 *
 * It is a SessionStart `--notify` hook in .claude/settings.json: loosen a case
 * and a loose loop holds its slot and memory against the 10 GB cap unnamed, or
 * a wait still in progress is handed over to be killed.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeProcRoot, type ProcSpec } from "./lib/proc-fake";
import { USER_HZ } from "./lib/proc-table.js";
import { runInProcess } from "./lib/run-in-process.js";
import { WATCH, watcherArgv } from "./lib/session-scope.js";

const SCRIPT = path.join(__dirname, "check-orphan-wait-loops.js");

const WAIT_LOOP =
	"/bin/bash -c until grep -q '######## T5' out.log; do sleep 3; done";

let fixture: ReturnType<typeof makeProcRoot>;
let root: string;

beforeEach(() => {
	fixture = makeProcRoot();
	root = fixture.root;
});

afterEach(() => {
	fixture.remove();
});

/** A process in the fixture tree: by default an orphaned wait loop 8 h old. */
function proc(
	pid: number,
	{
		argv = WAIT_LOOP,
		ageMinutes = 60 * 8,
		...spec
	}: ProcSpec & { ageMinutes?: number } = {},
): void {
	fixture.proc(pid, { argv, ageS: ageMinutes * 60, ...spec });
}

function run(...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		env: { ...process.env, WFC_PROC: root },
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

/** The --json envelope, which is stdout's whole content in that mode. */
function json(...args: string[]) {
	const res = run("--json", ...args);
	return JSON.parse(res.stdout) as {
		outcome: string;
		orphanCount: number;
		hidden: number;
		young: number;
		listed: number;
		unreadable: number;
		orphans: { pid: number; kill: string; argv: string }[];
		summary: string;
	};
}

describe("check-orphan-wait-loops", () => {
	it("reports an orphaned wait loop over the threshold, with its kill", () => {
		proc(4242);

		const { out, status } = run("--notify");

		expect(out).toContain("ORPHAN-WAIT-LOOP");
		expect(out).toContain("pid 4242");
		expect(out).toContain("kill 4242");
		expect(out).toContain("sleep 3");
		// WARN, never FAIL — it reports and a human decides (mantahostels#2017).
		expect(status).toBe(0);
	});

	it("says nothing at all when the machine is clean", () => {
		// An empty table: this case must not double as a test of any one criterion.
		const { out, status } = run("--notify");

		expect(out).toBe("");
		expect(status).toBe(0);
	});

	it("does not report a loop whose parent is not init (mantahostels#2017)", () => {
		proc(4242, { ppid: 900 });

		expect(json().orphanCount).toBe(0);
	});

	it("reports a loop whose parent is WSL's session /init, not pid 1 (#3055)", () => {
		proc(352, { argv: "/init" });
		proc(4242, { ppid: 352 });

		expect(json().orphans.map((o) => o.pid)).toEqual([4242]);
	});

	it("does not report a loop whose parent is a live shell (#3055)", () => {
		proc(900, { argv: "/bin/bash" });
		proc(4242, { ppid: 900 });

		expect(json().orphanCount).toBe(0);
	});

	it("does not report a loop under the elapsed threshold (mantahostels#2017)", () => {
		proc(4242, { ageMinutes: 5 });

		const envelope = json();

		expect(envelope.orphanCount).toBe(0);
		expect(envelope.young).toBe(1);
	});

	it("does not report an orphan with no sleep loop in its argv (mantahostels#2017)", () => {
		proc(4242, { argv: "/usr/bin/node scripts/run-vitest.js --changed" });

		expect(json().orphanCount).toBe(0);
	});

	it("does not report an orphan that sleeps outside any loop (mantahostels#2017)", () => {
		proc(4242, { argv: "/bin/sh -c sleep 600" });

		expect(json().orphanCount).toBe(0);
	});

	/* The `sleep` half of the predicate on its own. Without this fixture only
	 * dropping the WHOLE predicate is caught, and widening the check to every
	 * `while` orphan — a `while read` pipeline, a `while true` service — would
	 * ship silently and flood the session start (mantahostels#2043, review). */
	it("does not report a while loop that never sleeps (mantahostels#2043)", () => {
		proc(4242, { argv: "/bin/bash -c while read l; do echo $l; done" });

		expect(json().orphanCount).toBe(0);
	});

	it("parses a comm field carrying brackets and spaces (mantahostels#2017)", () => {
		proc(4242, { comm: "a (odd) name" });

		const envelope = json();

		expect(envelope.orphanCount).toBe(1);
		expect(envelope.orphans[0].pid).toBe(4242);
	});

	it("moves the threshold with --minutes", () => {
		proc(4242, { ageMinutes: 5 });

		expect(json("--minutes", "1").orphanCount).toBe(1);
	});

	it("skips a zombie", () => {
		proc(4242, { state: "Z" });

		expect(json().orphanCount).toBe(0);
	});

	it("passes over one process whose stat line has an unreadable shape", () => {
		proc(4242, { stat: "4242 (bash) S 1 0 0\n" });
		proc(4243);

		const envelope = json();

		expect(envelope.outcome).toBe("WARN");
		expect(envelope.orphanCount).toBe(1);
		expect(envelope.orphans[0].pid).toBe(4243);
		expect(envelope.unreadable).toBe(1);
	});

	it("skips with no /proc root at all, rather than reporting all-clear", () => {
		fs.rmSync(root, { recursive: true, force: true });

		const envelope = json();

		expect(envelope.outcome).toBe("SKIP");
		// Named, so an empty table falling through to the uptime skip below fails here.
		expect(envelope.summary).toContain("could not be enumerated");
		expect(envelope.orphanCount).toBeUndefined();
	});

	/* hidepid=2 and a hardened container: the root lists pids and none of them
	 * reads. An empty table here would be a false all-clear over a machine the
	 * run never saw (mantahostels#2043, review). */
	it("skips a root that lists processes of which none reads (mantahostels#2043)", () => {
		for (const pid of [4242, 4243]) fs.mkdirSync(path.join(root, String(pid)));

		const envelope = json();

		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("not one of them would read");
	});

	it("skips when uptime cannot be read, so no age can be derived", () => {
		proc(4242);
		fs.rmSync(path.join(root, "uptime"));

		const envelope = json();

		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("uptime");
	});

	it("caps the listing at ten entries and counts the remainder (mantahostels#2017)", () => {
		for (let i = 0; i < 13; i++) proc(5000 + i, { ageMinutes: 60 * (i + 1) });

		const { out } = run("--notify");
		const envelope = json();

		expect(envelope.orphanCount).toBe(13);
		expect(envelope.hidden).toBe(3);
		expect(out).toContain("and 3 more, not listed");
	});

	it("windows the printed command on the loop, past the harness preamble", () => {
		const preamble = `source ${"/a/very/long/snapshot/path".repeat(12)} && `;
		proc(4242, {
			argv: `${preamble}until grep -q DONE marker.log; do sleep 7; done`,
		});

		const { out } = run("--notify");

		expect(out).toContain("until grep -q DONE marker.log");
		expect(out).not.toContain("source /a/very/long");
	});

	/* Deliberately unlike check-ghost-jobs.js, which stamps each ghost and
	 * reports it once: a live orphan is a problem still happening (mantahostels#2017). */
	it("re-reports the same loop on a second run (mantahostels#2017)", () => {
		proc(4242);

		expect(run("--notify").out).toContain("pid 4242");
		expect(run("--notify").out).toContain("pid 4242");
	});

	/* A session-scope watcher sits under `systemd --user` by design and waits on
	 * its session's leader; the check reads that leader's pid and start time out
	 * of the watcher's argv (#4670). */
	describe("a session-scope watcher (#4670)", () => {
		const Leader = 660_083;
		const LeaderAgeS = 3600;
		const startOf = (ageS: number) =>
			Math.round((fixture.uptime - ageS) * USER_HZ);

		function watcher(start: number, script = WATCH) {
			proc(231, { argv: "/usr/lib/systemd/systemd --user" });
			proc(4242, {
				ppid: 231,
				argv: [
					"/usr/bin/sh",
					...watcherArgv(Leader, start)
						.slice(1)
						.map((word) => (word === WATCH ? script : word)),
				],
			});
		}

		it("is not reported while its leader lives", () => {
			proc(Leader, { ppid: 900, argv: "claude bg-spare", ageS: LeaderAgeS });
			watcher(startOf(LeaderAgeS));

			expect(json().orphanCount).toBe(0);
		});

		it("is reported once its leader is gone", () => {
			watcher(startOf(LeaderAgeS));

			expect(json().orphans.map((o) => o.pid)).toEqual([4242]);
		});

		it("is reported once its leader is a zombie", () => {
			proc(Leader, { ppid: 900, state: "Z", ageS: LeaderAgeS });
			watcher(startOf(LeaderAgeS));

			expect(json().orphans.map((o) => o.pid)).toEqual([4242]);
		});

		it("is not reported while its leader lives, though started from an older WATCH", () => {
			proc(Leader, { ppid: 900, argv: "claude bg-spare", ageS: LeaderAgeS });
			watcher(startOf(LeaderAgeS), "p=$1\nwhile alive; do sleep 5; done");

			expect(json().orphanCount).toBe(0);
		});

		it("is reported once its leader's pid is reused", () => {
			proc(Leader, { ppid: 900, argv: "claude bg-spare", ageS: 60 });
			watcher(startOf(LeaderAgeS));

			expect(json().orphans.map((o) => o.pid)).toEqual([4242]);
		});
	});

	it("never names its own process, even where its entry matches every test", () => {
		proc(process.pid);

		const envelope = json();

		expect(envelope.orphans.map((o) => o.pid)).not.toContain(process.pid);
		expect(envelope.orphanCount).toBe(0);
	});

	/* The ancestor walk, not just the self case: the check's own parent shell is
	 * an orphan matching every criterion, and is still not named (mantahostels#2043, review). */
	it("never names an ancestor of its own process (mantahostels#2043)", () => {
		const parent = 987_654;
		proc(process.pid, {
			ppid: parent,
			argv: "node check-orphan-wait-loops.js",
		});
		proc(parent);

		const envelope = json();

		expect(envelope.orphans.map((o) => o.pid)).not.toContain(parent);
		expect(envelope.orphanCount).toBe(0);
	});
});
