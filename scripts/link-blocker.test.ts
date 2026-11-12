// @vitest-environment node
/*
 * Pins that link-blocker.js makes a blocker link only where it closes no loop
 * of open issues waiting on each other (#5070): a loop-closing link exits 3
 * with nothing POSTed, naming each link, a foreign one by its full
 * reference; a link that closes none resolves the blocker's id itself, POSTs
 * it with -F and verifies in a separate read; a self-link is refused before
 * any read; an unread graph links anyway, warning; `--json` names each
 * failure's reason (#5096). Broken, it lets a
 * loop-closing blocker link through, and every issue in that loop stays open
 * for good.
 *
 * The oracle is a stubbed `gh` at WFC_GH logging each argv; the program runs
 * in-process.
 */

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
	asRecorded,
	LINK_READ_FAKE,
	WAIT_GRAPH_GRAPHQL_FAKE,
} from "./lib/gh-fake";
import { type GhStubServer, serveGhStub, stubGhScript } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "link-blocker.js");
const API = "https://api.github.com/repos";

interface Row {
	number: number;
	state: "open" | "closed";
	repo?: string;
}

interface Gh {
	/** The wait graph's links, by `owner/name#n`; no links where unset. */
	graph?: Record<string, { blockedBy?: Row[]; subIssues?: Row[] }>;
	graphFails?: boolean;
	/** What the blocked issue's canonical list names, once read. */
	listed?: { number: number; repo: string }[];
	postFails?: boolean;
}

let dir: string;

const HANDLER = `${LINK_READ_FAKE}
${WAIT_GRAPH_GRAPHQL_FAKE}
const fs = require("node:fs");
const path = require("node:path");
const at = (name) => path.join(env.GH_STUB_DIR, name);
fs.appendFileSync(at("calls.log"), argv.join(" ") + "\\n");
const g = JSON.parse(fs.readFileSync(at("gh-answers.json"), "utf8"));
const serve = (a) => { out(a.stdout); err(a.stderr); exit(a.status); };
const joined = argv.join(" ");
if (joined.includes("--method POST"))
	serve(g.postFails ? { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\\n" } : { status: 0, stdout: "{}", stderr: "" });
if (argv[1] === "graphql")
	serve(g.graphFails
		? { status: 1, stdout: "", stderr: "gh: Something went wrong (HTTP 502)\\n" }
		: answerWaitGraph(argv, (repo, n) => g.graph[repo.toLowerCase() + "#" + n] ?? {}));
if (joined.includes("/dependencies/blocked_by --paginate --slurp")) serve({ status: 0, stdout: g.listed, stderr: "" });
const id = /^repos\\/([^/]+\\/[^/]+)\\/issues\\/(\\d+)$/.exec(argv[1] ?? "");
if (id && argv.includes(".id")) serve(buildJqLines(9000 + Number(id[2])));
serve({ status: 1, stdout: "", stderr: "gh: no answer for " + joined + "\\n" });
`;

let server: GhStubServer;
beforeAll(async () => {
	server = await serveGhStub(HANDLER);
});
afterAll(() => server.close());

const run = (args: string[], g: Gh = {}) => {
	fs.writeFileSync(
		path.join(dir, "gh-answers.json"),
		JSON.stringify({
			graph: g.graph ?? {},
			graphFails: g.graphFails ?? false,
			postFails: g.postFails ?? false,
			listed: asRecorded("blockedByPage", [
				(g.listed ?? []).map((r) => ({
					number: r.number,
					state: "open",
					repository_url: `${API}/${r.repo}`,
				})),
			]),
		}),
	);
	return runInProcessAsync(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			GH_STUB_DIR: dir,
			...stubGhScript(dir, server.script).env,
			WFC_LINK_REPO: "o/r",
			WFC_LINK_RETRIES: "2",
			WFC_LINK_SLEEP: "0",
		},
	});
};

