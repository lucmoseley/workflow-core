// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	buildRefusedMessage,
	type Contents,
	judgeContents,
	judgeRegistration,
	pairBlobs,
	parseStatus,
	presentEntries,
	type Status,
} from "./orphaned-worktree-refusals.js";

const WT = "/repo/.claude/worktrees/w1";
const H = "a".repeat(40);
const I = "b".repeat(40);
const W = "c".repeat(40);

const changed = (rel: string, head = H, index = H, xy = ".M") =>
	`1 ${xy} N... 100644 100644 100644 ${head} ${index} ${rel}`;

const status = (...fields: string[]): Status =>
	parseStatus(`${fields.join("\0")}\0`);

const clean = (over: Partial<Contents> = {}): Contents => ({
	target: WT,
	ref: "origin/main",
	commits: { unlanded: 0 },
	status: status(),
	keptOnRef: [],
	files: [],
	landed: [],
	processes: [],
	selfPid: "1",
	ownership: { ownedTrees: [], unread: [], owner: null },
	...over,
});

describe("judgeRegistration", () => {
	const reg = {
		root: "/repo",
		mainRoot: "/repo",
		target: WT,
		cwd: "/elsewhere",
		linked: [WT],
	};

	it.each([
		[
			"an unreadable worktree list",
			{ linked: null },
			`git would not list the worktrees of /repo, so ${WT} cannot be confirmed as one`,
		],
		[
			"the main checkout",
			{ target: "/repo", cwd: "/elsewhere" },
			"/repo is the main checkout, not a linked worktree",
		],
		[
			"an unregistered path",
			{ linked: ["/repo/.claude/worktrees/w2"] },
			`${WT} is not a registered worktree of /repo`,
		],
		[
			"the caller's own directory",
			{ cwd: `${WT}/sub` },
			`${WT} holds this command's own working directory`,
		],
	])("refuses %s", (_, over, why) => {
		expect(judgeRegistration({ ...reg, ...over })).toBe(why);
	});

	it("passes a registered worktree the caller stands outside", () => {
		expect(judgeRegistration(reg)).toBeNull();
		expect(judgeRegistration({ ...reg, cwd: `${WT}-other` })).toBeNull();
	});
});

