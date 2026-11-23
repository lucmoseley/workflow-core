import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import type { freshSandbox } from "./arbiter-testkit";
import { ghAnswerHandler, RECORDED_SHAPES } from "./gh-fake";
import { buildHandlerPort } from "./gh-server-stub.js";
import {
	type GhStubServer,
	serveGhStub,
	stubGhHandler,
	stubGhScript,
} from "./gh-stub";
import {
	buildEarlyoomReadingLine,
	buildEarlyoomSignalLine,
	writeJournalctl,
} from "./journalctl-fake";
import { runInProcessAsync } from "./run-in-process";

const NOT_FOUND = path.join(__dirname, "fixtures/gh/not-found.json");
const ISSUE_COMMENT = path.join(__dirname, "fixtures/gh/issue-comment.json");
const COMMENT_FAILED = path.join(
	__dirname,
	"fixtures/gh/issue-comment-not-found.json",
);
const CREATE_FAILED = path.join(
	__dirname,
	"fixtures/gh/issue-create-no-repo.json",
);

const Handler = `
${RECORDED_SHAPES}
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(env.STUB_DIR, n);
const a = argv;
const read = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
const say = (kind, value) => { out(asRecorded(kind, value)); exit(0); };
const sayRows = (value) => say("issueListRows", value.map((r) => askedFields(a, r)));
const sayPage = (kind, items) => say(kind, [items]);
fs.appendFileSync(f("calls.log"), a.join(" ") + "\\n");
const timeline = (a[1] ?? "").split("/");
if (a[0] === "api" && a[1] === "graphql") say("idleIssuesPage", [{ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: read("idle.json") } } } }]);
if (a[0] === "api" && timeline[5] === "timeline") {
	const events = read("timelines.json")[timeline[4]] ?? [];
	if (events === "fail") { ${ghAnswerHandler(NOT_FOUND)} }
	sayPage("timelinePage", events);
}
if (a[0] === "issue" && a[1] === "list" && a[a.indexOf("--label") + 1] === "urgent") sayRows(read("urgent.json"));
if (a[0] === "issue" && a[1] === "list" && a[a.indexOf("--label") + 1] === "parked") sayRows(read("parked.json"));
if (a[0] === "api" && ["repos/acme/wfc/labels", "repos/acme/other/labels"].includes(a[1])) sayPage("labelsPage", fs.existsSync(f("no-labels")) ? [] : [{ name: "takes:wayfinder" }, { name: "takes:implement" }, { name: "origin:morning-review-script" }, { name: "origin:founder" }]);
if (a[0] === "api" && ["repos/acme/wfc/issues", "repos/acme/other/issues"].includes(a[1]) && a.some((x) => x.startsWith("since="))) {
	if (fs.existsSync(f("fail-issues-since"))) { ${ghAnswerHandler(NOT_FOUND)} }
	if (fs.existsSync(f("empty-issues-since"))) { fs.rmSync(f("empty-issues-since")); sayPage("issuesPage", []); }
	sayPage("issuesPage", fs.readdirSync(env.STUB_DIR).flatMap((n) => {
		const number = /^created-(\\d+)\\.json$/.exec(n)?.[1];
		if (!number) return [];
		const { title, body } = read(n);
		return [{ number: Number(number), title, state: "open", body }];
	}));
}
if (a[0] === "issue" && a[1] === "list" && a.includes('in:title "Memory kill incident from"')) sayRows(read("kills.json"));
if (a[0] === "issue" && a[1] === "list" && !a.includes("--label") && (a[a.indexOf("--search") + 1] ?? "").startsWith("closed:")) {
	if (fs.existsSync(f("fail-closes-once"))) { fs.rmSync(f("fail-closes-once")); ${ghAnswerHandler(NOT_FOUND)} }
	if (fs.existsSync(f("fail-closes"))) { ${ghAnswerHandler(NOT_FOUND)} }
}
if (a[0] === "issue" && a[1] === "list" && a.includes("--search") && !a.includes("--label")) sayRows(read("closed.json"));
if (a[0] === "issue" && a[1] === "list" && a.includes("--label") && fs.existsSync(f("fail-reviews"))) { ${ghAnswerHandler(NOT_FOUND)} }
if (a[0] === "issue" && a[1] === "list" && a.includes("--label"))
	sayRows(read("reviews.json").filter((i) => a[a.indexOf("--state") + 1] === "all" || i.state === a[a.indexOf("--state") + 1].toUpperCase()));
if (a[0] === "issue" && a[1] === "comment") {
	if (fs.existsSync(f("fail-comment"))) { ${ghAnswerHandler(COMMENT_FAILED)} }
	const reviews = read("reviews.json");
	const issue = reviews.find((i) => String(i.number) === a[2]);
	issue.comments = [...(issue.comments ?? []), { url: "ack-" + (issue.comments ?? []).length, body: stdin }];
	fs.writeFileSync(f("reviews.json"), JSON.stringify(reviews));
	${ghAnswerHandler(ISSUE_COMMENT)}
}
if (a[0] === "issue" && a[1] === "list") sayRows([
	...read("reviews.json"),
	...(fs.existsSync(f("lookalike")) ? [{ number: 1995, title: "Away mode: the morning review issue", state: "OPEN" }] : []),
	...Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "Fix widget " + i, state: "CLOSED" })),
]);
if (a[0] === "issue" && a[1] === "create") {
	const reviews = read("reviews.json");
	const number = 900 + reviews.length + fs.readdirSync(env.STUB_DIR).filter((n) => n.startsWith("created-")).length;
	const title = a[a.indexOf("--title") + 1];
	if (title.startsWith("Morning review") && fs.existsSync(f("fail-review-create"))) { ${ghAnswerHandler(CREATE_FAILED)} }
	const labels = a.flatMap((x, i) => (a[i - 1] === "--label" ? [x] : []));
	const body = stdin;
	fs.writeFileSync(f("created-" + number + ".json"), JSON.stringify({ title, labels, body }));
	/* A landed create that reports failure cannot be recorded; lib/gh.js reads this answer as broken, as it would that one. */
	if (fs.existsSync(f("fail-after-create"))) { ${ghAnswerHandler(CREATE_FAILED)} }
	if (title.startsWith("Morning review"))
		fs.writeFileSync(f("reviews.json"), JSON.stringify([...reviews, { number, title, state: "OPEN", createdAt: new Date().toISOString(), body, labels: [] }]));
	out(buildCreateAnswer(a[a.indexOf("--repo") + 1], number));
	exit(0);
}
err("gh stub: unsupported: " + a.join(" ") + "\\n");
exit(1);
`;

