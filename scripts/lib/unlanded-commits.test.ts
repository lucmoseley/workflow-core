// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { hexShaCommit, sharedShortShaCommits } from "./hex-sha-fixture";

const { hasUnlandedLine, readUnlandedCommits, unlandedRefusal } = createRequire(
	__filename,
)("./unlanded-commits.js");
const { CeilingPassed, buildGitCeiling } =
	createRequire(__filename)("./git-ceiling.js");

let template: string;
let root: string;

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd: root,
		encoding: "utf8",
	}).trim();

const commit = (message: string, file = "a.txt") => {
	fs.appendFileSync(path.join(root, file), `${message}\n`);
	git("add", "-A");
	git("commit", "-qm", message);
	return git("rev-parse", "HEAD");
};

const push = (ref = "HEAD") =>
	git("update-ref", "refs/remotes/origin/main", ref);

const unlanded = (n: number, comment = "") =>
	readUnlandedCommits(root, n, comment).commits.map(
		(c: { subject: string }) => c.subject,
	);

const mkTemp = () =>
	fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unlanded-")));

beforeAll(() => {
	template = mkTemp();
	root = template;
	git("init", "-q", "-b", "main");
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		JSON.stringify({ contract: 1, modules: [] }),
	);
	commit("seed");
	push();
});

beforeEach(() => {
	root = mkTemp();
	fs.cpSync(template, root, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(() => fs.rmSync(template, { recursive: true, force: true }));

describe("the ticket's commits (#3092, #2983 closed over unpushed ones)", () => {
	it("names a commit citing the ticket that origin/main lacks", () => {
		commit("Fix the stop (#12)");
		expect(unlanded(12)).toEqual(["Fix the stop (#12)"]);
	});

	it("names none once it is pushed", () => {
		commit("Fix the stop (#12)");
		push();
		expect(unlanded(12)).toEqual([]);
	});

	it("names none that landed under a new hash, its twin on origin/main", () => {
		const base = git("rev-parse", "HEAD");
		const fix = commit("Fix the stop (#12)");
		git("checkout", "-q", "-b", "upstream", base);
		commit("A neighbour's work (#7)", "b.txt");
		git("cherry-pick", fix);
		push();
		git("checkout", "-q", "main");
		expect(unlanded(12)).toEqual([]);
	});

	it("names one whose subject a pushed commit of another author date repeats", () => {
		const base = git("rev-parse", "HEAD");
		git("checkout", "-q", "-b", "upstream", base);
		git(
			"commit",
			"-q",
			"--allow-empty",
			"--date=1000000000 +0000",
			"-m",
			"Fix the stop (#12)",
		);
		push();
		git("checkout", "-q", "main");
		commit("Fix the stop (#12)");
		expect(unlanded(12)).toEqual(["Fix the stop (#12)"]);
	});

	it("reads the HEAD of the linked worktree it is handed, not the host's", () => {
		const wt = `${root}-wt`;
		git("worktree", "add", "-q", "--detach", wt);
		fs.appendFileSync(path.join(wt, "a.txt"), "fix\n");
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				"commit",
				"-qam",
				"Fix the stop (#12)",
			],
			{ cwd: wt },
		);
		expect(unlanded(12)).toEqual([]);
		expect(
			readUnlandedCommits(wt, 12, "").commits.map(
				(c: { subject: string }) => c.subject,
			),
		).toEqual(["Fix the stop (#12)"]);
		fs.rmSync(wt, { recursive: true, force: true });
	});

	it("reads the pushed ref from the host's config, not the worktree's (#4280)", () => {
		const wt = path.join(root, ".claude/worktrees/q");
		git("worktree", "add", "-q", "--detach", wt);
		git("update-ref", "refs/remotes/origin/queue/q", "HEAD");
		fs.writeFileSync(
			path.join(wt, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, modules: [] }),
		);
		expect(readUnlandedCommits(wt, 12, "").pushed).toBe("origin/queue/q");
		git("worktree", "remove", "--force", wt);
	});

	it("names none citing only another tracker's #12, or #120", () => {
		commit("Port it (gadgets#12)");
		commit("Port it (#120)");
		expect(unlanded(12)).toEqual([]);
	});
});

