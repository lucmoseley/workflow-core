// @vitest-environment node
/*
 * Pins pretest-reap.js: it reaps finished sessions only when memory is short of
 * the rung the starting suite needs, never refuses the suite on any failure,
 * and is wired as both npm pre-scripts (mantahostels#1840, #633).
 *
 * The script is run end to end through runInProcess (#1369: nothing is
 * exported for its tests), with its three outside reads pointed at fixtures by
 * the env seams it already has. So no test here reads this machine's memory
 * or stops a real session.
 *
 * It runs before every `npm run test`: loosen a case and a suite is hard-blocked
 * by a failing pre-script, or a short session stops to ask the founder for
 * memory the reap would have freed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUITE_RESTING_MB } from "./lib/admission.js";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "pretest-reap.js");

/** A rung's resting MB, read out of admission.js rather than copied (mantahostels#2715). */
const R1 = SUITE_RESTING_MB[1];
const R2 = SUITE_RESTING_MB[2];
const R3 = SUITE_RESTING_MB[3];
const ONE = `the ${R1} MB one-suite rung`;

/* A process line admission.js counts as one running vitest suite. */
const VITEST = "node /r/node_modules/.bin/vitest run";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pretest-reap-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const meminfoLine = (mb: number) => `MemAvailable: ${mb * 1024} kB\n`;

/**
 * Run the script with `mbs[0]` MB available before the reap and `mbs[1]` (or
 * `mbs[0]` again) after it. `suites: null` makes `ps` fail; `reaper: "throws"`
 * makes the stub reaper die with a stack on stderr.
 */
function run(opts: {
	mbs?: number[];
	unreadable?: boolean;
	suites?: number | null;
	/** Further `ps` lines beside the `suites` whole ones. */
	ps?: string[];
	reaper?: "throws";
}) {
	const meminfo = path.join(dir, "meminfo");
	const mbs = opts.mbs ?? [];
	if (!opts.unreadable) fs.writeFileSync(meminfo, meminfoLine(mbs[0]));
	const count = path.join(dir, "reaps");
	fs.rmSync(count, { force: true });
	const reaper = path.join(dir, "reap.js");
	const after = mbs[1] ?? mbs[0];
	fs.writeFileSync(
		reaper,
		opts.reaper === "throws"
			? `require("node:fs").appendFileSync(${JSON.stringify(count)}, "x");
throw new Error("boom");
`
			: `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(count)}, "x");
${opts.unreadable ? "" : `fs.writeFileSync(${JSON.stringify(meminfo)}, ${JSON.stringify(meminfoLine(after))});`}
process.stdout.write("reap: 1 of 1 session(s) returned 400 MB.\\n");
`,
	);
	const ps =
		opts.suites === null
			? writePsStub(dir, [], { fails: true })
			: writePsStub(dir, [
					"bash -l",
					...Array.from({ length: opts.suites ?? 0 }, () => VITEST),
					...(opts.ps ?? []),
				]);
	const r = runInProcess(SCRIPT, [], {
		env: {
			...process.env,
			WFC_MEMINFO: meminfo,
			WFC_PS: ps,
			WFC_REAP_SCRIPT: reaper,
		},
	});
	const reaps = fs.existsSync(count)
		? fs.readFileSync(count, "utf8").length
		: 0;
	const lines = r.stdout.split("\n").filter((l) => l !== "");
	return { code: r.status, lines, reaps, text: r.stdout };
}

