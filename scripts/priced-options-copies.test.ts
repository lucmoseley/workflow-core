// @vitest-environment node
/*
 * The priced-options rule is written twice: the guard-registry rule in
 * .claude/output-styles/core-voice.md, and the founder-worded paste
 * scripts/inject-tracker-docs.sh hands the tracker commands, worded differently
 * on purpose (#51). A shared clause dropped or reworded in one copy fails here;
 * a clause added to one alone does not. The working contract's adopter copies
 * are pinned in adopter-rule-copies.test.ts.
 *
 * It reads the real copies, not fixtures, and runs each one's spelled-out shape
 * through `guard-priced-options.js` itself, and its round marker through
 * `lib/round-marker.js`, which the guard reads it by, so a copy is judged by
 * what the guard actually enforces.
 *
 * Loosen a case and the copies drift apart unseen: a tracker command is handed
 * a round shape the `Stop` guard then refuses, spending its block budget.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Q_MARKER } from "./lib/round-marker";
import { readRuleText } from "./lib/rule-text";
import { runInProcess } from "./lib/run-in-process";

const ROOT = path.resolve(__dirname, "..");
const STYLE = path.join(ROOT, ".claude", "output-styles", "core-voice.md");
const CONTRACT = path.join(ROOT, "docs", "working-contract.md");
const GUARD = path.join(ROOT, "scripts", "guard-priced-options.js");
const HOOK = path.join(ROOT, "scripts", "inject-tracker-docs.sh");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "priced-copies-"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const styleRule = (() => {
	const line = fs
		.readFileSync(STYLE, "utf8")
		.split("\n")
		.find((l) => l.startsWith("- **A question round enumerates"));
	if (!line) throw new Error("the style's priced-options rule is gone");
	return line;
})();

const readContractLine = (lead: string) => {
	const line = fs
		.readFileSync(CONTRACT, "utf8")
		.split("\n")
		.find((l) => l.startsWith(lead));
	if (!line) throw new Error(`the working contract's "${lead}" rule is gone`);
	return line;
};
const houseRule = readContractLine(
	"- **Only a house decision reaches the founder",
);

/* Each variable is pinned for the reason scripts/inject-tracker-docs.test.ts's
 * `run` gives beside it. The project and config dirs are an empty scratch dir,
 * a host naming no output style, so the whole shape is pasted rather than Core
 * voice's pointer (#2039). */
const injected = (() => {
	const out = execFileSync(HOOK, {
		input: JSON.stringify({
			prompt: "/implement 51",
			hook_event_name: "UserPromptSubmit",
		}),
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: SCRATCH,
			CLAUDE_CONFIG_DIR: SCRATCH,
			CLAUDE_JOB_DIR: "",
			CLAUDE_CODE_SESSION_ID: "",
			TMPDIR: SCRATCH,
			WFC_GH: "false",
		},
	});
	const ctx: string = JSON.parse(out).hookSpecificOutput.additionalContext;
	const at = ctx.indexOf("SHIPS PRICED OPTIONS");
	if (at < 0) throw new Error("/implement no longer receives the pasted rule");
	return ctx.slice(at);
})();

/** The pasted template: its `(A)` line through its `Relation:` line. */
const template = (() => {
	const lines = injected.split("\n");
	const from = lines.findIndex((l) => l.startsWith("(A) "));
	const to = lines.findIndex((l) => l.startsWith("Relation:"));
	if (from < 0 || to < from) throw new Error("the pasted template is gone");
	return lines.slice(from, to + 1).join("\n");
})();

const copies = [
	{
		name: "style",
		text: styleRule,
		relation: /`Relation:` line says `rivals`/,
	},
	{ name: "injected", text: injected, relation: /^Relation: <rivals/m },
];

const EXAMPLE_FIGURE = /Confidence: \d+% \(\d+% - \d+%\)\./;

