// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitAll, freshSandbox, gitRepo } from "./lib/arbiter-testkit";
import { stubLaunch } from "./lib/suite-handoff-testkit";
import { runTeardown, setup, teardown } from "./vitest-tree-watch";

const markerLib = require("./lib/test-pass-marker.js");
const { FAIL_STORE } = markerLib;
const { fillRunReport, takeRunReport } = require("./lib/suite-handoff.js");

const sb = freshSandbox(() => {
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
});

function sandboxTree() {
	const tree = { sha: "" };
	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(path.join(sb.repo, "seed.txt"), "seed\n");
		commitAll(sb);
		tree.sha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		setup({ config: { root: sb.repo } });
	});
	afterEach(() => {
		setup({ config: { root: process.cwd() } });
	});
	return tree;
}

function captureStderr(fn: () => void) {
	const err: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		fn();
	} finally {
		process.stderr.write = original;
	}
	return err.join("");
}

describe("a run whose verdict nobody observed (mantahostels#1942)", () => {
	const failStore = markerLib.storePath(
		markerLib.repoRoot(path.dirname(__filename)) ?? ".",
		FAIL_STORE,
	);

	it("records no red marker when the reporter never ran", () => {
		const lines = () => {
			try {
				return fs.readFileSync(failStore, "utf8").split("\n").length;
			} catch {
				return 0;
			}
		};

		const before = lines();
		expect(() => teardown()).not.toThrow();
		expect(lines()).toBe(before);
	});
});

describe("a red run's timing (mantahostels#2182)", () => {
	sandboxTree();
	let redSandbox: string;

	beforeEach(() => {
		redSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tree-watch-red-"));
	});

	afterEach(() => {
		takeRunReport();
		fs.rmSync(redSandbox, { recursive: true, force: true });
	});

	it("writes startedAt/durationMs from the run's own clock, not the write time", () => {
		const startedAtMs = Date.now() - 600_000;
		fillRunReport({
			startedAtMs,
			endedAtMs: startedAtMs + 5000,
			elapsedMs: 5000,
			outcome: false,
		});

		runTeardown(redSandbox);

		const [marker] = markerLib.readFailures({ root: redSandbox });
		expect(marker.startedAt).toBe(new Date(startedAtMs).toISOString());
		expect(marker.durationMs).toBe(5000);
	});
});

describe("a red run's failures already red on its base (#3624)", () => {
	const tree = sandboxTree();
	const test = "scripts/a.test.ts";
	const scope = (file: string) => ({
		modulesRun: 1,
		modulesTotal: 9,
		tests: 1,
		skipped: 0,
		failures: [{ file, tests: ["t"] }],
	});

	afterEach(() => {
		takeRunReport();
	});

	it("names on stderr the failure an earlier red at the base's tree already shows", () => {
		const base = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		markerLib.recordFailure(
			{
				sha: base,
				at: "2026-01-01T00:00:00.000Z",
				treeAtEnd: tree.sha,
				closure: [test],
				scope: scope(path.join(sb.repo, test)),
			},
			{ root: sb.repo },
		);
		fillRunReport({
			outcome: false,
			scope: scope(path.join(sb.repo, test)),
			attestation: { closure: [test], selected: [test], base },
		});

		const err = captureStderr(() => runTeardown(sb.repo));

		expect(err).toContain(
			`ALREADY RED on the base ${base.slice(0, 12)} (#3624):\n    ${test} — by the red store's run at ${base.slice(0, 12)}`,
		);
	});
});

describe("isolated/treeAtEnd on the write path (mantahostels#2210)", () => {
	const tree = sandboxTree();
	let markerSandbox: string;

	beforeEach(() => {
		markerSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tree-watch-iso-"));
	});

	afterEach(() => {
		takeRunReport();
		fs.rmSync(markerSandbox, { recursive: true, force: true });
	});

	it("stamps a certificate with isolated:true and a real treeAtEnd sha", () => {
		stubLaunch({ isolated: true });
		fillRunReport({ outcome: true });

		runTeardown(markerSandbox);

		const [marker] = markerLib.readMarkers({ root: markerSandbox });
		expect(marker.isolated).toBe(true);
		expect(marker.treeAtEnd).toBe(tree.sha);
	});

	it("stamps the launch's argv off the launch record, on the certificate and the red marker alike (#1491)", () => {
		stubLaunch({ argv: ["--full=coverage"] });
		fillRunReport({ outcome: true });
		runTeardown(markerSandbox);
		fillRunReport({ outcome: false });
		runTeardown(markerSandbox);

		expect(markerLib.readMarkers({ root: markerSandbox })[0].argv).toEqual([
			"--full=coverage",
		]);
		expect(markerLib.readFailures({ root: markerSandbox })[0].argv).toEqual([
			"--full=coverage",
		]);
	});

	it("stamps the closure the reporter handed over, on the certificate and the red marker alike (#189)", () => {
		fillRunReport({
			outcome: true,
			attestation: { closure: ["a.test.ts", "a.js"], changedPaths: ["a.js"] },
		});
		runTeardown(markerSandbox);
		const [certificate] = markerLib.readMarkers({ root: markerSandbox });
		expect(certificate.closure).toEqual(["a.test.ts", "a.js"]);
		expect(certificate.changedPaths).toEqual(["a.js"]);
		expect(takeRunReport().attestation).toBeNull();

		fillRunReport({ outcome: false, attestation: { closure: "*" } });
		runTeardown(markerSandbox);
		const [red] = markerLib.readFailures({ root: markerSandbox });
		expect(red.closure).toBe("*");
	});

	it("stamps a red marker with isolated:false where the launch says not isolated", () => {
		stubLaunch({ isolated: false });
		fillRunReport({ outcome: false });

		runTeardown(markerSandbox);

		const [marker] = markerLib.readFailures({ root: markerSandbox });
		expect(marker.isolated).toBe(false);
		expect(marker.treeAtEnd).toBe(tree.sha);
	});
});

describe("the read audit (#4916)", () => {
	const keys = [
		"WFC_READ_AUDIT",
		"WFC_READ_AUDIT_ROOT",
		"WFC_READ_AUDIT_TMP",
		"NODE_OPTIONS",
	];
	const minted: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		setup({ config: { root: process.cwd() } });
		for (const d of minted.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	function armed(rowlessBy: "lander" | "ci" | null) {
		vi.stubEnv("WFC_READ_AUDIT_OWNER", "");
		vi.stubEnv("WFC_LANDER_RUN", rowlessBy === "lander" ? "1" : "");
		vi.stubEnv("WFC_ROWLESS_RUN", rowlessBy === "ci" ? "1" : "");
		for (const k of keys) vi.stubEnv(k, "");
		setup({ config: { root: process.cwd() } });
		return process.env.WFC_READ_AUDIT ?? "";
	}

	it("arms an outermost run, and leaves a rowless run as it would be with none", () => {
		const dir = armed(null);
		expect(dir).not.toBe("");
		minted.push(dir);
		expect(fs.existsSync(dir)).toBe(true);
		expect(process.env.NODE_OPTIONS).toContain("read-audit-preload.js");
		vi.unstubAllEnvs();

		expect(armed("lander")).toBe("");
		expect(process.env.NODE_OPTIONS).toBe("");
		vi.unstubAllEnvs();

		expect(armed("ci")).toBe("");
		expect(process.env.NODE_OPTIONS).toBe("");
	});
});
