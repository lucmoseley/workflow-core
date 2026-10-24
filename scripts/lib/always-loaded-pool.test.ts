// @vitest-environment node
/*
 * always-loaded-pool.js's membership (#33): the host's declared `alwaysLoaded`,
 * else the adopter default. Run as the script .husky/pre-commit runs, in a host
 * with the suite's WFC_ALWAYS_LOADED removed, so the config is what is read.
 *
 * .husky/pre-commit triggers the context-budget check on that list: loosen a
 * case here and an adopter's always-loaded file — its own output style, say —
 * grows past the byte cap uncounted and unwarned.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.resolve(__dirname, "always-loaded-pool.js");

let dir: string;
beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-pool-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function pool() {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir };
	delete env.WFC_ALWAYS_LOADED;
	const r = runInProcess(SCRIPT, [], { env });
	return { ...r, lines: r.stdout.split("\n").filter(Boolean) };
}

const writeConfig = (config: object) => {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify(config),
	);
};

describe("the always-loaded pool's files", () => {
	it("are CLAUDE.md and AGENTS.md where the host declares none", () => {
		const r = pool();
		expect([r.status, r.lines]).toEqual([0, ["CLAUDE.md", "AGENTS.md"]]);
	});

	it("are the declared list, in its order, where the host declares one", () => {
		writeConfig({
			alwaysLoaded: [".claude/output-styles/mine.md", "CLAUDE.md"],
		});
		const r = pool();
		expect([r.status, r.lines]).toEqual([
			0,
			[".claude/output-styles/mine.md", "CLAUDE.md"],
		]);
	});

	it("are empty, not the default, where the host declares an empty list", () => {
		writeConfig({ alwaysLoaded: [] });
		expect(pool().lines).toEqual([]);
	});

	it("fall back to the default on a path leaving the repo, WARNing on stderr naming the alwaysLoaded key", () => {
		writeConfig({ alwaysLoaded: ["../elsewhere.md"] });
		const r = pool();
		expect(r.lines).toEqual(["CLAUDE.md", "AGENTS.md"]);
		expect(r.stderr).toContain(
			'"alwaysLoaded" is not an array of repo-relative paths',
		);
	});

	it("fail on a config that will not read, naming the migration note", () => {
		writeConfig({ contract: 99 });
		const r = pool();
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/declares contract 99.*migration note/);
	});
});
