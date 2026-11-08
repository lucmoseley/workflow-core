// @vitest-environment node
/*
 * earlyoom's kills read from its journal lines (#3094), through a stub
 * journalctl: paired with their memory readings, merged per pid, grouped into
 * incidents, and rendered for the incident ticket. Break it and a kill goes
 * unticketed, one incident files twice, or a ticket misnames its victims.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ONE_BOOT,
	otherLine,
	readingLine,
	signalLine,
	writeFailingJournalctl,
	writeJournalctl,
} from "./earlyoom-journal-fake";

const kills = require("./earlyoom-kills.js");
const { basisFaults } = require("./issue-gate.js");

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-26T03:56:56+08:00");

/** Two incidents: three kills, one pid signalled twice, then one 40 min on. */
const JOURNAL = [
	otherLine(T0 - MIN),
	readingLine(T0, 776),
	signalLine(T0, 2_151_820, "dbus-daemon", { rss: 1 }),
	readingLine(T0 + 3000, 768),
	signalLine(T0 + 3000, 658_446, "MainThread"),
	readingLine(T0 + 20 * MIN, 790, 12),
	signalLine(T0 + 20 * MIN, 658_446, "MainThread", {
		rss: 900,
		sig: "SIGKILL",
	}),
	signalLine(T0 + 25 * MIN, 369_866, "2.1.310", { rss: 450 }),
	readingLine(T0 + 65 * MIN, 700),
	signalLine(T0 + 65 * MIN, 77, "a`b|c"),
];

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "earlyoom-kills-"));
	vi.stubEnv("WFC_JOURNALCTL", writeJournalctl(dir, JOURNAL));
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "refill"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const readAll = () => kills.readIncidents(T0 - 60 * MIN).incidents;

describe("readIncidents (#3094)", () => {
	it("pairs each kill with the reading before it, merges a pid's repeats and splits at a 30 min gap", () => {
		const [first, second, ...more] = readAll();
		expect(more).toHaveLength(0);
		expect(
			first.kills.map((k: { pid: number; kind: string }) => [k.pid, k.kind]),
		).toEqual([
			[2_151_820, "other"],
			[658_446, "node or python process"],
			[369_866, "Claude host"],
		]);
		expect(first.kills[1]).toMatchObject({
			name: "MainThread",
			badness: 741,
			rssMiB: 983,
			availMiB: 768,
			swapFreeMiB: 0,
			signals: 2,
		});
		expect(first.last).toBe(new Date(T0 + 25 * MIN).toISOString());
		expect(second.kills).toHaveLength(1);
		expect(kills.isOver(second, T0 + 95 * MIN)).toBe(false);
		expect(kills.isOver(second, T0 + 96 * MIN)).toBe(true);
	});

	it("reads an incident whole that began before the window, reading further back", () => {
		const { incidents, why } = kills.readIncidents(T0 + 22 * MIN);
		expect(why).toBeNull();
		expect(incidents).toHaveLength(2);
		expect(incidents[0].first).toBe(new Date(T0).toISOString());
		expect(incidents[0].kills).toHaveLength(3);
		const read = (ms: number) =>
			`journalctl -u earlyoom --no-pager -o short-iso --since @${ms / 1000}`;
		expect(
			fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"),
		).toEqual([
			read(T0 - 8 * MIN),
			read(T0 - 30 * MIN),
			"journalctl --list-boots --no-pager -o json",
		]);
	});

	it("drops an incident wholly before the window", () => {
		const { incidents } = kills.readIncidents(T0 + 60 * MIN);
		expect(incidents).toHaveLength(1);
		expect(incidents[0].kills[0].pid).toBe(77);
	});

	it("reads no kills, saying why, where journalctl fails", () => {
		vi.stubEnv(
			"WFC_JOURNALCTL",
			writeFailingJournalctl(path.join(dir, "failing")),
		);
		expect(kills.readIncidents(0)).toEqual({
			incidents: [],
			why: "journalctl -u earlyoom: denied",
		});
	});
});

describe("buildIncidentBody and incidentTitle (#3094)", () => {
	it("tables each victim by kind with its readings, and passes file-issue's basis check", () => {
		const [first, second] = readAll();
		const body = kills.buildIncidentBody(first);
		expect(body).toContain("earlyoom killed 3 processes between");
		expect(body).toContain("kills no more than 30 min apart");
		expect(body).toContain(
			"By kind: Claude host 1, node or python process 1, other 1.",
		);
		expect(body).not.toContain("Not joined");
		expect(body).toContain(
			"Lowest MemAvailable before a kill: 768 MiB, SwapFree 0 MiB.",
		);
		expect(body).toMatch(
			/\| node or python process \| `MainThread` \| 658446 \| 1000 \| 983 MiB \| 741 \| 768 MiB \| 0 MiB \| 2 \|/,
		);
		expect(basisFaults(body)).toEqual([]);
		expect(kills.buildIncidentBody(second)).toContain("| `a?b?c` |");
	});

	it("titles an incident by its first kill's UTC minute, whatever the TZ", () => {
		const [first] = readAll();
		expect(kills.incidentTitle(first)).toBe(
			"Memory kill incident from 2026-10-25 19:56 UTC",
		);
	});
});

