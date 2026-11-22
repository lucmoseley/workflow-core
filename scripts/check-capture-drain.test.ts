// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALE_CAPTURE_DAYS } from "./lib/captures";
import { GH_LOGGED_OUT_NODE, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const MARKER = "**Captured fact:**";

const SCRIPT = path.resolve(__dirname, "check-capture-drain.js");

let dir: string;

interface Comment {
	id: number;
	issue: number;
	age: number;
	body: string;
	reactions?: Record<string, number>;
	rawCreatedAt?: string;
}
interface Fixture {
	comments: Comment[];
	pages?: Comment[][];
	unreachable?: boolean;
	broken?: boolean;
}

const capture = (
	id: number,
	issue: number,
	age: number,
	drained = false,
): Comment => ({
	id,
	issue,
	age,
	body: `${MARKER} a fact caught on #${issue}`,
	reactions: { rocket: drained ? 1 : 0 },
});

const STATE = () => path.join(dir, "state.json");
const CALL_LOG = () => path.join(dir, "calls.log");

const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fx));
	const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "fixture.json"))}, "utf8"));
fs.appendFileSync(${JSON.stringify(CALL_LOG())}, process.argv.slice(2).join(" ") + "\\n");
const die = (msg) => { process.stderr.write("gh: " + msg + "\\n"); process.exit(1); };
if (fx.unreachable) { ${GH_LOGGED_OUT_NODE} }
if (fx.broken) die("HTTP 422: Unprocessable Entity");
const row = (c) => ({
  id: c.id,
  body: c.body,
  issue_url: "https://api.github.com/repos/o/r/issues/" + c.issue,
  html_url: "http://example/c/" + c.id,
  created_at: c.rawCreatedAt !== undefined ? c.rawCreatedAt : new Date(Date.now() - c.age * 864e5).toISOString(),
  reactions: c.reactions,
});
// --slurp wraps each page's array; fx.pages models a genuinely paginated read.
const pages = fx.pages || [fx.comments];
process.stdout.write(JSON.stringify(pages.map((p) => p.map(row))) + "\\n");
`;
	return stubGhScript(dir, stub);
};

const run = (
	fx: Fixture,
	args: string[] = [],
	env: Record<string, string> = {},
) => {
	const stub = stubGh(fx);
	const r = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			...stub.env,
			WFC_CAPTURE_STATE: STATE(),
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: dir,
			...env,
		},
	});
	const log = CALL_LOG();
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		stdout: r.stdout ?? "",
		json: () => JSON.parse(r.stdout ?? ""),
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
				: [],
	};
};

const writeState = (undrained: Comment[], hoursAgo = 0) =>
	fs.writeFileSync(
		STATE(),
		JSON.stringify({
			scannedAt: new Date(Date.now() - hoursAgo * 36e5).toISOString(),
			captureCount: undrained.length,
			undrainedCount: undrained.length,
			undrained: undrained.map((c) => ({
				id: c.id,
				issue: c.issue,
				url: `http://example/c/${c.id}`,
				createdAt: new Date(Date.now() - c.age * 864e5).toISOString(),
			})),
		}),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-capture-drain-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the drain command it prints (#439)", () => {
	const stale = { comments: [capture(1, 678, STALE_CAPTURE_DAYS + 5)] };

	it("names capture-drain.js repo-relative in a core checkout", () => {
		const r = run(stale);
		expect(r.status).toBe(0);
		expect(r.out).toContain("    node scripts/capture-drain.js list\n");
	});

	it("names capture-drain.js by its plugin-root path in an install", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-install-"));
		try {
			const r = run(stale, [], { WFC_SCRIPT_ROOT: root });
			expect(r.status).toBe(0);
			expect(r.out).toContain(`node ${root}/scripts/capture-drain.js list`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the age threshold", () => {
	it("speaks once the oldest undrained capture passes the threshold", () => {
		const r = run({ comments: [capture(1, 678, STALE_CAPTURE_DAYS + 5)] });
		expect(r.out).toContain("UNDRAINED CAPTURES");
		expect(r.out).toContain("#678");
		expect(r.out).toMatch(new RegExp(`${STALE_CAPTURE_DAYS + 5} days`));
		expect(r.status).toBe(0);
	});

	it("stays silent while every undrained capture is under it", () => {
		const r = run({ comments: [capture(1, 679, STALE_CAPTURE_DAYS - 1)] });
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
		expect(r.out).not.toContain("UNDRAINED CAPTURES");
	});

	it("does not fire exactly on the threshold, only past it", () => {
		const r = run({ comments: [capture(1, 679, STALE_CAPTURE_DAYS)] }, [
			"--days",
			String(STALE_CAPTURE_DAYS + 0.001),
		]);
		expect(r.out).not.toContain("UNDRAINED CAPTURES");
	});

	it("does not fire on a busy day — six captures, all fresh", () => {
		const r = run({
			comments: [1, 2, 3, 4, 5, 6].map((i) => capture(i, 679, 0)),
		});
		expect(r.out).not.toContain("UNDRAINED CAPTURES");
		expect(r.out).toContain("6 undrained capture(s)");
	});

	it("fires on a quiet fortnight — one capture, uncollected", () => {
		const r = run({ comments: [capture(1, 678, 14)] });
		expect(r.out).toContain("UNDRAINED CAPTURES");
	});

	it("ignores a drained capture however old it is", () => {
		const r = run({ comments: [capture(1, 640, 90, true)] });
		expect(r.out).toContain("OK");
		expect(r.out).not.toContain("UNDRAINED CAPTURES");
	});

	it("ages off the oldest, not the newest", () => {
		const r = run({ comments: [capture(1, 678, 30), capture(2, 679, 1)] });
		expect(r.out).toContain("UNDRAINED CAPTURES");
		expect(r.out).toMatch(/30 days/);
		expect(r.out).toContain("#678");
	});

	it("takes --days for a one-off look at a different threshold", () => {
		const fx = { comments: [capture(1, 678, 10)] };
		expect(run(fx, ["--days", "30"]).out).not.toContain("UNDRAINED CAPTURES");
		expect(run(fx, ["--days", "3"]).out).toContain("UNDRAINED CAPTURES");
	});

	it("is BROKEN on a --days that is not a number", () => {
		const r = run({ comments: [] }, ["--days", "soon"]);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});
});

describe("the paginated read", () => {
	it("finds a capture that only appears on a later page", () => {
		const r = run({
			comments: [],
			pages: [[capture(1, 679, 1)], [capture(2, 678, 40)]],
		});
		expect(r.out).toContain("UNDRAINED CAPTURES");
		expect(r.out).toContain("#678");
		expect(r.out).toMatch(/40 days/);
	});
});

describe("a timestamp GitHub did not give us", () => {
	it("reports an unparseable created_at rather than silently ignoring it", () => {
		const r = run({
			comments: [{ ...capture(1, 678, 0), rawCreatedAt: "not a date" }],
		});
		expect(r.out).toContain("UNDRAINED CAPTURES");
		expect(r.out).toContain("#678");
	});
});

describe("the session-start path", () => {
	it("reads the state file and never calls gh", () => {
		writeState([capture(1, 678, 30)]);
		const r = run({ comments: [] }, ["--notify"]);
		expect(r.stdout).toContain("UNDRAINED CAPTURES");
		expect(r.stdout).toContain("#678");
		expect(r.calls()).toEqual([]);
	});

	it("prints nothing when the state shows nothing overdue", () => {
		writeState([capture(1, 679, 1)]);
		const r = run({ comments: [] }, ["--notify"]);
		expect(r.out.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("prints nothing and calls no gh when there is no state at all", () => {
		const r = run({ comments: [capture(1, 678, 30)] }, ["--notify"]);
		expect(r.out.trim()).toBe("");
		expect(r.status).toBe(0);
		expect(r.calls()).toEqual([]);
	});

	it("ignores a state file too old to speak for", () => {
		writeState([capture(1, 678, 30)], 25);
		const r = run({ comments: [] }, ["--notify"]);
		expect(r.out.trim()).toBe("");
	});

	it("ages the stored capture itself, so a day-old state still reports", () => {
		writeState([capture(1, 678, 30)], 20);
		expect(run({ comments: [] }, ["--notify"]).stdout).toContain(
			"UNDRAINED CAPTURES",
		);
	});

	it("exits 0 with an unreachable gh, so the hook is not read as broken", () => {
		const r = run({ comments: [], unreachable: true }, ["--notify"]);
		expect(r.status).toBe(0);
	});
});

describe("--refresh", () => {
	it("writes the state file and prints nothing overdue", () => {
		const r = run(
			{ comments: [capture(1, 678, 30), capture(2, 640, 1, true)] },
			["--refresh"],
		);
		expect(r.status).toBe(0);
		const state = JSON.parse(fs.readFileSync(STATE(), "utf8"));
		expect(state.captureCount).toBe(2);
		expect(state.undrainedCount).toBe(1);
		expect(state.undrained[0].issue).toBe(678);
		expect(state.undrained[0].createdAt).toBeTruthy();
		expect(state.undrained[0].ageDays).toBeUndefined();
		expect(r.out).not.toContain("UNDRAINED CAPTURES");
	});

	it("makes one paginated call to the repo-wide comments endpoint", () => {
		const r = run({ comments: [capture(1, 679, 1)] }, ["--refresh"]);
		expect(r.calls()).toHaveLength(1);
		expect(r.calls()[0]).toContain("repos/{owner}/{repo}/issues/comments");
		expect(r.calls()[0]).toContain("--paginate");
		expect(r.calls()[0]).toContain("--slurp");
	});

	it("does not write a state file when the scan failed", () => {
		const r = run({ comments: [], unreachable: true }, ["--refresh"]);
		expect(r.out).toContain("SKIP");
		expect(fs.existsSync(STATE())).toBe(false);
	});
});

describe("a gh that fails", () => {
	it("SKIPs an unreachable GitHub rather than reporting all clear", () => {
		const r = run({ comments: [], unreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});

	it("is BROKEN on a gh failure that is not unreachability", () => {
		const r = run({ comments: [], broken: true });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});
});

describe("--json", () => {
	it("carries the counts and the oldest age", () => {
		const j = run(
			{ comments: [capture(1, 678, 30), capture(2, 640, 2, true)] },
			["--json"],
		).json();
		expect(j.checker).toBe("capture-drain");
		expect(j.undrainedCount).toBe(1);
		expect(Math.floor(j.oldestAgeDays)).toBe(30);
		expect(j.outcome).toBe("WARN");
		expect(j.findings[0].tag).toBe("UNDRAINED-CAPTURES");
	});
});
