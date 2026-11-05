// @vitest-environment node
/*
 * lib/queue-lander.js's green path, drop and defer (#4485, spec #4458),
 * driven through runQueueLander with an in-memory remote, tester, tracker,
 * ledgers and records: each case asserts the actions the machine chose and
 * where the remote ends.
 *
 * Loosen it and a batch lands untested or out of push order, a push made
 * while a batch is tested lands half-tested or is deleted unlanded, a
 * restart tests a sha again, a network blip throws a batch away, a member
 * that conflicts with another is dropped or one that conflicts with `main`
 * stops the queue, a dropped sha is lost or its fix ticket goes unfiled, or
 * a dropped ref outlives its closed ticket.
 */
import { describe, expect, it } from "vitest";
import type { Verdict } from "./lander.js";
import {
	type Batch,
	type Drop,
	type LanderEvent,
	type Member,
	type MergeResult,
	type QueueAction,
	type QueueLanderDeps,
	runQueueLander,
} from "./queue-lander.js";

interface Ref {
	sha: string;
	pushedAt: number;
	/** Descends from `main`, so the merge of it alone is itself. */
	onMain?: boolean;
	/** What its merge conflicts with in `<name>.txt`: `main`, or a member's name. */
	conflicts?: string[];
	/** Its merge refused, by a commit gate, giving this reason. */
	refused?: string;
}

/** The remote: `main`, the queue refs by name and the dropped refs. */
interface Remote {
	main: string;
	refs: Map<string, Ref>;
	dropped: Map<string, string>;
}

const remoteOf = (
	main: string,
	refs: Record<string, Ref> = {},
	dropped: Record<string, string> = {},
): Remote => ({
	main,
	refs: new Map(Object.entries(refs)),
	dropped: new Map(Object.entries(dropped)),
});

/** The disk a restart keeps: the ledgers, records, queue log and tracker. */
const freshDisk = () => ({
	green: new Set<string>(),
	verdicts: new Map<string, Verdict>(),
	batch: null as Batch | null,
	drops: [] as Drop[],
	log: [] as string[],
	/** Each ticket's state; the filed ones open. */
	tickets: new Map<number, "open" | "closed">(),
	filed: [] as Drop[],
});
type Disk = ReturnType<typeof freshDisk>;

const mergeSha = (onto: string, members: readonly Member[]) =>
	`merge(${onto};${members.map((m) => m.sha).join(",")})`;

interface Options {
	/** The tester's answer at a sha; green naming run 1 where absent. */
	verdict?: (sha: string, remote: Remote) => Verdict;
	requiresRun?: boolean;
	/** The merge's outcome; every member merged where absent. */
	merge?: (onto: string, members: readonly Member[]) => MergeResult;
	/** Throws in place of a call, by its name, while it returns an error. */
	fault?: (call: string) => Error | undefined;
	/** Runs before a compare-and-delete reads the ref. */
	beforeDelete?: (branch: string, remote: Remote) => void;
	/** Throws in place of filing a fix ticket while it returns an error. */
	fileFault?: () => Error | undefined;
	acquired?: boolean;
}

/**
 * The fake merge: each member in order onto `onto`, stopping at the first
 * refused or conflicting with `main` or an earlier member.
 */
function fakeMerge(
	remote: Remote,
	onto: string,
	members: readonly Member[],
): MergeResult {
	for (const [k, m] of members.entries()) {
		const r = remote.refs.get(m.name);
		const earlier = members.slice(0, k).map((x) => x.name);
		if (r?.refused) return { kind: "refused", name: m.name, reason: r.refused };
		if (r?.conflicts?.some((c) => c === "main" || earlier.includes(c)))
			return { kind: "conflict", name: m.name, files: [`${m.name}.txt`] };
	}
	const [lone] = members;
	const isLone =
		members.length === 1 &&
		lone !== undefined &&
		remote.refs.get(lone.name)?.onMain === true;
	return {
		kind: "merged",
		sha: isLone ? lone.sha : mergeSha(onto, members),
	};
}

