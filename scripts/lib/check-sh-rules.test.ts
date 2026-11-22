// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	latchesAt,
	runCore,
	splitCheckout,
	toolCall,
} from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

const { decide } = require("./check-sh-rules.js") as {
	decide: (command: string, ctx: object) => unknown;
};

const ctx = kitContextFake({ cwd: "/repo", moduleOn: () => true });

const TWO = {
	injectRules: ["shellcheck-not-installed", "shellcheck-source-directive"],
};
const THREE = {
	injectRules: [
		"shellcheck-not-installed",
		"shellcheck-source-directive",
		"shellcheck-changed-scope",
	],
};

describe("a shell-gate run is handed the rules, and refused nothing", () => {
	it.each([
		["npm run check:sh", THREE, "the spelling package.json defines"],
		["npm check:sh", THREE, "npm's own shorthand for the same script"],
		["npm run check:sh:changed", TWO, "the changed-paths form (#1015)"],
		["npm check:sh:changed", TWO, "its shorthand"],
		["shellcheck scripts/guard-branch.sh", TWO, "the tool driven directly"],
		["npm run typecheck && npm run check:sh", THREE, "the tail of a chain"],
		[
			"shellcheck a.sh && npm run check:sh",
			THREE,
			"a full run anywhere in the command adds its route",
		],
		[
			"npm run check:sh; shellcheck a.sh",
			THREE,
			"a later direct run does not take it away",
		],
	])("%s — %s", (command, want) => {
		expect(decide(command, ctx)).toEqual(want);
	});
});

describe("things that are not the shell gate", () => {
	it.each([
		["npm run lint", "lint never sees a .sh file (CLAUDE.md §Commands)"],
		["npm run check", "Biome over the repo, not shellcheck"],
		["npm run check:staged", "the pre-commit form of the Biome gate"],
		["npm test", "a different gate entirely"],
		["npm run", "npm run naming no script"],
		["npm", "a bare npm, every word absent"],
		["npm run run check:sh", "a script called run"],
		["npx check:sh", "not npm"],
		["/usr/bin/npm run check:sh", "npm by path, read as written"],
		["/usr/bin/shellcheck a.sh", "shellcheck by path, read as written"],
		["echo 'run npm run check:sh first'", "prose about the gate"],
		["echo npm run check:sh", "the gate as an argument"],
		["grep -rn 'shellcheck' scripts", "a search for it"],
	])("%s is handed nothing — %s", (command) => {
		expect(decide(command, ctx)).toBeNull();
	});
});

describe("from a linked worktree, its rule latches are the main checkout's (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});
	const fromWorktree = (command: string) =>
		runCore("guard-check-sh", toolCall("Bash", { command }), {
			root: at.main,
			worktree: at.worktree,
		}).output;

	it("latches the shellcheck rules in the main checkout's marker store, never the worktree's", () => {
		expect(fromWorktree("npm run check:sh")).not.toBeNull();
		expect(latchesAt(at.main)).toHaveLength(THREE.injectRules.length);
		expect(latchesAt(at.worktree)).toEqual([]);
	});
});
