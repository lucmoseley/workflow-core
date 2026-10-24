// @vitest-environment node
/*
 * Pins the /implement carve-out measurement matcher: mantahostels#1334's
 * original eight paths, the widened rules and where they stop, and the
 * transcript scan that feeds them.
 *
 * Transcripts are built line by line in the test, so each case holds exactly
 * the command, model and commit it needs, and no real session log is read.
 *
 * Breaking it skews the re-run count of Opus /implement misses, which a
 * too-narrow matcher once inflated twentyfold (mantahostels#2462).
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const carveout: any = createRequire(__filename)("./implement-carveout.js");

const ORIGINAL_EIGHT = [
	"scripts/guard-",
	".husky/",
	"CLAUDE.md",
	"AGENTS.md",
	"docs/working-contract.md",
	"docs/doc-map.md",
	".claude/settings.json",
	"scripts/session-arbiter",
];

/** mantahostels#1334's original matcher, reproduced so the widening can be asserted against it. */
function originalHardCarveOut(paths: string[]): boolean {
	return paths.some((p) => ORIGINAL_EIGHT.some((h) => p.includes(h)));
}

describe("isHardCarveOut — original eight items still match", () => {
	it("matches each of mantahostels#1334's original substrings", () => {
		expect(carveout.isHardCarveOut(["scripts/guard-file-claim.sh"]).hit).toBe(
			true,
		);
		expect(carveout.isHardCarveOut([".husky/pre-commit"]).hit).toBe(true);
		expect(carveout.isHardCarveOut(["CLAUDE.md"]).hit).toBe(true);
		expect(carveout.isHardCarveOut(["AGENTS.md"]).hit).toBe(true);
		expect(carveout.isHardCarveOut(["docs/working-contract.md"]).hit).toBe(
			true,
		);
		expect(carveout.isHardCarveOut(["docs/doc-map.md"]).hit).toBe(true);
		expect(carveout.isHardCarveOut([".claude/settings.json"]).hit).toBe(true);
		expect(carveout.isHardCarveOut(["scripts/session-arbiter.js"]).hit).toBe(
			true,
		);
	});

	it("does not match an unrelated product path", () => {
		expect(carveout.isHardCarveOut(["app/page.tsx"]).hit).toBe(false);
		expect(carveout.isHardCarveOut(["components/Nav.tsx"]).hit).toBe(false);
	});
});

describe("isHardCarveOut — mantahostels#2462's widened rules", () => {
	const cases: [string, string][] = [
		["scripts/lib/*", "scripts/lib/guard-parse.sh"],
		["scripts/lib/*", "scripts/lib/arbiter-store.js"],
		// A scripts/lib/ file naming neither "guard" nor "arbiter" — the
		// deliberate widening past mantahostels#2462's own literal "scripts/lib/*guard*"
		// candidate, on the census finding scripts/lib/ holds nothing but
		// check/guard/arbiter/doc-map support code.
		["scripts/lib/*", "scripts/lib/doc-map.js"],
		["scripts/check-*.js", "scripts/check-doc-map.js"],
		["docs/agents/*", "docs/agents/issue-tracker.md"],
		["docs/*.json", "docs/doc-map-restatements.json"],
		["docs/environment.md", "docs/environment.md"],
		[".claude/skills/*", ".claude/skills/pick-next/SKILL.md"],
		[".github/workflows/*", ".github/workflows/roadmap-digest.yml"],
	];

	for (const [rule, samplePath] of cases) {
		it(`${rule} — ${samplePath} now hits, and missed the original list`, () => {
			expect(carveout.isHardCarveOut([samplePath]).hit).toBe(true);
			expect(originalHardCarveOut([samplePath])).toBe(false);
		});
	}

	it("docs/*.json only matches a direct child of docs/, not a nested one", () => {
		expect(carveout.isHardCarveOut(["docs/research/foo.json"]).hit).toBe(false);
	});

	it("scripts/check-*.js does not match a nested checks directory", () => {
		expect(carveout.isHardCarveOut(["scripts/nested/check-foo.js"]).hit).toBe(
			false,
		);
	});

	it("does not widen to docs/research/, which mixes machinery notes with real business/legal research", () => {
		expect(
			carveout.isHardCarveOut(["docs/research/consent-notice-language.md"]).hit,
		).toBe(false);
	});

	it("reports which path and rule matched", () => {
		const r = carveout.isHardCarveOut([
			"app/page.tsx",
			"docs/agents/issue-tracker.md",
		]);
		expect(r).toEqual({
			hit: true,
			path: "docs/agents/issue-tracker.md",
			rule: "docs/agents/*",
		});
	});
});