/** A run against `remote` and `disk`, returning its end and every action. */
async function land(remote: Remote, disk: Disk, o: Options = {}) {
	const actions: QueueAction[] = [];
	const asked: string[] = [];
	const said: string[] = [];
	const call = (name: string) => {
		const err = o.fault?.(name);
		if (err) throw err;
	};
	const deps: QueueLanderDeps = {
		git: {
			refs: () => {
				call("refs");
				return {
					main: remote.main,
					queue: [...remote.refs].map(([name, r]) => ({
						name,
						sha: r.sha,
						pushedAt: r.pushedAt,
					})),
					dropped: [...remote.dropped].map(([ref, sha]) => ({ ref, sha })),
				};
			},
			mergeMembers: (onto, members) => {
				call("mergeMembers");
				return o.merge?.(onto, members) ?? fakeMerge(remote, onto, members);
			},
			pushBatch: () => call("pushBatch"),
			pushMain: (sha) => {
				call("pushMain");
				remote.main = sha;
			},
			deleteRef: (branch, sha) => {
				call("deleteRef");
				o.beforeDelete?.(branch, remote);
				const [kind, name = ""] = branch.split(/\/(.*)/);
				if (kind === "dropped") {
					if (remote.dropped.get(branch) !== sha) return false;
					remote.dropped.delete(branch);
					return true;
				}
				if (remote.refs.get(name)?.sha !== sha) return false;
				remote.refs.delete(name);
				return true;
			},
			createRef: (branch, sha) => {
				call("createRef");
				const held = remote.dropped.get(branch);
				if (held !== undefined && held !== sha)
					throw new Error(`${branch} holds ${held}`);
				remote.dropped.set(branch, sha);
			},
		},
		tester: {
			requiresRun: o.requiresRun ?? true,
			verdict: async (sha) => {
				asked.push(sha);
				return o.verdict?.(sha, remote) ?? { kind: "green", run: 1 };
			},
		},
		ledger: {
			has: (sha) => disk.green.has(sha),
			add: (sha) => {
				disk.green.add(sha);
			},
		},
		verdicts: {
			get: (sha, files) =>
				disk.verdicts.get(`${sha} ${files.join(",")}`) ?? null,
			add: (sha, files, v) => {
				disk.verdicts.set(`${sha} ${files.join(",")}`, v);
			},
		},
		record: {
			read: () => disk.batch,
			write: (b) => {
				disk.batch = b;
			},
		},
		drops: {
			read: () => disk.drops,
			write: (drops) => {
				disk.drops = [...drops];
			},
		},
		tracker: {
			fileDropTicket: (d) => {
				const err = o.fileFault?.();
				if (err) throw err;
				disk.filed.push(d);
				const n = 100 + disk.tickets.size;
				disk.tickets.set(n, "open");
				return `Filed #${n}: https://x/${n}`;
			},
			stateOf: (n) => {
				const state = disk.tickets.get(n);
				if (!state) throw new Error(`no issue #${n}`);
				return state;
			},
		},
		logQueue: (event: LanderEvent, m) => {
			disk.log.push(`${event} ${m.name}@${m.sha}`);
		},
		lock: { acquire: () => o.acquired ?? true, release: () => undefined },
		beat: () => undefined,
		wait: async () => undefined,
		log: (a) => actions.push(a),
		say: (line) => said.push(line),
	};
	const end = await runQueueLander(deps);
	return { end, actions, asked, said };
}

const kinds = (actions: QueueAction[]) => actions.map((a) => a.kind);
const taken = (actions: QueueAction[]) =>
	actions.flatMap((a) =>
		a.kind === "take-batch"
			? [a.batch.members.map((m) => `${m.name}@${m.sha}`)]
			: [],
	);
const NO_QUEUE = { kind: "exit", reason: "no queue ref waits" };

