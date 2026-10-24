// @vitest-environment node
/*
 * The SHAPE of a Stop guard, asserted once for all six of them (mantahostels#1798, mantahostels#2299).
 *
 * The three rules the shape carries — fail open, exit 0, resolve the counter
 * path against the repo root and not the cwd — held by prose agreement across
 * four files rather than by test.
 *
 * Black-box (§X3): every case drives the real guard end to end with a payload
 * on stdin and its repo root pointed at a throwaway directory, so a run never
 * mints a counter or a breadcrumb in the shared tree — bar "a review that
 * throws" below, which drives `lib/stop-guard.js` itself rather than a guard.
 *
 * Breaking a case here means a Stop guard can end a session outright, which is
 * the failure the whole family is built to avoid.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";

/* The breadcrumb directory, from the module that owns it (mantahostels#3382). */
const hookRecord = createRequire(__filename)("./hook-record.js");

/* The block counter lives under gr_markers_dir (.claude/tmp/markers), not
 * the repo root itself — hook-block.js's counterPath (mantahostels#3515 F8,
 * issue #2). */
const { markersDir } = createRequire(__filename)("./marker-root.js");

const ROOT = path.resolve(__dirname, "../..");
const LIB = path.join(__dirname, "stop-guard.js");

/** Every Stop guard registered in `.claude/settings.json`. */
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

/**
 * Run a guard with `stdin` on its stdin. `cwd` defaults to a directory that is
 * NOT the repo root, so anything the guard resolves off the cwd shows up.
 */
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

/* Every payload that answers no question the guard can act on. */
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

	/* §N6, whose mechanism `lib/stop-guard.js`'s header carries. The CALL is the
	 * hazard — it drops whatever node has buffered for a pipe. `process.exitCode`
	 * drops nothing, and guard-lost-deny.js's `replay` subcommand needs it to
	 * signal a usage error, so the needle is the open paren (mantahostels#2299). */
	it("carries no process.exit() and no process.chdir", () => {
		const src = fs.readFileSync(path.join(ROOT, guard), "utf8");
		expect(src).not.toContain("process.exit(");
		expect(src).not.toContain("process.chdir");
	});

	/* The prologue is the runner's, not the guard's: a guard reading stdin by
	 * hand bypasses hook-message.js's "whitespace-only counts as empty" rule and
	 * its breadcrumb (mantahostels#872), which is the drift mantahostels#1798 found. */
	it("reads its payload through lib/stop-guard.js and nowhere else", () => {
		const src = fs.readFileSync(path.join(ROOT, guard), "utf8");
		expect(src).not.toContain("readFileSync(0");
		expect(src).toMatch(/stopGuard\.(onMessage|onMessageAsync|onPayload)\(/);
	});
});

describe("the breadcrumb the runner owns", () => {
	/* guard-session-ceiling.js is one of the two that opt in to `record`
	 * (guard-lost-deny.js is the other), and stands for both here. The two
	 * outcomes below are the runner's own — every later one is written inside the
	 * guard, so reading them here proves the prologue crumbs before it hands
	 * over, and names the right outcome rather than falling through to the
	 * guard's first check (mantahostels#872's vocabulary). */
	const crumb = () => {
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
		expect(crumb()).toMatchObject({ outcome: "no-payload" });
	});

	it("names no-session-id on an empty session id, and reads no further", () => {
		run(
			"scripts/guard-session-ceiling.js",
			JSON.stringify({ hook_event_name: "Stop", session_id: "" }),
		);
		expect(crumb()).toMatchObject({ outcome: "no-session-id" });
	});
});

describe("the counter lands at the repo root, whatever the cwd is", () => {
	/* guard-priced-options.js is the one that blocks on a payload alone, with no
	 * git state and no transcript behind it. */
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
			// exempt (mantahostels#2082): Block reason for this exact payload ("❓ **Q1** - **X**: pick one.")
			// is pinned by guard-priced-options.test.ts's own `blocked` cases —
			// this test is only about where the counter file lands.
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
	/**
	 * Drive the runner directly, with a review that cannot succeed. Written to a
	 * throwaway script rather than `node -e`, so runInProcess has a file to load
	 * — the inline form has no path on disk for it to resolve (mantahostels#2309). Kept on
	 * runInProcess rather than exempted under the lib/** allowance: this still
	 * asserts the real process-level swallow, only through a fixture entry point
	 * instead of a guard's own. Residual: the fixture file lands inside `dir`,
	 * the same directory standing in for WFC_REPO_ROOT.
	 */
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
