// @vitest-environment node
/*
 * The pre-commit context-budget gate (mantahostels#1224), exercised as the shell it is.
 *
 * `.husky/pre-commit` calls `check-context-budget.js --against HEAD` only when the
 * commit touches a path either cap can contain, and passes its exit code
 * straight through — the checker's own FAIL is what refuses the commit.
 *
 * The checker is stubbed in each fixture so both exit codes can be driven; what
 * it FINDS is pinned in check-context-budget.test.ts, not here.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a commit growing
 * an always-loaded file, guard or injected doc past its cap lands unrefused,
 * and every later session pays those bytes before it does any work.
 *
 * full-sweep-only: reads every script the core's hooks wire on PreToolUse and
 * the libraries they source, a set read from self-plugin/hooks/hooks.json at
 * runtime, so no literal names them.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { coreCall, HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";

const CHECKER = "scripts/check-context-budget.js";
/* The event cap's inputs, read the checker's own way rather than restated. */
// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, as its own test loads it
const emission = require("./lib/rule-emission") as any;
const { CAP_SOURCE, WIRED_SCRIPT_RE, sourcedClosure } = emission;
/* Resolved, so an entry spelled as a named constant is checked as well as a
 * literal one (#1120). */
const { materialisePathspecs } =
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, as above
	require("./lib/context-budget-pathspecs") as any;
/* Materialised but moving no capped total, so the gate need not fire on it:
 * the vendored skills a `.claude/skills` symlink points into. */
const VENDORED_SOURCE = ".agents/skills";
const STUB_MARKER = "STUB-CHECK-RAN";

const temps = registerTempCleanup();
const gateFragment = () => cutGateFragment(`${CHECKER} --against HEAD`);

/**
 * A repo with one commit, a stubbed checker, and `staged` staged on top.
 *
 * The stub TOUCHES a file rather than printing: the gate holds the checker's
 * output and replays it only on a refusal or a WARN, so "did it run" cannot be
 * read off stdout.
 */
function fixture(
	staged: Record<string, string>,
	checkerExit = 0,
	extraLine = "",
): string {
	const checker =
		`require("node:fs").writeFileSync("${STUB_MARKER}", "");\n` +
		`console.log("${STUB_MARKER}");\n` +
		(extraLine ? `console.error(${JSON.stringify(extraLine)});\n` : "") +
		`process.exit(${checkerExit});\n`;
	return stagedRepo(
		"ctx-budget-gate-",
		temps,
		{ "scripts/check-context-budget.js": checker },
		staged,
	).root;
}

const ran = (root: string) => fs.existsSync(path.join(root, STUB_MARKER));