describe("the green path", () => {
	it("lands a lone ref as the integration commit its merge names, and deletes it", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual([
			"take-batch",
			"merge-members",
			"test-sha",
			"fast-forward-main",
			"delete-landed-ref",
			"exit",
		]);
		expect(remote.main).toBe("a1");
		expect(remote.refs.size).toBe(0);
		expect(disk.green.has("a1")).toBe(true);
	});

	it("takes every waiting ref, merges them in push order with the name breaking a tie, and lands the integration commit", async () => {
		const remote = remoteOf("m0", {
			b: { sha: "b1", pushedAt: 2 },
			c: { sha: "c1", pushedAt: 1 },
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1", "c@c1", "b@b1"]]);
		const integration = "merge(m0;a1,c1,b1)";
		expect(actions).toContainEqual({ kind: "test-sha", sha: integration });
		expect(remote.main).toBe(integration);
		expect(disk.green.has(integration)).toBe(true);
		expect(remote.refs.size).toBe(0);
	});

	it("merges a batch again onto main where main moved under it since its merge", async () => {
		const remote = remoteOf("m1", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const members = [
			{ name: "a", sha: "a1", pushedAt: 1 },
			{ name: "b", sha: "b1", pushedAt: 2 },
		];
		disk.batch = {
			members,
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: mergeSha("m0", members),
			phase: "testing",
		};

		const { actions } = await land(remote, disk);

		expect(actions[0]).toEqual({ kind: "merge-members", onto: "m1", members });
		expect(remote.main).toBe(mergeSha("m1", members));
	});
});

describe("a push during a run", () => {
	it("joins the next batch: the moved ref is kept and retaken at its new sha with the ref pushed meanwhile", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		let pushed = false;

		const { end, actions } = await land(remote, disk, {
			verdict: (_, r) => {
				if (!pushed) {
					pushed = true;
					r.refs.set("a", { sha: "a2", pushedAt: 3 });
					r.refs.set("c", { sha: "c1", pushedAt: 4 });
				}
				return { kind: "green", run: 1 };
			},
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([
			["a@a1", "b@b1"],
			["a@a2", "c@c1"],
		]);
		const deleted = actions.flatMap((a) =>
			a.kind === "delete-landed-ref" ? [`${a.name}@${a.sha}`] : [],
		);
		expect(deleted).toEqual(["b@b1", "a@a2", "c@c1"]);
		expect(remote.main).toBe("merge(merge(m0;a1,b1);a2,c1)");
	});

	it("keeps a ref that moves between the listing and its compare-and-delete, and lands it next", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		let moved = false;

		const { end, actions } = await land(remote, disk, {
			beforeDelete: (_, r) => {
				if (moved) return;
				moved = true;
				r.refs.set("a", { sha: "a2", pushedAt: 2 });
			},
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1"], ["a@a2"]]);
		expect(remote.main).toBe("merge(a1;a2)");
		expect(remote.refs.size).toBe(0);
	});
});

describe("verdicts", () => {
	it("never lands on an unknown verdict, keeping the batch for the next run to ask again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();

		const { end } = await land(remote, disk, {
			verdict: () => ({ kind: "unknown", reason: "no run at the sha" }),
		});

		expect(end).toEqual({
			kind: "exit",
			reason: "no verdict at a1: no run at the sha",
		});
		expect(remote.main).toBe("m0");
		expect(remote.refs.get("a")?.sha).toBe("a1");
		expect(disk.green.size).toBe(0);
		const again = await land(remote, disk);
		expect(again.asked).toEqual(["a1"]);
		expect(remote.main).toBe("a1");
	});

	it("never lands a green naming no CI run where main takes only a sha a run passed", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});

		const { end } = await land(remote, freshDisk(), {
			verdict: () => ({ kind: "green" }),
		});

		expect(end).toEqual({
			kind: "exit",
			reason: "no verdict at a1: its green read no CI run",
		});
		expect(remote.main).toBe("m0");
	});

	it("lands a green reached before a restart without asking the tester again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		let listings = 0;

		const first = await land(remote, disk, {
			fault: (c) =>
				c === "refs" && ++listings === 4 ? new Error("killed") : undefined,
		});
		expect(first.end).toEqual({
			kind: "exit",
			reason: "stopped on an error: killed",
		});
		expect(remote.main).toBe("m0");

		const second = await land(remote, disk, {
			verdict: () => ({ kind: "unknown", reason: "asked again" }),
		});

		expect(second.asked).toEqual([]);
		expect(second.end).toEqual(NO_QUEUE);
		expect(remote.main).toBe("a1");
	});

	it("stops on a red reached before a restart without testing it again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		const red = await land(remote, disk, {
			verdict: () => ({ kind: "red", files: ["scripts/x.test.ts"] }),
		});

		const second = await land(remote, disk);

		const end = {
			kind: "exit",
			reason:
				"the batch a1 is red on scripts/x.test.ts: the red path is unbuilt (#4485)",
		};
		expect(red.end).toEqual(end);
		expect(second.end).toEqual(end);
		expect(second.asked).toEqual([]);
		expect(remote.main).toBe("m0");
	});
});

