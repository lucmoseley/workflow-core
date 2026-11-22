// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { CITATION_CEILING } from "./lib/qualify-citations.js";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();

const CHECKER = path.join(ROOT, "scripts", "check-citation-tracker.js");

const SEED = [
	"A line citing mantahostels#900, which the other tracker really used.",
	"And mantahostels#63, likewise.",
	"",
].join("\n");

interface Repo {
	root: string;
	baseline: string;
	git: (...args: string[]) => string;
	stage: (rel: string, body: string) => void;
}

function newRepo(seed = SEED): Repo {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cite-tracker-"));
	temps.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q", ".");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");

	fs.writeFileSync(path.join(root, "history.md"), seed);
	git("add", "--", ".");
	git("commit", "-qm", "seed");

	const stage = (rel: string, body: string) => {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git("add", "--", rel);
	};
	return { root, baseline: git("rev-parse", "HEAD").trim(), git, stage };
}

function run(
	repo: Repo,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	const r = runInProcess(CHECKER, args, {
		cwd: repo.root,
		env: { ...process.env, WFC_CITATION_BASELINE: repo.baseline, ...env },
	});
	return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

describe("the citation prefix gate", () => {
	it("refuses a staged citation of a number the inherited tracker never used, naming it and its bare form", () => {
		const repo = newRepo();
		repo.stage("notes.md", "Fixed the thing (mantahostels#42).\n");

		const r = run(repo);
		expect(r.code).toBe(1);
		expect(r.output).toContain("mantahostels#42 should be #42");
	});

	it("passes a staged citation of a number it did use", () => {
		const repo = newRepo();
		repo.stage("notes.md", "As ruled at mantahostels#900.\n");

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("passes the bare form, which is what the rule asks for", () => {
		const repo = newRepo();
		repo.stage("notes.md", "Fixed the thing (#42).\n");

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("ignores a number above the overlap band", () => {
		const repo = newRepo();
		repo.stage("notes.md", `See mantahostels#${CITATION_CEILING + 1}.\n`);

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("judges added lines alone, not the file they land in", () => {
		const repo = newRepo();
		repo.stage("history.md", `${SEED}One more, at mantahostels#900.\n`);

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("skips where the baseline commit is not in the repository", () => {
		const repo = newRepo();
		repo.stage("notes.md", "Fixed the thing (mantahostels#42).\n");

		const r = run(repo, [], {
			WFC_CITATION_BASELINE: "0000000000000000000000000000000000000000",
		});
		expect(r.code).toBe(0);
		expect(r.output).toContain("no inherited tracker");
	});

	it("stands down for a commit that sets the defeat", () => {
		const repo = newRepo();
		repo.stage("notes.md", "Fixed the thing (mantahostels#42).\n");

		const r = run(repo, [], { WFC_CITATION_TRACKER_OFF: "1" });
		expect(r.code).toBe(0);
	});

	it("caps the finding below the gating line under --warn, still naming the form the citation should take", () => {
		const repo = newRepo();
		repo.stage("notes.md", "Fixed the thing (mantahostels#42).\n");

		const r = run(repo, ["--warn"]);
		expect(r.code).toBe(0);
		expect(r.output).toContain("mantahostels#42 should be #42");
	});

	it("leaves the classes sidecar's declared external references alone", () => {
		const repo = newRepo();
		repo.stage(
			"docs/doc-map-classes.json",
			'{\n\t"kind": "external",\n\t"ref": "mantahostels#42"\n}\n',
		);

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("drops a line carrying citation-exempt and an issue pointer", () => {
		const repo = newRepo();
		repo.stage(
			"notes.md",
			"See mantahostels#42.  <!-- citation-exempt: #805 -->\n",
		);

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("keeps a line whose citation-exempt carries prose", () => {
		const repo = newRepo();
		repo.stage(
			"notes.md",
			"See mantahostels#42.  <!-- citation-exempt: really the other tracker -->\n",
		);

		const r = run(repo);
		expect(r.code).toBe(1);
	});

	describe("the owner-qualified form (#1039)", () => {
		it("passes lucmoseley/mantahostels#N, a deliberate cross-repo reference", () => {
			const repo = newRepo();
			repo.stage(
				"notes.md",
				"Filed lucmoseley/mantahostels#3664 and github.com/lucmoseley/mantahostels#3665.\n",
			);

			expect(run(repo).code).toBe(0);
		});

		it("still refuses the bare form of the same number, naming the form the citation should take", () => {
			const repo = newRepo();
			repo.stage("notes.md", "Filed mantahostels#3664.\n");

			const r = run(repo);
			expect(r.code).toBe(1);
			expect(r.output).toContain("mantahostels#3664 should be #3664");
		});

		it("judges a bare citation beside an owner-qualified one", () => {
			const repo = newRepo();
			repo.stage(
				"notes.md",
				"Filed lucmoseley/mantahostels#3664, see mantahostels#42.\n",
			);

			const r = run(repo);
			expect(r.code).toBe(1);
			expect(r.output).toContain("mantahostels#42 should be #42");
			expect(r.output).not.toContain("#3664 should be");
		});

		it("judges as bare an owner glued to the previous citation's digits", () => {
			const repo = newRepo();
			repo.stage(
				"notes.md",
				"Filed mantahostels#900lucmoseley/mantahostels#3664.\n",
			);

			const r = run(repo);
			expect(r.code).toBe(1);
			expect(r.output).toContain("mantahostels#3664 should be #3664");
		});

		it.each(["someone-else", "xlucmoseley"])(
			"refuses owner %s, naming the citation",
			(owner) => {
				const repo = newRepo();
				repo.stage("notes.md", `Filed ${owner}/mantahostels#3664.\n`);

				const r = run(repo);
				expect(r.code).toBe(1);
				expect(r.output).toContain("mantahostels#3664 should be #3664");
			},
		);
	});

	it("judges an added line that itself begins with ++", () => {
		const repo = newRepo();
		repo.stage(
			"notes.md",
			"++ bold (mantahostels#42)\nand mantahostels#43 after it\n",
		);

		const r = run(repo);
		expect(r.code).toBe(1);
		expect(r.output).toContain("mantahostels#43 should be #43");
	});

	it("reports BROKEN where git cannot answer at all", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "cite-nogit-"));
		temps.push(root);
		const r = runInProcess(CHECKER, [], {
			cwd: root,
			env: { ...process.env, WFC_CITATION_BASELINE: "HEAD" },
		});
		expect(r.status).not.toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("BROKEN");
	});

	it("passes a baseline that holds no prefixed citation at all", () => {
		const repo = newRepo("A seed with no citations in it.\n");
		repo.stage("notes.md", "Nothing to cite here either.\n");

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("passes a number on the inherited-but-uncited allowlist", () => {
		const repo = newRepo();
		repo.stage("notes.md", "The consent ask at mantahostels#78.\n");

		const r = run(repo);
		expect(r.code).toBe(0);
	});

	it("scans the whole tree under --all, not just what is staged", () => {
		const repo = newRepo();
		fs.writeFileSync(
			path.join(repo.root, "notes.md"),
			"Fixed the thing (mantahostels#42).\n",
		);
		repo.git("add", "--", "notes.md");
		repo.git("commit", "-qm", "land it");

		expect(run(repo).code).toBe(0);
		const all = run(repo, ["--all"]);
		expect(all.code).toBe(1);
		expect(all.output).toContain("notes.md:1");
	});
});
