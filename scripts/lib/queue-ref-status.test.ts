// @vitest-environment node
/*
 * lib/queue-ref-status.js through readQueueRefStates, on a fixture checkout
 * whose records, ledger and commits are real, as the main sha is read off
 * git.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redPathAtRest } from "./queue-lander.js";
import type { QueueEvent } from "./queue-log.js";
import { buildQueueRefLine, readQueueRefStates } from "./queue-ref-status.js";

const SINCE = Date.parse("2026-11-01T00:00:00Z");
const REF = "refs/heads/queue/alpha";

let root: string;
let tree: string;
/** `seed` on main, `member` on it, `merged` the no-ff merge, `later` on member. */
let seed: string;
let member: string;
let merged: string;
let later: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const commit = (name: string) => {
	fs.writeFileSync(path.join(root, `${name}.txt`), name);
	git("add", "-A");
	git("commit", "-qm", name);
	return git("rev-parse", "HEAD");
};

const markers = () => path.join(root, ".claude", "tmp", "markers");
const short = (sha: string) => sha.slice(0, 9);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-ref-status-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	seed = commit("seed");
	member = commit("member");
	later = commit("later");
	git("checkout", "-q", "--detach", seed);
	git("merge", "-q", "--no-ff", "--no-edit", member);
	merged = git("rev-parse", "HEAD");
	tree = path.join(root, ".claude", "worktrees", "alpha");
	fs.mkdirSync(tree, { recursive: true });
	fs.writeFileSync(path.join(tree, ".git"), "gitdir: elsewhere\n");
	fs.utimesSync(path.join(tree, ".git"), SINCE / 1000, SINCE / 1000);
	fs.mkdirSync(markers(), { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const row = (min: number, event: QueueEvent, sha: string, ref = REF) => ({
	at: SINCE + min * 60_000,
	event,
	ref,
	sha,
});

const aBatch = (over: Record<string, unknown> = {}) => ({
	slot: 0,
	members: [{ name: "alpha", sha: member, pushedAt: 1 }],
	deferred: [],
	dropped: [],
	onto: seed,
	integration: null,
	phase: "merging",
	...redPathAtRest(),
	...over,
});

/** The pipeline record holding one batch, the line's head. */
const batch = (over: Record<string, unknown> = {}) => ({
	line: [aBatch(over)],
	search: null,
	depth: 2,
});

interface Fixture {
	waiting?: string | null;
	rows?: ReturnType<typeof row>[];
	/** The batch record; raw text where a string. */
	batch?: object | string;
	drops?: object[] | string;
	dropped?: { ref: string; sha: string }[];
	main?: string | null;
	green?: string[];
}

const write = (name: string, v: object | string | undefined) => {
	if (v !== undefined)
		fs.writeFileSync(
			path.join(markers(), name),
			typeof v === "string" ? v : JSON.stringify(v),
		);
};

function lines(f: Fixture = {}) {
	write(".queue-lander-batch.json", f.batch);
	write(".queue-lander-drops.json", f.drops);
	if (f.green)
		fs.writeFileSync(
			path.join(markers(), ".landing-green-ledger"),
			f.green.map((s) => `${s} 2026-11-02T00:00:00Z\n`).join(""),
		);
	const waiting = f.waiting === undefined ? member : f.waiting;
	return readQueueRefStates(
		root,
		tree,
		{
			main: f.main === undefined ? seed : f.main,
			queue:
				waiting === null ? [] : [{ name: "alpha", sha: waiting, pushedAt: 1 }],
			dropped: f.dropped ?? [],
		},
		f.rows ?? [],
	).map(buildQueueRefLine);
}

describe("a waiting ref", () => {
	it("reads as queued where no batch is live", () => {
		expect(lines({ rows: [row(1, "enqueue", member)] })).toEqual([
			`queued: queue/alpha at ${short(member)} — waiting for the lander's next batch`,
		]);
	});

	it("reads as testing in the live batch at its snapshot sha main does not hold", () => {
		expect(
			lines({
				rows: [row(1, "enqueue", member), row(2, "take", member)],
				batch: batch({ phase: "testing", integration: merged }),
			}),
		).toEqual([
			`testing: queue/alpha at ${short(member)} — in the lander's batch under test`,
		]);
	});

	it("reads as landed at the batch's integration once main holds its snapshot, before the lander records it", () => {
		expect(
			lines({
				rows: [row(1, "enqueue", member), row(2, "take", member)],
				batch: batch({ phase: "testing", integration: merged }),
				main: merged,
			}),
		).toEqual([
			`landed: queue/alpha at ${short(member)} — on main at ${short(merged)}`,
		]);
	});

	it("names the walk's failure where git cannot say whether main holds its snapshot", () => {
		const [line] = lines({
			batch: batch({ phase: "testing", integration: merged }),
			main: "f".repeat(40),
		});
		expect(line).toMatch(
			new RegExp(
				`^testing or landed: queue/alpha at ${short(member)} — could not walk main: fatal: [^\\n]+$`,
			),
		);
	});

	it("reads as queued where it moved after its snapshot, naming the snapshot", () => {
		expect(
			lines({
				waiting: later,
				rows: [
					row(1, "enqueue", member),
					row(2, "take", member),
					row(3, "enqueue", later),
				],
				batch: batch({ phase: "testing", integration: merged }),
			}),
		).toEqual([
			`queued: queue/alpha at ${short(later)} — moved past its snapshot ${short(member)} in the batch under test, so it waits for the next batch`,
		]);
	});

	it("reads as testing in a batch behind the head, and landed off a landed one beside it (#4556)", () => {
		const behind = {
			line: [
				aBatch({
					members: [{ name: "beta", sha: later, pushedAt: 3 }],
					phase: "testing",
					integration: merged,
				}),
				aBatch({ slot: 1, phase: "testing", integration: later }),
			],
			search: null,
			depth: 2,
		};
		expect(lines({ waiting: member, batch: behind })).toEqual([
			`testing: queue/alpha at ${short(member)} — in the lander's batch under test`,
		]);
	});

	it("reads as queued where the batch left it out", () => {
		expect(
			lines({ batch: batch({ deferred: ["alpha"], phase: "testing" }) }),
		).toEqual([
			`queued: queue/alpha at ${short(member)} — waiting for the lander's next batch`,
		]);
	});

	it("says so where the batch record is torn, claiming neither state", () => {
		expect(lines({ batch: '{"members": [' })).toEqual([
			`queued or testing: queue/alpha at ${short(member)} — the batch record is torn, so whether the batch under test holds it is unknown`,
		]);
	});

	it("says so where the log has it taken but no batch record exists", () => {
		expect(
			lines({ rows: [row(1, "enqueue", member), row(2, "take", member)] }),
		).toEqual([
			`queued or testing: queue/alpha at ${short(member)} — the queue log has it taken, but there is no batch record to say whether the batch under test holds it`,
		]);
	});
});

describe("a landed ref", () => {
	it("names the main sha off the batch record", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(1, "take", member), row(2, "land", member)],
				batch: batch({ phase: "landed", integration: merged }),
			}),
		).toEqual([
			`landed: queue/alpha at ${short(member)} — on main at ${short(merged)}`,
		]);
	});

	it("names the main sha off the green ledger and main's first-parent path once the batch record moved on", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "land", member)],
				batch: batch({ members: [{ name: "beta", sha: later, pushedAt: 3 }] }),
				main: merged,
				green: [merged],
			}),
		).toEqual([
			`landed: queue/alpha at ${short(member)} — on main at ${short(merged)}`,
		]);
	});

	it("says so where neither record names the main sha", () => {
		expect(
			lines({ waiting: null, rows: [row(2, "land", member)], main: merged }),
		).toEqual([
			`landed: queue/alpha at ${short(member)} — on main, but neither the batch record nor the green ledger names the main sha it reached`,
		]);
	});

	it("names the walk's failure, blaming no record", () => {
		const [line] = lines({
			waiting: null,
			rows: [row(2, "land", "f".repeat(40))],
			main: merged,
		});
		expect(line).toMatch(
			/^landed: queue\/alpha at fffffffff — on main, but could not walk main: fatal: [^\n]+$/,
		);
	});

	it("reads a ref still at its landed sha as landed, and a later push as queued", () => {
		expect(
			lines({
				rows: [row(1, "enqueue", member), row(2, "land", member)],
				main: merged,
				green: [merged],
			}),
		).toHaveLength(1);
		expect(
			lines({
				waiting: later,
				rows: [row(2, "land", member), row(3, "enqueue", later)],
				main: merged,
				green: [merged],
			}),
		).toEqual([
			`landed: queue/alpha at ${short(member)} — on main at ${short(merged)}`,
			`queued: queue/alpha at ${short(later)} — waiting for the lander's next batch`,
		]);
	});

	it("reads another ref's rows, or its own from before the worktree was made, as none of its own", () => {
		expect(
			lines({
				waiting: null,
				rows: [
					row(2, "land", member, "refs/heads/queue/beta"),
					row(-1, "land", member),
				],
			}),
		).toEqual([]);
	});
});

