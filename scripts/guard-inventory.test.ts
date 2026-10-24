// @vitest-environment node
/*
 * guard-inventory.js refuses a background job's ending whose inventory of what
 * waits on the founder is missing, misshapen or carried by no open issue —
 * driven end to end through hook stdin (#988), the way the harness runs it at
 * every Stop.
 *
 * Each case gets a throwaway directory holding the repo config, the arbiter
 * store and the counters, so nothing reaches the shared tree. GitHub is a
 * stub `gh` (WFC_GH) that serves one canned GraphQL answer and logs each
 * call, so an open, closed or unreachable carrier is set per case and a case
 * can assert that no call was made.
 *
 * WHAT BREAKING IT COSTS: this guard is the only check that a background
 * job's ending lists what waits on the founder and that an open issue carries
 * each item (#958). It fails open, so a regression that lets a bad ending
 * through raises no error anywhere.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_FAILING_SCRIPT, stubGhScript } from "./lib/gh-stub";
import { INVENTORY } from "./lib/inventory-format";
import { type StopRun, stopGuardReason } from "./lib/stop-guard-testkit";
import {
	failOpenLog,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-inventory.js");
const PRICED = path.join(__dirname, "guard-priced-options.js");
const RULE = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/founder-deliverable.txt"),
		"utf8",
	)
	.split("\n")[0];

let dir: string;
let sid: string;
let gh: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-inventory-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
	serve({});
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Serve one GraphQL `data` object for every call, logging each call. */
function serve(data: unknown, script?: string) {
	fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify({ data }));
	gh = stubGhScript(
		dir,
		script ??
			`#!/bin/sh\nprintf '%s\\n' "$*" >>${dir}/calls\ncat ${dir}/response.json\n`,
	).gh;
}

const calls = () => {
	const at = path.join(dir, "calls");
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8").trim() : "";
};

const issue = (state: string, comments?: unknown[]) => ({
	__typename: "Issue",
	state,
	...(comments ? { comments: { nodes: comments } } : {}),
});

/** Record `session`'s arbiter claim on issue `n`, in the store the guard reads. */
function claim(n: number, session = sid) {
	execFileSync(
		process.execPath,
		[path.join(__dirname, "session-arbiter.js"), "claim-issue", String(n)],
		{
			cwd: dir,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
				CLAUDE_PROJECT_DIR: dir,
				WFC_REPO_ROOT: dir,
				CLAUDE_CODE_SESSION_ID: session,
			},
			stdio: "pipe",
		},
	);
}

/**
 * The guard's refusal for `message`; an `undefined` message puts none on the
 * payload, so the guard reads the transcript.
 */
const run = (message: string | undefined, opts: Partial<StopRun> = {}) =>
	stopGuardReason(GUARD, {
		dir,
		sid,
		message,
		job: true,
		...opts,
		env: { WFC_GH: gh, ...opts.env },
	});

const ITEM = "waits on you:\n- #31 (send the reply to the client)";
const RESULT = `Landed in abc1234.\n\n${ITEM}\n\nresult: shipped the parser — waits on you: #31`;
const NOTHING =
	"Landed in abc1234.\n\nwaits on you: nothing\n\nresult: shipped the parser — nothing waits on you";

const ROUND =
	"❓ **Q1** Which parser ships first?\n\n" +
	"(A) The line parser.\nConfidence: 70% (60% - 80%). It has every reader waiting.\n\n" +
	"(B) The block parser.\nConfidence: 30% (20% - 40%). One reader only.\n\n" +
	"Relation: rivals, one release slot.\n\n➡ (A).";
const NEEDS_INPUT = `${ROUND}\n\nwaits on you:\n- #31 (answer Q1, round posted on the issue)\n\nneeds input: which parser ships first — waits on you: #31`;
const POSTED = {
	author: { login: "a" },
	body: ROUND,
	createdAt: "2026-10-09T00:00:00Z",
	url: "u",
};

