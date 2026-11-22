// @vitest-environment node

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
