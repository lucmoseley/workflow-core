// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { LOOP_NOTICE_PREFIX, isLoopNotice } = require("./refill-notice.js");

describe("isLoopNotice", () => {
	it("reads a plain or bold loop notice, and nothing else", () => {
		expect(isLoopNotice(`${LOOP_NOTICE_PREFIX}stopped QUESTION park.`)).toBe(
			true,
		);
		expect(isLoopNotice(`**${LOOP_NOTICE_PREFIX}handed off.** Session x`)).toBe(
			true,
		);
		expect(isLoopNotice("B, go. Refill loop: noted")).toBe(false);
		expect(isLoopNotice(undefined)).toBe(false);
	});

	it("is the one spelling of the prefix across the scripts", () => {
		const roots = [__dirname, path.dirname(__dirname)];
		const spelt = roots.flatMap((dir) =>
			fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".js") && f !== "refill-notice.js")
				.filter((f) =>
					fs
						.readFileSync(path.join(dir, f), "utf8")
						.includes(LOOP_NOTICE_PREFIX),
				),
		);
		expect(spelt).toEqual([]);
	});
});