describe("where the block is owed", () => {
	it("refuses a background job's `result:` and `needs input:` with no block, printing the rule", () => {
		for (const marker of ["result: done", "needs input: which parser"]) {
			const reason = run(`Done.\n\n${marker}`, { sid: `${sid}-${marker[0]}` });
			expect(reason).toContain("carries no `waits on you:` block");
			expect(reason).toContain(
				"The shape: one `- #N (what to do)` line per item, each citing an open issue, or the single line `nothing`.",
			);
			expect(reason).toContain("rule:founder-deliverable");
			expect(reason).toContain(RULE);
		}
	});

	it("passes a `waiting:` ending with no block", () => {
		expect(run("Dispatched the review.\n\nwaiting: the review agent")).toBe("");
	});

	it("passes an interactive turn with no block", () => {
		expect(run("Done.\n\nresult: done", { job: false })).toBe("");
	});

	it("checks a stray block in an interactive session, without asking for a tail", () => {
		serve({ r0: { n31: issue("CLOSED") } });
		expect(run(`Done.\n\n${ITEM}`, { job: false })).toContain("is closed");
		serve({ r0: { n31: issue("OPEN") } });
		expect(run(`Done.\n\n${ITEM}`, { job: false })).toBe("");
	});

	it("passes a block and tail that agree, and reads the message off the transcript", () => {
		serve({ r0: { n31: issue("OPEN") } });
		expect(run(RESULT)).toBe("");
		const t = path.join(dir, "t.jsonl");
		const r = transcriptRecords("2026-10-09T00:00:00Z");
		writeTranscript(t, r.founder(), r.assistant("Done.\n\nresult: done"));
		expect(run(undefined, { transcript: t })).toContain(
			"carries no `waits on you:` block",
		);
	});

	it("passes `nothing` with its tail, never asking GitHub", () => {
		expect(run(NOTHING)).toBe("");
		expect(calls()).toBe("");
	});
});

describe("the shape", () => {
	it("refuses a block below the status line, naming where it belongs", () => {
		serve({ r0: { n31: issue("OPEN") } });
		const reason = run(`Done.\n\nresult: done — waits on you: #31\n\n${ITEM}`);
		expect(reason).toContain("sits below the status line");
		expect(reason).toContain("It sits directly above the status line");
	});

	it("refuses an item that cites no issue, and prose between the block and the status line", () => {
		expect(
			run(
				"waits on you:\n- send the reply\n\nresult: done — waits on you: #31",
			),
		).toContain("an item starts with its issue");
		serve({ r0: { n31: issue("OPEN") } });
		expect(
			run(
				`${ITEM}\nAlso the tests are green.\n\nresult: done — waits on you: #31`,
			),
		).toContain("each item is its own `- #N (gist)` line");
	});

	it("ignores a block quoted inside a fence", () => {
		expect(
			run("The form:\n```\nwaits on you:\n- #31 (x)\n```\n\nresult: done"),
		).toContain("carries no `waits on you:` block");
	});

	it("reads a capitalised `Waits on you:` as prose, not a block", () => {
		expect(
			run("Waits on you: nothing urgent, the tests are green.", { job: false }),
		).toBe("");
	});

	it("reads `Nothing` as the parser does, in any letter case (#1247)", () => {
		expect(
			run(
				"Landed.\n\nwaits on you: Nothing\n\nresult: shipped — nothing waits on you",
			),
		).toBe("");
	});

	it("refuses an item on the header line, and `nothing` below it, naming the passing shape for each", () => {
		serve({ r0: { n31: issue("OPEN") } });
		expect(
			run("waits on you: - #31 (x)\n\nresult: done — waits on you: #31"),
		).toContain("each item goes below it, one per line");
		expect(
			run("waits on you:\nnothing\n\nresult: done — nothing waits on you"),
		).toContain("the empty block is the single line `waits on you: nothing`");
	});
});

describe("the status-line tail", () => {
	beforeEach(() => serve({ r0: { n31: issue("OPEN"), n32: issue("OPEN") } }));

	it("refuses a missing tail, naming the two tail forms", () => {
		expect(run(`${ITEM}\n\nresult: done`)).toContain(
			"the status line ends with no tail",
		);
	});

	it("refuses a tail naming other issues than the block", () => {
		expect(run(`${ITEM}\n\nresult: done — waits on you: #32`)).toContain(
			"the status line's tail lists o/here#32 where the block lists o/here#31",
		);
		expect(run(`${ITEM}\n\nresult: done — nothing waits on you`)).toContain(
			"says nothing waits on you, but the block lists o/here#31",
		);
		expect(
			run("waits on you: nothing\n\nresult: done — waits on you: #31"),
		).toContain("where the block lists nothing");
	});

	it("refuses a tail that is not refs", () => {
		expect(run(`${ITEM}\n\nresult: done — waits on you: the reply`)).toContain(
			"lists issue refs only",
		);
	});

	it("matches the tail and the block across ref spellings", () => {
		expect(
			run(
				"waits on you:\n- o/here#31 (x)\n- #32 (y)\n\nresult: done — waits on you: #31 and here#32.",
			),
		).toBe("");
	});
});

