// @vitest-environment node
/*
 * check-chrome-tab-leftovers.js, driven through its command line on fixture
 * transcripts under temporary seats and a fixture Chrome child store (#5385).
 *
 * The rows are hand-built in the Claude in Chrome extension's wording
 * (lib/chrome-rows-fake.ts); a rewording in the extension is caught only by
 * a live run. Each case runs under a temporary seat and project root, never
 * the real ones. Loosening a case lets a leftover tab pass the daily core
 * gate unreported.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcStartOf } from "./lib/arbiter-proc.js";
import { buildTabContext, buildToolResultRow } from "./lib/chrome-rows-fake";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-chrome-tab-leftovers.js");
const NOW = "2026-11-25T12:00:00Z";
const HOUR = 3_600_000;

let dir = "";
let seatA = "";
let seatB = "";
const store = () => path.join(seatA, "chrome-children");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-census-"));
	seatA = path.join(dir, ".claude");
	seatB = path.join(dir, ".claude2");
	fs.mkdirSync(seatA);
	fs.mkdirSync(seatB);
	firstLaunch("2026-11-17T12:00:00Z");
});

const firstLaunch = (iso: string) => {
	fs.mkdirSync(store(), { recursive: true });
	fs.writeFileSync(path.join(store(), "first-launch"), `${iso}\n`);
};

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[] = []) =>
	runInProcessAsync(SCRIPT, ["--json", ...args], {
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: seatA,
			CLAUDE_PROJECT_DIR: dir,
			WFC_CLAUDE_CONFIG_A: seatA,
			WFC_CLAUDE_CONFIG_B: seatB,
			WFC_CLAUDE_CONFIG_C: path.join(dir, ".claude3"),
			WFC_NOW: NOW,
		},
	});

const report = async (args: string[] = []) => {
	const r = await run(["--json-text", ...args]);
	return { status: r.status, ...JSON.parse(r.stdout) };
};

const keys = async (args: string[] = []) =>
	(await report(args)).findings.map((f: { key: string }) => f.key);

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const chromeCall = (sessionId: string) => ({
	type: "assistant",
	sessionId,
	message: {
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "toolu_1",
				name: "mcp__claude-in-chrome__tabs_context_mcp",
				input: {},
			},
		],
	},
});

const result = (sessionId: string, ...texts: string[]) => ({
	...buildToolResultRow(...texts),
	sessionId,
});

/** A transcript under `seat`, last written at `at`. */
function transcript(
	sessionId: string,
	rows: object[],
	{ seat = seatA, at = "2026-11-24T12:00:00Z", name = sessionId } = {},
) {
	const slug = path.join(seat, "projects", "-repo");
	fs.mkdirSync(slug, { recursive: true });
	const file = path.join(slug, `${name}.jsonl`);
	fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const t = new Date(at);
	fs.utimesSync(file, t, t);
}

/** A Chrome child whose last Tab Context lists `tabs`. */
const child = (
	tabs: [number, string, string?][],
	opts: Parameters<typeof transcript>[2] = {},
	id = uuid(),
) => {
	transcript(
		id,
		[
			{ type: "user", sessionId: id, message: { content: "go" } },
			chromeCall(id),
			result(id, "Done.", buildTabContext(...tabs)),
		],
		opts,
	);
	return id;
};

const record = (sessionId: string, extra: object = {}, sub = "") => {
	fs.mkdirSync(path.join(store(), sub), { recursive: true });
	fs.writeFileSync(
		path.join(store(), sub, `${sessionId}.json`),
		JSON.stringify({
			sessionId,
			seat: seatA,
			launcherPid: 999_999_999,
			launcherStart: "1",
			childPid: null,
			childStart: null,
			startedAt: "2026-11-24T10:00:00Z",
			attempts: 0,
			...extra,
		}),
	);
};

const sweptAt = (iso: string) => {
	fs.mkdirSync(store(), { recursive: true });
	fs.writeFileSync(path.join(store(), "last-sweep"), `${iso}\n`);
};

