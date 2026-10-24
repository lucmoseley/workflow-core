// @vitest-environment node
/*
 * The pre-commit superseded-needle gate (mantahostels#861).
 *
 * `.husky/pre-commit` runs check-superseded-values.js --broken-only when the
 * commit stages the doc map or its needle file, feeding it STAGED blobs rather
 * than the working tree.
 *
 * Each case runs the gate fragment cut from the real hook in a throwaway repo,
 * with a stubbed checker that echoes the map it was handed, so a case proves
 * which bytes — staged or working tree — reached it.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a doc map whose
 * needle data is BROKEN lands, so the superseded-figure scan finds nothing and
 * a retired figure stays live unreported.
 */

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

// Anchored on the mode flag, which is what makes this invocation the gate.
const gateFragment = () => cutGateScript("--broken-only");

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-CHECK-RAN";

/**
 * A repo with one commit and a stubbed checker. The stub echoes the map file it
 * was handed, so a test can prove WHICH bytes reached it.
 */
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
	// Written AFTER staging, so the index and the tree deliberately disagree.
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
					// Unset, as in the core: set, the hint names the plugin's copy.
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

	/* The map is seeded so the gate COULD run here: without it the hook falls into
	 * the not-in-the-index skip and this passes however broken the scoping is. */
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

	/* Exit 2, because the hook swallows a passing checker's output into `sv_out`
	 * — the failure replay is the only place the stub is observable. */
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

	/* A map absent from the index is apparatus, not a finding: warn and pass,
	 * leaving it to CI, rather than leaving a legitimate deletion uncommittable. */
	it("warns and passes when the map is not in the index", () => {
		const r = runGate(
			fixture({ staged: { [NEEDLES]: "{}\n" }, checkerExit: 2 }),
		);
		expect(r.code).toBe(0);
		expect(r.output).toContain("skipped the superseded-needle check");
		expect(r.output).not.toContain(STUB_MARKER);
	});
});
