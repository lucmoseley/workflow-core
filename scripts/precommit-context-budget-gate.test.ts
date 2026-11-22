// @vitest-environment node
// full-sweep-only: #1886

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Ctx } from "./lib/check";
import {
	materialisePathspecs,
	TRACKER_TEXT,
} from "./lib/context-budget-pathspecs";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	dispatchStubbed,
	patternRow,
	ROOT,
} from "./lib/precommit-gate-testkit";
import {
	CAP_SOURCE,
	readSourcedClosure,
	WIRED_SCRIPT_RE,
} from "./lib/rule-emission";

const CHECKER = "scripts/check-context-budget.js";
const VENDORED_SOURCE = ".agents/skills";

const temps = registerTempCleanup();

const ROW = patternRow(CHECKER);
const PATTERN = ROW.arm.pattern;

async function fires(
	staged: Record<string, string>,
	pool: string[] = [],
): Promise<boolean> {
	const { root } = stagedRepo("ctx-budget-gate-", temps, {}, staged);
	const { ran } = await dispatchStubbed(root, ROW, {
		ports: {
			computed: (name) => (name === "always-loaded-pool" ? pool : []),
		},
	});
	return ran;
}

interface PreToolUseSettings {
	hooks?: { PreToolUse?: { hooks?: { command?: unknown }[] }[] };
}

function preToolUseScripts(settings: PreToolUseSettings): string[] {
	const out: string[] = [];
	for (const entry of settings?.hooks?.PreToolUse ?? [])
		for (const h of entry?.hooks ?? [])
			for (const m of String(h?.command ?? "").matchAll(WIRED_SCRIPT_RE))
				out.push(m[1]);
	return out;
}

const readRepoFile = (rel: string) => {
	try {
		return fs.readFileSync(path.join(ROOT, rel), "utf8");
	} catch {
		return null;
	}
};

describe("the pre-commit context-budget row", () => {
	it("is a gating checker row, silent on a pass, armed on the always-loaded pool too", () => {
		expect(ROW).toMatchObject({
			policy: "gate",
			kind: "checker",
			args: ["--against", "HEAD"],
			quietPass: true,
			arm: { computed: "always-loaded-pool" },
		});
	});

	const armingRegex = () => PATTERN;

	it("triggers on every path --against materialises, the vendored source aside", () => {
		const ctx = {
			broken: (m: string) => {
				throw new Error(m);
			},
		} as unknown as Ctx;
		const spec = materialisePathspecs(ctx, "HEAD").filter(
			(s) => s !== VENDORED_SOURCE,
		);
		expect(spec).toContain(".claude/skills");
		expect(spec).toContain(".claude/workflow-core.json");
		expect(spec).toContain("CLAUDE.md");

		const alternation = armingRegex();
		for (const s of spec)
			expect(
				alternation.test(s.includes(".") ? s : `${s}/thing.md`),
				`the gate does not fire on ${s}`,
			).toBe(true);
	});

	it("triggers on every guard a PreToolUse event can fire", () => {
		const settings = JSON.parse(
			fs.readFileSync(
				path.join(ROOT, "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		);
		const wired = new Set<string>([CAP_SOURCE, ...preToolUseScripts(settings)]);
		expect(
			wired.size,
			"no PreToolUse guard parsed out of the wiring",
		).toBeGreaterThan(1);
		for (const rel of [...wired])
			for (const lib of readSourcedClosure(
				rel,
				readRepoFile(rel) ?? "",
				readRepoFile,
			).keys())
				wired.add(lib);

		const alternation = armingRegex();
		for (const rel of wired)
			expect(alternation.test(rel), `the gate does not fire on ${rel}`).toBe(
				true,
			);
	});

	it("triggers on the text module and every rule fragment the injection union reads", () => {
		const alternation = armingRegex();
		for (const rel of [
			TRACKER_TEXT,
			"docs/agents/rules/review-dispatch-shape.txt",
			"docs/agents/rules/review-deviations-read.txt",
			"docs/agents/rules/review-finding-destination.txt",
		])
			expect(alternation.test(rel), `the gate does not fire on ${rel}`).toBe(
				true,
			);
	});

	it("fires on a declared pool file outside the pattern, and not on its neighbour", async () => {
		const pool = ["CLAUDE.md", "STYLE.md"];
		expect(await fires({ "STYLE.md": "x\n" }, pool)).toBe(true);
		expect(await fires({ "STYLE.md.bak": "x\n" }, pool)).toBe(false);
	});

	it("does not fire on a commit touching none of them", async () => {
		expect(await fires({ "app/page.tsx": "x\n" })).toBe(false);
	});

	it("does not fire on a lookalike path outside the capped scope", async () => {
		expect(await fires({ "app/docs-helper.js": "x\n" })).toBe(false);
	});

	it.each([
		"CLAUDE.md",
		"AGENTS.md",
		"docs/working-contract.md",
		"docs/agents/issue-tracker.md",
		".claude/skills/thing/SKILL.md",
		".claude/commands/thing.md",
		".claude/agents/scout.md",
		"scripts/lib/tracker-inject-text.js",
	])("fires on a commit staging %s", async (rel) => {
		expect(await fires({ [rel]: "x\n" })).toBe(true);
	});
});
