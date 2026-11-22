// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";

const hookRecord = createRequire(__filename)("./hook-record.js");

const { markersDir } = createRequire(__filename)("./marker-root.js");

const ROOT = path.resolve(__dirname, "../..");
const LIB = path.join(__dirname, "stop-guard.js");

const GUARDS = [
	"scripts/guard-priced-options.js",
	"scripts/guard-inventory.js",
	"scripts/guard-jev-advisory.js",
	"scripts/guard-selection-sum.js",
	"scripts/guard-session-ceiling.js",
	"scripts/guard-uncommitted-work.js",
	"scripts/guard-lost-deny.js",
	"scripts/guard-automode-refusal.js",
	"scripts/guard-unpushed-commits.js",
];

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-guard-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(guard: string, stdin: string, cwd = dir) {
	return runInProcess(path.join(ROOT, guard), [], {
		stdin,
		cwd,
		env: {
			...process.env,
			WFC_REPO_ROOT: dir,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: dir,
		},
	});
}

const DEGENERATE: [string, string][] = [
	["nothing at all", ""],
	["whitespace alone", "   \n  "],
	["text that is not JSON", "not json"],
	["JSON that is not an object", "null"],
	["an object with no session id", "{}"],
	["an empty session id", JSON.stringify({ session_id: "" })],
	["a session id that is not a string", JSON.stringify({ session_id: 7 })],
];

describe.each(GUARDS)("%s", (guard) => {
	it.each(DEGENERATE)("exits 0 and says nothing on %s", (_name, stdin) => {
		const res = run(guard, stdin);
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});

	it("carries no process.exit() and no process.chdir", () => {
		const src = fs.readFileSync(path.join(ROOT, guard), "utf8");
		expect(src).not.toContain("process.exit(");
		expect(src).not.toContain("process.chdir");
	});

	it("reads its payload through lib/stop-guard.js and nowhere else", () => {
		const src = fs.readFileSync(path.join(ROOT, guard), "utf8");
		expect(src).not.toContain("readFileSync(0");
		expect(src).toMatch(/stopGuard\.(onMessage|onMessageAsync|onPayload)\(/);
	});
});

describe("the breadcrumb the runner owns", () => {
	const readCrumb = () => {
		const file = path.join(
			hookRecord.recordsDir(dir),
			".hook-ran-guard-session-ceiling-unknown-session",
		);
		const lines = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim());
		return JSON.parse(lines.at(-1) ?? "");
	};

	it("names no-payload where stdin will not parse", () => {
		run("scripts/guard-session-ceiling.js", "not json");
		expect(readCrumb()).toMatchObject({ outcome: "no-payload" });
	});

	it("names no-session-id on an empty session id, and reads no further", () => {
		run(
			"scripts/guard-session-ceiling.js",
			JSON.stringify({ hook_event_name: "Stop", session_id: "" }),
		);
		expect(readCrumb()).toMatchObject({ outcome: "no-session-id" });
	});
});

describe("the counter lands at the repo root, whatever the cwd is", () => {
	const defective = JSON.stringify({
		session_id: "s-counter",
		hook_event_name: "Stop",
		last_assistant_message: "❓ **Q1** - **X**: pick one.",
		transcript_path: "/nonexistent/absent.jsonl",
	});

	it("writes it under WFC_REPO_ROOT, not under the working directory", () => {
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "stop-guard-cwd-"));
		try {
			const res = run("scripts/guard-priced-options.js", defective, elsewhere);
			expect(JSON.parse(res.stdout).decision).toBe("block");
			expect(
				fs.existsSync(
					path.join(markersDir(dir), ".priced-options-nagged-s-counter"),
				),
			).toBe(true);
			expect(
				fs.existsSync(
					path.join(markersDir(elsewhere), ".priced-options-nagged-s-counter"),
				),
			).toBe(false);
		} finally {
			fs.rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

describe("a review that throws", () => {
	function throwing(entry: "onMessage" | "onPayload") {
		const file = path.join(dir, `throwing-${entry}.js`);
		fs.writeFileSync(
			file,
			`require(${JSON.stringify(LIB)}).${entry}({ review() { throw new Error("boom"); } });\n`,
		);
		return runInProcess(file, [], {
			stdin: JSON.stringify({
				session_id: "s-throw",
				hook_event_name: "Stop",
				last_assistant_message: "anything",
			}),
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: dir },
		});
	}

	it.each(["onMessage", "onPayload"] as const)(
		"is swallowed by %s, which still exits 0 and says nothing",
		(entry) => {
			const res = throwing(entry);
			expect(res.status).toBe(0);
			expect(res.stdout.trim()).toBe("");
		},
	);
});
