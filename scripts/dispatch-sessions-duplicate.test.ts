// @vitest-environment node
/*
 * Pins the dispatch's duplicate gate (mantahostels#1337): the ledger each launch
 * writes, and its refusal of an issue already launched.
 *
 * The fixture is scripts/lib/dispatch-sessions-testkit.ts's. The dispatch's
 * cases are split by subject across dispatch-sessions.test.ts (the advisor),
 * -launch (model, burn mode, launcher binary, seat, auth, usage), -allowance,
 * -duplicate, -drop (a set with one member already dispatched), -reread (the
 * per-member re-read, CPU holds, stagger, roster remedy), -overflow, -bridge
 * and -bridge-budget (the interop-bridge probe), so the forks pool runs them
 * side by side and no file holds the suite to its own length (#2413, #4299). The case that breaks the interop-probe library lives in
 * dispatch-sessions-probe-load.test.ts, as it links every file in scripts/lib
 * and so makes its file a reader of each one (#2423).
 *
 * Loosen a test here and a /pick-next set launches an issue a session already
 * holds, or records a launch that never happened.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from dispatch-sessions.test.ts, whose cost was pre-existing (#2413).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, runCore } = fx;

describe("the duplicate gate (mantahostels#1337)", () => {
	it("records nothing when claude refuses to start", async () => {
		stubClaude({ launchFails: true });
		const r = await runCore(["opus", "/implement 341"]);
		expect(fs.existsSync(ledger())).toBe(false);
		expect(r.stderr).toContain("not recorded as launched");
	});

	it("records the launch when claude starts", async () => {
		stubClaude({});
		await runCore(["opus", "/implement 341"]);
		expect(fs.readFileSync(ledger(), "utf8")).toContain("341");
	});

	/* mantahostels#3488: the launched job's own id, not the launcher's — the field
	 * pick-next.js reads to say whether the launch is still alive. */
	it("records the job id claude --bg printed as the ledger's jobId", async () => {
		stubClaude({ jobId: "efbb4e5e" });
		await runCore(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBe("efbb4e5e");
	});

	it("records jobId: null where the launch printed nothing on its first line", async () => {
		stubClaude({ launch: "silent" });
		await runCore(["opus", "/implement 341"]);
		const rec = JSON.parse(fs.readFileSync(ledger(), "utf8").trim());
		expect(rec.jobId).toBeNull();
	});

	/* The stub answers `agents --json` with plain text, so the live limb fails
	 * open with a warning and these cases exercise the ledger limb alone. */
	const ledger = () =>
		path.join(
			fx.dir,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);

	it("records each launch, so a later run can tell a plan from a launch", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341", "opus", "/wayfinder 1114"]);
		const lines = fs
			.readFileSync(ledger(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.issues)).toEqual([[341], [1114]]);
		expect(lines[0].model).toBe("claude-haiku-5-5[1m]");
	});

	it("records why each launch went on its seat: its caller's own, else the loop's pick (#3732)", async () => {
		const reasons = () =>
			fs
				.readFileSync(ledger(), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l).seatReason);
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		await runCore(["sonnet", "/implement 342"], {
			WFC_SEAT_REASON: "last typed on",
		});
		expect(reasons()).toEqual(["own seat", "last typed on"]);
	});

	it("leaves the loop's seat reason out of a launched session's environment (#3740)", async () => {
		const envLog = path.join(fx.dir, "launch-env");
		stubClaude({ envLog });
		await runCore(["sonnet", "/implement 342"], {
			WFC_SEAT_REASON: "last typed on",
		});
		const env = fs.readFileSync(envLog, "utf8");
		expect(env).toContain("WFC_CLAUDE_BIN=");
		expect(env).not.toContain("WFC_SEAT_REASON");
	});

	it("refuses a second launch of an issue it already launched, naming the issue", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const again = await runCore(["sonnet", "/implement 341"]);
		expect(again.code).toBe(4);
		expect(again.stderr).toContain("already dispatched");
		expect(again.stderr).toContain("#341");
	});

	it("launches nothing on that refusal", async () => {
		/* Counts `--bg` lines, not every `claude` call: the gate's own live-oracle
		 * probe (`claude agents --json`) reaches the stub too and is recorded. */
		const launches = () =>
			fs
				.readFileSync(path.join(fx.dir, "argv"), "utf8")
				.split("\n")
				.filter((l) => l.includes("--bg")).length;
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		expect(launches()).toBe(1);
		await runCore(["sonnet", "/implement 341"]);
		expect(launches()).toBe(1);
	});

	it("leaves an unrelated issue alone", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		expect((await runCore(["sonnet", "/implement 999"])).code).toBe(0);
	});

	it("honours --force, which is the way back in", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		expect((await runCore(["--force", "sonnet", "/implement 341"])).code).toBe(
			0,
		);
	});

	it("reports under --dry-run but does not refuse — a preview must not hide it", async () => {
		stubClaude({});
		await runCore(["sonnet", "/implement 341"]);
		const preview = await runCore(["--dry-run", "sonnet", "/implement 341"]);
		expect(preview.code).toBe(0);
		expect(preview.stderr).toContain("a real run would have exited 4");
		expect(preview.stdout).toContain("would launch");
	});

	it("writes no ledger entry for a --dry-run", async () => {
		stubClaude({});
		await runCore(["--dry-run", "sonnet", "/implement 341"]);
		expect(fs.existsSync(ledger())).toBe(false);
	});
});
