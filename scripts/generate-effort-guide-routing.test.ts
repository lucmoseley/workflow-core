// @vitest-environment node
/*
 * Pins the effort guide's routing generator (#5033). The routing is the
 * fixture's (lib/model-table.test.ts names its rows), so a value edit to the real file breaks nothing here; the
 * last case checks the real guide against the real file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "generate-effort-guide-routing.js");
const FIXTURE = path.join(__dirname, "fixtures/model-routing/fixture.json");
const GUIDE = path.join(__dirname, "../docs/effort-guide.md");
const REAL = path.join(__dirname, "lib/model-routing.json");
const PROSE = "# Guide\n\nBefore.\n\n";
const AFTER = "\n\nAfter.\n";

let dir: string;
let guide: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-routing-"));
	guide = path.join(dir, "guide.md");
	fs.writeFileSync(
		guide,
		`${PROSE}<!-- routing:begin -->\nstale\n<!-- routing:end -->${AFTER}`,
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], routing = FIXTURE) =>
	runInProcess(SCRIPT, [...args, "--guide", guide, "--no-claim"], {
		env: { ...process.env, WFC_MODEL_ROUTING: routing },
	});

describe("generate-effort-guide-routing", () => {
	it("fails --check on a stale block, and a write renders the fixture's rows between the markers alone", () => {
		expect(run(["--check"]).status).toBe(1);
		expect(fs.readFileSync(guide, "utf8")).toContain("stale");
		expect(run([]).status).toBe(0);
		const text = fs.readFileSync(guide, "utf8");
		expect(text.startsWith(PROSE)).toBe(true);
		expect(text.endsWith(`<!-- routing:end -->${AFTER}`)).toBe(true);
		expect(text).toContain(
			"| `opus` | `test-opus-2` | `test-opus-1`, `opusish` |",
		);
		expect(text).toContain("| `fable` | `test-fable-1` | — |");
		expect(text).toContain(
			"**Standard mode.** Session model `test-haiku-1[1m]`; settings efforts `test-haiku-1` `low`, `test-opus-2` `high`.",
		);
		expect(text).toContain("| `sonnet` | `opus` · `test-opus-2` | as asked |");
		expect(text).toContain("**Burn mode.** Session model `test-sonnet-1[1m]`");
		expect(text).toContain("| `haiku` | `fable` · `test-fable-1` | `high` |");
	});

	it("passes --check on a fresh render, and fails it once the block is edited", () => {
		run([]);
		expect(run(["--check"]).status).toBe(0);
		const text = fs.readFileSync(guide, "utf8");
		fs.writeFileSync(guide, text.replace("`high` |", "`low` |"));
		const r = run(["--check"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("does not match");
	});

	it("exits 2 on a guide with no marker pair, writing nothing", () => {
		fs.writeFileSync(guide, PROSE);
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no routing:begin / routing:end marker pair");
		expect(fs.readFileSync(guide, "utf8")).toBe(PROSE);
	});

	it("exits 2 where the routing file will not load", () => {
		const broken = path.join(dir, "routing.json");
		fs.writeFileSync(broken, "{");
		const r = run(["--check"], broken);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(broken);
	});

	it("finds the real guide's block matching the real routing file", () => {
		const r = runInProcess(SCRIPT, ["--check", "--guide", GUIDE], {
			env: { ...process.env, WFC_MODEL_ROUTING: REAL },
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});