describe("faults", () => {
	const blip = () =>
		Object.assign(new Error("push failed"), {
			stderr: "fatal: unable to access: Could not resolve host: github.com",
		});

	it("retries a transient fault with the batch kept, testing it once", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		let pushes = 0;

		const { end, actions, asked } = await land(remote, freshDisk(), {
			fault: (c) => (c === "pushMain" && ++pushes <= 2 ? blip() : undefined),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked).toEqual(["a1"]);
		expect(kinds(actions).filter((k) => k === "take-batch")).toHaveLength(1);
		expect(remote.main).toBe("a1");
	});

	it("retries a no verdict its tester marks transient with the batch kept, and lands the green that follows", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		let shut = 2;

		const { end, actions, asked } = await land(remote, freshDisk(), {
			verdict: () =>
				shut-- > 0
					? {
							kind: "unknown",
							reason: "no suite slot by the ceiling",
							transient: true,
						}
					: { kind: "green", run: 1 },
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked).toEqual(["a1", "a1", "a1"]);
		expect(kinds(actions).filter((k) => k === "take-batch")).toHaveLength(1);
		expect(remote.main).toBe("a1");
	});

	it("exits naming a transient no verdict that outlasts the tries, ledgering none", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();

		const { end } = await land(remote, disk, {
			verdict: () => ({
				kind: "unknown",
				reason: "no suite slot by the ceiling",
				transient: true,
			}),
		});

		expect(end).toEqual({
			kind: "exit",
			reason:
				"stopped on an error: no verdict at a1: no suite slot by the ceiling",
		});
		expect(disk.verdicts.size).toBe(0);
		expect(remote.main).toBe("m0");
	});

	it("retries a spawn fault in a merge, and exits naming a fault that outlasts the tries", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end } = await land(remote, disk, {
			fault: (c) =>
				c === "mergeMembers"
					? Object.assign(new Error("spawnSync git EAGAIN"), { code: "EAGAIN" })
					: undefined,
		});

		expect(end).toEqual({
			kind: "exit",
			reason: "stopped on an error: spawnSync git EAGAIN",
		});
		expect(remote.main).toBe("m0");
		expect(disk.batch?.phase).toBe("merging");
	});

	it("exits at once on a fault no retry outlasts, as a refused push to main", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		let pushes = 0;

		const { end } = await land(remote, freshDisk(), {
			fault: (c) =>
				c === "pushMain" && ++pushes === 1
					? Object.assign(new Error("push"), {
							stderr:
								" ! [remote rejected] a1 -> main (protected branch hook declined)",
						})
					: undefined,
		});

		expect(end).toEqual({
			kind: "exit",
			reason:
				"stopped on an error:  ! [remote rejected] a1 -> main (protected branch hook declined)",
		});
		expect(pushes).toBe(1);
	});
});

const dropsOf = (actions: QueueAction[]) =>
	actions.flatMap((a) => (a.kind === "drop-member" ? [a.drop] : []));

