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
 * rows, a dropped ref outlives its closed ticket, or a run whose landing
 * changed its own code takes another batch on it; or a flake or a failure
 * `main` shares starts an isolation or drops a member, one on another
 * signature than `main`'s is read as `main`'s, a member red alone once is
 * dropped unconfirmed, the passers wait behind a newer ref, a
 * collision drops more or less than one member, or a restart repeats an
 * isolation run or merge; or a red only `main` shares lands where `main`
 * takes only a sha a CI run passed, a sha `main` refused is pushed again by
 * any batch or stays green-ledgered, a base check takes `main`'s old verdict
 * or an earlier batch's base verdict, a red
 * naming no file skips its rerun, base check or isolation, or a serial step
 * drops its member on one red or on a red the collision did not fail.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	type Batch,
	type Drop,
	type LanderEvent,
	type Member,
	type MergeResult,
	type Pipeline,
	type QueueAction,
	type QueueLanderDeps,
	redPathAtRest,
	runQueueLander,
	type Verdict,
} from "./queue-lander.js";

// Required, not imported: runQueueLander tests for filing-refused.js's own
// FilingRefusedError and network-fault.js's own PushRefused, which an ESM
// import would load a second copy of.
const { FilingRefusedError } = createRequire(__filename)("./filing-refused.js");
const { PushRefused } = createRequire(__filename)("./network-fault.js");

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
	/** When each green sha went green, in ms. */
	greenAt: new Map<string, number>(),
	verdicts: new Map<string, Verdict>(),
	/** When each verdict was ledgered, in ms; NOW where absent. */
	verdictAt: new Map<string, number>(),
	/** The refused record: each sha `main` refused, with its refusal. */
	refused: new Map<string, string>(),
	pipeline: null as Pipeline | null,
	drops: [] as Drop[],
	log: [] as string[],
	/** Each ticket's state; the filed ones open. */
	tickets: new Map<number, "open" | "closed">(),
	filed: [] as Drop[],
	/** Each fix ticket by the `<name>@<sha>` its title names. */
	titled: new Map<string, number>(),
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
	/** Whether the tester takes several asks at once. */
	parallel?: boolean;
	/** Runs as an ask is made, before its verdict is awaited. */
	onAsk?: (sha: string, remote: Remote) => void;
	/** Holds an ask's verdict until it reads true; the events so far, each
	 * `ask <key>`, `verdict <key>`, `cancel <sha>`, `push <sha>` or
	 * `main <sha>`. */
	gate?: (key: string, events: readonly string[]) => boolean;
	/** The merge's outcome; every member merged where absent. */
	merge?: (
		onto: string,
		members: readonly Member[],
		fresh?: boolean,
		started?: (sha: string) => void,
	) => MergeResult;
	/** Throws in place of a call, by its name, while it returns an error. */
	fault?: (call: string) => Error | undefined;
	/** Runs before a compare-and-delete reads the ref. */
	beforeDelete?: (branch: string, remote: Remote) => void;
	/** The remote's refusal of a push of `sha` to `main`, none where absent. */
	refuse?: (sha: string) => string | undefined;
	/** Throws in place of filing a fix ticket while it returns an error. */
	fileFault?: () => Error | undefined;
	/** Throws in place of the fix ticket search, while it returns an error. */
	findFault?: () => Error | undefined;
	/** The shas `main` holds, beyond `main` itself. */
	onMain?: readonly string[];
	acquired?: boolean;
	/** The run's clock, in ms; NOW where absent. */
	now?: number;
	/** Whether a move of `main` to `sha` changed this run's own code; absent,
	 * the run is handed no `mainMoved` at all. */
	mainMoved?: (sha: string) => boolean;
}

/**
 * The fake merge: each member in order onto `onto`, stopping at the first
 * refused or conflicting with `main` or an earlier member; a lone member on
 * `main` is itself unless `fresh`.
 */
function fakeMerge(
	remote: Remote,
	onto: string,
	members: readonly Member[],
	fresh = false,
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
		!fresh &&
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
	/** Each push to `main` tried, refused or not. */
	const pushed: string[] = [];
	const events: string[] = [];
	/** The window each pipeline record write carries. */
	const depths: number[] = [];
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
			mergeMembers: (onto, members, fresh, started) => {
				call("mergeMembers");
				return (
					o.merge?.(onto, members, fresh, started) ??
					fakeMerge(remote, onto, members, fresh)
				);
			},
			pushBatch: (slot, sha) => {
				call("pushBatch");
				events.push(`push ${sha} on lander/batch-${slot}`);
			},
			pushIso: (branch, sha) => {
				call("pushIso");
				remote.iso.set(branch, sha);
			},
			pushMain: (sha) => {
				call("pushMain");
				pushed.push(sha);
				events.push(`main ${sha}`);
				const refused = o.refuse?.(sha);
				if (refused) return refused;
				remote.main = sha;
				return null;
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
			isAncestor: (sha, of) => sha === of || (o.onMain ?? []).includes(sha),
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
				events.push(`ask ${ask}`);
				o.onAsk?.(sha, remote);
				const nth = asked.filter((a) => a === ask).length;
				peak = Math.max(peak, ++inFlight);
				await Promise.resolve();
				for (let spins = 0; o.gate && !o.gate(ask, events); spins++) {
					/* A guess: a gate opens within a few dozen turns of the loop. */
					if (spins > 2000) throw new Error(`gate on ${ask} never opened`);
					await new Promise((r) => setTimeout(r, 0));
				}
				inFlight--;
				events.push(`verdict ${ask}`);
				return (
					o.verdict?.(sha, remote, files, nth) ?? { kind: "green", run: 1 }
				);
			},
			cancel: (sha, branch) => {
				events.push(`cancel ${sha} on ${branch}`);
			},
		},
		ledger: {
			has: (sha) => disk.green.has(sha),
			greenAt: (sha) => disk.greenAt.get(sha) ?? null,
			add: (sha) => {
				disk.green.add(sha);
			},
			remove: (sha) => {
				disk.green.delete(sha);
			},
		},
		verdicts: {
			get: (sha, files, pass = 1) => {
				const key = verdictKey(sha, files, pass);
				const verdict = disk.verdicts.get(key);
				return verdict ? { verdict, at: disk.verdictAt.get(key) ?? NOW } : null;
			},
			add: (sha, files, v, pass = 1) => {
				const key = verdictKey(sha, files, pass);
				disk.verdicts.set(key, v);
				disk.verdictAt.set(key, o.now ?? NOW);
			},
		},
		refused: {
			refusalOf: (sha) => disk.refused.get(sha) ?? null,
			add: (sha, reason) => {
				disk.refused.set(sha, reason);
			},
		},
		record: {
			read: () => disk.pipeline,
			write: (p) => {
				disk.pipeline = p;
				if (depths.at(-1) !== p.depth) depths.push(p.depth);
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
				disk.titled.set(`${d.name}@${d.sha}`, n);
				return `Filed #${n}: https://x/${n}`;
			},
			findDropTicket: (name, sha) => {
				const err = o.findFault?.();
				if (err) throw err;
				return disk.titled.get(`${name}@${sha}`) ?? null;
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
		/* A machine that loops on microtasks starves vitest's timeout, so a
		 * runaway fails its case here rather than hanging the file. */
		log: (a) => {
			if (actions.push(a) > MAX_ACTIONS)
				throw new Error(`runaway: ${kinds(actions.slice(-6)).join(", ")}`);
		},
		say: (line) => said.push(line),
		now: () => o.now ?? NOW,
		...(o.mainMoved && { mainMoved: o.mainMoved }),
	};
	const end = await runQueueLander(deps);
	return { end, actions, asked, said, peak, pushed, events, depths };
}

