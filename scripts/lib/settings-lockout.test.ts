// @vitest-environment node
/*
 * A session started in an existing worktree is refused, naming the line and
 * its fix, where that worktree's own `.claude/settings.json` would lock out
 * its every tool call, and admitted otherwise (#4752).
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
		expect(why).toContain("would lock out every tool call");
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

	it("admits a worktree whose lines are origin/main's without running them", () => {
		const at = repo.cutWorktree("landed");
		const canary = path.join(repo.main, "scripts", "self-plugin-canary.sh");
		const kept = fs.readFileSync(canary);
		fs.rmSync(canary);
		try {
			expect(settingsLockout(at)).toBeNull();
			expect(markersLeft(at)).toEqual([]);
		} finally {
			fs.writeFileSync(canary, kept, { mode: 0o755 });
		}
	});

	it("admits a worktree whose edited line fails where origin/main's fails too, the fault not its edit's", () => {
		const at = repo.cutWorktree("both", (text) =>
			text.replace(/"timeout": \d+/, '"timeout": 20'),
		);
		const canary = path.join(repo.main, "scripts", "self-plugin-canary.sh");
		const kept = fs.readFileSync(canary);
		fs.rmSync(canary);
		try {
			expect(settingsLockout(at)).toBeNull();
		} finally {
			fs.writeFileSync(canary, kept, { mode: 0o755 });
		}
	});
});
