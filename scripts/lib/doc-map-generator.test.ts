// @vitest-environment node
/*
 * The shared helper's own suite: parseCliArgs and claimDataFile in isolation.
 * Everything that must go through a spawned generator CLI — the wiring that
 * calls claimDataFile at all — stays in each generator's own *.test.ts.
 *
 * Extracted at mantahostels#1596, after each generator's own copy drifted.
 * Those generators write docs/doc-map.md and its sidecar through this claim,
 * so a loosened case lets one write over a live session's doc-map edit, or
 * lose the record of why its claim failed.
 */

import { describe, expect, it, vi } from "vitest";
import { claimDataFile, parseCliArgs } from "./doc-map-generator";

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
	/* Fails open (mantahostels#1194): a claim the arbiter refuses costs the content record
	 * and nothing else, and is never grounds to stop the write. This is the
	 * shape check-instruction-surface.js's rebaseline wants. */
	it("fails open by default, printing why the record was lost", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {
			/* kept off the test output; the spy reads it */
		});
		const result = claimDataFile("docs/doc-map-classes.json", {
			claimCmd: "false",
		});
		expect(result.ok).toBe(true);
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("could not claim docs/doc-map-classes.json"),
		);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("Writing anyway"));
		spy.mockRestore();
	});

	/* register-doc.js's case: the row it writes is authored, not a derived
	 * count, so a held file is refused rather than overwritten. */
	it("fails closed when asked to, naming the file it cannot claim, without the fail-open wording", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {
			/* kept off the test output; the spy reads it */
		});
		const result = claimDataFile("docs/doc-map-superseded.json", {
			claimCmd: "false",
			failClosed: true,
		});
		expect(result.ok).toBe(false);
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("cannot claim docs/doc-map-superseded.json"),
		);
		expect(spy).not.toHaveBeenCalledWith(
			expect.stringContaining("Writing anyway"),
		);
		spy.mockRestore();
	});

	it("reports ok on a successful claim, in either mode", () => {
		expect(claimDataFile("x.json", { claimCmd: "true" }).ok).toBe(true);
		expect(
			claimDataFile("x.json", { claimCmd: "true", failClosed: true }).ok,
		).toBe(true);
	});
});
