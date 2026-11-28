// @vitest-environment node

import { describe, expect, it } from "vitest";
import { programLibs } from "./program-libs.js";

const dirOf = (files: Record<string, string>) => ({
	read: (rel: string) => files[rel] ?? "",
	exists: (rel: string) => rel in files,
});

describe("programLibs", () => {
	it("follows lib-to-lib requires and skips a commented one or a non-lib path", () => {
		const dir = dirOf({
			"p.js": `require("./lib/a");\n// require("./lib/c");\nrequire("./other.js");`,
			"other.js": `require("./lib/c");`,
			"lib/a.js": `require("./b");\nrequire("../other.js");`,
			"lib/b.js": `require("./a.js");`,
			"lib/c.js": "",
		});
		expect(programLibs("p.js", dir)).toEqual(["a.js", "b.js"]);
	});

	it("adds the data file a lib reads by path", () => {
		const dir = dirOf({
			"p.js": `require("./lib/model-table.js");`,
			"lib/model-table.js": "",
		});
		expect(programLibs("p.js", dir)).toEqual([
			"model-table.js",
			"model-routing.json",
		]);
	});
});
