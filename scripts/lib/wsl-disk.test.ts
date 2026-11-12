// @vitest-environment node
/*
 * lib/wsl-disk.js (#5044): the compaction log's reading, when a run is due,
 * when a quiet one warns, and the sparse watch's triggers. Loosened, a missed
 * compaction re-fills C: with no warning, or a sparse fix goes unnoticed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DUE_DAYS,
	findLog,
	isDue,
	judgeDisk,
	judgeSparse,
	parseLog,
} from "./wsl-disk.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-20T12:00:00");
const LOG = [
	"2026-11-12T21:00:00 registered size_gb=108.6 c_free_gb=216.0",
	"2026-12-12T02:30:00 ok before_gb=120.1 after_gb=110.4 c_free_gb=210.0",
].join("\r\n");

describe("parseLog", () => {
	it("reads each line's time, result and fields, skipping junk and a BOM", () => {
		const entries = parseLog(`﻿${LOG}\r\nnot a line\r\n`);
		expect(entries.map((e) => e.result)).toEqual(["registered", "ok"]);
		expect(entries[1].fields).toEqual({
			before_gb: "120.1",
			after_gb: "110.4",
			c_free_gb: "210.0",
		});
		expect(entries[1].at).toBe(Date.parse("2026-12-12T02:30:00"));
	});
});

describe("isDue", () => {
	const at = (days: number) =>
		parseLog("2026-12-01T00:00:00 ok after_gb=1\n").map((e) => ({
			...e,
			at: NOW - days * DAY,
		}));
	it("is due at DUE_DAYS since the last success, and not a day before", () => {
		expect(isDue(at(DUE_DAYS), NOW)).toBe(true);
		expect(isDue(at(DUE_DAYS - 1), NOW)).toBe(false);
	});
	it("counts from the registered line, and ignores a newer failure or deferral", () => {
		const entries = parseLog(
			"2026-12-10T00:00:00 registered\n2026-12-19T00:00:00 failed step=diskpart\n2026-12-19T09:00:00 deferred sessions=2_live",
		);
		expect(isDue(entries, NOW)).toBe(false);
	});
	it("is due with no success on record", () => {
		expect(isDue(parseLog("2026-12-19T00:00:00 failed step=x"), NOW)).toBe(
			true,
		);
	});
});

describe("judgeDisk", () => {
	it("is clean on a recent success and roomy C:, naming both", () => {
		const v = judgeDisk({ entries: parseLog(LOG), now: NOW, freeGB: 210 });
		expect(v.warnings).toEqual([]);
		expect(v.okLine).toBe(
			"last compaction 2026-12-12 (120.1 to 110.4 GB), C: free 210.0 GB",
		);
	});
	it("warns over 35 days since the last success, quoting the newest line", () => {
		const v = judgeDisk({
			entries: parseLog(LOG),
			now: Date.parse("2026-12-12T02:30:00") + 36 * DAY,
			freeGB: 200,
		});
		expect(v.warnings.map((w) => w.tag)).toEqual(["COMPACT-STALE"]);
		expect(v.warnings[0].line).toContain("36 days ago");
	});
	it("warns on a newest failed run though the last success is recent", () => {
		const v = judgeDisk({
			entries: parseLog(
				`${LOG}\n2026-12-19T02:00:00 failed step=diskpart exit=1`,
			),
			now: NOW,
			freeGB: 200,
		});
		expect(v.warnings.map((w) => w.tag)).toEqual(["COMPACT-FAILED"]);
	});
	it("warns with no log, and on C: under 40 GB", () => {
		const v = judgeDisk({ entries: null, now: NOW, freeGB: 39.9 });
		expect(v.warnings.map((w) => w.tag)).toEqual([
			"C-LOW",
			"COMPACT-UNINSTALLED",
		]);
	});
});

describe("judgeSparse", () => {
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
	const installed = [3, 0, 5, 0];

	it("finds nothing while the issues are open and no newer release names sparse", () => {
		expect(
			judgeSparse({
				issues: [open(41_837), open(42_179), open(10_609)],
				releases: [
					release("3.0.6", "Fix networking"),
					release("3.0.5", "Sparse VHD fix"),
				],
				installed,
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
			installed,
		});
		expect(t.map((x) => x.key)).toEqual(["issue-41837", "issue-10609"]);
		expect(t[0].title).toBe(
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
			installed,
		});
		expect(t).toHaveLength(1);
		expect(t[0].title).toBe(
			"Convert the WSL disk to sparse? WSL 3.1.0 names sparse",
		);
		expect(t[0].line).toContain("Fix sparse VHD corruption");
	});
});

describe("findLog", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("takes the newest user's log, and null where none exists", () => {
		vi.stubEnv("WFC_WSL_COMPACT_LOG", "");
		expect(findLog(dir)).toBeNull();
		for (const [user, at] of [
			["a", 1000],
			["b", 2000],
		] as const) {
			const d = path.join(dir, user, "AppData", "Local");
			fs.mkdirSync(d, { recursive: true });
			const p = path.join(d, "wsl-compact.log");
			fs.writeFileSync(p, "");
			fs.utimesSync(p, at, at);
		}
		expect(findLog(dir)).toBe(
			path.join(dir, "b", "AppData", "Local", "wsl-compact.log"),
		);
	});
});
