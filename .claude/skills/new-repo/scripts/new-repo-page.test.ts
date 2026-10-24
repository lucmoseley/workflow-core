// @vitest-environment node
/*
 * docs/new-repo.md, the founder's page on /new-repo, quotes the script in three
 * places only — `/new-repo`, `--resume <name>` and the meaning of exits 0, 1
 * and 2 (#724) — and gives one line to each module. Each is held to what the
 * script or the config prints or states, so a change there fails here until the
 * page follows.
 *
 * The two driven cases stop in the script's input check, before preflight's
 * first `gh` call, so they need no stub and run in process (§X3).
 *
 * Loosen a case and the page can hand the founder a command, an exit meaning or
 * a module the script no longer has, with nothing else to catch it — the suite
 * is the only check on the page.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";
import { MODULES } from "../../../../scripts/lib/workflow-core-config.js";

const ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(__dirname, "new-repo.js");
const PAGE = fs.readFileSync(path.join(ROOT, "docs/new-repo.md"), "utf8");

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the script with HOME at a fresh folder, where `~/<name>` resolves. */
function run(args: string[], seed?: (home: string) => void) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-page-"));
	made.push(home);
	seed?.(home);
	return runInProcess(SCRIPT, args, {
		cwd: ROOT,
		env: { ...process.env, HOME: home },
	});
}

describe("docs/new-repo.md quotes the script correctly", () => {
	it("quotes nothing but `/new-repo` and `--resume <name>`", () => {
		const spans = new Set([...PAGE.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
		expect([...spans].sort()).toEqual(["--resume <name>", "/new-repo"]);
	});

	it("names `/new-repo`, the command the skill defines", () => {
		const skill = fs.readFileSync(path.join(__dirname, "../SKILL.md"), "utf8");
		expect(skill).toMatch(/^name: new-repo$/m);
		expect(PAGE).toContain("`/new-repo`");
	});

	it("gives the re-run form a stopped run prints", () => {
		const saved = {
			name: "tides",
			repo: "lucmoseley/tides",
			prefix: "td",
			idea: "A tide-table app.",
			oneLiner: "Tide tables for surfers",
			title: "tides: tide tables",
			corpus: [],
			specUrl: null,
			source: null,
		};
		const r = run(["--resume", "tides", "--prefix", "tx"], (home) => {
			fs.mkdirSync(path.join(home, "tides/.git"), { recursive: true });
			fs.writeFileSync(
				path.join(home, "tides/.git/new-repo.json"),
				JSON.stringify(saved),
			);
		});
		expect(r.status).toBe(2);
		expect(r.stdout).toContain("\nManual step: ");
		const rerun = r.stdout.match(/^Then re-run: .*$/m)?.[0];
		expect(rerun?.replace(/ tides$/, " <name>")).toMatch(/ --resume <name>$/);
		expect(PAGE).toContain("`--resume <name>`");
	});

	it("sends a run with nothing saved back to `/new-repo`", () => {
		const r = run(["--resume", "tides"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(/^Then start again: \/new-repo$/m);
		expect(PAGE).toContain("start again with `/new-repo`");
	});

	it("states each exit code's meaning as the script does", () => {
		const header = fs
			.readFileSync(SCRIPT, "utf8")
			.replace(/\n \* ?/g, " ")
			.match(/Exits 0 (.+?) \/ 1 (.+?) \/ 2 (.+?) \(#/);
		expect(header).not.toBeNull();
		const meanings = Object.fromEntries(
			[...PAGE.matchAll(/^- \*\*([012])\*\* — (.+)$/gm)].map((m) => [
				m[1],
				m[2],
			]),
		);
		expect(meanings).toEqual({
			0: header?.[1],
			1: header?.[2],
			// The page speaks to the founder; the header speaks about them.
			2: header?.[3].replace("the founder acts", "you act"),
		});
	});

	it("gives one line to each module the config knows", () => {
		const section = PAGE.split("## Changing modules later")[1].split(
			"\n## ",
		)[0];
		const named = [...section.matchAll(/^- \*\*(\w+)\*\* — /gm)].map(
			(m) => m[1],
		);
		expect(named).toEqual([...MODULES]);
	});
});
