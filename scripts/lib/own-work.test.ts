// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./git-fixture";

const require = createRequire(import.meta.url);
const { readNeighbourCommits, readOwnPaths } = require("./own-work.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(dir: string, files: Record<string, string>) {
	for (const [f, text] of Object.entries(files))
		fs.writeFileSync(path.join(dir, f), text);
	git(dir, "add", ...Object.keys(files));
	git(dir, "commit", "-qm", Object.keys(files).join(" "));
	return git(dir, "rev-parse", "HEAD");
}

const ranged = defineTemplate((dir) => {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	commit(dir, {
		"mine.js": "0\n",
		"theirs.js": "0\n",
		"loose.js": "0\n",
		"shared.js": "0\n",
		"reverted.js": "0\n",
	});
	commit(dir, { "mine.js": "1\n", "shared.js": "1\n" });
	commit(dir, { "theirs.js": "1\n", "reverted.js": "1\n" });
	commit(dir, { "loose.js": "1\n" });
	commit(dir, { "shared.js": "2\n" });
});

function range() {
	const dir = ranged.instantiate(mkScratchDir("own-work-"));
	dirs.push(dir);
	const [base, mine, theirs, loose, theirsToo] = git(
		dir,
		"rev-list",
		"--reverse",
		"HEAD",
	).split("\n");
	return { dir, base, mine, theirs, loose, theirsToo };
}

function ledgerOf(ledgers: Record<string, string[] | null>) {
	return {
		ledgerRoot: () => "/main",
		readCommitsBy: (id: string) => (id in ledgers ? ledgers[id] : []),
		readOwnersOf: (commits: string[]) => {
			const owners = new Map<string, string>();
			for (const [id, shas] of Object.entries(ledgers))
				for (const sha of shas ?? [])
					if (commits.includes(sha) && !owners.has(sha)) owners.set(sha, id);
			return owners;
		},
	};
}

describe("readNeighbourCommits, #1154's rule", () => {
	it("names a commit another ledger holds and the launcher's does not", () => {
		const ledger = ledgerOf({ me: ["a"], them: ["b", "a"] });
		expect(readNeighbourCommits(["a", "b", "c"], "me", { ledger })).toEqual(
			new Map([["b", "them"]]),
		);
	});

	it("cannot tell with no session id, no main worktree, or a ledger that will not read", () => {
		const ledger = ledgerOf({ me: [], them: ["b"] });
		expect(readNeighbourCommits(["b"], "", { ledger })).toBeNull();
		expect(
			readNeighbourCommits(["b"], "me", {
				ledger: { ...ledger, ledgerRoot: () => null },
			}),
		).toBeNull();
		expect(
			readNeighbourCommits(["b"], "me", { ledger: ledgerOf({ me: null }) }),
		).toBeNull();
		expect(
			readNeighbourCommits(["b"], "me", {
				ledger: { ...ledger, readOwnersOf: () => null },
			}),
		).toBeNull();
		expect(
			readNeighbourCommits(["b"], "me", {
				ledger: {
					...ledger,
					readOwnersOf: () => {
						throw new Error("EIO");
					},
				},
			}),
		).toBeNull();
	});
});

