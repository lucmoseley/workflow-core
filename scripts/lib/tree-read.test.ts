// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { readTreeText } = createRequire(__filename)(
	"./tree-read.js",
) as typeof import("./tree-read.js");

const tree = (readText: (rel: string) => string | null) => ({ readText });

describe("readTreeText", () => {
	it("answers read, absent or unreadable off the tree port", () => {
		expect(
			readTreeText(
				tree(() => "x"),
				"a",
			),
		).toEqual({
			state: "read",
			data: "x",
		});
		expect(
			readTreeText(
				tree(() => null),
				"a",
			),
		).toEqual({ state: "absent" });
		const got = readTreeText(
			tree(() => {
				throw new Error("EISDIR");
			}),
			"a",
		);
		expect(got.state).toBe("unreadable");
	});
});
