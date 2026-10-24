// @vitest-environment node
/*
 * Pins migration-note.js's reading of a migration note: the five sections in
 * order, the residue JSON, the one-line Verify and the typed manual-step
 * bullets.
 *
 * Most fixtures are an inline note with one rule broken. Three tests read the
 * real migrations/, so a shipped note that will not parse fails here before a
 * release refuses it.
 *
 * Breaking it lets upgrade walk an adopter through a note it misreads, with a
 * step cut short or a residue key dropped (#6).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNote, parseSteps, validateNote } from "./migration-note.js";

const GOOD = `# v2.0.0

## What changed

Config key \`disabled\` replaced \`skipped\`.

## Ruling

#100.

## Residue

\`\`\`json
{"contract": 2, "settingsKeys": true}
\`\`\`

## Manual steps

- [act] delete any \`.claude/local-override.json\` by hand

## Verify

\`\`\`sh
npm run typecheck
\`\`\`
`;

describe("parseNote", () => {
	it("reads a well-formed note", () => {
		const note = parseNote(GOOD);
		expect(note.faults).toEqual([]);
		expect(note.tag).toBe("v2.0.0");
		expect(note.residue).toEqual({ contract: 2, settingsKeys: true });
		expect(note.verify).toBe("npm run typecheck");
		expect(note.sections["What changed"]).toContain("disabled");
		expect(note.sections["Manual steps"]).toContain("local-override");
	});

	it("flags a missing section, naming it", () => {
		const faults = validateNote(GOOD.replace(/## Ruling[\s\S]*?\n\n/, ""));
		expect(faults).toContain('missing section "## Ruling"');
	});

	it("flags an unknown section, naming it", () => {
		const faults = validateNote(`${GOOD}\n## Extra\n\nstray\n`);
		expect(faults).toContain('unknown section "## Extra"');
	});

	it("flags sections out of order", () => {
		const swapped = GOOD.replace(
			/## What changed\n\nConfig key `disabled` replaced `skipped`\.\n\n## Ruling\n\n#100\.\n/,
			"## Ruling\n\n#100.\n\n## What changed\n\nConfig key `disabled` replaced `skipped`.\n",
		);
		expect(validateNote(swapped).some((f) => f.includes("out of order"))).toBe(
			true,
		);
	});

	it("flags a duplicate section, naming it", () => {
		const faults = validateNote(
			`${GOOD}\n## Verify\n\n\`\`\`sh\necho x\n\`\`\`\n`,
		);
		expect(faults).toContain('duplicate section "## Verify"');
	});

	it("flags residue with no fenced json block", () => {
		const faults = validateNote(
			GOOD.replace(/```json\n.*\n```/, "no code here"),
		);
		expect(faults).toContain('"## Residue" carries no fenced ```json block');
	});

	it("flags residue that does not parse", () => {
		const faults = validateNote(
			GOOD.replace('{"contract": 2, "settingsKeys": true}', "{not json"),
		);
		expect(faults.some((f) => f.includes("does not parse"))).toBe(true);
	});

	it("flags an unknown residue key, naming it", () => {
		const faults = validateNote(
			GOOD.replace('{"contract": 2, "settingsKeys": true}', '{"bogus": true}'),
		);
		expect(faults).toContain('"## Residue" names unknown key "bogus"');
	});

	it("accepts roadmapMajorPin as a known residue key (#70)", () => {
		const faults = validateNote(
			GOOD.replace(
				'{"contract": 2, "settingsKeys": true}',
				'{"roadmapMajorPin": true}',
			),
		);
		expect(faults).toEqual([]);
	});

	it("flags a multi-line Verify command", () => {
		const faults = validateNote(
			GOOD.replace("npm run typecheck", "npm run typecheck\nnpm test"),
		);
		expect(faults).toContain(
			'"## Verify" must be one command, not several lines',
		);
	});

	it("flags an empty Verify section", () => {
		const faults = validateNote(
			GOOD.replace(/```sh\nnpm run typecheck\n```/, ""),
		);
		expect(faults).toContain('"## Verify" names no command');
	});

	it("accepts act, choice and notice manual-step bullets", () => {
		const faults = validateNote(
			GOOD.replace(
				"- [act] delete any `.claude/local-override.json` by hand",
				"- [act] delete any `.claude/local-override.json` by hand\n" +
					"- [choice] want the old behaviour? set `legacyMode` yourself\n" +
					"- [notice] a session already running keeps the old key until restart",
			),
		);
		expect(faults).toEqual([]);
	});

	it("flags a manual-step bullet with no type", () => {
		const faults = validateNote(
			GOOD.replace(
				"- [act] delete any `.claude/local-override.json` by hand",
				"- delete any `.claude/local-override.json` by hand",
			),
		);
		expect(
			faults.some((f) =>
				f.includes('"## Manual steps" bullet carries no type'),
			),
		).toBe(true);
	});

	it("flags a bare [ ] manual-step bullet as carrying no type (#246)", () => {
		const faults = validateNote(
			GOOD.replace(
				"- [act] delete any `.claude/local-override.json` by hand",
				"- [ ] delete any `.claude/local-override.json` by hand",
			),
		);
		expect(
			faults.some((f) =>
				f.includes('"## Manual steps" bullet carries no type'),
			),
		).toBe(true);
	});

	it("flags an unknown manual-step bullet type, naming it, distinctly from no type", () => {
		const faults = validateNote(
			GOOD.replace(
				"- [act] delete any `.claude/local-override.json` by hand",
				"- [x] delete any `.claude/local-override.json` by hand",
			),
		);
		expect(
			faults.some((f) =>
				f.includes('"## Manual steps" bullet names unknown type "x"'),
			),
		).toBe(true);
	});

	it("flags an untyped `*`-marker manual-step bullet same as a `-` one", () => {
		const faults = validateNote(
			GOOD.replace(
				"- [act] delete any `.claude/local-override.json` by hand",
				"* delete any `.claude/local-override.json` by hand",
			),
		);
		expect(
			faults.some((f) =>
				f.includes('"## Manual steps" bullet carries no type'),
			),
		).toBe(true);
	});

	it("the whole shipped corpus passes validateNote (#246)", () => {
		const dir = path.join(__dirname, "../../migrations");
		for (const file of fs
			.readdirSync(dir)
			.filter((f: string) => f.endsWith(".md"))) {
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			expect(validateNote(text), file).toEqual([]);
		}
	});
});

describe("parseSteps (#248)", () => {
	it("reads every bullet's type and text, in order", () => {
		const steps = parseSteps(
			"- [act] do a thing\n- [choice] pick a thing\n- [notice] fyi a thing",
		);
		expect(steps).toEqual([
			{ type: "act", text: "do a thing" },
			{ type: "choice", text: "pick a thing" },
			{ type: "notice", text: "fyi a thing" },
		]);
	});

	it("ignores prose lines that are not a typed bullet", () => {
		const steps = parseSteps("Some prose above.\n\n- [notice] the only step");
		expect(steps).toEqual([{ type: "notice", text: "the only step" }]);
	});

	it("returns empty for an empty section", () => {
		expect(parseSteps("")).toEqual([]);
	});

	it("keeps a multi-line bullet's continuation lines, as migrations/v1.1.9.md writes them (#425)", () => {
		const note = fs.readFileSync(
			path.join(__dirname, "../../migrations/v1.1.9.md"),
			"utf8",
		);
		expect(parseSteps(parseNote(note).sections["Manual steps"])).toEqual([
			{
				type: "notice",
				text: "Set `worktree.bgIsolation` yourself already? The residue leaves it alone.",
			},
			{
				type: "choice",
				text: "Want auto-memory on in your repo? Set the key to `true` yourself. The residue leaves an existing value alone, so a later `upgrade` will not flip it back.",
			},
			{
				type: "notice",
				text: "A session already running keeps auto-memory until it restarts.",
			},
		]);
	});

	it("ends a step at a blank line, so prose below the list is not glued on (#425)", () => {
		expect(
			parseSteps("- [act] do a thing\n  still the thing\n\nTrailing prose."),
		).toEqual([{ type: "act", text: "do a thing still the thing" }]);
	});

	it("v1.1.17's act step names exactly the entries the pre-#425 parser cut from v1.1.9 (#429)", () => {
		const manualSteps = (note: string) =>
			parseNote(fs.readFileSync(path.join(__dirname, "../..", note), "utf8"))
				.sections["Manual steps"];
		const v119 = manualSteps("migrations/v1.1.9.md");
		/* The pre-#425 parser's output — each typed bullet's first line alone.
		 * Its regex is frozen here, not built from STEP_TYPES, because it models
		 * the old parser. */
		const firstLines = v119
			.split("\n")
			.map((l) => l.match(/^[-*]\s+\[(act|choice|notice)\]\s*(.*)$/))
			.filter((m) => m !== null)
			.map((m) => ({ type: m[1], text: m[2].trim() }));
		const full = parseSteps(v119);
		expect(full).toHaveLength(firstLines.length);
		const cut = firstLines.filter((s, i) => s.text !== full[i].text);
		expect(cut).toHaveLength(2);
		const [act] = parseSteps(manualSteps("migrations/v1.1.17.md"));
		expect(act.text.match(/``[^`].*?[^`]``/g)).toEqual(
			cut.map((s) => `\`\`${s.text}\`\``),
		);
	});
});
