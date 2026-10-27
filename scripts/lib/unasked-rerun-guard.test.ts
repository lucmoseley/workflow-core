// @vitest-environment node
/*
 * lib/unasked-rerun-guard.js, guard-unasked-rerun.js's core (#2800), in
 * process: which command reaches the judge — a bare `npm run test`, `npm run
 * test:changed` or `npm test`, `--` and `--queue` alone after it (#1153 Q1) —
 * and what the guard makes of each answer the judge can give.
 *
 * The judge is a fake the case sets, its calls recorded; what the real one
 * answers is lib/unasked-rerun.test.ts's. The rule store is the real one, read
 * through lib/rule-text.js. What the kit makes of a decision — the envelope,
 * the log file — is guard-unasked-rerun.test.ts's boundary set.
 *
 * Loosen a scope case and a run that names its files, or a script nobody
 * asked to repeat, is refused; loosen a policy case and a judge that could not
 * judge refuses, or allows with no record.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

interface Verdict {
	deny?: string;
	note?: string;
	why?: string;
	unread?: string;
}
interface JudgeInput {
	sessionId: string;
	cwd: string;
	command: string;
}
type Decision = { deny: string } | null;

/* An install's spelling, so a fallback naming a bare checkout path fails. */
const docPath = (name: string) => `/core/docs/${name}`;
const UNASKED_RULE_FALLBACK =
	"An unasked re-run is refused once a session; the rule could not be read from /core/docs/agents/rules/unasked-rerun.txt. Read that file before doing anything else.";
const UNASKED_LANDING_RULE_FALLBACK =
	"An unasked re-run is refused once a session; the rule could not be read from /core/docs/agents/rules/unasked-rerun-landing.txt. Read that file before doing anything else.";
