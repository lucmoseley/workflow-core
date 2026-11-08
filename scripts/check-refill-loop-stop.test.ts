// @vitest-environment node
/*
 * Pins that check-refill-loop-stop.js names a refill loop stopped on a damaged
 * control file, or paused by the no-progress rule, once, at the next session
 * start (#2014, #3389, #3859), and never an explicit stop or a founder's pause,
 * and names a damaged state file (#3380)
 * and a stopped loop's damaged control file (#3927), and a running loop's restart
 * wait past its bound at every start (#4145).
 * WFC_REFILL_DIR points the loop's files
 * at a temp directory, so the machine's real loop is never read. Loosen a case
 * and a stalled loop goes unseen at session start, or its notice repeats at
 * every start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStartEnv, writeJobRecord } from "./lib/background-start-testkit";
import { spawnLoopHolder } from "./lib/refill-loop-testkit";
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
const run = (
	args: string[],
	source = "startup",
	jobDir = "",
	env: Record<string, string> = {},
) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_REFILL_DIR: dir,
			...buildStartEnv(jobDir),
			...env,
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
		expect(JSON.parse(stdout).systemMessage).toContain("REFILL-LOOP-OVERFLOW");
		expect(stdout).toContain("Its status:");
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
	it("names no explicit stop", () => {
		writeState("explicit");
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("REFILL-LOOP-STOPPED");
	});

	describe("a no-progress pause (#3859)", () => {
		const issues = [{ root: "/h/workflow-core", number: 9 }];
		const writePause = (paused: object) =>
			fs.writeFileSync(
				path.join(dir, ".refill-loop-control.json"),
				JSON.stringify({
					noProgressFrom: STOP_AT - 60_000,
					stopRequested: false,
					seats: [],
					paused,
					scope: { mode: "normal", repos: [] },
				}),
			);

		it("names it once, with its issues and the resume", () => {
			writePause({ by: "no-progress", at: STOP_AT, issues });
			const first = run(["--notify"]);
			expect(first.status).toBe(0);
			expect(first.stdout).toContain("REFILL-LOOP-PAUSED");
			expect(first.stdout).toContain("workflow-core#9");
			expect(first.stdout).toContain("set --resume");
			expect(run(["--notify"]).stdout).not.toContain("REFILL-LOOP-PAUSED");
		});

		it("names no founder's pause", () => {
			writePause({ by: "founder", at: STOP_AT });
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			expect(r.stdout).not.toContain("REFILL-LOOP-PAUSED");
		});
	});

	it("names a damaged-control stop with its time and detail", () => {
		writeState("control-damaged");
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("stopped on a damaged control file");
		expect(r.stdout).toContain("2026-10-18T03:00:00.000Z");
		expect(r.stdout).toContain("the detail");
		expect(r.stdout).toContain("Restart it: node");
	});

	it("names a stop once", () => {
		writeState("control-damaged");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
		const again = run(["--notify"]);
		expect(again.status).toBe(0);
		expect(again.stdout).toBe("");
	});

	it("names a later stop after an earlier one was named", () => {
		writeState("control-damaged");
		run(["--notify"]);
		writeState("control-damaged", "d", STOP_AT + 1000);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("REFILL-LOOP-STOPPED");
	});

	it("neither names nor spends a stop on a compaction", () => {
		writeState("control-damaged");
		const r = run(["--notify"], "compact");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});

	it("leaves a stop to the next interactive start, unspent, at a background job's (#3707)", () => {
		writeState("control-damaged");
		const r = run(["--notify"], "startup", path.join(dir, "job"));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("names and spends a stop at a job he launched from the agents view (#3772)", () => {
		writeState("control-damaged");
		const his = writeJobRecord(path.join(dir, "his"), "claude");
		expect(run(["--notify"], "startup", his).stdout).toContain(
			"REFILL-LOOP-STOPPED",
		);
		expect(run(["--notify"], "startup", his).stdout).toBe("");
	});

	it("puts the stop on his screen and in the session's context (#3776)", () => {
		writeState("control-damaged");
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		const { systemMessage, hookSpecificOutput } = JSON.parse(r.stdout);
		expect(systemMessage).toContain(
			"REFILL-LOOP-STOPPED — the refill loop stopped on a damaged control file",
		);
		expect(systemMessage).toContain("Restart it: node");
		expect(hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(hookSpecificOutput.additionalContext).toContain(systemMessage);
	});

	it("keeps a plain run's report plain and its stamp unspent (#3776)", () => {
		writeState("control-damaged");
		const plain = run([]);
		expect(plain.status).toBe(0);
		expect(plain.stderr).toContain("REFILL-LOOP-STOPPED");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});

	it("neither names nor spends a stop at a plain `claude --bg` job (#3772)", () => {
		writeState("control-damaged");
		const loops = writeJobRecord(path.join(dir, "loops"), "bg");
		expect(run(["--notify"], "startup", loops).stdout).toBe("");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});

	it("says nothing of a restart a stop request followed", () => {
		writeState("control-damaged");
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ noProgressFrom: STOP_AT + 60_000, stopRequested: true }),
		);
		expect(run(["--notify"]).stdout).toContain("nothing new launches");
	});

	it("never names an explicit stop", () => {
		writeState("explicit");
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

	it("names a damaged-control stop once, with the file, then the damage alone at a later start (#3389, #3927)", () => {
		const control = path.join(dir, ".refill-loop-control.json");
		fs.writeFileSync(control, "{ not json");
		writeState("control-damaged", `${control} is damaged (bad JSON)`);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`stopped on a damaged control file at 2026-10-18T03:00:00.000Z: ${control} is damaged (bad JSON)`,
		);
		expect(r.stdout).not.toContain("REFILL-LOOP-FILE-DAMAGED");
		const later = run(["--notify"]);
		expect(later.status).toBe(0);
		expect(later.stdout).toContain(
			`REFILL-LOOP-FILE-DAMAGED — ${control} is damaged`,
		);
		expect(later.stdout).toContain("until a start rewrites it");
		expect(later.stdout).not.toContain("REFILL-LOOP-STOPPED");
	});

	describe("a damaged control beside a stopped loop (#3927)", () => {
		const damageControl = () =>
			fs.writeFileSync(
				path.join(dir, ".refill-loop-control.json"),
				"{ not json",
			);
		const expectDamageNamed = (stdout: string) => {
			const control = path.join(dir, ".refill-loop-control.json");
			expect(stdout).toContain(
				`REFILL-LOOP-FILE-DAMAGED — ${control} is damaged`,
			);
			expect(stdout).toContain("until a start rewrites it");
		};

		it("names it beside an explicit stop", () => {
			writeState("explicit");
			damageControl();
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			expectDamageNamed(r.stdout);
			expect(r.stdout).not.toContain("REFILL-LOOP-STOPPED");
		});

		it("names it with no stop written", () => {
			damageControl();
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			expectDamageNamed(r.stdout);
		});

		it("names it again beside a named stop already spent", () => {
			writeState("control-damaged");
			run(["--notify"]);
			damageControl();
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			expectDamageNamed(r.stdout);
			expect(r.stdout).not.toContain("REFILL-LOOP-STOPPED");
		});

		it("leaves a running loop's to check-idle-efforts.js", () => {
			writeState("explicit");
			damageControl();
			const holder = spawnLoopHolder(dir);
			try {
				const r = run(["--notify"]);
				expect(r.status).toBe(0);
				expect(r.stdout).toBe("");
			} finally {
				holder.kill();
			}
		});

		it("names a fresh stop but not a running loop's damage beside it", () => {
			writeState("control-damaged");
			damageControl();
			const holder = spawnLoopHolder(dir);
			try {
				const r = run(["--notify"]);
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("REFILL-LOOP-STOPPED");
				expect(r.stdout).not.toContain("REFILL-LOOP-FILE-DAMAGED");
			} finally {
				holder.kill();
			}
		});
	});

	describe("a restart's wait on the listing (#4145)", () => {
		const Now = Date.parse("2026-11-08T12:00:00Z");
		const writeWait = (minutes: number) =>
			fs.writeFileSync(
				path.join(dir, ".refill-loop-state.json"),
				JSON.stringify({
					launches: [],
					lastTick: null,
					stopped: null,
					bootedAt: Now - minutes * 60_000,
					sameBootRestart: true,
				}),
			);
		const runAt = (holding: boolean) => {
			const holder = holding ? spawnLoopHolder(dir) : null;
			try {
				return run(["--notify"], "startup", "", {
					WFC_NOW: new Date(Now).toISOString(),
				});
			} finally {
				holder?.kill();
			}
		};

		it("names a running loop's wait past its bound, at each start", () => {
			writeWait(20);
			for (const r of [runAt(true), runAt(true)]) {
				expect(r.status).toBe(0);
				expect(r.stdout).toContain(
					"REFILL-LOOP-RESTART-WAIT — the refill loop has waited since a restart at 2026-11-08T11:40:00.000Z",
				);
				expect(r.stdout).toContain("Its status:");
			}
		});

		it.each([
			["inside its bound", 5, true],
			["of a loop not running", 20, false],
		])("names none %s", (_name, minutes, holding) => {
			writeWait(minutes);
			const r = runAt(holding);
			expect(r.status).toBe(0);
			expect(r.stdout).not.toContain("REFILL-LOOP-RESTART-WAIT");
		});
	});

	it("says the loop was started again where a start followed the stop", () => {
		writeState("control-damaged");
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: STOP_AT + 60_000,
				stopRequested: false,
			}),
		);
		expect(run(["--notify"]).stdout).toContain("started again since");
	});
});

describe("the restart it names", () => {
	function writeControl(scope: object, noProgressFrom = STOP_AT - 60_000) {
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({ noProgressFrom, stopRequested: false, scope }),
		);
	}

	it("names `start`, its script absolute, whatever the mode", () => {
		for (const mode of ["normal", "away"]) {
			writeState("control-damaged");
			writeControl({ mode, repos: ["/h/workflow-core"], goal: null });
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			const { systemMessage } = JSON.parse(r.stdout);
			expect(systemMessage).toContain(
				`  Restart it: node ${path.join(__dirname, "refill-loop.js")} start\n`,
			);
			expect(systemMessage).not.toContain("/pick-next");
			fs.rmSync(path.join(dir, ".refill-loop-stop-seen"), { force: true });
		}
	});

	it("names no restart where the loop was started again since", () => {
		writeState("control-damaged");
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
		writeState("control-damaged");
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("REFILL-LOOP-STOPPED");
		expect(run(["--notify"]).stdout).toContain("REFILL-LOOP-STOPPED");
	});
});