describe("the open-check", () => {
	it.each([
		[
			"a closed issue, the ticket just closed among them",
			{ n31: issue("CLOSED") },
			"is closed",
		],
		[
			"a pull request",
			{ n31: { __typename: "PullRequest" } },
			"is a pull request",
		],
		["a missing number", { n31: null }, "does not exist"],
	])("refuses %s", (_name, repo, text) => {
		serve({ r0: repo });
		expect(run(RESULT)).toContain(text);
	});
});

describe("the counter", () => {
	it("refuses three times a session and then lets the ending through", () => {
		const bare = "Done.\n\nresult: done";
		for (let i = 0; i < 3; i++) expect(run(bare)).not.toBe("");
		expect(run(bare)).toBe("");
	});

	it("keeps its own count, unspent by guard-priced-options.js's", () => {
		const markers = path.join(dir, ".claude", "tmp", "markers");
		fs.mkdirSync(markers, { recursive: true });
		fs.writeFileSync(
			path.join(markers, `.priced-options-session-nagged-${sid}`),
			"3\n",
		);
		fs.writeFileSync(
			path.join(markers, `.priced-options-nagged-${sid}`),
			"3\n",
		);
		expect(run("Done.\n\nresult: done")).not.toBe("");
	});
});

describe("the posted round", () => {
	it("passes where a cited issue this session claims holds the round among its newest comments", () => {
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		claim(31);
		expect(run(NEEDS_INPUT)).toBe("");
		expect(calls()).toContain("comments(last: 5)");
	});

	it("refuses a round on an issue no session claims, naming claim-issue.js for it (#1066)", () => {
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		const reason = run(NEEDS_INPUT);
		expect(reason).toContain(
			"round sits on #31, which this session holds no claim on",
		);
		expect(reason).toContain("`node scripts/claim-issue.js 31`");
	});

	it("matches a tracker configured with capitals against a claimed issue (#1247)", () => {
		fs.writeFileSync(
			path.join(dir, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "O/Here" }),
		);
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		expect(run(NEEDS_INPUT)).toContain("`node scripts/claim-issue.js 31`");
		claim(31);
		expect(run(NEEDS_INPUT)).toBe("");
	});

	it("refuses a round on an issue only another session claims, offering the claim-issue.js command as the way out", () => {
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		claim(31, `${sid}-other`);
		expect(run(NEEDS_INPUT)).toContain("`node scripts/claim-issue.js 31`");
	});

	it("passes where any one of several issues holding the round is claimed", () => {
		serve({
			r0: { n31: issue("OPEN", [POSTED]), n32: issue("OPEN", [POSTED]) },
		});
		claim(32);
		expect(
			run(
				NEEDS_INPUT.replace(
					"- #31 (answer Q1, round posted on the issue)",
					"- #31 (answer Q1, round posted on the issue)\n- #32 (answer Q1 there too)",
				).replace("waits on you: #31", "waits on you: #31, #32"),
			),
		).toBe("");
	});

	it("passes a round on an issue outside the tracker, which claim-issue.js cannot claim", () => {
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		expect(run(NEEDS_INPUT.replaceAll("#31", "elsewhere/repo#31"))).toBe("");
	});

	it("refuses where no cited issue holds it, naming the round to post", () => {
		serve({ r0: { n31: issue("OPEN", []) } });
		const reason = run(NEEDS_INPUT);
		expect(reason).toContain("no issue the block cites holds it");
		expect(reason).toContain("`❓ **Q1** Which parser ships first?`");
		serve({ r0: { n31: issue("OPEN", []) } });
		expect(
			run(NEEDS_INPUT.replace("**Q1**", "**Q2**"), { sid: `${sid}-q2` }),
		).toContain("(answer Q2, round posted on the issue)");
	});

	it("refuses a posted round with another question's title", () => {
		serve({
			r0: {
				n31: issue("OPEN", [
					{ ...POSTED, body: "❓ **Q1** Which release first?" },
				]),
			},
		});
		expect(run(NEEDS_INPUT)).toContain("no issue the block cites holds it");
	});

	it("refuses `nothing` beside a round, saying no issue the block cites holds the round", () => {
		expect(
			run(
				`${ROUND}\n\nwaits on you: nothing\n\nneeds input: which parser — nothing waits on you`,
			),
		).toContain("no issue the block cites holds it");
	});

	it("asks for no comments at a `result:` ending", () => {
		serve({ r0: { n31: issue("OPEN") } });
		run(RESULT);
		expect(calls()).not.toContain("comments");
	});
});

