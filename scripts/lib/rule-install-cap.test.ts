// @vitest-environment node
/*
 * Every fragment a wired guard injects fits RULE_CAP as an INSTALL spells it
 * (#5439). An install respells each `scripts/x` and `docs/x` at the plugin
 * root and qualifies each bare `#N`, so a fragment that fits in this checkout
 * can overrun the cap in an adopter, where guard-entry.js then refuses every
 * call the guard fires on: 3.0.0's killed-background-job, 3527 B here, read
 * 4020 B there and refused every backgrounded Bash call.
 *
 * The install is a probe tree at WFC_SCRIPT_ROOT holding the real scripts/
 * and docs/ through links and no package.json, so script-path.js reads it as
 * an install. Its path is padded to the root a 32-character user name — the
 * useradd limit — gives under `~/.claude/plugins/cache/`, at a version of two
 * digits a part, a guess at the longest the plugin will ship. The store is
 * pinned as both layers, so a core fragment's bare `#N` is qualified as an
 * install's is: vitest.setup.ts's default leaves no core layer beneath it.
 */

import fs from "node:fs";
import os from "node:os";
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

const REPO = path.resolve(__dirname, "..", "..");
const RULES = path.join(REPO, "docs", "agents", "rules");
const INSTALL_ROOT_CHARS =
	`/home/${"u".repeat(32)}/.claude/plugins/cache/workflow-core/workflow-core/10.10.10`
		.length;

let base: string;
let probe: string;

beforeAll(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-install-"));
	probe = path.join(
		base,
		"p".repeat(Math.max(1, INSTALL_ROOT_CHARS - base.length - 1)),
	);
	fs.mkdirSync(probe);
	for (const dir of ["scripts", "docs"])
		fs.symlinkSync(path.join(REPO, dir), path.join(probe, dir));
});

beforeEach(() => {
	vi.stubEnv("WFC_SCRIPT_ROOT", probe);
	vi.stubEnv("WFC_RULES_DIR", RULES);
	vi.stubEnv("WFC_RULES_FALLBACK_DIR", RULES);
});

afterAll(() => {
	fs.rmSync(base, { recursive: true, force: true });
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
