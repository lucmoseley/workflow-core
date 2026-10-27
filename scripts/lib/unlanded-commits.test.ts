// @vitest-environment node
/*
 * lib/unlanded-commits.js (#3101): which of a ticket's commits the pushed ref
 * lacks under any hash. Both close routes refuse on its answer, so a commit it
 * misses closes a ticket over unpushed work (#3092, #2983), and one it wrongly
 * names strands a close whose work did land — rebased under a new hash, or
 * cited only by another tracker.
 *
 * Real git in a throwaway host with the `landing` module on, `origin/landing`
 * set by update-ref so no remote is needed.
 */

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
	vi,
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

/** Commits a change to `file` under `message`; its full sha. */
const commit = (message: string, file = "a.txt") => {
	fs.appendFileSync(path.join(root, file), `${message}\n`);
	git("add", "-A");
	git("commit", "-qm", message);
	return git("rev-parse", "HEAD");
};

const push = (ref = "HEAD") =>
	git("update-ref", "refs/remotes/origin/landing", ref);

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
		JSON.stringify({ contract: 1, modules: ["landing"] }),
	);
	commit("seed");
	push();
});

beforeEach(() => {
	vi.stubEnv("WFC_MODULES", undefined);
	root = mkTemp();
	fs.cpSync(template, root, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(() => fs.rmSync(template, { recursive: true, force: true }));

describe("the ticket's commits (#3092, #2983 closed over unpushed ones)", () => {
	it("names a commit citing the ticket that origin/landing lacks", () => {
		commit("Fix the stop (#12)");
		expect(unlanded(12)).toEqual(["Fix the stop (#12)"]);
	});

	it("names none once it is pushed", () => {
		commit("Fix the stop (#12)");
		push();
		expect(unlanded(12)).toEqual([]);
	});

	it("names none that landed under a new hash, its twin on origin/landing", () => {
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
		git("update-ref", "-d", "refs/remotes/origin/landing");
		commit("Fix the stop (#12)");
		expect(() => unlanded(12)).toThrow("no origin/landing to compare against");
	});

	it("reads origin/main with the landing module off", () => {
		fs.writeFileSync(
			path.join(root, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, modules: [] }),
		);
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		commit("Fix the stop (#12)");
		expect(unlanded(12)).toEqual(["Fix the stop (#12)"]);
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		expect(unlanded(12)).toEqual([]);
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
		expect(text).toContain("#12's commit is not on origin/landing");
		expect(text).toContain(
			`  ${git("rev-parse", "--short", sha)} Fix the stop (#12)\n`,
		);
		expect(text).toContain("git fetch origin landing");
		expect(text).toContain("**Unlanded:**");
	});

	it("reads an Unlanded line only with something after it", () => {
		expect(hasUnlandedLine("**Unlanded:** a neighbour's cite.")).toBe(true);
		expect(hasUnlandedLine("**Unlanded:**\nnext line")).toBe(false);
	});
});