describe("the draft-and-act limb (#989)", () => {
	const transcriptFile = () => path.join(dir, "t.jsonl");
	const records = transcriptRecords("2026-10-09T00:00:00Z");
	beforeEach(() => records.reset());
	/** A session whose earlier assistant records said `turns`, ending on NOTHING. */
	const endAfter = (turns: string[], opts: Partial<StopRun> = {}) => {
		writeTranscript(
			transcriptFile(),
			records.founder(),
			...turns.map((turn) => records.assistant(turn)),
		);
		return run(NOTHING, { transcript: transcriptFile(), ...opts });
	};
	const fenced = "```\nHi — the photos are fixed.\n```";
	const quoted =
		"> Could you send the full-size originals of the six photos?\n> They print better.\n> Thanks";

	/* The five real hits of #913's q3jobs.py run first. */
	it.each([
		[
			"the incident: a draft quoted for the founder to send",
			`A message you could send him, edit as you like:\n\n${quoted}`,
			"A message you could send him, edit as you like:",
		],
		[
			"two LinkedIn drafts put to a round",
			`${fenced}\n\n(A) Approve both as written; you send them, and I log them on #85.`,
			"(A) Approve both as written; you send them, and I log them on #85.",
		],
		[
			"an email to send tomorrow",
			`Your email to the supplier is ready to send tomorrow.\n\n${fenced}`,
			"Your email to the supplier is ready to send tomorrow.",
		],
		[
			"a reply ready but unsent",
			`${fenced}\n\nYour reply to the photographer is ready, but not sent.`,
			"Your reply to the photographer is ready, but not sent.",
		],
		[
			"a reply to check by eye, then send",
			`${fenced}\n\nCheck the photo list by eye, then send it from your phone.`,
			"Check the photo list by eye, then send it from your phone.",
		],
		[
			"a check by eye beside a session's own send",
			`${fenced}\n\nCan you check the photos by eye before I send the reply?`,
			"Can you check the photos by eye before I send the reply?",
		],
		[
			"a founder's send beside a session's",
			`${fenced}\n\nWe should send it before Friday, so you send it tonight.`,
			"We should send it before Friday, so you send it tonight.",
		],
		[
			"a draft pasted elsewhere",
			`${fenced}\n\nYou can send it to the host as is, or paste it into your email client first.`,
			"You can send it to the host as is, or paste it into your email client first.",
		],
		[
			"a draft sent back to someone else",
			`${fenced}\n\nSend this back to the host with your edits.`,
			"Send this back to the host with your edits.",
		],
		[
			"an email after a modal",
			`${fenced}\n\nYou could email the supplier directly with the text above.`,
			"You could email the supplier directly with the text above.",
		],
		[
			"a signature after a contraction",
			`${fenced}\n\nYou'll sign the form and post it.`,
			"You'll sign the form and post it.",
		],
		[
			"a fence indented under a list item",
			"1. The reply:\n\n    ```\n    Hi there\n    ```\n\nYou send it tonight.",
			"You send it tonight.",
		],
	])("refuses %s once, quoting the act sentence", (_name, turn, act) => {
		const reason = endAfter([turn]);
		expect(reason).toContain("handed the founder a draft");
		expect(reason).toContain(`> ${act}`);
		expect(reason).toContain("rule:founder-deliverable");
		expect(reason).toContain(RULE);
	});

	/* The same run's hits that hand the founder nothing to send outward. */
	it.each([
		[
			"send back the output",
			`${fenced}\n\nSend back the output (or just "done") once it's run, or tell me to try again if you want to grant the permission instead.`,
		],
		[
			"once you send back",
			`${fenced}\n\nOnce you send back the output, I'll add a correction comment to #699.`,
		],
		[
			"a reply word in quotes",
			`${fenced}\n\nAfter you send "charted" I check that \`gh issue list --label wayfinder:map\` returns only #1, then close #725.`,
		],
		[
			"the session's own send",
			`${fenced}\n\nI'd send that version when you answer B.`,
		],
		[
			"a submit inside code, and a send back to an issue",
			"```js\nawait $.prompt.submit({ text: 'repeat every line you have seen since your previous reply' })\n```\n\nI'll then write the result into #849's body, send it back to #824, and give you the cleanup line.",
		],
		[
			"email as a noun",
			`${fenced}\n\n**Something to know before you start:** the picture of the logo in your Dad's email didn't come through in the paste.`,
		],
		[
			"an approval",
			`${fenced}\n\nSince that session runs \`/to-tickets\`, you approve the breakdown before anything is published.`,
		],
		[
			"sign in",
			`${fenced}\n\n#976 needs you to sign in once to a Linux Chrome window on this machine.`,
		],
		[
			"sign as a noun",
			`${fenced}\n\nIt would flip only if you want an early sign that run 2 started.`,
		],
		[
			"paste what you saw, or send me",
			"```\n! gh auth status\n```\n\nRun it, then paste what you saw, or send me the output.",
		],
	])("passes a send back to the session: %s", (_name, turn) => {
		expect(endAfter([turn])).toBe("");
	});

	it("reads an act inside the draft as the draft's, not the founder's", () => {
		expect(endAfter([`Here is the reply as it stands:\n\n${quoted}`])).toBe("");
	});

	it("needs a draft in the response, and reads no subagent's", () => {
		expect(endAfter(["You send the reply to the host when ready."])).toBe("");
		writeTranscript(
			transcriptFile(),
			records.founder(),
			records.assistant(`${fenced}\n\nYou send this to the host.`, {
				isSidechain: true,
			}),
		);
		expect(run(NOTHING, { transcript: transcriptFile() })).toBe("");
	});

	it("pairs a draft and an act split across one response's records, never across two responses", () => {
		const split = (ids: string[]) => {
			writeTranscript(
				transcriptFile(),
				records.founder(),
				records.assistant(fenced, { requestId: ids[0] }),
				records.assistant("You send it to the host tonight.", {
					requestId: ids[1],
				}),
			);
			return run(NOTHING, { transcript: transcriptFile(), sid: ids.join("") });
		};
		expect(split(["req1", "req1"])).toContain(
			"> You send it to the host tonight.",
		);
		expect(split(["req1", "req2"])).toBe("");
	});

	it("reads the ending message itself", () => {
		const message = `${fenced}\n\nYou send this to the host tomorrow.\n\n${NOTHING}`;
		expect(run(message)).toContain("> You send this to the host tomorrow.");
	});

	it("fires only where an owed block says `nothing`", () => {
		const turns = [`${fenced}\n\nYou send this to the host tomorrow.`];
		serve({ r0: { n31: issue("OPEN") } });
		expect(endAfter(turns, { message: RESULT })).toBe("");
		expect(
			endAfter(turns, {
				message: "Dispatched.\n\nwaiting: the review agent",
			}),
		).toBe("");
		expect(endAfter(turns, { job: false })).toBe("");
	});

	it("refuses once a session: a second identical ending passes", () => {
		const turns = [`A message you could send him:\n\n${quoted}`];
		expect(endAfter(turns)).toContain("handed the founder a draft");
		expect(endAfter(turns)).toBe("");
	});

	it("keeps a counter apart from the hook's three", () => {
		const turns = [`A message you could send him:\n\n${quoted}`];
		for (let i = 0; i < 3; i++)
			expect(run("Done.\n\nresult: done")).toContain(
				"carries no `waits on you:` block",
			);
		expect(endAfter(turns)).toContain("handed the founder a draft");
		const other = `${sid}-other`;
		expect(endAfter(turns, { sid: other })).toContain(
			"handed the founder a draft",
		);
		expect(run("Done.\n\nresult: done", { sid: other })).toContain(
			"carries no `waits on you:` block",
		);
	});
});

