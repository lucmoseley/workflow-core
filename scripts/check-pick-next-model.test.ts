// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ignoreFailure } from "./lib/caught.js";
import { runInProcess } from "./lib/run-in-process.js";

const { slugForRepo } = require("./lib/project-slug");

const SCRIPT = path.join(__dirname, "check-pick-next-model.js");

let sandbox: string;
let corpus: string;

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-pick-next-model-"));
	corpus = path.join(sandbox, "projects", slugForRepo());
	fs.mkdirSync(corpus, { recursive: true });
});

afterEach(() => {
	ignoreFailure(() => fs.chmodSync(corpus, 0o755));
	fs.rmSync(sandbox, { recursive: true, force: true });
});

let seq = 0;

interface Turn {
	model?: string;
	out: number;
	fi?: number;
	cw?: number;
	cr?: number;
	cw5m?: number;
	cw1h?: number;
	usage?: Record<string, number>;
	requestId?: string;
}

function session(
	command: string | null,
	turns: Turn[],
	opts: { ageDays?: number } = {},
) {
	const id = `sess-${++seq}`;
	const file = path.join(corpus, `${id}.jsonl`);
	const at = new Date(
		Date.now() - (opts.ageDays ?? 0) * 86_400_000,
	).toISOString();
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			type: "user",
			timestamp: at,
			message: {
				role: "user",
				content: command
					? `<command-name>/${command}</command-name>\n<command-args></command-args>`
					: "just a prompt",
			},
		}),
	);
	for (const [i, t] of turns.entries())
		lines.push(
			JSON.stringify({
				type: "assistant",
				timestamp: at,
				requestId: t.requestId ?? `${id}-req-${i}`,
				message: {
					...(t.model ? { model: t.model } : {}),
					usage: {
						input_tokens: t.fi ?? 0,
						output_tokens: t.out,
						cache_creation_input_tokens: t.cw ?? 0,
						cache_read_input_tokens: t.cr ?? 0,
						...(t.cw5m !== undefined || t.cw1h !== undefined
							? {
									cache_creation: {
										ephemeral_5m_input_tokens: t.cw5m ?? 0,
										ephemeral_1h_input_tokens: t.cw1h ?? 0,
									},
								}
							: {}),
						...t.usage,
					},
				},
			}),
		);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	if (opts.ageDays) {
		const s = Date.now() / 1000 - opts.ageDays * 86_400;
		fs.utimesSync(file, s, s);
	}
	return file;
}

const OPUS = "claude-opus-5-20260401";
const OPUS_5_5 = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

const run = (args: string[] = [], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_CONFIG_DIR: sandbox,
			WFC_CLAUDE_CONFIG_A: sandbox,
			WFC_CLAUDE_CONFIG_B: sandbox,
			WFC_CLAUDE_CONFIG_C: sandbox,
			...env,
		},
	});

const report = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

const notifyDir = () =>
	path.join(sandbox, "projects", slugForRepo(), "notify-reports");
const stampPath = () => path.join(notifyDir(), "pick-next-model.notified");
const readPersistedReport = () =>
	JSON.parse(
		fs.readFileSync(
			path.join(notifyDir(), "pick-next-model.report.json"),
			"utf8",
		),
	) as { outcome: string; text: string; stamp: string | null };

const json = (args: string[] = []) =>
	JSON.parse(run(["--json", ...args]).stdout) as {
		outcome: string;
		sessions: number;
		missed: number;
		opus: number;
		mixed: number;
		haiku: number;
		unknownModel: number;
		unclassifiedFiles: number;
		unreadableDirs: string[];
		absentDirs: string[];
		spent: number;
		forfeited: number;
	};

