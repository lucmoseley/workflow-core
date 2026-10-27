// @vitest-environment node
/*
 * lib/core-deny-text.js's contract (#3001): what a Node guard core's source
 * says it can refuse with, read without loading it, and the core an entry
 * runs. In-process over source strings, the function being pure. A text it
 * misses is a reprinted rule check-guard-registry.js never warns of; a text it
 * invents is a warning that pushes a session to cut a load-bearing rule.
 */

import { describe, expect, it } from "vitest";
import { coreDenyTexts, decideModule } from "./core-deny-text.js";

const core = (...lines: string[]) => coreDenyTexts(lines.join("\n"));

describe("coreDenyTexts", () => {
	it("reads a REASON or *_REASON constant", () => {
		expect(
			core(
				'const REASON = "plain refusal";',
				"const NOOP_REASON = `noop refusal`;",
				'const HINT = "not a reason";',
			),
		).toEqual(["plain refusal", "noop refusal"]);
	});

	it("reads a literal inside a deny: value, and the strings bound to a name it mentions", () => {
		expect(
			core(
				'const FORK = "no forks";',
				"const decide = (ctx) =>",
				'\tctx.fork ? { deny: ctx.corePaths(FORK) } : { deny: "inline refusal" };',
			),
		).toEqual(["no forks", "inline refusal"]);
	});

	it("reads the arguments of a deny(…) call, guard-verdict's refusal", () => {
		expect(
			core(
				"function judge(run, seg) {",
				'\tdeny(run.ctx, seg, "called refusal");',
				"}",
			),
		).toEqual(["called refusal"]);
	});

	it("follows a function the site calls into its body", () => {
		expect(
			core(
				"function refusal(name) {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
				"\treturn `Refused: ${name} is scratch.`;",
				"}",
				"const decide = (n) => ({ deny: refusal(n) });",
			),
		).toEqual(["Refused:   is scratch."]);
	});

	it("follows an arrow whose body is a bare template", () => {
		expect(
			core(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
				"const why = (\n\tcard,\n) => `card ${card} is not called`;",
				"function judge(ctx, seg, card) { deny(ctx, seg, why(card)); }",
			),
		).toEqual(["card   is not called"]);
	});

	it("reads each call of a function whose body denies as a site of its own", () => {
		expect(
			core(
				"const refuse = (text, seg) => ({ deny: splice(seg, text) });",
				'const decide = (c) => (c.npm ? refuse("use the wrapper", c.seg) : null);',
			),
		).toEqual(["use the wrapper"]);
	});

	it("fills a template placeholder from the name's first bound string", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test, not a template
			core('const SLOT = "end the turn";', "const REASON = `Stop: ${SLOT}.`;"),
		).toEqual(["Stop: end the turn."]);
	});

	it("reads no text from a warning, a comment or a string no site reaches", () => {
		expect(
			core(
				"/* deny: `commented refusal` */",
				'const decide = () => ({ warn: "only a warning" });',
				'const label = "unrelated";',
			),
		).toEqual([]);
	});

	it("is not derailed by a regex literal holding a backtick (#3001)", () => {
		expect(
			core(
				"const shelly = (s) => /[$`]/.test(s);",
				"/* a comment with a ` in it */",
				'const decide = () => ({ deny: "after the regex" });',
			),
		).toEqual(["after the regex"]);
	});
});

describe("decideModule", () => {
	it("names the module an entry takes decide from", () => {
		expect(
			decideModule(
				[
					'const { run } = require("./lib/guard-entry.js");',
					'const { decide, field } = require("./lib/agent-poll.js");',
					"run({ field, decide });",
				].join("\n"),
			),
		).toBe("./lib/agent-poll.js");
	});

	it("is null for a guard that runs no core", () => {
		expect(decideModule('const fs = require("node:fs");')).toBeNull();
	});
});
