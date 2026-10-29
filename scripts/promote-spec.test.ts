// @vitest-environment node
/*
 * Pins promote-spec.js: a brief's spec re-parented under its map, read back,
 * and the brief closed, in that order; every refusal before any write; a move
 * that does not land leaves the brief open; a re-run finishes only what is
 * missing.
 *
 * promote-spec.js, driven through its command line against a gh stub (#608;
 * the seam ruled on #606). Every refusal also asserts that nothing was
 * written — no move, no comment, no close, the claim still standing.
 *
 * `/to-spec` runs it, and no hook sees a `gh` call a script makes: loosen a case
 * and a brief closes with its spec still under it, or a roadmap card's own
 * issue closes past /card-close.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "promote-spec.js");
const ME = "sess-me";
const BRIEF = 501;
const SPEC = 535;
const MAP = 469;

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const state = (name: string) => path.join(sb.dir, "gh", name);
const put = (name: string, value: object) => {
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	fs.writeFileSync(state(name), JSON.stringify(value));
};
const get = (name: string) => JSON.parse(fs.readFileSync(state(name), "utf8"));

/**
 * `gh` over issues kept in `issues.json` (number → issue, each with a
 * `parent`), a brief's `timeline.json` and its `comments.json`. The sub-issue
 * POST moves the child and logs `sub_issue_removed` on its old parent, as
 * GitHub does. Levers: `post-422`, `close-fails`, and `hide` — the map's
 * listing omits the moved spec.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const S = process.env.STUB_DIR;
const f = (n) => path.join(S, n);
const a = process.argv.slice(2);
fs.appendFileSync(f("calls"), a.join(" ") + "\\n");
const say = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
const no = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
const load = (n, d) => fs.existsSync(f(n)) ? JSON.parse(fs.readFileSync(f(n), "utf8")) : d;
const issues = load("issues.json", {});
const save = () => fs.writeFileSync(f("issues.json"), JSON.stringify(issues));
const rest = (i) => ({ ...i, id: i.number * 1000, html_url: "https://github.com/acme/widgets/issues/" + i.number, labels: i.labels.map((name) => ({ name })),
	parent_issue_url: i.parent ? "https://api.github.com/repos/acme/widgets/issues/" + i.parent : null });
let m;
if (a[0] === "api" && a[1] === "--method") {
	if (fs.existsSync(f("post-422"))) no("gh: Validation Failed (HTTP 422)");
	const parent = Number(a[3].match(/issues\\/(\\d+)\\/sub_issues/)[1]);
	const child = Object.values(issues).find((i) => i.number * 1000 === Number(a[5].split("=")[1]));
	const tl = load("timeline.json", []);
	tl.push({ event: "sub_issue_removed", sub_issue: { number: child.number } });
	fs.writeFileSync(f("timeline.json"), JSON.stringify(tl));
	child.parent = parent; save();
	say(rest(child));
}
if (a[0] === "api" && a[1] === "user") say({ login: "me" });
if (a[0] === "api" && (m = a[1].match(/^repos\\/acme\\/widgets\\/issues\\/(\\d+)\\/sub_issues$/))) {
	const p = Number(m[1]);
	const hidden = p === ${MAP} && fs.existsSync(f("hide"));
	say([Object.values(issues).filter((i) => i.parent === p && !(hidden && i.number === ${SPEC})).map(rest)]);
}
if (a[0] === "api" && a[1] === "repos/acme/widgets/issues/${BRIEF}/timeline") say([load("timeline.json", [])]);
if (a[0] === "api" && a[1] === "repos/acme/widgets/issues/${BRIEF}/comments") say([load("comments.json", [])]);
if (a[0] === "api" && (m = a[1].match(/^repos\\/acme\\/widgets\\/issues\\/(\\d+)$/)) && issues[m[1]]) say(rest(issues[m[1]]));
if (a[0] === "issue" && a[1] === "comment") {
	fs.writeFileSync(f("comments.json"), JSON.stringify([...load("comments.json", []), { user: { login: "me" }, body: fs.readFileSync(0, "utf8") }]));
	say("");
}
if (a[0] === "issue" && a[1] === "close") {
	if (fs.existsSync(f("close-fails"))) no("HTTP 502: Bad Gateway");
	issues[a[2]].state = "closed"; save();
	say("");
}
no("HTTP 404: Not Found");
`;

interface Iss {
	number: number;
	title: string;
	state: string;
	labels: string[];
	parent: number | null;
}
const iss = (number: number, labels: string[], over: Partial<Iss> = {}) => ({
	number,
	title: `issue ${number}`,
	state: "open",
	labels,
	parent: null,
	body: "",
	...over,
});

const setUp = ({
	brief = {} as Partial<Iss>,
	mapLabels = ["wayfinder:map", "takes:children"],
	mapState = "open",
	extra = [] as ReturnType<typeof iss>[],
	spec = true,
} = {}) => {
	const all = [
		iss(MAP, mapLabels, { state: mapState }),
		iss(BRIEF, ["kind:brief", "takes:children"], { parent: MAP, ...brief }),
		...(spec
			? [iss(SPEC, ["kind:spec", "takes:to-tickets"], { parent: BRIEF })]
			: []),
		...extra,
	];
	put("issues.json", Object.fromEntries(all.map((i) => [i.number, i])));
	issueClaims.claimIssue(BRIEF, { sessionId: ME });
};

const run = () =>
	runInProcess(SCRIPT, [String(BRIEF)], {
		env: {
			...process.env,
			...stubGhScript(sb.dir, STUB).env,
			CLAUDE_CODE_SESSION_ID: ME,
			CLAUDE_JOB_DIR: sb.dir,
			STUB_DIR: path.join(sb.dir, "gh"),
			WFC_PROMOTE_SLEEP: "0",
		},
	});

const readCalls = () =>
	fs.existsSync(state("calls"))
		? fs.readFileSync(state("calls"), "utf8").split("\n").filter(Boolean)
		: [];
const readWrites = () =>
	readCalls().filter((c) =>
		/^(api --method|issue (comment|close|edit))/.test(c),
	);
const claimed = () => issueClaims.readIssueClaims(BRIEF).length > 0;
const at = (n: number) => get("issues.json")[n];
const readComments = () =>
	fs.existsSync(state("comments.json")) ? get("comments.json") : [];

const CLOSE_COMMENT = `Specced at #${SPEC}, moved under #${MAP}.\n\n**Outstanding:** #${SPEC} (the spec carries this brief's work)\n`;

const untouched = () => {
	expect(readWrites()).toEqual([]);
	expect(claimed()).toBe(true);
};

describe("an open child besides the spec (#3637)", () => {
	it("refuses before any write, naming the child the brief's close would strand", () => {
		setUp({
			extra: [
				iss(SPEC + 1, ["kind:ticket", "takes:implement"], { parent: BRIEF }),
				iss(SPEC + 2, ["kind:ticket"], { parent: BRIEF, state: "closed" }),
			],
		});
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`#${BRIEF} has 1 open sub-issue`);
		expect(r.stderr).toContain(`#${SPEC + 1} (issue ${SPEC + 1})`);
		expect(r.stderr).not.toContain(`#${SPEC + 2}`);
		untouched();
	});
});

describe("a successful promote", () => {
	it("re-parents, reads back, comments, closes and releases, in that order", () => {
		setUp();
		const r = run();
		expect(r.status).toBe(0);
		const c = readCalls();
		const post = c.findIndex((x) =>
			x.startsWith(
				`api --method POST repos/acme/widgets/issues/${MAP}/sub_issues -F sub_issue_id=${SPEC * 1000} -F replace_parent=true`,
			),
		);
		const readBack = c.findIndex(
			(x, i) =>
				i > post &&
				x.startsWith(`api repos/acme/widgets/issues/${MAP}/sub_issues`),
		);
		const comment = c.findIndex((x) => x.startsWith(`issue comment ${BRIEF}`));
		const close = c.findIndex((x) => x.startsWith(`issue close ${BRIEF}`));
		expect(post).toBeGreaterThanOrEqual(0);
		expect(readBack).toBeGreaterThan(post);
		expect(comment).toBeGreaterThan(readBack);
		expect(close).toBeGreaterThan(comment);
		expect(at(SPEC).parent).toBe(MAP);
		expect(at(BRIEF).state).toBe("closed");
		expect(readComments().map((x: { body: string }) => x.body)).toEqual([
			CLOSE_COMMENT,
		]);
		expect(claimed()).toBe(false);
	});

	it("writes nothing on the spec", () => {
		setUp();
		expect(run().status).toBe(0);
		expect(
			readWrites().filter((c) => new RegExp(`issue \\w+ ${SPEC}\\b`).test(c)),
		).toEqual([]);
		expect(at(SPEC).labels).toEqual(["kind:spec", "takes:to-tickets"]);
	});

	it("ignores a closed spec child beside the open one", () => {
		setUp({
			extra: [iss(600, ["kind:spec"], { parent: BRIEF, state: "closed" })],
		});
		expect(run().status).toBe(0);
		expect(at(SPEC).parent).toBe(MAP);
		expect(at(600).parent).toBe(BRIEF);
	});
});

describe("refusals, all before any write", () => {
	it("refuses an issue not labelled kind:brief, offering to run it on the kind:brief as the way out, and writes nothing", () => {
		setUp({ brief: { labels: ["kind:ticket"] } });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("not labelled kind:brief");
		expect(r.stderr).toContain("run this on the kind:brief");
		untouched();
	});

	it("refuses a brief with no open spec child, saying to publish its spec under it first, and writes nothing", () => {
		setUp({ spec: false });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no open kind:spec child");
		expect(r.stderr).toContain("publish its spec under it first");
		untouched();
	});

	it("refuses a brief with two open spec children, naming both and saying to close or re-parent the extras, and writes nothing", () => {
		setUp({ extra: [iss(600, ["kind:spec"], { parent: BRIEF })] });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`#${SPEC}, #600`);
		expect(r.stderr).toContain("close or re-parent the extra ones");
		untouched();
	});

	it("refuses a brief with no parent, offering link-sub-issue.sh as the way out, and writes nothing", () => {
		setUp({ brief: { parent: null } });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no parent");
		expect(r.stderr).toContain(`link-sub-issue.sh <map> ${BRIEF}`);
		untouched();
	});

	it("refuses a brief whose parent is not a map, offering replace_parent=true as the way out, and writes nothing", () => {
		setUp({ mapLabels: ["kind:spec"] });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("is not a wayfinder:map");
		expect(r.stderr).toContain("replace_parent=true");
		untouched();
	});

	it("refuses a closed map, naming it and the replace_parent=true re-parent, and writes nothing (#3651)", () => {
		setUp({ mapState: "closed" });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`map #${MAP} is closed`);
		expect(r.stderr).toContain("replace_parent=true");
		untouched();
	});

	it("refuses a roadmap card's own issue, pointing at /card-close", () => {
		setUp({ brief: { title: "search-v1 — Build search", parent: null } });
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`/card-close ${BRIEF}`);
		untouched();
	});

	it("refuses a spec-less brief whose removed child sits on the map unlabelled kind:spec, saying to publish its spec under it first, and writes nothing", () => {
		setUp({
			spec: false,
			extra: [iss(600, ["kind:ticket"], { parent: MAP })],
		});
		put("timeline.json", [
			{ event: "sub_issue_removed", sub_issue: { number: 600 } },
		]);
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("publish its spec under it first");
		untouched();
	});

	it("refuses an open brief whose moved spec has since closed, and writes nothing", () => {
		setUp({
			spec: false,
			extra: [iss(SPEC, ["kind:spec"], { parent: MAP, state: "closed" })],
		});
		put("timeline.json", [
			{ event: "sub_issue_removed", sub_issue: { number: SPEC } },
		]);
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no open kind:spec child");
		untouched();
	});

	it("refuses a spec-less brief two of whose removed specs sit on the map, naming both and saying to close the brief by hand, and writes nothing", () => {
		setUp({
			spec: false,
			extra: [
				iss(SPEC, ["kind:spec"], { parent: MAP }),
				iss(600, ["kind:spec"], { parent: MAP }),
			],
		});
		put("timeline.json", [
			{ event: "sub_issue_removed", sub_issue: { number: SPEC } },
			{ event: "sub_issue_removed", sub_issue: { number: 600 } },
		]);
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`#${SPEC}, #600`);
		expect(r.stderr).toContain("close the brief by hand");
		untouched();
	});

	it.each([
		["no argument", []],
		["two arguments", ["1", "2"]],
		["a non-number", ["abc"]],
	])("exits 2 and prints the usage on a usage error: %s", (_, args) => {
		const r = runInProcess(SCRIPT, args, { env: process.env });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: node scripts/promote-spec.js <brief>");
	});
});

describe("a move that does not land", () => {
	it("exits 1 with the brief open when the map's read-back does not list the spec", () => {
		setUp();
		put("hide", {});
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`#${MAP} does not list it`);
		expect(r.stderr).toContain("re-run");
		expect(at(BRIEF).state).toBe("open");
		expect(readComments()).toEqual([]);
		expect(claimed()).toBe(true);
	});

	it("exits 1 on a 422, naming archive-closed-children.js, the brief open", () => {
		setUp();
		put("post-422", {});
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`node scripts/archive-closed-children.js ${MAP}`,
		);
		expect(at(SPEC).parent).toBe(BRIEF);
		expect(at(BRIEF).state).toBe("open");
		expect(readComments()).toEqual([]);
		expect(claimed()).toBe(true);
	});
});

describe("a re-run", () => {
	it("after the move landed and the close did not, finishes only the close", () => {
		setUp();
		put("close-fails", {});
		const first = run();
		expect(first.status).toBe(1);
		expect(first.stderr).toContain("Re-run to finish");
		expect(at(SPEC).parent).toBe(MAP);
		expect(at(BRIEF).state).toBe("open");

		fs.rmSync(state("close-fails"));
		fs.rmSync(state("calls"));
		const again = run();
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("re-parent skipped");
		expect(again.stdout).toContain("not posted again");
		expect(readCalls().some((c) => c.startsWith("api --method"))).toBe(false);
		expect(readComments()).toHaveLength(1);
		expect(at(BRIEF).state).toBe("closed");
		expect(claimed()).toBe(false);
	});

	it("after a full run writes nothing and exits 0", () => {
		setUp();
		expect(run().status).toBe(0);
		fs.rmSync(state("calls"));
		const again = run();
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("already closed");
		expect(readWrites()).toEqual([]);
	});

	it("after a full run whose map has since closed, still exits 0, refusing only a move (#3651)", () => {
		setUp();
		expect(run().status).toBe(0);
		put("issues.json", {
			...get("issues.json"),
			[MAP]: { ...at(MAP), state: "closed" },
		});
		fs.rmSync(state("calls"));
		const again = run();
		expect(again.status).toBe(0);
		expect(readWrites()).toEqual([]);
	});
});