describe("a clean window", () => {
	it("is OK when the corpus holds no /pick-next session at all", () => {
		session("implement", [{ model: OPUS, out: 1_000_000 }]);
		session(null, [{ model: OPUS, out: 1_000_000 }]);

		const r = run();
		expect(report(r)).toContain("OK: every one of 0 /pick-next session(s)");
		expect(r.status).toBe(0);
	});

	it("is OK when every /pick-next session ran on Haiku", () => {
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);

		const r = run();
		const out = report(r);
		expect(out).toContain("OK: every one of 2 /pick-next session(s)");
		expect(out).not.toContain("PICK-NEXT-ON-OPUS");
		expect(r.status).toBe(0);
	});

	it("says nothing at all under --notify when the window is clean", () => {
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);

		const r = run(["--notify"]);
		expect(report(r).trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("excludes a /pick-next session that ran before the window opened", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }], { ageDays: 30 });

		const r = run();
		expect(report(r)).toContain("OK: every one of 0 /pick-next session(s)");
		const wide = run(["--days", "60"]);
		expect(report(wide)).toContain("PICK-NEXT-ON-OPUS (1 of 1)");
	});
});

describe("a window carrying misses", () => {
	it("WARNs with the count, the rate and the forfeited cost", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		session("pick-next", [{ model: HAIKU, out: 1_000_000 }]);

		const r = run();
		const out = report(r);
		expect(out).toContain("PICK-NEXT-ON-OPUS (1 of 2)");
		expect(out).toContain("50% of them");
		expect(out).toContain("They spent $75; $74 of that was forfeited");
		expect(out).toContain("scripts/launch.sh pick-next");
		expect(out).toContain("WARN: 1 /pick-next session(s) launched off Haiku");
		expect(r.status).toBe(0);
	});

	it("counts a session that switched model mid-run as a miss, and says so", () => {
		session("pick-next", [
			{ model: HAIKU, out: 100_000 },
			{ model: OPUS, out: 100_000 },
		]);

		const r = run(["--json"]);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("WARN");
		expect(envelope.missed).toBe(1);
		expect(envelope.mixed).toBe(1);
		expect(envelope.opus).toBe(0);
		expect(report({ stdout: "", stderr: r.stderr })).not.toContain("switched");
	});

	it("prices one billable unit per requestId, MAXed across its records", () => {
		session("pick-next", [
			{ model: OPUS, out: 400_000, requestId: "r1" },
			{ model: OPUS, out: 1_000_000, requestId: "r1" },
		]);

		const r = run(["--json"]);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.spent).toBeCloseTo(75, 6);
	});

	it("keeps the founder-facing line short under --notify", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);

		const r = run(["--notify"]);
		const out = report(r);
		expect(out).toContain("PICK-NEXT-ON-OPUS (1 of 1)");
		expect(out).toContain("scripts/launch.sh pick-next");
		expect(out).not.toContain("Nothing was changed");
		expect(r.status).toBe(0);
	});

	it("asks the agent to relay under --notify, and does not on a hand run", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);

		const notified = report(run(["--notify"]));
		expect(notified).toContain("relay that line to him");
		expect(notified).toContain("Only the founder can act on this");

		const byHand = report(run());
		expect(byHand).toContain("Only the founder can act on this");
		expect(byHand).not.toContain("relay that line to him");
	});
});