const readLog = () => {
	const read = readText(path.join(dir, "calls.log"));
	if (read.state === "unreadable") throw read.error;
	return read.state === "read" ? read.data.split("\n").filter(Boolean) : [];
};
const readPosts = () => readLog().filter((l) => l.includes("--method POST"));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-blocker-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("link-blocker.js", () => {
	/* #5055's shape: o/r#3864 blocked by m/t#4891, which waits on its child
	 * m/t#4893; the new link makes m/t#4893 blocked by o/r#3864. */
	const loop: Gh["graph"] = {
		"o/r#3864": { blockedBy: [{ number: 4891, state: "open", repo: "m/t" }] },
		"m/t#4891": { subIssues: [{ number: 4893, state: "open", repo: "m/t" }] },
	};

	it("refuses #5055's loop with exit 3, POSTing nothing, the foreign links fully qualified", async () => {
		const r = await run(["m/t#4893", "o/r#3864"], { graph: loop });
		expect(r.status).toBe(3);
		expect(readPosts()).toEqual([]);
		for (const link of [
			"#4893 is blocked by o/r#3864   (the new link)",
			"o/r#3864 is blocked by #4891",
			"#4891 waits on child #4893",
		])
			expect(r.stderr).toContain(link);
		expect(r.stderr).toContain(
			"Block on the build unit that does the work, never on a spec or map that stays open for its own follow-ups",
		);
		expect(r.stderr).toContain(
			"docs/agents/issue-tracker.md §Placing a new issue",
		);
	});

	it("names a local issue as #n and the other repo's as owner/name#n, from the blocked issue's repo", async () => {
		const r = await run(["#3864", "m/t#4893"], {
			graph: {
				"m/t#4893": {
					blockedBy: [{ number: 3864, state: "open", repo: "o/r" }],
				},
			},
		});
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("#3864 is blocked by m/t#4893   (the new link)");
		expect(r.stderr).toContain("m/t#4893 is blocked by #3864");
	});

	it("resolves a cross-repo blocker to its id, POSTs it with -F, and verifies in a separate read", async () => {
		const r = await run(["#10", "m/t#20"], {
			listed: [{ number: 20, repo: "m/t" }],
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("linked #10 as blocked by m/t#20\n");
		const log = readLog();
		const idRead = log.indexOf("api repos/m/t/issues/20 --jq .id");
		const post = log.findIndex((l) => l.includes("--method POST"));
		const verify = log.findIndex((l) =>
			l.startsWith(
				"api repos/o/r/issues/10/dependencies/blocked_by --paginate",
			),
		);
		expect(idRead).toBeGreaterThanOrEqual(0);
		expect(log[post]).toBe(
			"api --method POST repos/o/r/issues/10/dependencies/blocked_by -F issue_id=9020",
		);
		expect(verify).toBeGreaterThan(post);
		expect(r.stderr).toBe("");
	});

	it("does not read another repo's issue of the same number as the blocker", async () => {
		const r = await run(["#10", "m/t#20"], {
			listed: [{ number: 20, repo: "o/r" }],
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("do NOT re-POST");
	});

	it("refuses a self-link with exit 3 before any read", async () => {
		const r = await run(["#10", "o/r#10"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("cannot block itself");
		expect(readLog()).toEqual([]);
	});

	it("links anyway where the graph cannot be read, warning that the check was partial", async () => {
		const r = await run(["#10", "#20"], {
			graphFails: true,
			listed: [{ number: 20, repo: "o/r" }],
		});
		expect(r.status).toBe(0);
		expect(readPosts()).toHaveLength(1);
		expect(r.stderr).toContain("the loop check was partial");
		expect(r.stderr).toContain("could not read #20");
	});

	it("fails loudly when the POST is refused and the edge is not there", async () => {
		const r = await run(["#10", "#20"], { postFails: true });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("POST failed");
		expect(r.stderr).toContain("401");
	});

	it.each([
		["self", ["#10", "#10"], {}, 3],
		["loop", ["m/t#4893", "o/r#3864"], { graph: loop }, 3],
		["other", ["#10", "#20"], { postFails: true }, 1],
		["unlisted", ["#10", "#20"], {}, 1],
	] as const)(
		"names the reason %s under --json, printing nothing on stderr (#5096)",
		async (reason, args, g, code) => {
			const r = await run([...args, "--json"], g as Gh);
			expect(r.status).toBe(code);
			expect(r.stderr).toBe("");
			expect(JSON.parse(r.stdout)).toMatchObject({ code, reason });
		},
	);

	it.each([
		[["#10"], "usage"],
		[["ten", "#20"], "is not a number or owner/name#n"],
	])(
		"refuses bad arguments with exit 1, reading nothing: %s",
		async (args, text) => {
			const r = await run(args);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(text);
			expect(readLog()).toEqual([]);
		},
	);
});
