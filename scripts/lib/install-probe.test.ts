// @vitest-environment node
/*
 * asInstall() (#5447) reads a checkout's text as the probe install spells it,
 * and leaves no root or tree behind. A break here mis-prices route (f)'s
 * budgets in scripts/check-context-budget.js. WFC_SCRIPT_ROOT is stubbed
 * empty, so the run starts from a checkout whatever the shell inherited.
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { asInstall } = require("./install-probe.js") as {
	asInstall: <T>(read: () => T) => T;
};
const { inCheckout, resolveScriptPaths } = require("./script-path.js") as {
	inCheckout: () => boolean;
	resolveScriptPaths: (text: string) => string;
};
const { shellQuote } = require("./sh-quote.js") as {
	shellQuote: (s: string) => string;
};

beforeEach(() => {
	vi.stubEnv("WFC_SCRIPT_ROOT", "");
});

describe("asInstall", () => {
	it("reads a checkout's text at the install spelling", () => {
		const read = asInstall(() => ({
			install: !inCheckout(),
			root: process.env.WFC_SCRIPT_ROOT ?? "",
			text: resolveScriptPaths("run scripts/claim-issue.js"),
		}));
		expect(read.install).toBe(true);
		expect(read.text).toBe(
			`run ${shellQuote(`${read.root}/scripts/claim-issue.js`)}`,
		);
	});

	it("restores the core root and removes its tree, on a throw too", () => {
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
