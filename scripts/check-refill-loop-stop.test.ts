// @vitest-environment node
/*
 * Pins that check-refill-loop-stop.js names a refill loop stopped on no
 * progress or the allowance cut once, at the next session start (#2014), and
 * never an expiry or an explicit stop. WFC_REFILL_DIR points the loop's files
 * at a temp directory, so the machine's real loop is never read. Loosen a case
 * and a stalled loop goes unseen at session start, or its notice repeats at
 * every start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-refill-loop-stop.js");
const STOP_AT = Date.parse("2026-10-18T03:00:00Z");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-stop-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeState(reason: string, detail = "the detail", at = STOP_AT) {
	fs.writeFileSync(
		path.join(dir, ".refill-loop-state.json"),
		JSON.stringify({
			launches: [],
			lastTick: null,
			stopped: { at, reason, detail },
		}),
	);
}

const run = (args: string[], source = "startup") =>
	runInProcess(SCRIPT, args, {
		env: { ...process.env, GITHUB_ACTIONS: "", WFC_REFILL_DIR: dir },
		stdin: JSON.stringify({ hook_event_name: "SessionStart", source }),
	});

describe("at session start (--notify)", () => {
	it.each([
		["no-progress", "no progress"],
		["allowance", "the allowance cut"],
	])("names a %s stop with its time and detail", (reason, words) => {
		writeState(reason);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`stopped on ${words}`);
		expect(r.stdout).toContain("2026-10-18T03:00:00.000Z");
		expect(r.stdout).toContain("the detail");
		expect(r.stdout).toContain("/pick-next");
	});

	it("names a stop once", () => {
		writeState("no-progress");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
		const again = run(["--notify"]);
		expect(again.status).toBe(0);
		expect(again.stdout).toBe("");
	});

	it("names a later stop after an earlier one was named", () => {
		writeState("no-progress");
		run(["--notify"]);
		writeState("allowance", "d", STOP_AT + 1000);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("the allowance cut");
	});

	it("neither names nor spends a stop on a compaction", () => {
		writeState("no-progress");
		const r = run(["--notify"], "compact");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});

	it("says nothing of a restart a stop request followed", () => {
		writeState("no-progress");
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ startedAt: STOP_AT + 60_000, stopRequested: true }),
		);
		expect(run(["--notify"]).stdout).toContain("nothing new launches");
	});

	it.each(["expired", "explicit"])("never names an %s stop", (reason) => {
		writeState(reason);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("prints nothing with no state file", () => {
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("says the loop was started again where a start followed the stop", () => {
		writeState("no-progress");
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ startedAt: STOP_AT + 60_000, stopRequested: false }),
		);
		expect(run(["--notify"]).stdout).toContain("started again since");
	});
});

describe("the restart it names (#3371)", () => {
	function writeControl(scope: object, startedAt = STOP_AT - 60_000) {
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ startedAt, stopRequested: false, scope }),
		);
	}

	it("names /pick-next for a normal-mode stop", () => {
		writeState("no-progress");
		writeControl({ mode: "normal", repos: ["/h/workflow-core"], goals: {} });
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		const out = r.stdout;
		expect(out).toContain("Restart it with /pick-next.");
		expect(out).not.toContain("--away");
	});

	it("names the away start, with its exclusions, for an away-mode stop", () => {
		writeState("no-progress");
		writeControl({ mode: "away", exclude: ["/h/mantahostels"], goals: {} });
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		const out = r.stdout;
		expect(out).toContain(
			`Restart away mode: node ${path.join(__dirname, "refill-loop.js")} start --away --exclude mantahostels\n`,
		);
		expect(out).not.toContain("/pick-next");
	});

	it("names one away start per goal's checkout, each with every exclusion", () => {
		writeState("allowance");
		writeControl({
			mode: "away",
			exclude: ["/h/mantahostels", "/h/fantasy-books"],
			goals: { "/h/workflow-core": [116, 117], "/h/design-vault": [9] },
		});
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		const out = r.stdout;
		const away = `node ${path.join(__dirname, "refill-loop.js")} start --away --exclude mantahostels --exclude fantasy-books`;
		expect(out).toContain(
			`  CLAUDE_PROJECT_DIR=/h/workflow-core ${away} --goal 116,117\n`,
		);
		expect(out).toContain(
			`  CLAUDE_PROJECT_DIR=/h/design-vault ${away} --goal 9\n`,
		);
	});

	it("names no restart where the loop was started again since", () => {
		writeState("no-progress");
		writeControl({ mode: "away" }, STOP_AT + 60_000);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		const out = r.stdout;
		expect(out).not.toContain("Restart");
		expect(out).toContain("Its status:");
	});
});

describe("a plain run", () => {
	it("names the stop and spends nothing", () => {
		writeState("no-progress");
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("REFILL-LOOP-STOPPED");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});
});