describe.each(copies)("the $name copy", ({ text, relation }) => {
	it("names the round marker in a spelling the guard opens a round on", () => {
		const m = text.match(/`(❓ \*\*Q\w+\*\*)`/u);
		expect(m).not.toBeNull();
		expect(Q_MARKER.test((m?.[1] ?? "").replace("Qn", "Q1"))).toBe(true);
	});

	it("spells a Confidence line the guard reads as priced", () => {
		const figure = text.match(EXAMPLE_FIGURE)?.[0] ?? "";
		const headline = Number(figure.match(/\d+/)?.[0]);
		expect(headline).toBeGreaterThan(0);
		const rest = 100 - headline;
		const rival = `Confidence: ${rest}% (${Math.max(rest - 10, 0)}% - ${Math.min(rest + 10, 100)}%).`;
		const round = (priced: string) =>
			"❓ **Q1** — Which schedule?\n\nRelation: rivals\n\n" +
			`(A) Daily.\n${priced} Cheap.\n\n(B) Weekly.\n${rival} Slow.\n\n➡ (A).`;
		const passed = guard(round(figure));
		expect(passed.status).toBe(0);
		expect(passed.stdout.trim()).toBe("");
		/* The same round with the figure gone is refused, so the pass above is
		 * the figure read as priced. */
		expect(JSON.parse(guard(round("Because.")).stdout).reason).toMatch(/\bQ1:/);
	});

	it("letters the options (A), (B)", () => {
		expect(text).toContain("(A) <");
		expect(text).toContain("(B)");
	});

	it("makes rivals' figures one split, named on the Relation line", () => {
		expect(text).toMatch(/sum to 100%/);
		expect(text).toMatch(relation);
	});

	it("exempts no yes/no and no obvious choice", () => {
		expect(text).toMatch(/no stakes threshold/i);
		expect(text).toMatch(/yes\/no/);
		expect(text).toMatch(/obvious/);
	});

	it("keeps an ordinary question plain and unlettered", () => {
		expect(text).toMatch(/takes no letters/);
	});
});

/** The guard's verdict on `text` as a turn's last message. */
const guard = (text: string, { job = false } = {}) => {
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_REPO_ROOT: SCRATCH };
	if (job) env.CLAUDE_JOB_DIR = SCRATCH;
	else delete env.CLAUDE_JOB_DIR;
	return runInProcess(GUARD, [], {
		stdin: JSON.stringify({
			session_id: `copies-${Math.random().toString(36).slice(2)}`,
			last_assistant_message: text,
			transcript_path: path.join(SCRATCH, "absent.jsonl"),
		}),
		cwd: SCRATCH,
		env,
	});
};

/** The round the guard's `needs input:`-without-round refusal prints. */
const refusalRound = (() => {
	const res = guard("Done.\n\nneeds input: whether to push.", { job: true });
	const reason: string = JSON.parse(res.stdout).reason;
	const m = reason.match(/^❓ \*\*Q1\*\*[\s\S]*?^\(B\).*\nConfidence:.*$/mu);
	if (!m) throw new Error("the needs-input refusal no longer prints a round");
	return m[0];
})();

describe("the copies together", () => {
	it("give the same example figure, the refusal's round included", () => {
		const figure = styleRule.match(EXAMPLE_FIGURE)?.[0];
		expect(figure).toBe(injected.match(EXAMPLE_FIGURE)?.[0]);
		expect(figure).toBe(refusalRound.match(EXAMPLE_FIGURE)?.[0]);
	});
});

describe("the pasted template, filled in as a round", () => {
	/* `rivals` as sessions write it: the placeholder's "or: independent" would
	 * spare the pair the close-rivals check (#572). */
	const fill = (body: string) =>
		body
			.replace(/^Relation: .*$/m, "Relation: rivals")
			.replace(/<([^>]*)>/g, "$1");
	const round = (body: string) =>
		`❓ **Q1** Which?\n\n${fill(body)}\n\nRecommend (A).`;

	it("passes the guard", () => {
		const res = guard(round(template));
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});

	it("is blocked once its band is dropped, naming the question", () => {
		const res = guard(round(template.replace(" (60% - 80%)", "")));
		expect(res.status).toBe(0);
		expect(JSON.parse(res.stdout).reason).toMatch(/\bQ1:/);
	});

	it("passes the guard as the needs-input refusal prints it (#572)", () => {
		const res = guard(`${fill(refusalRound)}\n\nRecommend (A).`);
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe("");
	});
});

