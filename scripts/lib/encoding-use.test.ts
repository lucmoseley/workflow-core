// @vitest-environment node
/*
 * The counting seam behind `scripts/measure-encoding-use.js` (mantahostels#1299).
 *
 * ONE GUARANTEE ABOVE ALL: an invocation is counted and a MENTION is not.
 *
 * In-process on hand-built transcript records, one per shape, rather than the
 * real corpus, whose mix of mentions and invocations has no known answer.
 *
 * CI's vitest step runs this file; measure-encoding-use.js itself gates nothing
 * and is run by hand. A loosened case counts mentions as use, so a skill or npm
 * script nobody invokes reads as used and escapes the retirement its zero would
 * have prompted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBashCall } from "./transcript-testkit";

const {
	recordShapes,
	recordUses,
	isEncoded,
	skillInventory,
} = require("./encoding-use.js");

const AT = { uuid: "u1", timestamp: "2026-08-20T10:00:00.000Z" };

const skillCall = (skill: string) => ({
	type: "assistant",
	...AT,
	message: {
		content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill } }],
	},
});

const bash = (command: string) => buildBashCall(command, "t1", AT);

/** The `npm run` names one Bash call is counted as invoking. */
const npmRunNames = (command: string) =>
	recordUses(bash(command)).map((u: { name: string }) => u.name);

/** The command shapes one Bash call is counted under. */
const shapes = (command: string) =>
	recordShapes(bash(command)).map((s: { shape: string }) => s.shape);

/** A user record carrying plain text. */
const userText = (text: string) => ({
	type: "user",
	uuid: "u2",
	timestamp: "2026-08-21T10:00:00.000Z",
	message: { content: [{ type: "text", text }] },
});

describe("what counts as an invocation", () => {
	it("counts a Skill tool call, by the skill it names", () => {
		const uses = recordUses(skillCall("concision-pass"));
		expect(uses).toEqual([
			expect.objectContaining({
				kind: "skill",
				name: "concision-pass",
				route: "tool",
				at: "2026-08-20T10:00:00.000Z",
			}),
		]);
	});

	it("counts a plugin's copy under the bare skill name", () => {
		expect(recordUses(skillCall("plugin:tdd"))[0]).toEqual(
			expect.objectContaining({ name: "tdd" }),
		);
	});

	it("counts a typed slash command", () => {
		expect(
			recordUses(userText("<command-name>/implement</command-name>")),
		).toEqual([
			expect.objectContaining({
				kind: "skill",
				name: "implement",
				route: "command",
			}),
		]);
	});

	it("counts an npm run name off a Bash call", () => {
		expect(recordUses(bash("npm run check:guards"))).toEqual([
			expect.objectContaining({
				kind: "npm",
				name: "check:guards",
				route: "bash",
			}),
		]);
	});

	it("counts `npm test` as the `test` script, npm's own alias for it", () => {
		expect(npmRunNames("npm test")).toEqual(["test"]);
		expect(npmRunNames("npm start")).toEqual(["start"]);
	});

	it("reads every run in a chained command", () => {
		expect(
			npmRunNames("npm run typecheck && npm run test -- scripts/x"),
		).toEqual(["typecheck", "test"]);
	});
});

describe("what is a MENTION and must not count", () => {
	it("ignores assistant prose naming a skill", () => {
		expect(
			recordUses({
				type: "assistant",
				uuid: "u3",
				message: {
					content: [
						{
							type: "text",
							text: "Next I will run the diagnosing-bugs skill.",
						},
					],
				},
			}),
		).toEqual([]);
	});

	it("ignores an `npm run` name inside a grep for it", () => {
		expect(npmRunNames("grep -n 'npm run check:sh' CLAUDE.md")).toEqual([]);
	});

	it("ignores an `npm run` name a session merely printed", () => {
		expect(npmRunNames("echo 'npm run test'")).toEqual([]);
		expect(npmRunNames("cat package.json")).toEqual([]);
	});

	it("ignores a tool RESULT carrying the text — stdout is whatever was `cat`ed", () => {
		expect(
			recordUses({
				type: "user",
				uuid: "u4",
				toolUseResult: {
					stdout: "npm run test\n<command-name>/triage</command-name>",
				},
				message: {
					content: [{ type: "tool_result", content: "npm run test" }],
				},
			}),
		).toEqual([]);
	});

	it("ignores another tool's own `run` subcommand", () => {
		// The segment's verb must BE npm.
		expect(npmRunNames("gh run list --limit 5")).toEqual([]);
		expect(npmRunNames("npx vitest run scripts/x.test.ts")).toEqual([]);
	});

	it("ignores `npm ci` and `npm install` — neither runs a script", () => {
		expect(npmRunNames("npm ci")).toEqual([]);
		expect(npmRunNames("npm install vitest")).toEqual([]);
	});
});

