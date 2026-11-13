// @vitest-environment node
/*
 * The pre-commit dispatcher's members share one process (#5172), so a member
 * that leaves state behind changes what every later member sees. This runs
 * the whole member set twice in one process, through the entry's real
 * loader, and holds the second pass to the first: the same output, and the
 * process's argv, exit code, working directory and environment as they were.
 * A member calling process.exit throws here instead.
 *
 * Every row runs, armed or not, and none stops the run: each is set to
 * `always` and `warn` for the pass, since a red would end it early and leave
 * the rows after it unproven.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "./lib/precommit-dispatch.js";
import { buildRepoPorts } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

// biome-ignore lint/suspicious/noExplicitAny: CommonJS module
const { computed, load } = require("./precommit-dispatch.js") as any;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** A repo with one commit, and a change staged on paths most rows arm on. */
function fixture(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-isolation-"));
	dirs.push(repo);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "fixture");
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), body);
		git(repo, "add", rel);
	};
	write("CLAUDE.md", "# one\n");
	write("scripts/a.js", 'require("node:path");\n');
	git(repo, "commit", "-qm", "init");
	write("CLAUDE.md", "# two\n");
	write("scripts/a.js", 'require("node:path"); // two\n');
	write("scripts/a.test.ts", "export {};\n");
	write("docs/a.md", "a\n");
	return repo;
}

/* What differs between two runs by design: the random name of each tree a
 * row materialises under the temp directory, and a stack frame's position. */
const TMP = new RegExp(
	`${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s'"]+`,
	"g",
);
const settle = (t: string) =>
	t.replace(TMP, "<tmp>").replace(/^\s+at .*\n/gm, "");

/** One pass of every row, its output and the process state it left. */
async function pass(repo: string) {
	let out = "";
	const exit = await dispatch({
		rows: GATES.map((g) => ({
			...g,
			arm: { always: true as const },
			policy: "warn" as const,
		})),
		gates: "all",
		ports: buildRepoPorts(repo, {
			computed,
			load,
			write: (fd: number, text: string) => {
				out += `[${fd}] ${text}`;
			},
		}),
	});
	return {
		exit,
		out: settle(out),
		state: {
			argv: [...process.argv],
			exitCode: process.exitCode,
			cwd: process.cwd(),
			env: { ...process.env },
		},
	};
}

it("runs every member twice in one process as it runs once, leaving the process as it found it", async () => {
	const repo = fixture();
	const was = process.cwd();
	process.chdir(repo);
	vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`a member called process.exit(${code})`);
	});
	try {
		const before = {
			argv: [...process.argv],
			exitCode: process.exitCode,
			cwd: process.cwd(),
			env: { ...process.env },
		};
		const first = await pass(repo);
		const second = await pass(repo);
		expect(first.state).toEqual(before);
		expect(second.state).toEqual(before);
		expect(first.out).not.toContain("process.exit(");
		expect(second.out).toEqual(first.out);
		expect(second.exit).toBe(first.exit);
	} finally {
		process.chdir(was);
	}
}, 120_000);
