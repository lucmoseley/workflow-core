// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suiteRungMb, WHOLE_SUITE_WORKERS } from "./lib/admission.js";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process.js";
import { EARLYOOM_FLOOR_MB } from "./lib/suite-ladder.js";

const SCRIPT = path.join(__dirname, "pretest-reap.js");

const rungMb = (n: number) => suiteRungMb(n * WHOLE_SUITE_WORKERS);
const R1 = rungMb(1);
const R2 = rungMb(2);
const R3 = rungMb(3);
const ONE = `the ${R1} MB one-suite rung`;

const VITEST = "node /r/node_modules/.bin/vitest run";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pretest-reap-"));
});
afterEach(() => {
	totalLine = "";
	fs.rmSync(dir, { recursive: true, force: true });
});

let totalLine = "";
const buildMeminfoLine = (mb: number) =>
	`${totalLine}MemAvailable: ${mb * 1024} kB\n`;

function run(opts: {
	mbs?: number[];
	unreadable?: boolean;
	suites?: number | null;
	ps?: string[];
	reaper?: "throws";
}) {
	const meminfo = path.join(dir, "meminfo");
	const mbs = opts.mbs ?? [];
	if (!opts.unreadable) fs.writeFileSync(meminfo, buildMeminfoLine(mbs[0]));
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
${opts.unreadable ? "" : `fs.writeFileSync(${JSON.stringify(meminfo)}, ${JSON.stringify(buildMeminfoLine(after))});`}
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

	it("runs the suite anyway when the reaper throws", () => {
		const r = run({ mbs: [R1 - 1500], reaper: "throws" });
		expect(r.reaps).toBe(1);
		expect(r.text).toContain("reap: did not run — Command failed");
		expect(r.text).not.toContain("boom");
		expect(r.code).toBe(0);
	});

	it.each([
		[0, 1, ONE],
		[1, 2, `the ${R2} MB rung for suite 2 of 3`],
		[2, 3, `the ${R3} MB rung for suite 3 of 3`],
	] as const)(
		"with %i running, judges against rung %i",
		(suites, rung, name) => {
			const mb = rungMb(rung);
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

	it("judges a suite past the cap against the rung for its workers", () => {
		const r = run({ mbs: [10_499, 10_499], suites: 3 });
		expect(r.reaps).toBe(1);
		expect(r.text).toContain(
			"under the 10500 MB rung for 20 vitest workers, 15 of them already running",
		);
		const five = run({ mbs: [15_749, 15_749], suites: 5 });
		expect(five.text).toContain(
			"under the 15750 MB rung for 30 vitest workers, 25 of them already running",
		);
		const above = run({ mbs: [10_500], suites: 3 });
		expect(above.reaps).toBe(0);
		expect(above.lines).toEqual([]);
	});

	it("clamps a rung past MemTotal less earlyoom's line, and says so", () => {
		totalLine = "MemTotal: 10168320 kB\n";
		const ceiling = 9930 - EARLYOOM_FLOOR_MB;
		const short = run({ mbs: [ceiling - 1], suites: 3 });
		expect(short.reaps).toBe(1);
		expect(short.text).toContain(
			`under the ${ceiling} MB rung for 20 vitest workers, 15 of them already running (clamped from ~${suiteRungMb(20)} MB, out of the machine's reach`,
		);
		const at = run({ mbs: [ceiling], suites: 3 });
		expect(at.reaps).toBe(0);
	});

	it("judges a whole launch beside one running 1-file run against the 3,650 MB rung", () => {
		const ps = [
			"node /r/node_modules/.bin/vitest run --passWithNoTests a.test.ts",
		];
		const short = run({ mbs: [3649, 3649], ps });
		expect(short.reaps).toBe(1);
		expect(short.text).toContain(
			"under the 3650 MB rung for 6 vitest workers, 1 of them already running",
		);
		const at = run({ mbs: [3650], ps });
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

	it("leaves `test:changed` itself the plain `--changed` run", () => {
		expect(pkg.scripts["test:changed"]).toMatch(
			/node scripts\/run-vitest\.js --changed$/,
		);
	});
});
