// @vitest-environment node

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	cutGateScript,
	expectFixtureSupplies,
	registerTempCleanup,
	stagedRepo,
	writeFiles,
} from "./lib/precommit-gate-harness";

const CHECKER = "scripts/check-superseded-values.js";
const MAP = "docs/doc-map.md";
const NEEDLES = "docs/doc-map-superseded.json";

const gateFragment = () => cutGateScript("--broken-only");

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-CHECK-RAN";

function fixture(opts: {
	staged: Record<string, string>;
	dirty?: Record<string, string>;
	checkerExit: number;
	seed?: Record<string, string>;
}): string {
	const checker =
		`const fs = require("node:fs");\n` +
		`console.log("${STUB_MARKER} " + fs.readFileSync(process.argv[2], "utf8").trim());\n` +
		`process.exit(${opts.checkerExit});\n`;
	const { root } = stagedRepo(
		"superseded-gate-",
		temps,
		{ [CHECKER]: checker, ...opts.seed },
		opts.staged,
	);
	writeFiles(root, opts.dirty ?? {});
	return root;
}

function runGate(cwd: string): { code: number; output: string } {
	try {
		return {
			code: 0,
			output: execFileSync(
				"sh",
				[
					"-c",
					`{ ${gateFragment()}
} 2>&1`,
				],
				{
					cwd,
					env: { ...process.env, WFC_PLUGIN_ROOT: "" },
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		};
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

describe("the pre-commit superseded-needle gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(gateFragment()).toContain(CHECKER);
		expect(gateFragment()).toContain("--broken-only");
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies("--broken-only", [CHECKER]);
	});

	it("does not run when the commit stages neither doc-map file", () => {
		const r = runGate(
			fixture({
				seed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
				staged: { "app/page.tsx": "x\n" },
				checkerExit: 2,
			}),
		);
		expect(r.code).toBe(0);
		expect(r.output).toBe("");
	});

	it("runs, and stays silent, when the staged map is sound", () => {
		const r = runGate(
			fixture({
				staged: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
				checkerExit: 0,
			}),
		);
		expect(r.code).toBe(0);
		expect(r.output).toBe("");
	});

	it("refuses the commit and names the fix when the checker is BROKEN", () => {
		const r = runGate(
			fixture({
				staged: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
				checkerExit: 2,
			}),
		);
		expect(r.code).toBe(1);
		expect(r.output).toContain(STUB_MARKER);
		expect(r.output).toContain("whose needles are the\n  values it supersedes");
	});

	it("fires on a commit staging only the needle file", () => {
		const r = runGate(
			fixture({
				seed: { [MAP]: "map\n" },
				staged: { [NEEDLES]: "{}\n" },
				checkerExit: 2,
			}),
		);
		expect(r.code).toBe(1);
		expect(r.output).toContain(STUB_MARKER);
	});

	it("feeds the staged blob, never the working tree", () => {
		const r = runGate(
			fixture({
				staged: { [MAP]: "STAGED-BYTES\n", [NEEDLES]: "{}\n" },
				dirty: { [MAP]: "NEIGHBOURS-HALF-SAVED-BYTES\n" },
				checkerExit: 2,
			}),
		);
		expect(r.output).toContain("STAGED-BYTES");
		expect(r.output).not.toContain("NEIGHBOURS-HALF-SAVED");
	});

	it("warns and passes when the map is not in the index", () => {
		const r = runGate(
			fixture({ staged: { [NEEDLES]: "{}\n" }, checkerExit: 2 }),
		);
		expect(r.code).toBe(0);
		expect(r.output).toContain("skipped the superseded-needle check");
		expect(r.output).not.toContain(STUB_MARKER);
	});
});
