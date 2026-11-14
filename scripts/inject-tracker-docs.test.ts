// @vitest-environment node
/*
 * The boundary set of scripts/inject-tracker-docs.js, the UserPromptSubmit
 * and SessionStart hook entry (#5151). Every routing, rule-text
 * and de-duplication branch is a module case on the core,
 * scripts/lib/inject-tracker-docs.test.ts. Broken, every tracker command a
 * session types may arrive without its rules, or twice, or hang its prompt.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { registrationsOf } from "./lib/hook-wiring";
import { runInProcess } from "./lib/run-in-process.js";
import { readJsConst } from "./lib/shell-const-testkit";

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "scripts", "inject-tracker-docs.js");
const TAKES_GH_TIMEOUT_S = readJsConst(
	path.join(ROOT, "scripts", "lib", "inject-tracker-docs-host.js"),
	"TAKES_GH_TIMEOUT_S",
);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "inject-entry-"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/* `gh` and the tier hook are pointed at nothing unless a case sets them. */
const ENV = {
	...process.env,
	CLAUDE_PROJECT_DIR: ROOT,
	CLAUDE_JOB_DIR: "",
	CLAUDE_CODE_SESSION_ID: "",
	TMPDIR: SCRATCH,
	CLAUDE_CONFIG_DIR: SCRATCH,
	WFC_GH: "false",
	WFC_REVIEW_TIER_HOOK: path.join(SCRATCH, "no-tier-hook"),
};

/** The entry run in-process on `stdin`. */
const entry = (stdin: string, env: Record<string, string> = {}) =>
	runInProcess(HOOK, [], { stdin, env: { ...ENV, ...env } });

/** The context a hook output hands the session. */
const contextOf = (stdout: string): string =>
	JSON.parse(stdout).hookSpecificOutput.additionalContext;

describe("the entry's input channels", () => {
	it("reads a typed command off UserPromptSubmit's stdin and answers as a hook", () => {
		const r = entry(
			JSON.stringify({
				prompt: "/implement 5151",
				hook_event_name: "UserPromptSubmit",
			}),
		);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
			"UserPromptSubmit",
		);
		expect(contextOf(r.stdout)).toContain("You invoked /implement");
	});

	it("reads a background job's command off its state.json at SessionStart", () => {
		const job = fs.mkdtempSync(path.join(SCRATCH, "job-"));
		fs.writeFileSync(
			path.join(job, "state.json"),
			JSON.stringify({ intent: "/wayfinder 186" }),
		);
		const r = entry(JSON.stringify({ hook_event_name: "SessionStart" }), {
			CLAUDE_JOB_DIR: job,
		});
		expect(r.status).toBe(0);
		expect(contextOf(r.stdout)).toContain("You invoked /wayfinder");
	});

	it.each(["not json", ""])(
		"exits 0 printing nothing on an unreadable payload (%j)",
		(stdin) => {
			const r = entry(stdin);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		},
	);

	it("prints the context bare for an event that reads plain stdout", () => {
		const r = entry(JSON.stringify({ prompt: "/triage 1" }));
		expect(r.status).toBe(0);
		expect(r.stdout.startsWith("You invoked /triage")).toBe(true);
	});
});

describe("the entry's fail-open (§N5, §X11 item 4)", () => {
	it("exits 0 printing nothing, the core's throw logged, where the marker directory cannot be searched", () => {
		/* The marker directory a first firing makes, its search permission
		 * then taken: the core's stat of the session's marker throws EACCES,
		 * past every catch of its own. */
		const tmp = fs.mkdtempSync(path.join(SCRATCH, "unsearchable-"));
		const fire = (session: string) =>
			entry(
				JSON.stringify({
					prompt: "/implement 5203",
					hook_event_name: "UserPromptSubmit",
					session_id: session,
				}),
				{ TMPDIR: tmp, CLAUDE_CONFIG_DIR: tmp },
			);
		expect(fire("first").status).toBe(0);
		const [markers, ...more] = fs
			.readdirSync(tmp)
			.filter((n) => n.startsWith("wfc-tracker-inject-"))
			.map((n) => path.join(tmp, n));
		expect(more).toHaveLength(0);
		if (!markers) throw new Error("the first firing made no marker directory");
		fs.chmodSync(markers, 0o600);
		try {
			const r = fire("unsearchable");
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(readGuardErrorsLog(tmp)).toMatch(
				/\tinject-tracker-docs\tinject-tracker-docs threw\tError: EACCES: permission denied, stat '[^']*unsearchable\.implement'/,
			);
		} finally {
			fs.chmodSync(markers, 0o700);
		}
	});
});

describe("the SessionStart/UserPromptSubmit double-fire (mantahostels#1117)", () => {
	it("lets exactly one of two concurrent firings through", async () => {
		const both = await Promise.all(
			["SessionStart", "UserPromptSubmit"].map(
				(event) =>
					new Promise<string>((resolve) => {
						// spawn-kept: two processes at once — only real processes can race the marker (§X3).
						execFile(HOOK, { env: ENV }, (_err, stdout) =>
							resolve(stdout),
						).stdin?.end(
							JSON.stringify({
								prompt: "/implement 1117",
								hook_event_name: event,
								session_id: "concurrent-pair",
							}),
						);
					}),
			),
		);
		expect(both.filter((o) => o.trim() !== "")).toHaveLength(1);
	});
});

describe("a command typed on an issue labelled for another (#1164)", () => {
	it("gives up on a hung gh at a 1 s give-up the test sets, injecting the usual payload", async () => {
		const slow = stubGhScript(
			path.join(SCRATCH, "slow"),
			"#!/bin/sh\nexec sleep 30\n",
		);
		const fire = (env: Record<string, string>) =>
			new Promise<string>((resolve) => {
				// spawn-kept: the kill of a real hung gh child, which only a process shows.
				execFile(HOOK, { env: { ...ENV, ...env } }, (_err, stdout) =>
					resolve(stdout),
				).stdin?.end(
					JSON.stringify({
						prompt: "/wayfinder 7",
						hook_event_name: "UserPromptSubmit",
					}),
				);
			});
		// §X9: a kill of a real hung gh, through a 1 s give-up so load cannot eat
		// the margin (#2268); a hook that never gave up outruns the case's 15 s.
		// Residual: a hook ignoring the seam falls back to 4 s and passes too.
		const hung = await fire({ WFC_GH: slow.gh, WFC_TAKES_GH_TIMEOUT_S: "1" });
		expect(contextOf(hung)).toBe(contextOf(await fire({})));
	}, 15_000);

	it("gives up on gh inside every timeout the self-plugin and the plugin manifest register", () => {
		for (const file of [
			path.join(ROOT, "self-plugin", "hooks", "hooks.json"),
			path.join(ROOT, "hooks", "hooks.json"),
		]) {
			const settings = JSON.parse(fs.readFileSync(file, "utf8"));
			const wired = (["UserPromptSubmit", "SessionStart"] as const).flatMap(
				(event) => registrationsOf(event, "inject-tracker-docs.js", settings),
			);
			expect(wired.length, file).toBeGreaterThan(0);
			for (const { timeout } of wired) {
				expect(
					timeout,
					`${file} registers the hook with no timeout`,
				).toBeDefined();
				expect(TAKES_GH_TIMEOUT_S, file).toBeLessThan(timeout as number);
			}
		}
	});
});
