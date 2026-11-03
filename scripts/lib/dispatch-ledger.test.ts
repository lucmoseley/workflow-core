// @vitest-environment node
/*
 * Pins readOverflowLookup, the one reader of what marks a session overflow
 * (#3694), on rows a dispatcher run never writes; the rows it does write are
 * dispatch-sessions-overflow.test.ts's. Loosen it and an overflow session reads
 * as a plan one, its credits counted as plan allowance and its cap never hit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ledgerPath,
	readOverflowLookup,
	record,
	release,
} from "./dispatch-ledger.js";

const JOB = "abcd1234";
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ledger-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const launch = {
	issues: [341],
	model: "opus",
	prompt: "/implement 341",
};
const recordOverflow = (
	jobId: string | null,
	sessionId: string | null = null,
	launchedAt?: number,
) =>
	record({
		...launch,
		root,
		jobId,
		...(launchedAt === undefined ? {} : { launchedAt }),
		overflow: { keyVar: "K2", allowanceUsd: 40, sessionId },
	});
const readLookup = () => readOverflowLookup([root]);

describe("readOverflowLookup", () => {
	it("still marks a session after its launch is released and past the window", () => {
		recordOverflow(JOB, null, Date.now() - 30 * 24 * 3600 * 1000);
		release({ root, jobId: JOB });
		expect(readLookup()({ jobId: JOB })?.allowanceUsd).toBe(40);
	});

	it("is not shadowed by a later plain row on the same job, as a limit hold writes", () => {
		recordOverflow(JOB);
		record({
			...launch,
			root,
			jobId: JOB,
			heldUntil: Date.now() + 3600 * 1000,
		});
		expect(readLookup()({ jobId: JOB })?.keyVar).toBe("K2");
	});

	it("joins a session id to a row with none yet by its job id, the id's first 8 digits", () => {
		recordOverflow(JOB);
		const sessionId = `${JOB}-409b-405c-ae27-ad5c936dda2c`;
		expect(readLookup()({ sessionId })?.keyVar).toBe("K2");
		expect(
			readLookup()({ sessionId: "feedface-409b-405c-ae27-ad5c936dda2c" }),
		).toBeNull();
	});

	it("reads every root it is given", () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ledger-"));
		try {
			record({
				...launch,
				root: other,
				jobId: JOB,
				overflow: { keyVar: "K3", allowanceUsd: 5, sessionId: null },
			});
			expect(readOverflowLookup([root, other])({ jobId: JOB })?.keyVar).toBe(
				"K3",
			);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	it("matches no row on an unknown id, a null one included", () => {
		recordOverflow(null);
		expect(readLookup()({ jobId: null, sessionId: null })).toBeNull();
		expect(readLookup()({ jobId: "feedface" })).toBeNull();
	});

	it("throws on a ledger that will not read, so an unread session never passes for a plan one", () => {
		fs.mkdirSync(ledgerPath(root), { recursive: true });
		expect(() => readLookup()).toThrow(/would not read/);
	});
});
