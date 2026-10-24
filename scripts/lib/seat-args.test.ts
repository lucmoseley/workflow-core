// @vitest-environment node
/*
 * lib/seat-args.js reads the seats lib/cli-args.js gathered, else every known
 * one (#380, #1391). Which argv spellings reach the list is cli-args's
 * contract, pinned at the scripts that call this.
 */

import { describe, expect, it } from "vitest";
import { configDirs } from "./arbiter-store.js";
import { seatsFrom } from "./seat-args.js";

describe("seatsFrom", () => {
	it("keeps every seat given, in order", () => {
		expect(seatsFrom(["/a", "/b"])).toEqual(["/a", "/b"]);
	});

	it("reads every known seat where none is given", () => {
		expect(seatsFrom(undefined)).toEqual(configDirs());
		expect(seatsFrom([])).toEqual(configDirs());
	});

	it("drops an empty seat rather than reading a seat at the empty path", () => {
		expect(seatsFrom([""])).toEqual(configDirs());
		expect(seatsFrom(["", "/a"])).toEqual(["/a"]);
	});
});