describe("readOwnPaths, the bare run's own-work path set (#1216)", () => {
	it("leaves out the paths only a neighbour's commit touched, and keeps unledgered and shared ones", () => {
		const r = range();
		const ledger = ledgerOf({
			me: [r.mine],
			them: [r.theirs, r.theirsToo],
		});
		const own = readOwnPaths(r.dir, r.base, { sessionId: "me", ledger });
		expect(own.dropped.sort()).toEqual([r.theirs, r.theirsToo].sort());
		expect(own.kept.sort()).toEqual([r.mine, r.loose].sort());
		expect(own.paths).toEqual(["loose.js", "mine.js", "shared.js"]);
	});

	it("adds the tree's uncommitted tracked files", () => {
		const r = range();
		fs.writeFileSync(path.join(r.dir, "theirs.js"), "dirty\n");
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine], them: [r.theirs, r.theirsToo] }),
		});
		expect(own.paths).toContain("theirs.js");
	});

	it("reads the tip alone, so no uncommitted file enters (#1218)", () => {
		const r = range();
		fs.writeFileSync(path.join(r.dir, "theirs.js"), "dirty\n");
		fs.writeFileSync(path.join(r.dir, "mine.js"), "0\n");
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine], them: [r.theirs, r.theirsToo] }),
			tip: r.loose,
		});
		expect(own.paths).toEqual(["loose.js", "mine.js", "shared.js"]);
		expect(own.dropped).toEqual([r.theirs]);
	});

	it("keeps out a path whose net change since the base is nil", () => {
		const r = range();
		const back = commit(r.dir, { "reverted.js": "0\n" });
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine, back], them: [r.theirs] }),
		});
		expect(own.paths).not.toContain("reverted.js");
	});

	it("drops nothing where every commit is the launcher's or in no ledger", () => {
		const r = range();
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine] }),
		});
		expect(own.dropped).toEqual([]);
		expect(own.paths).toEqual(
			git(r.dir, "diff", "--name-only", r.base).split("\n"),
		);
	});

	it("cannot say with no session id, an unreadable ledger, or a range git will not read", () => {
		const r = range();
		const ledger = ledgerOf({ me: [r.mine], them: [r.theirs] });
		expect(readOwnPaths(r.dir, r.base, { sessionId: "", ledger })).toBeNull();
		expect(
			readOwnPaths(r.dir, r.base, {
				sessionId: "me",
				ledger: ledgerOf({ me: null }),
			}),
		).toBeNull();
		expect(
			readOwnPaths(r.dir, "no-such-ref", { sessionId: "me", ledger }),
		).toBeNull();
	});
});

describe("readOwnPaths byPatch, a review marker's newer base= (#3108)", () => {
	it("leaves out an unledgered commit whose patch matches none of the launcher's", () => {
		const r = range();
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine], them: [r.theirs, r.theirsToo] }),
			tip: r.theirsToo,
			byPatch: true,
		});
		expect(own.kept).toEqual([r.mine]);
		expect(own.paths).toEqual(["mine.js", "shared.js"]);
	});

	it("keeps an unledgered commit carrying the launcher's ledgered patch, as a rebase leaves it", () => {
		const r = range();
		git(r.dir, "checkout", "-q", "--detach", r.base);
		const before = commit(r.dir, { "loose.js": "1\n" });
		const own = readOwnPaths(r.dir, r.base, {
			sessionId: "me",
			ledger: ledgerOf({ me: [r.mine, before], them: [r.theirs, r.theirsToo] }),
			tip: r.theirsToo,
			byPatch: true,
		});
		expect(own.kept.sort()).toEqual([r.mine, r.loose].sort());
		expect(own.paths).toEqual(["loose.js", "mine.js", "shared.js"]);
	});

	it("keeps the launcher's commit rebased over a neighbour's edit to the lines beside it", () => {
		const r = range();
		const lines10 = (at: number, text: string) =>
			Array.from({ length: 10 }, (_, i) => (i === at ? text : `${i}`)).join(
				"\n",
			);
		const start = commit(r.dir, { "long.js": lines10(-1, "") });
		const before = commit(r.dir, { "long.js": lines10(5, "mine") });
		git(r.dir, "reset", "-q", "--hard", start);
		const near = commit(r.dir, { "long.js": lines10(3, "theirs") });
		git(r.dir, "cherry-pick", before);
		const rebased = git(r.dir, "rev-parse", "HEAD");
		const own = readOwnPaths(r.dir, near, {
			sessionId: "me",
			ledger: ledgerOf({ me: [before] }),
			tip: rebased,
			byPatch: true,
		});
		expect(own.kept).toEqual([rebased]);
	});

	it("cannot say where git will not read the patches", () => {
		const r = range();
		const execFn = (file: string, args: string[], options: object) => {
			if (args[0] === "patch-id") throw new Error("EIO");
			return execFileSync(file, args, options);
		};
		expect(
			readOwnPaths(r.dir, r.base, {
				sessionId: "me",
				ledger: ledgerOf({ me: [r.mine] }),
				tip: r.theirsToo,
				byPatch: true,
				execFn,
			}),
		).toBeNull();
	});
});
