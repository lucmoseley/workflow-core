// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { walkCommand } = require("./walk-command.js");

describe("walkCommand (#5286)", () => {
	it("names the core's own script in a source checkout", () => {
		expect(
			walkCommand({ WFC_SCRIPT_ROOT: path.resolve(__dirname, "..", "..") }),
		).toBe("node scripts/upgrade.js");
	});

	it("routes an install through the adopter's resolve-core.js runner", () => {
		const install = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-walk-cmd-"));
		try {
			expect(walkCommand({ WFC_SCRIPT_ROOT: install })).toBe(
				"node scripts/lib/resolve-core.js scripts/upgrade.js",
			);
		} finally {
			fs.rmSync(install, { recursive: true, force: true });
		}
	});
});
