// @vitest-environment node
/*
 * lib/wsl-disk.js (#5044): the compaction log's reading, when a quiet run
 * or an idle fstrim.timer warns, the sparse watch, and one run's order with every effect behind a
 * port. Loosened, a missed compaction re-fills C: with no warning, a sparse
 * fix goes unnoticed, or the monthly job shuts WSL down under a live session
 * or leaves the loop held.
 */
import { describe, expect, it } from "vitest";
import {
	judgeDisk,
	judgeSparse,
	parseLog,
	runCompaction,
	runSparseWatch,
} from "./wsl-disk.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-20T12:00:00");
const LOG = [
	"2026-11-12T21:00:00 registered size_gb=108.6 c_free_gb=216.0",
	"2026-12-12T02:30:00 ok before_gb=120.1 after_gb=110.4 c_free_gb=210.0",
].join("\r\n");
const read = (text: string) => ({ state: "read", path: "/log", text }) as const;

describe("parseLog", () => {
	it("reads each line's time, result and fields, skipping junk and a BOM", () => {
		const entries = parseLog(`﻿${LOG}\r\nnot a line\r\n`);
		expect(entries.map((e) => e.result)).toEqual(["registered", "ok"]);
		expect(entries[1]?.fields).toEqual({
			before_gb: "120.1",
			after_gb: "110.4",
			c_free_gb: "210.0",
		});
		expect(entries[1]?.at).toBe(Date.parse("2026-12-12T02:30:00"));
	});
});

describe("judgeDisk", () => {
	const judge = (
		text: string,
		now = NOW,
		freeGB: number | { why: string } = 210,
	) =>
		judgeDisk({
			log: read(text),
			now,
			freeGB,
			trim: { last: now - DAY, fixedAt: null },
		});
	const tags = (v: ReturnType<typeof judgeDisk>) =>
		v.warnings.map((w) => w.tag);

	it("is clean on a recent success and roomy C:, naming both", () => {
		const v = judge(LOG);
		expect(v.warnings).toEqual([]);
		expect(v.okLine).toBe(
			"last compaction 2026-12-12 (120.1 to 110.4 GB), C: free 210.0 GB",
		);
	});
	it("warns over 35 days since the last success, naming the remedy", () => {
		const v = judge(LOG, Date.parse("2026-12-12T02:30:00") + 36 * DAY);
		expect(tags(v)).toEqual(["COMPACT-STALE"]);
		expect(v.warnings[0]?.line).toContain("36 days ago");
		expect(v.warnings[0]?.line).toContain("wsl-disk-compaction.js run --now");
	});
	it("does not warn at exactly 35 days", () => {
		expect(
			tags(judge(LOG, Date.parse("2026-12-12T02:30:00") + 35 * DAY)),
		).toEqual([]);
	});
	it("counts from the registered line, a newer deferral not resetting it", () => {
		const v = judge(
			"2026-12-10T00:00:00 registered\n2026-12-19T09:00:00 deferred sessions=2_live",
		);
		expect(tags(v)).toEqual([]);
	});
	it("warns on a newest failed run though the last success is recent, naming the remedy", () => {
		const v = judge(`${LOG}\n2026-12-19T02:00:00 failed step=diskpart exit=1`);
		expect(tags(v)).toEqual(["COMPACT-FAILED"]);
		expect(v.warnings[0]?.line).toContain("journalctl --user");
	});
	it("judges the newest run by its result, past a later watch line", () => {
		const v = judge(
			`${LOG}\n2026-12-19T02:00:00 failed step=hold\n2026-12-20T02:00:00 watched`,
		);
		expect(tags(v)).toEqual(["COMPACT-FAILED"]);
	});
	it("warns where the newest sparse watch failed, until one succeeds", () => {
		const failed = `${LOG}\n2026-12-19T02:00:00 watchfailed`;
		expect(tags(judge(failed))).toEqual(["WATCH-FAILED"]);
		expect(tags(judge(`${failed}\n2026-12-20T02:00:00 watched`))).toEqual([]);
	});
	it("warns where the last success ran untrimmed", () => {
		const v = judge(
			"2026-12-15T02:00:00 watched\n2026-12-15T02:01:00 trimfailed error=denied\n2026-12-15T02:10:00 ok before_gb=1 after_gb=1",
		);
		expect(tags(v)).toEqual(["TRIM-FAILED"]);
		expect(v.warnings[0]?.line).toContain("error=denied");
	});
	describe("fstrim.timer", () => {
		const trim = (
			last: number | null | { why: string },
			fixedAt: number | null = NOW - 30 * DAY,
		) =>
			judgeDisk({
				log: read(LOG),
				now: NOW,
				freeGB: 210,
				trim: { last, fixedAt },
			});
		const line = (v: ReturnType<typeof judgeDisk>) => v.warnings[0]?.line;
		it("is quiet within 14 days of its last firing", () => {
			expect(tags(trim(NOW - 14 * DAY))).toEqual([]);
		});
		it("warns past 14 days, pointing at its status where the fix is in", () => {
			const stale = trim(NOW - 15 * DAY);
			expect(tags(stale)).toEqual(["TRIM-TIMER-IDLE"]);
			expect(line(stale)).toContain("15 days ago");
			expect(line(stale)).toContain("systemctl status fstrim.timer");
		});
		it("counts a timer that has not fired yet from its fix's install", () => {
			expect(tags(trim(null, NOW - 3 * DAY))).toEqual([]);
			expect(line(trim(null, NOW - 20 * DAY))).toContain(
				"has not fired in the 20 days since its WSL fix was installed",
			);
		});
		it("names the installer where the fix is not in", () => {
			const v = trim(null, null);
			expect(line(v)).toContain("its WSL fix is not installed");
			expect(line(v)).toContain("install-fstrim-wsl.sh");
		});
		it("warns where its last run will not read", () => {
			expect(tags(trim({ why: "no bus" }))).toEqual(["TRIM-TIMER-UNREAD"]);
		});
	});
	it("warns with no log, an unreadable one, C: under 40 GB, and C: unread", () => {
		expect(
			tags(
				judgeDisk({
					log: { state: "absent" },
					now: NOW,
					freeGB: 39.9,
					trim: { last: NOW, fixedAt: null },
				}),
			),
		).toEqual(["C-LOW", "COMPACT-UNINSTALLED"]);
		expect(
			tags(
				judgeDisk({
					log: { state: "unreadable", why: "EIO" },
					now: NOW,
					freeGB: { why: "ENOENT" },
					trim: { last: NOW, fixedAt: null },
				}),
			),
		).toEqual(["C-UNREAD", "COMPACT-UNREAD"]);
	});
});