describe("judgeContents", () => {
	it("passes a worktree with nothing unlanded and nobody in it", () => {
		expect(judgeContents(clean())).toEqual([]);
	});

	it.each<[string, Partial<Contents>, string]>([
		[
			"an unresolved landed ref",
			{ commits: { unresolved: true } },
			"origin/main does not resolve, so whether its HEAD has landed is unknown",
		],
		[
			"an uncountable history",
			{ commits: { unlanded: null } },
			"git would not count its commits off origin/main",
		],
		[
			"commits off the landed ref",
			{ commits: { unlanded: 2 } },
			"its HEAD has 2 commit(s) not on origin/main",
		],
		[
			"an unreadable status",
			{ status: null, files: null },
			"git status would not list its paths",
		],
		[
			"an unmerged path",
			{
				status: status(
					`u UU N... 100644 100644 100644 100644 ${H} ${I} ${W} a.txt`,
				),
			},
			`unmerged or submodule path(s) it cannot judge: u UU N... 100644 100644 100644 100644 ${H} ${I} ${W} a.txt`,
		],
		[
			"a submodule",
			{ status: status(`1 .M SC.. 160000 160000 160000 ${H} ${H} sub`) },
			"unmerged or submodule path(s) it cannot judge",
		],
		[
			"a deletion still on the landed ref",
			{ keptOnRef: ["z.txt", "a.txt"] },
			"deleted here but still on origin/main: a.txt, z.txt",
		],
		[
			"unhashable working files",
			{ files: null },
			"git would not hash its working files",
		],
		[
			"staged content that is neither HEAD's nor the working copy's",
			{ files: [{ rel: "a.txt", head: H, index: I, gone: false, blob: H }] },
			"staged content that is neither HEAD's nor the working copy's: a.txt",
		],
		[
			"a change not on the landed history",
			{
				files: [{ rel: "a.txt", head: H, index: H, gone: false, blob: W }],
				landed: [false],
			},
			"changed and not on origin/main's history: a.txt",
		],
		[
			"an untracked file",
			{ status: status("? new.txt") },
			"untracked file(s) not gitignored: new.txt",
		],
		[
			"an unreadable process table",
			{ processes: { error: "EACCES" } },
			"the process table would not read (EACCES), so a process inside it cannot be ruled out",
		],
		[
			"a process inside it",
			{ processes: [{ pid: "42", cwd: `${WT}/sub` }] },
			"process(es) 42 have their working directory inside it",
		],
		[
			"unread live ownership",
			{ ownership: { why: "the arbiter's lock store would not read" } },
			"the arbiter's lock store would not read, so whether a live session owns it is unknown",
		],
		[
			"a live session's path in it",
			{
				ownership: { ownedTrees: [WT, "/other", WT], unread: [], owner: null },
			},
			"a live session claims, observed or wrote 2 path(s) in it",
		],
		[
			"unread job state",
			{ ownership: { ownedTrees: [], unread: ["/jobs/x"], owner: null } },
			"job state /jobs/x would not read, so its owner is unknown",
		],
		[
			"a live owning session",
			{
				ownership: {
					ownedTrees: [],
					unread: [],
					owner: { sessionId: "s1", name: "Worker one", live: true },
				},
			},
			"live session s1 (Worker one) owns it",
		],
	])("refuses %s", (_, over, why) => {
		const refusals = judgeContents(clean(over));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(why);
	});

	it.each<[string, Partial<Contents>]>([
		[
			"a change that landed",
			{
				files: [{ rel: "a.txt", head: H, index: H, gone: false, blob: W }],
				landed: [true],
			},
		],
		[
			"a staged change equal to the working copy",
			{
				files: [{ rel: "a.txt", head: H, index: W, gone: false, blob: W }],
				landed: [true],
			},
		],
		["its own process", { processes: [{ pid: "1", cwd: WT }] }],
		["a process beside it", { processes: [{ pid: "42", cwd: `${WT}-x` }] }],
		[
			"an owner no longer live",
			{
				ownership: {
					ownedTrees: [],
					unread: [],
					owner: { sessionId: "s1", name: null, live: false },
				},
			},
		],
	])("passes %s", (_, over) => {
		expect(judgeContents(clean(over))).toEqual([]);
	});

	it("judges only the files whose working copy differs from HEAD against `landed`", () => {
		const files = [
			{ rel: "same.txt", head: H, index: H, gone: false, blob: H },
			{ rel: "b.txt", head: H, index: H, gone: false, blob: W },
		];
		expect(judgeContents(clean({ files, landed: [false] }))).toEqual([
			"changed and not on origin/main's history: b.txt",
		]);
	});

	it("names a long list by its first five", () => {
		const names = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `? ${n}`);
		expect(judgeContents(clean({ status: status(...names) }))).toEqual([
			"untracked file(s) not gitignored: a, b, c, d, e, and 2 more",
		]);
	});

	it("names every failing condition at once, in order", () => {
		expect(
			judgeContents(
				clean({
					commits: { unlanded: 1 },
					status: status("? new.txt"),
					files: [{ rel: "a.txt", head: H, index: H, gone: false, blob: W }],
					landed: [false],
					processes: [{ pid: "42", cwd: WT }],
					ownership: { why: "x" },
				}),
			),
		).toEqual([
			"its HEAD has 1 commit(s) not on origin/main",
			"changed and not on origin/main's history: a.txt",
			"untracked file(s) not gitignored: new.txt",
			"process(es) 42 have their working directory inside it",
			"x, so whether a live session owns it is unknown",
		]);
	});
});

describe("parseStatus", () => {
	it("reads a rename's source as deleted and a D as gone", () => {
		const s = status(
			`2 R. N... 100644 100644 100644 ${H} ${H} R100 new.txt`,
			"old.txt",
			changed("gone.txt", H, H, ".D"),
		);
		expect(s.deleted).toEqual(["old.txt"]);
		expect(s.tracked.map((e) => [e.rel, e.gone])).toEqual([
			["new.txt", false],
			["gone.txt", true],
		]);
		expect(pairBlobs(presentEntries(s), [W])).toEqual([
			{ rel: "new.txt", head: H, index: H, gone: false, blob: W },
		]);
	});

	it("reads a rename with no source field as a path it cannot judge", () => {
		const raw = `2 R. N... 100644 100644 100644 ${H} ${H} R100 new.txt`;
		expect(parseStatus(raw).odd).toEqual([raw]);
	});
});

describe("buildRefusedMessage", () => {
	it("lists each refusal and both ways out", () => {
		expect(
			buildRefusedMessage(WT, ["one", "two"], { status: "S", land: "L" }),
		).toBe(
			`refused, nothing removed — ${WT}:\n  - one\n  - two\nClear each, or read what it holds (S) and land it: L`,
		);
	});
});