describe("classing each Chrome child", () => {
	it("passes a child whose last Tab Context lists no tab", async () => {
		child([]);
		const r = await report();
		expect(r.status).toBe(0);
		expect(r.findings).toEqual([]);
		expect(r.summary).toContain("1 counted, 1 clean");
	});

	it("passes a child whose resume, in a later transcript, closed its tab", async () => {
		const id = child([[7, "https://a.example/", "Page A"]], {
			at: "2026-11-24T10:00:00Z",
		});
		transcript(
			id,
			[
				chromeCall(id),
				result(id, "Closed tab 7. Group is now empty (auto-removed)."),
			],
			{ seat: seatB, at: "2026-11-24T11:00:00Z", name: uuid() },
		);
		expect(await keys()).toEqual([]);
	});

	it("passes a child whose resume found its group gone", async () => {
		const id = child([[7, "https://a.example/", "Page A"]], {
			at: "2026-11-24T10:00:00Z",
		});
		transcript(
			id,
			[
				chromeCall(id),
				result(id, "This session's tab group no longer exists."),
			],
			{ at: "2026-11-24T11:00:00Z", name: uuid() },
		);
		expect(await keys()).toEqual([]);
	});

	it("reports an unexplained leftover naming session, seat, title and URL", async () => {
		const id = child([[7, "https://a.example/", "Page A"]], { seat: seatB });
		const r = await report();
		expect(r.status).toBe(0);
		expect(r.findings).toHaveLength(1);
		expect(r.findings[0].severity).toBe("WARN");
		expect(r.findings[0].key).toBe(
			`UNEXPLAINED-TAB\t${id}\t${seatB}\tPage A (https://a.example/)`,
		);
	});

	it("reports a session that used the Chrome tools without the launcher", async () => {
		const id = child([[3, "https://b.example/", "B"]]);
		expect(await keys()).toEqual([
			`UNEXPLAINED-TAB\t${id}\t${seatA}\tB (https://b.example/)`,
		]);
	});

	it("does not count a session that never called a Chrome tool", async () => {
		const id = uuid();
		transcript(id, [
			{ type: "user", sessionId: id, message: { content: "go" } },
			result(id, "Done.", buildTabContext([3, "https://b.example/", "B"])),
		]);
		const r = await report();
		expect(r.findings).toEqual([]);
		expect(r.summary).toContain("0 counted");
	});

	it("counts a held tab within its hold on its own line, not as a finding", async () => {
		const id = child([[5, "https://held.example/", "Held"]]);
		record(id, { heldSince: "2026-11-25T11:00:00Z" });
		sweptAt("2026-11-25T11:30:00Z");
		const r = await report();
		expect(r.findings).toEqual([]);
		expect(r.text).toContain(
			"held: 1 child(ren) holding a hand-over tab within its 2 h hold.",
		);
	});

	it("reports a held tab a sweep has run past the hold of", async () => {
		const id = child([[5, "https://held.example/", "Held"]]);
		record(id, { heldSince: "2026-11-25T08:00:00Z" });
		sweptAt("2026-11-25T10:30:00Z");
		const r = await report();
		expect(r.findings.map((f: { key: string }) => f.key)).toEqual([
			`UNEXPLAINED-TAB\t${id}\t${seatA}\tHeld (https://held.example/)`,
		]);
		expect(r.text).toContain("held: 0 child(ren)");
	});

	it("counts a given-up child on its own line, not as a finding", async () => {
		const id = child([[5, "https://gone.example/", "Gone"]]);
		record(id, { givenUpAt: NOW, reason: "failed" }, "given-up");
		const r = await report();
		expect(r.findings).toEqual([]);
		expect(r.text).toContain(
			"given up: 1 child(ren) whose tabs no closer could close.",
		);
	});

	it("skips a child whose launcher still runs", async () => {
		const id = child([[5, "https://live.example/", "Live"]]);
		record(id, {
			launcherPid: process.pid,
			launcherStart: readProcStartOf(process.pid),
		});
		const r = await report();
		expect(r.findings).toEqual([]);
		expect(r.summary).toContain("0 counted");
	});
});

describe("the window", () => {
	it("reads nothing written before the store's first recorded launch, whatever --since says", async () => {
		child([[1, "https://old.example/", "Old"]], {
			at: "2026-11-17T11:00:00Z",
		});
		expect(await keys(["--since", "30"])).toEqual([]);
	});

	it("counts nothing where no launch was ever recorded", async () => {
		fs.rmSync(path.join(store(), "first-launch"));
		child([[1, "https://a.example/", "A"]]);
		const r = await run(["--json-text"]);
		expect(JSON.parse(r.stdout).findings).toEqual([]);
		expect(r.stdout).toContain(
			"no Chrome child has run under the recording launcher yet",
		);
	});

	it("reads only the last --since days", async () => {
		child([[1, "https://old.example/", "Old"]], {
			at: new Date(Date.parse(NOW) - 72 * HOUR).toISOString(),
		});
		const recent = child([[2, "https://new.example/", "New"]], {
			at: new Date(Date.parse(NOW) - 12 * HOUR).toISOString(),
		});
		expect(await keys(["--since", "2"])).toEqual([
			`UNEXPLAINED-TAB\t${recent}\t${seatA}\tNew (https://new.example/)`,
		]);
		expect(await keys(["--since", "7"])).toHaveLength(2);
	});
});

describe("--turnaround", () => {
	it("prints each held tab's hold-to-close time and what closed it", async () => {
		fs.mkdirSync(store(), { recursive: true });
		const a = uuid();
		fs.writeFileSync(
			path.join(store(), "closed.jsonl"),
			[
				{
					sessionId: a,
					heldSince: "2026-11-25T08:00:00Z",
					closedAt: "2026-11-25T08:45:00Z",
					by: "done",
				},
				{ sessionId: uuid(), closedAt: "2026-11-25T09:00:00Z", by: "trap" },
			]
				.map((l) => `${JSON.stringify(l)}\n`)
				.join(""),
		);
		const r = await runInProcessAsync(SCRIPT, ["--turnaround"], {
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: seatA,
				CLAUDE_PROJECT_DIR: dir,
				WFC_CLAUDE_CONFIG_A: seatA,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			`${a}\t2026-11-25T08:00:00Z\t2026-11-25T08:45:00Z\t45 min\tdone`,
		);
		expect(r.stderr).toContain("1 held tab(s) closed");
	});
});
