// @vitest-environment node
/*
 * The two dispatch rules lib/dispatch-rules.js detects (#2013); the hook's
 * splice of each fragment is tested in ../guard-dispatch-rewrite.test.ts.
 */

import { describe, expect, it } from "vitest";
import { tierDeparture, untrackedSearch } from "./dispatch-rules";

describe("tierDeparture", () => {
	it.each([
		["no model", {}],
		["sonnet", { model: "sonnet" }],
		[
			"the code reviewer on opus",
			{ model: "opus", subagent_type: "code-reviewer" },
		],
		[
			"an adopter's code reviewer on opus",
			{ model: "opus", subagent_type: "workflow-core:code-reviewer" },
		],
	])("is null for %s", (_n, call) => {
		expect(tierDeparture(call, false)).toBeNull();
	});

	it.each([
		["haiku", { model: "haiku" }, "`haiku`, a departure"],
		["fable", { model: "fable" }, "`fable`, a departure"],
		["opus outside the reviewer", { model: "opus" }, "unless it is one of"],
		[
			"the code reviewer off opus",
			{ model: "sonnet", subagent_type: "code-reviewer" },
			"for the code reviewer",
		],
		[
			"a model on a fork",
			{ model: "sonnet", subagent_type: "fork" },
			"on a fork",
		],
	])("names %s", (_n, call, said) => {
		expect(tierDeparture(call, false)).toContain(said);
	});

	it("leaves opus alone under burn mode, which asks for it", () => {
		expect(tierDeparture({ model: "opus" }, true)).toBeNull();
		expect(
			tierDeparture({ model: "sonnet", subagent_type: "code-reviewer" }, true),
		).toBeNull();
		expect(tierDeparture({ model: "haiku" }, true)).not.toBeNull();
	});
});

describe("untrackedSearch", () => {
	it.each([
		"Search the repo for every caller.",
		"grep the whole codebase for the figure",
		"Sweep across the repository and report.",
		"searching this repo for the term",
	])("names %j", (prompt) => {
		expect(untrackedSearch({ prompt })).not.toBeNull();
	});

	it.each([
		[
			"a search that names the tracker",
			"Search the repo and the tracker for it.",
		],
		[
			"one that runs gh issue",
			"Search the repo, then `gh issue list --search x`.",
		],
		[
			"one that names closed issues",
			"Search the repository and closed issues.",
		],
		["a prompt that only mentions the repo", "Read the repo's README."],
		["no prompt", undefined],
	])("is null for %s", (_n, prompt) => {
		expect(untrackedSearch({ prompt })).toBeNull();
	});
});
