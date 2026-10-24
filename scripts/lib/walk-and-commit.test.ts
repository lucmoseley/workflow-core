// @vitest-environment node
/*
 * walk-and-commit.test.ts — the reconciler-side wrapper around `upgrade()`
 * (#249). Every case runs against a real, throwaway git repo: the invariant
 * under test — one commit, never pushed, discarding exactly a failing
 * note's writes — is a git-level claim `upgrade.test.ts`'s file-only
 * fixture cannot check.
 *
 * `reconcile-plugin.js` runs it as a SessionEnd hook in `.claude/settings.json`,
 * committing into an adopter's repo unattended; loosen a case and a walk can mix
 * its edits into the founder's uncommitted work, push, or land a commit past a
 * refusing hook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bringCoreFiles } from "./core-owned-files.js";
import { walkAndCommit } from "./walk-and-commit.js";

let root: string;
let pluginRoot: string;
let remote: string;
let made: string[] = [];

const write = (base: string, rel: string, body: string) => {
	const at = path.join(base, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const writeJson = (base: string, rel: string, body: unknown) =>
	write(base, rel, JSON.stringify(body));
const readJson = (base: string, rel: string) =>
	JSON.parse(fs.readFileSync(path.join(base, rel), "utf8"));

const note = (
	tag: string,
	residue: object,
	verify: string,
	steps = "- [notice] nothing",
) => `# ${tag}

## What changed

Test fixture.

## Ruling

#1.

## Residue

\`\`\`json
${JSON.stringify(residue)}
\`\`\`

## Manual steps

${steps}

## Verify

\`\`\`sh
${verify}
\`\`\`
`;

function git(args: string[], cwd: string) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commitAll(cwd: string, message: string) {
	git(["add", "-A"], cwd);
	git(["commit", "-q", "-m", message], cwd);
}

function log(cwd: string) {
	return git(["log", "--format=%s%n%b%x00", "-z"], cwd)
		.split("\0")
		.filter(Boolean);
}

/** Pins the adopter at `ref` and brings its core-owned files current, as init
 * leaves them, so a walk with nothing to do writes nothing. */
function pinAt(ref: string) {
	const source = {
		source: "url",
		url: "https://example.invalid/wc.git",
		ref,
	};
	writeJson(root, ".claude/settings.json", {
		enabledPlugins: { "workflow-core@wc": true },
		extraKnownMarketplaces: { wc: { source } },
	});
	bringCoreFiles({
		root,
		pluginRoot,
		dryRun: false,
		out: () => {
			/* progress lines are not what this reads */
		},
		record: null,
		pin: { marketplace: "wc", source, plugin: "workflow-core" },
	});
}

beforeEach(() => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walk-and-commit-test-"));
	made.push(tmp);
	root = path.join(tmp, "adopter");
	pluginRoot = path.join(tmp, "plugin");
	remote = path.join(tmp, "remote.git");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(pluginRoot, { recursive: true });
	writeJson(pluginRoot, ".claude-plugin/plugin.json", {
		name: "workflow-core",
		version: "1.0.0",
	});
	pinAt("v1.0.0");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	git(["config", "user.email", "t@t"], root);
	git(["config", "user.name", "t"], root);
	execFileSync("git", ["init", "-q", "--bare", remote]);
	git(["remote", "add", "origin", remote], root);
	commitAll(root, "initial");
	git(["push", "-q", "-u", "origin", "main"], root);
});

afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

