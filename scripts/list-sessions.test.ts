// @vitest-environment node
/*
 * list-sessions.js prints every plan's sessions, each under its config dir,
 * and names a dir it could not read rather than dropping it (#4224). A fake
 * `claude` on WFC_CLAUDE_BIN answers per CLAUDE_CONFIG_DIR.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClaudeStub } from "./lib/claude-stub";
import { writeHeadlessRun } from "./lib/headless-runs-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "list-sessions.js");

let dir = "";
let own = "";
let a = "";
let b = "";

const listing = (...names: string[]) =>
	JSON.stringify(
		names.map((name, i) => ({
			pid: 100 + i,
			sessionId: `id-${name}`,
			name,
			state: "working",
			kind: "background",
		})),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-sessions-"));
	own = path.join(dir, "own");
	a = path.join(dir, "seat-a");
	b = path.join(dir, "seat-b");
	for (const d of [own, a, b]) fs.mkdirSync(d);
	writeClaudeStub(
		path.join(dir, "claude"),
		[
			`case "$CLAUDE_CONFIG_DIR" in`,
			`  ${shellQuote(a)}) echo ${shellQuote(listing("on-a"))} ;;`,
			`  ${shellQuote(b)}) [ -e ${shellQuote(path.join(dir, "b-fails"))} ] && exit 4; echo ${shellQuote(listing("on-b"))} ;;`,
			`  *) echo ${shellQuote(listing("on-own"))} ;;`,
			"esac",
		],
		0,
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
	return runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: own,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CODE_SESSION_ID: "",
			WFC_CLAUDE_BIN: path.join(dir, "claude"),
			WFC_CLAUDE_CONFIG_A: a,
			WFC_CLAUDE_CONFIG_B: b,
			WFC_CLAUDE_CONFIG_C: path.join(dir, "no-such-seat"),
			WFC_REFILL_DIR: path.join(dir, "refill"),
		},
	});
}

describe("list-sessions (#4224)", () => {
	it("lists every seat's sessions and each live headless run, each with its dir", () => {
		writeHeadlessRun(path.join(dir, "refill"), "0123abcd", "id-run", {
			seat: b,
		});
		const r = run("--json");
		expect(r.status).toBe(0);
		const { rows, failures } = JSON.parse(r.stdout);
		expect(failures).toEqual([]);
		expect(
			rows.map((x: { configDir: string; name: string; id: string }) => [
				x.configDir,
				x.name ?? x.id,
			]),
		).toEqual([
			[own, "on-own"],
			[a, "on-a"],
			[b, "on-b"],
			[b, "0123abcd"],
		]);
	});

	it("names a dir that will not read and exits non-zero, still printing the rest", () => {
		fs.writeFileSync(path.join(dir, "b-fails"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(`${a}\ton-a\tworking\tbackground`);
		expect(r.stdout).not.toContain("on-b");
		expect(r.stderr).toContain(`✗ ${b}: `);
		expect(r.stderr).toContain("exit 4");
	});

	it("refuses an unknown flag with exit 2, reading nothing", () => {
		const r = run("--jsn");
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("unknown flag: --jsn");
	});
});
