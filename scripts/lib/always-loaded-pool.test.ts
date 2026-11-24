// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIRRORED_FILE, MIRRORED_SECTIONS } from "./machine-mirrored-rules.js";
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

describe("stagedPoolDelta in an adopter (#5683)", () => {
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	};
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	};
	const sections = MIRRORED_SECTIONS.map((h) => `## ${h}\n\nm\n\n`).join("");

	const delta = () => {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir };
		delete env.WFC_ALWAYS_LOADED;
		const r = spawnSync(
			"node",
			[
				"-e",
				"const {stagedPoolDelta}=require(process.argv[1]);" +
					'console.log(JSON.stringify(stagedPoolDelta(["HEAD"])));',
				SCRIPT,
			],
			{ cwd: dir, encoding: "utf8", env },
		);
		return r.stdout.trim();
	};

	beforeEach(() => {
		git("init", "-q");
		writeConfig({ alwaysLoaded: ["CLAUDE.md", MIRRORED_FILE] });
		write("CLAUDE.md", "c".repeat(100));
		write(MIRRORED_FILE, "## Ground truth\n\ng\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
	});

	it("leaves the sections out of the bytes a commit adds", () => {
		write(MIRRORED_FILE, `## Ground truth\n\ng\n\n${sections}`);
		git("add", "-A");
		expect(delta()).toBe("1");
	});
});
