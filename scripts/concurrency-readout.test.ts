// @vitest-environment node
/*
 * concurrency-readout.js's unlisted watch with the refill loop off (#3496):
 * its newest tick is stale, so the watch reads admission live. A break here
 * leaves a session admission cannot see unraised while the loop is off,
 * which it is unless being tested (#3215).
 *
 * The program runs in-process over a refill record holding a stale tick, and
 * spawns the real admission.js over fake `ps`, `/proc`, `claude` and meminfo,
 * so its live read finds one claimed pair that no listing names. Which row the
 * watch reads, tick or live, is lib/concurrency.test.ts's. It also pins the
 * precomputed 24-hour file the status line reads (#3498).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildIsolatedEnv,
	SELF,
	writeHostRepo,
	writeProcRoot,
} from "./lib/admission-testkit";
import { buildAgentsBranch, buildJobRow } from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { buildMeminfo } from "./lib/meminfo-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process";

const { STALE_MS } = require("./lib/concurrency.js");

const SCRIPT = path.resolve(__dirname, "concurrency-readout.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrency-readout-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The readout over a machine running one claimed pair, `abc`, that a
 * listing of this session alone does not name; `refused` fails the listing,
 * `empty` runs outside any session over an empty one, and `fresh` seeds a
 * fresh tick. */
const run = ({ refused = false, empty = false, fresh = false } = {}) => {
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill, { recursive: true });
	fs.writeFileSync(
		path.join(refill, "concurrency.jsonl"),
		`${JSON.stringify({
			at: new Date(Date.now() - (fresh ? 0 : 2 * STALE_MS)).toISOString(),
			working: 1,
			ceiling: 2,
			binding: null,
			also: [],
			memory: { unlisted: { count: 0, mb: 0, dirs: [] } },
		})}\n`,
	);
	const meminfo = path.join(dir, "meminfo");
	fs.writeFileSync(
		meminfo,
		buildMeminfo({ availableMb: 4000, swapTotalMb: 2048, swapFreeMb: 2048 }),
	);
	const host = writeHostRepo(dir, {});
	const rows = empty
		? []
		: [buildJobRow("self", "working", { sessionId: SELF, cwd: host })];
	return runInProcess(SCRIPT, [], {
		env: {
			...process.env,
			...buildIsolatedEnv(dir),
			WFC_REFILL_DIR: refill,
			MEMWATCH_MINUTE_LOG: path.join(dir, "minutes.jsonl"),
			WFC_MEMINFO: meminfo,
			WFC_PS: writePsStub(dir, [
				"111 300000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
				"110 100000 claude bg-pty-host --bg-pty-host /tmp/x/spare/abc.pty.sock 200 50 --",
			]),
			WFC_PROC: writeProcRoot(dir, {
				pss: { "111": 300 * 1024, "110": 100 * 1024 },
				cwds: { "111": "/home/u/repo" },
			}),
			WFC_CLAUDE_BIN: writeClaudeStub(path.join(dir, "claude"), [
				buildAgentsBranch(refused ? null : rows),
			]),
			CLAUDE_PROJECT_DIR: host,
			...(empty ? { CLAUDE_CODE_SESSION_ID: "" } : {}),
		},
	});
};

describe("the unlisted watch with the loop off (#3496)", () => {
	it("prints the line off admission read now", () => {
		const r = run();
		expect(r.stdout).toContain(
			"unlisted:  1 session(s) outside admission's listing hold 400 MB now, charged no draw headroom (#2502)",
		);
		expect(r.status).toBe(0);
	});

	it("prints unknown where admission's listing was refused", () => {
		const r = run({ refused: true });
		expect(r.stdout).toMatch(/^unlisted: {2}unknown now — session listing: /m);
		expect(r.status).toBe(0);
	});

	it("prints unknown where admission's listing is empty and unvouched (#3504)", () => {
		const r = run({ empty: true });
		expect(r.stdout).toMatch(
			/^unlisted: {2}unknown now — session listing: empty and unvouched/m,
		);
		expect(r.stdout).not.toContain("outside admission's listing");
		expect(r.status).toBe(0);
	});
});

describe("the sustained figure the status line reads (#3498)", () => {
	const sustainedFile = () =>
		fs.readFileSync(path.join(dir, "refill", "concurrency-24h"), "utf8");

	it("writes the 24-hour figure and prints it", () => {
		const at = (ago: number) => new Date(Date.now() - ago).toISOString();
		fs.writeFileSync(
			path.join(dir, "minutes.jsonl"),
			[
				{ ts: at(10 * 60 * 1000), sessions: 3 },
				{ ts: at(5 * 60 * 1000), sessions: 3 },
			]
				.map((m) => `${JSON.stringify(m)}\n`)
				.join(""),
		);
		const r = run({ fresh: true });
		expect(sustainedFile()).toBe("3.0\n");
		expect(r.stdout).toMatch(/^sustained: 3\.0 over the last 24 h /m);
		expect(r.status).toBe(0);
	});

	it("writes `-` where no session was recorded working", () => {
		fs.writeFileSync(
			path.join(dir, "minutes.jsonl"),
			`${JSON.stringify({ ts: new Date().toISOString(), sessions: 0 })}\n`,
		);
		const r = run({ fresh: true });
		expect(sustainedFile()).toBe("-\n");
		expect(r.stdout).toMatch(
			/^sustained: no session recorded working over the last 24 h$/m,
		);
		expect(r.status).toBe(0);
	});

	it("writes `?` and prints unread where the minute record is missing (mantahostels#1206)", () => {
		const r = run({ fresh: true });
		expect(sustainedFile()).toBe("?\n");
		expect(r.stdout).toMatch(
			/^sustained: unread over the last 24 h — memwatch's minute record did not read$/m,
		);
		expect(r.status).toBe(0);
	});
});
