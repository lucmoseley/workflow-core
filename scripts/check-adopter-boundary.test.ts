// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { writeIn } from "./lib/repo-tree-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-adopter-boundary.js");
const PAGE = path.resolve(__dirname, "..", "docs", "adopter-boundary.md");

let root: string;

const write = (rel: string, body: string) => writeIn(root, rel, body);

const trackIn = (at: string, ...rels: string[]) => {
	for (const rel of rels) writeIn(at, rel, "x\n");
	execFileSync("git", ["add", "--", ...rels], { cwd: at });
};
const track = (...rels: string[]) => trackIn(root, ...rels);

const run = () => {
	const r = runInProcess(SCRIPT, ["--root", root], {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const page = () => fs.readFileSync(PAGE, "utf8");

const tracked = defineTemplate((dir) => {
	execFileSync("git", ["init", "-q"], { cwd: dir });
	trackIn(dir, "scripts/x.js", "docs/x.md", "CLAUDE.md");
});

beforeEach(() => {
	root = tracked.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "adopter-boundary-")),
	);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-adopter-boundary", () => {
	it("passes the repo's page over a tree whose top-level paths it names", () => {
		write("docs/adopter-boundary.md", page());
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("FAILs a path named in a group the code does not put it in", () => {
		write(
			"docs/adopter-boundary.md",
			page().replace(
				"- `ruff.toml` — the Python lint rules.\n",
				"- `scripts/release-plugin.js` — misplaced.\n- `ruff.toml` — the Python lint rules.\n",
			),
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'names `scripts/release-plugin.js` under "Ships in the plugin"',
		);
	});

	it("FAILs a core-owned entry the page names in no group", () => {
		write(
			"docs/adopter-boundary.md",
			page().replace("`.claude/registrations.json` ", ""),
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("names `.claude/registrations.json` in no group");
	});

	it("FAILs a top-level tracked path the page names in no group", () => {
		write("docs/adopter-boundary.md", page());
		track("unnamed-top/a.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("top-level path `unnamed-top` in no group");
	});

	it("SKIPs a repo with no page: an adopter", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("no docs/adopter-boundary.md");
	});
});
