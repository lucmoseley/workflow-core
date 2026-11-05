// @vitest-environment node
/*
 * lib/queue-lander.js's green path, drop and defer, and red path (#4485,
 * spec #4458), driven through runQueueLander with an in-memory remote,
 * tester, tracker, ledgers and records: each case asserts the actions the
 * machine chose and where the remote ends.
 *
 * Loosen it and a batch lands untested or out of push order, a push made
 * while a batch is tested lands half-tested or is deleted unlanded, a
 * restart tests a sha again, a network blip throws a batch away, a member
 * that conflicts with another is dropped or one that conflicts with `main`
 * stops the queue, a dropped sha is lost or its fix ticket goes unfiled, a
 * crash mid-drop lands the member or a crash after the push loses its land
 * rows, or a dropped ref outlives its closed ticket; or a flake or a failure
 * `main` shares starts an isolation or drops a member, a member red alone
 * once is dropped unconfirmed, the passers wait behind a newer ref, a
 * collision drops more or less than one member, or a restart repeats an
 * isolation run or merge.
 */
import { createRequire } from "node:module";
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

// Required, not imported: runQueueLander tests for filing-refused.js's own
// FilingRefusedError, which an ESM import of it would load a second copy of.
const { FilingRefusedError } = createRequire(__filename)("./filing-refused.js");

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
	/** The `lander/iso-<k>` refs pushed, by branch. */
	iso: Map<string, string>;
}

const remoteOf = (
	main: string,
	refs: Record<string, Ref> = {},
	dropped: Record<string, string> = {},
): Remote => ({
	main,
	refs: new Map(Object.entries(refs)),
	dropped: new Map(Object.entries(dropped)),
	iso: new Map(),
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
	/** Each base-red filing, as `<main> <files>`. */
	baseRed: [] as string[],
});
type Disk = ReturnType<typeof freshDisk>;

const mergeSha = (onto: string, members: readonly Member[]) =>
	`merge(${onto};${members.map((m) => m.sha).join(",")})`;

