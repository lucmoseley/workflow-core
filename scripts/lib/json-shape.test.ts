// @vitest-environment node
/*
 * lib/json-shape.js's contract (#4796): each helper narrows an untrusted
 * parsed value to what it claims, and gives null or none for anything else.
 */

import { describe, expect, it } from "vitest";
import { asObject, objectsIn, stringMembers } from "./json-shape.js";

describe("asObject", () => {
	it("keeps a plain object and refuses null, an array and a scalar", () => {
		expect(asObject({ a: 1 })).toEqual({ a: 1 });
		for (const v of [null, [1], "x", 3, undefined])
			expect(asObject(v)).toBeNull();
	});
});

describe("objectsIn", () => {
	it("keeps an array's object members only", () => {
		expect(objectsIn([{ a: 1 }, null, [2], "x", { b: 2 }])).toEqual([
			{ a: 1 },
			{ b: 2 },
		]);
	});

	it("gives none for a value that is no array", () => {
		expect(objectsIn({ a: 1 })).toEqual([]);
	});
});

describe("stringMembers", () => {
	it("keeps an array's string members, empty ones included", () => {
		expect(stringMembers(["a", 1, "", null])).toEqual(["a", ""]);
	});

	it("gives none for a string or an object, never their contents", () => {
		expect(stringMembers("a")).toEqual([]);
		expect(stringMembers({ k: "a" })).toEqual([]);
	});
});
