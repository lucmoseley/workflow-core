// @vitest-environment node
/*
 * lib/queue-lander-deps.js's reading of the lander's own code (#4521),
 * against a real git repo in a temp directory.
 *
 * Loosen it and a landing that changes a file the running lander loaded goes
 * unnoticed, one that changes only other files restarts it, a lander running
 * code outside the checkout it lands (a plugin cache) restarts on a landing,
 * or a checkout still on the old file reads as carrying the new one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { carriesFiles, readRunCode, readSupersededFiles } = createRequire(
	__filename,
)("./queue-lander-deps.js");

let repo = "";
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), text);
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
	return git("rev-parse", "HEAD");
};

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "lander-code-"));
	git("init", "-q");
	commit("scripts/queue-lander.js", "v1\n");
	commit("docs/notes.md", "v1\n");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("readSupersededFiles", () => {
	it("names each loaded file a landing changes, and none where it changes only others", () => {
		const base = git("rev-parse", "HEAD");
		const code = {
			sha: base,
			loaded: () => ["scripts/queue-lander.js", "scripts/lib/git.js"],
		};
		const docs = commit("docs/notes.md", "v2\n");
		const own = commit("scripts/queue-lander.js", "v2\n");

		expect(readSupersededFiles(repo, code, docs)).toEqual([]);
		expect(readSupersededFiles(repo, code, own)).toEqual([
			"scripts/queue-lander.js",
		]);
	});

	it("names none for a run on code outside the checkout it lands", () => {
		const own = commit("scripts/queue-lander.js", "v2\n");

		expect(readRunCode(repo).sha).toBeNull();
		expect(readSupersededFiles(repo, readRunCode(repo), own)).toEqual([]);
	});
});

describe("readRunCode", () => {
	it("reads the checkout's HEAD and its own loaded files where it runs that checkout's code", () => {
		const root = path.resolve(__dirname, "..", "..");

		const code = readRunCode(root);

		expect(code.sha).toBe(
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		);
		expect(code.loaded()).toContain("scripts/lib/queue-lander-deps.js");
	});
});

describe("carriesFiles", () => {
	it("reads the working tree against the landed sha, false until the file is on disk", () => {
		const old = git("rev-parse", "HEAD");
		const own = commit("scripts/queue-lander.js", "v2\n");
		git("checkout", "-q", old);

		expect(carriesFiles(repo, own, ["scripts/queue-lander.js"])).toBe(false);
		git("checkout", "-q", own);
		expect(carriesFiles(repo, own, ["scripts/queue-lander.js"])).toBe(true);
	});
});
