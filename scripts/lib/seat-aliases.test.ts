import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeatAliases, withWaitingAliases } from "./seat-aliases.js";

const BASHRC = [
	"# --- three Claude plans, one repo ---",
	"alias manta1='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude  _wfc_agents)'",
	"alias manta2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 _wfc_agents)'",
	"alias cl2='(cd ~/mantahostels && CLAUDE_CONFIG_DIR=$HOME/.claude2 claude)'",
	`alias wc2='(cd ~/workflow-core && CLAUDE_CONFIG_DIR=$\{HOME}/.claude2 _wfc_agents)'`,
	"alias wc3='(cd ~/workflow-core && CLAUDE_CONFIG_DIR=~/.claude3 _wfc_agents)'",
	"alias ll='ls -l'",
].join("\n");

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-aliases-"));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

const aliasOf = (seat: string, cwd: string | null) =>
	withWaitingAliases(
		{
			live: 1,
			ceiling: 2,
			working: 1,
			waiting: [{ seat: path.join(home, seat), count: 3, cwd }],
		},
		readSeatAliases(home),
	).waiting?.[0]?.alias;

describe("readSeatAliases", () => {
	it("reads each agents-view alias with its repo and seat, every spelling of home expanded, and skips any other line", () => {
		fs.writeFileSync(path.join(home, ".bashrc"), BASHRC);
		expect(readSeatAliases(home)).toEqual([
			{
				alias: "manta1",
				dir: path.join(home, "mantahostels"),
				seat: path.join(home, ".claude"),
			},
			{
				alias: "manta2",
				dir: path.join(home, "mantahostels"),
				seat: path.join(home, ".claude2"),
			},
			{
				alias: "wc2",
				dir: path.join(home, "workflow-core"),
				seat: path.join(home, ".claude2"),
			},
			{
				alias: "wc3",
				dir: path.join(home, "workflow-core"),
				seat: path.join(home, ".claude3"),
			},
		]);
	});

	it("gives none where the home has no .bashrc", () => {
		expect(readSeatAliases(home)).toEqual([]);
	});
});

describe("withWaitingAliases", () => {
	beforeEach(() => {
		fs.writeFileSync(path.join(home, ".bashrc"), BASHRC);
	});

	it("names the seat's alias for the repo the session runs in, a worktree of it included", () => {
		expect(
			aliasOf(".claude2", path.join(home, "workflow-core/.claude/worktrees/x")),
		).toBe("wc2");
	});

	it("falls back to the seat's first alias for a cwd no alias's repo holds, or none read", () => {
		expect(aliasOf(".claude2", "/tmp/elsewhere")).toBe("manta2");
		expect(aliasOf(".claude2", null)).toBe("manta2");
	});

	it("names none for a seat no alias opens", () => {
		expect(aliasOf(".claude9", null)).toBeNull();
	});

	it("keeps an unread listing's waiting seats unread", () => {
		expect(
			withWaitingAliases(
				{ live: null, ceiling: null, working: null, waiting: null },
				readSeatAliases(home),
			).waiting,
		).toBeNull();
	});
});
