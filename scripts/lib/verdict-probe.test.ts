// @vitest-environment node
/*
 * lib/verdict-probe.js — the proof that a declared test command gives the
 * lander a verdict on a red (#5294). Loosen the probe and a command that
 * exits 0 on red, or names no file, stands its commit gate down with nothing
 * behind it; loosen the record and a changed command keeps an old proof.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildStaysLine,
	ensureProof,
	proofState,
	voidProof,
} from "./verdict-probe.js";

const CANARY = "tests/canary.test.ts";
const COMMAND = "./run-tests";

let root: string;
let markers: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-probe-"));
	markers = path.join(root, "markers");
	fs.mkdirSync(markers);
	fs.mkdirSync(path.join(root, "tests"));
	fs.writeFileSync(path.join(root, CANARY), "it fails under the probe\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/* A test command written as a shell script, so the probe runs it for real. */
function command(body: string) {
	fs.writeFileSync(path.join(root, "run-tests"), `#!/bin/sh\n${body}\n`, {
		mode: 0o755,
	});
}

function probe() {
	const s = ensureProof({ root, command: COMMAND, canary: CANARY, markers });
	return s.state === "fresh"
		? { ok: true as const }
		: { ok: false as const, clause: "clause" in s ? s.clause : s.state };
}

const CONFORMING = `if [ -n "$WFC_VERDICT_PROBE" ]; then echo " FAIL  $1 > canary"; exit 1; fi; exit 0`;

describe("the probe", () => {
	it("passes a command that fails the canary under the variable, naming it, and passes it without", () => {
		command(CONFORMING);
		expect(probe()).toEqual({
			ok: true,
		});
	});

	it("fails a command that exits 0 on a red, naming that clause", () => {
		command("exit 0");
		const r = probe();
		expect(r.ok).toBe(false);
		expect(!r.ok && r.clause).toMatch(/exits 0 on a red/);
	});

	it("fails a command that prints no failing-file line, naming that clause", () => {
		command(
			`[ -n "$WFC_VERDICT_PROBE" ] && { echo "1 failed"; exit 1; }; exit 0`,
		);
		const r = probe();
		expect(!r.ok && r.clause).toMatch(/prints no `FAIL <path>`/);
	});

	it("fails a command that ignores its argument and runs other files", () => {
		command(
			`[ -n "$WFC_VERDICT_PROBE" ] && { echo " FAIL  $1"; echo " FAIL  tests/other.test.ts"; exit 1; }; exit 0`,
		);
		const r = probe();
		expect(!r.ok && r.clause).toMatch(
			/does not run the files it is given alone/,
		);
	});

	it("fails a command red without the variable", () => {
		command(`echo " FAIL  $1"; exit 1`);
		const r = probe();
		expect(!r.ok && r.clause).toMatch(/without WFC_VERDICT_PROBE/);
	});
});

