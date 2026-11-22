// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	alreadyDelivered,
	clearDelivery,
	delivered,
	highWater,
	markDelivered,
	readSeenStamp,
	readStamp,
	recordDelivery,
	stampFile,
} from "./delivery-stamp.js";
import { base } from "./notify-report.js";

freshSandbox();

const HAND = { notify: false, persisting: false };
const NOTIFY = { notify: true, persisting: false };
const PERSIST = { notify: true, persisting: true };

const CHECKER = "example";

describe("the store", () => {
	it("reads back what it recorded, at <checker>.notified", () => {
		expect(readStamp(CHECKER)).toBeNull();
		expect(recordDelivery(CHECKER, "sig-1")).toBe(true);

		expect(readStamp(CHECKER)).toBe("sig-1");
	});

	it("forgets a delivery, so the same report is said again", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(clearDelivery(CHECKER)).toBe(true);

		expect(readStamp(CHECKER)).toBeNull();
		expect(delivered(CHECKER, "sig-1")).toBe(false);
	});

	it("forgets a delivery on a hand run and under persist mode alike", () => {
		for (const ctx of [HAND, PERSIST]) {
			recordDelivery(CHECKER, "sig-1");
			markDelivered(ctx, CHECKER, "sig-2");
			expect(readStamp(CHECKER)).toBe("sig-1");

			clearDelivery(CHECKER);

			expect(readStamp(CHECKER)).toBeNull();
		}
	});

	it("says nothing was there rather than throwing on an absent stamp", () => {
		expect(clearDelivery(CHECKER)).toBe(true);
		expect(readStamp(CHECKER)).toBeNull();
	});

	it("sits beside the persisted reports", () => {
		expect(stampFile(CHECKER)).toBe(path.join(base(), `${CHECKER}.notified`));
	});

	it("degrades to a no-op where the stamp cannot be written", () => {
		fs.mkdirSync(stampFile(CHECKER), { recursive: true });

		expect(recordDelivery(CHECKER, "sig-1")).toBe(false);
		expect(readStamp(CHECKER)).toBeNull();
	});
});

describe("delivered() — the delivery half's read", () => {
	it("compares by identity, the ordinary case", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(delivered(CHECKER, "sig-1")).toBe(true);
		expect(delivered(CHECKER, "sig-2")).toBe(false);
	});

	it("reads a high-water signature as an order, not an identity", () => {
		recordDelivery(CHECKER, highWater(200));

		expect(delivered(CHECKER, highWater(199))).toBe(true);
		expect(delivered(CHECKER, highWater(200))).toBe(true);
		expect(delivered(CHECKER, highWater(201))).toBe(false);
	});

	it("compares a stamp without the high-water prefix by identity", () => {
		recordDelivery(CHECKER, "12345");

		expect(delivered(CHECKER, highWater(3))).toBe(false);
	});

	it("falls back to identity where a high-water pair is not numeric", () => {
		recordDelivery(CHECKER, highWater("x"));

		expect(delivered(CHECKER, highWater("x"))).toBe(true);
		expect(delivered(CHECKER, highWater("y"))).toBe(false);
	});

	it("is false where nothing was ever delivered", () => {
		expect(delivered(CHECKER, "sig-1")).toBe(false);
	});
});

describe("readSeenStamp() — what a producer may judge against", () => {
	it("is the recorded stamp under --notify", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(readSeenStamp(NOTIFY, CHECKER)).toBe("sig-1");
	});

	it("is null on a hand run, so it answers in full", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(readSeenStamp(HAND, CHECKER)).toBeNull();
	});

	it("is null under persist mode, however stamped", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(readSeenStamp(PERSIST, CHECKER)).toBeNull();
	});
});

describe("alreadyDelivered() — whether a producer stays silent", () => {
	it("suppresses a repeat under --notify", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(alreadyDelivered(NOTIFY, CHECKER, "sig-1")).toBe(true);
		expect(alreadyDelivered(NOTIFY, CHECKER, "sig-2")).toBe(false);
	});

	it("suppresses nothing on a hand run or under persist mode", () => {
		recordDelivery(CHECKER, "sig-1");

		expect(alreadyDelivered(HAND, CHECKER, "sig-1")).toBe(false);
		expect(alreadyDelivered(PERSIST, CHECKER, "sig-1")).toBe(false);
	});

	it("applies the same high-water rule the delivery half does", () => {
		recordDelivery(CHECKER, highWater(200));

		expect(alreadyDelivered(NOTIFY, CHECKER, highWater(199))).toBe(true);
		expect(alreadyDelivered(NOTIFY, CHECKER, highWater(201))).toBe(false);
	});
});

describe("markDelivered() — a producer's own stamping", () => {
	it("stamps under --notify, this run being the delivery", () => {
		markDelivered(NOTIFY, CHECKER, "sig-1");

		expect(readStamp(CHECKER)).toBe("sig-1");
	});

	it("stamps nothing under persist mode", () => {
		markDelivered(PERSIST, CHECKER, "sig-1");

		expect(readStamp(CHECKER)).toBeNull();
	});

	it("stamps nothing on a hand run", () => {
		markDelivered(HAND, CHECKER, "sig-1");

		expect(readStamp(CHECKER)).toBeNull();
	});
});
