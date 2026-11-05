// @vitest-environment node
/*
 * Tests for scripts/lib/regenerated-files.js, the list of files a lander
 * revert regenerates (#4452), and clean-revert.js's render of one.
 *
 * Loosen them and a file that records a read someone made is regenerated,
 * writing a read nobody made (#3127), or a broken generator holds the queue
 * naming no cause.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderRegenerated } from "./clean-revert.js";
import { REGENERATED_FILES } from "./regenerated-files.js";

const ROOT = path.resolve(__dirname, "../..");

describe("REGENERATED_FILES", () => {
	const classes = JSON.parse(
		fs.readFileSync(path.join(ROOT, "docs/doc-map-classes.json"), "utf8"),
	);

	it.each([...REGENERATED_FILES])(
		"lists %s, a generated-only file whose generator exists",
		(file, { generator }) => {
			expect(classes[file]?.class).toBe("generated-only");
			expect(fs.existsSync(path.join(ROOT, generator))).toBe(true);
		},
	);
});

describe("renderRegenerated", () => {
	it("says why a render failed instead of throwing", () => {
		const broken = {
			generator: "scripts/broken.js",
			renderAt: () => {
				throw new Error("extractor broke");
			},
		};
		expect(renderRegenerated(ROOT, broken, "HEAD")).toEqual({
			failed: "extractor broke",
		});
	});
});