describe("pretest-reap.js", () => {
	it("reaps nothing and says nothing above the rung", () => {
		const r = run({ mbs: [R1] });
		expect(r.reaps).toBe(0);
		expect(r.lines).toEqual([]);
		expect(r.code).toBe(0);
	});

	it("reaps below the rung and reports the recovered headroom", () => {
		const r = run({ mbs: [R1 - 700, R1 + 100] });
		expect(r.reaps).toBe(1);
		expect(r.text).toContain(`${R1 - 700} MB available, under ${ONE}`);
		expect(r.text).toContain("returned 400 MB");
		expect(r.text).toContain(`${R1 + 100} MB available now — above ${ONE}`);
		expect(r.code).toBe(0);
	});

	it("warns rather than refuses when the reap leaves it short, naming the MB left, the threshold and the earlyoom risk", () => {
		const r = run({ mbs: [R1 - 1300, R1 - 1000] });
		expect(r.text).toContain(`still ${R1 - 1000} MB available, under ${ONE}`);
		expect(r.text).toContain("earlyoom may kill it");
		expect(r.code).toBe(0);
	});

	it("runs the suite anyway when memory cannot be read", () => {
		const r = run({ unreadable: true });
		expect(r.reaps).toBe(0);
		expect(r.text).toContain("pretest: available memory unread (");
		expect(r.text).toContain("suite runs anyway");
		expect(r.code).toBe(0);
	});

	/* The reaper's stack goes to its own stderr; only the first line of the
	 * error (execFileSync's "Command failed") reaches the suite's output. */
	it("runs the suite anyway when the reaper throws", () => {
		const r = run({ mbs: [R1 - 1500], reaper: "throws" });
		expect(r.reaps).toBe(1);
		expect(r.text).toContain("reap: did not run — Command failed");
		expect(r.text).not.toContain("boom");
		expect(r.code).toBe(0);
	});

	/* Rung n + 1 for n running: its own figure reaps just under, stays silent at it. */
	it.each([
		[0, 1, ONE],
		[1, 2, `the ${R2} MB rung for suite 2 of 3`],
		[2, 3, `the ${R3} MB rung for suite 3 of 3`],
	] as const)(
		"with %i running, judges against rung %i",
		(suites, rung, name) => {
			const mb = SUITE_RESTING_MB[rung];
			const short = run({ mbs: [mb - 1, mb + 100], suites });
			expect(short.reaps).toBe(1);
			expect(short.text).toContain(`${mb - 1} MB available, under ${name}`);
			expect(short.code).toBe(0);

			const at = run({ mbs: [mb], suites });
			expect(at.reaps).toBe(0);
			expect(at.lines).toEqual([]);
			expect(at.code).toBe(0);
		},
	);

	/* Past the cap the guard's extrapolated rung: 349 MB a worker past 9. */
	it("judges a suite past the cap against the rung for its workers", () => {
		const r = run({ mbs: [4699, 4699], suites: 3 });
		expect(r.reaps).toBe(1);
		expect(r.text).toContain(
			"under the 4700 MB rung for 12 vitest workers, 9 of them already running",
		);
		const five = run({ mbs: [6799, 6799], suites: 5 });
		expect(five.text).toContain(
			"under the 6800 MB rung for 18 vitest workers, 15 of them already running",
		);
		const above = run({ mbs: [4700], suites: 3 });
		expect(above.reaps).toBe(0);
		expect(above.lines).toEqual([]);
	});

	/* A running 1-file run weighs 1 worker, not a whole suite (#2560). */
	it("judges a whole launch beside one running 1-file run against the 2,500 MB rung", () => {
		const ps = [
			"node /r/node_modules/.bin/vitest run --passWithNoTests a.test.ts",
		];
		const short = run({ mbs: [2499, 2499], ps });
		expect(short.reaps).toBe(1);
		expect(short.text).toContain(
			"under the 2500 MB rung for 4 vitest workers, 1 of them already running",
		);
		const at = run({ mbs: [2500], ps });
		expect(at.reaps).toBe(0);
		expect(at.lines).toEqual([]);
	});

	it("names the second-suite rung when still short after the reap", () => {
		const r = run({ mbs: [R2 - 400, R2 - 300], suites: 1 });
		expect(r.text).toContain(
			`still ${R2 - 300} MB available, under the ${R2} MB rung for suite 2 of 3`,
		);
		expect(r.code).toBe(0);
	});

	it("falls back to the one-suite rung, saying so, when the count is unread", () => {
		const green = run({ mbs: [R1 + 500], suites: null });
		expect(green.reaps).toBe(0);
		expect(green.lines).toEqual([
			`pretest: running suites unread (ps: cannot read /proc) — judging against ${ONE}`,
		]);
		expect(green.code).toBe(0);

		const short = run({ mbs: [R1 - 500, R1 + 100], suites: null });
		expect(short.reaps).toBe(1);
		expect(short.text).toContain(`under ${ONE}`);
		expect(short.code).toBe(0);
	});
});

/* npm fires `pre<name>` for script `<name>` and no other, so each npm suite
 * command needs its own pre-script to reap on its way in (#633). */
describe("package.json wiring (#633)", () => {
	const pkg = JSON.parse(
		fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
	);

	it.each(["test", "test:changed"])(
		"runs the reap before `npm run %s`",
		(name) => {
			expect(pkg.scripts[`pre${name}`]).toBe("node scripts/pretest-reap.js");
		},
	);

	/* The reap belongs in the pre-script: chained into `test:changed` itself,
	 * a reap failure would fail the run. */
	it("leaves `test:changed` itself the plain `--changed` run", () => {
		expect(pkg.scripts["test:changed"]).toMatch(
			/node scripts\/run-vitest\.js --changed$/,
		);
	});
});
