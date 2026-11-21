// @vitest-environment node
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { asInstall } = require("./install-probe.js") as {
	asInstall: <T>(read: () => T) => T;
};
const { inCheckout, resolveScriptPaths } = require("./script-path.js") as {
	inCheckout: () => boolean;
	resolveScriptPaths: (text: string) => string;
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("asInstall", () => {
	it("reads a checkout's text at the install spelling", () => {
		vi.stubEnv("WFC_SCRIPT_ROOT", "");
		const text = "run scripts/claim-issue.js";
		const read = asInstall(() => ({
			install: !inCheckout(),
			text: resolveScriptPaths(text),
		}));
		expect(read.install).toBe(true);
		expect(read.text).toMatch(/^run '?\/.+\/scripts\/claim-issue\.js'?$/);
		expect(read.text.length).toBeGreaterThan(text.length + 80);
	});

	it("restores the core root and removes its tree, on a throw too", () => {
		vi.stubEnv("WFC_SCRIPT_ROOT", "");
		let root = "";
		expect(() =>
			asInstall(() => {
				root = process.env.WFC_SCRIPT_ROOT ?? "";
				throw new Error("read failed");
			}),
		).toThrow("read failed");
		expect(process.env.WFC_SCRIPT_ROOT).toBe("");
		expect(fs.existsSync(root)).toBe(false);
	});
});
