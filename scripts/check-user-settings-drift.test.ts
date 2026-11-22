// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-user-settings-drift.js");
const FIXTURE = path.resolve(__dirname, "fixtures/model-routing/fixture.json");

const STANDARD = {
	model: "test-haiku-1[1m]",
	modelSettings: {
		"test-haiku-1": { effortLevel: "low" },
		"test-haiku-0": { effortLevel: "low" },
		"test-opus-2": { effortLevel: "high" },
		"test-opus-1": { effortLevel: "high" },
		opusish: { effortLevel: "high" },
	},
};
const BURN = {
	model: "test-sonnet-1[1m]",
	modelSettings: {
		"test-haiku-1": { effortLevel: "max" },
		"test-haiku-0": { effortLevel: "max" },
		"test-opus-2": { effortLevel: "medium" },
		"test-opus-1": { effortLevel: "medium" },
		opusish: { effortLevel: "medium" },
		"test-fable-1": { effortLevel: "xhigh" },
	},
};

const contract = fs.readFileSync(
	path.resolve(__dirname, "..", "docs", "working-contract.md"),
	"utf8",
);
const ruleSections = [
	"Removal means gone",
	"Leading practice",
	"Reports and paid data",
]
	.map((h) => `## ${h}\n${contract.split(`## ${h}\n`)[1]?.split("\n## ")[0]}`)
	.join("\n");

let dir: string;

const doc = (settings: object) =>
	[
		"# Snapshot",
		"",
		"```json",
		JSON.stringify(settings, null, 2),
		"```",
		"",
		"<!-- BEGIN statusline.sh -->",
		"```bash",
		"echo hi",
		"```",
		"<!-- END statusline.sh -->",
		"",
	].join("\n");

const run = (
	docSettings: object,
	liveSettings: object,
	docText = doc(docSettings),
	env: Record<string, string> = {},
) => {
	const docPath = path.join(dir, "snapshot.md");
	const livePath = path.join(dir, "settings.json");
	fs.writeFileSync(docPath, docText);
	fs.writeFileSync(
		livePath,
		JSON.stringify({ ...STANDARD, ...liveSettings }, null, 2),
	);
	const r = runInProcess(SCRIPT, [docPath, livePath], {
		env: {
			...process.env,
			HOME: dir,
			WFC_BURN_MARKER: path.join(dir, "no-burn-marker"),
			WFC_MODEL_ROUTING: FIXTURE,
			...env,
		},
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-drift-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the routed keys, judged against the routing file's current mode", () => {
	const burnOn = () => {
		const marker = path.join(dir, "burn-marker");
		fs.writeFileSync(marker, "");
		return { WFC_BURN_MARKER: marker };
	};

	it("passes live settings holding the standard writes while burn mode is off", () => {
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(0);
		expect(out).toMatch(/^OK:/m);
	});

	it("passes the burn writes while burn mode is on, and reports the standard ones then", () => {
		expect(run({}, BURN, undefined, burnOn()).status).toBe(0);
		const { status, out } = run({}, STANDARD, undefined, burnOn());
		expect(status).toBe(1);
		expect(out).toContain(
			`model: routing file "${BURN.model}" ≠ live "${STANDARD.model}"`,
		);
	});

	it("reports a model other than the mode's", () => {
		const { status, out } = run({}, { model: "hand-set" });
		expect(status).toBe(1);
		expect(out).toContain(
			`model: routing file "${STANDARD.model}" ≠ live "hand-set"`,
		);
	});

	it("reports an effort other than the mode's, an entry it writes that is missing, and one it does not write", () => {
		const { "test-haiku-0": _gone, ...rest } = STANDARD.modelSettings;
		const { status, out } = run(
			{},
			{
				modelSettings: {
					...rest,
					opusish: { effortLevel: "max" },
					"retired-id": { effortLevel: "low" },
				},
			},
		);
		expect(status).toBe(1);
		expect(out).toContain(
			'modelSettings.opusish.effortLevel: routing file "high" ≠ live "max"',
		);
		expect(out).toContain(
			"modelSettings.test-haiku-0: present in routing file, missing from live",
		);
		expect(out).toContain(
			"modelSettings.retired-id: missing from routing file, present in live",
		);
	});

	it("reports a snapshot that still carries model or modelSettings, and judges them only against the routing file", () => {
		const { status, out } = run(
			{ theme: "dark", model: "stale", modelSettings: {} },
			{ theme: "dark" },
		);
		expect(status).toBe(1);
		expect(out).toContain(
			"model: present in doc, which leaves it to the routing file",
		);
		expect(out).toContain(
			"modelSettings: present in doc, which leaves it to the routing file",
		);
		expect(out).not.toContain('"stale"');
	});

	it("still reports drift in another key alongside", () => {
		const { status, out } = run({ theme: "dark" }, { theme: "light" });
		expect(status).toBe(1);
		expect(out).toMatch(/theme/);
		expect(out).not.toMatch(/^\s+- model/m);
	});

	it("is BROKEN where the routing file will not load", () => {
		const broken = path.join(dir, "routing.json");
		fs.writeFileSync(broken, "{");
		const { status, out } = run({}, {}, undefined, {
			WFC_MODEL_ROUTING: broken,
		});
		expect(status).toBe(2);
		expect(out).toContain("the routing file will not load");
	});

	it("exits 0 on drift when --warn is passed, reporting it on a WARN: line", () => {
		const docPath = path.join(dir, "snapshot.md");
		const livePath = path.join(dir, "settings.json");
		fs.writeFileSync(docPath, doc({ theme: "dark" }));
		fs.writeFileSync(livePath, JSON.stringify({ ...STANDARD, theme: "light" }));
		const r = runInProcess(SCRIPT, ["--warn", docPath, livePath], {
			env: { ...process.env, HOME: dir, WFC_MODEL_ROUTING: FIXTURE },
		});
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toMatch(/^WARN:/m);
	});
});

describe("machine copies of shipped files, against their repo sources (#5344)", () => {
	const Sources = [
		["hooks/browser-profile-guard.sh", "scripts/browser-profile-guard.sh"],
		["hooks/practice-guard.sh", "scripts/practice-guard.sh"],
		["practice-crafts.md", "docs/practice-crafts.md"],
	] as const;
	const writeCopy = (live: string, body: string) => {
		const at = path.join(dir, ".claude", live);
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, body);
	};
	const source = (rel: string) =>
		fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

	it.each(Sources)("passes a live %s equal to %s", (live, rel) => {
		writeCopy(live, source(rel));
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(0);
		expect(out).toContain(`${path.basename(live)} equal to ${rel}`);
	});

	it.each(Sources)("reports a live %s one byte off %s", (live, rel) => {
		writeCopy(live, source(rel).replace("e", "f"));
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(1);
		expect(out).toContain(`${path.basename(live)}: `);
		expect(out).toContain(`differs from ${rel}`);
	});

	it("needs no fenced copy of any of them in the snapshot", () => {
		for (const [live, rel] of Sources) writeCopy(live, source(rel));
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(0);
		expect(out).not.toMatch(/has no copy in/);
	});

	it("leaves an absent live copy uncompared", () => {
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(0);
		expect(out).toContain("practice-guard.sh not compared");
	});

	it("is BROKEN where a live copy is there but unreadable", () => {
		fs.mkdirSync(path.join(dir, ".claude", "practice-crafts.md"), {
			recursive: true,
		});
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(2);
		expect(out).toMatch(
			/practice-crafts\.md is unreadable \(.*\): restore it as a readable file, or move it aside, and re-run/,
		);
	});
});

describe("the working-rule sections of the user-level CLAUDE.md (#5344)", () => {
	const head = "# Machine notes\n\nThis machine is a test.\n";
	const withBlock = [
		doc({ theme: "dark" }),
		"<!-- BEGIN CLAUDE.md -->",
		"````markdown",
		head.trimEnd(),
		"````",
		"<!-- END CLAUDE.md -->",
		"",
	].join("\n");
	const writeLive = (body: string) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), body);
	};

	it("passes sections equal to the contract's, the rest held to the doc's block", () => {
		writeLive(`${head}\n${ruleSections}\n`);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
		);
		expect(status).toBe(0);
		expect(out).toContain("working rules equal to docs/working-contract.md");
		expect(out).toMatch(/CLAUDE\.md 3 lines/);
	});

	it("reports a section one byte off the contract's", () => {
		writeLive(
			`${head}\n${ruleSections.replace("as if it never existed", "as if it never existef")}\n`,
		);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
		);
		expect(status).toBe(1);
		expect(out).toMatch(
			/"## Removal means gone" differs from docs\/working-contract\.md/,
		);
	});

	it("reports a section the live file lacks", () => {
		writeLive(
			`${head}\n${ruleSections.replace("## Leading practice", "## Something else")}\n`,
		);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
		);
		expect(status).toBe(1);
		expect(out).toMatch(/has no "## Leading practice" section/);
	});

	it("is BROKEN where the live CLAUDE.md is there but unreadable", () => {
		fs.mkdirSync(path.join(dir, ".claude", "CLAUDE.md"), { recursive: true });
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
		);
		expect(status).toBe(2);
		expect(out).toMatch(/CLAUDE\.md is unreadable/);
	});

	const pluginWith = (make: (at: string) => void) => {
		const root = path.join(dir, "plugin");
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		make(path.join(root, "docs", "working-contract.md"));
		return { WFC_SCRIPT_ROOT: root };
	};

	it("is BROKEN where the contract has lost a section it names", () => {
		writeLive(`${head}\n${ruleSections}\n`);
		const env = pluginWith((at) =>
			fs.writeFileSync(
				at,
				ruleSections.replace("## Leading practice", "## Something else"),
			),
		);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
			env,
		);
		expect(status).toBe(2);
		expect(out).toMatch(
			/docs\/working-contract\.md has no "## Leading practice" section/,
		);
	});

	it("is BROKEN where the contract is there but unreadable", () => {
		writeLive(`${head}\n${ruleSections}\n`);
		const env = pluginWith((at) => fs.mkdirSync(at));
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock,
			env,
		);
		expect(status).toBe(2);
		expect(out).toMatch(/working-contract\.md is unreadable/);
	});
});

