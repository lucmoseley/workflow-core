import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	readAdopterCheckouts,
	readCheckoutTracking,
	discoverRepos,
	isOptedOut,
	readAbsence,
	readExclusionWhy,
	startDetachedIn,
} = require("./refill-repos.js");
const { readLandingOffWhy } = require("./landing-pin.js");

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-home-"));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function checkout(
	name: string,
	config: Record<string, unknown> | null,
	git: "dir" | "file" = "dir",
) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	if (git === "dir") fs.mkdirSync(path.join(root, ".git"));
	else fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
	if (config)
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, ...config }),
		);
	return root;
}

describe("discoverRepos (#2003)", () => {
	it("includes the five repos, excludes fantasy-books on its flag, and skips a linked worktree and a checkout with no config", () => {
		const included = [
			"design-vault",
			"health-and-fitness",
			"mantahostels",
			"mmm-infra",
			"workflow-core",
		].map((n) => checkout(n, {}));
		const books = checkout("fantasy-books", { refillLoop: false });
		const worktree = checkout("design-vault-proto-26", {}, "file");
		checkout("no-config", null);

		const found = discoverRepos(home);
		expect(found.included.sort()).toEqual(included.sort());
		expect(found.excluded).toEqual(
			expect.arrayContaining([
				{ root: books, why: "refillLoop: false" },
				{ root: worktree, why: "not a main checkout" },
			]),
		);
		expect(found.excluded).toHaveLength(2);
	});

	it("names a checkout whose config cannot be read as a fault, not an exclusion", () => {
		const root = checkout("broken", {});
		fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{");
		const found = discoverRepos(home);
		expect(found.included).toEqual([]);
		expect(found.excluded).toEqual([]);
		expect(found.faulted[0].root).toBe(root);
		expect(found.faulted[0].why).toContain("does not parse");
	});

	it("keeps out a checkout whose refillLoop is malformed, since its owner meant to opt out, naming it as a fault", () => {
		const root = checkout("typo", { refillLoop: "false" });
		expect(discoverRepos(home)).toEqual({
			included: [],
			excluded: [],
			faulted: [{ root, why: '"refillLoop" is not a boolean' }],
		});
	});
});

function pin(root: string, ref: string) {
	fs.writeFileSync(
		path.join(root, ".claude", "settings.json"),
		JSON.stringify({
			enabledPlugins: { "workflow-core@wfc": true },
			extraKnownMarketplaces: {
				wfc: { source: { source: "github", repo: "o/wfc", ref } },
			},
		}),
	);
	return root;
}

describe("readExclusionWhy (#5276)", () => {
	it("leaves out a repo pinned below v3.0.0 whose config lacks landing, keeping its tick", () => {
		const old = pin(checkout("old", {}), "v2.3.0");
		expect(readExclusionWhy(old)).toContain(
			"pinned to workflow-core v2.3.0 with `landing` off",
		);
		expect(isOptedOut(old)).toBe(false);
	});

	it("leaves out an old pin whose config will not read, and says why (#5301)", () => {
		const old = pin(checkout("unread", {}), "v2.3.0");
		const config = path.join(old, ".claude", "workflow-core.json");
		fs.chmodSync(config, 0o000);
		try {
			expect(readLandingOffWhy(old)).toMatch(
				/^pinned to workflow-core v2\.3\.0, before v3\.0\.0, and .*workflow-core\.json would not read \(EACCES.*so whether it runs `landing` off is unknown$/,
			);
			expect(readExclusionWhy(old)).toMatch(/EACCES/);
			expect(isOptedOut(old)).toBe(false);
		} finally {
			fs.chmodSync(config, 0o644);
		}
	});

	it("reads an old pin with no config as landing off (#5301)", () => {
		const bare = pin(checkout("bare", null), "v2.3.0");
		expect(readExclusionWhy(bare)).toContain(
			"pinned to workflow-core v2.3.0 with `landing` off",
		);
	});

	it("serves an old pin with landing on, a pin at or past v3.0.0, and a branch pin", () => {
		const on = pin(checkout("on", { modules: ["landing"] }), "v2.3.0");
		const current = pin(checkout("current", {}), "v3.0.0");
		const branch = pin(checkout("branch", {}), "main");
		const unpinned = checkout("unpinned", {});
		expect([on, current, branch, unpinned].map(readExclusionWhy)).toEqual([
			null,
			null,
			null,
			null,
		]);
	});
});

describe("isOptedOut (#4188)", () => {
	it("reads an owner's refillLoop: false as an opt-out, and a fault or a served repo as none", () => {
		const out = checkout("books", { refillLoop: false });
		const typo = checkout("typo", { refillLoop: "false" });
		const broken = checkout("broken", {});
		fs.writeFileSync(path.join(broken, ".claude", "workflow-core.json"), "{");
		const served = checkout("served", {});
		expect([out, typo, broken, served].map(isOptedOut)).toEqual([
			true,
			false,
			false,
			false,
		]);
	});
});

describe("readAbsence (#3835)", () => {
	it("carries a checkout with no config or no .git, and ends one whose directory is gone", () => {
		const noConfig = checkout("no-config", null);
		const noGit = checkout("no-git", {});
		fs.rmSync(path.join(noGit, ".git"), { recursive: true });

		expect(readAbsence(noConfig)).toEqual({
			carried: true,
			why: "no workflow-core config",
		});
		expect(readAbsence(noGit)).toEqual({ carried: true, why: "no .git" });
		expect(readAbsence(path.join(home, "gone"))).toEqual({
			carried: false,
			why: "directory gone",
		});
	});

	it("reads a plain file where the directory was as gone", () => {
		const root = path.join(home, "now-a-file");
		fs.writeFileSync(root, "");
		expect(readAbsence(root)).toEqual({
			carried: false,
			why: "directory gone",
		});
	});

	it("gives nothing for a linked worktree, with or without a config, or one its owner opted out", () => {
		expect(readAbsence(checkout("worktree", {}, "file"))).toBeNull();
		expect(readAbsence(checkout("bare-worktree", null, "file"))).toBeNull();
		expect(
			readAbsence(checkout("opted-out", { refillLoop: false })),
		).toBeNull();
	});

	it("gives nothing for a checkout whole enough for discovery", () => {
		expect(readAbsence(checkout("whole", {}))).toBeNull();
	});

	it("gives nothing for one its owner opted out, its .git missing too", () => {
		const root = checkout("opted-out", { refillLoop: false });
		fs.rmSync(path.join(root, ".git"), { recursive: true });
		expect(readAbsence(root)).toBeNull();
	});
});

describe("readAdopterCheckouts (#2121)", () => {
	it("returns fantasy-books, which discoverRepos leaves out on its refillLoop flag, and skips a linked worktree and a checkout with no config", () => {
		const core = checkout("workflow-core", {});
		const books = checkout("fantasy-books", { refillLoop: false });
		const worktree = checkout("workflow-core-wt", {}, "file");
		checkout("no-config", null);

		const found = readAdopterCheckouts(home);
		expect(found.included.sort()).toEqual([books, core].sort());
		expect(found.excluded).toEqual([
			{ root: worktree, why: "not a main checkout" },
		]);
		expect(discoverRepos(home).included).toEqual([core]);
	});
});

describe("readCheckoutTracking (#3487)", () => {
	const breakConfig = (root: string) =>
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			"{ nope",
		);

	it("finds the checkout past a neighbour whose config will not read", () => {
		breakConfig(checkout("aaa", {}));
		const theirs = checkout("zzz", { tracker: "owner/theirs" });
		expect(readCheckoutTracking("owner/theirs", home)).toEqual({
			root: theirs,
		});
	});

	it("finds a checkout its owner opted out of the refill loop, whose blocker another repo still pulls in (#3281)", () => {
		const z = checkout("z", { tracker: "o/z", refillLoop: false });
		expect(readCheckoutTracking("o/z", home)).toEqual({ root: z });
	});

	it("names that neighbour where nothing tracks the repo", () => {
		const broken = checkout("aaa", {});
		breakConfig(broken);
		const { why } = readCheckoutTracking("owner/nobody", home);
		expect(why).toContain(`no checkout under ${home} tracks owner/nobody`);
		expect(why).toContain(`and ${broken} (`);
	});
});

describe("startDetachedIn (#5615)", () => {
	it("starts its job on the wall clocks, whatever test clocks its starter carries", async () => {
		vi.stubEnv("WFC_NOW", "2020-01-01T00:00:00Z");
		vi.stubEnv("WFC_STEP_MS", "5");
		const out = path.join(home, "env.json");
		const job = path.join(home, "job.js");
		fs.writeFileSync(
			job,
			`require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.env.WFC_NOW ?? null, process.env.WFC_STEP_MS ?? null, process.env.WFC_REPO_ROOT]));`,
		);
		const failed: unknown[] = [];
		startDetachedIn(home, [job], (e: unknown) => failed.push(e));
		await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true));
		await vi.waitFor(() =>
			expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([
				null,
				null,
				home,
			]),
		);
		expect(failed).toEqual([]);
	});
});