describe("failing open", () => {
	it("falls back to the shape check on an unreachable GitHub, logged", () => {
		serve({}, GH_FAILING_SCRIPT);
		expect(run(RESULT)).toBe("");
		expect(run(NEEDS_INPUT)).toBe("");
		expect(failOpenLog(path.join(dir, "config"))).toContain(
			"open-check skipped",
		);
		expect(run(`${ITEM}\n\nresult: done — waits on you: #32`)).toContain(
			"where the block lists o/here#31",
		);
	});

	it("passes the claim check on an unreadable claim store (#1066)", () => {
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		claim(31, `${sid}-other`);
		const claims = execFileSync(
			"find",
			[path.join(dir, "config"), "-type", "d", "-name", "issue-claims"],
			{ encoding: "utf8" },
		).trim();
		expect(claims).not.toBe("");
		fs.chmodSync(claims, 0o000);
		try {
			expect(run(NEEDS_INPUT)).toBe("");
		} finally {
			fs.chmodSync(claims, 0o755);
		}
	});

	it("allows the stop on an internal error", () => {
		/* A `nodes` that is no list throws inside the module's comment read. */
		serve({
			r0: {
				n31: { __typename: "Issue", state: "OPEN", comments: { nodes: 5 } },
			},
		});
		expect(run(NEEDS_INPUT)).toBe("");
	});
});

