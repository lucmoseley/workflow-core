// @vitest-environment node
/*
 * The pre-commit context-budget gate (mantahostels#1224), a pre-commit
 * dispatcher row (#5172).
 *
 * The row runs `check-context-budget.js --against HEAD` only when the commit
 * touches a path either cap can contain, or a pool file the host config
 * declares. What the dispatcher does with its exit, and its quiet pass, are
 * scripts/lib/precommit-dispatch.test.ts's; what the checker FINDS is
 * check-context-budget.test.ts's.
 *
 * It is a hard gate: loosen a case and a commit growing
 * an always-loaded file, guard or injected doc past its cap lands unrefused,
 * and every later session pays those bytes before it does any work.
 *
 * full-sweep-only: reads every script the core's hooks wire on PreToolUse and
 * the libraries they source, a set read from self-plugin/hooks/hooks.json at
 * runtime, so no literal names them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch } from "./lib/precommit-dispatch.js";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import { ROOT, repoPorts } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

const CHECKER = "scripts/check-context-budget.js";
/* The event cap's inputs, read the checker's own way rather than restated. */
// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, as its own test loads it
const emission = require("./lib/rule-emission") as any;
const { CAP_SOURCE, WIRED_SCRIPT_RE, readSourcedClosure } = emission;
/* Resolved, so an entry spelled as a named constant is checked as well as a
 * literal one (#1120). */
const { TRACKER_TEXT, materialisePathspecs } =
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, as above
	require("./lib/context-budget-pathspecs") as any;
/* Materialised but moving no capped total, so the gate need not fire on it:
 * the vendored skills a `.claude/skills` symlink points into. */
const VENDORED_SOURCE = ".agents/skills";

const temps = registerTempCleanup();

const row = GATES.find((g) => g.script === CHECKER);
if (!row || !("pattern" in row.arm))
	throw new Error(`no pattern row for ${CHECKER} in lib/precommit-gates.js`);
const ROW = row;
const PATTERN = row.arm.pattern;

/** Whether the dispatcher runs the row on `staged`, the pool being `pool`. */
async function fires(
	staged: Record<string, string>,
	pool: string[] = [],
): Promise<boolean> {
	const { root } = stagedRepo("ctx-budget-gate-", temps, {}, staged);
	let ran = false;
	await dispatch({
		rows: [ROW],
		gates: "all",
		ports: repoPorts(root, {
			computed: (name) => (name === "always-loaded-pool" ? pool : []),
			load: () => () => {
				ran = true;
				return { exit: 0, stdout: "", stderr: "" };
			},
		}),
	});
	return ran;
}

interface PreToolUseSettings {
	hooks?: { PreToolUse?: { hooks?: { command?: unknown }[] }[] };
}

/** Every script the hooks wire on PreToolUse, in wiring order. */
function preToolUseScripts(settings: PreToolUseSettings): string[] {
	const out: string[] = [];
	for (const entry of settings?.hooks?.PreToolUse ?? [])
		for (const h of entry?.hooks ?? [])
			for (const m of String(h?.command ?? "").matchAll(WIRED_SCRIPT_RE))
				out.push(m[1]);
	return out;
}

/** A repo-relative file's text, or null where it cannot be read. */
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

	/*
	 * The row's arming pattern is a second spelling of the paths the checker's
	 * `--against` materialises. A path the checker measures but the pattern does
	 * not match is a surface the gate silently stops covering, which is the
	 * drift this asserts against.
	 */
	const armingRegex = () => PATTERN;

	it("triggers on every path --against materialises, the vendored source aside", () => {
		const ctx = {
			broken: (m: string) => {
				throw new Error(m);
			},
		};
		const spec = (materialisePathspecs(ctx, "HEAD") as string[]).filter(
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

	/*
	 * The event cap covers whatever the core's hooks wire on PreToolUse,
	 * so a guard the grep does not reach is rule text that can grow past route
	 * (f)'s cap with nothing refusing the commit that grew it (mantahostels#2004).
	 *
	 * Read off the REAL wiring and the real call shape, not a list: a list here
	 * would go stale the moment a guard is wired, which is the drift this exists
	 * to catch.
	 */
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
		/* And the libs they source, whose rule calls the cap counts too (#1120). */
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

	/* The injection cap reads the text module and the rule fragments its
	 * review strings take, so a commit touching any of them must fire. */
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

	/* An adopter's declared pool file outside the pattern (#33). */
	it("fires on a declared pool file outside the pattern, and not on its neighbour", async () => {
		const pool = ["CLAUDE.md", "STYLE.md"];
		expect(await fires({ "STYLE.md": "x\n" }, pool)).toBe(true);
		expect(await fires({ "STYLE.md.bak": "x\n" }, pool)).toBe(false);
	});

	it("does not fire on a commit touching none of them", async () => {
		expect(await fires({ "app/page.tsx": "x\n" })).toBe(false);
	});

	/* `scripts/` moved INSIDE the scope at mantahostels#2004 — the event cap is contained by
	 * the guards under it — so the lookalike is a path that merely reads like a
	 * capped one. */
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
