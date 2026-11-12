// @vitest-environment node
/*
 * Pins that linking a child issue under a parent exits 0 only once the parent
 * lists the child, and fails loudly on every other path: `-f` for `-F`, an
 * empty or non-numeric id, a closed or unreadable parent, a 422, a link that
 * never shows; and that a link closing a loop of open issues is refused with
 * exit 3 and nothing POSTed (#5070).
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
import { readText } from "./lib/file-read.js";
import {
	buildJqLines,
	GH_NOT_FOUND,
	type GhAnswer,
	LINK_READ_FAKE,
	LINK_READS,
	type LinkReadAnswers,
	WAIT_GRAPH_GRAPHQL_FAKE,
} from "./lib/gh-fake";
import {
	type GhStubServer,
	printed,
	refused,
	serveGhStub,
	stubGhScript,
} from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "link-sub-issue.sh");
const WRITER = path.resolve(__dirname, "lib", "link-writer.js");

let dir: string;
let calls: string;

interface Gh {
	/** What `gh api repos/o/r/issues/<child> --jq .id` prints. */
	dbId?: string;
	/** The db-id lookup fails. */
	idFails?: boolean;
	/** How the POST answers: ok | dup (422, one parent) | layers (422) | cap (422) | invalid (422) | err. */
	post?: "ok" | "dup" | "layers" | "cap" | "invalid" | "err";
	/** Parent-side reads: numbers listed, once `lag` reads have gone by. */
	children?: string[];
	lag?: number;
	/** What `gh api repos/o/r/issues/<n> --jq .state` prints. */
	state?: string;
	/** Per-issue overrides of `state`, by number. */
	states?: Record<string, string>;
	/** The wait graph's links, by `owner/name#n`; no links where unset. */
	graph?: Record<string, { blockedBy?: Row[]; subIssues?: Row[] }>;
	/** The wait graph's GraphQL read fails. */
	graphFails?: boolean;
}

interface Row {
	number: number;
	state: "open" | "closed";
	repo?: string;
}

const POSTS: Record<NonNullable<Gh["post"]>, GhAnswer> = {
	ok: printed('{"number":1}\n'),
	dup: refused("gh: Sub issue may only have one parent (HTTP 422)"),
	layers: refused(
		"gh: You can't add more than 7 layers of sub-issues (HTTP 422)",
	),
	cap: refused("gh: Parent cannot have more than 100 sub-issues (HTTP 422)"),
	invalid: refused("gh: Validation Failed (HTTP 422)"),
	err: refused("gh: Bad credentials (HTTP 401)"),
};

const ANSWERS_FILE = "gh-answers.json";
const CALLS_FILE = "calls.log";
const READS_FILE = "reads";

/*
 * The `gh` every run calls, logging one line of argv per call under the
 * directory GH_STUB_DIR names and answering from its ANSWERS_FILE. The
 * parent's list stays empty for its first `lag` reads, which READS_FILE counts.
 */
