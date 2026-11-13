// @vitest-environment node
/*
 * precommit-gate-verdicts.js, the gates' verdict wording in Node (#5155).
 *
 * The module cases pin each branch of the direction verdict (mantahostels#1688,
 * mantahostels#2026). The production-port cases run it over the comparison as
 * doc-map-gate-ports.js spawns it, so node's own exit on a crash meets the
 * verdict for real. The parity case runs scripts/lib/precommit-gate.sh's
 * skip and deletion functions once, in one shell, and holds each Node namesake
 * to the bytes it prints: the two copies serve different gates, and a reworded
 * shell line with no matching Node change would leave one gate's refusal
 * differing from the rest, and the commit-gate refusal table matching only one
 * of them.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realPorts } from "./doc-map-gate-ports.js";
import {
	allowDeleteLine,
	deletionUnknownLine,
	directionVerdict,
	refuseDeletedLines,
	skipLine,
} from "./precommit-gate-verdicts.js";

const LIB = path.join(__dirname, "precommit-gate.sh");

const run = (status: number, stdout: string, stderr = "") => ({
	status,
	stdout,
	stderr,
});

describe("the direction verdict", () => {
	it("passes where every fault is inherited, saying the sweeps still fail on them", () => {
		const v = directionVerdict("doc-map", "mantahostels#1688", run(0, ""));
		expect(v.pass).toBe(true);
		expect(v.text).toBe(
			"pre-commit: every FAIL finding the doc-map check reported above is already in HEAD, so this commit did not cause one — passing (mantahostels#1688).\n" +
				"  They still FAIL the scheduled sweeps, which run a clean checkout, and block nothing here only because they are inherited.\n",
		);
	});

	it("refuses a fault this commit adds, naming each one indented", () => {
		const v = directionVerdict(
			"doc-map",
			"#1",
			run(1, "dead: a.md\ndead: b.md\n"),
		);
		expect(v.pass).toBe(false);
		expect(v.text).toBe(
			"pre-commit: the doc-map fault(s) below are NOT in HEAD — this commit adds them:\n  dead: a.md\n  dead: b.md\n",
		);
	});

	it("fails closed on a clean 1 that names nothing, never reading it as a pass", () => {
		const v = directionVerdict("doc-map", "#1", run(1, ""));
		expect(v.pass).toBe(false);
		expect(v.text).toBe(
			"pre-commit: could not tell inherited doc-map faults from new ones — refusing.\n",
		);
	});

	it("fails closed on any other exit, replaying what it printed", () => {
		const v = directionVerdict(
			"doc-map",
			"#1",
			run(2, "envelope unreadable\n"),
		);
		expect(v.pass).toBe(false);
		expect(v.text).toBe(
			"pre-commit: could not tell inherited doc-map faults from new ones — refusing.\nenvelope unreadable\n",
		);
	});

	// mantahostels#2026: a crash's trace is diagnostics, never the fault list.
	it("sets the comparison's stderr apart as diagnostics, on a pass and a refusal alike", () => {
		const diag =
			"\npre-commit: the doc-map comparison also wrote to stderr — diagnostics, not findings:\n  | one\n  | two\n";
		expect(
			directionVerdict("doc-map", "#1", run(0, "", "one\ntwo\n")).text.endsWith(
				diag,
			),
		).toBe(true);
		expect(
			directionVerdict("doc-map", "#1", run(1, "", "one\ntwo\n")).text,
		).toContain(diag);
	});
});

/*
 * Over the comparison as the production port spawns it: a stub
 * checker-new-faults.js per case, so what node itself does on an absent
 * script, a parse error or a throw reaches the verdict unmodelled.
 */
