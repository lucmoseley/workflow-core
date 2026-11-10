// @vitest-environment node
/*
 * Pins that linking a child issue under a parent exits 0 only once the parent
 * lists the child, and fails loudly on every other path: `-f` for `-F`, an
 * empty or non-numeric id, a closed or unreadable parent, a 422, a link that
 * never shows.
 *
 * link-sub-issue.sh links a child issue under a parent (mantahostels#1150, the build).
 *
 * The oracle is a stubbed `gh` at WFC_GH which logs the argv it was
 * handed and serves programmable answers — the `-F` assertion below reads that
 * log, which is the only place the difference between `-f` and `-F` is visible
 * at all.
 *
 * MUTATION TESTED (mantahostels#1150's last acceptance criterion): switching the POST's
 * `-F` to `-f` fails "POSTs the database id with -F, never -f" and nothing
 * else. Dropping the 422 branch's retry back to a single read fails the two
 * tests naming that branch, and nothing else.
 *
 * Breaking it lets a link that `file-issue.js`, `place-new-issue.sh` or
 * `promote-spec.js` asked for fail silently, leaving the child invisible to
 * every map that reads sub-issues.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	buildJqLines,
	GH_NOT_FOUND,
	type GhAnswer,
	LINK_READ_FAKE,
	LINK_READS,
	type LinkReadAnswers,
} from "./lib/gh-fake";
import {
	type GhStubServer,
	printed,
	serveGhStub,
	stubGhScript,
} from "./lib/gh-stub";

const SCRIPT = path.resolve(__dirname, "link-sub-issue.sh");

let dir: string;
let calls: string;

interface Gh {
	/** What `gh api repos/o/r/issues/<child> --jq .id` prints. */
	dbId?: string;
	/** The db-id lookup fails. */
	idFails?: boolean;
	/** How the POST answers: ok | dup (422, one parent) | layers (422) | err. */
	post?: "ok" | "dup" | "layers" | "err";
	/** Parent-side reads: numbers listed, once `lag` reads have gone by. */
	children?: string[];
	lag?: number;
	/** What `gh api repos/o/r/issues/<parent> --jq .state` prints. */
	state?: string;
}

const refused = (stderr: string): GhAnswer => ({
	status: 1,
	stdout: "",
	stderr: `${stderr}\n`,
});

const POSTS: Record<NonNullable<Gh["post"]>, GhAnswer> = {
	ok: printed('{"number":1}\n'),
	dup: refused("gh: Sub issue may only have one parent (HTTP 422)"),
	layers: refused(
		"gh: You can't add more than 7 layers of sub-issues (HTTP 422)",
	),
	err: refused("gh: Bad credentials (HTTP 401)"),
};

const ANSWERS_FILE = "gh-answers.json";
const CALLS_FILE = "calls.log";

/*
 * The `gh` every run calls, logging one line of argv per call under the
 * directory GH_STUB_DIR names and answering from its ANSWERS_FILE. The
 * parent's list stays empty for its first `lag` reads, which `reads` counts.
 */
const HANDLER = `${LINK_READ_FAKE}
const fs = require("node:fs");
const path = require("node:path");
const at = (name) => path.join(env.GH_STUB_DIR, name);
fs.appendFileSync(at(${JSON.stringify(CALLS_FILE)}), argv.join(" ") + "\\n");
const g = JSON.parse(fs.readFileSync(at(${JSON.stringify(ANSWERS_FILE)}), "utf8"));
const serve = (a) => { out(a.stdout); err(a.stderr); exit(a.status); };
if (argv.join(" ").includes("--method POST")) serve(g.post);
if (argv[argv.indexOf("--jq") + 1] === ${JSON.stringify(LINK_READS.children.jq)}) {
	const n = fs.existsSync(at("reads")) ? Number(fs.readFileSync(at("reads"), "utf8")) : 0;
	fs.writeFileSync(at("reads"), String(n + 1));
	if (n < g.lag) exit(0);
}
const read = answerLinkRead(argv, g.reads);
if (read) serve(read);
`;

let server: GhStubServer;
beforeAll(async () => {
	server = await serveGhStub(HANDLER);
});
afterAll(() => server.close());

/** Points the stub server at `g` for this run. */
const stubGh = (g: Gh) => {
	const reads: LinkReadAnswers = {
		state: buildJqLines(g.state ?? "open"),
		id: g.idFails ? GH_NOT_FOUND : buildJqLines(g.dbId ?? "987654"),
		children: buildJqLines(...(g.children ?? [])),
	};
	fs.writeFileSync(
		path.join(dir, ANSWERS_FILE),
		JSON.stringify({ post: POSTS[g.post ?? "ok"], lag: g.lag ?? 0, reads }),
	);
	return stubGhScript(dir, server.script).env;
};

const run = (
	args: string[],
	g: Gh = {},
	linkRepo: string | null = "owner/repo",
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_PROJECT_DIR: dir,
		GH_STUB_DIR: dir,
		...stubGh(g),
		WFC_LINK_RETRIES: "3",
		WFC_LINK_SLEEP: "0",
	};
	if (linkRepo === null) delete env.WFC_LINK_REPO;
	else env.WFC_LINK_REPO = linkRepo;
	return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
};

/** The host repo: its origin the code repo, and `tracker` where given. */
const hostRepo = (tracker?: string) => {
	spawnSync("git", ["init", "-q", dir]);
	spawnSync("git", [
		"-C",
		dir,
		"remote",
		"add",
		"origin",
		"https://github.com/owner/code.git",
	]);
	if (tracker === undefined) return;
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker }),
	);
};

