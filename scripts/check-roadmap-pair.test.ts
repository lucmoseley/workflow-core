// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, identityRepoTemplate } from "./lib/git-fixture";
import { gitIn } from "./lib/repo-tree-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-roadmap-pair.js");
const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

let repo: string;

const stageIn = (at: string, file: string, body: string) => {
	fs.writeFileSync(path.join(at, file), body);
	gitIn(at, "add", file);
};
const stage = (file: string, body: string) => stageIn(repo, file, body);

const check = (env: NodeJS.ProcessEnv = process.env) => {
	const r = runInProcess(SCRIPT, [], { cwd: repo, env });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const pairedRepo = defineTemplate((at) => {
	identityRepoTemplate(at);
	fs.mkdirSync(path.join(at, "docs"));
	stageIn(at, HTML, "roadmap v1\n");
	stageIn(at, DIGEST, "digest v1\n");
	gitIn(at, "commit", "-qm", "init");
});

beforeEach(() => {
	repo = pairedRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "pair-test-")),
	);
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-roadmap-pair", () => {
	it("refuses a commit staging the roadmap HTML without the digest, offering gen-roadmap-digest.js as the way out", () => {
		stage(HTML, "roadmap v2\n");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("is staged without");
		expect(r.stderr).toContain("gen-roadmap-digest.js");
	});

	it.each([
		["an installed plugin", false],
		["a source checkout of the core", true],
	])(
		"prints a generator command that runs as printed in an adopter of %s (#2234)",
		(_, checkout) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pair-root-"));
			try {
				fs.symlinkSync(
					path.resolve(__dirname, "../.claude"),
					path.join(root, ".claude"),
				);
				if (checkout) fs.writeFileSync(path.join(root, "package.json"), "{}");
				stage(
					HTML,
					fs.readFileSync(
						path.resolve(__dirname, "templates/adopter/reference-roadmap.html"),
						"utf8",
					),
				);
				const r = check({ ...process.env, WFC_SCRIPT_ROOT: root });
				const printed = r.stderr.match(/^ {2}node .*\\\n.*$/m)?.[0];
				expect(printed).toContain(
					`node ${root}/.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js`,
				);
				const run = spawnSync("bash", ["-c", printed ?? "false"], {
					cwd: repo,
					encoding: "utf8",
				});
				expect(run.status, run.stderr).toBe(0);
				const wrote = runInProcess(
					path.resolve(
						__dirname,
						"../.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
					),
					[HTML, "--stdout"],
					{ cwd: repo },
				).stdout;
				expect(fs.readFileSync(path.join(repo, DIGEST), "utf8")).toBe(wrote);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("does not offer --no-verify as the way out", () => {
		stage(HTML, "roadmap v2\n");
		const r = check();
		expect(r.stderr).not.toMatch(/--no-verify is the explicit way out/);
		expect(r.stderr).toContain("do not reach for --no-verify");
	});

	it("allows the pair staged together", () => {
		stage(HTML, "roadmap v2\n");
		stage(DIGEST, "digest v2\n");
		expect(check().status).toBe(0);
	});

	it("allows the digest alone but warns — a catch-up regeneration is legitimate", () => {
		stage(DIGEST, "digest v2\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
	});

	it("ignores commits that touch neither file", () => {
		stage("docs/other.md", "unrelated\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("FAIL");
		expect(r.stderr).not.toContain("WARN");
		expect(r.stderr).toContain("OK:");
	});

	it("is not fooled by an unstaged roadmap change in the working tree", () => {
		fs.writeFileSync(path.join(repo, HTML), "roadmap v2\n");
		stage("docs/other.md", "unrelated\n");
		expect(check().status).toBe(0);
	});
});