const HANDLER = `${LINK_READ_FAKE}
${WAIT_GRAPH_GRAPHQL_FAKE}
const fs = require("node:fs");
const path = require("node:path");
const at = (name) => path.join(env.GH_STUB_DIR, name);
fs.appendFileSync(at(${JSON.stringify(CALLS_FILE)}), argv.join(" ") + "\\n");
const g = JSON.parse(fs.readFileSync(at(${JSON.stringify(ANSWERS_FILE)}), "utf8"));
const serve = (a) => { out(a.stdout); err(a.stderr); exit(a.status); };
if (argv.join(" ").includes("--method POST")) serve(g.post);
if (argv[1] === "graphql")
	serve(g.graphFails
		? { status: 1, stdout: "", stderr: "gh: Something went wrong (HTTP 502)\\n" }
		: answerWaitGraph(argv, (repo, n) => g.graph[repo.toLowerCase() + "#" + n] ?? {}));
if (argv[argv.indexOf("--jq") + 1] === ${JSON.stringify(LINK_READS.children.jq)}) {
	const counter = at(${JSON.stringify(READS_FILE)});
	const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
	fs.writeFileSync(counter, String(n + 1));
	if (n < g.lag) exit(0);
}
const issue = /\\/issues\\/(\\d+)$/.exec(argv[1] ?? "");
if (issue && argv.includes(".state") && g.states[issue[1]] !== undefined)
	serve(buildJqLines(g.states[issue[1]]));
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
		JSON.stringify({
			post: POSTS[g.post ?? "ok"],
			lag: g.lag ?? 0,
			reads,
			states: g.states ?? {},
			graph: g.graph ?? {},
			graphFails: g.graphFails ?? false,
		}),
	);
	return stubGhScript(dir, server.script).env;
};

const linkEnv = (g: Gh, linkRepo: string | null) => {
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
	return env;
};

/* The writer in-process; the shim's own pass-through has one case below. */
const run = (
	args: string[],
	g: Gh = {},
	linkRepo: string | null = "owner/repo",
) =>
	runInProcessAsync(WRITER, ["sub-issue", ...args], {
		env: linkEnv(g, linkRepo),
	});

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
const readLog = () => {
	const read = readText(calls);
	if (read.state === "unreadable") throw read.error;
	return read.state === "read" ? read.data.split("\n").filter(Boolean) : [];
};

const readPosts = () => readLog().filter((l) => l.includes("--method POST"));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-sub-issue-"));
	calls = path.join(dir, CALLS_FILE);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shim", () => {
	it("passes its arguments through to the writer, linking under its own name", () => {
		const r = spawnSync("bash", [SCRIPT, "40", "63", "--replace-parent"], {
			encoding: "utf8",
			env: linkEnv({ children: ["63"] }, "owner/repo"),
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("linked #63 as a sub-issue of #40\n");
		expect(readPosts()[0]).toContain("-F replace_parent=true");
	});
});

describe("the repo it links in (#3556)", () => {
	it("is the declared tracker, not the origin remote, where WFC_LINK_REPO is unset", async () => {
		hostRepo("owner/tracker");
		const r = await run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain(
			"repos/owner/tracker/issues/40/sub_issues",
		);
	});

	it("is the origin remote where no tracker is declared", async () => {
		hostRepo();
		const r = await run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain("repos/owner/code/issues/40/sub_issues");
	});

	it("is WFC_LINK_REPO where set, over the declared tracker", async () => {
		hostRepo("owner/tracker");
		const r = await run(["40", "63"], { children: ["63"] });
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain("repos/owner/repo/issues/40/sub_issues");
	});

	it("refuses, POSTing nothing, where neither a tracker nor an origin remote resolves", async () => {
		spawnSync("git", ["init", "-q", dir]);
		const r = await run(["40", "63"], { children: ["63"] }, null);
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			'link-sub-issue: could not resolve the tracker — declare "tracker" in .claude/workflow-core.json or pass WFC_LINK_REPO\n',
		);
		expect(readLog()).toEqual([]);
	});
});

describe("link-sub-issue.sh", () => {
	it("POSTs the database id with -F, never -f", async () => {
		const r = await run(["40", "63"], {
			dbId: "987654",
			children: ["63"],
			lag: 1,
		});
		expect(r.status).toBe(0);
		expect(readPosts()).toHaveLength(1);
		expect(readPosts()[0]).toContain("-F sub_issue_id=987654");
		expect(readPosts()[0]).not.toContain("-f sub_issue_id");
	});

	it("verifies from the parent side, retrying through the documented lag", async () => {
		const r = await run(["40", "63"], { children: ["63"], lag: 2 });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("linked #63 as a sub-issue of #40");
		expect(readPosts()).toHaveLength(1);
		expect(
			readLog().filter((l) => l.includes("/40/sub_issues")).length,
		).toBeGreaterThan(2);
	});

	it("treats a 422 naming an existing parent as success, and never re-POSTs", async () => {
		// The parent lists the child on the second read, so the first POST worked.
		const r = await run(["40", "63"], {
			post: "dup",
			children: ["63"],
			lag: 1,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already a sub-issue of #40");
		expect(readPosts()).toHaveLength(1);
	});

	it("names the detach command when the 422 is a DIFFERENT parent", async () => {
		const r = await run(["40", "63"], {
			post: "dup",
			children: [],
			dbId: "987654",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("already has a different parent");
		expect(r.stderr).toContain("--method DELETE");
		expect(readPosts()).toHaveLength(1);
	});

	it("refuses rather than POSTing an empty string when the db id lookup fails, naming the issue", async () => {
		const r = await run(["40", "63"], { idFails: true });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not resolve the database id of #63");
		expect(r.stderr).toContain("nothing was POSTed");
		expect(readPosts()).toHaveLength(0);
	});

	it("refuses a closed parent over an open child, naming it and the remedy, and POSTs nothing (#3650)", async () => {
		const r = await run(["40", "63"], {
			states: { "40": "closed" },
			children: ["63"],
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("#40 is closed");
		expect(r.stderr).toContain("under an open issue");
		expect(r.stderr).toContain("--standalone");
		expect(readPosts()).toHaveLength(0);
	});

	it("moves a closed child under a closed parent, as into an archival container", async () => {
		const r = await run(["40", "63", "--replace-parent"], {
			state: "closed",
			children: ["63"],
		});
		expect(r.status, r.stderr).toBe(0);
		expect(readPosts()).toHaveLength(1);
	});

	it("refuses where the parent's state cannot be read, POSTing nothing", async () => {
		const r = await run(["40", "63"], { state: "" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not read the state of #40");
		expect(r.stderr).toContain("gh auth status");
		expect(readPosts()).toHaveLength(0);
	});

	it("refuses a db id that is not numeric, naming the value it got and POSTing nothing", async () => {
		const r = await run(["40", "63"], { dbId: "null" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("got 'null'");
		expect(readPosts()).toHaveLength(0);
	});

	it("retries the 422's own parent-side read through the lag", async () => {
		// Inside the propagation window a single read would report a DIFFERENT
		// parent and hand the operator a DELETE that unlinks a correct link.
		const r = await run(["40", "63"], {
			post: "dup",
			children: ["63"],
			lag: 2,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already a sub-issue of #40");
		expect(r.stderr).not.toContain("different parent");
	});

	it("routes the 7-layer 422 to the peer fallback", async () => {
		const r = await run(["40", "63"], { post: "layers" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SAME parent");
		expect(readPosts()).toHaveLength(1);
	});

	it("fails loudly, never silently, when the POST is refused outright, naming the HTTP status", async () => {
		const r = await run(["40", "63"], { post: "err" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("POST failed");
		expect(r.stderr).toContain("401");
	});

	it("refuses when the POST succeeds but the parent never lists the child", async () => {
		const r = await run(["40", "63"], { children: [] });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("do NOT re-POST");
		expect(readPosts()).toHaveLength(1);
	});

	it.each([
		[["40"], "usage"],
		[["40", "sixty-three"], "not an issue number"],
	])(
		"refuses bad arguments, saying what is wrong and posting nothing: %s",
		async (args, expected) => {
			const r = await run(args as string[]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(expected);
			expect(readPosts()).toHaveLength(0);
		},
	);

	it("refuses a self-link with exit 3 before any read", async () => {
		const r = await run(["#40", "#40"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("cannot be its own parent");
		expect(readLog()).toEqual([]);
	});

	it("accepts #-prefixed numbers", async () => {
		const r = await run(["#40", "#63"], { children: ["63"], lag: 1 });
		expect(r.status).toBe(0);
		expect(readLog().some((l) => l.includes("issues/40/sub_issues"))).toBe(
			true,
		);
		expect(readLog().some((l) => l.includes("issues/63 "))).toBe(true);
	});
});

describe("the --json outcome (#5096)", () => {
	it.each([
		["self", ["40", "40"], {}, 3],
		["layers", ["40", "63"], { post: "layers" }, 1],
		["cap", ["40", "63"], { post: "cap" }, 1],
		["rejected", ["40", "63"], { post: "invalid" }, 1],
		["other", ["40", "63"], { post: "err" }, 1],
		["unlisted", ["40", "63"], { children: [] }, 1],
		["closed-parent", ["40", "63"], { states: { "40": "closed" } }, 1],
	] as const)(
		"names the reason %s, printing one JSON object and nothing on stderr",
		async (reason, args, g, code) => {
			const r = await run([...args, "--json"], g as Gh);
			expect(r.status).toBe(code);
			expect(r.stderr).toBe("");
			const o = JSON.parse(r.stdout);
			expect(o).toMatchObject({ code, reason, out: "" });
			expect(o.err).not.toBe("");
		},
	);

	it("carries the success line and the partial-check warning, with no reason", async () => {
		const r = await run(["40", "63", "--json"], {
			children: ["63"],
			graphFails: true,
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		const o = JSON.parse(r.stdout);
		expect(o).toMatchObject({
			code: 0,
			reason: "",
			err: "",
			out: "linked #63 as a sub-issue of #40\n",
		});
		expect(o.warning).toMatch(/^warning — the loop check was partial/);
	});
});

describe("the loop check (#5070)", () => {
	/* #5055's shape: three open issues across two repos, one sub-issue link
	 * and two blocker links; the sub-issue link closes it. */
	const loop: Gh["graph"] = {
		"owner/repo#63": {
			blockedBy: [{ number: 3864, state: "open", repo: "other/m" }],
		},
		"other/m#3864": {
			blockedBy: [{ number: 40, state: "open", repo: "owner/repo" }],
		},
	};

	it("refuses a link that closes a loop with exit 3, POSTing nothing and naming each link", async () => {
		const r = await run(["40", "63"], { graph: loop, children: ["63"] });
		expect(r.status).toBe(3);
		expect(readPosts()).toHaveLength(0);
		const lines = r.stderr.split("\n");
		const at = (text: string) => lines.findIndex((l) => l.includes(text));
		expect(at("#40 waits on child #63   (the new link)")).toBeGreaterThan(0);
		expect(at("#63 is blocked by other/m#3864")).toBeGreaterThan(
			at("(the new link)"),
		);
		expect(at("other/m#3864 is blocked by #40")).toBeGreaterThan(
			at("#63 is blocked by other/m#3864"),
		);
		expect(r.stderr).toContain(
			"Block on the build unit that does the work, never on a spec or map that stays open for its own follow-ups",
		);
		expect(r.stderr).toContain(
			"docs/agents/issue-tracker.md §Placing a new issue",
		);
		expect(r.stderr).toContain("Nothing was changed.");
	});

	it("names the reason loop under --json", async () => {
		const r = await run(["40", "63", "--json"], { graph: loop });
		expect(r.status).toBe(3);
		expect(JSON.parse(r.stdout)).toMatchObject({ code: 3, reason: "loop" });
	});

	it("posts a link that closes no loop, though the child waits on other issues", async () => {
		const r = await run(["40", "63"], {
			graph: {
				"owner/repo#63": { blockedBy: [{ number: 7, state: "open" }] },
				"owner/repo#7": {
					blockedBy: [{ number: 40, state: "closed" }],
				},
			},
			children: ["63"],
		});
		expect(r.status).toBe(0);
		expect(readPosts()).toHaveLength(1);
		expect(r.stderr).toBe("");
	});

	it("links anyway where the graph cannot be read, warning that the check was partial", async () => {
		const r = await run(["40", "63"], { graphFails: true, children: ["63"] });
		expect(r.status).toBe(0);
		expect(readPosts()).toHaveLength(1);
		expect(r.stderr).toContain("the loop check was partial");
		expect(r.stderr).toContain("could not read #63");
	});

	it("sends replace_parent=true under --replace-parent", async () => {
		const r = await run(["40", "63", "--replace-parent"], { children: ["63"] });
		expect(r.status).toBe(0);
		expect(readPosts()[0]).toContain("-F replace_parent=true");
	});

	it("checks a --replace-parent link like a plain one", async () => {
		const r = await run(["40", "63", "--replace-parent"], {
			graph: loop,
			children: ["63"],
		});
		expect(r.status).toBe(3);
		expect(readPosts()).toHaveLength(0);
	});

	it("still reads the 422 naming an existing parent as success without --replace-parent", async () => {
		const r = await run(["40", "63"], { post: "dup", children: ["63"] });
		expect(r.status).toBe(0);
		expect(readPosts()[0]).not.toContain("replace_parent");
	});
});