describe("walkAndCommit", () => {
	it("defers on a dirty tree and commits nothing", () => {
		fs.writeFileSync(path.join(root, "dirty.txt"), "x");

		const lines: string[] = [];
		const r = walkAndCommit({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.action).toBe("dirty");
		expect(lines.join("\n")).toMatch(/not clean/);
		expect(log(root)).toHaveLength(1);
	});

	it("a clean tree with notes to walk produces exactly one commit of the walk's output", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2, ignoreBlock: ["*.wfc-local"] }, "true"),
		);

		const before = log(root).length;
		const r = walkAndCommit({ root, pluginRoot });
		expect(r.action).toBe("committed");
		expect(log(root)).toHaveLength(before + 1);

		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.walkedTo).toBe("v2.0.0");
		expect(config.contract).toBe(2);

		// nothing left dirty
		expect(git(["status", "--porcelain"], root).trim()).toBe("");
	});

	const remoteHead = () =>
		execFileSync("git", ["rev-parse", "refs/heads/main"], {
			cwd: remote,
			encoding: "utf8",
		}).trim();

	it("never pushes, on the clean-commit path", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		const before = remoteHead();
		walkAndCommit({ root, pluginRoot });

		const localHead = git(["rev-parse", "main"], root).trim();
		expect(remoteHead()).toBe(before);
		expect(remoteHead()).not.toBe(localHead);
	});

	it("never pushes, on the half-way path", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "exit 1"),
		);

		const before = remoteHead();
		walkAndCommit({ root, pluginRoot });
		expect(remoteHead()).toBe(before);
	});

	it("halts and reports on a refusing commit, leaving no commit and never pushing", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		const hooksDir = path.join(root, ".git", "hooks");
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});

		const before = log(root).length;
		const beforeRemote = remoteHead();
		const lines: string[] = [];
		const r = walkAndCommit({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.action).toBe("broken");
		expect(lines.join("\n")).toMatch(/commit was refused/);
		expect(log(root)).toHaveLength(before);
		expect(remoteHead()).toBe(beforeRemote);
	});

	it("a failing note's Verify leaves none of its own writes committed, and notes before it stay committed", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "exit 1"),
		);

		const before = log(root).length;
		const lines: string[] = [];
		const r = walkAndCommit({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.action).toBe("committed");
		expect(log(root)).toHaveLength(before + 1);
		expect(lines.join("\n")).toMatch(/v3\.0\.0 Verify failed/);

		const config = readJson(root, ".claude/workflow-core.json");
		// v2.0.0's residue landed, v3.0.0's never did
		expect(config.contract).toBe(2);
		expect(config.walkedTo).toBe("v2.0.0");
		expect(git(["status", "--porcelain"], root).trim()).toBe("");
	});

	it("walkedTo in the commit matches the last note the committed tree actually carries, on the half-way path", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "exit 1"),
		);

		const before = log(root).length;
		const r = walkAndCommit({ root, pluginRoot });
		// nothing verified at all — nothing to commit
		expect(r.action).toBe("up-to-date");
		expect(log(root)).toHaveLength(before);
		expect(
			"walkedTo" in
				(fs.existsSync(path.join(root, ".claude/workflow-core.json"))
					? readJson(root, ".claude/workflow-core.json")
					: {}),
		).toBe(false);
	});

	it("the commit message body carries the stepsOwed this walk added", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note(
				"v2.0.0",
				{ contract: 2 },
				"true",
				"- [act] do a thing\n- [choice] pick a thing",
			),
		);

		walkAndCommit({ root, pluginRoot });
		const [subjectAndBody] = log(root);
		expect(subjectAndBody).toContain("- [act] (v2.0.0) do a thing");
		expect(subjectAndBody).toContain("- [choice] (v2.0.0) pick a thing");
	});

	it("exit code 3 from upgrade() — install behind pin — is handled, not treated as a crash", () => {
		// pin ahead of the installed plugin: settings.json already carries v1.0.0
		// while plugin.json under pluginRoot stays at v1.0.0 too — force the gap
		pinAt("v2.0.0");
		commitAll(root, "pin ahead");

		const lines: string[] = [];
		const r = walkAndCommit({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.action).toBe("up-to-date");
		expect(lines.join("\n")).toMatch(/install owes/);
	});

	it("commits a helper the walk created, with no note to walk (#1501)", () => {
		write(pluginRoot, "scripts/browse.py", "# the plugin's helper\n");

		const r = walkAndCommit({ root, pluginRoot });
		expect(r.action).toBe("committed");
		expect(git(["ls-files", "scripts/browse.py"], root).trim()).toBe(
			"scripts/browse.py",
		);
		expect(git(["status", "--porcelain"], root)).toBe("");
	});

	it("re-run after a committed walk changes nothing further", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		expect(walkAndCommit({ root, pluginRoot }).action).toBe("committed");
		const after1 = log(root).length;
		expect(walkAndCommit({ root, pluginRoot }).action).toBe("up-to-date");
		expect(log(root)).toHaveLength(after1);
	});
});
