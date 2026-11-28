// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPluginRecord } from "./plugin-record.js";

describe("the url source's provenance sha (#5826)", () => {
	let root: string;
	let configDir: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-record-root-"));
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-record-cfg-"));
		fs.mkdirSync(path.join(configDir, "plugins"));
		fs.mkdirSync(path.join(root, ".claude"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(configDir, { recursive: true, force: true });
	});
	const rows = (...list: [string, string, string][]) =>
		fs.writeFileSync(
			path.join(configDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"workflow-core@wc": list.map(([projectPath, version, sha]) => ({
						projectPath,
						installPath: "/installed",
						version,
						gitCommitSha: sha,
					})),
				},
			}),
		);
	const file = (rel: string, text: string) =>
		fs.writeFileSync(path.join(root, ".claude", rel), text);
	const line = (ref: string, sha: string) =>
		`\n## Plugin provenance\n\n- url source, ref ${ref}, HEAD ${sha}\n`;
	const recordedFor = (ref: string) => {
		const record = readPluginRecord(
			{ source: "url", url: "https://example.invalid/wc.git", ref },
			{ root, pluginName: "workflow-core", marketplace: "wc", configDir },
		);
		return record.source === "url" ? record.resolvedSha : undefined;
	};

	it("takes the sha every other checkout's row records where this repo's row is another release", () => {
		rows(
			[root, "1.2.0", "n3w"],
			["/wt-a", "1.1.0", "0ld"],
			["/wt-b", "1.1.0", "0ld"],
		);
		expect(recordedFor("v1.1.0")).toBe("0ld");
	});

	it("takes none where other checkouts' rows disagree", () => {
		rows(["/wt-a", "1.1.0", "0ld"], ["/wt-b", "1.1.0", "f0rk"]);
		expect(recordedFor("v1.1.0")).toBeNull();
	});

	it("keeps the sha the core-owned reference file records for the ref", () => {
		file(
			"workflow-core.reference.md",
			`<!-- CORE-OWNED. x -->\n${line("v1.1.0", "kept")}`,
		);
		expect(recordedFor("v1.1.0")).toBe("kept");
		expect(recordedFor("v1.2.0")).toBeNull();
	});

	it("reads the rules file's line where the reference file is not the core's", () => {
		file(
			"workflow-core.reference.md",
			`# hand-written\n${line("v1.1.0", "theirs")}`,
		);
		file(
			"workflow-core.md",
			`<!-- CORE-OWNED. x -->\n${line("v1.1.0", "kept")}`,
		);
		expect(recordedFor("v1.1.0")).toBe("kept");
	});

	it("keeps no recorded sha for a branch ref, whose head may have moved", () => {
		file(
			"workflow-core.reference.md",
			`<!-- CORE-OWNED. x -->\n${line("main", "kept")}`,
		);
		expect(recordedFor("main")).toBeNull();
	});
});
