/*
 * lander-testkit.ts — the sandbox the real-git lander suites stand on: a bare
 * `remote.git` and its clone `work`, `main` on one seed commit, with the
 * tester, tracker and run helpers that drive scripts/queue-lander.js against
 * it.
 *
 * Break it and every lander suite fails at once, or runs against a repo whose
 * `origin` is another case's.
 *
 * The seeded repo is built once per file and copied for each case (#4301):
 * the copy's only path into the template is `origin`'s URL, rewritten.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { RECORDED_SHAPES } from "./gh-fake.js";
import { stubGhScript } from "./gh-stub.js";
import { runInProcessAsync } from "./run-in-process.js";
import { shellQuote } from "./sh-quote.js";

const LANDER = path.resolve(__dirname, "../queue-lander.js");

/** The case's sandbox root, fresh for each case once landerSandbox() is called. */
export let tmp: string;
/** The clone the lander runs in. */
export let work: string;
/** The bare repo `work`'s `origin` names. */
export let remote: string;

export const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitIn = (dir: string, message: string) => {
	fs.writeFileSync(path.join(dir, `${message}.txt`), message);
	git(dir, "add", "-A");
	git(
		dir,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
	return git(dir, "rev-parse", "HEAD");
};

/** A commit in `work` adding `<message>.txt`, returning its sha. */
export const commit = (message: string) => commitIn(work, message);

export const markers = () => path.join(work, ".claude", "tmp", "markers");

/** Where the levelling stub records each start, one `<cwd> <args>` line. */
export const levelled = () => path.join(tmp, "levelled");

/** Where stubTracker records each call it has no arm for, one argv a line. */
export const unansweredLog = () => path.join(tmp, "unanswered-gh");

const NO_ARM = "stub tracker has no arm for this gh call";

/** The script the lander starts after a move in place of level-main.js. */
export const levelStub = () => {
	const stub = path.join(tmp, "level-stub.js");
	if (!fs.existsSync(stub))
		fs.writeFileSync(
			stub,
			`require("node:fs").appendFileSync(${JSON.stringify(levelled())}, process.cwd() + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
		);
	return stub;
};

/** Register the hooks that build the seeded template once and copy it per case. */
export function landerSandbox(): void {
	let template: string;

	beforeAll(() => {
		template = fs.mkdtempSync(path.join(os.tmpdir(), "lander-template-"));
		const bare = path.join(template, "remote.git");
		const clone = path.join(template, "work");
		git(template, "init", "-q", "--bare", "-b", "main", bare);
		git(template, "clone", "-q", bare, clone);
		git(clone, "config", "user.email", "t@t");
		git(clone, "config", "user.name", "t");
		commitIn(clone, "seed");
		git(clone, "push", "-q", "origin", "HEAD:main");
	});

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-"));
		fs.cpSync(template, tmp, { recursive: true });
		remote = path.join(tmp, "remote.git");
		work = path.join(tmp, "work");
		git(work, "remote", "set-url", "origin", remote);
	});

	afterEach(() => {
		try {
			if (fs.existsSync(unansweredLog()))
				throw new Error(
					`${NO_ARM} — add one to stubTracker in scripts/lib/lander-testkit.ts:\n${fs.readFileSync(unansweredLog(), "utf8")}`,
				);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
}

export const stubTester = (code: number, failing = "") => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nprintf '%s' ${shellQuote(failing)}\nexit ${code}\n`,
	);
	fs.chmodSync(script, 0o700);
	return script;
};

/** A tester red on `scripts/<name>.test.ts` while `<name>.txt` is in the tree. */
export const stubRedWhile = (name: string, alongside?: string) => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nif git cat-file -e "$1:"${shellQuote(`${name}.txt`)} 2>/dev/null${alongside ? ` && git cat-file -e "$1:"${shellQuote(`${alongside}.txt`)} 2>/dev/null` : ""}; then echo ${shellQuote(`scripts/${name}.test.ts`)}; exit 1; fi\nexit 0\n`,
	);
	fs.chmodSync(script, 0o700);
	return script;
};

export const runLander = (
	tester: string,
	modules = "landing",
	extraEnv: Record<string, string> = {},
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_MODULES: modules,
		CLAUDE_PROJECT_DIR: work,
		CLAUDE_CONFIG_DIR: path.join(tmp, "config"),
		WFC_LEVEL_MAIN_SCRIPT: levelStub(),
		...extraEnv,
	};
	delete env.CLAUDE_CODE_SESSION_ID;
	return runInProcessAsync(LANDER, ["run", "--tester", shellQuote(tester)], {
		cwd: work,
		env,
	});
};

/** The config `work` reads, naming the stub tracker. */
export const writeTrackerConfig = () => {
	fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(work, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/here" }),
	);
};

/**
 * A tracker of issues held in a JSON file, served by a gh stub, with the
 * config naming it. Each JSON read it answers goes through `asRecorded`, which
 * holds it to the fixture gh.contract.test.ts holds to the real gh: a list or
 * view answers only the `--json` fields asked for, as gh does. `issue close`
 * and `issue edit` print nothing: every caller discards a write's stdout.
 * A call no arm models — an unknown verb, a flag an arm ignores, or an arm
 * throwing — exits 1 and fails the case from landerSandbox's afterEach,
 * since the lander's fail-open paths can swallow the exit (#4357).
 */
export const stubTracker = () => {
	const store = path.join(tmp, "issues.json");
	const refuseReland = path.join(tmp, "refuse-reland");
	const unanswered = unansweredLog();
	fs.writeFileSync(store, "[]");
	const gh = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const fs = require("node:fs");
${RECORDED_SHAPES}
const a = process.argv.slice(2);
const refuse = (why) => {
	fs.appendFileSync(${JSON.stringify(unanswered)}, JSON.stringify(a) + (why ? " " + why : "") + "\\n");
	process.stderr.write(${JSON.stringify(NO_ARM)} + ": gh " + a.join(" ") + "\\n");
	process.exit(1);
};
process.on("uncaughtException", (e) => refuse(String(e)));
const onlyFlags = (...modelled) => {
	const unread = a.filter((w) => w.startsWith("--") && !["--repo", ...modelled].includes(w));
	if (unread.length > 0) refuse("unmodelled " + unread.join(" "));
};
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8"));
const write = (all) => fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(all));
const out = (o) => process.stdout.write(o);
const flag = (name) => a[a.indexOf(name) + 1];
const is = (...words) => words.every((w, i) => a[i] === w);
if (is("issue", "list")) {
	const state = flag("--state");
	const rows = read().filter((i) => state === "all" || i.state === state.toUpperCase());
	out(asRecorded("issueListRows", rows.map((r) => askedFields(a, r))) + "\\n");
} else if (is("api") && a[1].endsWith("/labels")) {
	const labels = ["urgent", "bug", "takes:implement", "kind:ticket"].map((name) => ({ name }));
	out(asRecorded("labelsPage", [labels]));
} else if (is("issue", "create")) {
	if (flag("--title").startsWith("Re-land") && fs.existsSync(${JSON.stringify(refuseReland)})) {
		process.stderr.write("gh down\\n");
		process.exit(1);
	}
	const all = read();
	const number = 100 + all.length;
	const labels = a.flatMap((w, i) => (w === "--label" ? [{ name: a[i + 1] }] : []));
	all.push({ number, title: flag("--title"), state: "OPEN", labels, body: fs.readFileSync(0, "utf8") });
	write(all);
	out(buildCreateAnswer("o/here", number));
} else if (is("issue", "view")) {
	const row = askedFields(a, read().find((i) => String(i.number) === a[2]));
	const text = asRecorded("issueView", row);
	if (!a.includes("--jq")) out(text + "\\n");
	else {
		const jq = flag("--jq").match(/^\\.(\\w+)$/);
		if (!jq) throw new Error("stub tracker reads no --jq filter but .<field>: " + flag("--jq"));
		// gh's --jq prints a string raw and anything else as JSON.
		const v = row[jq[1]] ?? null;
		out((typeof v === "string" ? v : JSON.stringify(v)) + "\\n");
	}
} else if (is("issue", "close")) {
	onlyFlags("--comment");
	const all = read();
	const issue = all.find((i) => String(i.number) === a[2]);
	issue.state = "CLOSED";
	issue.closing = flag("--comment");
	write(all);
} else if (is("issue", "edit")) {
	onlyFlags("--body-file", "--add-label");
	const all = read();
	const issue = all.find((i) => String(i.number) === a[2]);
	if (a.includes("--body-file")) issue.body = fs.readFileSync(flag("--body-file"), "utf8");
	a.forEach((w, i) => w === "--add-label" && issue.labels.push({ name: a[i + 1] }));
	write(all);
} else refuse();
`,
	);
	writeTrackerConfig();
	const readStore = () => JSON.parse(fs.readFileSync(store, "utf8"));
	return { store, refuseReland, gh, readStore };
};