const seed = (disk: Disk, b: Omit<Batch, "slot">) => {
	const batch = { slot: 0, ...b };
	disk.pipeline = ["merging", "testing", "landed"].includes(b.phase)
		? { line: [batch], search: null, depth: 2 }
		: { line: [], search: batch, depth: 1 };
};

const batchIn = (disk: Disk) =>
	disk.pipeline?.search ?? disk.pipeline?.line[0] ?? null;

const verdictKey = (sha: string, files: readonly string[], pass: number) =>
	`${sha} ${files.join(",")}${pass === 1 ? "" : ` #${pass}`}`;

const kinds = (actions: QueueAction[]) => actions.map((a) => a.kind);
/* A guess, several times the longest case's ~60 actions. */
const MAX_ACTIONS = 400;
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
		seed(disk, {
			...redPathAtRest(),
			members,
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: mergeSha("m0", members),
			phase: "testing",
		});

		const { actions } = await land(remote, disk);

		expect(actions[0]).toEqual({
			kind: "merge-members",
			onto: "m1",
			members,
			fresh: false,
		});
		expect(remote.main).toBe(mergeSha("m1", members));
	});
});

describe("a batch's run started before its gate pass (#4573)", () => {
	const members = [
		{ name: "a", sha: "a1", pushedAt: 1 },
		{ name: "b", sha: "b1", pushedAt: 2 },
	];
	const merges = mergeSha("m0", members);
	const remote = () =>
		remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});

	it("tests the merges the run started on where the gates pass them as merged, cancelling nothing", async () => {
		const { events, asked } = await land(remote(), freshDisk(), {
			merge: (onto, ms, _fresh, started) => {
				started?.(mergeSha(onto, ms));
				return { kind: "merged", sha: mergeSha(onto, ms) };
			},
		});

		expect(events.indexOf(`push ${merges} on lander/batch-0`)).toBeLessThan(
			events.indexOf(`ask ${merges}`),
		);
		expect(events.some((e) => e.startsWith("cancel"))).toBe(false);
		expect(asked).toEqual([merges]);
	});

	it("cancels the run where the gates commit edits, and tests the edited sha", async () => {
		const edited = `${merges}+fixes`;
		const remoteNow = remote();
		const { events, asked } = await land(remoteNow, freshDisk(), {
			merge: (onto, ms, _fresh, started) => {
				started?.(mergeSha(onto, ms));
				return { kind: "merged", sha: `${mergeSha(onto, ms)}+fixes` };
			},
		});

		expect(events).toContain(`cancel ${merges} on lander/batch-0`);
		expect(events).toContain(`push ${edited} on lander/batch-0`);
		expect(asked).toEqual([edited]);
		expect(remoteNow.main).toBe(edited);
	});

	it("leaves the push to test-sha where the early one fails, cancelling nothing", async () => {
		let pushes = 0;
		const { events, asked, said } = await land(remote(), freshDisk(), {
			merge: (onto, ms, _fresh, started) => {
				started?.(mergeSha(onto, ms));
				return { kind: "merged", sha: mergeSha(onto, ms) };
			},
			fault: (name) =>
				name === "pushBatch" && pushes++ === 0
					? new Error("network down")
					: undefined,
		});

		expect(
			said.some((l) => l.includes("not pushed before its gate pass")),
		).toBe(true);
		expect(events.some((e) => e.startsWith("cancel"))).toBe(false);
		expect(events).toContain(`push ${merges} on lander/batch-0`);
		expect(asked).toEqual([merges]);
	});

	it("cancels the run where the gates refuse, and still drops the member they refuse", async () => {
		const remoteNow = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2, refused: "rule:size-line refused it" },
		});
		const disk = freshDisk();
		const { events } = await land(remoteNow, disk, {
			merge: (onto, ms, fresh, started) => {
				if (ms.length > 1) started?.(mergeSha(onto, ms));
				return fakeMerge(remoteNow, onto, ms, fresh);
			},
		});

		expect(events).toContain(`cancel ${merges} on lander/batch-0`);
		expect(disk.drops.map((d) => d.name)).toEqual(["b"]);
		expect(remoteNow.main).toBe(mergeSha("m0", [members[0] as Member]));
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

