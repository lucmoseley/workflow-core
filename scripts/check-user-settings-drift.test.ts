// @vitest-environment node
/*
 * Pins that a switched `model` never reads as settings drift while any other
 * key still does, and where the snapshot is found when no path is given.
 *
 * check-user-settings-drift.js compares a doc snapshot against a live settings
 * file, exercised against fixtures in a temp directory rather than against this
 * machine's real ~/.claude.
 *
 * Scope: VOLATILE_KEYS — `model` must never register as drift, in either
 * direction — and where the snapshot is found with no argument (#447) — and that
 * the browser-profile guard's copy is held to the live hook (#1547), and the
 * user-level CLAUDE.md's to the live file through its own fence (#2174). The
 * ordinary match/drift paths are covered incidentally.
 *
 * It warns from `.husky/pre-commit` on every commit, so a loosened case either
 * fires on every model switch or lets real drift go unsaid.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-user-settings-drift.js");

let dir: string;

/**
 * A doc with a ```json snapshot block and the two bash blocks, and no
 * CLAUDE.md block, so it reads as a snapshot predating #2174.
 */
const doc = (settings: object) =>
	[
		"# Snapshot",
		"",
		"```json",
		JSON.stringify(settings, null, 2),
		"```",
		"",
		"<!-- BEGIN statusline.sh -->",
		"```bash",
		"echo hi",
		"```",
		"<!-- END statusline.sh -->",
		"",
		"<!-- BEGIN browser-profile-guard.sh -->",
		"```bash",
		"exit 0",
		"```",
		"<!-- END browser-profile-guard.sh -->",
		"",
	].join("\n");

/** Run the checker over a doc/live pair; returns exit status and output. */
const run = (
	docSettings: object,
	liveSettings: object,
	docText = doc(docSettings),
) => {
	const docPath = path.join(dir, "snapshot.md");
	const livePath = path.join(dir, "settings.json");
	fs.writeFileSync(docPath, docText);
	fs.writeFileSync(livePath, JSON.stringify(liveSettings, null, 2));
	// The script resolves every file copy from $HOME with no override, so point
	// HOME at the fixture dir; absent there, each is reported and not compared.
	const r = runInProcess(SCRIPT, [docPath, livePath], {
		env: { ...process.env, HOME: dir },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-drift-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("VOLATILE_KEYS", () => {
	it("ignores model present in the doc but absent from live, the drift 54488ffcb stopped", () => {
		const { status, out } = run(
			{ theme: "dark", model: "claude-fable-5[1m]" },
			{ theme: "dark" },
		);
		expect(status).toBe(0);
		expect(out).toMatch(/^OK:/m);
		expect(out).not.toMatch(/model/);
	});

	it("ignores model present in live but absent from the doc", () => {
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark", model: "claude-opus-5" },
		);
		expect(status).toBe(0);
		expect(out).toMatch(/^OK:/m);
	});

	it("ignores model differing on both sides", () => {
		const { status } = run(
			{ theme: "dark", model: "claude-fable-5[1m]" },
			{ theme: "dark", model: "claude-opus-5" },
		);
		expect(status).toBe(0);
	});

	it("still reports drift in a non-volatile key alongside a differing model", () => {
		// Excluding model must not mask a real difference in the same object.
		const { status, out } = run(
			{ theme: "dark", model: "claude-fable-5[1m]" },
			{ theme: "light", model: "claude-opus-5" },
		);
		expect(status).toBe(1);
		expect(out).toMatch(/theme/);
		expect(out).not.toMatch(/model/);
	});

	it("exits 0 on drift when --warn is passed, reporting it on a WARN: line", () => {
		const docPath = path.join(dir, "snapshot.md");
		const livePath = path.join(dir, "settings.json");
		fs.writeFileSync(docPath, doc({ theme: "dark" }));
		fs.writeFileSync(livePath, JSON.stringify({ theme: "light" }));
		const r = spawnSync("node", [SCRIPT, "--warn", docPath, livePath], {
			encoding: "utf8",
			env: { ...process.env, HOME: dir },
		});
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toMatch(/^WARN:/m);
	});
});

describe("the browser-profile guard's copy (#1547)", () => {
	const writeGuard = (body: string) => {
		fs.mkdirSync(path.join(dir, ".claude", "hooks"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "hooks", "browser-profile-guard.sh"),
			body,
		);
	};

	it("matches a live guard identical to the doc's copy", () => {
		writeGuard("exit 0\n");
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(0);
		expect(out).toMatch(/browser-profile-guard\.sh 1 lines/);
	});

	it("reports a live guard that has moved on from the doc's copy", () => {
		writeGuard("exit 1\n");
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(1);
		expect(out).toMatch(/browser-profile-guard\.sh: doc copy differs/);
	});

	it("reports a snapshot predating the guard's block as drift, not broken", () => {
		writeGuard("exit 0\n");
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			doc({ theme: "dark" }).replace(
				/<!-- BEGIN browser-profile-guard[\s\S]*$/,
				"",
			),
		);
		expect(status).toBe(1);
		expect(out).toMatch(/has no copy in/);
	});
});

describe("the user-level CLAUDE.md's copy (#2174)", () => {
	// Fences and headings of its own: a ``` line must not close the block.
	const notes = [
		"# Machine notes",
		"",
		"## Node heap",
		"",
		"```bash",
		"echo $NODE_OPTIONS",
		"```",
	].join("\n");
	const withBlock = (body: string) =>
		[
			doc({ theme: "dark" }),
			"<!-- BEGIN CLAUDE.md -->",
			"````markdown",
			body,
			"````",
			"<!-- END CLAUDE.md -->",
			"",
		].join("\n");
	const writeLive = (body: string) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), body);
	};

	it("matches a live file holding fences and headings identical to the doc's copy", () => {
		writeLive(`${notes}\n`);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(0);
		expect(out).toMatch(/CLAUDE\.md 7 lines/);
	});

	it("reports one changed byte in the live file", () => {
		writeLive(`${notes.replace("heap", "heaq")}\n`);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(1);
		expect(out).toMatch(/CLAUDE\.md: doc copy differs .*line 3/);
	});

	it("reports a snapshot predating the block as drift, not broken", () => {
		writeLive(`${notes}\n`);
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(1);
		expect(out).toMatch(/CLAUDE\.md: .* has no copy in/);
	});

	it("leaves the copy uncompared where the live file is absent", () => {
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(0);
		expect(out).toMatch(/CLAUDE\.md absent \(not compared\)/);
	});
});

