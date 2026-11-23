// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeProcRoot, type ProcSpec } from "./lib/proc-fake";
import { USER_HZ } from "./lib/proc-table.js";
import { runInProcess } from "./lib/run-in-process.js";
import { watcherArgv } from "./lib/session-scope.js";

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
		expect(status).toBe(0);
	});

	it("says nothing at all when the machine is clean", () => {
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
		expect(envelope.summary).toContain("could not be enumerated");
		expect(envelope.orphanCount).toBeUndefined();
	});

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

	it("re-reports the same loop on a second run (mantahostels#2017)", () => {
		proc(4242);

		expect(run("--notify").out).toContain("pid 4242");
		expect(run("--notify").out).toContain("pid 4242");
	});

	describe("a session-scope watcher (#4670)", () => {
		const Leader = 660_083;
		const LeaderAgeS = 3600;
		const startOf = (ageS: number) =>
			Math.round((fixture.uptime - ageS) * USER_HZ);

		function watcher(start: number, script?: string) {
			const argv = watcherArgv(Leader, start);
			if (script !== undefined) argv[2] = script;
			proc(231, { argv: "/usr/lib/systemd/systemd --user" });
			proc(4242, {
				ppid: 231,
				argv: ["/usr/bin/sh", ...argv.slice(1)],
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

		it("is not reported while its leader lives, though started from an older watcher script", () => {
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
