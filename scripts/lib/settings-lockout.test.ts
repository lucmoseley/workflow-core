// @vitest-environment node
/*
 * A session started in an existing worktree is refused, naming the line and
 * its fix, where that worktree's own `.claude/settings.json` would lock out
 * its every tool call, and admitted otherwise (#4752).
 *
 * Each case runs the real canary line in a throwaway repository holding the
 * real scripts, since the check's verdict is that line's exit. Loosen it and
 * a resumed session meets the harness's bare refusal on every call, with no
 * fix named and no tool left to apply one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKERS_REL } from "./marker-root.js";
import { settingsLockout } from "./settings-lockout.js";
import {
	breakCanaryPath,
	buildLockoutRepo,
	SETTINGS,
} from "./settings-lockout-testkit";

let dir: string;
let repo: ReturnType<typeof buildLockoutRepo>;

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lockout-")));
	repo = buildLockoutRepo(dir);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const markersLeft = (at: string) => {
	const markers = path.join(at, MARKERS_REL);
	return fs.existsSync(markers) ? fs.readdirSync(markers) : [];
};

describe("settingsLockout", () => {
	it("refuses a worktree whose own canary line cannot start, naming the line and the restore", () => {
		const at = repo.cutWorktree("broken", breakCanaryPath);
		const why = settingsLockout(at);
		expect(why).toContain("self-plugin-canray.sh");
		expect(why).toContain("would refuse or stall every tool call");
		expect(why).toContain(
			`\`git -C ${at} checkout origin/main -- ${SETTINGS}\``,
		);
		expect(markersLeft(at)).toEqual([]);
	});

	it("refuses a worktree whose canary line outlives its timeout", () => {
		/* Wall-clock, as the probe kills the line at its registered timeout and
		 * the line runs in `sh`, where no clock seam reaches. */
		const at = repo.cutWorktree("slow", (text) =>
			text
				.replace(/"command": "(.*?)",/, '"command": "sleep 3; $1",')
				.replace(/"timeout": \d+/, '"timeout": 1'),
		);
		expect(settingsLockout(at)).toContain("ran past its 1s timeout");
	});

	it("admits a worktree whose broken line has no onFailure block, which the harness runs past", () => {
		const at = repo.cutWorktree("unblocked", (text) =>
			breakCanaryPath(text).replace(/,\s*"onFailure": "block"/, ""),
		);
		expect(settingsLockout(at)).toBeNull();
	});

	it("refuses a worktree whose line exits 0 with a deny on stdout", () => {
		const deny = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
			},
		});
		const at = repo.cutWorktree("denies", (text) =>
			text.replace(
				/"command": "(.*?)",/,
				`"command": ${JSON.stringify(`echo '${deny}'`)},`,
			),
		);
		expect(settingsLockout(at)).toContain("it denied the call on stdout");
	});

	it("refuses a worktree whose settings will not parse", () => {
		const at = repo.cutWorktree("unparsed", (text) => `${text},`);
		expect(settingsLockout(at)).toContain("does not parse as JSON");
	});

	it("admits a worktree whose edited canary line still lets a loaded session through", () => {
		const at = repo.cutWorktree("edited", (text) =>
			text.replace(/"timeout": \d+/, '"timeout": 20'),
		);
		expect(settingsLockout(at)).toBeNull();
		expect(markersLeft(at)).toEqual([]);
	});

	/* The cases below each remove one of the main checkout's scripts, so each
	 * builds a repo of its own rather than break the one the others share. */
	const without = (name: string, script: string) => {
		const own = path.join(dir, name);
		fs.mkdirSync(own);
		const built = buildLockoutRepo(own);
		fs.rmSync(path.join(built.main, "scripts", script));
		return built;
	};
	const withoutCanary = (name: string) =>
		without(name, "self-plugin-canary.sh");

	it("admits a worktree whose lines are origin/main's without running them", () => {
		const at = withoutCanary("landed").cutWorktree("landed");
		expect(settingsLockout(at)).toBeNull();
		expect(markersLeft(at)).toEqual([]);
	});

	it("admits a worktree whose edited line fails where origin/main's fails too, the fault not its edit's", () => {
		const at = withoutCanary("both").cutWorktree("both", (text) =>
			text.replace(/"timeout": \d+/, '"timeout": 20'),
		);
		expect(settingsLockout(at)).toBeNull();
	});

	it("admits a worktree whose probe marker cannot be written, saying the start goes unchecked", () => {
		const at = without("unmarked", "write-self-plugin-marker.sh").cutWorktree(
			"unmarked",
			breakCanaryPath,
		);
		const said: string[] = [];
		expect(settingsLockout(at, (line) => said.push(line))).toBeNull();
		expect(said).toEqual([
			expect.stringContaining(
				"was not checked, so the start goes ahead unchecked",
			),
		]);
	});
});
