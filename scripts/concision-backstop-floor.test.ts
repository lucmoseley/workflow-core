// @vitest-environment node

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
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

backstopFixture();

describe("the /implement floor — mantahostels#2769", () => {
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

	it("reads only its own session's marker", () => {
		implementRan(OTHER);
		tinyCode();

		expect(run("stop")).toBeNull();
	});

	it("still nags a large change, without claiming /implement ran", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).not.toContain("(#2769)");
	});

	it("does not lower the prose threshold", () => {
		implementRan();
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	it("reads the marker inject-tracker-docs.js actually writes", () => {
		const sid = "sid.with.dots";
		const injected = runInProcess(
			path.resolve(__dirname, "inject-tracker-docs.js"),
			[],
			{
				stdin: JSON.stringify({
					session_id: sid,
					hook_event_name: "UserPromptSubmit",
					prompt: "/implement 2769",
				}),
				env: { ...env(), CLAUDE_CONFIG_DIR: cfg, WFC_GH: "false" },
			},
		);
		expect(injected.status).toBe(0);
		expect(injected.stdout).not.toBe("");

		run("start", sid);
		tinyCode(sid);

		expect(run("stop", sid)).toContain("(mantahostels#2769)");
	});

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

	it("nags a mode-only change, which reports no churn at all", () => {
		write("scripts/moded.sh", "echo hi\n");
		git("add", "scripts/moded.sh");
		git("commit", "-qm", "a script to chmod", "--", "scripts/moded.sh");
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

describe("the pass runs in this session — mantahostels#1143, mantahostels#1099", () => {
	const readRecordedBase = () =>
		fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();

	const marker = (name: string, body: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), body);
	};

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

	it.each(hookNames)("counts .husky/%s as code, and not as prose", (name) => {
		wroteHook(name);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(`.husky/${name}`);
		expect(reason).not.toContain("words of prose");
	});

	it("counts an edit to a hook already committed", () => {
		write(".husky/pre-commit", "#!/usr/bin/env sh\necho one\n");
		git("add", ".husky/pre-commit");
		git("commit", "-qm", "a hook to edit", "--", ".husky/pre-commit");
		fs.rmSync(path.join(markersDir(), `.concision-base-${ME}`));
		run("start");
		wroteHook("pre-commit");

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(".husky/pre-commit");
		expect(reason).not.toContain("words of prose");
	});

	it("leaves an extensionless file elsewhere on the prose signal", () => {
		write("docs/RUNBOOK", PARAGRAPH);
		record("docs/RUNBOOK", ME);

		expect(run("stop") ?? "").toContain("words of prose");
	});
});

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
