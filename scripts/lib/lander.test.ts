// @vitest-environment node
/*
 * The lander's run (#2402, #2404, spec #2261).
 *
 * Loosen one and `main` can move to a sha no tester passed, move before the
 * ledger holds it (so the pre-push check refuses the lander's own push), two
 * landers can test and push at once, or a red batch can revert the wrong
 * commit, revert on a flake, or leave a revert with no fix ticket.
 */
import { describe, expect, it } from "vitest";
import {
	type FixTicket,
	type Held,
	type HoldNote,
	type Red,
	runLander,
	type Verdict,
} from "./lander.js";

type Relation = "ahead" | "equal" | "behind" | "diverged";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const R = "e".repeat(40);
const F = "f".repeat(40);

/**
 * One run against a remote holding `main` and `landing` over a linear
 * `history`, recording each push with the ledger as it stood, each test, and
 * each fix ticket. `relation` defaults to what the shas say, reading any two
 * distinct shas as landing ahead. A revert lands on `landing` as `R`, onto
 * the tip it found there. `refsFail` throws from the nth read of the refs
 * where it returns an error.
 */
async function run(
	remote: { main: string; landing: string | null; relation?: Relation },
	verdictOf: (sha: string, files: string[] | undefined, nth: number) => Verdict,
	{
		lockFree = true,
		ledgered = [] as string[],
		onTest = (_sha: string): void => undefined,
		history = [] as string[],
		revertFails = null as string | null,
		fileFails = null as string | null,
		holdFails = null as string | null,
		lastHold = null as HoldNote | null,
		lastRed = null as Red | null,
		refsFail = ((_nth: number) => null) as (nth: number) => Error | null,
	} = {},
) {
	const ledger = new Set<string>(ledgered);
	const pushes: { sha: string; ledgerAtPush: string[] }[] = [];
	const tested: { sha: string; files?: string[] }[] = [];
	const tickets: FixTicket[] = [];
	const holds: Held[] = [];
	const beats: { batch: string | null; hold?: HoldNote; red?: Red }[] = [];
	const said: string[] = [];
	const actions: unknown[] = [];
	let refsRead = 0;
	let released = 0;
	const waits: number[] = [];
	const at = (sha: string) =>
		sha === R ? history.length : history.indexOf(sha);
	const end = await runLander({
		git: {
			refs: () => {
				refsRead++;
				const fault = refsFail(refsRead);
				if (fault) throw fault;
				const relation =
					remote.relation ??
					(remote.main === remote.landing ? "equal" : "ahead");
				return { main: remote.main, landing: remote.landing, relation };
			},
			pushMain: (sha) => {
				pushes.push({ sha, ledgerAtPush: [...ledger] });
				remote.main = sha;
			},
			firstParents: (base, sha) =>
				history.slice(
					base === null ? 0 : history.indexOf(base) + 1,
					history.indexOf(sha) + 1,
				),
			revertOnLanding: () => {
				if (revertFails !== null) return { failed: revertFails };
				const onto = remote.landing ?? A;
				remote.landing = R;
				return { sha: R, onto };
			},
			contains: (tip, sha) =>
				tip === sha || (at(sha) !== -1 && at(sha) <= at(tip)),
		},
		tester: {
			verdict: async (sha, files) => {
				tested.push(files ? { sha, files } : { sha });
				onTest(sha);
				return verdictOf(
					sha,
					files,
					tested.filter((t) => t.sha === sha && t.files).length,
				);
			},
		},
		tracker: {
			fileFixTicket: (t) => {
				if (fileFails !== null) throw new Error(fileFails);
				tickets.push(t);
				return "Filed #1";
			},
			holdQueue: (h) => {
				if (holdFails !== null) throw new Error(holdFails);
				holds.push(h);
				return "Filed #2";
			},
		},
		ledger: {
			has: (sha) => ledger.has(sha),
			add: (sha) => {
				ledger.add(sha);
			},
		},
		lock: {
			acquire: () => lockFree,
			release: () => {
				released++;
			},
		},
		beat: (batch, note) => {
			beats.push({ batch, ...note });
		},
		lastHold: () => lastHold,
		lastRed: () => lastRed,
		wait: async (ms) => {
			waits.push(ms);
		},
		log: (a) => {
			actions.push(a);
		},
		say: (line) => {
			said.push(line);
		},
	});
	return {
		end,
		pushes,
		tested,
		tickets,
		holds,
		beats,
		said,
		actions,
		released,
		refsRead,
		waits,
	};
}

const green = (): Verdict => ({ kind: "green" });

