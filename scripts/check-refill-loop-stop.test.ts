// @vitest-environment node
/*
 * Pins that check-refill-loop-stop.js names a refill loop stopped on no
 * progress, the allowance cut or a damaged control file once, at the next
 * session start (#2014, #3389), and
 * never an expiry or an explicit stop, and names a damaged state file (#3380).
 * WFC_REFILL_DIR points the loop's files
 * at a temp directory, so the machine's real loop is never read. Loosen a case
 * and a stalled loop goes unseen at session start, or its notice repeats at
 * every start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEnv, writeJobRecord } from "./lib/background-start-testkit";
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

/** An interactive start unless `jobDir` names a background job's. */
const run = (args: string[], source = "startup", jobDir = "") =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_REFILL_DIR: dir,
			...startEnv(jobDir),
		},
		stdin: JSON.stringify({ hook_event_name: "SessionStart", source }),
	});

describe("the first overflow launch (#3767)", () => {
	const At = Date.parse("2026-11-01T09:00:00Z");
	const home = process.env.HOME || os.homedir();
	const writeStart = (at = At) =>
		fs.writeFileSync(
			path.join(dir, ".refill-loop-state.json"),
			JSON.stringify({
				launches: [],
				overflowStart: {
					at,
					seat: path.join(home, ".claude3-api"),
					planSeats: [
						{
							seat: path.join(home, ".claude2"),
							percent: 100,
							weekReadAt: at - 120_000,
							weekFull: true,
						},
						{
							seat: path.join(home, ".claude3"),
							percent: 0,
							weekReadAt: at - 7_200_000,
							weekFull: false,
						},
						{
							seat: path.join(home, ".claude4"),
							percent: null,
							weekReadAt: null,
							weekFull: false,
						},
					],
					omitted: [path.join(home, ".claude9")],
				},
			}),
		);

	it("names each plan seat's reading and the omitted dirs, once", () => {
		writeStart();
		const { status, stdout } = run(["--notify"]);
		expect(status).toBe(0);
		expect(stdout).toContain("REFILL-LOOP-OVERFLOW");
		expect(stdout).toContain("Its status:");
		expect(stdout).toContain("Tell the founder");
		expect(stdout).toContain("2026-11-01T09:00:00.000Z");
		expect(stdout).toContain("~/.claude3-api");
		expect(stdout).toContain(
			"~/.claude2: 100% of the week, read 2m before it, weekly-full",
		);
		expect(stdout).toContain(
			"~/.claude3: 0% of the week, read 2h before it, not weekly-full",
		);
		expect(stdout).toContain("~/.claude4: no weekly reading, not weekly-full");
		expect(stdout).toContain("credentials outside the seat file: ~/.claude9");
		const again = run(["--notify"]);
		expect(again.status).toBe(0);
		expect(again.stdout).not.toContain("REFILL-LOOP-OVERFLOW");
	});

	it("reads a damaged plan-seat element as absent, never throwing", () => {
		fs.writeFileSync(
			path.join(dir, ".refill-loop-state.json"),
			JSON.stringify({
				overflowStart: { at: At, seat: "/s", planSeats: [null], omitted: [1] },
			}),
		);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("REFILL-LOOP-OVERFLOW");
	});

	it("names a later overflow start past the stamp", () => {
		writeStart();
		run(["--notify"]);
		writeStart(At + 1000);
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-OVERFLOW");
	});

	it("holds back and keeps the stamp at a background start", () => {
		writeStart();
		const held = run(["--notify"], "startup", dir);
		expect(held.status).toBe(0);
		expect(held.stdout).not.toContain("REFILL-LOOP-OVERFLOW");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-OVERFLOW");
	});

	it("names it without stamping on a plain run", () => {
		writeStart();
		const plain = run([]);
		expect(plain.status).toBe(0);
		expect(plain.stderr).toContain("REFILL-LOOP-OVERFLOW");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-OVERFLOW");
	});
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

	it("leaves a stop to the next interactive start, unspent, at a background job's (#3707)", () => {
		writeState("no-progress");
		const r = run(["--notify"], "startup", path.join(dir, "job"));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("names and spends a stop at a job he launched from the agents view, telling the session to relay it (#3772)", () => {
		writeState("no-progress");
		const his = writeJobRecord(path.join(dir, "his"), "claude");
		const r = run(["--notify"], "startup", his);
		expect(r.stdout).toContain("REFILL-LOOP-STOPPED");
		expect(r.stdout).toContain("Tell the founder this in your next reply");
		expect(run(["--notify"], "startup", his).stdout).toBe("");
	});

	it("neither names nor spends a stop at a plain `claude --bg` job (#3772)", () => {
		writeState("no-progress");
		const loops = writeJobRecord(path.join(dir, "loops"), "bg");
		expect(run(["--notify"], "startup", loops).stdout).toBe("");
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

	it("names a damaged state file as its own warning, and no stop (#3380)", () => {
		const state = path.join(dir, ".refill-loop-state.json");
		fs.writeFileSync(state, "{ not json");
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`REFILL-LOOP-FILE-DAMAGED — ${state} is damaged`,
		);
		expect(r.stdout).toContain("until its next write replaces it");
		expect(r.stdout).not.toContain("REFILL-LOOP-STOPPED");
	});

	it("names a damaged control file beside the stop it was read for (#3380)", () => {
		writeState("no-progress");
		const control = path.join(dir, ".refill-loop-control.json");
		fs.writeFileSync(control, "{ not json");
		const r = run(["--notify"]);
		expect(r.stdout).toContain(
			`REFILL-LOOP-FILE-DAMAGED — ${control} is damaged`,
		);
		expect(r.stdout).toContain("REFILL-LOOP-STOPPED");
		/* No control reads as no renewal, so the restart is named. */
		expect(r.stdout).toContain("/pick-next");
	});

	it("names a damaged-control stop once, with the file, and no second warning (#3389)", () => {
		const control = path.join(dir, ".refill-loop-control.json");
		fs.writeFileSync(control, "{ not json");
		writeState("control-damaged", `${control} is damaged (bad JSON)`);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`stopped on a damaged control file at 2026-10-18T03:00:00.000Z: ${control} is damaged (bad JSON)`,
		);
		expect(r.stdout).not.toContain("REFILL-LOOP-FILE-DAMAGED");
		expect(run(["--notify"]).stdout).toBe("");
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

	it("names a normal stop's goal and other repos in its checkout (#3390)", () => {
		writeState("no-progress");
		writeControl({
			mode: "normal",
			repos: ["/h/workflow-core", "/h/mantahostels"],
			goals: { "/h/workflow-core": [116, 117] },
		});
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"  Restart it in workflow-core: /pick-next #116 #117 mantahostels\n",
		);
	});

	it.each([
		[{ "/h/workflow-core": [116] }, ["/h/workflow-core"], "/pick-next #116"],
		[{}, ["/h/workflow-core", "/h/mantahostels"], "/pick-next mantahostels"],
	])("names a normal stop's goal or repos alone (%j)", (goals, repos, line) => {
		writeState("no-progress");
		writeControl({ mode: "normal", repos, goals });
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`  Restart it in workflow-core: ${line}\n`);
	});

	it("names one /pick-next per goal's checkout for a normal stop", () => {
		writeState("allowance");
		writeControl({
			mode: "normal",
			repos: ["/h/workflow-core", "/h/design-vault"],
			goals: { "/h/design-vault": [9] },
		});
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"  Restart it with /pick-next, one per goal's checkout:\n" +
				"    in workflow-core: /pick-next design-vault\n" +
				"    in design-vault: /pick-next #9\n",
		);
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
