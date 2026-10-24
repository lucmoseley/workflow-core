// @vitest-environment node
/*
 * Pins which of a checker's faults count as added by this commit rather than
 * inherited from HEAD, per profile, and that the profiles match the envelopes
 * the real checkers emit.
 *
 * checker-new-faults.js (mantahostels#1688, mantahostels#1753, mantahostels#1797) — the direction test behind the
 * two whole-repo pre-commit gates and the doc-map one.
 *
 * Each gate's own suite stubs this script, so this file alone pins its
 * verdicts. Each case writes the two envelopes to a temp directory and runs
 * the script in process over them.
 *
 * Those gates refuse commits in `.husky/pre-commit` on its verdict: loosen a
 * case and a commit adding a fault passes with a warning, or a bystander's
 * commit is refused over a fault someone else left on `main`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OVER_INJECTION, OVER_POOL } from "./lib/context-budget-tags";
import { liveCaps } from "./lib/context-budget-testkit";
import { ENVELOPE_FRAME_KEYS } from "./lib/envelope-frame-keys";
import { REFUSES_COMMIT } from "./lib/refuses-commit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "checker-new-faults.js");
const ROOT = path.join(__dirname, "..");

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/** Writes the two envelopes to a throwaway dir and runs the script over them. */
function run(
	profile: string,
	staged: unknown,
	baseline: unknown,
): { code: number; out: string; err: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checker-new-faults-"));
	temps.push(dir);
	const write = (name: string, body: unknown) => {
		const abs = path.join(dir, name);
		fs.writeFileSync(
			abs,
			typeof body === "string" ? body : JSON.stringify(body),
		);
		return abs;
	};
	const r = runInProcess(SCRIPT, [
		profile,
		write("staged.json", staged),
		write("baseline.json", baseline),
	]);
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A check-guard-registry.js FAIL finding, as the live checker emits one. */
const regFail = (over: Record<string, unknown> = {}) => ({
	severity: "FAIL",
	tag: "UNPRINTED-RULE",
	message: "docs/agents/rules/x.txt:1 — no wired emitter prints this fragment.",
	kind: "UNPRINTED-RULE",
	file: "docs/agents/rules/x.txt",
	line: 1,
	rule: 'rule id "x"',
	detail: "no wired emitter prints this fragment.",
	...over,
});

/** A STALE-PROSE warning, whose message and detail carry the moving anchors. */
const regStale = (anchored: string, now: string) => ({
	severity: "WARN",
	tag: "STALE-PROSE",
	message: `.husky/pre-push — changed since it was last reviewed (anchored ${anchored}, now ${now})`,
	kind: "STALE-PROSE",
	guard: ".husky/pre-push",
	rules: [],
	detail: `changed since it was last reviewed (anchored ${anchored}, now ${now})`,
});

/** A REPRINTED warning, which the gate never refuses. */
const regReprinted = () => ({
	severity: "WARN",
	tag: "REPRINTED",
	message: "scripts/guard-x.sh — its deny reprints a rule",
	kind: "REPRINTED",
	guard: "scripts/guard-x.sh",
	rules: [],
	detail: "its deny reprints a rule",
	spans: [],
});

describe("checker-new-faults, guard-registry", () => {
	it("passes a commit that inherits every FAIL from HEAD", () => {
		const both = { findings: [regFail(), regStale("aaaa", "bbbb")] };

		const { code, out } = run("guard-registry", both, both);

		expect(code).toBe(0);
		expect(out.trim()).toBe("");
	});

	it("refuses a commit that adds a FAIL, naming it", () => {
		const staged = {
			findings: [
				regFail(),
				regFail({
					file: "docs/agents/rules/y.txt",
					rule: 'rule id "y"',
					message:
						"docs/agents/rules/y.txt:1 — no wired emitter prints this fragment.",
				}),
			],
		};

		const { code, out } = run("guard-registry", staged, {
			findings: [regFail()],
		});

		expect(code).toBe(1);
		expect(out).toContain("docs/agents/rules/y.txt");
		expect(out).not.toContain("rules/x.txt");
	});

	it("refuses on the one it added, not the one it repaired, naming only the added file", () => {
		const { code, out } = run(
			"guard-registry",
			{
				findings: [
					regFail({
						file: "b.txt",
						rule: 'rule id "b"',
						message: "b.txt:1 — no wired emitter prints this fragment.",
					}),
				],
			},
			{ findings: [regFail()] },
		);

		expect(code).toBe(1);
		expect(out.trim().split("\n")).toHaveLength(1);
		expect(out).toContain("b.txt");
	});

	it("passes a commit that changes only a stale-prose anchor hash", () => {
		// Every anchor moves whenever its guard is edited, so comparing the whole
		// JSON value would call an untouched warning new and refuse a bystander.
		const { code, out } = run(
			"guard-registry",
			{ findings: [regFail(), regStale("b75160cf", "7c36bffb")] },
			{ findings: [regFail(), regStale("00000000", "b75160cf")] },
		);

		expect(code).toBe(0);
		expect(out.trim()).toBe("");
	});

	it("never refuses on an unmarked WARN, however new", () => {
		const { code } = run(
			"guard-registry",
			{ findings: [regStale("aaaa", "bbbb"), regReprinted()] },
			{ findings: [] },
		);

		expect(code).toBe(0);
	});

	it("refuses a new staleness warning the checker marks as refusing the commit (#2617)", () => {
		const { code, out } = run(
			"guard-registry",
			{ findings: [{ ...regStale("aaaa", "bbbb"), [REFUSES_COMMIT]: true }] },
			{ findings: [] },
		);

		expect(code).toBe(1);
		expect(out).toContain(".husky/pre-push — changed since");
	});

	it("tells two marked warnings apart by the guard they name", () => {
		const marked = (guard: string) => ({
			...regStale("aaaa", "bbbb"),
			guard,
			[REFUSES_COMMIT]: true,
		});
		const { code } = run(
			"guard-registry",
			{ findings: [marked(".husky/pre-push"), marked(".husky/pre-commit")] },
			{ findings: [marked(".husky/pre-push")] },
		);

		expect(code).toBe(1);
	});

	it("does not read a fault as new because an edit above moved its line", () => {
		// A FAIL's message is `${file}:${line} — ${detail}`, so the line moving
		// moves the message with it.
		const at = (line: number) =>
			regFail({
				line,
				message: `docs/agents/rules/x.txt:${line} — no wired emitter prints this fragment.`,
			});

		const { code } = run(
			"guard-registry",
			{ findings: [at(412)] },
			{ findings: [at(9)] },
		);

		expect(code).toBe(0);
	});

	it("keeps two kinds at one path apart", () => {
		const { code, out } = run(
			"guard-registry",
			{
				findings: [regFail({ tag: "ORPHAN-TRIGGER", kind: "ORPHAN-TRIGGER" })],
			},
			{ findings: [regFail()] },
		);

		expect(code).toBe(1);
		expect(out).toContain("no wired emitter");
	});
});

describe("checker-new-faults, guard-test-isolation", () => {
	/** A check-guard-test-isolation.js FAIL finding, as the checker emits one. */
	const isoFail = (file: string, guards: string[]) => ({
		severity: "FAIL",
		tag: "GUARD-TEST-ISOLATION",
		message: `${file} spawns ${guards.join(", ")} without setting CLAUDE_CONFIG_DIR, so a fail-open it provokes is written to the developer's live guard-errors.log (mantahostels#1452).`,
		file,
		guards,
	});

	it("refuses a commit that adds an unisolated test, naming the test and CLAUDE_CONFIG_DIR", () => {
		const { code, out } = run(
			"guard-test-isolation",
			{ findings: [isoFail("scripts/a.test.ts", ["scripts/guard-branch.sh"])] },
			{ findings: [] },
		);

		expect(code).toBe(1);
		expect(out).toContain("scripts/a.test.ts");
		expect(out).toContain("CLAUDE_CONFIG_DIR");
	});

	it("passes an inherited one whose guard list has since grown", () => {
		const { code } = run(
			"guard-test-isolation",
			{
				findings: [
					isoFail("scripts/a.test.ts", [
						"scripts/guard-branch.sh",
						"scripts/guard-pull-form.sh",
					]),
				],
			},
			{ findings: [isoFail("scripts/a.test.ts", ["scripts/guard-branch.sh"])] },
		);

		expect(code).toBe(0);
	});
});

describe("checker-new-faults, doc-map", () => {
	/*
	 * The other envelope shape (mantahostels#1688): faults are the TOP-LEVEL
	 * lists, one per fault kind, holding plain paths or whole objects and
	 * carrying no severity of their own.
	 */
	const doc = (staged: unknown, baseline: unknown) =>
		run("doc-map", staged, baseline);

	it("says nothing when every fault is already in the baseline", () => {
		const both = { dead: ["a.md", "b.md"], uncovered: ["c.md"] };

		const { code, out } = doc(both, both);

		expect(code).toBe(0);
		expect(out.trim()).toBe("");
	});

	it("names a fault the baseline does not carry, with its key", () => {
		const { code, out } = doc(
			{ dead: ["old.md", "new.md"] },
			{ dead: ["old.md"] },
		);

		expect(code).toBe(1);
		expect(out.trim()).toBe("dead: new.md");
	});

	it("keeps the two keys apart — the same path under a different fault is new", () => {
		const { code, out } = doc({ uncovered: ["x.md"] }, { dead: ["x.md"] });

		expect(code).toBe(1);
		expect(out.trim()).toBe("uncovered: x.md");
	});

	it("passes a commit that REPAIRS a fault and adds none", () => {
		// The gate only asks this when the checker failed, so a partial repair
		// still leaves faults on the report — they must not be read as new.
		const { code } = doc({ dead: ["b.md"] }, { dead: ["a.md", "b.md"] });

		expect(code).toBe(0);
	});

	it("compares an object item whole, never by one field", () => {
		const entry = { id: "B12", fault: "no restatement key" };

		expect(
			doc({ pointerFaults: [entry] }, { pointerFaults: [entry] }).code,
		).toBe(0);
		expect(
			doc(
				{ pointerFaults: [{ ...entry, fault: "other" }] },
				{
					pointerFaults: [entry],
				},
			).code,
		).toBe(1);
	});

	it("ignores `unreached`, which is report text rather than a fault", () => {
		const { code } = doc({ unreached: ["a.md", "b.md"] }, { unreached: [] });

		expect(code).toBe(0);
	});

	it("ignores `findings`", () => {
		// Here that key is the severity envelope, not the item list: a repair
		// turns "3 tracked file(s)…" into "2 tracked file(s)…", an object the
		// baseline cannot hold — comparing it would refuse the repair.
		const { code } = doc(
			{ findings: [{ severity: "FAIL", message: "2 tracked file(s):" }] },
			{ findings: [{ severity: "FAIL", message: "3 tracked file(s):" }] },
		);

		expect(code).toBe(0);
	});

	/*
	 * mantahostels#1785: `untracked` and `untrackedRoutes` are WARN-only in check-doc-map.js
	 * itself, always (mantahostels#1193, mantahostels#1403) — a register row or route naming a file
	 * that merely has not been committed yet, normal mid-ticket state. Without
	 * this exclusion the profile's missing `gating` predicate would still
	 * refuse a commit adding one of these the moment the doc map ALSO carried
	 * any unrelated, already-inherited FAIL — the direction gate is blind to
	 * severity, so a WARN-only list left in reads as gate material regardless.
	 */
	it("ignores `untracked`, which is WARN-only in the checker itself", () => {
		const { code } = doc(
			{ untracked: ["a.md"], dead: ["old.md"] },
			{ dead: ["old.md"] },
		);

		expect(code).toBe(0);
	});

	it("ignores `untrackedRoutes`, which is WARN-only in the checker itself", () => {
		const { code } = doc(
			{ untrackedRoutes: ["docs/a.md"], dead: ["old.md"] },
			{ dead: ["old.md"] },
		);

		expect(code).toBe(0);
	});

	/*
	 * mantahostels#2594: `keys` is lib/check.js's envelope FRAME — the deduplicated key line
	 * of every finding, WARN ones included — rather than any checker's payload.
	 */
	it("ignores `keys`, lib/check.js's envelope frame rather than a fault list", () => {
		const { code } = doc(
			{ keys: ["UNCOVERED-GRACE\tdocs/fresh.md"], dead: ["old.md"] },
			{ dead: ["old.md"] },
		);

		expect(code).toBe(0);
	});

	/*
	 * This profile's `keys` predicate is NEGATIVE, so any array lib/check.js
	 * ever grows on the envelope frame is gate material by default unless
	 * named. Read off ENVELOPE_FRAME_KEYS rather than hand-listing today's
	 * members, so this test needs no edit the day the frame does. It cannot see
	 * a key added to the frame that never joins that Set — lib/check.test.ts
	 * pins that lib/check.js's own `finish()` throws before writing an envelope
	 * carrying one.
	 */
	it("ignores every key in lib/check.js's envelope frame, not just the ones named by hand", () => {
		for (const key of ENVELOPE_FRAME_KEYS) {
			const { code } = doc(
				{ [key]: ["a frame array, not a fault"], dead: ["old.md"] },
				{ dead: ["old.md"] },
			);

			expect(code, `frame key "${key}" leaked through as gate material`).toBe(
				0,
			);
		}
	});

	it("ignores the envelope's scalar counts", () => {
		expect(doc({ tracked: 264 }, { tracked: 263 }).code).toBe(0);
	});

	it("treats a key absent from the baseline as carrying nothing", () => {
		const { code, out } = doc({ strays: ["s.md"] }, {});

		expect(code).toBe(1);
		expect(out.trim()).toBe("strays: s.md");
	});

	it("refuses on a new FAIL-severity list even where no severity is on the item, naming the list and the item", () => {
		// No `gating` on this profile, deliberately: it cannot see which keys
		// FAILed, so every list is compared and the caller establishes that
		// something failed at all.
		const { code, out } = doc({ uncovered: ["fresh.md"] }, { uncovered: [] });

		expect(code).toBe(1);
		expect(out.trim()).toBe("uncovered: fresh.md");
	});
});

describe("checker-new-faults, website-copy", () => {
	/** A check-website-copy.js FAIL finding, as the checker emits one. */
	const tell = (over: Record<string, unknown> = {}) => ({
		severity: "FAIL",
		tag: "AI-VOCAB",
		message: 'app/page.tsx:12 AI-VOCAB: "crucial" in "a crucial step"',
		file: "app/page.tsx",
		line: 12,
		match: "crucial",
		context: "a crucial step",
		...over,
	});

	it("refuses a commit that adds a tell, naming it", () => {
		const { code, out } = run(
			"website-copy",
			{ findings: [tell()] },
			{ findings: [] },
		);

		expect(code).toBe(1);
		expect(out).toContain("app/page.tsx");
	});

	it("passes a tell the baseline already carried", () => {
		const both = { findings: [tell()] };

		const { code, out } = run("website-copy", both, both);

		expect(code).toBe(0);
		expect(out.trim()).toBe("");
	});

	it("does not read a tell as new because an edit above moved its line", () => {
		// `context` is excluded from the identity too: a rewrite of the
		// neighbouring sentence changes it without touching the tell.
		const { code } = run(
			"website-copy",
			{
				findings: [
					tell({
						line: 40,
						context: "another crucial step",
						message:
							'app/page.tsx:40 AI-VOCAB: "crucial" in "another crucial step"',
					}),
				],
			},
			{ findings: [tell()] },
		);

		expect(code).toBe(0);
	});

	it("keeps two different tells in one file apart", () => {
		const { code, out } = run(
			"website-copy",
			{
				findings: [
					tell(),
					tell({
						tag: "COPULA",
						match: "serves as",
						context: "it serves as a hub",
						message:
							'app/page.tsx:12 COPULA: "serves as" in "it serves as a hub"',
					}),
				],
			},
			{ findings: [tell()] },
		);

		expect(code).toBe(1);
		expect(out).toContain("serves as");
		expect(out).not.toContain("a crucial step");
	});

	it("reads one of two identical tells being removed as unchanged", () => {
		// Both share an identity, deliberately: what refuses a commit is
		// INTRODUCING a tell, and the file still carries this one.
		const { code } = run(
			"website-copy",
			{ findings: [tell()] },
			{ findings: [tell(), tell({ line: 40 })] },
		);

		expect(code).toBe(0);
	});
});

describe("checker-new-faults, context-budget", () => {
	/*
	 * The measured profile (mantahostels#1834): the two over-cap findings are WARN and still
	 * gate. Tags are imported
	 * rather than spelled, so these fixtures follow a rename of the tag VALUE
	 * instead of quietly ceasing to exercise the predicate (mantahostels#1938).
	 */
	/* The live caps, so a fixture is never tagged over a cap it sits under. */
	const { pool: poolCap, injection: injectionCap } = liveCaps();

	const overPool = (total: number) => ({
		severity: "WARN",
		tag: OVER_POOL,
		message: `always-loaded pool is ${total} B, over the cap`,
		surface: "pool",
		total,
		cap: poolCap,
		over: total - poolCap,
	});
	const overInjection = (total: number) => ({
		...overPool(total),
		tag: OVER_INJECTION,
		surface: "injection",
		cap: injectionCap,
		over: total - injectionCap,
		message: `injected tracker docs are ${total} B, over the cap`,
	});
	/** An `admissibility` item: the mantahostels#1177 prompt's reading, and never a fault. */
	const admis = (bytes: number) => ({
		surface: "pool-files",
		bytes,
		message: `ADMISSIBILITY — the pool's own prose is ${bytes} B`,
	});

	it("refuses a commit that GROWS an already-over-cap pool, naming its new size", () => {
		const { code, out } = run(
			"context-budget",
			{ findings: [overPool(60_000)] },
			{ findings: [overPool(59_000)] },
		);

		expect(code).toBe(1);
		expect(out).toContain("60000 B");
	});

	it("passes a shed that leaves the pool still over cap", () => {
		const { code } = run(
			"context-budget",
			{ findings: [overPool(59_000)] },
			{ findings: [overPool(60_000)] },
		);

		expect(code).toBe(0);
	});

	it("refuses a surface the baseline never breached, naming its size", () => {
		const { code, out } = run(
			"context-budget",
			{ findings: [overPool(60_000)] },
			{ findings: [] },
		);

		expect(code).toBe(1);
		expect(out).toContain("60000 B");
	});

	it("gates the injection surface as well as the pool", () => {
		const { code, out } = run(
			"context-budget",
			{ findings: [overInjection(9000)] },
			{ findings: [overInjection(8000)] },
		);

		expect(code).toBe(1);
		expect(out).toContain("injected tracker docs");
	});

	it("compares each surface only against its own family", () => {
		const { code, out } = run(
			"context-budget",
			{ findings: [overPool(59_000), overInjection(9000)] },
			{ findings: [overPool(60_000)] },
		);

		expect(code).toBe(1);
		expect(out).toContain("injected tracker docs");
		expect(out).not.toContain("always-loaded pool");
	});

	it("never gates on `admissibility`, which is a note", () => {
		// The mantahostels#1177 prompt fires on a pool that GREW without breaching anything,
		// so both totals are derived to stay under the cap when it is re-priced.
		const { code } = run(
			"context-budget",
			{ admissibility: [admis(poolCap - 2000)] },
			{ admissibility: [admis(poolCap - 3000)] },
		);

		expect(code).toBe(0);
	});

	it("ignores an unrelated WARN, which is not gate material", () => {
		const { code } = run(
			"context-budget",
			{ findings: [{ severity: "WARN", tag: "SOMETHING-ELSE", message: "x" }] },
			{ findings: [] },
		);

		expect(code).toBe(0);
	});

	it("still gates a FAIL whatever its tag, echoing its message", () => {
		const { code, out } = run(
			"context-budget",
			{
				findings: [
					{ severity: "FAIL", tag: "BROKEN", message: "the checker broke" },
				],
			},
			{ findings: [] },
		);

		expect(code).toBe(1);
		expect(out).toContain("the checker broke");
	});
});

describe("checker-new-faults fails closed", () => {
	/*
	 * A WRITE that fails is the one place a partial list could escape (mantahostels#2314):
	 * an uncaught throw from the write exits 1, which gate_direction reads as a
	 * complete fault list.
	 *
	 * stdout goes to /dev/full, whose every write returns ENOSPC. Closing the fd
	 * instead (`>&-`) does NOT work — node reopens 0, 1 and 2 on /dev/null when
	 * it finds them closed, so the write succeeds and the case measures nothing.
	 * A real spawn through `sh`: runInProcess patches writeSync, so the fd this
	 * case turns on is not the one the script would see.
	 */
	it("exits 2 rather than 1 when it cannot write the fault list", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checker-new-faults-"));
		temps.push(dir);
		const write = (name: string, body: unknown) => {
			const abs = path.join(dir, name);
			fs.writeFileSync(abs, JSON.stringify(body));
			return abs;
		};
		const staged = write("staged.json", { dead: ["old.md", "new.md"] });
		const baseline = write("baseline.json", { dead: ["old.md"] });

		const r = spawnSync(
			"sh",
			[
				"-c",
				`exec "$1" "$2" doc-map "$3" "$4" >/dev/full`,
				"sh",
				process.execPath,
				SCRIPT,
				staged,
				baseline,
			],
			{ encoding: "utf8" },
		);

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not write the fault list");
	});

	it("exits 2 rather than 0 on an unreadable envelope", () => {
		const { code, err } = run("guard-registry", "{ not json", {});

		expect(code).toBe(2);
		expect(err).toContain("checker-new-faults");
	});

	it("exits 2 on an envelope that is not an object", () => {
		expect(run("guard-registry", ["a"], {}).code).toBe(2);
	});

	it("exits 2 when an envelope is missing entirely, naming checker-new-faults on stderr", () => {
		const r = runInProcess(SCRIPT, [
			"guard-registry",
			"/nope/a.json",
			"/nope/b.json",
		]);

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("checker-new-faults");
	});

	it("exits 2 when called with too few arguments, naming checker-new-faults on stderr", () => {
		const r = runInProcess(SCRIPT, ["guard-registry"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("checker-new-faults");
	});

	it("exits 2 on an unknown profile, naming the ones it has", () => {
		const r = runInProcess(SCRIPT, ["nope", "a", "b"]);

		expect(r.status).toBe(2);
		expect(r.stderr).toContain("guard-registry");
		expect(r.stderr).toContain("guard-test-isolation");
		expect(r.stderr).toContain("doc-map");
	});
});

describe("the profiles against the real checkers", () => {
	/*
	 * The live `--json` envelope, whatever the checker's exit code. Safe over
	 * runInProcess only because `extra` never carries `--against`: that flag
	 * routes through lib/check.js's reread(), which gives a grandchild
	 * stdio: "inherit" on stderr and bypasses the seam's captured output
	 * (run-in-process.js's exemption 7) — a future caller passing it here
	 * would silently under-report.
	 */
	const envelope = (checker: string, extra: string[] = []) => {
		const r = runInProcess(
			path.join(__dirname, checker),
			["--json", ...extra],
			{
				cwd: ROOT,
				env: { ...process.env, GITHUB_ACTIONS: "" },
			},
		);
		expect(r.stdout, `${checker} printed no --json envelope`).toContain(
			'"outcome"',
		);
		return r.stdout;
	};

	it("read check-guard-registry.js's envelope: a tree against itself is empty", () => {
		const live = envelope("check-guard-registry.js");

		expect(run("guard-registry", live, live).code).toBe(0);
	});

	it("read check-guard-test-isolation.js's envelope the same way", () => {
		const live = envelope("check-guard-test-isolation.js");

		expect(run("guard-test-isolation", live, live).code).toBe(0);
	});

	it("read check-doc-map.js's envelope the same way", () => {
		const live = envelope("check-doc-map.js");

		expect(run("doc-map", live, live).code).toBe(0);
	});

	it("read check-website-copy.js's envelope the same way", () => {
		const live = envelope("check-website-copy.js");

		expect(run("website-copy", live, live).code).toBe(0);
	});

	it("read check-context-budget.js's envelope the same way", () => {
		const live = envelope("check-context-budget.js");

		expect(run("context-budget", live, live).code).toBe(0);
	});

	it("reads a grown pool total off the real envelope as a new fault", () => {
		/*
		 * The live tree may be under both caps, so the envelope alone exercises
		 * only the inherited direction.
		 */
		const live = JSON.parse(envelope("check-context-budget.js"));
		const at = (total: number) => ({
			...live,
			findings: [
				{
					severity: "WARN",
					tag: OVER_POOL,
					message: `always-loaded pool is ${total} B, over the cap`,
					surface: "pool",
					total,
				},
			],
		});

		expect(run("context-budget", at(60_000), at(59_000)).code).toBe(1);
		expect(run("context-budget", at(59_000), at(60_000)).code).toBe(0);
	});

	it("agrees that --root over a HEAD checkout inherits every live FAIL", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "head-tree-"));
		temps.push(dir);
		const tar = path.join(dir, "head.tar");
		spawnSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], {
			cwd: ROOT,
		});
		spawnSync("tar", ["-xf", tar, "-C", dir]);
		fs.rmSync(tar);

		/* FAILs only: a staleness warning gates too (#2617), and a neighbour's
		 * dirty edit to any library a guard hashes makes one the live tree has
		 * and HEAD does not. */
		const failsOf = (raw: string) => {
			const e = JSON.parse(raw);
			return {
				...e,
				findings: e.findings.filter(
					(f: { severity: string }) => f.severity === "FAIL",
				),
			};
		};
		const live = failsOf(envelope("check-guard-registry.js"));
		const base = failsOf(envelope("check-guard-registry.js", ["--root", dir]));

		const { code, out } = run("guard-registry", live, base);
		expect(
			out,
			"an uncommitted rule edit in the shared tree can cause this",
		).toBe("");
		expect(code).toBe(0);
	});
});