const open = (number: number) => ({
	number,
	state: "open",
	state_reason: null,
});
const release = (tagName: string, body: string, prerelease = false) => ({
	tag_name: tagName,
	body,
	prerelease,
	draft: false,
});
const INSTALLED = [3, 0, 5, 0];

describe("judgeSparse", () => {
	it("finds nothing while the issues are open and no newer release names sparse", () => {
		expect(
			judgeSparse({
				issues: [open(41_837), open(42_179), open(10_609)],
				releases: [
					release("3.0.6", "Fix networking"),
					release("3.0.5", "Sparse VHD fix"),
				],
				installed: INSTALLED,
			}),
		).toEqual([]);
	});
	it("triggers on #41837 closed for any reason, on another only when completed", () => {
		const t = judgeSparse({
			issues: [
				{ number: 41_837, state: "closed", state_reason: "not_planned" },
				{ number: 42_179, state: "closed", state_reason: "not_planned" },
				{ number: 10_609, state: "closed", state_reason: "completed" },
			],
			releases: [],
			installed: INSTALLED,
		});
		expect(t.map((x) => x.key)).toEqual(["issue-41837", "issue-10609"]);
		expect(t[0]?.title).toBe(
			"Convert the WSL disk to sparse? microsoft/WSL#41837 closed",
		);
	});
	it("triggers on a newer stable release naming sparse, quoting its lines", () => {
		const t = judgeSparse({
			issues: [],
			releases: [
				release(
					"3.1.0",
					"- Fix sparse VHD corruption on a full host disk\n- Other",
				),
				release("3.2.0", "sparse", true),
			],
			installed: INSTALLED,
		});
		expect(t.map((x) => x.title)).toEqual([
			"Convert the WSL disk to sparse? WSL 3.1.0 names sparse",
		]);
		expect(t[0]?.line).toContain("Fix sparse VHD corruption");
	});
});

