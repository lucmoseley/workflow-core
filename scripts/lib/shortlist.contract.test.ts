// @vitest-environment node
/*
 * Holds lib/shortlist-fake.ts, the shortlist the refill loop's run tests stub,
 * to what the real pick-next.js prints under `--json`, run in process against
 * lib/pick-next-testkit.ts's stub gh (#4358). Breaking it lets a key
 * pick-next renames or drops pass the run tests while the loop reads it
 * missing live.
 */
import { describe, expect, it } from "vitest";
import { installPickNextHarness, run } from "./pick-next-testkit";
import { buildShortlist, buildShortlistRow } from "./shortlist-fake";

const { parseShortlist } = require("./shortlist-parse.js");

installPickNextHarness();

/** A value's JSON kind, null kept apart from object. */
const kindOf = (v: unknown) => {
	if (v === null) return "null";
	return Array.isArray(v) ? "array" : typeof v;
};

const kinds = (o: Record<string, unknown>, keys: string[]) =>
	Object.fromEntries(keys.map((k) => [k, kindOf(o[k])]));

describe("the shortlist fake against pick-next.js --json (#4358)", () => {
	it("carries only keys the real shortlist and its row print, of the same kind", async () => {
		const r = await run(
			{ issues: [{ number: 5, labels: ["takes:implement"] }] },
			["--json"],
		);
		const real = r.json();
		const fake: Record<string, unknown> = buildShortlist();
		const shortlistKeys = Object.keys(fake).filter((k) => fake[k] !== null);
		expect(kinds(real, shortlistKeys)).toEqual(kinds(fake, shortlistKeys));
		for (const k of Object.keys(fake)) expect(real).toHaveProperty(k);
		const row = buildShortlistRow();
		expect(kinds(real.frontier[0], Object.keys(row))).toEqual(
			kinds(row, Object.keys(row)),
		);
		expect(parseShortlist(JSON.stringify(real))).not.toHaveProperty("error");
	});
});