describe("the proof record", () => {
	it("reads none where no canary is declared, and says so", () => {
		const s = proofState({ root, command: COMMAND, canary: null, markers });
		expect(s).toEqual({ state: "none" });
		expect(buildStaysLine(s)).toMatch(/no canary declared/);
	});

	it("probes once, then reads fresh until the canary changes", () => {
		command(CONFORMING);
		const at = { root, command: COMMAND, canary: CANARY, markers };
		expect(proofState(at)).toEqual({ state: "stale" });
		expect(ensureProof(at)).toEqual({ state: "fresh" });
		expect(proofState(at)).toEqual({ state: "fresh" });
		fs.appendFileSync(path.join(root, CANARY), "edited\n");
		expect(proofState(at)).toEqual({ state: "stale" });
	});

	it("reads stale once the command text changes", () => {
		command(CONFORMING);
		ensureProof({ root, command: COMMAND, canary: CANARY, markers });
		expect(
			proofState({ root, command: `${COMMAND} --x`, canary: CANARY, markers }),
		).toEqual({ state: "stale" });
	});

	it("reads stale once the npm script a command runs changes", () => {
		const pkg = (script: string) =>
			fs.writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ scripts: { test: script } }),
			);
		pkg(COMMAND);
		const at = { root, command: "npm test --", canary: CANARY, markers };
		/* Seeded pass: the record's key is what is under test, not npm. */
		const run = (_line: string, { env }: { env: NodeJS.ProcessEnv }) =>
			env.WFC_VERDICT_PROBE
				? { code: 1, out: ` FAIL  ${CANARY}` }
				: { code: 0, out: "" };
		expect(ensureProof({ ...at, run })).toEqual({ state: "fresh" });
		pkg(`${COMMAND} --other`);
		expect(proofState(at)).toEqual({ state: "stale" });
	});

	/* A node runner whose verdict a module it requires decides: the shape of
	 * this repo's own, scripts/run-vitest.js and its scripts/lib/ (#5327). */
	function nodeRunner(exitOnRed: number) {
		fs.writeFileSync(
			path.join(root, "runner.js"),
			`process.exit(require("./decide.js")(process.argv[2]));\n`,
		);
		fs.writeFileSync(
			path.join(root, "decide.js"),
			`module.exports = (f) => { if (!process.env.WFC_VERDICT_PROBE) return 0; console.log(" FAIL  " + f); return ${exitOnRed}; };\n`,
		);
		return { root, command: "node runner.js", canary: CANARY, markers };
	}

	it("reprobes a failed record once a module the runner requires is fixed (#5327)", () => {
		const at = nodeRunner(0);
		expect(ensureProof(at).state).toBe("failed");
		nodeRunner(1);
		expect(proofState(at)).toEqual({ state: "stale" });
		expect(ensureProof(at)).toEqual({ state: "fresh" });
	});

	it("reprobes a passed record once a module the runner requires changes (#5327)", () => {
		const at = nodeRunner(1);
		expect(ensureProof(at)).toEqual({ state: "fresh" });
		nodeRunner(0);
		expect(proofState(at)).toEqual({ state: "stale" });
		expect(ensureProof(at).state).toBe("failed");
	});

	it("keeps each runner's verdict beside the others (#5327)", () => {
		const at = nodeRunner(1);
		ensureProof(at);
		nodeRunner(0);
		ensureProof(at);
		nodeRunner(1);
		expect(proofState(at)).toEqual({ state: "fresh" });
	});

	it("reprobes a passed record once a file the runner's config names changes (#5327)", () => {
		const at = nodeRunner(1);
		fs.writeFileSync(
			path.join(root, "vitest.config.ts"),
			`export default { test: { reporters: ["./reporter.ts"] } };\n`,
		);
		fs.writeFileSync(path.join(root, "reporter.ts"), "export default {};\n");
		expect(ensureProof(at)).toEqual({ state: "fresh" });
		fs.appendFileSync(path.join(root, "reporter.ts"), "// prints no FAIL\n");
		expect(proofState(at)).toEqual({ state: "stale" });
	});

	it("keys a runner the command reaches in the core, where the working copy lacks it (#5327)", () => {
		const core = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-core-"));
		vi.stubEnv("WFC_SCRIPT_ROOT", core);
		try {
			fs.writeFileSync(path.join(core, "core-runner.js"), "// v1\n");
			const at = {
				root,
				command: "node core-runner.js",
				canary: CANARY,
				markers,
			};
			const run = (_line: string, { env }: { env: NodeJS.ProcessEnv }) =>
				env.WFC_VERDICT_PROBE
					? { code: 1, out: ` FAIL  ${CANARY}` }
					: { code: 0, out: "" };
			expect(ensureProof({ ...at, run })).toEqual({ state: "fresh" });
			fs.writeFileSync(path.join(core, "core-runner.js"), "// v2\n");
			expect(proofState(at)).toEqual({ state: "stale" });
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(core, { recursive: true, force: true });
		}
	});

	it("reads an unreadable record as stale, never fresh", () => {
		fs.writeFileSync(path.join(markers, "verdict-proof.json"), "{not json");
		expect(
			proofState({ root, command: COMMAND, canary: CANARY, markers }),
		).toEqual({ state: "stale" });
	});

	it("records a failed probe with its clause, and keeps it until the command changes", () => {
		command("exit 0");
		const at = { root, command: COMMAND, canary: CANARY, markers };
		const s = ensureProof(at);
		expect(s.state).toBe("failed");
		expect(proofState(at)).toEqual(s);
		expect(buildStaysLine(s)).toMatch(/the verdict probe failed: it exits 0/);
		expect(buildStaysLine(s)).toMatch(/code-standards-base\.md/);
	});

	it("the lander's backstop marks every passed verdict failed", () => {
		command(CONFORMING);
		const at = { root, command: COMMAND, canary: CANARY, markers };
		ensureProof(at);
		expect(voidProof("npm test exited 1", markers)).toBe(true);
		const s = proofState(at);
		expect(s.state).toBe("failed");
		expect(s.state === "failed" && s.clause).toMatch(/naming no failing file/);
		expect(voidProof("again", markers)).toBe(false);
	});
});