describe("runSparseWatch", () => {
	const closed = { number: 41_837, state: "closed", state_reason: "completed" };
	function ports(over: Record<string, unknown> = {}) {
		const filed: string[] = [];
		const p = {
			readInstalled: () => ({ version: "3.0.5.0" }),
			readIssue: (n: number) => (n === 41_837 ? closed : open(n)),
			readReleases: () => [],
			findFiled: () => null,
			file: (title: string, body: string) => {
				filed.push(`${title}\n${body}`);
				return "https://github.com/x/y/issues/9";
			},
			...over,
		};
		return { p, filed };
	}
	it("files a ticket for a new trigger, naming the ruling in its body", () => {
		const { p, filed } = ports();
		const r = runSparseWatch(p as never);
		expect(r.lines[0]).toContain("Filed: https://");
		expect(r.failed).toBe(false);
		expect(filed).toHaveLength(1);
		expect(filed[0]).toContain("#5041 Q1 ruled (A)");
	});
	it("files nothing where the title is already ticketed, in any state", () => {
		const { p, filed } = ports({ findFiled: () => 77 });
		expect(runSparseWatch(p as never)).toEqual({
			lines: [expect.stringContaining("Already ticketed: #77.")],
			failed: false,
		});
		expect(filed).toEqual([]);
	});
	it("files nothing where the dedupe search fails, and says it failed", () => {
		const { p, filed } = ports({ findFiled: () => ({ why: "HTTP 502" }) });
		expect(runSparseWatch(p as never)).toEqual({
			lines: [expect.stringContaining("Not filed: HTTP 502")],
			failed: true,
		});
		expect(filed).toEqual([]);
	});
	it("says a refused filing failed", () => {
		const { p } = ports({ file: () => ({ why: "similar titles" }) });
		expect(runSparseWatch(p as never).failed).toBe(true);
	});
	it("says what would not read, judging nothing", () => {
		const { p, filed } = ports({
			readReleases: () => ({ why: "rate limited" }),
		});
		expect(runSparseWatch(p as never)).toEqual({
			lines: ["not read: rate limited"],
			failed: true,
		});
		expect(filed).toEqual([]);
		const { p: q } = ports({ readInstalled: () => ({ why: "stalled" }) });
		expect(runSparseWatch(q as never)).toEqual({
			lines: ["not read: wsl.exe --version: stalled"],
			failed: true,
		});
	});
	it("says no trigger where none fires", () => {
		const { p } = ports({ readIssue: open });
		expect(runSparseWatch(p as never)).toEqual({
			lines: ["no trigger"],
			failed: false,
		});
	});
});

