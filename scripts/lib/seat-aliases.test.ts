// The founder's agents-view aliases, read off his .bashrc (#5293).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	aliasFor,
	parseSeatAliases,
	readSeatAliases,
	withWaitingAliases,
} from "./seat-aliases.js";

const HOME = "/home/u";

const BASHRC = [
	"# --- three Claude plans, one repo ---",
	"alias manta1='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude  _wfc_agents)'",
	"alias manta2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 _wfc_agents)'",
	"alias cl2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 claude)'",
	"alias wc2='(cd ~/workflow-core && CLAUDE_CONFIG_DIR=$HOME/.claude2 _wfc_agents)'",
	"alias wc3='(cd ~/workflow-core && CLAUDE_CONFIG_DIR=$HOME/.claude3 _wfc_agents)'",
	"alias ll='ls -l'",
].join("\n");

describe("parseSeatAliases", () => {
	it("reads each agents-view alias with its repo and seat, home expanded, and skips any other line", () => {
		expect(parseSeatAliases(BASHRC, HOME)).toEqual([
			{ alias: "manta1", dir: "/home/u/mantahostels", seat: "/home/u/.claude" },
			{
				alias: "manta2",
				dir: "/home/u/mantahostels",
				seat: "/home/u/.claude2",
			},
			{ alias: "wc2", dir: "/home/u/workflow-core", seat: "/home/u/.claude2" },
			{ alias: "wc3", dir: "/home/u/workflow-core", seat: "/home/u/.claude3" },
		]);
	});
});

describe("aliasFor", () => {
	const aliases = parseSeatAliases(BASHRC, HOME);

	it("names the seat's alias for the repo the session runs in, a worktree of it included", () => {
		expect(
			aliasFor(
				aliases,
				"/home/u/.claude2",
				"/home/u/workflow-core/.claude/worktrees/x",
			),
		).toBe("wc2");
	});

	it("falls back to the seat's first alias for a cwd no alias's repo holds, or none read", () => {
		expect(aliasFor(aliases, "/home/u/.claude2", "/tmp/elsewhere")).toBe(
			"manta2",
		);
		expect(aliasFor(aliases, "/home/u/.claude2", null)).toBe("manta2");
	});

	it("names none for a seat no alias opens", () => {
		expect(aliasFor(aliases, "/home/u/.claude9", null)).toBeNull();
	});

	it("carries the alias onto each waiting seat", () => {
		expect(
			withWaitingAliases(
				{
					live: 1,
					ceiling: 2,
					working: 1,
					waiting: [{ seat: "/home/u/.claude2", count: 3, cwd: null }],
				},
				aliases,
			).waiting,
		).toEqual([
			{ seat: "/home/u/.claude2", count: 3, cwd: null, alias: "manta2" },
		]);
	});
});

describe("readSeatAliases", () => {
	let home: string | undefined;
	afterEach(() => {
		if (home) fs.rmSync(home, { recursive: true, force: true });
		home = undefined;
	});

	it("reads the home's .bashrc, and gives none where it is absent", () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-aliases-"));
		expect(readSeatAliases(home)).toEqual([]);
		fs.writeFileSync(path.join(home, ".bashrc"), BASHRC);
		expect(readSeatAliases(home).map((a) => a.alias)).toEqual([
			"manta1",
			"manta2",
			"wc2",
			"wc3",
		]);
	});
});