describe("what it will not call clean", () => {
	it("SKIPs when the transcript directory cannot be read", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		fs.chmodSync(corpus, 0o000);

		const r = run();
		const out = report(r);
		expect(out).toContain("SKIP:");
		expect(out).toContain("not clean");
		expect(out).not.toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("does not read a `<synthetic>` API-error record as an Opus turn", () => {
		session("pick-next", [
			{ model: HAIKU, out: 500_000 },
			{ model: "<synthetic>", out: 0 },
		]);

		const envelope = json();
		expect(envelope.outcome).toBe("OK");
		expect(envelope.haiku).toBe(1);
		expect(envelope.mixed).toBe(0);
		expect(envelope.missed).toBe(0);
	});

	it("counts a session whose only record is `<synthetic>` as unknown, not Opus", () => {
		session("pick-next", [{ model: "<synthetic>", out: 0 }]);

		const envelope = json();
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.opus).toBe(0);
		expect(envelope.missed).toBe(0);
	});

	it("ignores an unclosed <command-name> in a transcript's body", () => {
		const file = path.join(corpus, "mentions-the-tag.jsonl");
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				type: "user",
				timestamp: new Date().toISOString(),
				message: { content: "grep found <command-name>/pick-next in a file" },
			})}\n${JSON.stringify({
				type: "assistant",
				timestamp: new Date().toISOString(),
				requestId: "r-mention",
				message: {
					model: OPUS,
					usage: {
						input_tokens: 0,
						output_tokens: 1_000_000,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			})}\n`,
		);

		const envelope = json();
		expect(envelope.outcome).toBe("OK");
		expect(envelope.sessions).toBe(0);
	});

	it("counts a /pick-next session with no readable model neither way", () => {
		session("pick-next", [{ out: 1_000_000 }]);

		const r = run(["--json"]);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("OK");
		expect(envelope.sessions).toBe(1);
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.missed).toBe(0);
		expect(envelope.haiku).toBe(0);
	});

	it("SKIPs, and does not WARN, where no config dir holds this repo at all", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-no-corpus-"));
		try {
			const out = report(
				run([], {
					CLAUDE_CONFIG_DIR: empty,
					WFC_CLAUDE_CONFIG_A: empty,
					WFC_CLAUDE_CONFIG_B: empty,
					WFC_CLAUDE_CONFIG_C: empty,
				}),
			);
			expect(out).toContain("SKIP:");
			expect(out).not.toContain("UNREADABLE-TRANSCRIPT-DIR");
			expect(out).not.toContain("OK:");
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	it("does not WARN about a sibling config dir that simply is not there", () => {
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);

		const gone = path.join(sandbox, "no-such-config-dir");
		const out = report(
			run([], {
				WFC_CLAUDE_CONFIG_A: `${gone}-a`,
				WFC_CLAUDE_CONFIG_B: `${gone}-b`,
				WFC_CLAUDE_CONFIG_C: `${gone}-c`,
			}),
		);
		expect(out).not.toContain("UNREADABLE-TRANSCRIPT-DIR");
		expect(out).toContain("OK: every one of 1 /pick-next session(s)");
	});

	it("drops a transcript that vanished between the listing and the stat, uncounted", () => {
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);
		fs.symlinkSync(
			path.join(corpus, "nothing-here"),
			path.join(corpus, "z.jsonl"),
		);

		const envelope = json();
		expect(envelope.unclassifiedFiles).toBe(0);
		expect(envelope.sessions).toBe(1);
	});

	it("counts a transcript it can list but cannot stat", () => {
		session("pick-next", [{ model: HAIKU, out: 500_000 }]);
		fs.chmodSync(corpus, 0o444);

		const envelope = json();
		expect(envelope.unclassifiedFiles).toBe(1);
		expect(envelope.sessions).toBe(0);
	});

	it("counts a confirmed /pick-next session too large to read as unknown, not as an unread command", () => {
		const file = path.join(corpus, "over-cap.jsonl");
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				type: "user",
				timestamp: new Date().toISOString(),
				message: { content: "<command-name>/pick-next</command-name>" },
			})}\n`,
		);
		fs.truncateSync(file, 64 * 1024 * 1024 + 1);

		const envelope = json();
		expect(envelope.sessions).toBe(1);
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.unclassifiedFiles).toBe(0);
		expect(envelope.missed).toBe(0);
	});

	it("reports a transcript whose command it could not read rather than dropping it", () => {
		const file = path.join(corpus, "huge.jsonl");
		const filler = JSON.stringify({
			type: "user",
			message: { content: "x".repeat(4096) },
		});
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(filler);
		lines.push(
			JSON.stringify({
				type: "user",
				timestamp: new Date().toISOString(),
				message: { content: "<command-name>/pick-next</command-name>" },
			}),
		);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);

		const r = run(["--json"]);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.unclassifiedFiles).toBe(1);
		expect(envelope.sessions).toBe(0);
	});
});