describe("the user-level CLAUDE.md's copy (#2174)", () => {
	const notes = [
		"# Machine notes",
		"",
		"## Node heap",
		"",
		"```bash",
		"echo $NODE_OPTIONS",
		"```",
	].join("\n");
	const withBlock = (body: string) =>
		[
			doc({ theme: "dark" }),
			"<!-- BEGIN CLAUDE.md -->",
			"````markdown",
			body,
			"````",
			"<!-- END CLAUDE.md -->",
			"",
		].join("\n");
	const writeLive = (body: string) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "CLAUDE.md"),
			`${body}\n${ruleSections}\n`,
		);
	};

	it("matches a live file holding fences and headings identical to the doc's copy", () => {
		writeLive(`${notes}\n`);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(0);
		expect(out).toMatch(/CLAUDE\.md 7 lines/);
	});

	it("reports one changed byte in the live file", () => {
		writeLive(`${notes.replace("heap", "heaq")}\n`);
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(1);
		expect(out).toMatch(/CLAUDE\.md: doc copy differs .*line 3/);
	});

	it("reports a snapshot predating the block as drift, not broken", () => {
		writeLive(`${notes}\n`);
		const { status, out } = run({ theme: "dark" }, { theme: "dark" });
		expect(status).toBe(1);
		expect(out).toMatch(/CLAUDE\.md: .* has no copy in/);
	});

	it("leaves the copy uncompared where the live file is absent", () => {
		const { status, out } = run(
			{ theme: "dark" },
			{ theme: "dark" },
			withBlock(notes),
		);
		expect(status).toBe(0);
		expect(out).toMatch(/CLAUDE\.md absent \(not compared\)/);
	});
});

