// @vitest-environment node
/*
 * Pins the backstop's /implement floor (mantahostels#2769), the in-session
 * pass (mantahostels#1143), the Husky hooks as code (mantahostels#2779) and the
 * closing steps it hands over (#2031). Loosen a case and an /implement
 * session or a hook-only change ends with no review, or the nag stops naming
 * the steps it owes. The fixture: concision-backstop.test.ts's header.
 *
 * Over base §X8 (5)'s 10 s budget: each case spawns the hook for real, 0.3-0.5 s
 * a run (#4308's profile), and the logic under test is bash with no in-process seam.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BIG_CODE,
	backstopFixture,
	cfg,
	dir,
	env,
	git,
	implementRan,
	ME,
	markersDir,
	OTHER,
	PARAGRAPH,
	record,
	repo,
	run,
	write,
} from "./lib/concision-backstop-testkit";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { shellQuote } from "./lib/sh-quote.js";

backstopFixture();

/*
 * mantahostels#2769: /implement's injected closing steps make the two-axis review mandatory
 * at any diff size, so the churn floor that prices a review against its ~2M
 * tokens (mantahostels#1071) is the wrong question for those sessions.
 */
describe("the /implement floor — mantahostels#2769", () => {
	/** A code change far below CODE_THRESHOLD, attributed to this session. */
	const tinyCode = (sid = ME) => {
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", sid);
	};

	it("nags a tiny code change when this session ran /implement", () => {
		implementRan();
		tinyCode();

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain("(mantahostels#2769)");
	});

	it("leaves a session that never ran /implement on the 20-line floor", () => {
		tinyCode();

		expect(run("stop")).toBeNull();
	});

	// Keyed to the session, not the machine: a parallel session's /implement
	// must not lower this one's floor.
	it("reads only its own session's marker", () => {
		implementRan(OTHER);
		tinyCode();

		expect(run("stop")).toBeNull();
	});

	// Below the floor is the only case the marker changes; above it the nag
	// fires either way, and says nothing about /implement when none ran.
	it("still nags a large change, without claiming /implement ran", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).not.toContain("(#2769)");
	});

	// The prose signal has its own threshold, which mantahostels#2769 did not touch.
	it("does not lower the prose threshold", () => {
		implementRan();
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	// The marker path is a contract between two scripts, and a session's floor
	// silently returns to 20 if they drift. Pinned by running the injector for
	// real rather than by matching its source.
	it("reads the marker inject-tracker-docs.sh actually writes", () => {
		// A sid the sanitiser actually changes, so a drift between the two
		// spellings of it fails here rather than passing on a plain uuid.
		// Dots, not a slash: the base and nag marker filenames use the sid RAW,
		// so a slash makes them unwritable paths and the backstop exits silent.
		const sid = "sid.with.dots";
		const injected = spawnSync(
			path.resolve(__dirname, "inject-tracker-docs.sh"),
			{
				encoding: "utf8",
				input: JSON.stringify({
					session_id: sid,
					hook_event_name: "UserPromptSubmit",
					prompt: "/implement 2769",
				}),
				// Its `takes:` read (#1164) stays off the network. CLAUDE_CONFIG_DIR
				// restates env()'s for check-guard-test-isolation.js, which reads
				// only this call site.
				env: { ...env(), CLAUDE_CONFIG_DIR: cfg, WFC_GH: "false" },
			},
		);
		// The injector reserves the marker only once it has text to emit, and
		// exits 0 silently on a missing jq or a dedupe hit — so an unasserted
		// run would leave a drift to fail below, blaming the backstop.
		expect(injected.status).toBe(0);
		expect(injected.stdout).not.toBe("");

		run("start", sid);
		tinyCode(sid);

		expect(run("stop", sid)).toContain("(mantahostels#2769)");
	});

	// The floor is the only thing mantahostels#2769 moved: a review that ran still clears
	// the signal, and pass_valid gates ahead of the threshold either way.
	it("stays silent when a valid review marker already covers the change", () => {
		implementRan();
		tinyCode();
		const base = fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();
		fs.writeFileSync(
			path.join(markersDir(), `.codereview-pass-${ME}`),
			`base=${base}\nfindings=0\n`,
		);

		expect(run("stop")).toBeNull();
	});

	// A changed file can report zero churn — a mode-only chmod — and mantahostels#2769
	// asked for "any tracked code-file change (however small)".
	it("nags a mode-only change, which reports no churn at all", () => {
		write("scripts/moded.sh", "echo hi\n");
		git("add", "scripts/moded.sh");
		git("commit", "-qm", "a script to chmod", "--", "scripts/moded.sh");
		// Re-record the base ON that commit, or the diff carries the file's
		// whole body and the case is no longer a zero-churn one.
		fs.rmSync(path.join(markersDir(), `.concision-base-${ME}`));
		run("start");
		fs.chmodSync(path.join(repo, "scripts/moded.sh"), 0o755);
		record("scripts/moded.sh", ME);
		implementRan();

		expect(run("stop")).toContain("(mantahostels#2769)");
	});

	it("stays silent when this session changed no code at all", () => {
		implementRan();
		write("docs/mine.md", "one\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});
});

/*
 * mantahostels#1143 reverted mantahostels#1097: the pass this nag demands runs in the session that
 * wrote the prose, and mantahostels#1099's marker line recording the route survives it. The
 * nag string is the only place a session learns the instruction or the route to
 * write, so both are pinned here.
 */
describe("the pass runs in this session — mantahostels#1143, mantahostels#1099", () => {
	/** The base the hook recorded at SessionStart, which markers must match. */
	const readRecordedBase = () =>
		fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();

	/** Writes a pass marker as a session's step 6 would. */
	const marker = (name: string, body: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), body);
	};

	/** Trips the prose signal: enough attributed words to clear THRESHOLD. */
	const wroteProse = () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
	};

	it("tells the session to run the pass itself, on the recorded base", () => {
		wroteProse();

		const reason = run("stop") ?? "";
		expect(reason).toContain(
			`Run the concision-pass skill with fixed point ${readRecordedBase()}`,
		);
		expect(reason).not.toContain("Do NOT run that pass in this session");
		// The dispatch wording mantahostels#1097 added, and only it: `Agent` is still live
		// in the code signal's own nag, which mantahostels#1143 did not touch.
		expect(reason).not.toContain("dispatch it (#1097)");
	});

	it("tells the session what route= to write", () => {
		wroteProse();

		const reason = run("stop") ?? "";
		expect(reason).toContain("'route=in-session'");
		expect(reason).not.toContain("route=subagent");
		expect(reason).not.toContain("route=mixed");
	});

	it("keeps the code signal's comment pass in this session too", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain(
			"here in this session and not in a subagent (mantahostels#1143)",
		);
	});

	// route= is instrumentation, not a gate: a pass that ran is not worth
	// re-running because it recorded its route badly, or not at all.
	it("accepts a marker carrying route=, and one still missing it", () => {
		wroteProse();
		marker(
			`.concision-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=4\nroute=in-session\n`,
		);
		expect(run("stop")).toBeNull();

		fs.rmSync(path.join(markersDir(), `.concision-nagged-${ME}`), {
			force: true,
		});
		marker(`.concision-pass-${ME}`, `base=${readRecordedBase()}\nfindings=4\n`);
		expect(run("stop")).toBeNull();
	});

	it("still rejects a branch name as base= however the route reads", () => {
		wroteProse();
		marker(`.concision-pass-${ME}`, "base=main\nfindings=0\nroute=subagent\n");

		expect(run("stop")).toContain("not a 40-hex sha");
	});
});