/** Every stubbed gh invocation, in call order. */
const readLog = () =>
	fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean)
		: [];

const readPosts = () => readLog().filter((l) => l.includes("--method POST"));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-sub-issue-"));
	calls = path.join(dir, CALLS_FILE);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the repo it links in (#3556)", () => {
	it("is the declared tracker, not the origin remote, where WFC_LINK_REPO is unset", () => {
		hostRepo("owner/tracker");
		const r = run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain(
			"repos/owner/tracker/issues/40/sub_issues",
		);
	});

	it("is the origin remote where no tracker is declared", () => {
		hostRepo();
		const r = run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain("repos/owner/code/issues/40/sub_issues");
	});

	it("is WFC_LINK_REPO where set, over the declared tracker", () => {
		hostRepo("owner/tracker");
		const r = run(["40", "63"], { children: ["63"] });
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain("repos/owner/repo/issues/40/sub_issues");
	});

	it("refuses, POSTing nothing, where neither a tracker nor an origin remote resolves", () => {
		spawnSync("git", ["init", "-q", dir]);
		const r = run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			'link-sub-issue: could not resolve the tracker — declare "tracker" in .claude/workflow-core.json or pass WFC_LINK_REPO\n',
		);
		expect(readLog()).toEqual([]);
	});
});

describe("link-sub-issue.sh", () => {
	it("POSTs the database id with -F, never -f", () => {
		const r = run(["40", "63"], { dbId: "987654", children: ["63"], lag: 1 });
		expect(r.status).toBe(0);
		expect(readPosts()).toHaveLength(1);
		expect(readPosts()[0]).toContain("-F sub_issue_id=987654");
		expect(readPosts()[0]).not.toContain("-f sub_issue_id");
	});

	it("verifies from the parent side, retrying through the documented lag", () => {
		const r = run(["40", "63"], { children: ["63"], lag: 2 });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("linked #63 as a sub-issue of #40");
		expect(readPosts()).toHaveLength(1);
		expect(
			readLog().filter((l) => l.includes("/40/sub_issues")).length,
		).toBeGreaterThan(2);
	});

	it("treats a 422 naming an existing parent as success, and never re-POSTs", () => {
		// The parent lists the child on the second read, so the first POST worked.
		const r = run(["40", "63"], { post: "dup", children: ["63"], lag: 1 });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already a sub-issue of #40");
		expect(readPosts()).toHaveLength(1);
	});

	it("names the detach command when the 422 is a DIFFERENT parent", () => {
		const r = run(["40", "63"], { post: "dup", children: [], dbId: "987654" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("already has a different parent");
		expect(r.stderr).toContain("--method DELETE");
		expect(readPosts()).toHaveLength(1);
	});

	it("refuses rather than POSTing an empty string when the db id lookup fails, naming the issue", () => {
		const r = run(["40", "63"], { idFails: true });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not resolve the database id of #63");
		expect(r.stderr).toContain("nothing was POSTed");
		expect(readPosts()).toHaveLength(0);
	});

	it("refuses a closed parent, naming it and the remedy, and POSTs nothing (#3650)", () => {
		const r = run(["40", "63"], { state: "closed", children: ["63"] });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("#40 is closed");
		expect(r.stderr).toContain("under an open issue");
		expect(r.stderr).toContain("--standalone");
		expect(readPosts()).toHaveLength(0);
	});

	it("refuses where the parent's state cannot be read, POSTing nothing", () => {
		const r = run(["40", "63"], { state: "" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not read the state of #40");
		expect(r.stderr).toContain("gh auth status");
		expect(readPosts()).toHaveLength(0);
	});

	it("refuses a db id that is not numeric, naming the value it got and POSTing nothing", () => {
		const r = run(["40", "63"], { dbId: "null" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("got 'null'");
		expect(readPosts()).toHaveLength(0);
	});

	it("retries the 422's own parent-side read through the lag", () => {
		// Inside the propagation window a single read would report a DIFFERENT
		// parent and hand the operator a DELETE that unlinks a correct link.
		const r = run(["40", "63"], { post: "dup", children: ["63"], lag: 2 });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already a sub-issue of #40");
		expect(r.stderr).not.toContain("different parent");
	});

	it("routes the 7-layer 422 to the peer fallback", () => {
		const r = run(["40", "63"], { post: "layers" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SAME parent");
		expect(readPosts()).toHaveLength(1);
	});

	it("fails loudly, never silently, when the POST is refused outright, naming the HTTP status", () => {
		const r = run(["40", "63"], { post: "err" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("POST failed");
		expect(r.stderr).toContain("401");
	});

	it("refuses when the POST succeeds but the parent never lists the child", () => {
		const r = run(["40", "63"], { children: [] });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("do NOT re-POST");
		expect(readPosts()).toHaveLength(1);
	});

	it.each([
		[["40"], "usage"],
		[["40", "sixty-three"], "not an issue number"],
		[["#40", "#40"], "cannot be its own parent"],
	])(
		"refuses bad arguments, saying what is wrong and posting nothing: %s",
		(args, expected) => {
			const r = run(args as string[]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(expected);
			expect(readPosts()).toHaveLength(0);
		},
	);

	it("accepts #-prefixed numbers", () => {
		const r = run(["#40", "#63"], { children: ["63"], lag: 1 });
		expect(r.status).toBe(0);
		expect(readLog().some((l) => l.includes("issues/40/sub_issues"))).toBe(
			true,
		);
		expect(readLog().some((l) => l.includes("issues/63 "))).toBe(true);
	});
});
