// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDocMapGate } from "./doc-map-gate.js";
import { fakeGatePorts, type GateScene } from "./doc-map-gate-fake";
import { realPorts } from "./doc-map-gate-ports.js";
import { readText } from "./file-read.js";
import { defineTemplate, mkScratchDir } from "./git-fixture";

const MAP = "docs/doc-map.md";

const seeded = defineTemplate((root) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, MAP), "map\n");
	fs.writeFileSync(path.join(root, "docs", "note.md"), "note\n");
	git("add", "--", "docs");
	git("commit", "-qm", "seed");
});

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

interface RealScene {
	arrange: (git: (...args: string[]) => void, root: string) => void;
	scene: GateScene;
}

const check = (status: number, report: string) => ({ status, report });
const faults = (status: number, stdout: string, stderr = "") => ({
	status,
	stdout,
	stderr,
});

function stubCheckers(root: string, scene: GateScene) {
	const scripts = path.join(root, "scripts");
	fs.mkdirSync(scripts, { recursive: true });
	const run = scene.check ?? check(0, "");
	fs.writeFileSync(
		path.join(scripts, "check-doc-map.js"),
		`const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.log"))}, JSON.stringify({ json: a.includes("--json"), dirty: a.includes("--map-dirty"), index: process.env.GIT_INDEX_FILE !== undefined }) + "\\n");
if (a.includes("--json")) { console.log("{}"); process.exit(0); }
process.stdout.write(${JSON.stringify(run.report)});
process.exit(${run.status});
`,
	);
	const nf = scene.newFaults ?? faults(1, "dead: docs/new-fault.md\n");
	fs.writeFileSync(
		path.join(scripts, "checker-new-faults.js"),
		`process.stdout.write(${JSON.stringify(nf.stdout)});
process.stderr.write(${JSON.stringify(nf.stderr)});
process.exit(${nf.status});
`,
	);
}

function overRealPorts(real: RealScene, allowDelete = false) {
	const root = mkScratchDir("doc-map-gate-contract-");
	temps.push(root);
	seeded.instantiate(root);
	const git = (...args: string[]) => {
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	};
	real.arrange(git, root);
	stubCheckers(root, real.scene);
	const made: string[] = [];
	try {
		const verdict = runDocMapGate(
			realPorts(path.join(root, "scripts"), made, {
				cwd: root,
				env: process.env,
			}),
			{ allowDelete },
		);
		const log = path.join(root, "calls.log");
		const logged = readText(log);
		if (logged.state === "unreadable") throw new Error(logged.message);
		const calls = (logged.state === "read" ? logged.data : "")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		return { verdict, calls };
	} finally {
		for (const d of made) fs.rmSync(d, { recursive: true, force: true });
	}
}

function overFake(scene: GateScene, allowDelete = false) {
	const { ports, calls } = fakeGatePorts(scene);
	const verdict = runDocMapGate(ports, { allowDelete });
	return {
		verdict,
		calls: calls.map((c) => ({
			json: c.json,
			dirty: c.args.includes("--map-dirty"),
			index: c.indexFile !== undefined,
		})),
	};
}

const SCENES: Record<string, RealScene> = {
	"passes silently, building no baseline, when the check passes": {
		arrange: (git, root) => {
			fs.writeFileSync(path.join(root, "docs", "note.md"), "edited\n");
			git("add", "--", "docs/note.md");
		},
		scene: { check: check(0, "OK: doc map covers everything\n") },
	},
	"passes on inheritance, comparing against HEAD's baseline": {
		arrange: (git, root) => {
			fs.writeFileSync(path.join(root, "docs", "note.md"), "edited\n");
			git("add", "--", "docs/note.md");
		},
		scene: {
			check: check(1, "FAIL: dead entry\n"),
			newFaults: faults(0, ""),
		},
	},
	"refuses an added fault, replaying the comparison's stderr as diagnostics": {
		arrange: (git, root) => {
			fs.writeFileSync(path.join(root, "docs", "note.md"), "edited\n");
			git("add", "--", "docs/note.md");
		},
		scene: {
			check: check(1, "FAIL: dead entry\n"),
			newFaults: faults(1, "dead: docs/x.md\n", "a warning\n"),
		},
	},
	"flags a map that differs from HEAD as dirty to the staged runs": {
		arrange: (git, root) => {
			fs.writeFileSync(path.join(root, MAP), "map, mid-edit\n");
			git("add", "--", MAP);
		},
		scene: { mapDiffStatus: 1, check: check(1, "FAIL\n") },
	},
	"refuses with no baseline when HEAD's tree lacks the map": {
		arrange: (git) => {
			git("rm", "-q", "--cached", "--", MAP);
			git("commit", "-qm", "drop the map");
			git("add", "--", MAP);
		},
		scene: {
			headHoldsMap: false,
			mapDiffStatus: 1,
			check: check(1, "FAIL\n"),
		},
	},
	"refuses with no baseline when HEAD is unborn": {
		arrange: (git) => git("update-ref", "-d", "HEAD"),
		scene: { headUnborn: true, mapDiffStatus: 128, check: check(1, "FAIL\n") },
	},
	"refuses a staged deletion of the map before any check": {
		arrange: (git) => git("rm", "-q", "--cached", "--", MAP),
		scene: { mapInIndex: false, deletion: { ok: true, deleted: true } },
	},
	"skips with a warning when the map was never in the index": {
		arrange: (git, root) => {
			git("rm", "-q", "--cached", "--", MAP);
			git("commit", "-qm", "drop the map");
			fs.rmSync(path.join(root, MAP));
			fs.writeFileSync(path.join(root, "docs", "note.md"), "edited\n");
			git("add", "--", "docs/note.md");
		},
		scene: { mapInIndex: false },
	},
	"skips with a warning when the index will not extract": {
		arrange: (git) =>
			git("update-index", "--cacheinfo", `100644,${"1".repeat(40)},${MAP}`),
		scene: { extracts: false },
	},
	"refuses an untracked row this commit adds, reading HEAD's map": {
		arrange: (git, root) => {
			fs.writeFileSync(path.join(root, "docs", "note.md"), "edited\n");
			git("add", "--", "docs/note.md");
		},
		scene: {
			check: check(
				0,
				"1 doc-map register entr(ies) name a file present on disk but not yet tracked by git:\n  docs/fresh.md\n\nCommit the file, or drop the entry.\n",
			),
			headMap: "map",
		},
	},
};

describe("the doc-map gate's fake answers as its production ports do", () => {
	for (const [name, real] of Object.entries(SCENES))
		it(name, () => {
			const got = overRealPorts(real);
			const want = overFake(real.scene);
			expect(got.verdict).toEqual(want.verdict);
			expect(got.calls).toEqual(want.calls);
		});

	it("lets a staged deletion of the map through when the escape is set", () => {
		const real =
			SCENES["refuses a staged deletion of the map before any check"];
		const got = overRealPorts(real, true);
		expect(got.verdict).toEqual(overFake(real.scene, true).verdict);
	});
});
