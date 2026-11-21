// @vitest-environment node
/*
 * Every fragment a wired guard injects fits RULE_CAP as an INSTALL spells it
 * (#5439), read through lib/install-probe.js's probe tree. The store is pinned
 * as both layers, so a core fragment's bare `#N` is qualified as an install's
 * is: vitest.setup.ts's default leaves no core layer beneath it.
 */

import fs from "node:fs";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { reachableByTool } = require("./rule-emission.js") as {
	reachableByTool: (o: { root: string }) => {
		cap: number;
		overCap: { id: string; bytes: number; guards: string[] }[];
	};
};

const { makeInstallProbe } = require("./install-probe.js") as {
	makeInstallProbe: (core: string) => { root: string; remove: () => void };
};

const REPO = path.resolve(__dirname, "..", "..");
const RULES = path.join(REPO, "docs", "agents", "rules");

let probe: { root: string; remove: () => void };

beforeAll(() => {
	probe = makeInstallProbe(REPO);
});

beforeEach(() => {
	vi.stubEnv("WFC_SCRIPT_ROOT", probe.root);
	vi.stubEnv("WFC_RULES_DIR", RULES);
	vi.stubEnv("WFC_RULES_FALLBACK_DIR", RULES);
});

afterAll(() => {
	probe.remove();
});

describe("an injected fragment as an install spells it", () => {
	it("comes from a probe tree read as an install, not a checkout", () => {
		expect(require("./script-path.js").inCheckout()).toBe(false);
	});

	it("has its bare citations qualified, as an install's are", () => {
		const { readRuleText } = require("./rule-text.js");
		const texts = fs
			.readdirSync(RULES)
			.filter((f) => f.endsWith(".txt"))
			.map((f) => readRuleText(f.slice(0, -4), REPO));
		expect(texts.some((t: string) => t.includes("(workflow-core#"))).toBe(true);
	});

	it("fits RULE_CAP, so no adopter's guard refuses the call it fires on", () => {
		const { cap, overCap } = reachableByTool({ root: REPO });
		expect(overCap.map((o) => `${o.id}: ${o.bytes} B over ${cap} B`)).toEqual(
			[],
		);
	});
});