const { decide } = require("./unasked-rerun-guard.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const CWD = "/work";
const SID = "sess-815";
const JUDGE_DENY = "Not run: what this run would test is already attested.";
const RULE = readRuleText("unasked-rerun");

let calls: JudgeInput[];
let logged: [string, string | undefined][];

/** The core on `command`, the judge answering `answer` (or throwing it). */
function run(
	command: string,
	{
		answer = { deny: JUDGE_DENY },
		sessionId = SID,
		ruleText = readRuleText,
		vars = {},
		moduleOn = () => false,
	}: {
		answer?: Verdict | Error;
		sessionId?: string;
		ruleText?: (id: string) => string;
		vars?: Record<string, string>;
		moduleOn?: (module: string) => boolean;
	} = {},
) {
	return decide(
		command,
		kitContextFake({
			cwd: CWD,
			fallbackCwd: CWD,
			vars,
			isDir: () => true,
			log: (what: string, detail?: string) => logged.push([what, detail]),
			sessionId,
			ruleText,
			docPath,
			moduleOn,
			judge: (input: JudgeInput) => {
				calls.push(input);
				if (answer instanceof Error) throw answer;
				return answer;
			},
		}),
	);
}

const REFUSED = { deny: `${JUDGE_DENY}\n\n${RULE}` };

beforeEach(() => {
	calls = [];
	logged = [];
});

describe("a bare test run is judged", () => {
	it.each([
		["npm run test", "npm run test"],
		["npm test", "npm test"],
		["npm run test:changed", "npm run test:changed"],
		["npm run test --", "npm run test --"],
		/* --queue counts as bare (#1153 Q1, #1211). */
		["npm run test -- --queue", "npm run test -- --queue"],
		["npm run test --queue", "npm run test --queue"],
		["npm run test:changed -- --queue", "npm run test:changed -- --queue"],
		/* A quoted span is read as its text, and handed on rendered. */
		['npm run test "--queue"', 'npm run test "…"'],
		['npm run "test"', 'npm run "…"'],
		["timeout 600 npm run test", "timeout 600 npm run test"],
	])("%s, handing the judge the segment as typed", (command, segment) => {
		expect(run(command)).toEqual(REFUSED);
		expect(calls).toEqual([{ sessionId: SID, cwd: CWD, command: segment }]);
		expect(logged).toEqual([]);
	});

	it.each([
		["npm run test 2>&1 | tail -20", "piped, with a redirection"],
		["npm run test > out.txt", "redirected to a file"],
		["env FOO=1 npm test", "behind env"],
	])("%s (%s)", (command) => {
		expect(run(command)).toEqual(REFUSED);
		expect(calls).toHaveLength(1);
	});

	it("in the directory a leading cd moves to", () => {
		expect(run("cd /work/sub && npm run test")).toEqual(REFUSED);
		expect(calls).toEqual([
			{ sessionId: SID, cwd: "/work/sub", command: "npm run test" },
		]);
	});

	it("in no directory where the walk cannot know it, leaving the judge to skip the checkout test", () => {
		run("cd $NOWHERE && npm run test");
		expect(calls.map((c) => c.cwd)).toEqual([""]);
	});

	it("once, on the first bare segment of a compound command", () => {
		run("npm run test -- a.test.ts && npm test && npm run test:changed");
		/* The flattened segment, as the bash guard handed it on. */
		expect(calls.map((c) => c.command)).toEqual(["npm test "]);
	});
});

describe("never judged", () => {
	it.each([
		["npm run test -- a.test.ts", "a filtered run"],
		["npm run test -- -t widget", "a name filter"],
		["npm run test -- --full=suite-edit", "a --full= run"],
		["npm run test -- --queue a.test.ts", "a queued filtered run"],
		["npm run test -- --queue --full=suite-edit", "a queued --full= run"],
		["npm run test:py", "another suite's script"],
		["npm run test:watch", "the watcher"],
		["npm run lint", "a script that is no suite"],
		["npm run -s test", "a flag before the script"],
		["npm test a.test.ts", "a file named with no --"],
		["node scripts/run-vitest.js", "the runner launched directly"],
		["echo npm run test", "a command merely naming it"],
	])("%s (%s)", (command) => {
		expect(run(command)).toBeNull();
		expect(calls).toEqual([]);
		expect(logged).toEqual([]);
	});

	it("a payload with no session id, silently", () => {
		expect(run("npm run test", { sessionId: "" })).toBeNull();
		expect(calls).toEqual([]);
		expect(logged).toEqual([]);
	});
});

describe("the verdict, spent", () => {
	it("allows silently where the judge finds no repeat", () => {
		expect(run("npm run test", { answer: {} })).toBeNull();
		expect(logged).toEqual([]);
	});

	it("allows and logs why where the judge could not judge (mantahostels#103 §6)", () => {
		expect(
			run("npm run test", { answer: { why: "ledger unreadable" } }),
		).toBeNull();
		expect(logged).toEqual([
			[
				"could not judge whether certificates attest HEAD — a bare test run allowed unjudged",
				"ledger unreadable",
			],
		]);
	});

	it("allows and logs where the judge throws, as the bash guard's child answered", () => {
		expect(run("npm run test", { answer: new Error("boom") })).toBeNull();
		expect(logged).toEqual([
			[
				"could not judge whether certificates attest HEAD — a bare test run allowed unjudged",
				"the judge threw: boom",
			],
		]);
	});

	it("logs own work unread beside an allow (#1218)", () => {
		expect(run("npm run test", { answer: { unread: "no ledger" } })).toBeNull();
		expect(logged).toEqual([
			[
				"own work unreadable — the re-run judged on all of HEAD (#1218)",
				"no ledger",
			],
		]);
	});

	it("allows where the judge says it could not judge, whatever else it says", () => {
		expect(
			run("npm run test", { answer: { deny: JUDGE_DENY, why: "w" } }),
		).toBeNull();
	});

	it("logs own work unread before why where the judge gives both", () => {
		run("npm run test", { answer: { unread: "u", why: "w" } });
		expect(logged.map(([, d]) => d)).toEqual(["u", "w"]);
	});

	it("logs own work unread beside a refusal", () => {
		expect(
			run("npm run test", { answer: { deny: JUDGE_DENY, unread: "u" } }),
		).toEqual(REFUSED);
		expect(logged).toEqual([
			["own work unreadable — the re-run judged on all of HEAD (#1218)", "u"],
		]);
	});

	it("refuses and logs a refusal the judge could not record (#810)", () => {
		expect(
			run("npm run test", {
				answer: { deny: JUDGE_DENY, note: "log unwritable" },
			}),
		).toEqual(REFUSED);
		expect(logged).toEqual([
			[
				"a refusal went unrecorded — the post-change count (#810) undercounts",
				"log unwritable",
			],
		]);
	});

	it("carries the whole rule after the judge's text", () => {
		const out = run("npm run test");
		expect(out?.deny).toContain("AN UNASKED RE-RUN IS REFUSED ONCE A SESSION");
		expect(out?.deny.startsWith(`${JUDGE_DENY}\n\n`)).toBe(true);
	});

	it("owes push:check before a push where landing is off", () => {
		expect(run("npm run test")?.deny).toContain(
			"push:check` says what is owed",
		);
	});

	it("owes only the touched tests before a push where landing is on (#2936)", () => {
		const out = run("npm run test", { moduleOn: (m) => m === "landing" });
		expect(out).toEqual({
			deny: `${JUDGE_DENY}\n\n${readRuleText("unasked-rerun-landing")}`,
		});
		expect(out?.deny).toContain(
			"Before a push, run the tests you touched; the lander runs the full suite.",
		);
		expect(out?.deny).not.toContain("push:check");
	});

	it("names the landing fragment's file where landing is on and the store fails", () => {
		const out = run("npm run test", {
			moduleOn: () => true,
			ruleText: () => {
				throw new Error("no store");
			},
		});
		expect(out).toEqual({
			deny: `${JUDGE_DENY}\n\n${UNASKED_LANDING_RULE_FALLBACK}`,
		});
	});

	it("still refuses where the rule cannot be read, naming the fragment's file", () => {
		const out = run("npm run test", {
			ruleText: () => {
				throw new Error("no store");
			},
		});
		expect(out).toEqual({ deny: `${JUDGE_DENY}\n\n${UNASKED_RULE_FALLBACK}` });
		expect(logged).toEqual([]);
	});
});