describe("normalising a Bash command to a shape", () => {
	it("identifies a script by its path, not its interpreter", () => {
		expect(shapes("node scripts/pick-next.js --json")).toEqual([
			"node scripts/pick-next.js",
		]);
		expect(shapes("./scripts/guard-commit-form.sh")).toEqual([
			"scripts/guard-commit-form.sh",
		]);
	});

	it("identifies a subcommand tool by up to two subcommand words", () => {
		expect(shapes("gh issue view 1299 --json body")).toEqual(["gh issue view"]);
		expect(shapes("git commit -m 'x' -- a b")).toEqual(["git commit"]);
	});

	it("identifies a plain utility by its verb alone", () => {
		// A `cat` shape carrying its filename would be one shape per file.
		expect(shapes("cat docs/doc-map.md")).toEqual(["cat"]);
		expect(shapes("grep -rn foo docs/")).toEqual(["grep"]);
	});

	it("strips env assignments and wrappers before reading the verb", () => {
		expect(shapes("WFC_ALLOW_BRANCH=1 git commit -m x")).toEqual([
			"git commit",
		]);
		expect(shapes("time npm run test")).toEqual(["npm run test"]);
	});

	it("refuses shell grammar as a verb", () => {
		for (const kw of ["for f in a", "done", "if [ -f x ]", "else"])
			expect(shapes(kw)).toEqual([]);
	});

	it("files an inline script under its flag, never its first word of code", () => {
		expect(shapes('python3 -c "import os"')).toEqual(["python3 -c"]);
		expect(shapes("node -e 'console.log(1)'")).toEqual(["node -e"]);
	});

	it("does not read a redirection as an argument", () => {
		expect(shapes("python3 <<'PY'")).toEqual(["python3"]);
	});
});

describe("heredocs and multi-line bodies are data, not commands", () => {
	it("drops a heredoc body", () => {
		const command = ["python3 - <<'PY'", "import os", "print(1)", "PY"].join(
			"\n",
		);
		expect(shapes(command)).toEqual(["python3"]);
	});

	it("joins a line sitting inside an unclosed quote", () => {
		expect(shapes('node -e "\nconsole.log(1)\n"')).toEqual(["node -e"]);
	});

	it("splits a genuine chain into one shape each", () => {
		expect(shapes("cd /x && git status | head -3")).toEqual([
			"cd",
			"git status",
			"head",
		]);
	});

	it("counts one shape once per tool call, however often it is repeated", () => {
		expect(recordShapes(bash("git status; git status"))).toHaveLength(1);
	});
});

describe("which shapes are already encoded", () => {
	const encoded = {
		npm: new Set(["test", "check:sh"]),
		skills: new Set(["tdd"]),
	};

	it("treats a repo script, an npm run and a skill as encoded", () => {
		expect(isEncoded("node scripts/pick-next.js", encoded)).toBe(true);
		expect(isEncoded("npm run check:sh", encoded)).toBe(true);
		expect(isEncoded("npm test", encoded)).toBe(true);
		expect(isEncoded(".husky/pre-commit", encoded)).toBe(true);
		expect(isEncoded("tdd", encoded)).toBe(true);
	});

	it("leaves a hand shape alone", () => {
		for (const shape of ["gh issue view", "git commit", "npx vitest", "cat"])
			expect(isEncoded(shape, encoded)).toBe(false);
	});
});

describe("the skill inventory, read off the directories", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
		const agents = path.join(tmp, "agents");
		const claude = path.join(tmp, "claude");
		fs.mkdirSync(path.join(agents, "tdd"), { recursive: true });
		fs.mkdirSync(claude, { recursive: true });
		fs.writeFileSync(
			path.join(agents, "tdd", "SKILL.md"),
			"---\nname: tdd\ndisable-model-invocation: true\n---\n",
		);
		// This is how most of `.claude/skills` is built: a symlink to the copy.
		fs.symlinkSync(path.join(agents, "tdd"), path.join(claude, "tdd"));
		fs.mkdirSync(path.join(claude, "own"), { recursive: true });
		fs.writeFileSync(
			path.join(claude, "own", "SKILL.md"),
			"---\nname: own\n---\n",
		);
		// A directory with no SKILL.md is not a skill.
		fs.mkdirSync(path.join(claude, "notaskill"), { recursive: true });
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("finds a skill exposed as a symlink, and records both roots", () => {
		const { skills: inv, unreadable } = skillInventory([
			path.join(tmp, "claude"),
			path.join(tmp, "agents"),
		]);
		expect(unreadable).toEqual([]);
		expect(inv.map((s: { name: string }) => s.name)).toEqual(["own", "tdd"]);
		const tdd = inv.find((s: { name: string }) => s.name === "tdd");
		expect(tdd.roots).toEqual([
			path.join(tmp, "claude"),
			path.join(tmp, "agents"),
		]);
		expect(tdd.modelInvocable).toBe(false);
		expect(
			inv.find((s: { name: string }) => s.name === "own").modelInvocable,
		).toBe(true);
	});

	it("names a root it cannot read rather than reporting a repo with no skills", () => {
		const missing = path.join(tmp, "gone");
		const { skills, unreadable } = skillInventory([
			path.join(tmp, "claude"),
			missing,
		]);
		expect(unreadable).toEqual([missing]);
		expect(skills.map((s: { name: string }) => s.name)).toEqual(["own", "tdd"]);
	});
});
