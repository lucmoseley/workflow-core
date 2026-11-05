// @vitest-environment node
/*
 * lib/queue-ref-status.js: each of a session's queue ref stays read as
 * queued, testing, landed or dropped off the remote, the queue log, the
 * batch record, the drop record and the green ledger (#4485, spec #4458).
 *
 * Loosen it and a session reads a ref that moved past its snapshot as under
 * test, a landed ref without the `main` sha it reached, a dropped ref
 * without its fix ticket or dropped ref, or a state guessed off a record
 * that is missing or torn.
 */
import { describe, expect, it } from "vitest";
import { buildQueueRefLine, queueRefStates } from "./queue-ref-status.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const M = "e".repeat(40);
const REF = "refs/heads/queue/alpha";

interface Row {
	at: number;
	event: string;
	ref: string;
	sha: string;
}
const row = (at: number, event: string, sha: string, ref = REF): Row => ({
	at,
	event,
	ref,
	sha,
});

const batch = (over: Record<string, unknown> = {}) => ({
	kind: "read",
	value: {
		members: [{ name: "alpha", sha: A, pushedAt: 1 }],
		deferred: [],
		dropped: [],
		onto: M,
		integration: null,
		phase: "merging",
		...over,
	},
});

const reading = (over: Record<string, unknown> = {}) => ({
	name: "alpha",
	waiting: { sha: A },
	rows: [] as Row[],
	batch: { kind: "absent" },
	drops: { kind: "absent" },
	dropped: [],
	mainReached: () => null,
	...over,
});

const lines = (over: Record<string, unknown> = {}) =>
	// biome-ignore lint/suspicious/noExplicitAny: the reading's shape is the module's
	queueRefStates(reading(over) as any).map(buildQueueRefLine);

describe("a waiting ref", () => {
	it("reads as queued where no batch is live", () => {
		expect(lines({ rows: [row(1, "enqueue", A)] })).toEqual([
			"queued: queue/alpha at aaaaaaaaa — waiting for the lander's next batch",
		]);
	});

	it("reads as testing in the live batch at its snapshot sha", () => {
		expect(
			lines({
				rows: [row(1, "enqueue", A), row(2, "take", A)],
				batch: batch({ phase: "testing", integration: M }),
			}),
		).toEqual([
			"testing: queue/alpha at aaaaaaaaa — in the lander's batch under test",
		]);
	});

	it("reads as queued where it moved after its snapshot, naming the snapshot", () => {
		expect(
			lines({
				waiting: { sha: B },
				rows: [row(1, "enqueue", A), row(2, "take", A), row(3, "enqueue", B)],
				batch: batch({ phase: "testing", integration: M }),
			}),
		).toEqual([
			"queued: queue/alpha at bbbbbbbbb — moved past its snapshot aaaaaaaaa in the batch under test, so it waits for the next batch",
		]);
	});

	it("reads as queued where the batch left it out", () => {
		expect(
			lines({ batch: batch({ deferred: ["alpha"], phase: "testing" }) }),
		).toEqual([
			"queued: queue/alpha at aaaaaaaaa — waiting for the lander's next batch",
		]);
	});

	it("says so where the batch record is torn, claiming neither state", () => {
		expect(lines({ batch: { kind: "torn" } })).toEqual([
			"queued or testing: queue/alpha at aaaaaaaaa — the batch record is torn, so whether the batch under test holds it is unknown",
		]);
	});

	it("says so where the log has it taken but no batch record exists", () => {
		expect(lines({ rows: [row(1, "enqueue", A), row(2, "take", A)] })).toEqual([
			"queued or testing: queue/alpha at aaaaaaaaa — the queue log has it taken, but there is no batch record to say whether the batch under test holds it",
		]);
	});
});

describe("a landed ref", () => {
	it("names the main sha off the batch record", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(1, "take", A), row(2, "land", A)],
				batch: batch({ phase: "landed", integration: M }),
			}),
		).toEqual(["landed: queue/alpha at aaaaaaaaa — on main at eeeeeeeee"]);
	});

	it("names the main sha off the green ledger once the batch record moved on", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "land", A)],
				batch: batch({ members: [{ name: "beta", sha: B, pushedAt: 3 }] }),
				mainReached: (sha: string) => (sha === A ? M : null),
			}),
		).toEqual(["landed: queue/alpha at aaaaaaaaa — on main at eeeeeeeee"]);
	});

	it("says so where neither record names the main sha", () => {
		expect(lines({ waiting: null, rows: [row(2, "land", A)] })).toEqual([
			"landed: queue/alpha at aaaaaaaaa — on main, but neither the batch record nor the green ledger names the main sha it reached",
		]);
	});

	it("reads a ref still at its landed sha as landed, and a later push as queued", () => {
		expect(
			lines({ rows: [row(1, "enqueue", A), row(2, "land", A)] }),
		).toHaveLength(1);
		expect(
			lines({
				waiting: { sha: B },
				rows: [row(2, "land", A), row(3, "enqueue", B)],
				mainReached: () => M,
			}),
		).toEqual([
			"landed: queue/alpha at aaaaaaaaa — on main at eeeeeeeee",
			"queued: queue/alpha at bbbbbbbbb — waiting for the lander's next batch",
		]);
	});

	it("reads another ref's rows as none of its own", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "land", A, "refs/heads/queue/beta")],
			}),
		).toEqual([]);
	});
});

describe("a dropped ref", () => {
	const drop = (over: Record<string, unknown> = {}) => ({
		name: "alpha",
		sha: A,
		ref: "dropped/alpha",
		onto: M,
		cause: { kind: "conflict", name: "alpha", files: ["x"] },
		ticket: 77,
		...over,
	});

	it("names its fix ticket and dropped ref off the drop record", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", A)],
				drops: { kind: "read", value: [drop()] },
			}),
		).toEqual([
			"dropped: queue/alpha at aaaaaaaaa — kept as dropped/alpha, fix ticket #77",
		]);
	});

	it("says a fix ticket not yet filed, from a drop the log missed", () => {
		expect(
			lines({
				waiting: null,
				drops: {
					kind: "read",
					value: [drop({ ref: "dropped/alpha-aaaaaaaaa", ticket: null })],
				},
			}),
		).toEqual([
			"dropped: queue/alpha at aaaaaaaaa — kept as dropped/alpha-aaaaaaaaa, its fix ticket not yet filed",
		]);
	});

	it("names the dropped ref off the remote where the drop record holds no entry", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", A)],
				drops: { kind: "read", value: [] },
				dropped: [{ ref: "dropped/alpha-aaaaaaaaa", sha: A }],
			}),
		).toEqual([
			"dropped: queue/alpha at aaaaaaaaa — kept as dropped/alpha-aaaaaaaaa; the drop record holds no entry for it, so its fix ticket is unknown",
		]);
	});

	it("says so where the drop record is torn", () => {
		expect(
			lines({
				waiting: null,
				rows: [row(2, "drop", A)],
				drops: { kind: "torn" },
			}),
		).toEqual([
			"dropped: queue/alpha at aaaaaaaaa — no dropped ref holds it; the drop record is torn, so its fix ticket is unknown",
		]);
	});
});