describe("the snapshot path with no argument (#447)", () => {
	/** Run with no doc argument, in `dir` as the host root. */
	const runHost = (config?: object) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		if (config)
			fs.writeFileSync(
				path.join(dir, ".claude", "workflow-core.json"),
				JSON.stringify(config),
			);
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ theme: "dark" }),
		);
		const r = runInProcess(SCRIPT, [], {
			cwd: dir,
			env: { ...process.env, HOME: dir, CLAUDE_PROJECT_DIR: dir },
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	};
	const place = (rel: string) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), doc({ theme: "dark" }));
	};

	it("reads the default path where none is declared", () => {
		place("docs/claude-user-settings.md");
		const { status, out } = runHost();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: docs\/claude-user-settings\.md matches/m);
	});

	it("skips where none is declared and the default is absent", () => {
		const { status, out } = runHost();
		expect(status).toBe(0);
		expect(out).toMatch(
			/^SKIP: this repo has no docs\/claude-user-settings\.md/m,
		);
	});

	it("reads the host's declared userSettingsSnapshotPath", () => {
		place("docs/machinery/claude-user-settings.md");
		const { status, out } = runHost({
			userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
		});
		expect(status).toBe(0);
		expect(out).toMatch(
			/^OK: docs\/machinery\/claude-user-settings\.md matches/m,
		);
	});

	it("reports a declared path that does not exist as broken, not a skip", () => {
		const { status, out } = runHost({
			userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
		});
		expect(status).toBe(2);
		expect(out).not.toMatch(/^SKIP/m);
		expect(out).toContain("docs/machinery/claude-user-settings.md not found");
		expect(out).toContain("userSettingsSnapshotPath");
	});

	it("reports a refused declaration as broken, not a skip of the default", () => {
		const { status, out } = runHost({
			userSettingsSnapshotPath: "/abs/claude-user-settings.md",
		});
		expect(status).toBe(2);
		expect(out).not.toMatch(/^SKIP/m);
		expect(out).toContain(
			'"userSettingsSnapshotPath" is not a repo-relative path',
		);
	});
});