describe("drop and defer", () => {
	it("drops a member conflicting with main without merging it alone again, files its fix ticket, and lands the rest", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();

		const { end, actions, said } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		const drop = {
			name: "a",
			sha: "a1",
			ref: "dropped/a",
			onto: "m0",
			cause: { kind: "conflict", name: "a", files: ["a.txt"] },
			ticket: null,
		};
		expect(kinds(actions)).toEqual([
			"take-batch",
			"merge-members",
			"drop-member",
			"file-fix-ticket",
			"merge-members",
			"test-sha",
			"fast-forward-main",
			"delete-landed-ref",
			"exit",
		]);
		expect(dropsOf(actions)).toEqual([drop]);
		expect(disk.filed).toEqual([drop]);
		expect(said).toEqual(["Filed #100: https://x/100"]);
		expect(disk.drops).toEqual([{ ...drop, ticket: 100 }]);
		expect(remote.dropped).toEqual(new Map([["dropped/a", "a1"]]));
		expect(remote.refs.size).toBe(0);
		expect(remote.main).toBe("b1");
		expect(disk.log).toEqual([
			"take a@a1",
			"take b@b1",
			"drop a@a1",
			"land b@b1",
		]);
	});

	it("drops a later member that does not merge onto main alone either, as one a commit gate refuses", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2, refused: "rule:size-line refused it" },
			c: { sha: "c1", pushedAt: 3 },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(actions).toContainEqual({
			kind: "merge-alone",
			onto: "m0",
			member: { name: "b", sha: "b1", pushedAt: 2 },
		});
		expect(dropsOf(actions)).toEqual([
			{
				name: "b",
				sha: "b1",
				ref: "dropped/b",
				onto: "m0",
				cause: {
					kind: "refused",
					name: "b",
					reason: "rule:size-line refused it",
				},
				ticket: null,
			},
		]);
		expect(remote.main).toBe("merge(m0;a1,c1)");
		expect(remote.refs.size).toBe(0);
	});

	it("defers a member conflicting only with an earlier one: a later member still lands in its batch, and it lands in the next", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2, conflicts: ["a"] },
			c: { sha: "c1", pushedAt: 3 },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(actions).toContainEqual({ kind: "defer-member", name: "b" });
		expect(dropsOf(actions)).toEqual([]);
		expect(taken(actions)).toEqual([["a@a1", "b@b1", "c@c1"], ["b@b1"]]);
		expect(remote.main).toBe("merge(merge(m0;a1,c1);b1)");
		expect(remote.refs.size).toBe(0);
		expect(disk.filed).toEqual([]);
		expect(disk.log).toEqual([
			"take a@a1",
			"take b@b1",
			"take c@c1",
			"land a@a1",
			"land c@c1",
			"take b@b1",
			"land b@b1",
		]);
	});

	it("keeps a ref pushed again after its snapshot queued, still keeping the dropped sha under dropped/<name>", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, {
			beforeDelete: (branch, r) => {
				if (branch === "queue/a" && r.refs.get("a")?.sha === "a1")
					r.refs.set("a", { sha: "a2", pushedAt: 2, onMain: true });
			},
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1"], ["a@a2"]]);
		expect(remote.dropped).toEqual(new Map([["dropped/a", "a1"]]));
		expect(remote.main).toBe("a2");
		expect(remote.refs.size).toBe(0);
	});

	it("leaves a dropped/<name> holding an earlier drop to its own ticket, taking dropped/<name>-<sha>", async () => {
		const remote = remoteOf(
			"m0",
			{ a: { sha: "a1", pushedAt: 1, conflicts: ["main"] } },
			{ "dropped/a": "a0" },
		);
		const disk = freshDisk();

		const { actions } = await land(remote, disk);

		expect(dropsOf(actions).map((d) => d.ref)).toEqual(["dropped/a-a1"]);
		expect(remote.dropped).toEqual(
			new Map([
				["dropped/a", "a0"],
				["dropped/a-a1", "a1"],
			]),
		);
	});

	it("repeats a drop a crash cut short at its own dropped/<name>, keeping the ticket it filed", async () => {
		const remote = remoteOf(
			"m0",
			{ a: { sha: "a1", pushedAt: 1, conflicts: ["main"] } },
			{ "dropped/a": "a1" },
		);
		const disk = freshDisk();
		const members = [{ name: "a", sha: "a1", pushedAt: 1 }];
		disk.batch = {
			members,
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: null,
			phase: "merging",
		};
		disk.tickets.set(7, "open");
		disk.drops = [
			{
				name: "a",
				sha: "a1",
				ref: "dropped/a",
				onto: "m0",
				cause: { kind: "conflict", name: "a", files: ["a.txt"] },
				ticket: 7,
			},
		];

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual(["merge-members", "drop-member", "exit"]);
		expect(disk.drops.map((d) => [d.ref, d.ticket])).toEqual([
			["dropped/a", 7],
		]);
		expect(disk.filed).toEqual([]);
		expect(remote.refs.size).toBe(0);
	});

	it("reports a fix ticket that will not file and lands the rest, and the next run files it", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();

		const first = await land(remote, disk, {
			fileFault: () => new Error("file-issue: refused"),
		});

		expect(first.end).toEqual(NO_QUEUE);
		expect(first.said).toEqual([
			"fix ticket for dropped/a not filed, left for the next run: file-issue: refused",
		]);
		expect(disk.drops.map((d) => d.ticket)).toEqual([null]);
		expect(remote.main).toBe("b1");

		const second = await land(remote, disk);

		expect(kinds(second.actions)).toEqual(["file-fix-ticket", "exit"]);
		expect(disk.drops.map((d) => d.ticket)).toEqual([100]);
	});
});

