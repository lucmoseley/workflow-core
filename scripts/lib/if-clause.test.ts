/*
 * lib/if-clause.js's clausesAdmit decides which Bash calls reach a
 * dispatcher core narrowed by `if` clauses (#3224). Miss a call the
 * harness's own `if` started the guard on and the fold loses reach; the
 * segment cases are guard-authoring.md's measured splits.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const { clausesAdmit } = require("./if-clause.js") as {
	clausesAdmit: (
		clauses: string[],
		tool: string | undefined,
		subject: string,
	) => boolean;
};

describe("clausesAdmit", () => {
	it.each([
		["git status", true],
		["cd x && git commit -m a", true],
		["ls; git push", true],
		["echo a | git apply", true],
		["echo $(git rev-parse HEAD)", true],
		["echo `git rev-parse HEAD`", true],
		["  git status", true],
		["if true; then git commit -a -m x; fi", true],
		["for f in a; do git add -A; done", true],
		["{ git commit -am x; }", true],
		["! git push", true],
		["x=1 git commit -a -m y", true],
		["A='a b' B=2 git push", true],
		['A="" git status', true],
		["A=it\\'s git push", true],
		['A=a\\"b git push', true],
		['A="a\\"b" git push', true],
		["time git status", true],
		["ls .gitignore", false],
		["thenx git status", false],
		["x=1", false],
		["legitimate", false],
	])("an anchored clause on %j: %s", (command, admitted) => {
		expect(clausesAdmit(["Bash(git *)"], "Bash", command)).toBe(admitted);
	});

	// A regex match is synchronous, so only a process timeout can stop a
	// backtracking one (#2188, CodeQL js/redos): 40 empty quote pairs never
	// finish when each pair can also read as two bare characters, and finish
	// in milliseconds when it cannot. 10 s is far above a linear read on any
	// machine and far below that exponential one.
	it("reads a long run of quotes with no command after it", () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`process.exit(require(${JSON.stringify(require.resolve("./if-clause.js"))}).clausesAdmit(["Bash(git *)"], "Bash", process.argv[1]) ? 1 : 0)`,
				`A=${'""'.repeat(40)}`,
			],
			{ timeout: 10_000 },
		);
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
	});

	it("matches a glob across lines", () => {
		expect(clausesAdmit(["Bash(*npm *)"], "Bash", "ls\nnpm test")).toBe(true);
	});

	it("admits on any one clause", () => {
		const clauses = ["Bash(git *)", "Bash(*commit-paths.js*)"];
		expect(clausesAdmit(clauses, "Bash", "node commit-paths.js a")).toBe(true);
		expect(clausesAdmit(clauses, "Bash", "node other.js")).toBe(false);
	});

	it("leaves a tool no clause names unnarrowed", () => {
		expect(clausesAdmit(["Bash(*sleep *)"], "Read", "")).toBe(true);
	});

	it("fails toward running on a clause it cannot read", () => {
		expect(clausesAdmit(["not a clause"], "Bash", "ls")).toBe(true);
	});
});
