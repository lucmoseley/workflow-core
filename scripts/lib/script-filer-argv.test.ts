// @vitest-environment node
/*
 * lib/script-filer-argv.js: the file-issue.js argv every script filer builds.
 */
import { describe, expect, it } from "vitest";
import { buildScriptFilerArgv } from "./script-filer-argv.js";

describe("buildScriptFilerArgv", () => {
	it("places a parented filing, declares no fault and names its lists", () => {
		expect(
			buildScriptFilerArgv({
				title: "T",
				labels: ["takes:implement", "kind:ticket"],
				placement: { parent: 12 },
				origin: "lander-script",
				distinctFrom: [3, 4],
				sizeLineChecked: [5],
			}),
		).toEqual([
			"--title",
			"T",
			"--label",
			"takes:implement",
			"--label",
			"kind:ticket",
			"--parent",
			"12",
			"--origin",
			"lander-script",
			"--no-fault",
			"--distinct-from",
			"3,4",
			"--size-line-checked",
			"5",
			"--body-file",
			"-",
		]);
	});

	it("leaves out empty lists and takes a standalone reason and body file", () => {
		expect(
			buildScriptFilerArgv({
				title: "T",
				labels: ["takes:triage"],
				placement: { standalone: "why" },
				origin: "incident",
				distinctFrom: [],
				bodyFile: "/b.md",
			}),
		).toEqual([
			"--title",
			"T",
			"--label",
			"takes:triage",
			"--standalone",
			"why",
			"--origin",
			"incident",
			"--no-fault",
			"--body-file",
			"/b.md",
		]);
	});
});
