// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { asInstall } = require("./install-probe.js") as {
	asInstall: <T>(root: string, read: () => T) => T;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string, root: string) => string;
};
const { inCheckout, resolveScriptPaths } = require("./script-path.js") as {
	inCheckout: () => boolean;
	resolveScriptPaths: (text: string) => string;
};
const { shellQuote } = require("./sh-quote.js") as {
	shellQuote: (s: string) => string;
};

const REPO = path.resolve(__dirname, "..", "..");

beforeEach(() => {
	vi.stubEnv("WFC_SCRIPT_ROOT", "");
});

describe("asInstall", () => {
	it("reads a checkout's text at the install spelling", () => {
		const read = asInstall(REPO, () => ({
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
			asInstall(REPO, () => {
				root = process.env.WFC_SCRIPT_ROOT ?? "";
				throw new Error("read failed");
			}),
		).toThrow("read failed");
		expect(process.env.WFC_SCRIPT_ROOT).toBe("");
		expect(fs.existsSync(root)).toBe(false);
	});

	it("reads a fragment alike at two roots of different lengths, as it reads a checkout's text at the install spelling (#5480)", () => {
		const short = fs.mkdtempSync(path.join(os.tmpdir(), "c"));
		try {
			for (const rel of ["docs/agents/rules", "self-plugin/hooks/hooks.json"])
				fs.cpSync(path.join(REPO, rel), path.join(short, rel), {
					recursive: true,
				});
			const [atRepo, atShort] = [REPO, short].map((root) =>
				asInstall(root, () =>
					readRuleText("founder-handover", root).replaceAll(
						process.env.WFC_SCRIPT_ROOT ?? "",
						"<probe>",
					),
				),
			);
			expect(short.length).not.toBe(REPO.length);
			expect(atRepo).toContain("(workflow-core#");
			expect(atRepo).not.toContain(REPO);
			expect(atShort).not.toContain(short);
			expect(atShort).toBe(atRepo);
		} finally {
			fs.rmSync(short, { recursive: true, force: true });
		}
	});
});
