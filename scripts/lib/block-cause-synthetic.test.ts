// @vitest-environment node
/*
 * The synthetic-stop reading (#5322): the shape table of a background job the
 * harness ended on its own "No response requested." record, read beside the
 * block-cause readings.
 *
 * A table over the pure reading, since the refill loop and check-ghost-jobs
 * both act on it. Loosen a case and the loop types into a session the founder
 * already answered, resumes one an API error or limit stopped, or acts on an
 * unread record; tighten one and a stopped session is left for good.
 */
import { describe, expect, it } from "vitest";
import { syntheticStopAt } from "./block-cause.js";
import {
	apiRequestRow,
	doneJob,
	founderRow,
	replyRow,
	STOP_AT,
	stoppedRows,
	syntheticRow,
	toolCallRow,
	toolResultRow,
} from "./synthetic-stop-fixture.js";

const at = Date.parse(STOP_AT);
const read = (job: unknown, rows: unknown) => syntheticStopAt({ job, rows });

describe("a job the harness ended on a synthetic reply", () => {
	it("reads the synthetic record's time where it is the last turn row", () => {
		expect(read(doneJob(), stoppedRows())).toBe(at);
	});

	it("reads it on a job the reaper has since stopped", () => {
		expect(read(doneJob({ state: "stopped" }), stoppedRows())).toBe(at);
	});

	it("reads it past rows that are no turn rows", () => {
		const rows = [
			...stoppedRows(),
			{ type: "attachment", attachment: { type: "output_style" } },
			{ type: "custom-title" },
		];
		expect(read(doneJob(), rows)).toBe(at);
	});
});

describe("no synthetic stop", () => {
	it("reads none where a user row follows it, the founder's prompt included", () => {
		expect(read(doneJob(), [...stoppedRows(), founderRow()])).toBeNull();
	});

	it("reads none where a later turn row follows it", () => {
		const rows = [...stoppedRows(), apiRequestRow("2026-11-17T02:48:00.000Z")];
		expect(read(doneJob(), rows)).toBeNull();
		const ended = [
			...stoppedRows(),
			{ type: "system", subtype: "turn_duration", timestamp: STOP_AT },
		];
		expect(read(doneJob(), ended)).toBeNull();
	});

	it("reads none where the synthetic record carries other text", () => {
		const rows = [
			toolCallRow(),
			toolResultRow(),
			syntheticRow(STOP_AT, "API Error: 529 overloaded"),
		];
		expect(read(doneJob(), rows)).toBeNull();
	});

	it("reads none where it is an API-error or a limit record", () => {
		const apiError = syntheticRow(STOP_AT, "No response requested.", {
			isApiErrorMessage: true,
		});
		expect(read(doneJob(), [toolCallRow(), apiError])).toBeNull();
		const limit = syntheticRow(STOP_AT, "You've hit your session limit");
		expect(read(doneJob(), [toolCallRow(), limit])).toBeNull();
	});

	it("reads none where the last assistant row a model wrote is a real reply", () => {
		expect(read(doneJob(), [toolResultRow(), replyRow("done")])).toBeNull();
	});

	it.each(["result: shipped", "needs input: Q1 above — waits on you: #1"])(
		"reads none where the last real reply before it governs with %s",
		(marker) => {
			const rows = [replyRow(`All done.\n\n${marker}`), syntheticRow()];
			expect(read(doneJob(), rows)).toBeNull();
		},
	);

	it("reads a stop where the last real reply carries only a waiting: marker", () => {
		const rows = [replyRow("waiting: the suite runs"), syntheticRow()];
		expect(read(doneJob(), rows)).toBe(at);
	});

	it.each(["working", "blocked"])("reads none on a %s job", (state) => {
		expect(read(doneJob({ state }), stoppedRows())).toBeNull();
	});
});

describe("unread, on which nothing acts", () => {
	it("reads unread on an unread job record or one with no state", () => {
		expect(read(null, stoppedRows())).toBe("unread");
		expect(read({ detail: "done" }, stoppedRows())).toBe("unread");
	});

	it("reads unread on an unread transcript", () => {
		expect(read(doneJob(), null)).toBe("unread");
	});

	it("reads unread on malformed rows", () => {
		expect(read(doneJob(), [...stoppedRows(), 7])).toBe("unread");
		expect(read(doneJob(), [{ type: "custom-title" }])).toBe("unread");
	});

	it("reads unread on a synthetic record with no readable time", () => {
		expect(read(doneJob(), [toolCallRow(), syntheticRow("never")])).toBe(
			"unread",
		);
	});
});