export const HOUR = 60 * 60 * 1000;

const CORE = path.resolve(__dirname, "..", "..");
const BASE_DOC = "docs/code-standards-base.md";

function countFreeCore(dir: string) {
	for (const name of fs.readdirSync(CORE))
		if (name !== "docs")
			fs.symlinkSync(path.join(CORE, name), path.join(dir, name));
	fs.mkdirSync(path.join(dir, "docs"));
	for (const name of fs.readdirSync(path.join(CORE, "docs")))
		fs.symlinkSync(path.join(CORE, "docs", name), path.join(dir, "docs", name));
	const at = path.join(dir, BASE_DOC);
	fs.rmSync(at);
	const text = fs.readFileSync(path.join(CORE, BASE_DOC), "utf8");
	const table = text.indexOf("\n## Primitives\n");
	const end = text.indexOf("\n## ", table + 1);
	if (table === -1 || end === -1)
		throw new Error(`${BASE_DOC} has no closed ## Primitives section`);
	const rows = text
		.slice(table, end)
		.replace(
			/^(\|.*\|)[ \t]*`[^|\n]*\|[ \t]*$/gm,
			"$1 Standards axis criterion |",
		);
	const last = (row: string) => row.split("|").at(-2)?.trim();
	const unswapped = rows
		.split("\n")
		.filter((l) => l.startsWith("| ") && !l.startsWith("| Job "))
		.filter((l) => last(l) !== "Standards axis criterion");
	if (unswapped.length > 0)
		throw new Error(
			`${BASE_DOC} rows still naming a program: ${unswapped.join("; ")}`,
		);
	fs.writeFileSync(at, text.slice(0, table) + rows + text.slice(end));
}

let shared: { server: GhStubServer; core: string } | undefined;
let state: "unregistered" | "registered" | "closed" = "unregistered";
function sharedState() {
	if (state === "unregistered") {
		state = "registered";
		beforeAll(async () => {
			const core = fs.mkdtempSync(
				path.join(os.tmpdir(), "morning-review-core-"),
			);
			countFreeCore(core);
			shared = { server: await serveGhStub(Handler), core };
		});
		afterAll(async () => {
			state = "closed";
			if (!shared) return;
			await shared.server.close();
			fs.rmSync(shared.core, { recursive: true, force: true });
		});
	}
	return () => {
		if (!shared || state === "closed")
			throw new Error(
				"the morning review fixture is not up: call it at a test file's top level",
			);
		return shared;
	};
}

const Hold = `
if (argv[0] === "issue" && argv[1] === "create") {
	const at = (n) => require("node:path").join(env.STUB_DIR, n);
	const fs = require("node:fs");
	if (fs.existsSync(at("hold-create"))) {
		fs.renameSync(at("hold-create"), at("holding"));
		/* A guess: quick beside a node start, and idle between looks. */
		while (!fs.existsSync(at("release"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
}
`;

export function morningReviewFixture(
	sb: ReturnType<typeof freshSandbox>,
	script: string,
) {
	const home = () => path.join(sb.dir, "fixture-home");
	const wfc = () => path.join(home(), "wfc");
	const stub = (name: string) => path.join(sb.dir, "gh", name);
	const refillFile = (name: string) => path.join(sb.dir, "refill", name);
	const live = sharedState();

	const ago = (hours: number) =>
		new Date(Date.now() - hours * HOUR).toISOString();

	function seed(reviews: object[]) {
		fs.mkdirSync(path.join(wfc(), ".git"), { recursive: true });
		fs.mkdirSync(path.join(wfc(), ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(wfc(), ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "T", tracker: "acme/wfc" }),
		);
		const entry = (at: string, issue: number, question: string) => ({
			at,
			repo: "acme/wfc",
			issue,
			comment: `https://github.com/acme/wfc/issues/${issue}#issuecomment-1`,
			question,
			taken: { option: "(A) keep", figure: 52 },
			runnerUp: { option: "(B) drop", figure: 48 },
			rungs: { rulings: "none", web: "none", subagent: "none" },
			stillClose: true,
			reverse: "drop it",
		});
		fs.writeFileSync(
			path.join(
				wfc(),
				".claude",
				"tmp",
				"markers",
				"delegated-decisions.jsonl",
			),
			`${[entry(ago(30), 1, "Before the window"), entry(ago(2), 2, "Inside the window")].map((e) => JSON.stringify(e)).join("\n")}\n{"at": "torn\n`,
		);
		fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
		fs.writeFileSync(stub("reviews.json"), JSON.stringify(reviews));
		fs.writeFileSync(stub("urgent.json"), "[]");
		fs.writeFileSync(stub("parked.json"), "[]");
		fs.writeFileSync(stub("timelines.json"), "{}");
		fs.writeFileSync(stub("idle.json"), "[]");
		const killedAt = Date.now() - 3 * HOUR;
		writeJournalctl(path.join(sb.dir, "gh"), [
			buildEarlyoomReadingLine(killedAt),
			buildEarlyoomSignalLine(killedAt, 9, "2.1.310"),
		]);
		const { incidentTitle } = require("./earlyoom-kills.js");
		fs.writeFileSync(
			stub("kills.json"),
			JSON.stringify([
				{
					number: 61,
					title: incidentTitle({ first: new Date(killedAt).toISOString() }),
				},
			]),
		);
		fs.writeFileSync(
			stub("closed.json"),
			JSON.stringify([
				{
					number: 77,
					title: "Drop the old ledger",
					url: "https://github.com/acme/wfc/issues/77",
					closedAt: ago(1),
					comments: [{ body: "**Door:** one-way — deleted data; cannot" }],
				},
			]),
		);
	}

	const heldGh = () =>
		stubGhHandler(path.join(sb.dir, "held"), `{${Hold}}\n${Handler}`).env;

	const runEnv = () => ({
		...process.env,
		...stubGhScript(sb.dir, live().server.script).env,
		HOME: home(),
		CLAUDE_PROJECT_DIR: wfc(),
		STUB_DIR: path.join(sb.dir, "gh"),
		WFC_JOURNALCTL: stub("journalctl"),
		WFC_RUNAWAY_LOG: stub("no-runaway-log.jsonl"),
		WFC_PROC: stub("no-proc"),
		WFC_REFILL_DIR: path.join(sb.dir, "refill"),
		WFC_SCRIPT_ROOT: live().core,
		MEMWATCH_MINUTE_LOG: refillFile("memwatch-minute.jsonl"),
	});

	const ghPort = () =>
		buildHandlerPort(Handler, {
			env: { STUB_DIR: path.join(sb.dir, "gh") },
			cwd: wfc(),
		});

	const stubRunEnv = () => {
		const env = runEnv();
		for (const key of [
			"HOME",
			"CLAUDE_PROJECT_DIR",
			"WFC_JOURNALCTL",
			"WFC_RUNAWAY_LOG",
			"WFC_PROC",
			"WFC_REFILL_DIR",
			"MEMWATCH_MINUTE_LOG",
		] as const)
			vi.stubEnv(key, env[key]);
	};

	const run = (argv: string[] = [], env: Record<string, string> = {}) =>
		runInProcessAsync(script, argv, {
			cwd: wfc(),
			env: { ...runEnv(), ...env },
		});

	const readCreated = () =>
		fs
			.readdirSync(path.join(sb.dir, "gh"))
			.filter((n) => n.startsWith("created-"))
			.map((n) => JSON.parse(fs.readFileSync(stub(n), "utf8")));

	return {
		ago,
		ghPort,
		heldGh,
		home,
		readCreated,
		refillFile,
		run,
		runEnv,
		seed,
		stub,
		stubRunEnv,
		wfc,
	};
}
