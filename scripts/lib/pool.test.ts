// @vitest-environment node

import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { pool } = createRequire(__filename)("./pool.js");

it("runs at most width jobs at once and keeps the items' order", async () => {
	let live = 0;
	let peak = 0;
	const out = await pool([30, 5, 20, 1, 10], 2, async (ms: number) => {
		live++;
		peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, ms));
		live--;
		return ms * 2;
	});
	expect(out).toEqual([60, 10, 40, 2, 20]);
	expect(peak).toBe(2);
});

it("answers an empty list with an empty list", async () => {
	expect(await pool([], 4, async () => 1)).toEqual([]);
});
