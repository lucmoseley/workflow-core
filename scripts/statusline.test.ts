// @vitest-environment node
/*
 * The status line's concurrency segment (#3319) shows the refill loop's last
 * tick and the 24-hour sustained figure, reads "loop off" for a stale, stopped
 * or missing tick, and spawns no `node` and no `claude` per render.
 *
 * The script is machine-level, at ~/.claude/statusline.sh, so what runs here
 * is its reference copy in docs/claude-user-settings.md; `npm run
 * check:settings` holds it to the live file. A miss here shows a stopped
 * loop as a full machine, or spends a node start on every render of every
 * session.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { copyBlockPattern } from "./lib/settings-copy";

const { buildTickRecord, writeSustained } = require("./lib/concurrency.js");

const DOC = path.resolve(__dirname, "..", "docs", "claude-user-settings.md");
const MINUTE_MS = 60 * 1000;

let dir: string;
let script: string;
let home: string;
let repo: string;
let shims: string;
let spawned: string;

beforeAll(() => {
	const found = fs
		.readFileSync(DOC, "utf8")
		.match(copyBlockPattern("statusline.sh", "```bash"));
	if (!found) throw new Error(`no statusline.sh block in ${DOC}`);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-"));
	script = path.join(dir, "statusline.sh");
	fs.writeFileSync(script, `${found[1]}\n`, { mode: 0o755 });
	// A checkout with scripts/burn-mode.sh, so the workflow-core gate opens.
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(repo, "scripts", "burn-mode.sh"), "");
	shims = path.join(dir, "shims");
	spawned = path.join(dir, "spawned");
	fs.mkdirSync(shims);
	for (const name of ["node", "claude"])
		fs.writeFileSync(
			path.join(shims, name),
			`#!/usr/bin/env bash\necho ${name} >> "${spawned}"\n`,
			{ mode: 0o755 },
		);
});

beforeEach(() => {
	home = fs.mkdtempSync(path.join(dir, "home-"));
	fs.mkdirSync(path.join(home, ".claude"));
	fs.rmSync(spawned, { force: true });
	process.env.WFC_REFILL_DIR = path.join(home, ".claude");
});

afterEach(() => {
	delete process.env.WFC_REFILL_DIR;
	fs.rmSync(home, { recursive: true, force: true });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const admission = (over: Record<string, unknown> = {}) => ({
	slots: 2,
	memorySlots: 1,
	drawNeedMb: 2000,
	load: { overloaded: false },
	cpu: { full: false, slots: 2 },
	memory: { working: { count: 3, mb: 1800 } },
	...over,
});

const tick = (
	agoMs: number,
	{
		decision = { launches: [], skipped: [], idle: null },
		admitted = admission(),
	}: { decision?: object; admitted?: object | null } = {},
) =>
	`${JSON.stringify(
		buildTickRecord({
			input: { now: Date.now() - agoMs, freeSlots: 0, lastPromptAt: null },
			decision,
			admission: admitted,
		}),
	)}\n`;

const writeRecord = (lines: string[], sustained?: number | null) => {
	fs.writeFileSync(
		path.join(home, ".claude", "concurrency.jsonl"),
		lines.join(""),
	);
	if (sustained !== undefined) writeSustained({ sustained, minutesRead: true });
};

/** The concurrency segment of one render, colour codes stripped. */
const render = () => {
	const out = execFileSync("bash", [script], {
		input: JSON.stringify({ workspace: { project_dir: repo } }),
		env: {
			...process.env,
			HOME: home,
			PATH: `${shims}:${process.env.PATH}`,
		},
		encoding: "utf8",
	});
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what is stripped.
	const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
	return plain.match(/Sess .*$/m)?.[0] ?? null;
};

describe("concurrency segment", () => {
	it("shows the last tick's working count, ceiling and binding limit with the 24h figure", () => {
		writeRecord(
			[
				tick(9 * MINUTE_MS),
				tick(MINUTE_MS, { admitted: admission({ memorySlots: 0 }) }),
			],
			4.7,
		);
		expect(render()).toBe("Sess 3/5 · memory · 24h 4.7");
	});

	it("names no limit as none, an unread count as ? and no 24h figure as -", () => {
		writeRecord([tick(MINUTE_MS)], null);
		expect(render()).toBe("Sess 3/5 · none · 24h -");
		writeRecord([tick(MINUTE_MS, { admitted: null })]);
		expect(render()).toBe("Sess ?/? · memory · 24h -");
	});

	it("reads a tick 14 minutes old as live and one 16 minutes old as loop off", () => {
		writeRecord([tick(14 * MINUTE_MS)], 4.7);
		expect(render()).toBe("Sess 3/5 · none · 24h 4.7");
		writeRecord([tick(16 * MINUTE_MS)]);
		expect(render()).toBe("Sess loop off · 24h 4.7");
	});

	it("reads a stop tick as loop off", () => {
		writeRecord([
			tick(MINUTE_MS, { decision: { stop: "explicit", detail: "stopped" } }),
		]);
		expect(render()).toBe("Sess loop off · 24h -");
	});

	it("reads a missing or torn record as loop off", () => {
		expect(render()).toBe("Sess loop off · 24h -");
		writeRecord(['{"at": "2026-'], 2);
		expect(render()).toBe("Sess loop off · 24h 2.0");
	});

	it("shows the 24h figure as ? where the minute record did not read (#3531)", () => {
		writeRecord([tick(MINUTE_MS)]);
		writeSustained({ sustained: null, minutesRead: false });
		expect(render()).toMatch(/ · 24h \?$/);
	});

	it("spawns no node and no claude on a render", () => {
		writeRecord([tick(MINUTE_MS)], 4.7);
		render();
		expect(fs.existsSync(spawned)).toBe(false);
	});
});