/*
 * mantahostels#2779: the Husky hooks carry no extension, so CODE's extension globs
 * missed them and a hook-only change fell through to PROSE — no review nag at
 * any threshold.
 */
describe("the Husky hooks are code — mantahostels#2779", () => {
	const hookNames = [
		"pre-commit",
		"prepare-commit-msg",
		"commit-msg",
		"pre-merge-commit",
		"pre-applypatch",
		"post-commit",
		"pre-push",
	];

	/** 31 lines and 182 words: past CODE_THRESHOLD and past THRESHOLD alike. */
	const hookBody = [
		"#!/usr/bin/env sh",
		...Array.from(
			{ length: 30 },
			(_, i) => `echo ${shellQuote(`gate ${i} of the stack`)}`,
		),
	].join("\n");

	const wroteHook = (name: string) => {
		write(`.husky/${name}`, `${hookBody}\n`);
		record(`.husky/${name}`, ME);
	};

	// PROSE is CODE's complement, so a hook added to one and not removed from the
	// other is billed twice, on two signals. The pathspec is a directory, so a
	// seventh hook is covered on the day it is added.
	it.each(hookNames)("counts .husky/%s as code, and not as prose", (name) => {
		wroteHook(name);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(`.husky/${name}`);
		expect(reason).not.toContain("words of prose");
	});

	// Every case above writes a hook the fixture does not track, which drives the
	// untracked limb alone. Editing a hook that already exists — the ticket's own
	// case — goes through the tracked diff instead, a separate pathspec use.
	it("counts an edit to a hook already committed", () => {
		write(".husky/pre-commit", "#!/usr/bin/env sh\necho one\n");
		git("add", ".husky/pre-commit");
		git("commit", "-qm", "a hook to edit", "--", ".husky/pre-commit");
		// Re-record the base ON that commit, or the hook is new to the diff and
		// the case is an untracked one again.
		fs.rmSync(path.join(markersDir(), `.concision-base-${ME}`));
		run("start");
		wroteHook("pre-commit");

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(".husky/pre-commit");
		expect(reason).not.toContain("words of prose");
	});

	// The exclusion is scoped to .husky, not to extensionless files at large.
	it("leaves an extensionless file elsewhere on the prose signal", () => {
		write("docs/RUNBOOK", PARAGRAPH);
		record("docs/RUNBOOK", ME);

		expect(run("stop") ?? "").toContain("words of prose");
	});
});

