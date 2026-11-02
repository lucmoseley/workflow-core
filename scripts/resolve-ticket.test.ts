// @vitest-environment node
/*
 * resolve-ticket.js, driven through its command line (#534; the seam ruled on
 * #500, Q1 (A)).
 *
 * Every refusal also asserts that nothing was written — no comment, no close,
 * no map edit, the claim still standing.
 *
 * It runs in-process inside a sandbox repo with a real arbiter store, and `gh`
 * is a stub holding the ticket and its parent map as files, so every write the
 * script would make to the tracker is read back from disk. No hook sees a `gh`
 * call a script makes, so the script is the only guard on its own closes:
 * loosen a refusal here and a ticket closes with owed work unnamed, or a
 * card's issue closes around `/card-close`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	issueClaims,
	live,
	store,
} from "./lib/arbiter-testkit";
import { GRAPHQL_FAKE } from "./lib/gh-fake";
import { stubGhScript } from "./lib/gh-stub";
import { hexShaCommit } from "./lib/hex-sha-fixture";
import { runInProcess } from "./lib/run-in-process";

const { digestOf } = createRequire(__filename)("./lib/census-digest.js");

const SCRIPT = path.resolve(__dirname, "resolve-ticket.js");
const ME = "sess-me";

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const state = (name: string) => path.join(sb.dir, "gh", name);
const put = (name: string, value: string | object) => {
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	fs.writeFileSync(
		state(name),
		typeof value === "string" ? value : JSON.stringify(value),
	);
};
const read = (name: string) => fs.readFileSync(state(name), "utf8");

/**
 * `gh` over one ticket (#534) and its parent (#528), kept in files under
 * STUB_DIR. Levers: `close-fails` and `edit-fails` make that write fail;
 * `comments-fail` makes reading the comments fail;
 * `subs.json` is the ticket's sub-issues, none where it is absent;
 * `clobber` is written over the map right after the first map edit — a rival
 * writing from a base older than the neighbour's line.
 */
const STUB = `#!/usr/bin/env node
${GRAPHQL_FAKE}
const fs = require("node:fs");
const path = require("node:path");
const S = process.env.STUB_DIR;
const f = (n) => path.join(S, n);
const a = process.argv.slice(2);
fs.appendFileSync(f("calls"), a.join(" ") + "\\n");
const say = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
const no = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
const issue = () => JSON.parse(fs.readFileSync(f("issue.json"), "utf8"));
const comments = () => JSON.parse(fs.readFileSync(f("comments.json"), "utf8"));
if (a[0] === "api") {
	if (a[1] === "user") say({ login: "me" });
	if (a[1] === "graphql")
		// Every cited number open, unless the gql-closed file lists it (#984).
		serveAnswer(answerGraphql(a, fs.existsSync(f("gql-closed")) ? fs.readFileSync(f("gql-closed"), "utf8").split(" ") : [], []));
	if (a[1] === "repos/acme/widgets/issues/534") say(issue());
	if (a[1] === "repos/acme/widgets/issues/534/sub_issues")
		say([fs.existsSync(f("subs.json")) ? JSON.parse(fs.readFileSync(f("subs.json"), "utf8")) : []]);
	if (a[1] === "repos/acme/widgets/issues/534/comments") {
		if (fs.existsSync(f("comments-fail"))) no("HTTP 502: Bad Gateway");
		say([comments()]);
	}
	if (a[1] === "repos/acme/widgets/issues/528" && fs.existsSync(f("parent.json")))
		say({ ...JSON.parse(fs.readFileSync(f("parent.json"), "utf8")), body: fs.readFileSync(f("map.md"), "utf8") });
	no("HTTP 404: Not Found");
}
if (a[0] === "issue" && a[1] === "comment") {
	fs.writeFileSync(f("comments.json"), JSON.stringify([...comments(), { user: { login: "me" }, body: fs.readFileSync(0, "utf8") }]));
	say("https://github.com/acme/widgets/issues/534#issuecomment-1\\n");
}
if (a[0] === "issue" && a[1] === "close") {
	if (fs.existsSync(f("close-fails"))) no("HTTP 502: Bad Gateway");
	fs.writeFileSync(f("issue.json"), JSON.stringify({ ...issue(), state: "closed", reason: a[a.indexOf("--reason") + 1] }));
	say("");
}
if (a[0] === "issue" && a[1] === "view" && a[2] === "528") say({ body: fs.readFileSync(f("map.md"), "utf8") });
if (a[0] === "issue" && a[1] === "edit" && a[2] === "528") {
	if (fs.existsSync(f("edit-fails"))) no("HTTP 502: Bad Gateway");
	fs.writeFileSync(f("map.md"), fs.readFileSync(a[a.indexOf("--body-file") + 1], "utf8"));
	if (fs.existsSync(f("clobber"))) { fs.copyFileSync(f("clobber"), f("map.md")); fs.rmSync(f("clobber")); }
	say("");
}
no("gh stub: unsupported: " + a.join(" "));
`;