function runGate(cwd: string): { code: number; output: string } {
	// stderr merged in: the gate replays the checker's held output there, and on
	// a WARN it does so while still exiting 0.
	const script = `{\n${LIB}\n${gateFragment()}\n} 2>&1`;
	try {
		const out = execFileSync("sh", ["-c", script], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
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

describe("the pre-commit context-budget gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(`${coreCall("node", CHECKER)} --against HEAD`);
	});

	/*
	 * The hook's arming pattern is a second spelling of the paths the checker's
	 * `--against` materialises. A path the checker measures but the pattern does
	 * not match is a surface the gate silently stops covering, which is the
	 * drift this asserts against.
	 */
	function armingRegex(): RegExp {
		return new RegExp(armingPattern(`${CHECKER} --against HEAD`));
	}

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
			for (const lib of sourcedClosure(
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

	/*
	 * The injection cap covers whatever the injector's DOCS array names, so a doc
	 * moved out of the grep's reach uncaps it silently rather than loudly.
	 */
	it("triggers on every doc the live injector actually injects", () => {
		const script = fs.readFileSync(
			path.join(ROOT, "scripts", "inject-tracker-docs.sh"),
			"utf8",
		);
		const docs = /^DOCS=\(([^)]*)\)/m.exec(script);
		expect(docs, "DOCS no longer parses out of the injector").toBeTruthy();
		const paths = (docs?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
		// DOCS stays empty by design since mantahostels#1870 — the injector points at docs
		// now, it no longer pastes them. The loop below still enforces coverage
		// the moment a doc is pasted again.

		const alternation = armingRegex();
		for (const rel of paths)
			expect(alternation.test(rel), `the gate does not fire on ${rel}`).toBe(
				true,
			);
	});

	/* An adopter's declared pool file outside the grep (#33), read off the pool
	 * module the hook runs — stubbed here, as the checker is. */
	it("fires on a declared pool file outside the grep, and not on its neighbour", () => {
		const stubPool = (root: string) => {
			fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
			fs.writeFileSync(
				path.join(root, "scripts", "lib", "always-loaded-pool.js"),
				'console.log("CLAUDE.md\\nSTYLE.md");\n',
			);
		};
		const declared = fixture({ "STYLE.md": "x\n" });
		stubPool(declared);
		expect(runGate(declared).code).toBe(0);
		expect(ran(declared)).toBe(true);

		const neighbour = fixture({ "STYLE.md.bak": "x\n" });
		stubPool(neighbour);
		expect(runGate(neighbour).code).toBe(0);
		expect(ran(neighbour)).toBe(false);
	});

	it("does not fire on a commit touching none of them", () => {
		const root = fixture({ "app/page.tsx": "x\n" }, 1);
		expect(runGate(root).code).toBe(0);
		expect(ran(root)).toBe(false);
	});

	/* `scripts/` moved INSIDE the scope at mantahostels#2004 — the event cap is contained by
	 * the guards under it — so the lookalike is a path that merely reads like a
	 * capped one. */
	it("does not fire on a lookalike path outside the capped scope", () => {
		const root = fixture({ "app/docs-helper.js": "x\n" }, 1);
		expect(runGate(root).code).toBe(0);
		expect(ran(root)).toBe(false);
	});

	/*
	 * The gate is silent on a pass and speaks on a WARN. A byte line at every
	 * docs commit is what teaches the reader to skip the gate; a WARN names a
	 * surface that is over cap, which is worth one line even when unrefused.
	 */
	it("holds the checker's output on a pass", () => {
		expect(runGate(fixture({ "CLAUDE.md": "x\n" })).output).not.toContain(
			STUB_MARKER,
		);
	});

	it("replays it on a WARN, which exits 0 and would otherwise go unseen", () => {
		const r = runGate(fixture({ "CLAUDE.md": "x\n" }, 0, "WARN: over cap"));
		expect(r.code).toBe(0);
		expect(r.output).toContain("WARN: over cap");
	});

	for (const rel of [
		"CLAUDE.md",
		"AGENTS.md",
		"docs/working-contract.md",
		"docs/agents/issue-tracker.md",
		".claude/skills/thing/SKILL.md",
		".claude/commands/thing.md",
		".claude/agents/scout.md",
		"scripts/inject-tracker-docs.sh",
	]) {
		it(`fires on a commit staging ${rel}`, () => {
			const root = fixture({ [rel]: "x\n" });
			runGate(root);
			expect(ran(root)).toBe(true);
		});
	}

	it("refuses the commit with the checker's own exit code", () => {
		const failRoot = fixture({ "CLAUDE.md": "x\n" }, 1);
		const fail = runGate(failRoot);
		expect(fail.code).toBe(1);
		expect(ran(failRoot)).toBe(true);
		expect(fail.output).toContain(STUB_MARKER);

		// BROKEN is passed through rather than flattened, AND its output is
		// replayed rather than swallowed: the exit-code check alone would still
		// pass if the gate dropped the `printf` that replays it.
		const brokenRoot = fixture({ "CLAUDE.md": "x\n" }, 2);
		const broken = runGate(brokenRoot);
		expect(broken.code).toBe(2);
		expect(ran(brokenRoot)).toBe(true);
		expect(broken.output).toContain(STUB_MARKER);
	});
});