describe("a tier this checker cannot price (mantahostels#2476)", () => {
	it("counts a Sonnet /pick-next session as unknown, not as an Opus miss", () => {
		session("pick-next", [{ model: SONNET, out: 1_000_000 }]);

		const envelope = json();
		expect(envelope.outcome).toBe("OK");
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.opus).toBe(0);
		expect(envelope.missed).toBe(0);
		expect(envelope.spent).toBe(0);
	});

	it("keeps it in the denominator rather than dropping it", () => {
		session("pick-next", [{ model: SONNET, out: 1_000_000 }]);
		session("pick-next", [{ model: HAIKU, out: 1_000_000 }]);

		const envelope = json();
		expect(envelope.sessions).toBe(2);
		expect(envelope.haiku).toBe(1);
		expect(envelope.unknownModel).toBe(1);
	});

	it("takes precedence over mixed, so a three-tier session is never priced", () => {
		session("pick-next", [
			{ model: OPUS, out: 1_000_000 },
			{ model: HAIKU, out: 1_000_000 },
			{ model: SONNET, out: 1_000_000 },
		]);

		const envelope = json();
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.mixed).toBe(0);
		expect(envelope.missed).toBe(0);
		expect(envelope.spent).toBe(0);
	});

	it("leaves an Opus session that also carries an unpriceable turn out of the cost", () => {
		session("pick-next", [
			{ model: OPUS, out: 1_000_000 },
			{ model: SONNET, out: 1_000_000 },
		]);

		const envelope = json();
		expect(envelope.unknownModel).toBe(1);
		expect(envelope.missed).toBe(0);
		expect(envelope.spent).toBe(0);
	});
});

describe("the WARN's throttle (mantahostels#2476)", () => {
	it("says nothing at the next session start when no newer session has missed", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }], { ageDays: 2 });

		const first = run(["--notify"]);
		expect(first.stdout).toContain("PICK-NEXT-ON-OPUS");

		const second = run(["--notify"]);
		expect(second.stdout).toBe("");
		expect(second.status).toBe(0);
	});

	it("speaks again the moment a newer session misses", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }], { ageDays: 2 });
		expect(run(["--notify"]).stdout).toContain("PICK-NEXT-ON-OPUS");
		expect(run(["--notify"]).stdout).toBe("");

		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		const third = run(["--notify"]);
		expect(third.stdout).toContain("PICK-NEXT-ON-OPUS");
		expect(third.stdout).toContain("2 of 2");
		expect(third.status).toBe(0);
	});

	it("throttles --notify alone: a hand run always answers in full", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }], { ageDays: 2 });
		expect(run(["--notify"]).stdout).toContain("PICK-NEXT-ON-OPUS");

		expect(report(run())).toContain("PICK-NEXT-ON-OPUS");
		expect(json().missed).toBe(1);
	});
});