describe("the guard's own header", () => {
	it("points at the style's rule rather than restating the shape", () => {
		const header = fs.readFileSync(GUARD, "utf8").split("*/")[0];
		expect(header).toContain(".claude/output-styles/core-voice.md");
		expect(header).not.toMatch(/Confidence:\s*\d{1,3}\s*%/);
	});
});

describe("the house-decision rule", () => {
	it("stands in the working contract's registry, Enforced by the guard", () => {
		expect(houseRule).toContain("**Enforced**");
		expect(houseRule).toContain("`scripts/guard-priced-options.js`");
		expect(houseRule).toContain("`rule:house-decision`");
		expect(houseRule).toContain("a clarifying one included");
	});

	/* Case-blind: the fragment starts a sentence where the contract runs on. */
	it("prints, in its refusal, each delegated-decision clause the contract's bullet binds (#2091)", () => {
		const contract = houseRule.toLowerCase();
		const refusal = readRuleText("house-decision").toLowerCase();
		for (const clause of [
			"Approval is owed only for a house decision or an act hard to undo or seen outside",
			"any other choice is a delegated decision",
			"make it, then",
			"`node scripts/record-delegated-decision.js <n>`",
		]) {
			expect(contract).toContain(clause.toLowerCase());
			expect(refusal).toContain(clause.toLowerCase());
		}
	});

	it("is what the injected research sentence points at", () => {
		expect(injected).toContain(
			"Research before you ask, as far as any source could answer it; ask only what research leaves open, naming that gap: `rule:house-decision`.",
		);
		expect(injected).not.toContain("Measure before you price");
		expect(injected).not.toContain("throwaway prototype");
		/* The words it points by lead to the fragment the rule cites. */
		expect(readRuleText("house-decision")).toContain(
			"Ask only what research leaves open, and name that gap.",
		);
	});
});

describe("the founder hand-over rule (#597)", () => {
	const entry =
		fs
			.readFileSync(STYLE, "utf8")
			.split("\n")
			.find((l) => l.startsWith("- **When work needs the founder's hands")) ??
		"";
	const fragment = fs.readFileSync(
		path.join(ROOT, "docs", "agents", "rules", "founder-handover.txt"),
		"utf8",
	);
	const refusal: string = JSON.parse(
		guard(
			"❓ **Q1** — How?\n\nRelation: rivals\n\n" +
				"(A) Paste `! <cmd>`.\nConfidence: 80% (70% - 90%). Cheap.\n\n" +
				"(B) Leave it.\nConfidence: 20% (10% - 30%). Slow.\n\n➡ (A).",
		).stdout,
	).reason;

	it("stands in the style's registry, Enforced by the guard, pointing at the fragment", () => {
		expect(entry).toContain("**Enforced**");
		expect(entry).toContain("`scripts/guard-priced-options.js`");
		expect(entry).toContain("`rule:founder-handover`");
	});

	/* Whole but for the secret lines, whose paths the accessor spells in (#643). */
	const printedWhole = (text: string) => {
		const pieces = fragment.trim().split(/^.*\{host-root\}.*$/m);
		expect(pieces).toHaveLength(3);
		for (const piece of pieces) expect(text).toContain(piece);
		expect(text).not.toMatch(/\{host-root\}|\{script:/);
	};

	it("is printed whole by the refusal", () => {
		printedWhole(refusal);
	});

	it.each([
		/do every step you can first/i,
		/literal text/,
		/what he should see/,
		/what to send back/,
		/placeholder/,
		/"the command above"/,
		/"you or me\?"/,
		/`Blocked:/,
	])("keeps the clause %s in the entry and the fragment", (clause) => {
		expect(entry).toMatch(clause);
		expect(fragment).toMatch(clause);
	});

	it("is printed whole by the actor-only refusal (#598)", () => {
		const actorRefusal: string = JSON.parse(
			guard(
				"❓ **Q1** — Who?\n\nRelation: rivals\n\n" +
					"(A) I merge it.\nConfidence: 80% (70% - 90%). Cheap.\n\n" +
					"(B) You merge it.\nConfidence: 20% (10% - 30%). Slow.\n\n➡ (A).",
			).stdout,
		).reason;
		expect(entry).toContain("#598");
		printedWhole(actorRefusal);
		expect(fragment).toContain("`Blocked: <the refusal you hit");
		expect(fragment).toContain("A preference to ask first is not a block.");
	});
});