const MAP =
	"## Decisions so far\n\n- #530 — neighbour's line\n\n## Not yet specified\n\nfog\n";

const BODY = "## Acceptance criteria\n\n- [x] it works\n";

const setUp = ({
	title = "resolve-ticket: resolve a ticket in one call",
	labels = ["takes:implement", "kind:ticket"],
	body = BODY,
	parentLabels = ["wayfinder:map"] as string[] | null,
	map = MAP,
} = {}) => {
	put("issue.json", {
		number: 534,
		title,
		state: "open",
		labels: labels.map((name) => ({ name })),
		body,
		parent_issue_url:
			parentLabels === null
				? null
				: "https://api.github.com/repos/acme/widgets/issues/528",
	});
	put("comments.json", []);
	put("map.md", map);
	if (parentLabels !== null)
		put("parent.json", {
			number: 528,
			title: "Map: claim, file and resolve",
			state: "open",
			labels: parentLabels.map((name) => ({ name })),
			parent_issue_url: null,
		});
	issueClaims.claimIssue(534, { sessionId: ME });
};

/** The resolution lines every completed close owes, ending at **Values:**'s value. */
const TRAILER =
	"**Bound:** read it all.\n**Practice:** ran — docs/practice/test-design-and-reliability.md\n**Values:** ";

const COMMENT = `## Resolution\n\nDone.\n\n${TRAILER}none\n**Outstanding:** none.\n`;

const run = (args: string[], comment = COMMENT) => {
	put("comment.md", comment);
	return runInProcess(
		SCRIPT,
		["534", "--comment-file", state("comment.md"), ...args],
		{
			env: {
				...process.env,
				...stubGhScript(sb.dir, STUB).env,
				CLAUDE_CODE_SESSION_ID: ME,
				CLAUDE_JOB_DIR: sb.dir,
				STUB_DIR: path.join(sb.dir, "gh"),
			},
		},
	);
};
const DECISION = ["--decision", "one call resolves"];

const readCalls = () =>
	fs.existsSync(state("calls"))
		? read("calls").split("\n").filter(Boolean)
		: [];
const readWrites = () =>
	readCalls().filter((c) => /^issue (comment|close|edit)/.test(c));
const posted = () => JSON.parse(read("comments.json")).length;
const claimed = () => issueClaims.readIssueClaims(534).length > 0;
/** This session's acts ledger (#2308). */
const readActs = () => store.readActsBy(ME, [sb.repo]).acts;
const readMapLines = () =>
	read("map.md")
		.split("\n")
		.filter((l) => l.startsWith("- #534"));

const untouched = () => {
	expect(readWrites()).toEqual([]);
	expect(claimed()).toBe(true);
	expect(readActs()).toEqual([]);
};

describe("the open sub-issues it refuses to strand (#3637)", () => {
	const child = (number: number, kidState: string, repo = "acme/widgets") => ({
		number,
		state: kidState,
		title: `child ${number}`,
		html_url: `https://github.com/${repo}/issues/${number}`,
	});

	it.each([
		["completed", COMMENT, DECISION],
		[
			"not planned",
			"Dropped.\n\n**Bound:** read the ticket.\n",
			[...DECISION, "--reason", "not planned"],
		],
	])(
		"refuses a %s close with an open child, naming it and the remedy",
		(_, comment, args) => {
			setUp();
			put("subs.json", [
				child(535, "closed"),
				child(536, "open"),
				child(9, "open", "acme/other"),
			]);
			const r = run(args, comment);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("#534 has 2 open sub-issues");
			expect(r.stderr).toContain("#536 (child 536)");
			expect(r.stderr).toContain("acme/other#9 (child 9)");
			expect(r.stderr).not.toContain("#535");
			expect(r.stderr).toContain("takes:children");
			untouched();
		},
	);

	it("closes once every child is closed", () => {
		setUp();
		put("subs.json", [child(535, "closed"), child(536, "closed")]);
		const r = run(DECISION);
		expect(r.status).toBe(0);
		expect(JSON.parse(read("issue.json")).state).toBe("closed");
	});
});

