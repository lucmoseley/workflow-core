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
	type JobsOnMain,
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
/* A row the revert left stale, which the fix ticket carries (#3127). */
const STALE = [
	{
		row: "STALE-PROSE scripts/g.js",
		forward: "node scripts/check-guard-registry.js --review scripts/g.js",
	},
];
const F = "f".repeat(40);

/**
 * One run against a remote holding `main` and `landing` over a linear
 * `history`, recording each push with the ledger as it stood, each test, and
 * each fix ticket. `relation` defaults to what the shas say, reading any two
 * distinct shas as landing ahead. A revert lands on `landing` as `R`, onto
 * the tip it found there. `refsFail` throws from the nth read of the refs
 * where it returns an error. `mainJobs`, where given, is the tester's read of
 * CI jobs on `main`.
 */
async function run(
	remote: { main: string; landing: string | null; relation?: Relation },
	verdictOf: (sha: string, files: string[] | undefined, nth: number) => Verdict,
	{
		lockFree = true,
		ledgered = [] as string[],
		stuck = [] as string[],
		onTest = (_sha: string): void => undefined,
		history = [] as string[],
		revertFails = null as string | null,
		fileFails = null as string | null,
		holdFails = null as string | null,
		lastHold = null as HoldNote | null,
		lastRed = null as Red | null,
		lastMoved = null as string | null,
		refsFail = ((_nth: number) => null) as (nth: number) => Error | null,
		requiresRun = false,
		pushRefused = null as string | null,
		pushFails = null as (() => Error) | null,
		mainJobs = null as ((jobs: string[]) => JobsOnMain) | null,
	} = {},
) {
	const ledger = new Set<string>(ledgered);
	const noVerdict = new Set<string>(stuck);
	const pushes: { sha: string; ledgerAtPush: string[] }[] = [];
	const tested: { sha: string; files?: string[] }[] = [];
	const landing: { sha: string; files: string[] }[] = [];
	const tickets: FixTicket[] = [];
	const holds: Held[] = [];
	const beats: {
		batch: string | null;
		hold?: HoldNote;
		red?: Red;
		movedAt?: string | null;
	}[] = [];
	const said: string[] = [];
	const reverted: { culprit: string; parent: string | null }[] = [];
	const revertWhys: string[] = [];
	const actions: unknown[] = [];
	const mainJobsRead: string[][] = [];
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
				if (pushFails !== null) throw pushFails();
				if (pushRefused !== null)
					throw Object.assign(new Error("Command failed: git push"), {
						stderr: pushRefused,
					});
				remote.main = sha;
			},
			chain: (base, sha) =>
				history.slice(
					base === null ? 0 : history.indexOf(base) + 1,
					history.indexOf(sha) + 1,
				),
			revertOnLanding: (culprit, parent, why) => {
				reverted.push({ culprit, parent });
				revertWhys.push(why);
				if (revertFails !== null) return { failed: revertFails };
				const onto = remote.landing ?? A;
				remote.landing = R;
				return { sha: R, onto, stale: STALE };
			},
			/* A, main before the batch, precedes every sha in `history`. */
			contains: (tip, sha) =>
				tip === sha ||
				(sha === A && at(tip) !== -1) ||
				(at(sha) !== -1 && at(sha) <= at(tip)),
		},
		tester: {
			requiresRun,
			...(mainJobs && {
				jobsOnMain: async (jobs: string[]) => {
					mainJobsRead.push(jobs);
					return mainJobs(jobs);
				},
			}),
			verdict: async (sha, files, lands) => {
				tested.push(files ? { sha, files } : { sha });
				if (lands && files) landing.push({ sha, files });
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
		noVerdict: {
			has: (sha) => noVerdict.has(sha),
			add: (sha) => {
				noVerdict.add(sha);
			},
		},
		lock: {
			acquire: () => lockFree,
			release: () => {
				released++;
			},
		},
		beat: (batch, note, movedAt) => {
			beats.push({ batch, ...note, ...(movedAt ? { movedAt } : {}) });
		},
		lastHold: () => lastHold,
		lastRed: () => lastRed,
		lastMoved: () => lastMoved,
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
		stuck: [...noVerdict],
		tested,
		landing,
		tickets,
		holds,
		beats,
		said,
		revertWhys,
		reverted,
		actions,
		released,
		refsRead,
		waits,
		mainJobsRead,
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

	it("records in its beats when it moved main, from the push on (#2692)", async () => {
		const before = Date.now();
		const r = await run({ main: A, landing: B }, green);
		const last = r.beats.at(-1);
		expect(Date.parse(last?.movedAt ?? "")).toBeGreaterThanOrEqual(before);
		expect(r.beats[0]?.movedAt).toBeUndefined();
	});

	it("carries the last run's move in every beat where it moves main nowhere", async () => {
		const moved = "2026-10-21T10:00:00.000Z";
		const r = await run({ main: A, landing: A }, green, { lastMoved: moved });
		expect(r.beats.length).toBeGreaterThan(0);
		expect(r.beats.every((b) => b.movedAt === moved)).toBe(true);
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

	it("holds on a push to main the remote refuses, naming the refusal, and never pushes it again (#3329)", async () => {
		const refusal =
			"remote: error: GH013: Repository rule violations found for refs/heads/main.\nTo github.com:o/r.git\n ! [remote rejected] bbbbbbbbb -> main (push declined due to repository rule violations)\nerror: failed to push some refs\n";
		const reason =
			"the push of bbbbbbbbb to main was refused:  ! [remote rejected] bbbbbbbbb -> main (push declined due to repository rule violations)";
		const first = await run({ main: A, landing: B }, green, {
			pushRefused: refusal,
		});
		expect(first.end).toEqual({ kind: "hold", reason });
		expect(first.pushes.map((p) => p.sha)).toEqual([B]);
		expect(first.holds).toEqual([{ batch: B, reason, failing: null }]);
		const hold = first.beats.at(-1)?.hold;
		expect(hold).toEqual({ landing: B, reason, filed: "Filed #2" });
		expect(first.beats.some((b) => b.movedAt)).toBe(false);
		expect(first.released).toBe(1);

		const next = await run({ main: A, landing: B }, green, {
			ledgered: [B],
			lastHold: hold ?? null,
		});
		expect(next.end).toMatchObject({ kind: "exit" });
		expect(next.pushes).toEqual([]);
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

	it.each([
		["a network fault the retries do not outlast", dnsFailure, 5],
		[
			"a timeout git printed no refusal for",
			() => new Error("git push b:refs/heads/main timed out after 20 min"),
			1,
		],
	])(
		"exits naming the error, holding nothing, on a push to main that fails on %s (#3329)",
		async (_, fault, tries) => {
			const r = await run({ main: A, landing: B }, green, {
				pushFails: fault,
			});
			expect(r.end).toMatchObject({ kind: "exit" });
			expect(r.end.reason).toMatch(/^stopped on an error: /);
			expect(r.holds).toEqual([]);
			expect(r.pushes).toHaveLength(tries);
		},
	);

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

	it("names git's refusal, not the pre-push hook's first line, where a push is refused (#2996)", async () => {
		const r = await run({ main: A, landing: B }, green, {
			refsFail: () =>
				Object.assign(new Error("Command failed: git push"), {
					stderr:
						"lander: OK: no pushed ref to judge.\nTo github.com:o/r.git\n ! [rejected]        024a6dce5 -> main (non-fast-forward)\nerror: failed to push some refs\n",
				}),
		});
		expect(r.end).toEqual({
			kind: "exit",
			reason:
				"stopped on an error:  ! [rejected]        024a6dce5 -> main (non-fast-forward)",
		});
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
		history?: string[];
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
			{ kind: "rerun", sha: A, files: FILES, why: "base" },
			{ kind: "bisect", base: A, sha: D },
			{ kind: "rerun", sha: B, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "confirm" },
			{ kind: "rerun", sha: B, files: [], why: "parent" },
			{ kind: "fast-forward", sha: B },
			{
				kind: "revert",
				culprit: C,
				parent: B,
				files: FILES,
				jobs: [],
				parentIsMain: false,
			},
			{
				kind: "file-fix-ticket",
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
			{ kind: "test", sha: R },
			{ kind: "fast-forward", sha: R },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.tickets).toEqual([
			{
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
		]);
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
		expect(r.pushes.map((p) => p.sha)).toEqual([B, R]);
	});

	it("moves main nowhere before the revert where the culprit's parent is main", async () => {
		const r = await redBatch((sha) => sha !== A);
		expect(r.actions).toContainEqual({
			kind: "revert",
			culprit: B,
			parent: A,
			files: FILES,
			jobs: [],
			parentIsMain: true,
		});
		expect(r.revertWhys).toEqual([
			"The lander found it red on x.test.ts, twice, with its parent aaaaaaaaa at `main`.",
		]);
		expect(r.tickets).toEqual([
			{
				culprit: B,
				parent: A,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
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
		expect(r.holds).toEqual([
			{ batch: D, reason, failing: { files: FILES, jobs: [] } },
		]);
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

	it("pins a hold to the batch it tested, handing a red tip pushed mid-run to the next run (#2477, #3415)", async () => {
		const remote = { main: A, landing: D };
		const first = await redBatch(unconfirmedC, {
			remote,
			history: [B, C, D, F],
			onTest: (sha) => {
				if (sha === C) remote.landing = F;
			},
		});
		expect(first.end).toMatchObject({ kind: "hold" });
		expect(first.tested).toContainEqual({ sha: F });
		const { hold = null, red = null } = first.beats.at(-1) ?? {};
		expect(hold?.landing).toBe(D);
		expect(red?.sha).toBe(F);
		const second = await run(remote, green, {
			history: [B, C, D, F],
			lastHold: hold,
			lastRed: red,
		});
		expect(second.tested).toEqual([{ sha: F, files: FILES }]);
		expect(second.pushes.map((p) => p.sha)).toEqual([F]);
	});

	it("lands a green tip pushed past the batch mid-bisect, bisecting no further (#3486)", async () => {
		const remote = { main: A, landing: D };
		const r = await run(
			remote,
			(sha, files) =>
				sha === F || (files !== undefined && sha !== C && sha !== D)
					? green()
					: { kind: "red", files: FILES },
			{
				history: [B, C, D, F],
				onTest: (sha) => {
					if (sha === B) remote.landing = F;
				},
			},
		);
		expect(r.actions).toEqual([
			{ kind: "test", sha: D },
			{ kind: "rerun", sha: D, files: FILES, why: "flake" },
			{ kind: "rerun", sha: A, files: FILES, why: "base" },
			{ kind: "bisect", base: A, sha: D },
			{ kind: "rerun", sha: B, files: FILES, why: "bisect" },
			{ kind: "test", sha: F },
			{ kind: "fast-forward", sha: F },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.reverted).toEqual([]);
	});

	it("bisects on past a tip pushed mid-bisect that does not descend from the batch", async () => {
		const remote = { main: A, landing: D };
		const r = await redBatch((sha) => sha === C || sha === D, {
			remote,
			onTest: (sha) => {
				if (sha === B) remote.landing = F;
			},
		});
		expect(r.tested).not.toContainEqual({ sha: F });
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
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
			history: [B, C, D, F],
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
			jobs: [],
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
		expect(second.actions.slice(0, 2)).toEqual([
			{ kind: "rerun", sha: A, files: FILES, why: "base" },
			{ kind: "bisect", base: A, sha: D },
		]);
		expect(second.tested).not.toContainEqual({ sha: D });
		expect(second.tickets).toEqual([
			{
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
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
			jobs: [],
			flake: { kind: "unknown", reason: "tester died" },
			onMain: null,
			range: null,
			bisect: {},
			confirm: {},
			parentOnFiles: null,
			jobsOnMain: null,
			revert: null,
			unfiled: null,
			pushedPast: null,
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

describe("runLander on a red only a CI job names (#3253)", () => {
	const job = "Full suite / Lint and types";
	/** Every whole-suite run at `red` shas fails `job` alone, naming no file. */
	const jobRed = (
		red: (sha: string, nth: number) => boolean,
		mainJobs: ((jobs: string[]) => JobsOnMain) | null = null,
	) =>
		run(
			{ main: A, landing: D },
			(sha, _files, nth) =>
				sha !== R && red(sha, nth)
					? { kind: "red", files: [], jobs: [job] }
					: { kind: "green" },
			{ history: [B, C, D], mainJobs },
		);

	it("names the job in the revert and the fix ticket, rerunning the whole suite and never the job", async () => {
		const r = await jobRed((sha) => sha === C || sha === D);
		expect(r.tickets).toEqual([
			{
				culprit: C,
				parent: B,
				revert: R,
				files: [],
				jobs: [job],
				stale: STALE,
			},
		]);
		expect(r.revertWhys).toEqual([
			`The lander found it red on the CI jobs '${job}', twice, with its parent bbbbbbbbb green.`,
		]);
		expect(r.tested.filter((t) => t.files)).toEqual(
			[D, B, C, C, B].map((sha) => ({ sha, files: [] })),
		);
	});

	it("runs no whole suite at a culprit's parent that is main, reverting where the job is green there (#3493)", async () => {
		const r = await jobRed(
			(sha) => sha !== A,
			() => ({ kind: "read", red: [] }),
		);
		expect(r.tested).not.toContainEqual({ sha: A, files: [] });
		expect(r.mainJobsRead).toEqual([[job]]);
		expect(r.reverted).toEqual([{ culprit: B, parent: A }]);
		expect(r.revertWhys).toEqual([
			`The lander found it red on the CI jobs '${job}', twice, with its parent aaaaaaaaa at \`main\`.`,
		]);
	});

	it("holds, never reverting, where the job is already red on main (#3526)", async () => {
		const r = await jobRed(
			(sha) => sha !== A,
			(jobs) => ({ kind: "read", red: jobs }),
		);
		expect(r.reverted).toEqual([]);
		expect(r.tickets).toEqual([]);
		expect(r.end).toEqual({
			kind: "hold",
			reason: `already red on \`main\`: the CI jobs '${job}'`,
			cause: "already-red",
		});
	});

	it("reverts where the job's state on main went unread, saying so (#3526)", async () => {
		const r = await jobRed(
			(sha) => sha !== A,
			() => ({ kind: "unread", reason: "gh down" }),
		);
		expect(r.reverted).toEqual([{ culprit: B, parent: A }]);
		expect(r.revertWhys).toEqual([
			`The lander found it red on the CI jobs '${job}', twice, with its parent aaaaaaaaa at \`main\`. Their state on \`main\` was unread: gh down.`,
		]);
	});

	it("reverts, saying the state on main was unread, where the tester reads no CI run", async () => {
		const r = await jobRed((sha) => sha !== A);
		expect(r.reverted).toEqual([{ culprit: B, parent: A }]);
		expect(r.revertWhys[0]).toContain(
			"Their state on `main` was unread: the tester reads no CI run.",
		);
	});

	it("names the culprit's own failing jobs, not the tip's", async () => {
		const docsJob = "Full suite / Document guards";
		const r = await run(
			{ main: A, landing: D },
			(sha) => {
				if (sha === D) return { kind: "red", files: [], jobs: [job, docsJob] };
				if (sha === C) return { kind: "red", files: [], jobs: [job] };
				return { kind: "green" };
			},
			{ history: [B, C, D] },
		);
		expect(r.tickets.map((t) => t.jobs)).toEqual([[job]]);
		expect(r.revertWhys[0]).not.toContain(docsJob);
	});

	it("names the job in the hold reason and the held-queue filing", async () => {
		const r = await jobRed((sha, nth) => sha === D || (sha === C && nth === 1));
		const reason = `culprit unconfirmed: ccccccccc passed the CI jobs '${job}' on its second run`;
		expect(r.end).toEqual({ kind: "hold", reason });
		expect(r.holds).toEqual([
			{ batch: D, reason, failing: { files: [], jobs: [job] } },
		]);
	});
});

describe("runLander where the culprit's parent reaches no verdict on the whole suite (#2910)", () => {
	const ceiling = "SUITE CEILING — killed at the 840s ceiling";
	const redVerdict: Verdict = { kind: "red", files: FILES };
	/** C is the culprit; B's whole suite hits the ceiling; B passes its
	 * first `bisectRuns` runs on the failing files, and `onFiles` is its
	 * verdict on them after. */
	const parentStuck =
		(onFiles: Verdict, bisectRuns = 1) =>
		(sha: string, files: string[] | undefined, nth: number): Verdict => {
			if (sha !== B)
				return sha === R || sha === A ? { kind: "green" } : redVerdict;
			if (files?.length === 0) return { kind: "unknown", reason: ceiling };
			return nth <= bisectRuns ? { kind: "green" } : onFiles;
		};

	it("confirms the parent on the failing files, reverts the culprit without landing the parent, and lands the revert", async () => {
		const r = await run(
			{ main: A, landing: D },
			parentStuck({ kind: "green" }),
			{
				history: [B, C, D],
			},
		);
		expect(r.actions).toEqual([
			{ kind: "test", sha: D },
			{ kind: "rerun", sha: D, files: FILES, why: "flake" },
			{ kind: "rerun", sha: A, files: FILES, why: "base" },
			{ kind: "bisect", base: A, sha: D },
			{ kind: "rerun", sha: B, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "bisect" },
			{ kind: "rerun", sha: C, files: FILES, why: "confirm" },
			{ kind: "rerun", sha: B, files: [], why: "parent" },
			{ kind: "rerun", sha: B, files: FILES, why: "parent-files" },
			{
				kind: "revert",
				culprit: C,
				parent: B,
				files: FILES,
				jobs: [],
				parentIsMain: false,
			},
			{
				kind: "file-fix-ticket",
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
			{ kind: "test", sha: R },
			{ kind: "fast-forward", sha: R },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.pushes.map((p) => p.sha)).toEqual([R]);
		expect(r.stuck).toEqual([B]);
	});

	it("lands neither the parent nor the revert where the parent fails a file outside the failing ones, reverting the parent as the next batch's culprit", async () => {
		const elsewhere: Verdict = { kind: "red", files: ["y.test.ts"] };
		let revertTests = 0;
		const r = await run(
			{ main: A, landing: D },
			(sha, files) => {
				if (sha === A) return { kind: "green" };
				if (sha === B && files?.length === 0)
					return { kind: "unknown", reason: ceiling };
				if (sha === R || files?.includes("y.test.ts")) return elsewhere;
				return sha === B ? { kind: "green" } : redVerdict;
			},
			{
				history: [B, C, D, R],
				/* The fake lands every revert as R, so the run stops before
				 * testing the second revert's tip. */
				onTest: (sha) => {
					if (sha === R && ++revertTests === 3) throw new Error("stop");
				},
			},
		);
		expect(r.actions.slice(11)).toEqual([
			{ kind: "test", sha: R },
			{ kind: "rerun", sha: R, files: elsewhere.files, why: "flake" },
			{ kind: "rerun", sha: A, files: elsewhere.files, why: "base" },
			{ kind: "bisect", base: A, sha: R },
			{ kind: "rerun", sha: C, files: elsewhere.files, why: "bisect" },
			{ kind: "rerun", sha: B, files: elsewhere.files, why: "bisect" },
			{ kind: "rerun", sha: B, files: elsewhere.files, why: "confirm" },
			{ kind: "rerun", sha: A, files: elsewhere.files, why: "parent-main" },
			{
				kind: "revert",
				culprit: B,
				parent: A,
				files: elsewhere.files,
				jobs: [],
				parentIsMain: true,
			},
			{
				kind: "file-fix-ticket",
				culprit: B,
				parent: A,
				revert: R,
				files: elsewhere.files,
				jobs: [],
				stale: STALE,
			},
			{ kind: "test", sha: R },
			{ kind: "exit", reason: "stopped on an error: stop" },
		]);
		expect(r.pushes).toEqual([]);
	});

	it.each([
		[
			"fails them",
			{ kind: "red", files: FILES } as Verdict,
			"culprit unconfirmed: ccccccccc's parent bbbbbbbbb fails x.test.ts",
		],
		[
			"reaches no verdict on them either",
			{ kind: "unknown", reason: "tester died" } as Verdict,
			"culprit unconfirmed: ccccccccc's parent bbbbbbbbb reached no verdict on the whole suite or on x.test.ts: tester died",
		],
	])(
		"holds, moving and reverting nothing, where the parent %s",
		async (_, files, reason) => {
			const r = await run({ main: A, landing: D }, parentStuck(files), {
				history: [B, C, D],
			});
			expect(r.end).toEqual({ kind: "hold", reason });
			expect(r.pushes).toEqual([]);
			expect(r.tickets).toEqual([]);
		},
	);

	it("runs a ledgered parent on its failing files, never its whole suite, when resuming a past run", async () => {
		const red: Red = {
			sha: D,
			base: A,
			files: FILES,
			jobs: [],
			flake: { kind: "red", files: FILES },
			onMain: { kind: "green" },
			range: [B, C, D],
			bisect: {
				[B]: { kind: "green" },
				[C]: { kind: "red", files: FILES },
				[D]: { kind: "red", files: FILES },
			},
			confirm: {
				[C]: { kind: "red", files: FILES },
				[B]: { kind: "unknown", reason: ceiling },
			},
			parentOnFiles: null,
			jobsOnMain: null,
			revert: null,
			unfiled: null,
			pushedPast: null,
		};
		const r = await run(
			{ main: A, landing: D },
			parentStuck({ kind: "green" }, 0),
			{
				history: [B, C, D],
				lastRed: red,
				stuck: [B],
			},
		);
		expect(r.actions[0]).toEqual({
			kind: "rerun",
			sha: B,
			files: FILES,
			why: "parent-files",
		});
		expect(r.tested).not.toContainEqual({ sha: B, files: [] });
		expect(r.pushes.map((p) => p.sha)).toEqual([R]);
	});

	it("says a stuck parent cleared on its files was green, not at main (#3533)", async () => {
		const r = await run(
			{ main: A, landing: D },
			parentStuck({ kind: "green" }),
			{ history: [B, C, D], stuck: [B] },
		);
		expect(r.tested).not.toContainEqual({ sha: B, files: [] });
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
		expect(r.revertWhys).toEqual([
			"The lander found it red on x.test.ts, twice, with its parent bbbbbbbbb green.",
		]);
	});

	it("never runs a ledgered parent's whole suite again after a hold and a push", async () => {
		const remote = { main: A, landing: D };
		const first = await run(remote, parentStuck(redVerdict), {
			history: [B, C, D, F],
		});
		expect(first.end).toMatchObject({ kind: "hold" });
		remote.landing = F;
		const second = await run(remote, parentStuck({ kind: "green" }), {
			history: [B, C, D, F],
			lastHold: first.beats.at(-1)?.hold ?? null,
			stuck: first.stuck,
		});
		expect(second.tested).not.toContainEqual({ sha: B, files: [] });
		expect(second.tickets).toEqual([
			{
				culprit: C,
				parent: B,
				revert: R,
				files: FILES,
				jobs: [],
				stale: STALE,
			},
		]);
	});
});

describe("runLander on a red batch whose files are red on main too (#3324)", () => {
	const X = "x.test.ts";
	const Y = "y.test.ts";
	/** Every batch test but R's fails X and Y; a named-file run at `sha`
	 * fails the files `redAt` gives it on its nth run there. */
	const scripted = (redAt: (sha: string, nth: number) => string[]) =>
		run(
			{ main: A, landing: D },
			(sha, files, nth) => {
				if (files === undefined)
					return sha === R ? { kind: "green" } : { kind: "red", files: [X, Y] };
				const failing = (files.length > 0 ? files : [X, Y]).filter((f) =>
					redAt(sha, nth).includes(f),
				);
				return failing.length > 0
					? { kind: "red", files: failing }
					: { kind: "green" };
			},
			{ history: [B, C, D] },
		);

	it("holds without a bisect where every failing file is red on main", async () => {
		const r = await scripted(() => [X, Y]);
		expect(r.actions).toEqual([
			{ kind: "test", sha: D },
			{ kind: "rerun", sha: D, files: [X, Y], why: "flake" },
			{ kind: "rerun", sha: A, files: [X, Y], why: "base" },
			{
				kind: "hold",
				reason: "already red on `main`: x.test.ts, y.test.ts",
				cause: "already-red",
			},
		]);
		expect(r.pushes).toEqual([]);
		expect(r.reverted).toEqual([]);
	});

	it("bisects only the files green on main, naming those red there in the hold", async () => {
		/* C fails Y on its first run alone; X is red on main and after it. */
		const r = await scripted((sha, nth) =>
			sha === D || (sha === C && nth === 1) ? [X, Y] : [X],
		);
		expect(r.actions.slice(2, 6)).toEqual([
			{ kind: "rerun", sha: A, files: [X, Y], why: "base" },
			{ kind: "bisect", base: A, sha: D },
			{ kind: "rerun", sha: B, files: [Y], why: "bisect" },
			{ kind: "rerun", sha: C, files: [Y], why: "bisect" },
		]);
		expect(r.end).toEqual({
			kind: "hold",
			reason:
				"culprit unconfirmed: ccccccccc passed y.test.ts on its second run; already red on `main`: x.test.ts",
		});
		expect(r.reverted).toEqual([]);
	});

	it("reverts past a parent red only on files red on main, never landing it", async () => {
		/* C breaks Y; X is red on main and after it. */
		const r = await scripted((sha) => (sha === A || sha === B ? [X] : [X, Y]));
		expect(r.tested).toContainEqual({ sha: B, files: [] });
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
		expect(r.pushes.map((p) => p.sha)).not.toContain(B);
	});

	it("names every file red on main once where the main confirm fails too", async () => {
		/* B breaks Y, which main then fails as well; X is red on main. */
		const r = await scripted((sha, nth) =>
			sha === A && nth === 1 ? [X] : [X, Y],
		);
		expect(r.actions.at(-2)).toEqual({
			kind: "rerun",
			sha: A,
			files: [Y],
			why: "parent-main",
		});
		expect(r.end).toEqual({
			kind: "hold",
			reason: "already red on `main`: x.test.ts, y.test.ts",
			cause: "already-red",
		});
	});

	it("runs no base check on a past run's red batch whose bisect had begun", async () => {
		const red = {
			sha: D,
			base: A,
			files: [X, Y],
			jobs: [],
			flake: { kind: "red", files: [X, Y] },
			range: [B, C, D],
			bisect: { [D]: { kind: "red", files: [X, Y] } },
			confirm: {},
			parentOnFiles: null,
			jobsOnMain: null,
			revert: null,
			unfiled: null,
		} as unknown as Red;
		const r = await run(
			{ main: A, landing: D },
			(sha) => (sha === R ? { kind: "green" } : { kind: "red", files: [X, Y] }),
			{ history: [B, C, D], lastRed: red },
		);
		expect(r.actions[0]).toEqual({
			kind: "rerun",
			sha: B,
			files: [X, Y],
			why: "bisect",
		});
		expect(r.actions).not.toContainEqual(
			expect.objectContaining({ why: "base" }),
		);
	});

	it("confirms a culprit whose parent is main on its failing files there, holding on red and never reverting", async () => {
		/* B breaks X; main passes X at the base check and fails it after. */
		const r = await scripted((sha, nth) => (sha === A && nth === 1 ? [] : [X]));
		expect(r.actions.slice(-2)).toEqual([
			{ kind: "rerun", sha: A, files: [X], why: "parent-main" },
			{
				kind: "hold",
				reason: "already red on `main`: x.test.ts",
				cause: "already-red",
			},
		]);
		expect(r.tested).not.toContainEqual({ sha: A, files: [] });
		expect(r.reverted).toEqual([]);
		expect(r.pushes).toEqual([]);
	});

	it("keeps the whole-suite confirm for a parent that is not main", async () => {
		/* C breaks Y. */
		const r = await scripted((sha) => (sha === C || sha === D ? [Y] : []));
		expect(r.actions).toContainEqual({
			kind: "rerun",
			sha: B,
			files: [],
			why: "parent",
		});
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
	});
});

describe("runLander where main takes only a sha a CI run passed (#3329)", () => {
	const ran: Verdict = { kind: "green", run: 9 };
	/**
	 * The batch A..D, D's own test red on x.test.ts and the revert R's green
	 * on a CI run: `flake` is D's rerun, and C, red on every rerun, is the
	 * culprit whose parent B's whole suite is `parent`.
	 */
	const gated = (flake: Verdict, parent: Verdict = ran) =>
		run(
			{ main: A, landing: D },
			(sha, files) => {
				const red: Verdict = { kind: "red", files: FILES };
				if (files === undefined) return sha === R ? ran : red;
				const reruns: Record<string, Verdict> = { [D]: flake, [C]: red };
				const whole = sha === B && files.length === 0;
				return whole ? parent : (reruns[sha] ?? green());
			},
			{ history: [B, C, D], requiresRun: true },
		);

	it("lands a tip whose flake rerun a CI run passed, asking the tester for a rerun that lands", async () => {
		const r = await gated(ran);
		expect(r.pushes.map((p) => p.sha)).toEqual([D]);
		expect(r.landing).toEqual([{ sha: D, files: FILES }]);
	});

	it("holds, pushing nothing, on a tip whose flake rerun passed off CI", async () => {
		const r = await gated(green());
		expect(r.end).toEqual({
			kind: "hold",
			reason:
				"ddddddddd passed x.test.ts on a rerun no CI run made, and main takes only a sha a CI run passed",
		});
		expect(r.pushes).toEqual([]);
	});

	it("reverts past a confirmed culprit's parent no CI run passed, landing the revert's tip alone", async () => {
		const r = await gated({ kind: "red", files: FILES }, green());
		expect(r.reverted).toEqual([{ culprit: C, parent: B }]);
		expect(r.tickets.map((t) => t.culprit)).toEqual([C]);
		expect(r.pushes.map((p) => p.sha)).toEqual([R]);
	});

	it("lands a confirmed culprit's parent a CI run passed before the revert", async () => {
		const r = await gated({ kind: "red", files: FILES });
		expect(r.pushes.map((p) => p.sha)).toEqual([B, R]);
	});

	it("exits on a batch's own green that names no CI run, pushing nothing", async () => {
		const r = await run({ main: A, landing: B }, green, { requiresRun: true });
		expect(r.end).toEqual({
			kind: "exit",
			reason: "no verdict at bbbbbbbbb: its green read no CI run",
		});
		expect(r.pushes).toEqual([]);
	});
});

describe("runLander resuming a past run's red batch where the remote moved (#2673)", () => {
	const pastRed = (): Red => ({
		sha: D,
		base: A,
		files: FILES,
		jobs: [],
		flake: { kind: "red", files: FILES },
		onMain: { kind: "green" },
		range: null,
		bisect: {},
		confirm: {},
		parentOnFiles: null,
		jobsOnMain: null,
		revert: null,
		unfiled: null,
		pushedPast: null,
	});

	it("resumes it on a landing pushed past it to a red tip, once that tip is tested (#3410)", async () => {
		const r = await run(
			{ main: A, landing: F },
			(sha, files) =>
				files === undefined || sha === C || sha === D
					? { kind: "red", files: FILES }
					: { kind: "green" },
			{ history: [B, C, D, F], lastRed: pastRed() },
		);
		expect(r.actions.slice(0, 2)).toEqual([
			{ kind: "test", sha: F },
			{ kind: "bisect", base: A, sha: D },
		]);
	});

	it("resumes its bisect where its range steps from its base", async () => {
		const r = await run(
			{ main: B, landing: F },
			(_, files) =>
				files === undefined ? { kind: "red", files: FILES } : green(),
			{
				history: [B, C, D, F],
				lastRed: { ...pastRed(), base: B, range: [C, D] },
			},
		);
		expect(r.actions[1]).toEqual({
			kind: "rerun",
			sha: C,
			files: FILES,
			why: "bisect",
		});
	});

	it("tests no pushed-past tip a past run already tested (#3410)", async () => {
		const r = await run({ main: A, landing: F }, green, {
			history: [B, C, D, F],
			lastRed: {
				...pastRed(),
				pushedPast: { sha: F, verdict: { kind: "red", files: FILES } },
			},
		});
		expect(r.tested).not.toContainEqual({ sha: F });
		expect(r.actions[0]).toEqual({ kind: "bisect", base: A, sha: D });
	});

	it("tests afresh where its range holds a commit main cannot fast-forward to (#2996)", async () => {
		const r = await run({ main: B, landing: F }, green, {
			history: [B, C, D, F],
			lastRed: { ...pastRed(), base: B, range: ["9".repeat(40), D] },
		});
		expect(r.actions[0]).toEqual({ kind: "test", sha: F });
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

describe("runLander where the culprit's whole-suite confirm reaches no verdict (#3410)", () => {
	const ceiling = "exited 1 naming no failing file in the tree";
	/** The #3399 heartbeat: C bisected as the culprit of D on the whole
	 * suite, its confirm not yet taken. */
	const bisected = (): Red => ({
		sha: D,
		base: A,
		files: [],
		jobs: ["Vitest (1/4)"],
		flake: { kind: "red", files: [] },
		onMain: null,
		range: [B, C, D],
		bisect: {
			[B]: { kind: "green" },
			[C]: { kind: "red", files: [] },
			[D]: { kind: "red", files: [] },
		},
		confirm: {},
		parentOnFiles: null,
		jobsOnMain: null,
		revert: null,
		unfiled: null,
		pushedPast: null,
	});
	/** C's whole suite stalls; F, a fix pushed past D, passes. */
	const stalls = (sha: string, files: string[] | undefined): Verdict => {
		if (sha === C && files?.length === 0)
			return { kind: "unknown", reason: ceiling };
		return sha === F || sha === B ? green() : { kind: "red", files: [] };
	};

	it("holds and ledgers the culprit, never running its whole suite again until landing moves, then lands the tip pushed past it", async () => {
		const remote = { main: A, landing: D };
		const history = [B, C, D, F];
		const first = await run(remote, stalls, { history, lastRed: bisected() });
		expect(first.end).toEqual({
			kind: "hold",
			reason: `culprit unconfirmed: ccccccccc's whole suite reached no verdict on its second run: ${ceiling}`,
		});
		expect(first.stuck).toEqual([C]);
		expect(first.pushes).toEqual([]);

		const second = await run(remote, stalls, {
			history,
			lastHold: first.beats.at(-1)?.hold ?? null,
			stuck: first.stuck,
		});
		expect(second.tested).toEqual([]);

		remote.landing = F;
		const third = await run(remote, stalls, {
			history,
			lastHold: second.beats.at(-1)?.hold ?? null,
			stuck: first.stuck,
		});
		expect(third.actions).toEqual([
			{ kind: "test", sha: F },
			{ kind: "fast-forward", sha: F },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(remote.main).toBe(F);
	});

	it("lands a green tip pushed past the #3399 heartbeat's red batch, never rerunning its culprit's confirm", async () => {
		const remote = { main: A, landing: F };
		const r = await run(remote, stalls, {
			history: [B, C, D, F],
			lastRed: bisected(),
		});
		expect(r.actions).toEqual([
			{ kind: "test", sha: F },
			{ kind: "fast-forward", sha: F },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(r.tested).not.toContainEqual({ sha: C, files: [] });
		expect(remote.main).toBe(F);
	});

	it("tests again a pushed-past tip a past run's test reached no verdict on", async () => {
		const remote = { main: A, landing: F };
		const r = await run(remote, stalls, {
			history: [B, C, D, F],
			lastRed: {
				...bisected(),
				pushedPast: { sha: F, verdict: { kind: "unknown", reason: ceiling } },
			},
		});
		expect(r.actions[0]).toEqual({ kind: "test", sha: F });
		expect(remote.main).toBe(F);
	});

	it("lands a pushed-past tip the ledger holds without testing it", async () => {
		const remote = { main: A, landing: F };
		const r = await run(remote, stalls, {
			history: [B, C, D, F],
			lastRed: bisected(),
			ledgered: [F],
		});
		expect(r.tested).toEqual([]);
		expect(remote.main).toBe(F);
	});

	it("tests no pushed-past tip once the batch's culprit is reverted, filing its fix ticket", async () => {
		const r = await run({ main: A, landing: F }, stalls, {
			history: [B, C, D, F],
			lastRed: {
				...bisected(),
				confirm: { [C]: { kind: "red", files: [] }, [B]: green() },
				revert: { sha: R, onto: D, stale: null },
			},
		});
		expect(r.actions.slice(0, 2)).toEqual([
			{ kind: "fast-forward", sha: B },
			expect.objectContaining({ kind: "file-fix-ticket", culprit: C }),
		]);
		expect(r.tickets.map((t) => t.culprit)).toEqual([C]);
	});

	it("ledgers a bisected commit whose whole suite reaches no verdict, then holds on it rather than running it again", async () => {
		const remote = { main: A, landing: D };
		const stallsAtB = (sha: string, files: string[] | undefined): Verdict =>
			sha === B && files?.length === 0
				? { kind: "unknown", reason: ceiling }
				: { kind: "red", files: [] };
		const fresh = {
			...bisected(),
			range: [B, C, D],
			bisect: { [D]: { kind: "red", files: [] } as Verdict },
		};
		const first = await run(remote, stallsAtB, {
			history: [B, C, D],
			lastRed: fresh,
		});
		expect(first.end).toMatchObject({ kind: "exit" });
		expect(first.stuck).toEqual([B]);
		const second = await run(remote, stallsAtB, {
			history: [B, C, D],
			lastRed: first.beats.at(-1)?.red ?? null,
			stuck: first.stuck,
		});
		expect(second.end).toEqual({
			kind: "hold",
			reason:
				"bisect unfinished: bbbbbbbbb's whole suite reached no verdict on a past run",
		});
		expect(second.tested).toEqual([]);
	});

	it("holds on a ledgered culprit a fresh bisect names, running no confirm", async () => {
		const r = await run({ main: A, landing: D }, stalls, {
			history: [B, C, D],
			lastRed: bisected(),
			stuck: [C],
		});
		expect(r.end).toEqual({
			kind: "hold",
			reason:
				"culprit unconfirmed: ccccccccc's whole suite reached no verdict on its second run",
		});
		expect(r.tested).toEqual([]);
	});

	it("exits, ledgering nothing, where a confirm on named files reaches no verdict", async () => {
		const r = await run(
			{ main: A, landing: D },
			(sha, files) =>
				sha === C && files?.length
					? { kind: "unknown", reason: "tester died" }
					: stalls(sha, files),
			{
				history: [B, C, D],
				lastRed: {
					...bisected(),
					files: FILES,
					bisect: { [B]: green(), [C]: { kind: "red", files: FILES } },
				},
			},
		);
		expect(r.end).toEqual({
			kind: "exit",
			reason: "no verdict at ccccccccc: tester died",
		});
		expect(r.stuck).toEqual([]);
	});
	/** As `stalls`, but F fails x.test.ts. */
	const redAtF = (sha: string, files: string[] | undefined): Verdict =>
		sha === F ? { kind: "red", files: FILES } : stalls(sha, files);
	const wholeSuiteRunsOfF = (tested: { sha: string; files?: string[] }[]) =>
		tested.filter((t) => t.sha === F && t.files === undefined);

	it("starts the batch after a held one from its red pushed-past tip's test, running that tip's whole suite once across the two (#3415)", async () => {
		const remote = { main: A, landing: F };
		const history = [B, C, D, F];
		const first = await run(remote, redAtF, { history, lastRed: bisected() });
		expect(first.end).toMatchObject({ kind: "hold" });
		const last = first.beats.at(-1);
		const second = await run(remote, redAtF, {
			history,
			lastHold: last?.hold ?? null,
			lastRed: last?.red ?? null,
			stuck: first.stuck,
		});
		expect(second.actions[0]).toEqual({
			kind: "rerun",
			sha: F,
			files: FILES,
			why: "flake",
		});
		expect(wholeSuiteRunsOfF([...first.tested, ...second.tested])).toEqual([
			{ sha: F },
		]);
	});

	it("starts the batch after one it landed from its red pushed-past tip's test (#3415)", async () => {
		const remote = { main: A, landing: F };
		const r = await run(
			remote,
			(sha, files) =>
				sha === F && files === undefined
					? { kind: "red", files: FILES }
					: green(),
			{
				history: [B, C, D, F],
				lastRed: { ...bisected(), files: FILES, flake: null, range: null },
			},
		);
		expect(r.actions).toEqual([
			{ kind: "test", sha: F },
			{ kind: "rerun", sha: D, files: FILES, why: "flake" },
			{ kind: "fast-forward", sha: D },
			{ kind: "rerun", sha: F, files: FILES, why: "flake" },
			{ kind: "fast-forward", sha: F },
			{ kind: "exit", reason: "landing equals main" },
		]);
		expect(wholeSuiteRunsOfF(r.tested)).toEqual([{ sha: F }]);
	});

	it("starts the batch after one held on a revert that did not land from its red pushed-past tip's test (#3415)", async () => {
		const r = await run({ main: B, landing: F }, redAtF, {
			history: [B, C, D, F],
			lastRed: {
				...bisected(),
				confirm: { [C]: { kind: "red", files: [] }, [B]: green() },
				revert: { failed: "error: could not revert ccccccc" },
				pushedPast: { sha: F, verdict: { kind: "red", files: FILES } },
			},
		});
		expect(r.end).toMatchObject({ kind: "hold" });
		expect(r.beats.at(-1)?.red).toMatchObject({ sha: F, base: B });
	});

	it("hands on no batch from a hold whose pushed-past tip's test was not red (#3415)", async () => {
		const r = await run(
			{ main: A, landing: F },
			(sha, files) =>
				sha === F ? { kind: "unknown", reason: ceiling } : stalls(sha, files),
			{ history: [B, C, D, F], lastRed: bisected() },
		);
		expect(r.end).toMatchObject({ kind: "hold" });
		expect(r.beats.at(-1)?.red).toBeUndefined();
	});
});
