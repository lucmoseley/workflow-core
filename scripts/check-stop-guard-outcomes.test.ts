// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NotifyReport from "./lib/notify-report.js";
import { runInProcess } from "./lib/run-in-process.js";

const hookRecord = createRequire(__filename)("./lib/hook-record.js");

const SCRIPT = path.resolve(__dirname, "check-stop-guard-outcomes.js");
const GUARD = "guard-priced-options";
const OTHER = "guard-selection-sum";

let dir: string;
let home: string;
let crumbs: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stopguard-"));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "stopguard-home-"));
	crumbs = hookRecord.recordsDir(dir);
	fs.mkdirSync(crumbs, { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

function crumb(over: Record<string, unknown> = {}) {
	return {
		outcome: "message",
		source: "payload",
		payloadLen: 190,
		transcriptLen: null,
		stopHookActive: false,
		at: new Date().toISOString(),
		...over,
	};
}

const blindLine = crumb({
	outcome: "empty-message",
	source: null,
	payloadLen: null,
	transcriptLen: 0,
});

function write(
	guard: string,
	session: string,
	lines: Record<string, unknown>[],
) {
	fs.writeFileSync(
		path.join(crumbs, `.hook-ran-${guard}-${session}`),
		lines.map((l) => JSON.stringify({ guard, session, ...l })).join("\n") +
			"\n",
	);
}

function spread(
	guard: string,
	n: number,
	line: Record<string, unknown>,
	{ sessions = 2, tag = "s" }: { sessions?: number; tag?: string } = {},
) {
	for (let s = 0; s < sessions; s++) {
		const mine = Math.floor(n / sessions) + (s < n % sessions ? 1 : 0);
		write(
			guard,
			`session-${tag}-${s}`,
			Array.from({ length: mine }, () => line),
		);
	}
}

interface Envelope {
	outcome: string;
	summary: string;
	findings: { severity: string; tag: string; message: string }[];
	vanished?: number;
}

function run(args: string[] = []): { env: Envelope; stdout: string } {
	const res = runInProcess(SCRIPT, ["--root", dir, ...args], {
		env: {
			...process.env,
			HOME: home,
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			CLAUDE_PROJECT_DIR: dir,
		},
	});
	const json = args.includes("--json")
		? (JSON.parse(res.stdout) as Envelope)
		: ({ outcome: "", summary: res.stderr, findings: [] } as Envelope);
	return { env: json, stdout: res.stdout };
}

const tags = (args: string[] = []) =>
	run(["--json", ...args]).env.findings.map((f) => `${f.severity}:${f.tag}`);

describe("guards that are reading what they judge", () => {
	it("finds nothing when every invocation took its text off the payload", () => {
		spread(GUARD, 60, crumb());
		spread(OTHER, 60, crumb());
		expect(tags()).toEqual([]);
	});

	it("says nothing at all under --notify", () => {
		spread(GUARD, 60, crumb());
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("allows the 3.6% of turns that legitimately end with no text (mantahostels#1291)", () => {
		spread(GUARD, 59, crumb());
		write(GUARD, "session-quiet", [
			crumb({ outcome: "empty-message", source: null, payloadLen: null }),
		]);
		expect(tags()).toEqual([]);
	});

	it("reports nothing where no guard has ever run here", () => {
		expect(run(["--json"]).env.summary).toMatch(/no Stop-guard breadcrumbs/);
	});

	it("reads a tree whose breadcrumb directory does not exist yet as no sample", () => {
		fs.rmSync(crumbs, { recursive: true, force: true });
		expect(run(["--json"]).env.outcome).not.toBe("BROKEN");
		expect(run(["--json"]).env.summary).toMatch(/no Stop-guard breadcrumbs/);
	});
});

describe("a guard that has gone blind again (mantahostels#1254)", () => {
	const blind = crumb({
		outcome: "empty-message",
		source: null,
		payloadLen: null,
		transcriptLen: 0,
	});

	it("reports the guard reaching no verdict on most of its invocations", () => {
		spread(GUARD, 60, blind);
		expect(tags()).toContain("FAIL:BLIND");
	});

	it("names the share and says the turns went unexamined", () => {
		spread(GUARD, 60, blind);
		const { env } = run(["--json"]);
		const blindFinding = env.findings.find((f) => f.tag === "BLIND");
		expect(blindFinding?.message).toMatch(/60 of 60 invocations \(100\.0%\)/);
		expect(env.summary).toMatch(/Stop-guard reading fault/);
	});

	it("prints the distribution to the session under --notify", () => {
		spread(GUARD, 60, blind);
		const { stdout } = run(["--notify"]);
		expect(stdout).toMatch(/empty-message 60 \(100\.0%\)/);
		expect(stdout).toMatch(/#1254/);
	});

	it("reports a rate far below the defect's own, being far above a healthy one", () => {
		const lines = Array.from({ length: 60 }, (_, i) =>
			i < 20 ? blind : crumb(),
		);
		write(GUARD, "session-mixed", lines);
		expect(tags()).toContain("FAIL:BLIND");
	});

	it("leaves a guard below the sample floor alone", () => {
		spread(GUARD, 49, blind, { sessions: 1 });
		expect(tags()).toEqual([]);
	});

	it("reports one guard blind while its sibling reads fine", () => {
		spread(GUARD, 60, blind);
		spread(OTHER, 30, crumb());
		const messages = run(["--json"]).env.findings.map((f) => f.message);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(GUARD);
	});
});

describe("the routes that say the fix itself is failing (mantahostels#1275, mantahostels#1273)", () => {
	it("warns when the payload stopped carrying the field and the fallback fired", () => {
		spread(GUARD, 60, crumb());
		write(GUARD, "session-fb", [
			crumb({ source: "transcript", payloadLen: null, transcriptLen: 88 }),
		]);
		expect(tags()).toContain("WARN:FALLBACK");
	});

	it("fails IMPOSSIBLE on a payload route that still read an empty message, saying it took text off the payload and citing its ticket", () => {
		spread(GUARD, 60, crumb());
		write(GUARD, "session-x", [
			crumb({ outcome: "empty-message", payloadLen: 0 }),
		]);
		expect(tags()).toContain("FAIL:IMPOSSIBLE");
		const finding = run(["--json"]).env.findings.find(
			(f) => f.tag === "IMPOSSIBLE",
		);
		expect(finding?.message).toMatch(/took text off the payload/);
		expect(finding?.message).toMatch(/#1273/);
	});

	it("reads each route off the lines hook-record.js writes", () => {
		const rec = (outcome: string, source: string, message: string) =>
			hookRecord.record({
				root: dir,
				guard: GUARD,
				sessionId: "session-rec",
				outcome,
				source,
				payload: { last_assistant_message: message },
			});
		for (let i = 0; i < 60; i++) rec("message", "payload", "done");
		rec("message", "transcript", "");
		rec("empty-message", "payload", "");
		expect(tags()).toEqual(
			expect.arrayContaining(["WARN:FALLBACK", "FAIL:IMPOSSIBLE"]),
		);
	});
});

describe("a guard that has stopped running", () => {
	const old = new Date(Date.now() - 9 * 86_400_000).toISOString();

	it("reports a guard with a history and nothing inside the window", () => {
		spread(GUARD, 60, crumb());
		write(OTHER, "session-old", [crumb({ at: old })]);
		const finding = run(["--json"]).env.findings.find(
			(f) => f.tag === "SILENT",
		);
		expect(finding?.message).toContain(OTHER);
	});

	it("says nothing on a machine nobody worked on, where every guard is silent", () => {
		write(GUARD, "session-old", [crumb({ at: old })]);
		write(OTHER, "session-old", [crumb({ at: old })]);
		expect(tags()).toEqual([]);
	});

	it("widens with --days, so an old sample is judged rather than called silent", () => {
		write(GUARD, "session-old", [crumb({ at: old })]);
		expect(tags(["--days", "30"])).toEqual([]);
	});
});

describe("records it must not choke on", () => {
	it("ignores the cap sentinel hook-record.js writes at 32 KB (mantahostels#1274)", () => {
		spread(GUARD, 60, blindLine);
		write(GUARD, "session-cap", [
			{ capped: true, at: new Date().toISOString() },
		]);
		expect(run(["--notify"]).stdout).toMatch(/: 60 invocation/);
	});

	it("keeps reading past a torn line, and says it found one", () => {
		spread(GUARD, 60, crumb());
		fs.appendFileSync(
			path.join(crumbs, `.hook-ran-${GUARD}-session-s-0`),
			'{"guard":"gua',
		);
		const finding = run(["--json"]).env.findings.find((f) => f.tag === "TORN");
		expect(finding?.severity).toBe("WARN");
		expect(finding?.message).toMatch(/would not parse/);
	});

	it("keeps reading past a record zeroed by a crash, and says it found one apart from a torn line (#5775)", () => {
		spread(GUARD, 60, crumb());
		fs.appendFileSync(
			path.join(crumbs, `.hook-ran-${GUARD}-session-s-0`),
			`\0\0\0${JSON.stringify(crumb())}\n`,
		);
		const { findings } = run(["--json"]).env;
		const finding = findings.find((f) => f.tag === "ZEROED");
		expect(finding?.severity).toBe("WARN");
		expect(finding?.message).toMatch(
			/1 breadcrumb record\(s\) zeroed by a crash/,
		);
		expect(findings.find((f) => f.tag === "TORN")).toBeUndefined();
	});

	it("treats an undateable line as history, never as evidence about now", () => {
		spread(GUARD, 60, crumb());
		spread(
			GUARD,
			60,
			crumb({
				outcome: "empty-message",
				source: null,
				payloadLen: null,
				at: "not a date",
			}),
			{ sessions: 1, tag: "undated" },
		);
		expect(tags()).toEqual([]);
	});

	it("is BROKEN on a root it cannot read", () => {
		const res = runInProcess(SCRIPT, [
			"--root",
			path.join(dir, "nope"),
			"--json",
		]);
		expect(JSON.parse(res.stdout).outcome).toBe("BROKEN");
		expect(res.status).toBe(2);
	});

	it("is BROKEN on a --days that is not a number, printing usage on stderr", () => {
		const res = runInProcess(SCRIPT, ["--root", dir, "--days", "soon"]);
		expect(res.stderr).toMatch(/BROKEN/);
		expect(res.stderr).toMatch(/--days must be a positive number/);
		expect(res.stderr).toMatch(/usage: node check-stop-guard-outcomes\.js/);
	});

	it("exits 0 under --notify even when broken, so the hook is not disabled", () => {
		const res = runInProcess(SCRIPT, [
			"--root",
			path.join(dir, "nope"),
			"--notify",
		]);
		expect(res.status).toBe(0);
	});
});

describe("what --notify says twice", () => {
	const blind = crumb({
		outcome: "empty-message",
		source: null,
		payloadLen: null,
	});

	it("says a standing fault once, not at every session start", () => {
		spread(GUARD, 60, blind);
		expect(run(["--notify"]).stdout).toMatch(/BLIND|no verdict/);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("does not re-say a fault whose only change is one more occurrence", () => {
		spread(GUARD, 60, crumb());
		const fallback = crumb({
			source: "transcript",
			payloadLen: null,
			transcriptLen: 88,
		});
		write(GUARD, "session-fb", [fallback]);
		expect(run(["--notify"]).stdout).toMatch(/fell back to the transcript/);
		write(GUARD, "session-fb", [fallback, fallback]);
		expect(run(["--notify"]).stdout).toBe("");
	});

	it("says it again once the distribution changes", () => {
		spread(GUARD, 60, blind);
		run(["--notify"]);
		spread(OTHER, 60, blind);
		expect(run(["--notify"]).stdout).toMatch(/guard-selection-sum/);
	});

	it("reports every run when the flag is absent, the stamp being --notify's", () => {
		spread(GUARD, 60, blind);
		expect(tags()).toContain("FAIL:BLIND");
		expect(tags()).toContain("FAIL:BLIND");
	});

	describe("under persist mode", () => {
		const notify: typeof NotifyReport = createRequire(__filename)(
			"./lib/notify-report.js",
		);

		beforeEach(() => {
			vi.stubEnv("HOME", home);
			vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
			vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
		});

		const persist = () =>
			runInProcess(SCRIPT, ["--root", dir, "--notify"], {
				env: { ...process.env, WFC_NOTIFY_PERSIST: "1" },
			});

		const stampPath = () =>
			path.join(notify.base(), "stop-guard-outcomes.notified");

		it("writes a fresh report on every run, however stamped", () => {
			spread(GUARD, 60, blind);
			expect(run(["--notify"]).stdout).toMatch(/BLIND|no verdict/);
			expect(fs.existsSync(stampPath())).toBe(true);

			for (const _ of [1, 2]) {
				expect(persist().status).toBe(0);
				const report = notify.readReport("stop-guard-outcomes");
				expect(report?.outcome).toBe("FAIL");
				expect(report?.text).toMatch(/BLIND|no verdict/);
			}
		});

		it("carries the signature instead of stamping with it", () => {
			spread(GUARD, 60, blind);

			persist();

			expect(fs.existsSync(stampPath())).toBe(false);
			expect(notify.readReport("stop-guard-outcomes")?.stamp).toContain(GUARD);
		});
	});
});

describe("the guard name as it sits on disk (mantahostels#2545)", () => {
	const old = new Date(Date.now() - 9 * 86_400_000).toISOString();

	it("folds a suffixed record onto the guard that wrote it", () => {
		write(`${GUARD}.js`, "session-old", [crumb({ at: old })]);
		spread(GUARD, 60, crumb());
		expect(tags()).toEqual([]);
	});

	it("counts a suffixed record in that guard's own distribution", () => {
		write(`${GUARD}.js`, "session-blind", new Array(60).fill(blindLine));
		const { stdout } = run(["--notify"]);
		expect(stdout).toMatch(/guard-priced-options: 60 invocation/);
		expect(stdout).not.toMatch(/guard-priced-options\.js/);
	});
});

describe("a guard whose healthy case is finding nothing", () => {
	const lost = "guard-lost-deny";
	const found = crumb({ outcome: "no-finding", source: null });

	it("reads no-finding as a verdict reached, not a verdict missed", () => {
		spread(lost, 60, found);
		expect(tags()).toEqual([]);
	});

	it("still reports it blind where it genuinely read nothing", () => {
		spread(lost, 60, blindLine);
		expect(tags()).toContain("FAIL:BLIND");
	});
});

describe("the ceiling guard's stand-down (#1786)", () => {
	it("reads inventory-stand-down as a verdict reached, not a verdict missed", () => {
		spread(
			"guard-session-ceiling",
			60,
			crumb({ outcome: "inventory-stand-down", source: null }),
		);
		expect(tags()).toEqual([]);
	});
});

describe("a breadcrumb swept while the report was reading it", () => {
	const dangle = (name: string) =>
		fs.symlinkSync(path.join(crumbs, "gone"), path.join(crumbs, name));

	it("skips it rather than reporting a file it cannot read", () => {
		spread(GUARD, 60, crumb());
		dangle(`.hook-ran-${GUARD}-session-swept`);
		expect(tags()).toEqual([]);
	});

	it("says how many were skipped, where it is reporting anyway", () => {
		spread(GUARD, 60, blindLine);
		dangle(`.hook-ran-${GUARD}-session-swept`);
		expect(run(["--notify"]).stdout).toMatch(/1 breadcrumb\(s\) were swept/);
		expect(run(["--json"]).env.vanished).toBe(1);
	});

	it("says how many were skipped on a tree with nothing else wrong", () => {
		spread(GUARD, 60, crumb());
		dangle(`.hook-ran-${GUARD}-session-swept`);
		expect(run(["--json"]).env.summary).toMatch(
			/1 breadcrumb\(s\) fewer than were listed/,
		);
	});

	it("does not call a tree whose every breadcrumb vanished a clean one", () => {
		dangle(`.hook-ran-${GUARD}-session-swept`);
		expect(run(["--json"]).env.summary).toMatch(
			/no Stop-guard breadcrumbs read/,
		);
		expect(run(["--json"]).env.summary).toMatch(/1 vanished mid-read/);
	});

	it("still reports a breadcrumb that fails to read for any other reason", () => {
		spread(GUARD, 60, crumb());
		const unreadable = path.join(crumbs, `.hook-ran-${GUARD}-session-locked`);
		fs.mkdirSync(unreadable);
		expect(tags()).toContain("WARN:UNREADABLE");
	});
});