describe("a successful resolve", () => {
	it("comments, closes, releases the claim and appends one map line, leaving the assignee", () => {
		setUp();
		const r = run(DECISION);
		expect(r.status).toBe(0);
		expect(JSON.parse(read("comments.json"))[0].body).toBe(COMMENT);
		expect(JSON.parse(read("issue.json"))).toMatchObject({
			state: "closed",
			reason: "completed",
		});
		expect(claimed()).toBe(false);
		expect(readActs()).toEqual(["close acme/widgets#534"]);
		expect(readMapLines()).toEqual(["- #534 — one call resolves"]);
		expect(read("map.md")).toContain("- #530 — neighbour's line");
		expect(readCalls().some((c) => c.includes("assignee"))).toBe(false);
		expect(readCalls().some((c) => c.startsWith("issue edit 534"))).toBe(false);
	});

	it("closes as not planned with no Values, Practice or Outstanding line (#1707, #2325)", () => {
		setUp();
		const r = run(
			[...DECISION, "--reason", "not planned"],
			"Dropped.\n\n**Bound:** read the ticket.\n",
		);
		expect(r.status).toBe(0);
		expect(JSON.parse(read("issue.json")).reason).toBe("not planned");
	});

	it("accepts a comment naming a commit sha that carries a Door line (#895)", () => {
		setUp();
		const r = run(
			DECISION,
			`Done in \`3dd809ef\`.\n\n**Door:** two-way — revert 3dd809ef.\n${TRAILER}none\n**Outstanding:** none.\n`,
		);
		expect(r.status).toBe(0);
	});

	it.each([
		["no sha", "Decided: keep the old shape.\n"],
		["an issue number or a digit run", "Ruled at #1234 and run 12345678.\n"],
		["a hex word of letters alone (#1247)", "The cafebabe was defaced.\n"],
		["a session id", "Seen by session 182bfe06-7681-406e-a5d6-3bc73a946663.\n"],
	])("owes no Door line where the comment names %s (#895)", (_, prose) => {
		setUp();
		expect(
			run(DECISION, `${prose}\n${TRAILER}none\n**Outstanding:** none.\n`)
				.status,
		).toBe(0);
	});

	it("passes a Values line listing house and untraced values (#1707)", () => {
		setUp();
		const r = run(
			DECISION,
			`Done.\n\n${TRAILER}10 tool calls — house: #1684; cap of 3 — untraced\n**Outstanding:** none.\n`,
		);
		expect(r.status).toBe(0);
	});

	it("exempts a not-planned close naming a sha from the Door line (#895)", () => {
		setUp();
		const r = run(
			[...DECISION, "--reason", "not planned"],
			"Superseded by 3dd809ef.\n\n**Bound:** read the ticket.\n",
		);
		expect(r.status).toBe(0);
	});

	it("releases this session's claims on clean files, naming them, and keeps the one on a dirty file (#3565)", () => {
		setUp();
		gitRepo(sb);
		for (const rel of ["clean.md", "dirty.md", "other.md"])
			fs.writeFileSync(path.join(sb.repo, rel), `${rel}\n`);
		commitAll(sb, "seed");
		const me = live(sb, ME);
		store.acquire("clean.md", me);
		store.acquire("dirty.md", me);
		store.acquire("other.md", live(sb, "sess-other"));
		fs.writeFileSync(path.join(sb.repo, "dirty.md"), "mine\n");
		const r = run(DECISION);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^Released clean\.md — /m);
		expect(
			store
				.listLocks()
				.map((l: { path: string }) => l.path)
				.sort(),
		).toEqual(["dirty.md", "other.md"]);
	});

	it("needs no decision line where the parent is not a map", () => {
		setUp({ parentLabels: ["kind:spec"] });
		expect(run([]).status).toBe(0);
		expect(readWrites().some((c) => c.startsWith("issue edit"))).toBe(false);
	});
});

const BOUND_REFUSAL =
	"no **Bound:** line, or an empty one — say on that line what you read in full and what you only sampled or cited";