/* Each rule fragment's text, as rule_text prints it. */
const closingSteps = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/implement-closing-steps.txt"),
		"utf8",
	)
	.trim();
const dispatchShape = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/review-dispatch-shape.txt"),
		"utf8",
	)
	.trim();

describe("the /implement closing steps — #2031", () => {
	it("prints them whole on the prose nag of an /implement session", () => {
		implementRan();
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("has not run a concision pass");
		expect(reason).toContain(closingSteps);
	});

	it("prints them whole on the code nag of an /implement session", () => {
		implementRan();
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", ME);

		expect(run("stop") ?? "").toContain(closingSteps);
	});

	it("leaves them off the nag of a session that never ran /implement", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("has not run a concision pass");
		expect(reason).not.toContain(closingSteps);
	});

	it("prints nothing when an /implement session owes no pass", () => {
		implementRan();
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});
});

describe("a rule store that cannot supply the fragments (#3439)", () => {
	const noRules = () => {
		const empty = path.join(dir, "no-rules");
		fs.mkdirSync(empty);
		return { WFC_RULES_DIR: empty, WFC_RULES_FALLBACK_DIR: empty };
	};

	it("names the closing steps' path and logs the miss", () => {
		implementRan();
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop", ME, noRules()) ?? "";
		expect(reason).not.toContain(closingSteps);
		expect(reason).toContain(
			"its closing steps are in docs/agents/rules/implement-closing-steps.txt.",
		);
		expect(readGuardErrorsLog(cfg)).toContain(
			"rule:implement-closing-steps unreadable",
		);
	});

	it("names the dispatch shape's path and logs the miss", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop", ME, noRules()) ?? "";
		expect(reason).not.toContain(dispatchShape);
		expect(reason).toContain(
			"Dispatch the review runs as docs/agents/rules/review-dispatch-shape.txt says.",
		);
		expect(readGuardErrorsLog(cfg)).toContain(
			"rule:review-dispatch-shape unreadable",
		);
	});
});
