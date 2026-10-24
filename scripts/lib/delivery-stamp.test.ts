// @vitest-environment node
/*
 * The once-only delivery stamp, shared by every `--notify` checker that carries
 * one (mantahostels#1975, mantahostels#2244). Everything here runs in-process
 * against a sandboxed report directory; the two producer halves take a ctx
 * narrowed to the two flags they read.
 *
 * Those checkers report at session start or under `npm run status`, so a loosened case either reprints
 * a standing fault into every session or buries a finding nobody was shown.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { freshSandbox } from "./arbiter-testkit";

const req = createRequire(__filename);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const stamp: any = req("./delivery-stamp.js");
// biome-ignore lint/suspicious/noExplicitAny: as above
const notify: any = req("./notify-report.js");

freshSandbox();

const HAND = { notify: false, persisting: false };
const NOTIFY = { notify: true, persisting: false };
const PERSIST = { notify: true, persisting: true };

const CHECKER = "example";

describe("the store", () => {
	it("reads back what it recorded, at <checker>.notified", () => {
		expect(stamp.readStamp(CHECKER)).toBeNull();
		expect(stamp.recordDelivery(CHECKER, "sig-1")).toBe(true);

		expect(stamp.readStamp(CHECKER)).toBe("sig-1");
	});

	it("forgets a delivery, so the same report is said again", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.clearDelivery(CHECKER)).toBe(true);

		expect(stamp.readStamp(CHECKER)).toBeNull();
		expect(stamp.delivered(CHECKER, "sig-1")).toBe(false);
	});

	/* UNGATED, where markDelivered is not: a producer clearing on a run that was
	 * not the delivery costs a repeated notice, and one that fails to clear
	 * silences the same finding's return for good (mantahostels#2244). Asserted against both
	 * halves of markDelivered's gate, since the clear takes no ctx at all. */
	it("forgets a delivery on a hand run and under persist mode alike", () => {
		for (const ctx of [HAND, PERSIST]) {
			stamp.recordDelivery(CHECKER, "sig-1");
			stamp.markDelivered(ctx, CHECKER, "sig-2");
			// The write really was gated — or the clear below proves nothing.
			expect(stamp.readStamp(CHECKER)).toBe("sig-1");

			stamp.clearDelivery(CHECKER);

			expect(stamp.readStamp(CHECKER)).toBeNull();
		}
	});

	it("says nothing was there rather than throwing on an absent stamp", () => {
		expect(stamp.clearDelivery(CHECKER)).toBe(true);
		expect(stamp.readStamp(CHECKER)).toBeNull();
	});

	it("sits beside the persisted reports", () => {
		expect(stamp.stampFile(CHECKER)).toBe(
			path.join(notify.base(), `${CHECKER}.notified`),
		);
	});

	/* Never a throw: an unwritable stamp is a repeated notice. */
	it("degrades to a no-op where the stamp cannot be written", () => {
		fs.mkdirSync(stamp.stampFile(CHECKER), { recursive: true });

		expect(stamp.recordDelivery(CHECKER, "sig-1")).toBe(false);
		expect(stamp.readStamp(CHECKER)).toBeNull();
	});
});

describe("delivered() — the delivery half's read", () => {
	it("compares by identity, the ordinary case", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.delivered(CHECKER, "sig-1")).toBe(true);
		expect(stamp.delivered(CHECKER, "sig-2")).toBe(false);
	});

	/* ci-status's comparison: the stamp is the newest failing run id, so an
	 * OLDER id counts as delivered and a newer one does not. */
	it("reads a high-water signature as an order, not an identity", () => {
		stamp.recordDelivery(CHECKER, stamp.highWater(200));

		expect(stamp.delivered(CHECKER, stamp.highWater(199))).toBe(true);
		expect(stamp.delivered(CHECKER, stamp.highWater(200))).toBe(true);
		expect(stamp.delivered(CHECKER, stamp.highWater(201))).toBe(false);
	});

	/* An unprefixed stamp sliced as if it carried `max:` would read "12345"
	 * as 5, and suppress run 3. */
	it("compares a stamp without the high-water prefix by identity", () => {
		stamp.recordDelivery(CHECKER, "12345");

		expect(stamp.delivered(CHECKER, stamp.highWater(3))).toBe(false);
	});

	/* Rather than guessing an order it cannot read. */
	it("falls back to identity where a high-water pair is not numeric", () => {
		stamp.recordDelivery(CHECKER, stamp.highWater("x"));

		expect(stamp.delivered(CHECKER, stamp.highWater("x"))).toBe(true);
		expect(stamp.delivered(CHECKER, stamp.highWater("y"))).toBe(false);
	});

	it("is false where nothing was ever delivered", () => {
		expect(stamp.delivered(CHECKER, "sig-1")).toBe(false);
	});
});

describe("seenStamp() — what a producer may judge against", () => {
	it("is the recorded stamp under --notify", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.seenStamp(NOTIFY, CHECKER)).toBe("sig-1");
	});

	it("is null on a hand run, so it answers in full", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.seenStamp(HAND, CHECKER)).toBeNull();
	});

	/* Under persist mode the producer's stdout is not the delivery, so a stamp
	 * it reads could suppress a report no reader ever showed. */
	it("is null under persist mode, however stamped", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.seenStamp(PERSIST, CHECKER)).toBeNull();
	});
});

describe("alreadyDelivered() — whether a producer stays silent", () => {
	it("suppresses a repeat under --notify", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.alreadyDelivered(NOTIFY, CHECKER, "sig-1")).toBe(true);
		expect(stamp.alreadyDelivered(NOTIFY, CHECKER, "sig-2")).toBe(false);
	});

	it("suppresses nothing on a hand run or under persist mode", () => {
		stamp.recordDelivery(CHECKER, "sig-1");

		expect(stamp.alreadyDelivered(HAND, CHECKER, "sig-1")).toBe(false);
		expect(stamp.alreadyDelivered(PERSIST, CHECKER, "sig-1")).toBe(false);
	});

	it("applies the same high-water rule the delivery half does", () => {
		stamp.recordDelivery(CHECKER, stamp.highWater(200));

		expect(stamp.alreadyDelivered(NOTIFY, CHECKER, stamp.highWater(199))).toBe(
			true,
		);
		expect(stamp.alreadyDelivered(NOTIFY, CHECKER, stamp.highWater(201))).toBe(
			false,
		);
	});
});

describe("markDelivered() — a producer's own stamping", () => {
	it("stamps under --notify, this run being the delivery", () => {
		stamp.markDelivered(NOTIFY, CHECKER, "sig-1");

		expect(stamp.readStamp(CHECKER)).toBe("sig-1");
	});

	/* The reader stamps instead, once it has actually shown the report
	 * (mantahostels#1949's story 14). */
	it("stamps nothing under persist mode", () => {
		stamp.markDelivered(PERSIST, CHECKER, "sig-1");

		expect(stamp.readStamp(CHECKER)).toBeNull();
	});

	it("stamps nothing on a hand run", () => {
		stamp.markDelivered(HAND, CHECKER, "sig-1");

		expect(stamp.readStamp(CHECKER)).toBeNull();
	});
});
