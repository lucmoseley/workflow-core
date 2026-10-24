// @vitest-environment node
/*
 * Pins that the route report splits the pass receipts by route with each arm's
 * mean, and names an unusable directory rather than reporting no evidence.
 *
 * The CLI over the `.concision-pass-<sid>` receipts is driven in-process
 * against a throwaway directory.
 *
 * The parsing and totalling are asserted in-process next to the seam
 * (scripts/lib/concision-receipts.test.ts). What is left here is what only a
 * end-to-end run can show.
 *
 * What breaking these costs: this command is how mantahostels#1099's held question —
 * subagent passes against in-session ones — gets answered, and it is run once,
 * by hand. A crash or a silently empty table would be read as "no evidence".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "concision-route-report.js");

let dir: string;

/** Drops one receipt into the throwaway directory, as a pass's step 6 would. */
const receipt = (sid: string, findings: number, route?: string) =>
	fs.writeFileSync(
		path.join(dir, `.concision-pass-${sid}`),
		`base=${"a".repeat(40)}\nfindings=${findings}\n${route ? `route=${route}\n` : ""}`,
	);

/** Runs the CLI, returning both streams and the exit code. */
const run = (...args: string[]) =>
	runInProcess(SCRIPT, args, {
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "receipts-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("reporting the receipts in a directory (mantahostels#1099)", () => {
	it("splits the runs by route, naming each arm and its mean", () => {
		receipt("a", 10, "subagent");
		receipt("b", 4, "subagent");
		receipt("c", 12, "in-session");

		const r = run("--dir", dir);
		expect(r.stdout).toContain("| subagent | 2 | 14 | 7.0 | 0 |");
		expect(r.stdout).toContain("| in-session | 1 | 12 | 12.0 | 0 |");
		expect(r.status).toBe(0);
	});

	it("reads only the pass receipts, not the other session-suffixed files", () => {
		receipt("a", 10, "subagent");
		fs.writeFileSync(
			path.join(dir, ".codereview-pass-a"),
			"base=x\nfindings=99\n",
		);
		fs.writeFileSync(path.join(dir, ".concision-base-a"), "a".repeat(40));

		expect(run("--dir", dir).stdout).toContain("1 concision-pass receipts");
	});

	it("says so rather than printing an empty table when there are none", () => {
		expect(run("--dir", dir).stdout).toContain("0 concision-pass receipts");
	});
});

describe("a directory argument that is not usable (mantahostels#1099)", () => {
	// The paired positive is the passing --dir above. A bare --dir used to reach
	// readdirSync(undefined) and throw a stack trace at the one session that
	// will ever run this.
	it("names the missing path rather than crashing on a bare --dir", () => {
		const r = run("--dir");
		expect(r.stderr).toContain("--dir needs a value");
		expect(r.stderr).toContain("usage: node scripts/concision-route-report.js");
		expect(r.status).toBe(2);
	});

	it("refuses an unknown flag rather than reading the host root (#2218)", () => {
		const r = run("--dri", dir);
		expect(r.stderr).toContain("unknown flag: --dri");
		expect(r.stderr).toContain("usage: node scripts/concision-route-report.js");
		expect(r.stdout).toBe("");
		expect(r.status).toBe(2);
	});

	it("answers --help with the usage and reads nothing (#2218)", () => {
		const r = run("--help");
		expect(r.stdout).toContain("usage: node scripts/concision-route-report.js");
		expect(r.stdout).not.toContain("concision-pass receipts");
		expect(r.status).toBe(0);
	});

	it("names an unreadable directory rather than reporting an empty corpus", () => {
		const absent = path.join(dir, "absent");
		const r = run("--dir", absent);
		expect(r.stderr).toContain(`Cannot read receipts in ${absent}`);
		// Never a build failure: this command gates nothing.
		expect(r.status).toBe(0);
	});
});
