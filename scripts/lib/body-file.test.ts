// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const { readBodyFile } = createRequire(__filename)(
	"./body-file.js",
) as typeof import("./body-file.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "body-file-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it("returns the text, undefined where absent, and throws where unreadable", () => {
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, "body\n");
	expect(readBodyFile(file)).toBe("body\n");
	expect(readBodyFile(path.join(dir, "nope"))).toBeUndefined();
	expect(() => readBodyFile(dir)).toThrow(/EISDIR/);
});
