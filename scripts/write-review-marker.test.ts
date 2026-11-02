// @vitest-environment node
/*
 * write-review-marker.js, driven through its command line in a sandbox repo
 * (#2040). Every refusal also asserts that no marker was written.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "write-review-marker.js");
const COMMIT_PATHS = path.resolve(__dirname, "commit-paths.js");
const SID = "abcdef12-3456-7890-abcd-ef1234567890";

let repo = "";

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd: repo,
		encoding: "utf8",
	}).trim();

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "review-marker-"));
	git("init", "-q");
	fs.writeFileSync(path.join(repo, "a.js"), "one\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
});

afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

const env = { ...process.env, CLAUDE_PROJECT_DIR: "" };
const run = (args: string[], sid = SID, cwd = repo) =>
	runInProcess(SCRIPT, args, {
		cwd,
		env: { ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: sid },
	});

const marker = () =>
	path.join(repo, ".claude", "tmp", "markers", `.codereview-pass-${SID}`);
const readMarkerText = () => fs.readFileSync(marker(), "utf8");

/** The tree `commit-paths.js --tree <args>` prints in the repo. */
const readTree = (args: string[], cwd = repo) => {
	const r = runInProcess(COMMIT_PATHS, ["--tree", ...args], {
		cwd,
		env: { ...env, CLAUDE_PROJECT_DIR: repo },
	});
	if (r.status !== 0)
		throw new Error(`commit-paths.js exited ${r.status}: ${r.stderr}`);
	return r.stdout.trim();
};

const artefact = (
	axis: "standards" | "spec" | "focus" | "attack",
	text = "- no findings\n",
	root = repo,
) => {
	fs.mkdirSync(path.join(root, ".claude", "tmp"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "tmp", `review-${axis}-abcdef12.md`),
		text,
	);
};

/** A tiered review's flags, with no paths. */
const tiered = (tier: string) => [
	"--base",
	"HEAD",
	"--findings",
	"0",
	"--tier",
	tier,
	"--areas",
	"money",
];

