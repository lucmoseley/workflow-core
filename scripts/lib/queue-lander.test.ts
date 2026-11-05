// @vitest-environment node
/*
 * lib/queue-lander.js's green path (#4485, spec #4458), driven through
 * runQueueLander with an in-memory remote, tester, ledgers and batch record:
 * each case asserts the actions the machine chose and where the remote ends.
 *
 * Loosen it and a batch lands untested or out of push order, a push made
 * while a batch is tested lands half-tested or is deleted unlanded, a
 * restart tests a sha again, or a network blip throws a batch away.
 */
import { describe, expect, it } from "vitest";
import type { Verdict } from "./lander.js";
import {
	type Batch,
	type Member,
	type MergeResult,
	type QueueAction,
	type QueueLanderDeps,
	runQueueLander,
} from "./queue-lander.js";

interface Ref {
	sha: string;
	pushedAt: number;
	onMain?: boolean;
}

/** The remote: `main` and the queue refs by name. */
interface Remote {
	main: string;
	refs: Map<string, Ref>;
}

const remoteOf = (main: string, refs: Record<string, Ref> = {}): Remote => ({
	main,
	refs: new Map(Object.entries(refs)),
});

/** The disk a restart keeps: the ledgers and the batch record. */
const freshDisk = () => ({
	green: new Set<string>(),
	verdicts: new Map<string, Verdict>(),
	batch: null as Batch | null,
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
	beforeDelete?: (name: string, remote: Remote) => void;
	acquired?: boolean;
}

/** A run against `remote` and `disk`, returning its end and every action. */
async function land(remote: Remote, disk: Disk, o: Options = {}) {
	const actions: QueueAction[] = [];
	const asked: string[] = [];
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
						onMain: r.onMain ?? false,
					})),
				};
			},
			mergeMembers: (onto, members) => {
				call("mergeMembers");
				return (
					o.merge?.(onto, members) ?? {
						kind: "merged",
						sha: mergeSha(onto, members),
					}
				);
			},
			pushBatch: () => call("pushBatch"),
			pushMain: (sha) => {
				call("pushMain");
				remote.main = sha;
			},
			deleteRef: (name, sha) => {
				call("deleteRef");
				o.beforeDelete?.(name, remote);
				if (remote.refs.get(name)?.sha !== sha) return false;
				remote.refs.delete(name);
				return true;
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
		lock: { acquire: () => o.acquired ?? true, release: () => undefined },
		beat: () => undefined,
		wait: async () => undefined,
		log: (a) => actions.push(a),
	};
	const end = await runQueueLander(deps);
	return { end, actions, asked };
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
	it("lands a lone ref that descends from main as pushed, with no merge, and deletes it", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual([
			"take-batch",
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
			beforeDelete: (name, r) => {
				if (moved) return;
				moved = true;
				r.refs.set(name, { sha: "a2", pushedAt: 2 });
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
				c === "refs" && ++listings === 3 ? new Error("killed") : undefined,
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

describe("paths this machine does not take", () => {
	it("exits naming a member that does not merge, landing nothing", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});

		const { end } = await land(remote, freshDisk(), {
			merge: () => ({ kind: "conflict", name: "b", files: ["x.txt"] }),
		});

		expect(end).toEqual({
			kind: "exit",
			reason:
				"queue/b did not merge into the batch (conflict in x.txt): dropping or deferring a member is unbuilt (#4485)",
		});
		expect(remote.main).toBe("m0");
		expect(remote.refs.size).toBe(2);
	});

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
