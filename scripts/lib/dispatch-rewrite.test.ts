// @vitest-environment node
/*
 * lib/dispatch-rewrite.js composes the dispatch transforms into one envelope
 * (#515). Two envelopes on one call race, the last to finish winning
 * (anthropics/claude-code#83353), so a composition that dropped either change
 * would bring the race back by another route, unseen. The hook's process half is
 * tested in ../guard-dispatch-rewrite.test.ts.
 *
 * The composition is called in-process on built hook inputs because it is a
 * pure function of them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewrite } from "./dispatch-rewrite";

const FILE = "/repo/.claude/tmp/agents/d-0badf00d.md";

describe("rewrite", () => {
	it("carries both changes in one updatedInput, on an allow", () => {
		const out = rewrite(
			{ prompt: "Do it.", description: "d", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		const v = out?.envelope.hookSpecificOutput;
		expect(v?.permissionDecision).toBe("allow");
		expect(v?.updatedInput).toMatchObject({
			model: "opus",
			description: "d",
			prompt: expect.stringContaining(`Artefact: ${FILE}`),
		});
		expect(v?.additionalContext).toContain("watch-artefact.js");
		expect(v?.additionalContext).toContain("from `sonnet` to `opus`");
		expect(out?.artefact).toBe(FILE);
	});

	it("names no artefact where only the model moved", () => {
		const out = rewrite(
			{ prompt: "Artefact: a/b.md", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		expect(out?.artefact).toBeNull();
	});

	it("leaves the model alone while burn mode is off", () => {
		const out = rewrite(
			{ prompt: "x", model: "sonnet" },
			{ file: FILE, burn: false },
		);
		expect(out?.envelope.hookSpecificOutput.updatedInput).toMatchObject({
			model: "sonnet",
		});
	});

	it("tells the watch on a prompt's own artefact, changing nothing (#2013)", () => {
		const v = rewrite(
			{ prompt: "Artefact: a/b.md", model: "opus" },
			{ file: FILE, burn: true },
		)?.envelope.hookSpecificOutput;
		expect(v).not.toHaveProperty("updatedInput");
		expect(v).not.toHaveProperty("permissionDecision");
		expect(v?.additionalContext).toContain(
			"This dispatch names its artefact: a/b.md.",
		);
		expect(v?.additionalContext).toContain("watch-artefact.js a/b.md 120");
	});

	it("tells an agent with no artefact to watch to end the turn", () => {
		const v = rewrite(
			{ prompt: "Find it.", subagent_type: "Explore" },
			{ file: FILE, burn: false },
		)?.envelope.hookSpecificOutput;
		expect(v?.additionalContext).toMatch(
			/^While this agent runs, end the turn/,
		);
	});

	it.each([
		[
			"a tier the guide routes away from",
			{ model: "haiku" },
			["dispatch-tier"],
		],
		[
			"a tracker-less search of the repo",
			{ prompt: "Search the repo for it." },
			["dispatch-search-tracker"],
		],
		["neither", { model: "sonnet" }, []],
	])("names the rules %s trips", (_n, call, rules) => {
		const out = rewrite(
			{ prompt: "Do it.", ...call },
			{ file: FILE, burn: false },
		);
		expect(out?.rules).toEqual(rules);
	});

	it("judges the tier as asked, before burn mode's remap", () => {
		const out = rewrite(
			{ prompt: "Do it.", model: "sonnet" },
			{ file: FILE, burn: true },
		);
		expect(out?.rules).toEqual([]);
	});

	it.each([
		["a non-object", "x"],
		["null", null],
	])("is null for %s", (_n, input) => {
		expect(rewrite(input, { file: FILE, burn: true })).toBeNull();
	});
});

/** The watch the envelope hands the session for an artefact supplied at `file`. */
const watchCommand = (file: string) =>
	/backgrounded `([^`]+)`/.exec(
		String(
			rewrite({ prompt: "Do it." }, { file, burn: false })?.envelope
				.hookSpecificOutput.additionalContext,
		),
	)?.[1] ?? expect.fail("the envelope names no backgrounded watch");

describe("the watch command", () => {
	it("names the watcher that ships beside this file", () => {
		const watcher = String(
			/^node '?(.*?)'? \S+ 120$/.exec(watchCommand(FILE))?.[1],
		);
		expect(path.basename(watcher)).toBe("watch-artefact.js");
		expect(fs.existsSync(watcher)).toBe(true);
	});

	// The watcher's own path is the checkout's, quoted or not, so only the
	// artefact's half is pinned.
	it("leaves a plain path bare", () => {
		expect(watchCommand(FILE).endsWith(` ${FILE} 120`)).toBe(true);
	});

	it("quotes a path a shell would split, apostrophe included", () => {
		expect(
			watchCommand("/my repo/it's.md").endsWith(` '/my repo/it'\\''s.md' 120`),
		).toBe(true);
	});
});
