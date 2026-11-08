// @vitest-environment node
/*
 * The shared helper's own suite: parseCliArgs and claimDataFile in isolation,
 * the contended case against the real arbiter in the testkit sandbox.
 * Everything that must go through a spawned generator CLI — the wiring that
 * calls claimDataFile at all — stays in each generator's own *.test.ts.
 *
 * Extracted at mantahostels#1596, after each generator's own copy drifted.
 * Those generators write docs/doc-map.md and its sidecar through this claim,
 * so a loosened case lets one write over a live session's doc-map edit, or
 * lose the record of why its claim failed.
 */

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { arbiterCli, freshSandbox, live } from "./arbiter-testkit";
import { claimDataFile, parseCliArgs } from "./doc-map-generator";
import { restoreStderr, spyStderr } from "./write-fd-testkit";

describe("parseCliArgs", () => {
	it("treats a bare argument as positional", () => {
		expect(parseCliArgs(["docs/doc-map.md"]).args).toEqual(["docs/doc-map.md"]);
	});

	it("skips a value flag and the value that follows it", () => {
		const { args } = parseCliArgs([
			"docs/doc-map.md",
			"--data-dir",
			"elsewhere",
			"--claim-cmd",
			"/bin/true",
		]);
		expect(args).toEqual(["docs/doc-map.md"]);
	});

	it("reads a bare flag and a value flag's value", () => {
		const { flag, value } = parseCliArgs(["--no-claim", "--data-dir", "x"]);
		expect(flag("--no-claim")).toBe(true);
		expect(flag("--check")).toBe(false);
		expect(value("--data-dir")).toBe("x");
		expect(value("--claim-cmd")).toBe(null);
	});
});

describe("claimDataFile", () => {
	const sb = freshSandbox();

	/* Fails open (mantahostels#1194): a claim the arbiter refuses costs the content record
	 * and nothing else, and is never grounds to stop the write. This is the
	 * shape check-instruction-surface.js's rebaseline wants. */
	it("fails open by default, printing why the record was lost", () => {
		const write = spyStderr();
		const result = claimDataFile("docs/doc-map-classes.json", {
			claimCmd: "false",
		});
		restoreStderr();
		const said = write.mock.calls.map((c) => c[0]).join("");
		expect(result.claimed).toBe(false);
		expect(said).toContain("could not claim docs/doc-map-classes.json");
		expect(said).toContain("Writing anyway");
	});

	it("passes on the arbiter's warning where a live neighbour holds the file too (#4403)", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "map-writer");
		const file = path.join(sb.repo, "docs/doc-map-classes.json");
		live(sb, "map-holder");
		expect(arbiterCli(sb).cli(["claim", file, "map-holder"]).status).toBe(0);
		const write = spyStderr();
		const result = claimDataFile(file);
		restoreStderr();
		const said = write.mock.calls.map((c) => c[0]).join("");
		expect(result.claimed).toBe(true);
		expect(said).toContain("is also held by session");
		expect(said).toContain("map-holder");
	});
});