describe("runLander", () => {
	it("lands a green batch, the ledger holding its sha when main is pushed", async () => {
		const r = await run({ main: A, landing: B }, green);
		expect(r.actions).toEqual([
			{ kind: "test", sha: B },
			{ kind: "fast-forward", sha: B },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.pushes).toEqual([{ sha: B, ledgerAtPush: [B] }]);
		expect(r.released).toBe(1);
	});

	it("never fast-forwards on an unknown verdict", async () => {
		const r = await run({ main: A, landing: B }, () => ({
			kind: "unknown",
			reason: "tester died",
		}));
		expect(r.end).toEqual({
			kind: "exit",
			reason: "no verdict at bbbbbbbbb: tester died",
		});
		expect(r.pushes).toEqual([]);
	});

	it("tests nothing where landing equals main", async () => {
		const r = await run({ main: A, landing: A }, green);
		expect(r.end).toEqual({ kind: "exit", reason: "landing equals main" });
		expect(r.tested).toEqual([]);
	});

	it("tests nothing where the remote has no landing branch", async () => {
		const r = await run({ main: A, landing: null }, green);
		expect(r.end).toEqual({
			kind: "exit",
			reason: "the remote has no landing branch",
		});
		expect(r.tested).toEqual([]);
	});

	it.each([
		["behind", "landing is behind main"],
		["diverged", "landing bbbbbbbbb and main have diverged"],
	] as const)(
		"pushes nothing, ledgered or not, where landing is %s",
		async (relation, reason) => {
			const r = await run({ main: A, landing: B, relation }, green, {
				ledgered: [B],
			});
			expect(r.end).toEqual({ kind: "exit", reason });
			expect(r.tested).toEqual([]);
			expect(r.pushes).toEqual([]);
		},
	);

	it("reads no ref and releases nothing where the lock is held", async () => {
		const r = await run({ main: A, landing: B }, green, { lockFree: false });
		expect(r.end).toEqual({
			kind: "exit",
			reason: "another lander holds the lock",
		});
		expect(r.refsRead).toBe(0);
		expect(r.released).toBe(0);
	});

	it("fast-forwards without a test to a tip the ledger already holds", async () => {
		const r = await run({ main: A, landing: B }, green, { ledgered: [B] });
		expect(r.tested).toEqual([]);
		expect(r.pushes.map((p) => p.sha)).toEqual([B]);
	});

	it("lands the batch in flight, then takes a tip pushed during its test as the next", async () => {
		const remote = { main: A, landing: B as string | null };
		const r = await run(remote, green, {
			onTest: (sha) => {
				if (sha === B) remote.landing = C;
			},
		});
		expect(r.actions).toEqual([
			{ kind: "test", sha: B },
			{ kind: "fast-forward", sha: B },
			{ kind: "test", sha: C },
			{ kind: "fast-forward", sha: C },
			{ kind: "exit", reason: "landing equals main" },
		]);
	});

	it("ends as an exit naming the error, releasing the lock, when a push is refused", async () => {
		let released = 0;
		const actions: unknown[] = [];
		const end = await runLander({
			git: {
				refs: () => ({ main: A, landing: B, relation: "ahead" }),
				pushMain: () => {
					throw Object.assign(new Error("Command failed: git push"), {
						stderr: "! [remote rejected] pre-push hook declined\n",
					});
				},
				firstParents: () => [],
				revertOnLanding: () => ({ sha: R, onto: B }),
				contains: () => false,
			},
			tester: { verdict: async () => ({ kind: "green" }) },
			tracker: { fileFixTicket: () => "", holdQueue: () => "" },
			ledger: { has: () => false, add: () => undefined },
			lock: {
				acquire: () => true,
				release: () => {
					released++;
				},
			},
			beat: () => undefined,
			log: (a) => {
				actions.push(a);
			},
			wait: async () => undefined,
		});
		const exit = {
			kind: "exit",
			reason: "stopped on an error: ! [remote rejected] pre-push hook declined",
		};
		expect(end).toEqual(exit);
		expect(actions.at(-1)).toEqual(exit);
		expect(released).toBe(1);
	});
});

/** git's words for the DNS failure of #2673. */
const dnsFailure = () =>
	Object.assign(new Error("Command failed: git ls-remote origin"), {
		stderr:
			"fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n",
	});

describe("runLander on a failing remote (#2673)", () => {
	it("retries a read of the refs that fails on the network, then carries on", async () => {
		const r = await run({ main: A, landing: B }, green, {
			refsFail: (nth) => (nth === 1 ? dnsFailure() : null),
		});
		expect(r.waits).toHaveLength(1);
		expect(r.actions[0]).toEqual({ kind: "test", sha: B });
		expect(r.pushes.map((p) => p.sha)).toEqual([B]);
	});

	it("ends as an exit naming git's error, releasing the lock, once the retries run out", async () => {
		const r = await run({ main: A, landing: B }, green, {
			refsFail: () => dnsFailure(),
		});
		expect(r.end).toEqual({
			kind: "exit",
			reason:
				"stopped on an error: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
		});
		expect(r.actions).toEqual([r.end]);
		expect(r.refsRead).toBe(5);
		expect(r.released).toBe(1);
	});

	it("retries no failure but the network's", async () => {
		const r = await run({ main: A, landing: B }, green, {
			refsFail: () => new Error("fatal: not a git repository"),
		});
		expect(r.end).toEqual({
			kind: "exit",
			reason: "stopped on an error: fatal: not a git repository",
		});
		expect(r.refsRead).toBe(1);
		expect(r.waits).toEqual([]);
	});
});

const FILES = ["x.test.ts"];

/**
 * A batch A..D over B, C, D whose tip fails x.test.ts, with each rerun's
 * verdict, on that file or the whole suite, from `filesRed`, and the revert
 * R green.
 */
const redBatch = (
	filesRed: (sha: string, nth: number) => boolean,
	{
		remote = { main: A, landing: D } as { main: string; landing: string },
		...opts
	}: {
		remote?: { main: string; landing: string };
		revertFails?: string;
		fileFails?: string;
		holdFails?: string;
		onTest?: (sha: string) => void;
		lastRed?: Red | null;
		refsFail?: (nth: number) => Error | null;
	} = {},
) =>
	run(
		remote,
		(sha, files, nth) => {
			if (files === undefined)
				return sha === R ? { kind: "green" } : { kind: "red", files: FILES };
			if (!filesRed(sha, nth)) return { kind: "green" };
			return { kind: "red", files: files.length > 0 ? files : FILES };
		},
		{ history: [B, C, D], ...opts },
	);

/** C fails on its first run and passes its confirming one. */
const unconfirmedC = (sha: string, nth: number) =>
	sha === D || (sha === C && nth === 1);

describe("runLander on a red batch", () => {
	it("lands the batch when its failing files pass on the rerun", async () => {
		const r = await redBatch(() => false);
		expect(r.actions).toEqual([
			{ kind: "test", sha: D },
			{ kind: "rerun", sha: D, files: FILES, why: "flake" },
			{ kind: "fast-forward", sha: D },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.pushes).toEqual([{ sha: D, ledgerAtPush: [D] }]);
		expect(r.tickets).toEqual([]);
	});

	it("lands a confirmed culprit's parent, reverts the culprit on landing, files its fix ticket and lands the revert", async () => {
		const r = await redBatch((sha) => sha === C || sha === D);
		expect(r.actions).toEqual([
			{ kind: "test", sha: D },
			{ kind: "rerun", sha: D, files: FILES, why: "flake" },
			{ kind: "bisect", base: A, sha: D },
			{ kind: "rerun", sha: B, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "confirm" },
			{ kind: "rerun", sha: B, files: [], why: "confirm" },
			{ kind: "fast-forward", sha: B },
			{ kind: "revert", culprit: C, parent: B, files: FILES },
			{
				kind: "file-fix-ticket",
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
			},
			{ kind: "test", sha: R },
			{ kind: "fast-forward", sha: R },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.tickets).toEqual([
			{ culprit: C, parent: B, revert: R, files: FILES },
		]);
		expect(r.pushes.map((p) => p.sha)).toEqual([B, R]);
	});

	it("moves main nowhere before the revert where the culprit's parent is main", async () => {
		const r = await redBatch((sha) => sha !== A);
		expect(r.actions).toContainEqual({
			kind: "revert",
			culprit: B,
			parent: A,
			files: FILES,
		});
		expect(r.tickets).toEqual([
			{ culprit: B, parent: A, revert: R, files: FILES },
		]);
		expect(r.pushes.map((p) => p.sha)).toEqual([R]);
	});

	it.each([
		[
			"passes on its second run",
			unconfirmedC,
			"culprit unconfirmed: ccccccccc passed x.test.ts on its second run",
		],
		[
			"has a parent that fails on its confirming run",
			(sha: string, nth: number) =>
				sha === C || sha === D || (sha === B && nth === 2),
			"culprit unconfirmed: ccccccccc's parent bbbbbbbbb fails the whole suite: x.test.ts",
		],
	])(
		"holds, moving and reverting nothing, where the culprit %s",
		async (_, filesRed, reason) => {
			const r = await redBatch(filesRed);
			expect(r.end).toEqual({ kind: "hold", reason });
			expect(r.pushes).toEqual([]);
			expect(r.tickets).toEqual([]);
		},
	);

	it("files the held-queue issue on a hold, naming the batch, reason and failing files, and beats last naming the hold", async () => {
		const r = await redBatch(unconfirmedC);
		const reason =
			"culprit unconfirmed: ccccccccc passed x.test.ts on its second run";
		expect(r.holds).toEqual([{ batch: D, reason, files: FILES }]);
		expect(r.said).toContain("Filed #2");
		expect(r.beats.at(-1)).toEqual({
			batch: D,
			hold: { landing: D, reason, filed: "Filed #2" },
		});
	});

	it("still holds, naming the failure in its last beat, where the held-queue issue is not filed", async () => {
		const r = await redBatch(unconfirmedC, { holdFails: "gh down" });
		expect(r.end).toMatchObject({ kind: "hold" });
		expect(r.beats.at(-1)?.hold).toMatchObject({
			filed: "held-queue issue not filed: gh down",
		});
	});

	it("files no held-queue issue on a run that lands", async () => {
		const r = await run({ main: A, landing: B }, green);
		expect(r.holds).toEqual([]);
		expect(r.beats.every((b) => b.hold === undefined)).toBe(true);
	});

	it("leaves a tip the last run held on untested, beating the hold again", async () => {
		const hold = {
			landing: D,
			reason: "culprit unconfirmed",
			filed: "Filed #2",
		};
		const r = await run({ main: A, landing: D }, green, { lastHold: hold });
		expect(r.end).toEqual({
			kind: "exit",
			reason: "landing ddddddddd is held: culprit unconfirmed",
		});
		expect(r.tested).toEqual([]);
		expect(r.beats.at(-1)).toEqual({ batch: null, hold });
	});

	it("tests a tip pushed since the last run held", async () => {
		const hold = { landing: C, reason: "r", filed: "f" };
		const r = await run({ main: A, landing: D }, green, { lastHold: hold });
		expect(r.pushes.map((p) => p.sha)).toEqual([D]);
	});

	it("pins a hold to the batch it tested, so a tip pushed mid-run is tested by the next run (#2477)", async () => {
		const remote = { main: A, landing: D };
		const first = await redBatch(unconfirmedC, {
			remote,
			onTest: (sha) => {
				if (sha === C) remote.landing = F;
			},
		});
		expect(first.end).toMatchObject({ kind: "hold" });
		const hold = first.beats.at(-1)?.hold ?? null;
		expect(hold?.landing).toBe(D);
		const second = await run(remote, green, { lastHold: hold });
		expect(second.tested).toEqual([{ sha: F }]);
		expect(second.pushes.map((p) => p.sha)).toEqual([F]);
	});

	it("holds on a revert that does not land, after landing the culprit's parent", async () => {
		const r = await redBatch((sha) => sha === C || sha === D, {
			revertFails: "error: could not revert ccccccc",
		});
		expect(r.end).toEqual({
			kind: "hold",
			reason:
				"the revert of ccccccccc did not land on landing: error: could not revert ccccccc",
		});
		expect(r.pushes.map((p) => p.sha)).toEqual([B]);
		expect(r.tickets).toEqual([]);
	});

	it("holds, naming the culprit and its revert, where the fix ticket is not filed, recording the revert as the held tip", async () => {
		const r = await redBatch((sha) => sha === C || sha === D, {
			fileFails: "fix ticket for ccccccccc not filed: gh down",
		});
		expect(r.beats.at(-1)?.hold?.landing).toBe(R);
		expect(r.end).toEqual({
			kind: "hold",
			reason:
				"ccccccccc is reverted in eeeeeeeee, but its fix ticket is not filed: fix ticket for ccccccccc not filed: gh down",
		});
		expect(r.pushes.map((p) => p.sha)).toEqual([B]);
	});

	it("pins the red batch, not its revert, where the revert was committed on a tip pushed mid-run (#2477)", async () => {
		const remote = { main: A, landing: D };
		const r = await redBatch((sha) => sha === C || sha === D, {
			remote,
			fileFails: "gh down",
			onTest: (sha) => {
				if (sha === C) remote.landing = F;
			},
		});
		expect(r.end).toMatchObject({ kind: "hold" });
		expect(r.beats.at(-1)?.hold?.landing).toBe(D);
	});

	it("exits with no verdict, moving nothing, where a rerun reads none", async () => {
		const r = await run(
			{ main: A, landing: D },
			(_sha, files) =>
				files
					? { kind: "unknown", reason: "tester died" }
					: { kind: "red", files: FILES },
			{ history: [B, C, D] },
		);
		expect(r.end).toEqual({
			kind: "exit",
			reason: "no verdict at ddddddddd: tester died",
		});
		expect(r.pushes).toEqual([]);
	});
});

describe("runLander across runs on a red batch (#2673)", () => {
	/** A first run whose refs fail once the tip's flake rerun is red. */
	const cutShort = (remote: { main: string; landing: string }) => {
		let reran = false;
		return redBatch((sha) => sha === C || sha === D, {
			remote,
			onTest: (sha) => {
				if (sha === D && remote.landing === D) reran = true;
			},
			refsFail: (nth) => (reran && nth > 2 ? dnsFailure() : null),
		});
	};

	it("carries the red batch in its beats, so a run ended by an error leaves it", async () => {
		const first = await cutShort({ main: A, landing: D });
		expect(first.end).toMatchObject({ kind: "exit" });
		expect(first.beats.at(-1)?.red).toMatchObject({
			sha: D,
			base: A,
			files: FILES,
			flake: { kind: "red", files: FILES },
		});
	});

	it("resumes the red batch a past run left, bisecting rather than testing the tip again", async () => {
		const remote = { main: A, landing: D };
		const first = await cutShort(remote);
		const second = await redBatch((sha) => sha === C || sha === D, {
			remote,
			lastRed: first.beats.at(-1)?.red ?? null,
		});
		expect(second.actions[0]).toEqual({ kind: "bisect", base: A, sha: D });
		expect(second.tested).not.toContainEqual({ sha: D });
		expect(second.tickets).toEqual([
			{ culprit: C, parent: B, revert: R, files: FILES },
		]);
	});

	it("tests afresh where landing no longer descends from the past run's red batch", async () => {
		const first = await cutShort({ main: A, landing: D });
		const second = await run({ main: A, landing: F }, green, {
			lastRed: first.beats.at(-1)?.red ?? null,
		});
		expect(second.actions[0]).toEqual({ kind: "test", sha: F });
	});

	it("reruns a past run's run that reached no verdict, rather than exiting on it", async () => {
		const red: Red = {
			sha: D,
			base: A,
			files: FILES,
			flake: { kind: "unknown", reason: "tester died" },
			range: null,
			bisect: {},
			confirm: {},
			revert: null,
			unfiled: null,
		};
		const r = await redBatch(() => false, { lastRed: red });
		expect(r.actions[0]).toEqual({
			kind: "rerun",
			sha: D,
			files: FILES,
			why: "flake",
		});
		expect(r.pushes.map((p) => p.sha)).toEqual([D]);
	});

	it("drops the red batch from its beats once it holds", async () => {
		const r = await redBatch(unconfirmedC);
		expect(r.end).toMatchObject({ kind: "hold" });
		expect(r.beats.at(-1)?.red).toBeUndefined();
	});
});

describe("runLander resuming a past run's red batch where the remote moved (#2673)", () => {
	const pastRed = (): Red => ({
		sha: D,
		base: A,
		files: FILES,
		flake: { kind: "red", files: FILES },
		range: null,
		bisect: {},
		confirm: {},
		revert: null,
		unfiled: null,
	});

	it("resumes it on a landing pushed past it", async () => {
		const r = await run(
			{ main: A, landing: F },
			(sha, files) =>
				files === undefined || sha === C || sha === D
					? { kind: "red", files: FILES }
					: { kind: "green" },
			{ history: [B, C, D, F], lastRed: pastRed() },
		);
		expect(r.actions[0]).toEqual({ kind: "bisect", base: A, sha: D });
	});

	it("tests afresh where main already holds it", async () => {
		const r = await run({ main: D, landing: F }, green, {
			history: [B, C, D, F],
			lastRed: pastRed(),
		});
		expect(r.actions[0]).toEqual({ kind: "test", sha: F });
	});
});

it("keeps the last run's hold in its beats where the remote cannot be read (#2673)", async () => {
	const hold = { landing: D, reason: "culprit unconfirmed", filed: "Filed #2" };
	const r = await run({ main: A, landing: D }, green, {
		lastHold: hold,
		refsFail: () => dnsFailure(),
	});
	expect(r.end).toMatchObject({ kind: "exit" });
	expect(r.beats.every((b) => b.hold === hold)).toBe(true);
});