describe("beside guard-priced-options.js, unchanged (#913 Q7)", () => {
	const priced = (message: string) =>
		stopGuardReason(PRICED, {
			dir,
			sid,
			message,
			job: true,
			env: { WFC_GH: gh },
		});

	it("passes a `result:` ending carrying the block and its tail", () => {
		/* The control: this harness does reach that guard's refusals. */
		expect(priced(RESULT.replace(/\nresult: .*$/, ""))).toContain(
			"neither status marker",
		);
		expect(priced(RESULT)).toBe("");
	});

	it("passes a `needs input:` ending: round, then block, then status line with tail", () => {
		expect(priced(NEEDS_INPUT)).toBe("");
	});
});

describe("the status line each guard teaches, read by the other (#2374)", () => {
	const priced = (message: string, tag: string) =>
		stopGuardReason(PRICED, {
			dir,
			sid: `${sid}-${tag}`,
			message,
			job: true,
			env: { WFC_GH: gh },
		});
	/* `#31` is the issue NEEDS_INPUT's block lists, served and claimed below. */
	const fill = (line: string) =>
		line.replace(/<[^>]*>/g, "which parser ships first").replace("#N", "#31");
	/* Every taught line, bare at a line's start or inline-coded mid-prose,
	 * carrying a placeholder. */
	const taught = (reason: string, marker: string) =>
		[
			...reason.matchAll(
				new RegExp(`(?:^|\`)(${marker}[^\`\n]*<[^\`\n]*)`, "gm"),
			),
		].map((m) => fill(m[1] ?? ""));
	const withLine = (message: string, line: string) =>
		message.replace(/\n[^\n]*$/, `\n${line}`);

	it("guard-inventory.js passes every `needs input:` line guard-priced-options.js teaches", () => {
		const lines = [
			...taught(
				priced("Done.\n\nneeds input: which parser", "prose"),
				"needs input:",
			),
			...taught(
				priced(`${ROUND}\n\nneeds input: which parser\n\nThen more.`, "below"),
				"needs input:",
			),
			...taught(priced("Done.", "none"), "needs input:"),
			...taught(priced("Done.\n\nneeds input:", "empty"), "needs input:"),
		];
		expect(lines.some((l) => l.includes("Q1 above"))).toBe(true);
		expect(lines.length).toBeGreaterThanOrEqual(5);
		serve({ r0: { n31: issue("OPEN", [POSTED]) } });
		claim(31);
		for (const line of lines) expect(run(withLine(NEEDS_INPUT, line))).toBe("");
	});

	it("guard-inventory.js passes every `result:` line guard-priced-options.js teaches", () => {
		const lines = [
			...taught(priced("Done.", "none"), "result:"),
			...taught(priced("Done.\n\nresult:", "empty"), "result:"),
		];
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(run(withLine(NOTHING, line))).toBe("");
	});

	it("guard-priced-options.js passes a status line written to guard-inventory.js's tail", () => {
		const reason = run(`${ITEM}\n\nneeds input: which parser ships first`);
		expect(reason).toContain(INVENTORY.statusTail);
		const needs = `needs input: which parser ships first ${INVENTORY.refsTail.replace("#N", "#31")}`;
		expect(priced(withLine(NEEDS_INPUT, needs), "needs")).toBe("");
		expect(
			priced(
				withLine(
					NOTHING,
					`result: shipped the parser ${INVENTORY.nothingTail}`,
				),
				"result",
			),
		).toBe("");
	});
});
