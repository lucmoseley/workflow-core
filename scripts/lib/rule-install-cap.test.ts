// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reachableByTool } = require("./rule-emission.js") as {
	reachableByTool: (o: { root: string }) => {
		cap: number;
		overCap: { id: string; bytes: number; guards: string[] }[];
	};
};
const { asInstall } = require("./install-probe.js") as {
	asInstall: <T>(root: string, read: () => T) => T;
};

const REPO = path.resolve(__dirname, "..", "..");
const RULES = path.join(REPO, "docs", "agents", "rules");

beforeEach(() => {
	vi.stubEnv("WFC_SCRIPT_ROOT", "");
});

describe("an injected fragment as an install spells it", () => {
	it("comes from a probe tree read as an install, not a checkout", () => {
		expect(
			asInstall(REPO, () => require("./script-path.js").inCheckout()),
		).toBe(false);
	});

	it("has its bare citations qualified, as an install's are", () => {
		const { readRuleText } = require("./rule-text.js");
		const texts = asInstall(REPO, () =>
			fs
				.readdirSync(RULES)
				.filter((f) => f.endsWith(".txt"))
				.map((f) => readRuleText(f.slice(0, -4), REPO)),
		);
		expect(texts.some((t: string) => t.includes("(workflow-core#"))).toBe(true);
	});

	it("fits RULE_CAP, so no adopter's guard refuses the call it fires on", () => {
		const { cap, overCap } = asInstall(REPO, () =>
			reachableByTool({ root: REPO }),
		);
		expect(overCap.map((o) => `${o.id}: ${o.bytes} B over ${cap} B`)).toEqual(
			[],
		);
	});
});
