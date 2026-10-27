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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
const saved = process.env.WFC_JOURNALCTL;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "earlyoom-kills-"));
	process.env.WFC_JOURNALCTL = writeJournalctl(dir, JOURNAL);
});
afterEach(() => {
	if (saved === undefined) delete process.env.WFC_JOURNALCTL;
	else process.env.WFC_JOURNALCTL = saved;
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
			[658_446, "test or build"],
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
		expect(
			fs.readFileSync(path.join(dir, "reads"), "utf8").trim().split("\n"),
		).toHaveLength(2);
	});

	it("drops an incident wholly before the window", () => {
		const { incidents } = kills.readIncidents(T0 + 60 * MIN);
		expect(incidents).toHaveLength(1);
		expect(incidents[0].kills[0].pid).toBe(77);
	});

	it("reads no kills, saying why, where journalctl fails", () => {
		process.env.WFC_JOURNALCTL = writeFailingJournalctl(
			path.join(dir, "failing"),
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
		expect(body).toContain("By kind: Claude host 1, test or build 1, other 1.");
		expect(body).toContain(
			"Lowest MemAvailable before a kill: 768 MiB, SwapFree 0 MiB.",
		);
		expect(body).toMatch(
			/\| test or build \| `MainThread` \| 658446 \| 1000 \| 983 MiB \| 741 \| 768 MiB \| 0 MiB \| 2 \|/,
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