describe("a landing that changes the lander's own code (#4521)", () => {
	it("settles its batch, then ends for a fresh run before taking the ref pushed meanwhile", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const moved: string[] = [];

		const { end, actions } = await land(remote, freshDisk(), {
			verdict: (_, r) => {
				r.refs.set("b", { sha: "b1", pushedAt: 2 });
				return { kind: "green", run: 1 };
			},
			mainMoved: (sha) => {
				moved.push(sha);
				return true;
			},
		});

		expect(end).toEqual({
			kind: "exit",
			reason:
				"main changed this lander's own code; a fresh run takes the queue",
			relaunch: "merge(m0;a1)",
		});
		expect(moved).toEqual(["merge(m0;a1)"]);
		expect(taken(actions)).toEqual([["a@a1"]]);
		expect(kinds(actions)).toContain("delete-landed-ref");
		expect(remote.refs.has("b")).toBe(true);
	});

	it("takes the next batch where the move changed none of its code", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		let pushed = false;

		const { end, actions } = await land(remote, freshDisk(), {
			verdict: (_, r) => {
				if (!pushed) r.refs.set("b", { sha: "b1", pushedAt: 2 });
				pushed = true;
				return { kind: "green", run: 1 };
			},
			mainMoved: () => false,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1"], ["b@b1"]]);
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
				c === "refs" && ++listings === 5 ? new Error("killed") : undefined,
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
		expect(batchIn(disk)?.phase).toBe("merging");
	});

	it("retries a push GitHub refused on its own internal fault, landing on the try that follows (#4497)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		let pushes = 0;

		const { end } = await land(remote, freshDisk(), {
			fault: (c) =>
				c === "pushMain" && ++pushes === 1
					? Object.assign(new Error("push"), {
							stderr:
								" ! [remote rejected] a1 -> main (fatal error in commit_refs_rules)",
						})
					: undefined,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(remote.main).toBe("a1");
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

	it("exits at once on a PushRefused whose stderr quotes a network fault, never retrying it (#4513)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		let pushes = 0;

		const { end } = await land(remote, freshDisk(), {
			fault: (c) =>
				c === "pushBatch" && ++pushes === 1
					? new PushRefused("push", {
							cause: Object.assign(new Error("push"), {
								status: 1,
								stderr:
									"test said: Connection reset\nerror: failed to push some refs",
							}),
						})
					: undefined,
		});

		expect(end).toEqual({
			kind: "exit",
			reason: "stopped on an error: error: failed to push some refs",
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
		seed(disk, {
			...redPathAtRest(),
			members,
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: null,
			phase: "merging",
		});
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

	it("finishes a drop a crash cut short after its drop record but before the batch record, never testing the member again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const a = { name: "a", sha: "a1", pushedAt: 1 };
		seed(disk, {
			...redPathAtRest(),
			members: [a, { name: "b", sha: "b1", pushedAt: 2 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "merge(m0;a1,b1)",
			phase: "isolating",
			blame: { files: ["scripts/a.test.ts"], base: [], members: ["a", "b"] },
			isolated: [
				{ name: "a", sha: "a1", iso: "merge(m0;a1)" },
				{ name: "b", sha: "b1", iso: "merge(m0;b1)" },
			],
		});
		disk.drops = [
			{
				name: "a",
				sha: "a1",
				ref: "dropped/a",
				onto: "m0",
				cause: {
					kind: "red",
					name: "a",
					files: ["scripts/a.test.ts"],
					iso: "merge(m0;a1)",
				},
				ticket: null,
				at: NOW,
			},
		];
		disk.verdicts.set(verdictKey("merge(m0;b1)", ["scripts/a.test.ts"], 1), {
			kind: "green",
			run: 1,
		});

		const { end, actions, asked } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions).slice(0, 2)).toEqual([
			"drop-member",
			"file-fix-ticket",
		]);
		expect(asked.filter((x) => x.includes("a1") && !x.includes("b1"))).toEqual(
			[],
		);
		expect(taken(actions)).toEqual([["b@b1"]]);
		expect(remote.main).toBe("merge(m0;b1)");
		expect(remote.dropped).toEqual(new Map([["dropped/a", "a1"]]));
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
		seed(disk, {
			...redPathAtRest(),
			members: [{ name: "x", sha: "x1", pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "x1",
			phase: "testing",
		});

		const { end, actions } = await land(remote, disk);

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual([
			"record-landed",
			"delete-landed-ref",
			"exit",
		]);
		expect(disk.log).toEqual(["take x@x1", "land x@x1"]);
		expect(batchIn(disk)?.phase).toBe("landed");
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
		seed(disk, {
			...redPathAtRest(),
			members: [{ name: "x", sha: "x1", pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "x1",
			phase: "testing",
		});

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

describe("a dropped ref the drop record lost (#4498)", () => {
	it("gets its entry back with the ticket titled for it, and is reaped once that ticket closes", async () => {
		const remote = remoteOf("m0", {}, { "dropped/a": "a1" });
		const disk = freshDisk();
		disk.tickets.set(7, "open");
		disk.titled.set("a@a1", 7);

		const first = await land(remote, disk);

		expect(kinds(first.actions)).toEqual(["adopt-dropped-ref", "exit"]);
		expect(disk.drops).toEqual([
			{
				name: "a",
				sha: "a1",
				ref: "dropped/a",
				onto: "m0",
				cause: { kind: "unrecorded", name: "a" },
				ticket: 7,
				at: NOW,
			},
		]);
		expect(remote.dropped.has("dropped/a")).toBe(true);

		disk.tickets.set(7, "closed");
		const second = await land(remote, disk);

		expect(kinds(second.actions)).toEqual(["delete-dropped-ref", "exit"]);
		expect(remote.dropped.size).toBe(0);
		expect(disk.filed).toEqual([]);
	});

	it("reaps it the same run where its ticket is already closed", async () => {
		const remote = remoteOf("m0", {}, { "dropped/a": "a1" });
		const disk = freshDisk();
		disk.tickets.set(7, "closed");
		disk.titled.set("a@a1", 7);

		const { actions } = await land(remote, disk);

		expect(kinds(actions)).toEqual([
			"adopt-dropped-ref",
			"delete-dropped-ref",
			"exit",
		]);
		expect(remote.dropped.size).toBe(0);
		expect(disk.drops.map((d) => [d.ref, d.ticket, d.reapedAt])).toEqual([
			["dropped/a", 7, NOW],
		]);
	});

	it("files a ticket for one the tracker holds none for, once across reruns that lose the record again", async () => {
		const sha = "b".repeat(40);
		const ref = `dropped/a-${sha.slice(0, 9)}`;
		const remote = remoteOf("m0", {}, { "dropped/a": "a1", [ref]: sha });
		const disk = freshDisk();
		disk.tickets.set(7, "open");
		disk.titled.set("a@a1", 7);

		await land(remote, disk);
		disk.drops = [];
		await land(remote, disk);

		expect(disk.filed.map((d) => [d.name, d.sha, d.ref, d.cause])).toEqual([
			["a", sha, ref, { kind: "unrecorded", name: "a" }],
		]);
		expect(disk.drops.map((d) => [d.ref, d.ticket])).toEqual([
			["dropped/a", 7],
			[ref, 100 + 1],
		]);
	});

	it("deletes one with no ticket whose sha main already holds, filing none", async () => {
		const remote = remoteOf("m0", {}, { "dropped/a": "a1" });
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, { onMain: ["a1"] });

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual(["adopt-dropped-ref", "exit"]);
		expect(remote.dropped.size).toBe(0);
		expect(disk.drops).toEqual([]);
		expect(disk.filed).toEqual([]);
	});

	it("files nothing where the tracker cannot be searched, leaving the ref for the next run", async () => {
		const remote = remoteOf("m0", {}, { "dropped/a": "a1" });
		const disk = freshDisk();

		const { end, actions, said } = await land(remote, disk, {
			findFault: () => new Error("gh: search failed"),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toEqual(["adopt-dropped-ref", "exit"]);
		expect(said).toEqual([
			"fix ticket for dropped/a not searched, left for the next run: gh: search failed",
		]);
		expect(disk.drops).toEqual([]);
		expect(disk.filed).toEqual([]);
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

	it("takes no rerun of a red its own run retried, going straight to the base check (#4545)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});

		const { asked } = await land(remote, freshDisk(), {
			requiresRun: false,
			verdict: (sha) =>
				sha === "m0" ? Green : { ...red("scripts/x.test.ts"), retried: true },
		});

		const integration = "merge(m0;a1,b1)";
		expect(asked.slice(0, 2)).toEqual([integration, "m0:scripts/x.test.ts"]);
	});

	it("reads main green, running no base check, where main went green within the hour (#4564)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		disk.green.add("m0");
		disk.greenAt.set("m0", NOW - 10 * 60 * 1000);

		const { asked } = await land(remote, disk, {
			requiresRun: false,
			verdict: (sha) => (sha === "m0" ? Green : red("scripts/x.test.ts")),
		});

		expect(asked).not.toContain("m0:scripts/x.test.ts");
		expect(remote.iso.has("lander/iso-base")).toBe(false);
	});

	it("asks the base check where main went green over an hour ago (#4564)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		disk.green.add("m0");
		disk.greenAt.set("m0", NOW - 2 * 60 * 60 * 1000);

		const { asked } = await land(remote, disk, {
			requiresRun: false,
			verdict: (sha) => (sha === "m0" ? Green : red("scripts/x.test.ts")),
		});

		expect(asked).toContain("m0:scripts/x.test.ts");
	});

	it("lands a batch red only where main is red too on a tester main takes any green of, filing one base-red ticket for those files", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end, asked, said } = await land(remote, disk, {
			requiresRun: false,
			verdict: () => red("scripts/x.test.ts"),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked).toContain("m0:scripts/x.test.ts");
		expect(disk.baseRed).toEqual(["m0 scripts/x.test.ts"]);
		expect(said).toContain("base-red issue: filed #90");
		expect(remote.main).toBe("merge(m0;a1,b1)");
		expect([...remote.iso]).toEqual([["lander/iso-base", "m0"]]);
		expect(disk.drops).toEqual([]);
	});

	/** Red on x's test `t`, failing with `signature`. */
	const failing = (signature: string): Verdict => ({
		kind: "red",
		files: ["scripts/x.test.ts"],
		failures: [{ file: "scripts/x.test.ts", test: "t", signature }],
	});

	it("reads a failure main shares on another signature as the batch's own, isolating its members and filing no base-red ticket", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { actions } = await land(remote, disk, {
			requiresRun: false,
			verdict: (sha) => failing(sha === "m0" ? "on main" : "in the batch"),
		});

		expect(kinds(actions)).toContain("start-isolation");
		expect(disk.baseRed).toEqual([]);
	});

	it("reads a repeat of main's failure, on its signature, as main's, filing the base-red ticket and isolating nothing", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, {
			requiresRun: false,
			verdict: () => failing("the same"),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).not.toContain("start-isolation");
		expect(disk.baseRed).toEqual(["m0 scripts/x.test.ts"]);
		expect(remote.main).toBe("merge(m0;a1,b1)");
	});

	it("holds a batch red only where main is red too where main takes only a sha a CI run passed, ledgering it never green, and lands the fix pushed after", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const x = "scripts/x.test.ts";
		/* x fails everywhere but where the fix f1 is merged. */
		const verdict = (sha: string) => (sha.includes("f1") ? Green : red(x));
		const held = {
			kind: "exit",
			reason: `held: red only where main at m0 is too, on ${x}, #90; retaken once a new ref waits or main moves`,
		};

		const first = await land(remote, disk, { requiresRun: true, verdict });
		const again = await land(remote, disk, { requiresRun: true, verdict });
		remote.refs.set("f", { sha: "f1", pushedAt: 3 });
		const fixed = await land(remote, disk, { requiresRun: true, verdict });

		expect(first.end).toEqual(held);
		expect(disk.baseRed).toEqual([`m0 ${x}`]);
		expect(kinds(first.actions)).toContain("hold");
		expect(kinds(first.actions)).not.toContain("start-isolation");
		expect(again.end).toEqual(held);
		expect(again.asked).toEqual([]);
		expect(disk.green.has("merge(m0;a1,b1)")).toBe(false);
		expect(taken(fixed.actions)).toEqual([["a@a1", "b@b1", "f@f1"]]);
		expect(fixed.end).toEqual(NO_QUEUE);
		expect(remote.main).toBe("merge(m0;a1,b1,f1)");
		expect(remote.refs.size).toBe(0);
	});

	it("runs the base check at main anew on lander/iso-base, never taking the verdict main reached as a batch", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		disk.verdicts.set(verdictKey("m0", [], 1), Green);
		disk.verdicts.set(verdictKey("m0", ["scripts/x.test.ts"], 1), Green);
		const isoAtAsk: (string | undefined)[] = [];

		const { asked } = await land(remote, disk, {
			requiresRun: false,
			verdict: (sha, r) => {
				if (sha === "m0") isoAtAsk.push(r.iso.get("lander/iso-base"));
				return red("scripts/x.test.ts");
			},
		});

		expect(asked).toContain("m0:scripts/x.test.ts");
		expect(isoAtAsk).toEqual(["m0"]);
		expect(batchIn(disk)?.bases).toContainEqual({
			sha: "m0",
			files: ["scripts/x.test.ts"],
			verdict: red("scripts/x.test.ts"),
		});
	});

	it("asks each red batch's base check afresh, so a failure main gained since an earlier batch's check is never blamed on this one (#4501)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		const x = "scripts/x.test.ts";
		/* x fails in every batch, and at main once the date turns. */
		let turned = false;
		const verdict = (sha: string) => (sha === "m0" && !turned ? Green : red(x));

		const first = await land(remote, disk, { requiresRun: false, verdict });
		turned = true;
		remote.refs.set("c", { sha: "c1", pushedAt: 2 });
		const second = await land(remote, disk, { requiresRun: false, verdict });

		expect(dropsOf(first.actions).map((d) => d.name)).toEqual(["a"]);
		expect(second.asked).toContain(`m0:${x}`);
		expect(dropsOf(second.actions)).toEqual([]);
		expect(disk.baseRed).toEqual([`m0 ${x}`]);
		expect(remote.main).toBe("merge(m0;c1)");
	});

	it("drops the one culprit red alone twice, landing a ref pushed during the search beside it and the passers as a batch of their own (#4556)", async () => {
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
			["d@d1"],
			["a@a1", "c@c1"],
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
		expect(remote.main).toBe("merge(merge(m0;d1);a1,c1)");
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
		seed(disk, {
			...redPathAtRest(),
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
			hold: null,
		});

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
		expect(asked).toEqual(["merge(merge(m0;a1);b1)", "merge(merge(m0;a1);b1)"]);
		expect(disk.log).toEqual([
			"take a@a1",
			"take b@b1",
			"land a@a1",
			"drop b@b1",
		]);
		expect(remote.main).toBe("merge(m0;a1)");
		expect(remote.refs.size).toBe(0);
	});

	it("takes a red naming no file through the whole suite: rerun, at main on lander/iso-suite-base, then each member alone on lander/iso-suite-<k>", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		disk.verdicts.set(verdictKey("m0", [], 1), Green);

		const { end, actions, asked } = await land(remote, disk, {
			verdict: (sha) =>
				sha.includes("a1") && sha.includes("b1") ? red() : Green,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(asked.filter((a) => a.includes(":"))).toEqual([]);
		const whole = "merge(m0;a1,b1)";
		expect(asked.slice(0, 5)).toEqual([
			whole,
			whole,
			"m0",
			"merge(m0;a1)",
			"merge(m0;b1)",
		]);
		expect(kinds(actions)).toContain("start-isolation");
		expect([...remote.iso]).toEqual([
			["lander/iso-suite-base", "m0"],
			["lander/iso-suite-0", "merge(m0;a1)"],
			["lander/iso-suite-1", "merge(m0;b1)"],
		]);
		expect(dropsOf(actions).map((d) => d.cause.kind)).toEqual(["collision"]);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["b"]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("drops a member whose whole suite is red twice alone where the red named no file", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, {
			verdict: (sha) => (sha.includes("b1") ? red() : Green),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(dropsOf(actions).map((d) => d.cause)).toEqual([
			{ kind: "red", name: "b", files: [], iso: "merge(m0;b1)" },
		]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("ends a batch whose push run never appears, dropping the member whose tree alone fires none and landing the rest (#4571)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const noRun: Verdict = { kind: "red", files: [], noRun: true };

		const { end, actions } = await land(remote, disk, {
			verdict: (sha) => (sha.includes("b1") ? noRun : Green),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(dropsOf(actions).map((d) => d.cause)).toEqual([
			{ kind: "red", name: "b", files: [], iso: "merge(m0;b1)", noRun: true },
		]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("drops a member whose tree fires no run though main went green within the hour, asking main afresh (#4571)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		disk.greenAt.set("m0", NOW - 10 * 60 * 1000);
		const noRun: Verdict = { kind: "red", files: [], noRun: true };

		const { actions, asked } = await land(remote, disk, {
			verdict: (sha) => (sha.includes("a1") ? noRun : Green),
		});

		expect(asked).toContain("m0");
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["a"]);
	});

	it("isolates a no-run red where main is red on a run of its own, rather than holding (#4571)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		const lint: Verdict = { kind: "red", files: [], jobs: ["Lint and types"] };

		const { actions } = await land(remote, disk, {
			verdict: (sha) =>
				sha.includes("a1") ? { kind: "red", files: [], noRun: true } : lint,
		});

		expect(kinds(actions)).not.toContain("hold");
		expect(kinds(actions)).toContain("start-isolation");
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["a"]);
	});

	it("holds a batch whose push run never appears where main fires none either, dropping no member (#4571)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();

		const { end, actions } = await land(remote, disk, {
			verdict: () => ({ kind: "red", files: [], noRun: true }),
		});

		expect(dropsOf(actions)).toEqual([]);
		expect(kinds(actions)).toContain("hold");
		expect(end.reason).toMatch(/^held: red only where main at m0 is too/);
		expect(remote.main).toBe("m0");
	});

	it("retakes a batch held where main fired no run either once the bound passes, with no new ref, and lands it once Actions fires runs again (#4572)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		const outage = () => ({ kind: "red", files: [], noRun: true }) as Verdict;
		const Hour = 60 * 60 * 1000;

		await land(remote, disk, { verdict: outage });
		const early = await land(remote, disk, {
			verdict: outage,
			now: NOW + Hour / 2,
		});
		expect(early.asked).toEqual([]);
		expect(early.end.reason).toMatch(/^held: .*as no run fired at main/);

		const due = await land(remote, disk, { now: NOW + Hour });

		expect(kinds(due.actions)).toContain("take-batch");
		expect(due.asked).toContain("merge(m0;a1)");
		expect(dropsOf(due.actions)).toEqual([]);
		expect(remote.main).toBe("merge(m0;a1)");
	});

	it("asks main afresh on retaking a no-run hold, never its outage verdict, dropping a member whose tree alone still fires none (#4572)", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();
		const noRun: Verdict = { kind: "red", files: [], noRun: true };

		await land(remote, disk, { verdict: () => noRun });
		const due = await land(remote, disk, {
			verdict: (sha) => (sha.includes("a1") ? noRun : Green),
			now: NOW + 60 * 60 * 1000,
		});

		expect(due.asked).toContain("m0");
		expect(due.asked).toContain("merge(m0;a1)");
		expect(kinds(due.actions)).not.toContain("hold");
		expect(dropsOf(due.actions).map((d) => d.name)).toEqual(["a"]);
	});

	it("holds a red naming no file whose every job main fails too, filing the base-red ticket for the whole suite", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
		});
		const disk = freshDisk();
		const lint: Verdict = { kind: "red", files: [], jobs: ["Lint and types"] };

		const { end, asked } = await land(remote, disk, {
			verdict: (sha) =>
				sha === "m0"
					? { ...lint, jobs: ["Lint and types", "Document guards"] }
					: lint,
		});

		expect(end).toEqual({
			kind: "exit",
			reason:
				"held: red only where main at m0 is too, on the whole suite, naming no file, #90; retaken once a new ref waits or main moves",
		});
		expect(asked).toEqual(["merge(m0;a1)", "merge(m0;a1)", "m0"]);
		expect(disk.baseRed).toEqual(["m0 "]);
		expect(remote.main).toBe("m0");
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
				c === "pushIso" && ++pushes === 4 ? new Error("killed") : undefined,
		});
		const second = await land(remote, disk, { verdict: redWhereHeld("b") });

		expect(first.end).toEqual({
			kind: "exit",
			reason: "stopped on an error: killed",
		});
		expect(batchIn(disk)?.phase).not.toBe("merging");
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

describe("a push main refuses", () => {
	const Ruleset =
		"! [remote rejected] x -> main (push declined due to repository rule violations)";

	it("holds the batch naming the refusal, takes its sha off the green ledger, and never pushes it again", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		let pushes = 0;
		const refuse = () => {
			pushes++;
			return Ruleset;
		};
		const held = {
			kind: "exit",
			reason: `held: the push of a1 to main was refused: ${Ruleset}; retaken once a new ref waits or main moves`,
		};

		const first = await land(remote, disk, { requiresRun: true, refuse });
		const again = await land(remote, disk, { requiresRun: true, refuse });

		expect(first.end).toEqual(held);
		expect(again.end).toEqual(held);
		expect(pushes).toBe(1);
		expect(disk.green.has("a1")).toBe(false);
		expect(batchIn(disk)?.hold).toEqual({
			kind: "refused",
			main: "m0",
			sha: "a1",
			reason: Ruleset,
		});
		expect(remote.main).toBe("m0");
		expect(remote.refs.size).toBe(1);
	});

	it("takes a refused sha off the green ledger before anything else, where a crash left its batch unheld and main moved since (#4501)", async () => {
		const remote = remoteOf("m1", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		disk.green.add("a1");
		disk.refused.set("a1", Ruleset);
		seed(disk, {
			...redPathAtRest(),
			members: [{ name: "a", sha: "a1", pushedAt: 1 }],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "a1",
			phase: "testing",
		});

		const { end, actions, pushed } = await land(remote, disk);

		expect(kinds(actions)[0]).toBe("unledger");
		expect(disk.green.has("a1")).toBe(false);
		expect(pushed).toEqual(["merge(m1;a1)"]);
		expect(end).toEqual(NO_QUEUE);
	});

	it("lands a serial step whose member main refused before as a new commit, never its own sha (#4501)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2, onMain: true },
		});
		const disk = freshDisk();
		disk.refused.set("b1", Ruleset);

		const { actions, pushed } = await land(remote, disk, {
			verdict: (sha) =>
				sha === "merge(m0;a1,b1)"
					? { kind: "red", files: ["y.ts"] }
					: { kind: "green", run: 1 },
		});

		expect(actions).toContainEqual(
			expect.objectContaining({ kind: "serial-land-step", fresh: true }),
		);
		expect(pushed).not.toContain("b1");
		expect(remote.main).toBe("merge(merge(m0;a1);b1)");
	});

	it("merges a lone member main refused as a new commit once retaken, pushing its own sha never again (#4501, the 5 Nov ea01c223e case)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1, onMain: true },
		});
		const disk = freshDisk();
		const refuse = (sha: string) => (sha === "a1" ? Ruleset : undefined);

		const first = await land(remote, disk, { refuse });
		remote.main = "m1";
		const retaken = await land(remote, disk, { refuse });

		expect(first.pushed).toEqual(["a1"]);
		expect(disk.refused.get("a1")).toBe(Ruleset);
		expect(retaken.pushed).toEqual(["merge(m1;a1)"]);
		expect(retaken.end).toEqual(NO_QUEUE);
		expect(remote.main).toBe("merge(m1;a1)");
	});

	it("holds any batch whose landing sha main refused before, pushing it never again (#4501)", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		disk.refused.set("merge(m0;a1,b1)", Ruleset);

		const { end, pushed, actions } = await land(remote, disk);

		expect(pushed).toEqual([]);
		expect(kinds(actions)).toContain("hold");
		expect(end.reason).toMatch(
			/^held: the push of merge\(m0; to main was refused/,
		);
		expect(disk.green.has("merge(m0;a1,b1)")).toBe(false);
	});

	it("holds a serial step main refuses, the members before it landed", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const step = "merge(merge(m0;a1);b1)";

		const { end } = await land(remote, disk, {
			verdict: (sha) =>
				sha === "merge(m0;a1,b1)"
					? { kind: "red", files: ["y.ts"] }
					: { kind: "green", run: 1 },
			refuse: (sha) => (sha === step ? Ruleset : undefined),
		});

		expect(end.reason).toMatch(
			/^held: the push of merge\(mer to main was refused/,
		);
		expect(remote.main).toBe("merge(m0;a1)");
		expect(disk.green.has(step)).toBe(false);
		expect(batchIn(disk)?.hold).toMatchObject({
			main: "merge(m0;a1)",
			sha: step,
		});
		expect([...remote.refs.keys()]).toEqual(["b"]);
	});
});

describe("a serial step", () => {
	const remote = () =>
		remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
	const Y = "scripts/y.test.ts";
	const Z = "scripts/z.test.ts";
	const step = "merge(merge(m0;a1);b1)";
	/* Red on y where a1 and b1 meet in the batch, each passing alone, and
	 * at the step as `at` says. */
	const collision =
		(
			at: (
				sha: string,
				files: readonly string[],
				nth: number,
			) => Verdict | undefined,
		) =>
		(sha: string, _: Remote, files: readonly string[], nth: number): Verdict =>
			at(sha, files, nth) ??
			(sha === "merge(m0;a1,b1)"
				? { kind: "red", files: [Y] }
				: { kind: "green", run: 1 });

	it("lands a step red once that passes its confirm, dropping nothing", async () => {
		const r = remote();
		const disk = freshDisk();

		const { end, actions, asked } = await land(r, disk, {
			verdict: collision((sha, _, nth) =>
				sha === step && nth === 1 ? { kind: "red", files: [Y] } : undefined,
			),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(dropsOf(actions)).toEqual([]);
		expect(asked.filter((x) => x === step)).toHaveLength(2);
		expect(r.main).toBe(step);
	});

	it("never drops a step red twice on files the collision did not fail, batching the rest again", async () => {
		const r = remote();
		const disk = freshDisk();

		const { actions } = await land(r, disk, {
			verdict: collision((sha, _, nth) =>
				sha === step && nth <= 2 ? { kind: "red", files: [Z] } : undefined,
			),
		});

		const retaken = actions.findIndex(
			(a, k) => k > 0 && a.kind === "take-batch",
		);
		expect(dropsOf(actions.slice(0, retaken))).toEqual([]);
		expect(actions.slice(0, retaken)).toContainEqual({
			kind: "rebatch-passers",
			ahead: ["b"],
		});
		expect(taken(actions)[1]).toEqual(["b@b1"]);
	});

	it("checks a step red twice elsewhere at its own main, and holds where main fails those files too", async () => {
		const r = remote();
		const disk = freshDisk();

		const { end, actions, asked } = await land(r, disk, {
			verdict: collision((sha, files) =>
				sha === step || (sha === "merge(m0;a1)" && files.includes(Z))
					? { kind: "red", files: [Z] }
					: undefined,
			),
		});

		expect(asked).toContain(`merge(m0;a1):${Z}`);
		expect(r.iso.get("lander/iso-base")).toBe("merge(m0;a1)");
		expect(dropsOf(actions)).toEqual([]);
		expect(disk.baseRed).toContain(`merge(m0;a1) ${Z}`);
		expect(end.reason).toMatch(
			/^held: red only where main at merge\(m0; is too, on scripts\/z\.test\.ts, #90;/,
		);
		expect(r.main).toBe("merge(m0;a1)");
		expect(disk.green.has(step)).toBe(false);
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

describe("the pipeline (#4556)", () => {
	const RedA = "scripts/a.test.ts";
	const A = "merge(m0;a1)";
	const B = `merge(${A};b1)`;
	const redWhereA = (sha: string): Verdict =>
		sha.includes("a1")
			? { kind: "red", files: [RedA] }
			: { kind: "green", run: 1 };
	const pushB = (sha: string, r: Remote) => {
		if (sha.includes("a1") && !r.refs.has("b"))
			r.refs.set("b", { sha: "b1", pushedAt: 2 });
	};
	const at = (events: readonly string[], e: string) => {
		const k = events.indexOf(e);
		if (k < 0) throw new Error(`no event ${e} in ${events.join(" | ")}`);
		return k;
	};

	it("merges a ref pushed while a batch is under test onto that batch's tip, and starts its run before that batch's verdict", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();

		const { end, actions, events } = await land(remote, disk, {
			parallel: true,
			onAsk: pushB,
			gate: (key, ev) => key !== A || ev.includes(`ask ${B}`),
		});

		expect(end).toEqual(NO_QUEUE);
		expect(taken(actions)).toEqual([["a@a1"], ["b@b1"]]);
		const second = actions.find(
			(a) => a.kind === "take-batch" && a.batch.members[0]?.name === "b",
		);
		expect(second).toMatchObject({ batch: { onto: A, slot: 1 } });
		expect(at(events, `ask ${B}`)).toBeLessThan(at(events, `verdict ${A}`));
		expect(remote.main).toBe(B);
		expect(disk.pipeline?.depth).toBe(3);
	});

	it("holds a green batch behind one still under test, moving main to each tip in queue order", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();

		const { pushed, events } = await land(remote, disk, {
			parallel: true,
			onAsk: pushB,
			gate: (key, ev) => key !== A || ev.includes(`verdict ${B}`),
		});

		expect(at(events, `verdict ${B}`)).toBeLessThan(at(events, `verdict ${A}`));
		expect(pushed).toEqual([A, B]);
		expect(at(events, `main ${A}`)).toBeGreaterThan(at(events, `verdict ${A}`));
		expect(remote.main).toBe(B);
	});

	it("cancels and rebuilds on main what follows a red batch, its run started before the red one's isolation ends; and drops the window to one on the red, widening it on each landing", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			c: { sha: "c1", pushedAt: 1 },
		});
		const disk = freshDisk();
		const Ac = "merge(m0;a1,c1)";
		const stale = `merge(${Ac};b1)`;
		const rebuilt = "merge(m0;b1)";
		const isoA = `${A}:${RedA}`;

		const { end, actions, events, depths } = await land(remote, disk, {
			parallel: true,
			verdict: redWhereA,
			onAsk: pushB,
			gate: (key, ev) => {
				if (key === Ac) return ev.includes(`ask ${stale}`);
				if (key === stale)
					return ev.some((e) => e.startsWith(`cancel ${stale}`));
				if (key === isoA) return ev.includes(`ask ${rebuilt}`);
				return true;
			},
		});

		expect(end).toEqual(NO_QUEUE);
		expect(kinds(actions)).toContain("detach");
		expect(events).toContain(`cancel ${stale} on lander/batch-1`);
		expect(at(events, `ask ${rebuilt}`)).toBeLessThan(
			at(events, `verdict ${isoA}`),
		);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["a"]);
		expect(taken(actions)).toEqual([["a@a1", "c@c1"], ["b@b1"], ["c@c1"]]);
		expect(remote.main).toBe(`merge(${rebuilt};c1)`);
		expect(depths).toEqual([2, 1, 2, 3]);
	});

	it("cancels a follower's run on a restart that finds its head red, though this run never asked it", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			b: { sha: "b1", pushedAt: 2 },
		});
		const disk = freshDisk();
		const batch = (name: string, slot: number, onto: string): Batch => ({
			...redPathAtRest(),
			slot,
			members: [{ name, sha: `${name}1`, pushedAt: slot + 1 }],
			deferred: [],
			dropped: [],
			onto,
			integration: `merge(${onto};${name}1)`,
			phase: "testing",
		});
		disk.pipeline = {
			line: [batch("a", 0, "m0"), batch("b", 1, A)],
			search: null,
			depth: 2,
		};
		disk.verdicts.set(verdictKey(A, [], 1), { kind: "red", files: [RedA] });

		const { end, actions, events } = await land(remote, disk, {
			parallel: true,
			verdict: redWhereA,
		});

		expect(end).toEqual(NO_QUEUE);
		expect(events).toContain(`cancel ${B} on lander/batch-1`);
		expect(dropsOf(actions).map((d) => d.name)).toEqual(["a"]);
		expect(remote.main).toBe("merge(m0;b1)");
	});

	it("keeps the window on a head whose push to main is refused, a refusal saying nothing of the batches", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();

		const { actions, depths } = await land(remote, disk, {
			parallel: true,
			refuse: (sha) => (sha === A ? "a gate" : undefined),
		});

		expect(kinds(actions)).toContain("detach");
		expect(depths).not.toContain(1);
	});

	it("takes a ref behind one batch at a time where the tester is not parallel", async () => {
		const remote = remoteOf("m0", { a: { sha: "a1", pushedAt: 1 } });
		const disk = freshDisk();

		const { actions, events } = await land(remote, disk, { onAsk: pushB });

		const second = actions.find(
			(a) => a.kind === "take-batch" && a.batch.members[0]?.name === "b",
		);
		expect(second).toMatchObject({ batch: { onto: A } });
		expect(at(events, `ask merge(${A};b1)`)).toBeGreaterThan(
			at(events, `main ${A}`),
		);
	});

	it("takes a re-batched search's passers ahead of a ref that waits beside them", async () => {
		const remote = remoteOf("m0", {
			a: { sha: "a1", pushedAt: 1 },
			c: { sha: "c1", pushedAt: 3 },
			d: { sha: "d1", pushedAt: 2 },
		});
		const disk = freshDisk();
		seed(disk, {
			...redPathAtRest(),
			members: [
				{ name: "a", sha: "a1", pushedAt: 1 },
				{ name: "c", sha: "c1", pushedAt: 3 },
			],
			deferred: [],
			dropped: [],
			onto: "m0",
			integration: "merge(m0;a1,c1)",
			phase: "requeued",
			ahead: ["a", "c"],
		});

		const { actions } = await land(remote, disk);

		expect(taken(actions)).toEqual([["a@a1", "c@c1"], ["d@d1"]]);
	});
});