describe("a dropped ref", () => {
	const drop = (over: Record<string, unknown> = {}) => ({
		name: "alpha",
		sha: member,
		ref: "dropped/alpha",
		onto: seed,
		cause: { kind: "conflict", name: "alpha", files: ["x"] },
		ticket: 77,
		at: SINCE + 60_000,
		...over,
	});

	it("names its fix ticket and dropped ref off the drop record", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", member)],
				drops: [drop()],
			}),
		).toEqual([
			`dropped: queue/alpha at ${short(member)} — kept as dropped/alpha, fix ticket #77`,
		]);
	});

	it("names its closed fix ticket once the lander reaped its dropped ref", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", member)],
				drops: [drop({ reapedAt: SINCE + 120_000 })],
			}),
		).toEqual([
			`dropped: queue/alpha at ${short(member)} — fix ticket #77 (closed), dropped ref reaped`,
		]);
	});

	it("says a fix ticket not yet filed, from a drop the log missed", () => {
		expect(
			lines({
				waiting: null,
				drops: [drop({ ref: `dropped/alpha-${short(member)}`, ticket: null })],
			}),
		).toEqual([
			`dropped: queue/alpha at ${short(member)} — kept as dropped/alpha-${short(member)}, its fix ticket not yet filed`,
		]);
	});

	it("reads an earlier session's drop of the same worktree name as none of its own", () => {
		expect(
			lines({ waiting: null, drops: [drop({ at: SINCE - 60_000 })] }),
		).toEqual([]);
	});

	it("names the dropped ref off the remote where the drop record holds no entry, matching only its own names", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", member)],
				drops: [],
				dropped: [
					{ ref: "dropped/alpha-x", sha: member },
					{ ref: `dropped/alpha-${short(member)}`, sha: member },
				],
			}),
		).toEqual([
			`dropped: queue/alpha at ${short(member)} — kept as dropped/alpha-${short(member)}; the drop record holds no entry for it, so its fix ticket is unknown`,
		]);
	});

	it("says so where the drop record is torn", () => {
		expect(
			lines({ waiting: null, rows: [row(2, "drop", member)], drops: "[{" }),
		).toEqual([
			`dropped: queue/alpha at ${short(member)} — no dropped ref holds it; the drop record is torn, so its fix ticket is unknown`,
		]);
	});
});
