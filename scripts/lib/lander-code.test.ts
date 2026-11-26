// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./git-fixture";
import { gitIn, gitTrimmedIn, writeIn } from "./repo-tree-testkit";

const { isCarried, levelUntilCarried, readRunCode, readSupersededFiles } =
	createRequire(__filename)("./lander-code.js");

const OWN = "scripts/queue-lander.js";
let repo = "";
const git = (...args: string[]) => gitTrimmedIn(repo, ...args);
const write = (file: string, text: string) => writeIn(repo, file, text);
const commitIn = (at: string, file: string, text: string) => {
	const g = (...args: string[]) => gitTrimmedIn(at, ...args);
	writeIn(at, file, text);
	g("add", "-A");
	g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
	return g("rev-parse", "HEAD");
};
const commit = (file: string, text: string) => commitIn(repo, file, text);

const seeded = defineTemplate((dir) => {
	gitIn(dir, "init", "-q");
	commitIn(dir, OWN, "module.exports = 1;\n");
	commitIn(dir, "docs/notes.md", "v1\n");
});

beforeEach(() => {
	repo = seeded.instantiate(
		fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lander-code-"))),
	);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("readRunCode", () => {
	it("reads HEAD and the loaded files inside the checkout where the run is its tracked code", () => {
		createRequire(__filename)(path.join(repo, OWN));

		const code = readRunCode(repo, path.join(repo, OWN));

		expect(code.sha).toBe(git("rev-parse", "HEAD"));
		expect(code.loaded()).toEqual([OWN]);
	});

	it("is null for a run on code outside the checkout", () => {
		expect(
			readRunCode(repo, path.join(os.tmpdir(), "elsewhere.js")),
		).toBeNull();
	});

	it("is null for a run on untracked code nested in the checkout, as a worktree's is", () => {
		const nested = ".claude/worktrees/w/scripts/queue-lander.js";
		write(nested, "v1\n");

		expect(readRunCode(repo, path.join(repo, nested))).toBeNull();
	});
});

describe("readSupersededFiles", () => {
	it("names each loaded file a landing changes, and none where it changes only others", () => {
		const code = {
			sha: git("rev-parse", "HEAD"),
			loaded: () => [OWN, "scripts/lib/git.js"],
		};
		const docs = commit("docs/notes.md", "v2\n");
		const own = commit(OWN, "v2\n");

		expect(readSupersededFiles(repo, code, docs)).toEqual([]);
		expect(readSupersededFiles(repo, code, own)).toEqual([OWN]);
	});
});

describe("isCarried", () => {
	it("reads the working tree against the landed sha, false until the file is on disk", () => {
		const old = git("rev-parse", "HEAD");
		const own = commit(OWN, "v2\n");
		git("checkout", "-q", old);

		expect(isCarried(repo, own, [OWN])).toBe(false);
		git("checkout", "-q", own);
		expect(isCarried(repo, own, [OWN])).toBe(true);
	});
});

describe("levelUntilCarried", () => {
	const clock = () => {
		let t = 0;
		return {
			now: () => t,
			wait: async (ms: number) => {
				t += ms;
			},
		};
	};

	it("asks again while another pass holds the lock, until the checkout carries the code", async () => {
		const passes = ["busy", "busy", null];
		let carried = false;

		const settled = await levelUntilCarried({
			...clock(),
			level: () => {
				const failed = passes.shift() ?? null;
				carried = failed === null;
				return failed;
			},
			carried: () => carried,
		});

		expect(settled).toEqual({ carried: true });
		expect(passes).toEqual([]);
	});

	it("gives up at the deadline with the last pass's failure", async () => {
		let tries = 0;

		const settled = await levelUntilCarried({
			...clock(),
			level: () => {
				tries += 1;
				return "npm ci failed";
			},
			carried: () => false,
		});

		expect(settled).toEqual({ carried: false, failed: "npm ci failed" });
		expect(tries).toBe(61);
	});
});