describe("a SKIP under --notify (mantahostels#2476)", () => {
	it("says the corpus could not be read, rather than reading as a clean window", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		fs.chmodSync(corpus, 0o000);

		const r = run(["--notify"]);
		expect(r.stdout).toContain("SKIPPED");
		expect(r.stdout).toContain("not clean");
		expect(r.status).toBe(0);
	});

	it("stays silent under --notify on a genuinely clean window", () => {
		session("pick-next", [{ model: HAIKU, out: 1_000_000 }]);

		const r = run(["--notify"]);
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("what the throttle must never silence (mantahostels#2476)", () => {
	it("reports a miss whose session STARTED before one already reported", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		expect(run(["--notify"]).stdout).toContain("1 of 1");
		expect(run(["--notify"]).stdout).toBe("");

		session("pick-next", [{ model: OPUS, out: 1_000_000 }], { ageDays: 3 });
		const r = run(["--notify"]);
		expect(r.stdout).toContain("PICK-NEXT-ON-OPUS");
		expect(r.stdout).toContain("2 of 2");
	});

	it("reports a miss carrying no readable start when one already reported does", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		expect(run(["--notify"]).stdout).toContain("1 of 1");

		const file = path.join(corpus, "no-timestamp.jsonl");
		fs.writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "user",
					message: {
						role: "user",
						content: "<command-name>/pick-next</command-name>",
					},
				}),
				JSON.stringify({
					type: "assistant",
					requestId: "no-ts-req",
					message: { model: OPUS, usage: { output_tokens: 500_000 } },
				}),
			].join("\n")}\n`,
		);

		expect(run(["--notify"]).stdout).toContain("2 of 2");
	});

	it("speaks again when a miss leaves the set, rather than staying silent", () => {
		const older = session("pick-next", [{ model: OPUS, out: 1_000_000 }], {
			ageDays: 3,
		});
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		expect(run(["--notify"]).stdout).toContain("2 of 2");
		expect(run(["--notify"]).stdout).toBe("");

		fs.rmSync(older);
		expect(run(["--notify"]).stdout).toContain("1 of 1");
	});

	it("stamps the set of misses, not a high-water mark", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		run(["--notify"]);

		const stamp = fs.readFileSync(stampPath(), "utf8");
		expect(stamp).not.toContain("max:");
		expect(stamp).toContain(".jsonl");
	});
});

describe("under persist mode (mantahostels#2476)", () => {
	const persist = (args: string[] = ["--notify"]) =>
		run(args, { WFC_NOTIFY_PERSIST: "1" });

	it("carries the signature instead of stamping with it", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);

		expect(persist().status).toBe(0);

		expect(fs.existsSync(stampPath())).toBe(false);
		expect(readPersistedReport().stamp).toContain(".jsonl");
	});

	it("writes a fresh report on every run, however stamped", () => {
		session("pick-next", [{ model: OPUS, out: 1_000_000 }]);
		run(["--notify"]);
		expect(fs.existsSync(stampPath())).toBe(true);

		for (const _ of [1, 2]) {
			expect(persist().status).toBe(0);
			const record = readPersistedReport();
			expect(record.outcome).toBe("WARN");
			expect(record.text).toContain("PICK-NEXT-ON-OPUS");
		}
	});
});

describe("usage", () => {
	it("is BROKEN on a --days that is not a positive number", () => {
		const r = run(["--days", "nope"]);
		expect(report(r)).toContain("--days must be a positive number");
		expect(r.status).toBe(2);
	});
});

describe("pricing each request at its own model (#359)", () => {
	const mix = { cr: 561_000_000, cw: 20_320_000, out: 3_680_000, fi: 100_000 };

	it("prices an Opus 5.5 session at its own rates, not Opus 5's (#359)", () => {
		session("pick-next", [{ model: OPUS_5_5, ...mix }]);

		const envelope = json();
		const opus5 = 1500;
		const ratio55 = 0.561 * 0.4 + 0.439 * 0.8;
		expect(envelope.spent).toBeCloseTo(opus5 * ratio55, 6);
		expect(envelope.forfeited / envelope.spent).toBeCloseTo(
			(ratio55 - 0.02) / ratio55,
			9,
		);
	});

	it("still prices an Opus 5 request at Opus 5's rates on the same mix", () => {
		session("pick-next", [{ model: OPUS, ...mix }]);

		const envelope = json();
		expect(envelope.spent).toBeCloseTo(1500, 6);
		expect(envelope.forfeited).toBeCloseTo(1500 * 0.98, 6);
	});

	it("books no forfeit on a mixed session's Haiku requests", () => {
		session("pick-next", [
			{ model: HAIKU, out: 1_000_000 },
			{ model: OPUS_5_5, out: 1_000_000 },
		]);

		const envelope = json();
		expect(envelope.mixed).toBe(1);
		expect(envelope.spent).toBeCloseTo(1.5 + 60, 6);
		expect(envelope.forfeited).toBeCloseTo(60 - 1.5, 6);
	});
});

describe("pricing each cache write at its own TTL (#1203)", () => {
	it("prices a 1-hour write at 2x fresh input", () => {
		session("pick-next", [
			{ model: OPUS, out: 0, cw: 1_000_000, cw1h: 1_000_000 },
		]);

		expect(json().spent).toBeCloseTo(30, 6);
	});

	it("prices a 5-minute write, and a write the split does not cover, at 1.25x", () => {
		session("pick-next", [
			{ model: OPUS, out: 0, cw: 1_000_000, cw5m: 1_000_000 },
			{ model: OPUS, out: 0, cw: 1_000_000 },
		]);

		expect(json().spent).toBeCloseTo(18.75 * 2, 6);
	});

	it("prices a split write at each TTL's own rate", () => {
		session("pick-next", [
			{ model: OPUS, out: 0, cw: 3_000_000, cw5m: 1_000_000, cw1h: 2_000_000 },
		]);

		expect(json().spent).toBeCloseTo(18.75 + 60, 6);
	});

	it("prices an Opus 5.5 1-hour write at 0.8 of Opus 5's, forfeiting all but what Haiku would have spent", () => {
		session("pick-next", [
			{ model: OPUS_5_5, out: 0, cw: 1_000_000, cw1h: 1_000_000 },
		]);

		const envelope = json();
		expect(envelope.spent).toBeCloseTo(24, 6);
		expect(envelope.forfeited).toBeCloseTo(24 - 0.6, 6);
	});

	it("counts one request's 1-hour write once when a later record drops the split", () => {
		session("pick-next", [
			{ model: OPUS, out: 0, cw: 1_000_000, cw1h: 1_000_000, requestId: "r" },
			{ model: OPUS, out: 0, cw: 1_000_000, requestId: "r" },
		]);

		expect(json().spent).toBeCloseTo(30, 6);
	});
	it("prices both TTLs in full when one request's records split it each way, as fileSpend does", () => {
		session("pick-next", [
			{ model: OPUS, out: 0, cw: 1_000_000, cw5m: 1_000_000, requestId: "r" },
			{ model: OPUS, out: 0, cw: 1_000_000, cw1h: 1_000_000, requestId: "r" },
		]);

		expect(json().spent).toBeCloseTo(18.75 + 30, 6);
	});

	it("reads a top-level split before the nested one, as flatUsage does", () => {
		session("pick-next", [
			{
				model: OPUS,
				out: 0,
				cw: 1_000_000,
				usage: { ephemeral_1h_input_tokens: 1_000_000 },
			},
			{
				model: OPUS,
				out: 0,
				cw: 2_000_000,
				cw1h: 2_000_000,
				usage: { ephemeral_1h_input_tokens: 0 },
			},
		]);

		expect(json().spent).toBeCloseTo(30 + 18.75 * 2, 6);
	});
});

describe("a session held on two seats (#382)", () => {
	it("counts it once, from the larger copy", () => {
		const first = session("pick-next", [{ model: HAIKU, out: 500_000 }]);
		const seat2 = path.join(sandbox, "seat2");
		const corpus2 = path.join(seat2, "projects", slugForRepo());
		fs.mkdirSync(corpus2, { recursive: true });
		const resumed = session("pick-next", [
			{ model: HAIKU, out: 500_000 },
			{ model: OPUS, out: 1_000_000 },
		]);
		fs.renameSync(resumed, path.join(corpus2, path.basename(first)));

		const r = run(["--json"], { WFC_CLAUDE_CONFIG_B: seat2 });
		const envelope = JSON.parse(r.stdout);
		expect(envelope.sessions).toBe(1);
		expect(envelope.missed).toBe(1);
	});
});
