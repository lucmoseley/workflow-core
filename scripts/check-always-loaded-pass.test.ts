// @vitest-environment node
/*
 * Pins when check-always-loaded-pass.js calls the always-loaded pool due a
 * concision pass — a month since the recorded pass, or the pool
 * near its cap — that an unreadable input reads BROKEN, and that no finding
 * ever gates (mantahostels#2500).
 *
 * check-always-loaded-pass.js reports off two inputs: a committed record of
 * the newest pass, and the pool's live headroom. Both are fabricated here — the
 * record as a temp file, the headroom through the `--headroom` seam — because
 * the live figures move with every commit and a test reading them would pass
 * or fail by what someone else pushed.
 *
 * The wall clock is pinned through WFC_NOW for the same reason: a calendar
 * trigger asserted against `Date.now()` changes verdict overnight.
 *
 * It reports through `npm run status` and gates nothing: loosen a case and a
 * due pass goes unannounced while every session keeps paying for the pool's
 * excess bytes, or a pass is called due when none is.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPoolFiles } from "./lib/always-loaded-pool.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-always-loaded-pass.js");
const ROOT = path.resolve(__dirname, "..");
const SHA = "a".repeat(40);
const TODAY = "2026-10-01T09:00:00Z";

let dir: string;
let record: string;

const write = (passes: unknown) => {
	fs.writeFileSync(record, JSON.stringify({ passes }));
	return record;
};

const pass = (date: string) => ({ date, sha: SHA, issue: "#2500" });

const at = (args: string[], extraEnv: Record<string, string> = {}) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: ROOT,
		env: { ...process.env, WFC_NOW: TODAY, ...extraEnv },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const run = (...extra: string[]) => at(["--record", record, ...extra]);

/* Headroom well clear of the margin, so a case testing the calendar trigger is
 * not answered by the other one. */
const SLACK = ["--headroom", "5000"];

/* Writes a recent pass and reads the margin the program reports under --json:
 * the figure is re-measured by hand, so a copy here would go stale. */