describe("run from a linked worktree (#3714)", () => {
	const wt = () => `${repo}-wt`;
	const inWorktree = (args: string[]) => run(args, SID, wt());
	const Flags = ["--base", "HEAD", "--findings", "1"];

	beforeEach(() => {
		git("worktree", "add", "-q", "-b", "landing", wt());
		fs.writeFileSync(path.join(wt(), "b.js"), "earlier\n");
		git("-C", wt(), "add", "b.js");
		git("-C", wt(), "commit", "-qm", "earlier");
	});

	afterEach(() => {
		fs.rmSync(wt(), { recursive: true, force: true });
	});

	it("reads the base and the tree there, takes the artefacts there, and writes the marker in the host's store", () => {
		artefact("standards", undefined, wt());
		artefact("spec", undefined, wt());
		fs.writeFileSync(path.join(wt(), "a.js"), "changed there\n");
		const r = inWorktree([...Flags, "--paths", "a.js"]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const head = git("-C", wt(), "rev-parse", "HEAD");
		expect(readMarkerText()).toBe(
			`base=${head}\nfindings=1\ntree=${readTree(["--", "a.js"], wt())}\npaths=a.js\n`,
		);
	});

	it("takes the artefacts from the host where the runs left them there", () => {
		artefact("standards");
		artefact("spec");
		expect(inWorktree(Flags).status).toBe(0);
		expect(fs.existsSync(marker())).toBe(true);
	});

	it("finds the shared tree's artefacts and writes its store with CLAUDE_PROJECT_DIR unset (#3830)", () => {
		artefact("standards");
		artefact("spec");
		const { CLAUDE_PROJECT_DIR: _, ...unset } = env;
		const r = runInProcess(SCRIPT, Flags, {
			cwd: wt(),
			env: { ...unset, CLAUDE_CODE_SESSION_ID: SID },
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(fs.existsSync(marker())).toBe(true);
		expect(
			fs.existsSync(
				path.join(wt(), ".claude", "tmp", "markers", `.codereview-pass-${SID}`),
			),
		).toBe(false);
	});

	it("refuses, writing nothing, where neither tree holds an artefact", () => {
		const r = inWorktree(Flags);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`no review left its artefact at ${path.join(".claude", "tmp", "review-standards-abcdef12.md")} or`,
		);
		expect(r.stderr).toContain("Run the code-review skill");
		expect(fs.existsSync(marker())).toBe(false);
	});
});

describe("a review that left both artefacts", () => {
	it("writes base= as the full sha and findings=", () => {
		artefact("standards");
		artefact("spec");
		const r = run(["--base", "HEAD", "--findings", "3"]);
		expect(r.status).toBe(0);
		expect(readMarkerText()).toBe(
			`base=${git("rev-parse", "HEAD")}\nfindings=3\n`,
		);
	});

	it("adds tier=, areas=, and the tree= commit-paths prints for --paths", () => {
		artefact("standards");
		artefact("spec");
		artefact("focus");
		fs.writeFileSync(path.join(repo, "a.js"), "two\n");
		const tree = readTree(["--", "a.js"]);
		const r = run([
			"--base",
			"HEAD",
			"--findings",
			"0",
			"--tier",
			"escalated",
			"--areas",
			"guards, hooks",
			"--paths",
			"a.js",
		]);
		expect(r.status).toBe(0);
		expect(readMarkerText()).toBe(
			[
				`base=${git("rev-parse", "HEAD")}`,
				"findings=0",
				"tier=escalated",
				"areas=guards,hooks",
				`tree=${tree}`,
				"paths=a.js",
				"",
			].join("\n"),
		);
	});
	/**
	 * Write the marker for a.js, left to a patch, and the new file at `added`,
	 * named in `--paths` as `paths`; the tree commit-paths prints for that commit.
	 */
	const patchedRun = (added: string, paths: string) => {
		artefact("standards");
		artefact("spec");
		fs.writeFileSync(path.join(repo, "a.js"), "two\n");
		fs.mkdirSync(path.dirname(path.join(repo, added)), { recursive: true });
		fs.writeFileSync(path.join(repo, added), "new\n");
		const patch = path.join(repo, ".claude", "tmp", "own.patch");
		fs.writeFileSync(patch, `${git("diff", "-U0", "--", "a.js")}\n`);
		const tree = readTree(["--patch", patch, "--", added]);
		const r = run([
			"--base",
			"HEAD",
			"--findings",
			"0",
			"--paths",
			paths,
			"--patch",
			patch,
		]);
		return { r, tree };
	};

	it("names a patched file in paths= and leaves it to the patch in tree=", () => {
		const { r, tree } = patchedRun("b.js", "a.js,b.js");
		expect(r.status).toBe(0);
		expect(readMarkerText()).toContain(`tree=${tree}\npaths=a.js,b.js\n`);
	});

	it("writes ./<patched path> in its repo-relative spelling and still leaves it to the patch (#2740)", () => {
		const { r, tree } = patchedRun("lib/b.js", "./a.js,lib/./b.js");
		expect(r.status).toBe(0);
		expect(readMarkerText()).toContain(`tree=${tree}\npaths=a.js,lib/b.js\n`);
	});
});

describe("refuses, writing no marker", () => {
	it.each([
		["no artefact at all", [] as ("standards" | "spec")[]],
		["only the standards artefact", ["standards"] as const],
		["only the spec artefact", ["spec"] as const],
	])("where the review left %s", (_, axes) => {
		for (const axis of axes) artefact(axis);
		const r = run(["--base", "HEAD", "--findings", "2"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no review left its artefact");
		expect(fs.existsSync(marker())).toBe(false);
	});

	it.each([
		["escalated", ["standards", "spec"], ["focus"]],
		["mission-critical", ["standards", "spec"], ["focus", "attack"]],
		["mission-critical", ["standards", "spec", "focus"], ["attack"]],
		["mission-critical", ["standards", "spec", "attack"], ["focus"]],
	] as const)(
		"at --tier %s with only %j, naming %j (#3905)",
		(tier, left, missing) => {
			for (const axis of left) artefact(axis);
			const r = run(tiered(tier));
			expect(r.status).toBe(2);
			for (const axis of missing)
				expect(r.stderr).toContain(`review-${axis}-abcdef12.md`);
			for (const axis of left)
				expect(r.stderr).not.toContain(`review-${axis}-abcdef12.md`);
			expect(fs.existsSync(marker())).toBe(false);
		},
	);

	it("at --tier escalated where the focus artefact is empty (#3905)", () => {
		artefact("standards");
		artefact("spec");
		artefact("focus", "");
		const r = run(tiered("escalated"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("review-focus-abcdef12.md");
		expect(fs.existsSync(marker())).toBe(false);
	});

	it("where an artefact is empty", () => {
		artefact("standards");
		artefact("spec", "");
		const r = run(["--base", "HEAD", "--findings", "2"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("review-spec-abcdef12.md");
		expect(fs.existsSync(marker())).toBe(false);
	});

	it.each([
		[
			"a base naming no commit",
			["--base", "nope", "--findings", "1"],
			"names no commit",
		],
		[
			"a findings that is not a number",
			["--base", "HEAD", "--findings", "six"],
			"whole number",
		],
		["no --findings", ["--base", "HEAD"], "required"],
		[
			"a skip with findings",
			["--base", "HEAD", "--findings", "1", "--skipped", "rename"],
			"--findings 0 only",
		],
		[
			"an unknown skip",
			["--base", "HEAD", "--findings", "0", "--skipped", "tidy"],
			"deletion or rename",
		],
		[
			"a tier without areas",
			["--base", "HEAD", "--findings", "1", "--tier", "escalated"],
			"go together",
		],
		[
			"an unknown tier",
			["--base", "HEAD", "--findings", "1", "--tier", "high", "--areas", "x"],
			"escalated or mission-critical",
		],
		[
			"a patch without paths",
			["--base", "HEAD", "--findings", "1", "--patch", "p.diff"],
			"--patch needs --paths",
		],
		[
			"an unknown flag",
			["--base", "HEAD", "--findings", "1", "--force"],
			"unknown flag",
		],
		[
			"a sensitive change claiming no spec",
			[
				"--base",
				"HEAD",
				"--findings",
				"1",
				"--no-spec",
				"--tier",
				"escalated",
				"--areas",
				"x",
			],
			"owes both review axes",
		],
		[
			"a sensitive change claiming no review",
			[
				"--base",
				"HEAD",
				"--findings",
				"0",
				"--skipped",
				"rename",
				"--tier",
				"escalated",
				"--areas",
				"x",
			],
			"owes both review axes",
		],
		[
			"a skip naming the paths the review hold reads",
			[
				"--base",
				"HEAD",
				"--findings",
				"0",
				"--skipped",
				"rename",
				"--paths",
				"a.js",
			],
			"--skipped takes no --paths",
		],
		[
			"a path outside the repository (#2740)",
			["--base", "HEAD", "--findings", "0", "--paths", "../a.js"],
			"names no file inside",
		],
	])("on %s", (_, args, says) => {
		artefact("standards");
		artefact("spec");
		const r = run(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(fs.existsSync(marker())).toBe(false);
	});

	it("with no session id", () => {
		artefact("standards");
		artefact("spec");
		const r = run(["--base", "HEAD", "--findings", "1"], "");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("CLAUDE_CODE_SESSION_ID");
	});
});

describe("the routes that run without one axis or without a review", () => {
	it("--tier escalated takes the focus artefact, and owes no attack artefact", () => {
		artefact("standards");
		artefact("spec");
		artefact("focus");
		const r = run(tiered("escalated"));
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("--tier mission-critical takes the focus and attack artefacts", () => {
		artefact("standards");
		artefact("spec");
		artefact("focus");
		artefact("attack");
		const r = run(tiered("mission-critical"));
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("--no-spec needs only the standards artefact", () => {
		artefact("standards");
		expect(run(["--base", "HEAD", "--findings", "1", "--no-spec"]).status).toBe(
			0,
		);
		expect(readMarkerText()).toContain("findings=1\n");
	});

	it("--no-spec still refuses where the standards artefact is missing", () => {
		artefact("spec");
		const r = run(["--base", "HEAD", "--findings", "1", "--no-spec"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("review-standards-abcdef12.md");
		expect(fs.existsSync(marker())).toBe(false);
	});

	it("--skipped writes findings=0 with no artefact", () => {
		const r = run([
			"--base",
			"HEAD",
			"--findings",
			"0",
			"--skipped",
			"deletion",
		]);
		expect(r.status).toBe(0);
		expect(readMarkerText()).toBe(
			`base=${git("rev-parse", "HEAD")}\nfindings=0\n`,
		);
	});
});