describe("the direction verdict over the production comparison port", () => {
	const notAnAnswer = "could not tell inherited doc-map faults";
	const addsThem = "are NOT in HEAD";
	const diagnostics = "diagnostics, not findings";

	/** The verdict on a comparison whose script body is `body`, or none at all. */
	const verdictOn = (body: string | null) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-verdicts-cmp-"));
		try {
			if (body !== null)
				fs.writeFileSync(path.join(dir, "checker-new-faults.js"), body);
			const made: string[] = [];
			const ports = realPorts(dir, made, {
				cwd: process.cwd(),
				env: process.env,
			});
			return directionVerdict(
				"doc-map",
				"#1",
				ports.newFaults(
					path.join(dir, "staged.json"),
					path.join(dir, "baseline.json"),
				),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
	const exits = (code: number, stdout = "", stderr = "") =>
		`${stdout ? `console.log(${JSON.stringify(stdout)});\n` : ""}` +
		`${stderr ? `console.error(${JSON.stringify(stderr)});\n` : ""}` +
		`process.exit(${code});\n`;

	it("refuses when the comparison script is not there at all, as a failure to answer, not as new faults", () => {
		const v = verdictOn(null);
		expect(v.pass).toBe(false);
		expect(v.text).toContain(notAnAnswer);
		expect(v.text).not.toContain(addsThem);
		expect(v.text).not.toContain("already in HEAD");
	});

	it("refuses a comparison that will not parse, as a failure to answer, not as new faults", () => {
		const v = verdictOn("function (\n");
		expect(v.pass).toBe(false);
		expect(v.text).toContain(notAnAnswer);
		expect(v.text).not.toContain(addsThem);
	});

	/* The stack trace is the crash's, so it must reach the session labelled as
	 * diagnostics rather than as the faults this commit added. */
	it("refuses a comparison that throws before it runs, saying it could not tell inherited faults, and labels the trace", () => {
		const v = verdictOn('throw new Error("boom at require time");\n');
		expect(v.pass).toBe(false);
		expect(v.text).toContain(notAnAnswer);
		expect(v.text).not.toContain(addsThem);
		expect(v.text).toContain(diagnostics);
		expect(v.text).toContain("boom at require time");
	});

	/* EXIT 1 OBLIGES A FAULT LIST (mantahostels#2026): a 1 that named nothing on either
	 * stream has answered nothing. A comparison that wrote nothing gets no
	 * diagnostics block. */
	it("refuses a silent exit 1 as a failure to answer, not as new faults, with no diagnostics block", () => {
		const v = verdictOn(exits(1));
		expect(v.pass).toBe(false);
		expect(v.text).toContain(notAnAnswer);
		expect(v.text).not.toContain(addsThem);
		expect(v.text).not.toContain(diagnostics);
	});

	/* THE VERDICT IS THE EXIT STATUS, NEVER THE TEXT: a test of the
	 * comparison's stdout refuses every commit a chatty clean run should pass. */
	it("passes a clean comparison that printed something anyway", () => {
		const v = verdictOn(exits(0, "nothing new here"));
		expect(v.pass).toBe(true);
		expect(v.text).toContain("already in HEAD");
		expect(v.text).not.toContain(diagnostics);
	});

	it("passes a clean comparison that wrote to stderr, and replays it", () => {
		const v = verdictOn(exits(0, "", "warning: sidecar is stale"));
		expect(v.pass).toBe(true);
		expect(v.text).toContain(diagnostics);
		expect(v.text).toContain("sidecar is stale");
	});

	// Both streams on the one limb (mantahostels#2026).
	it("keeps a noisy stderr out of the fault list it refuses on", () => {
		const v = verdictOn(exits(1, "dead: docs/x.md", "note: cache miss"));
		expect(v.pass).toBe(false);
		expect(v.text).toContain(addsThem);
		expect(v.text).toContain("  dead: docs/x.md");
		expect(v.text).toContain("  | note: cache miss");
		expect(v.text).not.toContain("  note: cache miss\n");
	});

	/* THE COMPOSITION, pinned by the verdict (mantahostels#2314): lib/fault-diff.test.ts
	 * proves the comparison exits 2 on a crash, the module cases above what the
	 * verdict does with each code, and this that the two meet. The stub runs
	 * the shared CLI with its writes wrapped, so it prints part of a fault list
	 * and then crashes. */
	it("refuses a comparison that crashes mid-list as a failure to answer, not as new faults, under a diagnostics block", () => {
		const seam = JSON.stringify(path.join(__dirname, "fault-diff.js"));
		const v = verdictOn(`const fs = require("node:fs");
const [, , , staged, baseline] = process.argv;
fs.writeFileSync(staged, JSON.stringify({ findings: ["docs/a.md dead"] }));
fs.writeFileSync(baseline, JSON.stringify({ findings: [] }));
const inner = fs.writeSync;
let stderrFailed = false;
fs.writeSync = (fd, data, ...rest) => {
	if (fd === 1) {
		inner(1, String(data).slice(0, 16));
		throw new Error("stdout went away mid-list");
	}
	if (fd === 2 && !stderrFailed) {
		stderrFailed = true;
		throw new Error("stderr went away too");
	}
	return inner(fd, data, ...rest);
};
require(${seam}).runCli("demo", staged, baseline, {
	keys: (k) => k === "findings",
	identity: (i) => i,
});
`);
		expect(v.pass).toBe(false);
		expect(v.text).toContain(notAnAnswer);
		expect(v.text).not.toContain(addsThem);
		expect(v.text).toContain(diagnostics);
		expect(v.text).toContain("crashed before it finished the fault list");
	});
});

describe("the Node verdicts print what precommit-gate.sh's functions print", () => {
	it("gate_skip, gate_refuse_deleted, gate_check_deleted's escape and gate_stage_out's warning", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-verdicts-"));
		const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		const script = [
			`. ${q(LIB)}`,
			"echo @@ >&2; gate_skip doc-map 'git checkout-index would not write it'",
			"echo @@ >&2; GATE_DELETED=', docs/a.md, docs/b.md'; gate_refuse_deleted doc-map",
			"echo @@ >&2; WFC_ALLOW_GATE_INPUT_DELETE=1; GATE_DELETED=', docs/a.md'; gate_check_deleted doc-map",
			'echo @@ >&2; gate_stage_out "$PWD" docs/doc-map.md || :',
		].join("\n");
		try {
			// A directory outside any repo, so gate_stage_out's git reads fail.
			const shell = spawnSync("sh", ["-ec", script], {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, GIT_CEILING_DIRECTORIES: dir },
			});
			expect(shell.status, shell.stderr).toBe(0);
			const printed = shell.stderr.split("@@\n").slice(1);
			expect(printed).toEqual([
				skipLine("doc-map", "git checkout-index would not write it"),
				refuseDeletedLines("doc-map", ["docs/a.md", "docs/b.md"]),
				allowDeleteLine(["docs/a.md"]),
				deletionUnknownLine("docs/doc-map.md"),
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
