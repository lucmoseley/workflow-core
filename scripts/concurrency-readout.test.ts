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
 * watch reads, tick or live, is lib/concurrency.test.ts's.
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

const SCRIPT = path.resolve(__dirname, "concurrency-readout.js");
/* lib/concurrency.js's silence bound, past which a tick reads stale. */
const STALE_MS = 15 * 60 * 1000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrency-readout-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The readout over a machine running one claimed pair, `abc`, that a
 * listing of this session alone does not name; `refused` fails the listing. */
const run = ({ refused = false } = {}) => {
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill, { recursive: true });
	fs.writeFileSync(
		path.join(refill, "concurrency.jsonl"),
		`${JSON.stringify({
			at: new Date(Date.now() - 2 * STALE_MS).toISOString(),
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
	return runInProcess(SCRIPT, [], {
		env: {
			...process.env,
			...buildIsolatedEnv(dir),
			WFC_REFILL_DIR: refill,
			MEMWATCH_MINUTE_LOG: path.join(dir, "no-minutes.jsonl"),
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
				buildAgentsBranch(
					refused
						? null
						: [buildJobRow("self", "working", { sessionId: SELF, cwd: host })],
				),
			]),
			CLAUDE_PROJECT_DIR: host,
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
});