describe("isAdjacent — unchanged by mantahostels#2462", () => {
	it("still matches only the two mantahostels#1334 Q3 adjacent paths", () => {
		expect(carveout.isAdjacent([".claude/settings.json"]).hit).toBe(true);
		expect(carveout.isAdjacent(["scripts/session-arbiter.js"]).hit).toBe(true);
	});

	it("does not match a widened hard-list-only path", () => {
		expect(carveout.isAdjacent(["docs/agents/issue-tracker.md"]).hit).toBe(
			false,
		);
	});
});

describe("the paths a session committed", () => {
	/** The pathspecs scanSession reads off one session's one commit command. */
	function committed(commitCmd: string): string[] {
		return carveout.scanSession(assistantLine("claude-opus-4", commitCmd))
			.paths;
	}

	it("pulls pathspecs after -- from a git commit -m command", () => {
		expect(
			committed(
				'git commit -m "fix thing" -- scripts/foo.js scripts/foo.test.ts',
			),
		).toEqual(["scripts/foo.js", "scripts/foo.test.ts"]);
	});

	it("strips surrounding quotes from a path token", () => {
		expect(committed('git commit -m "x" -- "app/page.tsx"')).toEqual([
			"app/page.tsx",
		]);
	});

	it("returns nothing for a commit command with no -- pathspec", () => {
		expect(committed('git commit -m "x"')).toEqual([]);
	});
});

/** One line of a fake transcript. */
function line(record: Record<string, unknown>): string {
	return JSON.stringify(record);
}

/** A user turn carrying the session's `<command-name>` block. */
function commandLine(command: string, timestamp: string): string {
	return line({
		type: "user",
		timestamp,
		message: {
			content: [
				{ type: "text", text: `<command-name>/${command}</command-name>` },
			],
		},
	});
}

/**
 * An assistant turn, optionally naming a Bash `git commit` call. Not
 * transcript-testkit's buildBashCall: the tier read needs `message.model`, which it
 * does not set, and a turn with no call at all.
 */
function assistantLine(model: string, commitCmd?: string): string {
	const content: unknown[] = [];
	if (commitCmd)
		content.push({
			type: "tool_use",
			name: "Bash",
			input: { command: commitCmd },
		});
	return line({ type: "assistant", message: { model, content } });
}

describe("scanSession", () => {
	it("reads the command, model tier and committed paths from a fake transcript", () => {
		const text = [
			commandLine("implement", "2026-08-26T00:00:00Z"),
			assistantLine(
				"claude-opus-4",
				'git commit -m "x" -- scripts/foo.js docs/agents/bar.md',
			),
		].join("\n");
		const s = carveout.scanSession(text);
		expect(s.command).toBe("implement");
		expect(s.model).toBe("opus");
		expect(s.paths).toEqual(["scripts/foo.js", "docs/agents/bar.md"]);
		expect(s.startedAt).toBe(Date.parse("2026-08-26T00:00:00Z"));
		expect(s.capped).toBe(false);
	});

	it("reports mixed where the session ran on both tiers", () => {
		const text = [
			commandLine("implement", "2026-08-26T00:00:00Z"),
			assistantLine("claude-sonnet-4"),
			assistantLine("claude-opus-4"),
		].join("\n");
		expect(carveout.scanSession(text).model).toBe("mixed");
	});

	it("reports unknown model and null start for a transcript with neither", () => {
		const s = carveout.scanSession(commandLine("implement", "not-a-date"));
		expect(s.model).toBe("unknown");
		expect(s.startedAt).toBeNull();
	});

	it("reports capped when the head read ends with no <command-name> block", () => {
		const padding = "x".repeat(1024 * 1024);
		const s = carveout.scanSession(padding);
		expect(s.command).toBeNull();
		expect(s.capped).toBe(true);
	});

	it("does not throw on a half-written line", () => {
		expect(() =>
			carveout.scanSession(
				`${commandLine("implement", "2026-08-26T00:00:00Z")}\n{"type":"asse`,
			),
		).not.toThrow();
	});
});
