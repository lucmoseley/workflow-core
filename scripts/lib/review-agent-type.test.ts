// @vitest-environment node
/*
 * review-agent-type.test.ts — lib/review-agent-type.js and its bash twin
 * lib/review-agent-type.sh name one subagent type for the two review axes on
 * the same host (#741): the bare `code-reviewer` where the host carries its
 * own definition, the plugin's `workflow-core:code-reviewer` where it does
 * not. Disagreeing, a review dispatched from a Skill-loaded route and one
 * from a typed /code-review ask for different agents, and an adopter is
 * refused the bare name as not found. A plain tempdir, not a git repo: gr_root
 * takes CLAUDE_PROJECT_DIR, and nothing here reads git.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { reviewAgentType } = require("./review-agent-type.js") as {
	reviewAgentType: (root: string) => string;
};
const LIB = path.resolve(__dirname, "review-agent-type.sh");

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "review-agent-type-")),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const bash = () =>
	spawnSync("bash", ["-c", 'source "$LIB" && review_agent_type'], {
		encoding: "utf8",
		env: { ...process.env, LIB, CLAUDE_PROJECT_DIR: dir },
	}).stdout;

const agents = () => path.join(dir, ".claude", "agents");

describe("the review subagent type, in both twins (#741)", () => {
	it("is the plugin's where the host has no definition", () => {
		expect(reviewAgentType(dir)).toBe("workflow-core:code-reviewer");
		expect(bash()).toBe("workflow-core:code-reviewer");
	});

	it("is the bare name where the host has its own", () => {
		fs.mkdirSync(agents(), { recursive: true });
		fs.writeFileSync(path.join(agents(), "code-reviewer.md"), "x\n");
		expect(reviewAgentType(dir)).toBe("code-reviewer");
		expect(bash()).toBe("code-reviewer");
	});

	// `[[ -f ]]` reads a regular file only: a directory of that name defines
	// no agent.
	it("is the plugin's where the name is a directory", () => {
		fs.mkdirSync(path.join(agents(), "code-reviewer.md"), { recursive: true });
		expect(reviewAgentType(dir)).toBe("workflow-core:code-reviewer");
		expect(bash()).toBe("workflow-core:code-reviewer");
	});

	it("follows a symlinked definition, as `[[ -f ]]` does", () => {
		fs.mkdirSync(agents(), { recursive: true });
		const real = path.join(dir, "real.md");
		fs.writeFileSync(real, "x\n");
		fs.symlinkSync(real, path.join(agents(), "code-reviewer.md"));
		expect(reviewAgentType(dir)).toBe("code-reviewer");
		expect(bash()).toBe("code-reviewer");
	});
});