describe("headless runs among the kills (#4143)", () => {
	const Pid = 4242;
	const OtherBoot = "fedcba9876543210fedcba9876543210";
	/** Kills of comm `claude` on PID: `at` each, in ONE_BOOT unless `boots` says. */
	function seed(
		at: number[],
		runs: { jobId: string; launchedAt: number; bootId?: string | null }[],
		boots: (typeof ONE_BOOT)[] | null = [ONE_BOOT],
	) {
		vi.stubEnv(
			"WFC_JOURNALCTL",
			writeJournalctl(
				path.join(dir, "join"),
				at.flatMap((ms) => [readingLine(ms), signalLine(ms, Pid, "claude")]),
				boots,
			),
		);
		for (const r of runs) {
			const runDir = path.join(dir, "refill", ".headless-runs", r.jobId);
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(
				path.join(runDir, "run.json"),
				JSON.stringify({
					jobId: r.jobId,
					sessionId: "s",
					pid: Pid,
					procStart: "1",
					/* /proc's boot_id, dashed as the launcher records it. */
					bootId:
						r.bootId === undefined
							? ONE_BOOT.id.replace(
									/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
									"$1-$2-$3-$4-$5",
								)
							: r.bootId,
					pgid: Pid,
					launchedAt: r.launchedAt,
				}),
			);
		}
	}
	const victims = () =>
		kills
			.readIncidents(T0 - 60 * MIN)
			.incidents.flatMap(
				(i: { kills: { kind: string; jobId: string | null }[] }) =>
					i.kills.map((k) => [k.kind, k.jobId]),
			);

	it("names a kill whose pid, boot and time match a stored run as that headless run, in the ticket and its kind count", () => {
		seed([T0], [{ jobId: "0aaaaaaa", launchedAt: T0 - 5 * MIN }]);
		const { incidents } = kills.readIncidents(T0 - 60 * MIN);
		expect(victims()).toEqual([["headless run", "0aaaaaaa"]]);
		const body = kills.buildIncidentBody(incidents[0]);
		expect(body).toContain("By kind: headless run 1 (job 0aaaaaaa).");
		expect(body).toMatch(/\| headless run `0aaaaaaa` \| `claude` \| 4242 \|/);
		expect(basisFaults(body)).toEqual([]);
	});

	it("takes the run launched latest before the kill where two share the pid", () => {
		seed(
			[T0],
			[
				{ jobId: "0aaaaaaa", launchedAt: T0 - 50 * MIN },
				{ jobId: "0bbbbbbb", launchedAt: T0 - 5 * MIN },
				{ jobId: "0ccccccc", launchedAt: T0 + 5 * MIN },
			],
		);
		expect(victims()).toEqual([["headless run", "0bbbbbbb"]]);
	});

	it("leaves a reused pid unmatched: a kill before the run's launch, or in another boot", () => {
		seed(
			[T0, T0 + 65 * MIN],
			[{ jobId: "0aaaaaaa", launchedAt: T0 + 5 * MIN }],
			[
				{ id: OtherBoot, from: 0, to: T0 + 60 * MIN },
				{ ...ONE_BOOT, from: T0 + 61 * MIN },
			],
		);
		/* T0: before the launch, and in a boot the run never saw. */
		expect(victims()).toEqual([
			["claude CLI", null],
			["headless run", "0aaaaaaa"],
		]);
		seed(
			[T0],
			[{ jobId: "0aaaaaaa", launchedAt: T0 - 5 * MIN, bootId: OtherBoot }],
		);
		expect(victims()).toEqual([["claude CLI", null]]);
	});

	it("says the kills were not joined where the store or the boot list will not read, never as no headless victim", () => {
		seed([T0], [{ jobId: "0aaaaaaa", launchedAt: T0 - 5 * MIN }], null);
		const [i] = kills.readIncidents(T0 - 60 * MIN).incidents;
		expect(i.kills[0].kind).toBe("claude CLI");
		expect(i.unjoined).toBe("journalctl --list-boots: no boots");
		expect(kills.buildIncidentBody(i)).toContain(
			"Not joined to the headless runs, so a claude CLI kill may be one: journalctl --list-boots: no boots.",
		);

		seed([T0], [{ jobId: "0aaaaaaa", launchedAt: T0 - 5 * MIN }]);
		fs.writeFileSync(
			path.join(dir, "refill", ".headless-runs", "0aaaaaaa", "run.json"),
			"{",
		);
		const [j] = kills.readIncidents(T0 - 60 * MIN).incidents;
		expect(j.kills[0].kind).toBe("claude CLI");
		expect(j.unjoined).toMatch(/^the headless run store: /);
	});
});