describe("the snapshot path with no argument (#447)", () => {
	const runHost = (config?: object) => {
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		if (config)
			fs.writeFileSync(
				path.join(dir, ".claude", "workflow-core.json"),
				JSON.stringify(config),
			);
		fs.writeFileSync(
			path.join(dir, ".claude", "settings.json"),
			JSON.stringify({ ...STANDARD, theme: "dark" }),
		);
		const r = runInProcess(SCRIPT, [], {
			cwd: dir,
			env: {
				...process.env,
				HOME: dir,
				CLAUDE_PROJECT_DIR: dir,
				WFC_MODEL_ROUTING: FIXTURE,
			},
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	};
	const place = (rel: string) => {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), doc({ theme: "dark" }));
	};

	it("reads the default path where none is declared", () => {
		place("docs/claude-user-settings.md");
		const { status, out } = runHost();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: docs\/claude-user-settings\.md matches/m);
	});

	it("skips where none is declared and the default is absent", () => {
		const { status, out } = runHost();
		expect(status).toBe(0);
		expect(out).toMatch(
			/^SKIP: this repo has no docs\/claude-user-settings\.md/m,
		);
	});

	it("reads the host's declared userSettingsSnapshotPath", () => {
		place("docs/machinery/claude-user-settings.md");
		const { status, out } = runHost({
			userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
		});
		expect(status).toBe(0);
		expect(out).toMatch(
			/^OK: docs\/machinery\/claude-user-settings\.md matches/m,
		);
	});

	it("reports a declared path that does not exist as broken, not a skip", () => {
		const { status, out } = runHost({
			userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
		});
		expect(status).toBe(2);
		expect(out).not.toMatch(/^SKIP/m);
		expect(out).toContain("docs/machinery/claude-user-settings.md not found");
		expect(out).toContain("userSettingsSnapshotPath");
	});

	it("reports a refused declaration as broken, not a skip of the default", () => {
		const { status, out } = runHost({
			userSettingsSnapshotPath: "/abs/claude-user-settings.md",
		});
		expect(status).toBe(2);
		expect(out).not.toMatch(/^SKIP/m);
		expect(out).toContain(
			'"userSettingsSnapshotPath" is not a repo-relative path',
		);
	});
});