describe("runCompaction", () => {
	const RunNow = Date.parse("2026-12-20T02:00:00");
	const Old = "2026-11-12T21:00:00 registered";
	const Fresh = "2026-12-15T02:00:00 ok after_gb=100";

	const live = (n: number, waiting = 0) => ({ live: n, waiting });
	function ports(
		over: Record<string, unknown> = {},
		readings: unknown[] = [live(0)],
	) {
		const calls: string[] = [];
		let clock = RunNow;
		let polls = 0;
		const p = {
			now: () => clock,
			readKernelRelease: () => "6.18.33.2-microsoft-standard-WSL2",
			readLog: () => read(Old),
			appendLine: (file: string, l: string) => calls.push(`log ${file} ${l}`),
			sparseWatch: () => {
				calls.push("sparse");
				return { lines: ["no trigger"], failed: false };
			},
			readLiveSessions: () => readings[Math.min(polls++, readings.length - 1)],
			hold: () => {
				calls.push("hold");
				return null;
			},
			release: () => {
				calls.push("release");
				return null;
			},
			sleep: (ms: number) => {
				clock += ms;
			},
			trim: () => {
				calls.push("trim");
				return { out: "/: 10 GiB trimmed", error: null };
			},
			startTask: () => {
				calls.push("start");
				return null;
			},
			say: (l: string) => calls.push(`say ${l}`),
			...over,
		};
		return { p, calls };
	}
	const steps = (calls: string[]) => calls.filter((c) => !c.startsWith("say "));
	const run = (p: unknown, force = false) =>
		runCompaction(p as never, { force });

	it("does nothing when not due, or off WSL", () => {
		const fresh = ports({ readLog: () => read(Fresh) });
		expect(run(fresh.p)).toBe(0);
		expect(steps(fresh.calls)).toEqual([]);
		const off = ports({ readKernelRelease: () => "6.8.0-45-generic" });
		expect(run(off.p)).toBe(0);
		expect(steps(off.calls)).toEqual([]);
	});

	const Watched = "log /log 2026-12-20T02:00:00 watched";

	it("runs a due one: watch, hold across two empty readings, trim, start, no release", () => {
		const { p, calls } = ports();
		expect(run(p)).toBe(0);
		expect(steps(calls)).toEqual([
			"sparse",
			Watched,
			"hold",
			"hold",
			"trim",
			"start",
		]);
	});

	it("logs a failed sparse watch and still compacts", () => {
		const { p, calls } = ports({
			sparseWatch: () => ({ lines: ["not read: x"], failed: true }),
		});
		expect(run(p)).toBe(0);
		expect(steps(calls)[0]).toBe("log /log 2026-12-20T02:00:00 watchfailed");
		expect(steps(calls)).toContain("start");
	});

	it("runs one not due under --now", () => {
		const { p, calls } = ports({ readLog: () => read(Fresh) });
		expect(run(p, true)).toBe(0);
		expect(steps(calls)).toContain("start");
	});

	it("waits for live sessions, renewing the hold each poll", () => {
		const { p, calls } = ports({}, [live(2), live(1), live(0)]);
		expect(run(p)).toBe(0);
		expect(steps(calls)).toEqual([
			"sparse",
			Watched,
			"hold",
			"hold",
			"hold",
			"hold",
			"trim",
			"start",
		]);
	});

	it("starts over on a session seen between two empty readings", () => {
		const { p, calls } = ports({}, [live(0), live(1), live(0), live(0)]);
		expect(run(p)).toBe(0);
		expect(steps(calls).filter((c) => c === "hold")).toHaveLength(4);
	});

	it("defers at once where every live session waits on input", () => {
		const { p, calls } = ports({}, [live(2, 2)]);
		expect(run(p)).toBe(1);
		expect(steps(calls).slice(-3)).toEqual([
			"hold",
			"release",
			"log /log 2026-12-20T02:00:00 deferred sessions=2_live,_2_waiting_on_input",
		]);
	});

	it("treats a listing that will not read as live, never as none", () => {
		const { p, calls } = ports({}, [{ why: "oracle down" }, live(0)]);
		expect(run(p)).toBe(0);
		expect(calls).toContain("say waiting: oracle down; launches held.");
	});

	it("defers after 6 h of live sessions: releases, logs, starts nothing", () => {
		const { p, calls } = ports({}, [live(1)]);
		expect(run(p)).toBe(1);
		const s = steps(calls);
		expect(s).not.toContain("trim");
		expect(s).not.toContain("start");
		expect(s.slice(-2)).toEqual([
			"release",
			"log /log 2026-12-20T08:00:00 deferred sessions=1_live,_0_waiting_on_input",
		]);
		// One hold a 5-minute poll across the 6 h, and the last one.
		expect(s.filter((c) => c === "hold")).toHaveLength(73);
	});

	it("releases and logs when the task will not start", () => {
		const { p, calls } = ports({ startTask: () => "schtasks exited 1" });
		expect(run(p)).toBe(1);
		expect(steps(calls).slice(-2)).toEqual([
			"release",
			"log /log 2026-12-20T02:05:00 failed step=schtasks error=schtasks_exited_1",
		]);
	});

	it("logs a failed trim and still compacts", () => {
		const { p, calls } = ports({
			trim: () => ({ out: "", error: "permission denied" }),
		});
		expect(run(p)).toBe(0);
		expect(steps(calls)).toEqual([
			"sparse",
			Watched,
			"hold",
			"hold",
			"log /log 2026-12-20T02:05:00 trimfailed error=permission_denied",
			"start",
		]);
	});

	it("stops where the hold will not set, releasing and starting nothing", () => {
		const { p, calls } = ports({ hold: () => "refill-loop exited 1" });
		expect(run(p)).toBe(1);
		expect(steps(calls).slice(-2)).toEqual([
			"release",
			"log /log 2026-12-20T02:00:00 failed step=hold error=refill-loop_exited_1",
		]);
	});

	it("exits 1, touching nothing, with no log, an unreadable one or an unread kernel", () => {
		for (const over of [
			{ readLog: () => ({ state: "absent" }) },
			{ readLog: () => ({ state: "unreadable", why: "EIO" }) },
			{ readKernelRelease: () => ({ why: "EACCES" }) },
		]) {
			const { p, calls } = ports(over);
			expect(run(p, true)).toBe(1);
			expect(steps(calls)).toEqual([]);
		}
	});
});