describe("the reap", () => {
	const dropOf = (name: string, ticket: number): Drop => ({
		name,
		sha: `${name}1`,
		ref: `dropped/${name}`,
		onto: "m0",
		cause: { kind: "conflict", name, files: [`${name}.txt`] },
		ticket,
	});

	it("deletes a dropped ref once its fix ticket closes, and keeps one whose ticket is open or unread", async () => {
		const remote = remoteOf(
			"m0",
			{},
			{ "dropped/a": "a1", "dropped/b": "b1", "dropped/c": "c1" },
		);
		const disk = freshDisk();
		disk.tickets.set(1, "closed");
		disk.tickets.set(2, "open");
		disk.drops = [dropOf("a", 1), dropOf("b", 2), dropOf("c", 3)];

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(actions).toContainEqual({
			kind: "delete-dropped-ref",
			ref: "dropped/a",
			sha: "a1",
		});
		expect([...remote.dropped.keys()]).toEqual(["dropped/b", "dropped/c"]);
		expect(disk.drops.map((d) => d.ref)).toEqual(["dropped/b", "dropped/c"]);
	});

	it("waits for a batch in flight before it reaps", async () => {
		const remote = remoteOf(
			"m0",
			{ x: { sha: "x1", pushedAt: 1, onMain: true } },
			{ "dropped/a": "a1" },
		);
		const disk = freshDisk();
		disk.tickets.set(1, "closed");
		disk.drops = [dropOf("a", 1)];
		disk.batch = {
			members: [{ name: "x", sha: "x1", pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "x1",
			phase: "testing",
		};

		const { actions } = await land(remote, disk);

		expect(kinds(actions)).toEqual([
			"test-sha",
			"fast-forward-main",
			"delete-landed-ref",
			"delete-dropped-ref",
			"exit",
		]);
		expect(remote.dropped.size).toBe(0);
	});
});

describe("paths this machine does not take", () => {
	it("exits where another lander holds the lock, touching nothing", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});

		const { end, asked } = await land(remote, freshDisk(), { acquired: false });

		expect(end).toEqual({
			kind: "exit",
			reason: "another lander holds the lock",
		});
		expect(asked).toEqual([]);
		expect(remote.main).toBe("m0");
	});
});