interface Options {
	/**
	 * The tester's answer at a sha on `files`, the whole suite where empty,
	 * `nth` counting its asks there from 1; green naming run 1 where absent.
	 */
	verdict?: (
		sha: string,
		remote: Remote,
		files: readonly string[],
		nth: number,
	) => Verdict;
	requiresRun?: boolean;
	/** Whether the tester runs isolation members at once. */
	parallel?: boolean;
	/** The merge's outcome; every member merged where absent. */
	merge?: (onto: string, members: readonly Member[]) => MergeResult;
	/** Throws in place of a call, by its name, while it returns an error. */
	fault?: (call: string) => Error | undefined;
	/** Runs before a compare-and-delete reads the ref. */
	beforeDelete?: (branch: string, remote: Remote) => void;
	/** Throws in place of filing a fix ticket while it returns an error. */
	fileFault?: () => Error | undefined;
	acquired?: boolean;
	/** The run's clock, in ms; NOW where absent. */
	now?: number;
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
	/** Each ask: the sha for the whole suite, else `<sha>:<files>`. */
	const asked: string[] = [];
	let inFlight = 0;
	let peak = 0;
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
			pushIso: (k, sha) => {
				call("pushIso");
				remote.iso.set(`lander/iso-${k}`, sha);
			},
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
			...(o.parallel === undefined ? {} : { parallel: o.parallel }),
			verdict: async (sha, files = []) => {
				const ask = files.length > 0 ? `${sha}:${files.join(",")}` : sha;
				asked.push(ask);
				const nth = asked.filter((a) => a === ask).length;
				peak = Math.max(peak, ++inFlight);
				await Promise.resolve();
				inFlight--;
				return (
					o.verdict?.(sha, remote, files, nth) ?? { kind: "green", run: 1 }
				);
			},
		},
		ledger: {
			has: (sha) => disk.green.has(sha),
			add: (sha) => {
				disk.green.add(sha);
			},
		},
		verdicts: {
			get: (sha, files, pass = 1) =>
				disk.verdicts.get(verdictKey(sha, files, pass)) ?? null,
			add: (sha, files, v, pass = 1) => {
				disk.verdicts.set(verdictKey(sha, files, pass), v);
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
			fileBaseRed: (sha, files) => {
				disk.baseRed.push(`${sha} ${files.join(",")}`);
				return "base-red issue: filed #90";
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
		now: () => o.now ?? NOW,
	};
	const end = await runQueueLander(deps);
	return { end, actions, asked, said, peak };
}

const verdictKey = (sha: string, files: readonly string[], pass: number) =>
	`${sha} ${files.join(",")}${pass > 1 ? ` #${pass}` : ""}`;

/** A batch record's red-path fields at rest. */
const UNRED = { ahead: [], blame: null, isolated: [], serial: null };

const kinds = (actions: QueueAction[]) => actions.map((a) => a.kind);
const taken = (actions: QueueAction[]) =>
	actions.flatMap((a) =>
		a.kind === "take-batch"
			? [a.batch.members.map((m) => `${m.name}@${m.sha}`)]
			: [],
	);
const NO_QUEUE = { kind: "exit", reason: "no queue ref waits" };
const NOW = Date.parse("2026-11-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

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
			...UNRED,
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

	it("goes on from a red reached before a restart without testing the whole suite again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		const red = await land(remote, disk, {
			verdict: (_, __, files) =>
				files.length === 0
					? { kind: "red", files: ["scripts/x.test.ts"] }
					: { kind: "unknown", reason: "no run" },
		});

		const second = await land(remote, disk);

		expect(red.end).toEqual({
			kind: "exit",
			reason: "no verdict at a1: no run",
		});
		expect(remote.main).toBe("a1");
		expect(second.asked).toEqual(["a1:scripts/x.test.ts"]);
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
			at: NOW,
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
				at: NOW,
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
			...UNRED,
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
				at: NOW,
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

	it("stops the run on a fix ticket the tracker refuses for good, naming the refusal", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();
		const refusal = "fix ticket for a commit on queue/a not filed: rule:x";

		const { end, said } = await land(remote, disk, {
			fileFault: () => new FilingRefusedError(refusal),
		});

		expect(end).toEqual({
			kind: "exit",
			reason: `stopped on an error: ${refusal}`,
		});
		expect(said).toEqual([]);
		expect(disk.drops.map((d) => d.ticket)).toEqual([null]);
		expect(remote.main).toBe("m0");
	});

	it("finishes a drop a crash cut short after its records, so the member never lands once it would merge", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();

		const first = await land(remote, disk, {
			fault: (call) => (call === "createRef" ? new Error("killed") : undefined),
		});
		remote.refs.set("a", { sha: "a1", pushedAt: 1 });
		const second = await land(remote, disk);

		expect(first.end).toEqual({
			kind: "exit",
			reason: "stopped on an error: killed",
		});
		expect(kinds(second.actions).slice(0, 3)).toEqual([
			"drop-member",
			"file-fix-ticket",
			"merge-members",
		]);
		expect(second.end).toEqual(NO_QUEUE);
		expect(remote.dropped).toEqual(new Map([["dropped/a", "a1"]]));
		expect(remote.main).toBe("b1");
		expect(remote.refs.size).toBe(0);
		expect(disk.filed.map((d) => d.ref)).toEqual(["dropped/a"]);
		expect(disk.log).toEqual([
			"take a@a1",
			"take b@b1",
			"drop a@a1",
			"land b@b1",
		]);
	});

	it("takes a member again whose drop a crash cut short before its drop record, and drops it then", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, conflicts: ["main"] },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();
		disk.batch = {
			...UNRED,
			members: [
				{ name: "a", sha: "a1", pushedAt: 1 },
				{ name: "b", sha: "b1", pushedAt: 2 },
			],
			deferred: [],
			dropped: ["a"],
			onto: "m0",
			integration: null,
			phase: "merging",
		};

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1"]]);
		expect(remote.main).toBe("b1");
		expect(remote.dropped).toEqual(new Map([["dropped/a", "a1"]]));
		expect(disk.filed.map((d) => d.ref)).toEqual(["dropped/a"]);
	});
});