describe("refusals, all before any write", () => {
	it("refuses a comment with no Bound line, saying what the line must hold and leaving the issue and its claim untouched", () => {
		setUp();
		const r = run(DECISION, "Done.\n\n**Outstanding:** none.\n");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(BOUND_REFUSAL);
		untouched();
	});

	it.each([
		["an empty Bound line", "**Bound:**   \n"],
		["an empty Bound line, its text on the next", "**Bound:**\nread it all.\n"],
	])("refuses %s, saying what the line must hold (#2364)", (_, bound) => {
		setUp();
		const r = run(
			DECISION,
			`Done.\n\n${bound}**Practice:** ran — docs/practice/test-design-and-reliability.md\n**Values:** none\n**Outstanding:** none.\n`,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(BOUND_REFUSAL);
		untouched();
	});

	it("refuses a comment with no Values line, printing the line's form and leaving the issue and its claim untouched (#1707)", () => {
		setUp();
		const r = run(
			DECISION,
			"Done.\n\n**Bound:** read it all.\n**Outstanding:** none.\n",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the comment has no **Values:** line");
		expect(r.stderr).toContain(
			'"**Values:** <value> — house: #<the ruling that made it a house decision>; <value> — untraced", or "**Values:** none"',
		);
		untouched();
	});

	it.each([
		["an empty Values line", "**Values:**\n"],
		[
			"an empty Values line, its value on the next (#1750)",
			"**Values:**\nnone\n",
		],
	])("refuses %s (#1707)", (_, values) => {
		setUp();
		const r = run(
			DECISION,
			`Done.\n\n**Bound:** read it all.\n${values}**Outstanding:** none.\n`,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no **Values:** line, or an empty one");
		untouched();
	});

	it("refuses a comment with no Practice line, naming its four forms and leaving the issue and its claim untouched (#2325)", () => {
		setUp();
		const r = run(
			DECISION,
			"Done.\n\n**Bound:** read it all.\n**Values:** none\n**Outstanding:** none.\n",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the comment has no **Practice:** line");
		for (const form of [
			'"**Practice:** ran — <note>"',
			'"**Practice:** covered — <note>, <Researched date>"',
			'"**Practice:** skipped — <exempt kind>"',
			'"**Practice:** none-fits — nearest <craft>"',
		])
			expect(r.stderr).toContain(form);
		untouched();
	});

	it("refuses an empty Practice line (#2325)", () => {
		setUp();
		const r = run(
			DECISION,
			"Done.\n\n**Bound:** read it all.\n**Practice:**\n**Values:** none\n**Outstanding:** none.\n",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no **Practice:** line, or an empty one");
		untouched();
	});

	it("refuses a comment with no Outstanding line, leaving the issue and its claim untouched", () => {
		setUp();
		const r = run(DECISION, `Done.\n\n${TRAILER}none\n`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the comment has no **Outstanding:** line");
		untouched();
	});

	it("passes an Outstanding line whose items cite open issues (#984)", () => {
		setUp();
		const r = run(
			DECISION,
			`Done.\n\n${TRAILER}none\n**Outstanding:** #600 (log rotation), other#7 (the warn).\n`,
		);
		expect(r.status).toBe(0);
		expect(
			readCalls().some((c) => c.includes('owner: "acme", name: "other"')),
		).toBe(true);
	});

	it.each([
		[
			"a reason beside none",
			"none — but check the dashboard by eye",
			"`none` stands alone",
		],
		["a closed carrier", "#600 (log rotation)", "acme/widgets#600 is closed"],
		[
			"the ticket itself",
			"#534 (the rest)",
			"acme/widgets#534 is the issue in hand",
		],
	])(
		"refuses %s on the Outstanding line, naming the accepted form and writing nothing (#984)",
		(_, line, why) => {
			setUp();
			put("gql-closed", "600");
			const r = run(
				DECISION,
				`Done.\n\n${TRAILER}none\n**Outstanding:** ${line}\n`,
			);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(why);
			expect(r.stderr).toContain("`**Outstanding:** none`, or");
			untouched();
		},
	);

	it.each([
		["no Door line", ""],
		["a Door line with neither label", "**Door:** probably fine.\n"],
		[
			"an empty Door line, its label on the next (#1750)",
			"**Door:**\ntwo-way\n",
		],
	])("refuses a comment naming a commit sha with %s (#895)", (_, door) => {
		setUp();
		const r = run(
			DECISION,
			`Fixed in 605c04ec.\n\n${door}${TRAILER}none\n**Outstanding:** none.\n`,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("names a commit sha but has no **Door:** line");
		expect(r.stderr).toContain(
			'"**Door:** two-way — <what undoing it takes>", or "**Door:** one-way — <which entry on the one-way list in docs/agents/issue-tracker.md>',
		);
		untouched();
	});

	it("refuses a roadmap card's own issue, pointing at /card-close", () => {
		setUp({ title: "search-v1 — Build search", parentLabels: null });
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("/card-close 534");
		expect(r.stderr).toContain('re-run with --reason "not planned"');
		untouched();
	});

	it("lets a not-planned close abandon a card's own issue", () => {
		setUp({ title: "search-v1 — Build search", parentLabels: null });
		expect(run(["--reason", "not planned"]).status).toBe(0);
	});

	it("does not take a card-prefixed child for the card's own issue", () => {
		setUp({ title: "search-v1 — one slice of it" });
		expect(run(DECISION).status).toBe(0);
	});

	/* #1640: keyed on the criteria section, whatever the labels. */
	const labellings: [string, string[]][] = [
		["a kind:ticket", ["takes:implement", "kind:ticket"]],
		["an issue without kind:ticket", ["takes:implement", "wayfinder:task"]],
	];

	it.each(labellings)(
		"refuses %s with an unticked criterion carrying no waived note",
		(_, labels) => {
			setUp({
				labels,
				body: "## Acceptance criteria\n\n- [x] done\n- [ ] still open\n",
			});
			const r = run(DECISION);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("- [ ] still open");
			expect(r.stderr).toContain(
				"Tick each one you verified (issue-body.js tick), or annotate it **waived:** <why>",
			);
			untouched();
		},
	);

	it.each(labellings)(
		"skips the criteria on a not-planned close of %s",
		(_, labels) => {
			setUp({
				labels,
				body: "## Acceptance criteria\n\n- [ ] never started\n",
			});
			expect(run([...DECISION, "--reason", "not planned"]).status).toBe(0);
		},
	);

	it.each(labellings)(
		"passes %s whose criteria are all ticked or waived",
		(_, labels) => {
			setUp({
				labels,
				body: "## Acceptance criteria\n\n- [x] done\n- [ ] not met **waived:** out of reach\n",
			});
			expect(run(DECISION).status).toBe(0);
		},
	);

	it("passes an issue with no criteria section", () => {
		setUp({
			labels: ["takes:implement"],
			body: "## What to build\n\n- [ ] a list that is not criteria\n",
		});
		expect(run(DECISION).status).toBe(0);
	});

	it.each([
		["no decision line", [] as string[], "--decision"],
		[
			"a multi-line decision line",
			["--decision", "one\ntwo"],
			"more than one line",
		],
	])(
		"refuses a map parent with %s, leaving the issue and its claim untouched",
		(_, args, says) => {
			setUp();
			const r = run(args);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(says);
			untouched();
		},
	);

	it("refuses an unknown flag as an unexpected argument, naming --decision and leaving the issue and its claim untouched", () => {
		setUp();
		const r = run(["--no-such-flag", "one call resolves"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unexpected argument '--no-such-flag'");
		expect(r.stderr).toContain('--decision "<one line>"');
		untouched();
	});

	it.each([
		["no issue number", ["--comment-file", "x"], "an issue number is required"],
		[
			"an unknown reason",
			["534", "--comment-file", "x", "--reason", "dup"],
			`--reason is completed or "not planned", not 'dup'`,
		],
	])(
		"exits 2 on a usage error: %s, saying what it requires",
		(_, args, says) => {
			const r = runInProcess(SCRIPT, args, { env: process.env });
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(says);
		},
	);
});

describe("census rows the ticket's commits expired (#1876)", () => {
	const guardRel = "scripts/guard-one.sh";
	const writeGuard = (body: string) => {
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(sb.repo, guardRel), body);
	};
	const writeAnchors = () =>
		fs.writeFileSync(
			path.join(sb.repo, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({
				guards: {
					[guardRel]: { digest: digestOf(sb.repo, guardRel), verdict: "v" },
				},
			}),
		);
	const anchored = () => {
		gitRepo(sb);
		writeGuard("#!/bin/sh\necho rule one\n");
		commitAll(sb, "seed");
		writeAnchors();
		commitAll(sb, "anchor");
	};

	it("refuses a close whose commit changed what a measured guard prints, naming the row and the re-anchor", () => {
		setUp({ parentLabels: null });
		anchored();
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (#534)");
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`  ${guardRel}\n`);
		expect(r.stderr).toContain(`--rebaseline --only ${guardRel}`);
		expect(r.stderr).toContain("**Census:**");
		untouched();
	});

	it("refuses a close whose commit reworded a rule file a measured guard prints (#1914)", () => {
		setUp({ parentLabels: null });
		const rule = path.join(sb.repo, "docs/agents/rules/one.txt");
		fs.mkdirSync(path.dirname(rule), { recursive: true });
		fs.writeFileSync(rule, "Rule one.\n");
		gitRepo(sb);
		writeGuard("#!/bin/sh\nrule_text one\n");
		commitAll(sb, "seed");
		fs.writeFileSync(
			path.join(sb.repo, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({
				guards: {
					[guardRel]: { digest: digestOf(sb.repo, guardRel), verdict: "v" },
				},
			}),
		);
		commitAll(sb, "anchor");
		fs.writeFileSync(rule, "Rule one, reworded.\n");
		commitAll(sb, "Reword the rule (#534)");
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`  ${guardRel}\n`);
		untouched();
	});

	it("names each row the ticket's commits expired, one through a rule file its core's deeper lib names (#3411)", () => {
		setUp({ parentLabels: null });
		const core = "scripts/lib/four.js";
		const write = (rel: string, body: string) => {
			fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
			fs.writeFileSync(path.join(sb.repo, rel), body);
		};
		gitRepo(sb);
		writeGuard("#!/bin/sh\necho rule one\n");
		write(core, "module.exports = { decide: () => null };\n");
		write(
			"scripts/lib/four-host.js",
			'const { refusal } = require("./deeper");\nmodule.exports = { buildHostPorts: () => ({ refusal }) };\n',
		);
		write(
			"scripts/lib/deeper.js",
			'module.exports = { refusal: () => readRuleTextOr("deep") };\n',
		);
		write(
			"scripts/lib/guard-cores.json",
			JSON.stringify({
				PreToolUse: [{ name: "four", core: "four.js", host: "four-host.js" }],
			}),
		);
		write("docs/agents/rules/deep.txt", "Deep.\n");
		commitAll(sb, "seed");
		write(
			"scripts/instruction-surface-anchors.json",
			JSON.stringify({
				guards: Object.fromEntries(
					[guardRel, core].map((rel) => [
						rel,
						{ digest: digestOf(sb.repo, rel), verdict: "v" },
					]),
				),
			}),
		);
		commitAll(sb, "anchor");
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (#534)");
		write("docs/agents/rules/deep.txt", "Deep, reworded.\n");
		commitAll(sb, "Reword the deep rule (#534)");
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`  ${guardRel}\n`);
		expect(r.stderr).toContain(`  ${core}\n`);
		untouched();
	});

	const anchorsRel = "scripts/instruction-surface-anchors.json";
	const rewordAndReanchor = () => {
		const stale = fs.readFileSync(path.join(sb.repo, anchorsRel), "utf8");
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (#534)");
		writeAnchors();
		return stale;
	};

	it("passes where HEAD re-anchored the row and a neighbour's dirty copy holds the old digest (#3521)", () => {
		setUp({ parentLabels: null });
		anchored();
		const stale = rewordAndReanchor();
		commitAll(sb, "Re-anchor the guard (#534)");
		fs.writeFileSync(path.join(sb.repo, anchorsRel), stale);
		expect(run([]).status).toBe(0);
	});

	it("refuses where only a neighbour's dirty copy re-anchored the row (#3521)", () => {
		setUp({ parentLabels: null });
		anchored();
		rewordAndReanchor();
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`  ${guardRel}\n`);
		untouched();
	});

	it("passes where the ticket's commit only cut comments", () => {
		setUp({ parentLabels: null });
		anchored();
		writeGuard("#!/bin/sh\n# why it says so\necho rule one\n");
		commitAll(sb, "Explain the guard (#534)");
		expect(run([]).status).toBe(0);
	});

	it("passes where the change came from another tracker's #534", () => {
		setUp({ parentLabels: null });
		anchored();
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (gadgets#534)");
		expect(run([]).status).toBe(0);
	});

	it("passes a comment whose Census line says why the row is left", () => {
		setUp({ parentLabels: null });
		anchored();
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (#534)");
		expect(
			run([], `${COMMENT}**Census:** re-measured under #535.\n`).status,
		).toBe(0);
	});

	it("refuses an empty Census line, its value on the next, naming the guard whose row expired (#1750)", () => {
		setUp({ parentLabels: null });
		anchored();
		writeGuard("#!/bin/sh\necho rule one, reworded\n");
		commitAll(sb, "Reword the guard (#534)");
		const r = run([], `${COMMENT}**Census:**\nre-measured under #535.\n`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`  ${guardRel}\n`);
		untouched();
	});
});

describe("commits the pushed ref lacks (#3101)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" }).trim();
	const push = () => git("update-ref", "refs/remotes/origin/landing", "HEAD");
	const fix = () => {
		// The suite leaves `landing` off; the sandbox restores the env after.
		process.env.WFC_MODULES = "landing";
		fs.writeFileSync(
			path.join(sb.repo, ".claude", "workflow-core.json"),
			JSON.stringify({
				contract: 1,
				founder: "T",
				tracker: "acme/widgets",
				modules: ["landing"],
			}),
		);
		gitRepo(sb);
		commitAll(sb, "seed");
		push();
		fs.writeFileSync(path.join(sb.repo, "fix.txt"), "fixed\n");
		commitAll(sb, "Fix the stop (#534)");
	};

	it("refuses a close whose commit is not on the pushed ref, naming it and the escape", () => {
		setUp({ parentLabels: null });
		fix();
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("#534's commit is not on origin/landing");
		expect(r.stderr).toContain(" Fix the stop (#534)\n");
		expect(r.stderr).toContain("**Unlanded:**");
		untouched();
	});

	it("passes once the commit is pushed", () => {
		setUp({ parentLabels: null });
		fix();
		push();
		expect(run([]).status).toBe(0);
	});

	it("refuses a close whose comment names a commit off HEAD that origin/landing lacks (#3092)", () => {
		setUp({ parentLabels: null });
		fix();
		push();
		git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(sb.repo, "side.txt"), "fixed\n");
		commitAll(sb, "Fix the stop");
		const sha = git("rev-parse", "HEAD");
		git("checkout", "-q", "-");
		const r = run(
			[],
			`${COMMENT}Fixed in ${sha}.\n**Door:** two-way — revert it.\n`,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`  ${git("rev-parse", "--short", sha)} Fix the stop\n`,
		);
		untouched();
	});

	it("refuses a close whose comment names such a commit by an all-digit short sha (#3230)", () => {
		setUp({ parentLabels: null });
		fix();
		push();
		git("checkout", "-q", "-b", "side");
		const { sha, short } = hexShaCommit(sb.repo, "Fix the stop", "digits");
		git("checkout", "-q", "-");
		const r = run([], `${COMMENT}Fixed in ${short}.\n`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`  ${git("rev-parse", "--short", sha)} Fix the stop\n`,
		);
		untouched();
	});

	it("passes a comment whose Unlanded line says why", () => {
		setUp({ parentLabels: null });
		fix();
		expect(
			run([], `${COMMENT}**Unlanded:** a neighbour's cite in passing.\n`)
				.status,
		).toBe(0);
	});
});

describe("the map append", () => {
	it("exits 1 naming the map when it has no Decisions so far section, writing nothing", () => {
		setUp({ map: "## Something else\n\nbody\n" });
		const r = run(DECISION);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("map #528 has no '## Decisions so far'");
		untouched();
	});

	it("exits 1 when a neighbour's Decisions line vanishes during the append, quoting the lost line and keeping its own", () => {
		setUp();
		put("clobber", "## Decisions so far\n\n## Not yet specified\n\nfog\n");
		const r = run(DECISION);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("- #530 — neighbour's line");
		expect(readMapLines()).toEqual(["- #534 — one call resolves"]);
	});
});

describe("a review record in the close comment (#3846)", () => {
	const gitHere = (...args: string[]) =>
		execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" }).trim();
	const Tier =
		"**Review tier:** escalated — secret handling; not mission-critical.";
	const Head =
		"**Review findings:** base aaaaaaa1, reviewed bbbbbbb2, landed ccccccc3";
	const onTicket = (...bodies: string[]) =>
		put(
			"comments.json",
			bodies.map((body) => ({
				user: { login: "me" },
				body,
				created_at: "2026-11-01T12:00:00Z",
			})),
		);
	const closing = (record: string) =>
		`${COMMENT}**Door:** two-way — revert it.\n${record}\n`;
	const refused = (record: string, text: string) => {
		const before = posted();
		const r = run(DECISION, closing(record));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(text);
		expect(r.stderr).toContain("Nothing written.");
		expect(posted()).toBe(before);
		expect(JSON.parse(read("issue.json")).state).toBe("open");
	};
	const passes = (record: string) => {
		const r = run(DECISION, closing(record));
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(JSON.parse(read("issue.json")).state).toBe("closed");
	};

	it("refuses a note after the landed sha, naming the remedy, under a tier on an earlier comment or its own", () => {
		setUp();
		onTicket(Tier);
		refused(
			`${Head} (queued on landing), paths a.ts`,
			"record not in the form",
		);
		onTicket();
		refused(
			`${Tier}\n${Head.replace("ccccccc3", "pending (ccccccc3 on landing)")}`,
			"need not have reached main yet",
		);
	});

	it("refuses disposition lines cut off from their record", () => {
		setUp();
		onTicket(Tier);
		refused(
			`${Head}, paths a.ts\nThe findings were:\n- FIXED: a leak (Focus)`,
			"1 - FIXED or - TICKETED line past a line that ends its list",
		);
	});

	it("passes a plain pushed sha with its list straight under it, prose after", () => {
		setUp();
		onTicket(Tier);
		passes(
			`${Head}, paths a.ts\n- FIXED: a leak (Focus)\nFocus 1, Standards 0.`,
		);
	});

	it("passes prose under a record whose defects sit under the next, as #3737's does", () => {
		setUp();
		onTicket(Tier);
		passes(
			`${Head}, paths a.ts\nIts defects are under the next.\n${Head.replace("ccccccc3", "ddddddd4")}, paths b.ts\n- FIXED: a leak (Focus)`,
		);
	});

	it("passes an ordinary review report with no counted tier above it, a backticked mention, and a declined line past the prose", () => {
		setUp();
		onTicket("**Review tier:** standard");
		passes("**Review findings:** 2 fixed, 1 declined.");
		setUp();
		onTicket(Tier);
		passes(
			`\`**Review findings:** base <sha>\` names the form.\n${Head}\nProse.\n- DECLINED: not one (Spec)`,
		);
	});

	it("reads a dash with no space as a disposition line, so one past prose is refused", () => {
		setUp();
		onTicket(Tier);
		refused(
			`${Head}, paths a.ts\n-FIXED: a leak (Focus)\nProse.\n-TICKETED #9: a lock (Spec)`,
			"1 - FIXED or - TICKETED line past a line that ends its list",
		);
	});

	it.each([
		[
			3817,
			"**Review findings:** base fa86cc9ed7c333202bc6b4e5c4939f1934f45641, reviewed 22018e4b7e5113b0a141a9db4f82a6203cf45fe3, landed 88a44510b, paths scripts/lib/read-hidden.js scripts/write-secret.js. scripts/write-secret.test.ts and docs/test-read-edges.json joined with the fixes.",
			'"scripts/write-secret.js."',
		],
		[
			3826,
			"**Review findings:** base `88a44510be20f03e872e02ed3b05e0b496d58577`, reviewed `98f36d9c9a871ecd5c577b1f7b08856bd0e1b398`, landed `6a459da0c`, paths `scripts/lib/read-hidden.js,scripts/test_write_secret_tty.py`. Landed names the commit queued on `landing`, not yet on `main`.",
			'"scripts/test_write_secret_tty.py."',
		],
		[
			2085,
			"**Review findings:** base 23f76f5f0305f7a3dd6768e82d27557778208484, reviewed 75982fd5ef153713a69fd079009076d5b795bde1, landed 19ba39677, paths scripts/lib/atomic-write.js, scripts/lib/atomic-write.test.ts and the 27 routed sites, tests and manifest in that commit",
			'"routed"',
		],
	])(
		"refuses #%s's filed record, the note read as paths (#3907)",
		(_, record, entry) => {
			setUp();
			onTicket(Tier);
			refused(record, entry);
		},
	);

	it("refuses a path-shaped entry the record's replay never changed, judged in this checkout (#3907)", () => {
		setUp();
		onTicket(Tier);
		gitRepo(sb);
		commitAll(sb, "seed");
		const base = gitHere("rev-parse", "HEAD");
		fs.writeFileSync(path.join(sb.repo, "changed.ts"), "1\n");
		commitAll(sb, "Change");
		const landed = gitHere("rev-parse", "HEAD");
		const head = `**Review findings:** base ${base}, reviewed ${landed}, landed ${landed}`;
		refused(`${head}, paths changed.ts other.ts`, "no note after them");
		refused(`${head}, paths changed.ts other.ts`, '"other.ts"');
		passes(`${head}, paths changed.ts`);
	});

	it("refuses a record under no tier or the standard tier, naming the tier owed (#3907)", () => {
		setUp();
		onTicket();
		refused(`${Head}, paths a.ts`, "under no tier line");
		onTicket("**Review tier:** standard");
		refused(`${Head}, paths a.ts`, "under the tier standard");
		refused(`${Head}, paths a.ts`, "as plain prose");
	});

	it("refuses a record under a tier in no known word on an earlier comment (#3907)", () => {
		setUp();
		onTicket("**Review tier:** mission critical");
		refused(`${Head}, paths a.ts`, "under the tier mission");
	});

	it("refuses a base this checkout does not hold, and takes a directory the replay changes under as a path (#3907)", () => {
		setUp();
		onTicket(Tier);
		gitRepo(sb);
		commitAll(sb, "seed");
		const base = gitHere("rev-parse", "HEAD");
		fs.mkdirSync(path.join(sb.repo, "dir"));
		fs.writeFileSync(path.join(sb.repo, "dir", "a.ts"), "1\n");
		commitAll(sb, "Change");
		const landed = gitHere("rev-parse", "HEAD");
		refused(
			`**Review findings:** base ${"e".repeat(40)}, reviewed ${landed}, landed ${landed}, paths dir`,
			"naming the base its review ran from",
		);
		passes(
			`**Review findings:** base ${base}, reviewed ${landed}, landed ${landed}, paths dir ./dir/a.ts`,
		);
	});

	it.each([
		"- Fixed: a leak",
		"- **FIXED**: a leak",
		"* FIXED: a leak",
		"1. FIXED: a leak",
	])("refuses the disposition line %s (#3907)", (line) => {
		setUp();
		onTicket(Tier);
		refused(
			`${Head}, paths a.ts\n${line} (Focus)`,
			"1 disposition line not spelt - FIXED or - TICKETED, so they count 0. Correct it: write the record with each line spelt",
		);
	});

	it("refuses a tier in no known word in the comment, a record under it or none (#3907)", () => {
		setUp();
		onTicket();
		refused("**Review tier:** mission critical", "a tier in no known word");
		refused(
			`**Review tier:** mission critical\n${Head}, paths a.ts`,
			"**Review tier:** mission critical",
		);
	});

	it("passes a tier or record only named: in backticks, in a fence, in a quote, in a quoted line (#3907)", () => {
		setUp();
		onTicket(Tier);
		passes(
			`\`**Review tier:** mission critical\` and "**Review tier:** nope" name the form.\n\`\`\`\n${Head} (queued)\n\`\`\`\n> ${Head} (queued)`,
		);
	});

	it("fails open with a note where the ticket's comments cannot be read, the second-post check then stopping the close", () => {
		setUp();
		put("comments-fail", "");
		const r = run(DECISION, closing(`${Head} (queued)`));
		expect(r.stdout).toContain("review record check skipped");
		expect(r.status).toBe(1);
		fs.rmSync(state("comments-fail"));
		expect(posted()).toBe(0);
	});

	it("adds no comments read for a close that names no record", () => {
		setUp();
		expect(run(DECISION).status).toBe(0);
		/* The one read is the check against posting twice. */
		expect(readCalls().filter((c) => c.includes("/comments"))).toHaveLength(1);
	});
});

describe("a re-run after a partial failure", () => {
	it("posts no second comment when the close failed, and finishes the close", () => {
		setUp();
		put("close-fails", "");
		const first = run(DECISION);
		expect(first.status).toBe(1);
		expect(first.stderr).toContain("Re-run to finish");
		expect(posted()).toBe(1);
		expect(claimed()).toBe(true);
		expect(readActs()).toEqual([]);

		fs.rmSync(state("close-fails"));
		const again = run(DECISION);
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("not posted again");
		expect(posted()).toBe(1);
		expect(JSON.parse(read("issue.json")).state).toBe("closed");
		expect(readMapLines()).toHaveLength(1);
	});

	it("retries no close on a closed issue and adds no second map line", () => {
		setUp();
		put("edit-fails", "");
		expect(run(DECISION).status).toBe(1);
		expect(readMapLines()).toEqual([]);

		fs.rmSync(state("edit-fails"));
		const again = run(DECISION);
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("already closed");
		expect(readMapLines()).toHaveLength(1);

		const third = run(DECISION);
		expect(third.status).toBe(0);
		expect(posted()).toBe(1);
		expect(readCalls().filter((c) => c.startsWith("issue close"))).toHaveLength(
			1,
		);
		expect(readMapLines()).toHaveLength(1);
		// The one close is the one act: a re-run on the closed issue adds none.
		expect(readActs()).toEqual(["close acme/widgets#534"]);
	});
});