describe("a commit the comment names", () => {
	it("is named where the pushed ref lacks it, though it cites nothing and HEAD lacks it", () => {
		git("checkout", "-q", "-b", "side");
		const sha = commit("Fix the stop");
		git("checkout", "-q", "main");
		expect(unlanded(12, `Fixed in ${sha}.`)).toEqual(["Fix the stop"]);
	});

	it.each(["digits", "letters"] as const)(
		"is named by a short sha all %s (#3230)",
		(shape) => {
			git("checkout", "-q", "-b", "side");
			const { short } = hexShaCommit(root, "Fix the stop", shape);
			git("checkout", "-q", "main");
			expect(unlanded(12, `Fixed in ${short}.`)).toEqual(["Fix the stop"]);
		},
	);

	it("is named by a short sha a pushed commit shares, the pushed one not (#3233)", () => {
		const {
			shas: [pushed, side],
			short,
		} = sharedShortShaCommits(root, ["A neighbour's work", "Fix the stop"]);
		push(pushed);
		git("update-ref", "refs/heads/side", side);
		expect(unlanded(12, `Fixed in ${short}.`)).toEqual(["Fix the stop"]);
	});

	it("is not named where it was rebased into a twin now on HEAD and pushed (#3092's shape)", () => {
		const base = git("rev-parse", "HEAD");
		const fix = commit("Fix the stop");
		git("checkout", "-q", "-b", "upstream", base);
		commit("A neighbour's work", "b.txt");
		git("cherry-pick", fix);
		push();
		git("checkout", "-q", "main");
		git("reset", "-q", "--hard", "upstream");
		expect(unlanded(12, `Fixed in ${fix}.`)).toEqual([]);
	});

	it("is still named where HEAD will not read, and the HEAD fault throws only where nothing is named", () => {
		git("checkout", "-q", "-b", "side");
		const sha = commit("Fix the stop");
		git("checkout", "-q", "main");
		fs.writeFileSync(path.join(root, ".git/refs/heads/main"), "");
		expect(unlanded(12, `Fixed in ${sha}.`)).toEqual(["Fix the stop"]);
		expect(() => unlanded(12)).toThrow();
	});

	it("is not named once pushed, and a hex word naming no commit, all digits or all letters, is ignored", () => {
		const sha = commit("Fix the stop");
		push();
		expect(
			unlanded(12, `Fixed in ${sha}; see deadbee1, 3230000 and defaced.`),
		).toEqual([]);
	});
});

describe("the pushed ref it compares against", () => {
	it("throws, naming the ref, in a checkout whose pushed ref is absent", () => {
		git("update-ref", "-d", "refs/remotes/origin/main");
		commit("Fix the stop (#12)");
		expect(() => unlanded(12)).toThrow("no origin/main to compare against");
	});
});

describe("where git cannot answer", () => {
	it("throws outside a repository, never an empty answer", () => {
		fs.rmSync(path.join(root, ".git"), { recursive: true });
		expect(() => readUnlandedCommits(root, 12, "")).toThrow();
	});

	it("throws CeilingPassed where its ceiling passes", () => {
		commit("Fix the stop (#12)");
		const ceiling = buildGitCeiling({ label: "t", ms: 0 });
		expect(() => readUnlandedCommits(root, 12, "", { ceiling })).toThrow(
			CeilingPassed,
		);
	});
});

describe("the refusal and its escape", () => {
	it("names each commit by short sha and subject, the ref, and the Unlanded line", () => {
		const sha = commit("Fix the stop (#12)");
		const text = unlandedRefusal(12, readUnlandedCommits(root, 12, ""));
		expect(text).toContain("#12's commit is not on origin/main");
		expect(text).toContain(
			`  ${git("rev-parse", "--short", sha)} Fix the stop (#12)\n`,
		);
		expect(text).toContain("git fetch origin main");
		expect(text).toContain("**Unlanded:**");
	});

	it("reads an Unlanded line only with something after it", () => {
		expect(hasUnlandedLine("**Unlanded:** a neighbour's cite.")).toBe(true);
		expect(hasUnlandedLine("**Unlanded:**\nnext line")).toBe(false);
	});
});