describe("a crash after main moved", () => {
	it("logs the land rows of a batch main holds once on restart, then deletes its refs", async () => {
		const remote = remoteOf("x1", {
			x: { sha: "x1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		disk.green.add("x1");
		disk.log = ["take x@x1"];
		disk.batch = {
			...UNRED,
			members: [{ name: "x", sha: "x1", pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "x1",
			phase: "testing",
		};

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual([
			"record-landed",
			"delete-landed-ref",
			"exit",
		]);
		expect(disk.log).toEqual(["take x@x1", "land x@x1"]);
		expect(disk.batch?.phase).toBe("landed");
	});
});

describe("the reap", () => {
	const dropOf = (name: string, ticket: number): Drop => ({
		name,
		sha: `${name}1`,
		ref: `dropped/${name}`,
		onto: "m0",
		cause: { kind: "conflict", name, files: [`${name}.txt`] },
		at: NOW,
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

		const { end, actions, said } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(actions).toContainEqual({
			kind: "delete-dropped-ref",
			ref: "dropped/a",
			sha: "a1",
		});
		expect(said).toEqual([
			"#3's state not read, dropped/c kept for a later run: no issue #3",
		]);
		expect([...remote.dropped.keys()]).toEqual(["dropped/b", "dropped/c"]);
		expect(disk.drops.map((d) => [d.ref, d.reapedAt])).toEqual([
			["dropped/a", NOW],
			["dropped/b", undefined],
			["dropped/c", undefined],
		]);
	});

	it("keeps a reaped drop's entry, neither reading its ticket nor dropping it again, until the queue log's retention passes", async () => {
		const remote = remoteOf("m0", {}, {});
		const disk = freshDisk();
		disk.drops = [
			{ ...dropOf("a", 1), reapedAt: NOW - 13 * DAY },
			{ ...dropOf("b", 2), reapedAt: NOW - 15 * DAY },
		];

		const { end, actions, said } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual(["exit"]);
		expect(said).toEqual([]);
		expect(remote.dropped.size).toBe(0);
		expect(disk.drops.map((d) => [d.ref, d.reapedAt])).toEqual([
			["dropped/a", NOW - 13 * DAY],
		]);
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
			...UNRED,
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

describe("the red path", () => {
	const RedB = "scripts/b.test.ts";
	const red = (...files: string[]): Verdict => ({ kind: "red", files });
	const Green: Verdict = { kind: "green", run: 1 };
	/** Red on each `<name>.test.ts` whose `<name>1` the sha holds. */
	const redWhereHeld =
		(...names: string[]) =>
		(sha: string, _: Remote, files: readonly string[]): Verdict => {
			const failing = names
				.filter((n) => sha.includes(`${n}1`))
				.map((n) => `scripts/${n}.test.ts`)
				.filter((f) => files.length === 0 || files.includes(f));
			return failing.length > 0 ? red(...failing) : Green;
		};
	const abc = () =>
		remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
			c: { sha: "c1", pushedAt: 3 },
		});
	const Abc = "merge(m0;a1,b1,c1)";

	it("lands a batch whose failing files pass on their rerun, isolating nothing", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});

		const { end, asked } = await land(remote, freshDisk(), {
			verdict: (_, __, files) =>
				files.length === 0 ? red("scripts/x.test.ts") : Green,
		});

		const integration = "merge(m0;a1,b1)";
		expect(end).toEqual(NO_QUEUE);
		expect(asked).toEqual([integration, `${integration}:scripts/x.test.ts`]);
		expect(remote.main).toBe(integration);
		expect(remote.iso.size).toBe(0);
	});

	it("lands a batch red only where main is red too, filing one base-red ticket for those files", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end, asked, said } = await land(remote, disk, {
			verdict: () => red("scripts/x.test.ts"),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked).toContain("m0:scripts/x.test.ts");
		expect(disk.baseRed).toEqual(["m0 scripts/x.test.ts"]);
		expect(said).toContain("base-red issue: filed #90");
		expect(remote.main).toBe("merge(m0;a1,b1)");
		expect(remote.iso.size).toBe(0);
		expect(disk.drops).toEqual([]);
	});

	it("drops the one culprit red alone twice, and lands the passers as the next batch ahead of a newer ref", async () => {
		const remote = abc();
		const disk = freshDisk();
		const isos = ["merge(m0;a1)", "merge(m0;b1)", "merge(m0;c1)"];
		const base = redWhereHeld("b");

		const { end, actions, asked } = await land(remote, disk, {
			verdict: (sha, r, files) => {
				if (isos.includes(sha)) {
					if (![...r.iso.values()].includes(sha))
						throw new Error(
							`${sha} asked before its lander/iso ref was pushed`,
						);
					r.refs.set("d", { sha: "d1", pushedAt: 9 });
				}
				const v = base(sha, r, files);
				/* main shares x's failure, which is never blamed. */
				if (sha !== Abc && sha !== "m0") return v;
				return red("scripts/x.test.ts", ...(v.kind === "red" ? v.files : []));
			},
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([
			["a@a1", "b@b1", "c@c1"],
			["a@a1", "c@c1"],
			["d@d1"],
		]);
		const drop = {
			name: "b",
			sha: "b1",
			ref: "dropped/b",
			onto: "m0",
			cause: {
				kind: "red",
				name: "b",
				files: [RedB],
				iso: "merge(m0;b1)",
			},
			ticket: null,
			at: NOW,
		};
		expect(dropsOf(actions)).toEqual([drop]);
		expect(disk.filed).toEqual([drop]);
		expect(asked).toContain(`merge(m0;a1):${RedB}`);
		expect(asked.filter((a) => a === `merge(m0;b1):${RedB}`)).toHaveLength(2);
		expect(asked).not.toContain("merge(m0;a1):scripts/x.test.ts");
		expect(disk.baseRed[0]).toBe("m0 scripts/x.test.ts");
		expect(remote.main).toBe("merge(merge(m0;a1,c1);d1)");
		expect(remote.dropped).toEqual(new Map([["dropped/b", "b1"]]));
		expect(remote.refs.size).toBe(0);
		expect(disk.log).toContain("drop b@b1");
	});

	it("drops two culprits in one isolation and lands the one passer", async () => {
		const remote = abc();
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, {
			verdict: redWhereHeld("b", "c"),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["b", "c"]);
		expect(disk.filed).toHaveLength(2);
		expect(taken(actions)).toEqual([["a@a1", "b@b1", "c@c1"], ["a@a1"]]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("keeps a member red alone once that passes its confirm, landing it with the other passer", async () => {
		const remote = abc();
		const disk = freshDisk();
		const culprit = redWhereHeld("c");

		const { end, actions } = await land(remote, disk, {
			verdict: (sha, r, files, nth) =>
				sha === "merge(m0;b1)" && nth === 1
					? red("scripts/c.test.ts")
					: culprit(sha, r, files),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["c"]);
		expect(taken(actions)).toEqual([
			["a@a1", "b@b1", "c@c1"],
			["a@a1", "b@b1"],
		]);
		expect(remote.main).toBe("merge(m0;a1,b1)");
	});

	it("settles a collision by landing members one at a time in push order, dropping only the one that brings the failure back", async () => {
		const remote = abc();
		const disk = freshDisk();
		const collides = (sha: string) => sha.includes("a1") && sha.includes("b1");

		const { end, actions } = await land(remote, disk, {
			verdict: (sha) => (collides(sha) ? red("scripts/y.test.ts") : Green),
		});

		expect(end).toEqual(NO_QUEUE);
		const step = "merge(merge(m0;a1);b1)";
		expect(dropsOf(actions)).toEqual([
			{
				name: "b",
				sha: "b1",
				ref: "dropped/b",
				onto: "merge(m0;a1)",
				cause: {
					kind: "collision",
					name: "b",
					files: ["scripts/y.test.ts"],
					step,
					after: ["a"],
				},
				ticket: null,
				at: NOW,
			},
		]);
		expect(taken(actions)).toEqual([["a@a1", "b@b1", "c@c1"], ["c@c1"]]);
		expect(remote.main).toBe("merge(merge(m0;a1);c1)");
		expect(disk.green.has("merge(m0;a1)")).toBe(true);
		expect(disk.green.has(step)).toBe(false);
		expect(remote.refs.size).toBe(0);
		expect(disk.log.filter((l) => !l.startsWith("take"))).toEqual([
			"land a@a1",
			"drop b@b1",
			"land c@c1",
		]);
	});

	it("records a serial step main already holds after a crash, landing it once and going on to the next", async () => {
		const remote = remoteOf("merge(m0;a1)", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		disk.green.add("merge(m0;a1)");
		disk.log = ["take a@a1", "take b@b1"];
		disk.batch = {
			members: [
				{ name: "a", sha: "a1", pushedAt: 1 },
				{ name: "b", sha: "b1", pushedAt: 2 },
			],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "merge(m0;a1,b1)",
			phase: "serial",
			ahead: [],
			blame: { files: ["scripts/y.test.ts"], base: [], members: ["a", "b"] },
			isolated: [],
			serial: {
				landed: [],
				step: { name: "a", sha: "merge(m0;a1)", onto: "m0" },
			},
		};

		const { end, actions, asked } = await land(remote, disk, {
			verdict: (sha) =>
				sha.includes("a1") && sha.includes("b1")
					? red("scripts/y.test.ts")
					: Green,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(actions[0]).toEqual({
			kind: "record-step",
			sha: "merge(m0;a1)",
			name: "a",
		});
		expect(asked).toEqual(["merge(merge(m0;a1);b1)"]);
		expect(disk.log).toEqual([
			"take a@a1",
			"take b@b1",
			"land a@a1",
			"drop b@b1",
		]);
		expect(remote.main).toBe("merge(m0;a1)");
		expect(remote.refs.size).toBe(0);
	});

	it("settles a red naming no file by serial landing, never rerunning named files", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end, actions, asked } = await land(remote, disk, {
			verdict: (sha) =>
				sha.includes("a1") && sha.includes("b1") ? red() : Green,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked.filter((a) => a.includes(":"))).toEqual([]);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["b"]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("resumes an isolation after a restart without merging or testing again what it ledgered", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		let pushes = 0;

		const first = await land(remote, disk, {
			verdict: redWhereHeld("b"),
			fault: (c) =>
				c === "pushIso" && ++pushes === 3 ? new Error("killed") : undefined,
		});
		const second = await land(remote, disk, { verdict: redWhereHeld("b") });

		expect(first.end).toEqual({
			kind: "exit",
			reason: "stopped on an error: killed",
		});
		expect(disk.batch?.phase).not.toBe("merging");
		expect(kinds(second.actions)).not.toContain("merge-iso");
		expect(second.asked).toEqual([`merge(m0;b1):${RedB}`, "merge(m0;a1)"]);
		expect(dropsOf(second.actions).map((d) => d.name)).toEqual(["b"]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("never lands nor drops on an isolation member's unknown verdict, and asks only it again next run", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const culprit = redWhereHeld("b");

		const first = await land(remote, disk, {
			verdict: (sha, r, files) =>
				sha === "merge(m0;a1)"
					? { kind: "unknown", reason: "no run" }
					: culprit(sha, r, files),
		});

		expect(first.end).toEqual({
			kind: "exit",
			reason: "no verdict at merge(m0;: no run",
		});
		expect(remote.main).toBe("m0");
		expect(disk.drops).toEqual([]);
		expect(remote.refs.size).toBe(2);
		const second = await land(remote, disk, { verdict: culprit });
		expect(second.asked).toEqual([
			`merge(m0;a1):${RedB}`,
			`merge(m0;b1):${RedB}`,
			"merge(m0;a1)",
		]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("retries an isolation member's transient no verdict with the batch kept", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const culprit = redWhereHeld("b");

		const { end, actions, asked } = await land(remote, disk, {
			verdict: (sha, r, files, nth) =>
				sha === "merge(m0;b1)" && nth === 1
					? { kind: "unknown", reason: "slot shut", transient: true }
					: culprit(sha, r, files),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions).filter((k) => k === "take-batch")).toHaveLength(2);
		expect(asked.filter((a) => a === `merge(m0;a1):${RedB}`)).toHaveLength(1);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["b"]);
	});

	it("tests isolation members at once on a parallel tester and one at a time on any other", async () => {
		const run = (parallel?: boolean) =>
			land(abc(), freshDisk(), {
				verdict: redWhereHeld("b"),
				...(parallel === undefined ? {} : { parallel }),
			});

		expect((await run(true)).peak).toBe(3);
		expect((await run()).peak).toBe(1);
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