const recordPassReadMargin = (): number => {
	write([pass("2026-09-28")]);
	return JSON.parse(run(...SLACK, "--json").out).margin;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-pass-test-"));
	record = path.join(dir, "always-loaded-passes.json");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("check-always-loaded-pass", () => {
	it("is OK and silent under --notify when no trigger fires", () => {
		write([pass("2026-09-20")]);
		const r = run(...SLACK, "--notify");
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
	});

	it("names the next due date when it is not due", () => {
		write([pass("2026-09-20")]);
		const r = run(...SLACK);
		expect(r.status).toBe(0);
		expect(r.out).toContain("2026-10-20");
		expect(r.out).not.toContain("a concision pass is due");
	});

	it("WARNs once a calendar month has passed, naming the date it fell due", () => {
		write([pass("2026-08-25")]);
		const r = run(...SLACK);
		expect(r.status).toBe(0);
		expect(r.out).toContain("a concision pass is due");
		expect(r.out).toContain("due since 2026-09-25");
		expect(r.out).not.toContain("full period missed");
	});

	it("says a full period was missed once two months have passed", () => {
		write([pass("2026-07-25")]);
		const r = run(...SLACK);
		expect(r.status).toBe(0);
		expect(r.out).toContain("full period missed");
	});

	it("WARNs on thin headroom alone, well inside the calendar period, naming the headroom against the margin", () => {
		const m = recordPassReadMargin();
		const r = run("--headroom", "10");
		expect(r.status).toBe(0);
		expect(r.out).toContain("a concision pass is due");
		expect(r.out).toContain(`headroom 10 B, under the ${m} B margin`);
		expect(r.out).not.toContain("due since");
	});

	it("is silent at exactly the margin, and fires one byte under it", () => {
		const m = recordPassReadMargin();
		expect(run("--headroom", String(m)).out).not.toContain(
			"a concision pass is due",
		);
		expect(run("--headroom", String(m - 1)).out).toContain(
			"a concision pass is due",
		);
	});

	it("WARNs when the record holds no pass at all", () => {
		write([]);
		const r = run(...SLACK);
		expect(r.status).toBe(0);
		expect(r.out).toContain("no pass has ever been recorded");
		expect(r.out).toContain("none recorded");
	});

	it("is BROKEN when the record file is absent", () => {
		const r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read the pool-pass record");
	});

	it("is BROKEN when the record is unparseable", () => {
		fs.writeFileSync(record, "{ not json");
		const r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot parse");
	});

	it("is BROKEN when the record has no passes array", () => {
		fs.writeFileSync(record, JSON.stringify({ history: [] }));
		const r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain('has no "passes" array');
	});

	it("is BROKEN on a pass with a malformed date or sha", () => {
		write([{ date: "25 August 2026", sha: SHA }]);
		let r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain("YYYY-MM-DD");
		write([{ date: "2026-08-25", sha: "abc1234" }]);
		r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain('40-hex "sha"');
	});

	it("is BROKEN on a second pass, so a pass replaces the entry rather than appending", () => {
		write([pass("2026-08-25"), pass("2026-09-20")]);
		const r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain("records 2 passes");
		expect(r.out).toContain("replace the entry rather than appending one");
	});

	it("is BROKEN on a pass carrying a field beside date, sha and issue", () => {
		write([{ ...pass("2026-09-20"), files: [] }]);
		const r = run(...SLACK);
		expect(r.status).toBe(2);
		expect(r.out).toContain("carries date, sha and issue alone, got files");
	});

	/* check-always-loaded-pass.js spawns the budget checker off its own
	 * __dirname, never off --root (#36), so a fixture copy is pointed at
	 * through WFC_BUDGET_SCRIPT_FILE (`lib/host-root.js`'s header convention)
	 * rather than planted under `dir` where nothing spawns it any more. */

	it("is BROKEN when the budget checker cannot be run", () => {
		write([pass("2026-09-20")]);
		const r = at(["--record", record, "--root", dir], {
			WFC_BUDGET_SCRIPT_FILE: path.join(dir, "no-such-budget-script.js"),
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("did not answer");
	});

	const fakeBudget = (out: string) => {
		const file = path.join(dir, "fake-check-context-budget.js");
		fs.writeFileSync(file, `console.log(${JSON.stringify(out)});`);
		return file;
	};

	it("is BROKEN when the budget checker answers with something else", () => {
		write([pass("2026-09-20")]);
		const file = fakeBudget("no envelope here");
		const r = at(["--record", record, "--root", dir], {
			WFC_BUDGET_SCRIPT_FILE: file,
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot parse");
	});

	it("is BROKEN when the envelope carries no headroom", () => {
		write([pass("2026-09-20")]);
		const file = fakeBudget(JSON.stringify({ outcome: "OK", cap: 38_000 }));
		const r = at(["--record", record, "--root", dir], {
			WFC_BUDGET_SCRIPT_FILE: file,
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("no numeric headroom and cap");
	});

	it("reports the due date, the last pass's sha, the scope and the headroom", () => {
		write([pass("2026-08-25")]);
		const out = run("--headroom", "10").out;
		expect(out).toContain("2026-09-25");
		expect(out).toContain(SHA.slice(0, 8));
		for (const member of getPoolFiles()) expect(out).toContain(member);
		expect(out).toContain("10 B");
	});

	it("excludes docs/doc-map.md from the scope it reports", () => {
		write([pass("2026-08-25")]);
		const out = run(...SLACK).out;
		expect(out).toContain("excluded:");
		expect(out).toMatch(/excluded: *docs\/doc-map\.md/);
		expect(out).not.toMatch(/in scope:.*docs\/doc-map\.md/);
	});

	/* Criterion 6 of mantahostels#2500. A FAIL is what gates, so the assertion is on the
	 * severity in the envelope as well as on the exit code — a checker that
	 * exited 2 on every input would pass the exit-code half alone. */
	it("never gates: no input produces a finding that fails a gate", () => {
		for (const [passes, extra] of [
			[[pass("2026-09-20")], SLACK],
			[[pass("2026-08-25")], SLACK],
			[[pass("2026-05-25")], SLACK],
			[[], SLACK],
			[[pass("2026-09-28")], ["--headroom", "0"]],
			[[pass("2026-09-28")], ["--headroom", "-500"]],
		] as [unknown[], string[]][]) {
			write(passes);
			const r = run(...extra, "--json");
			expect(r.status).not.toBe(1);
			const findings = JSON.parse(r.out).findings as { severity: string }[];
			expect(findings.map((f) => f.severity)).not.toContain("FAIL");
		}
	});

	/* The one case outside the fabricated inputs above: it reads the committed
	 * record, the live pool and the wall clock, which is what makes a record
	 * someone hand-edits into an unparseable state fail here rather than at a
	 * session start. Its verdict therefore moves with the repo, so it asserts
	 * only that the apparatus works — never which trigger fired. */
	it("reads the live repo's record and pool without BROKENing", () => {
		const r = runInProcess(SCRIPT, [], { cwd: ROOT });
		expect(r.status).not.toBe(2);
	});
});
