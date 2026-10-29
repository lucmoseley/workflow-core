// @vitest-environment node
/*
 * Pins that linking a child issue under a parent exits 0 only once the parent
 * lists the child, and fails loudly on every other path: `-f` for `-F`, an
 * empty or non-numeric id, a 422, a link that never shows.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "link-sub-issue.sh");

let dir: string;
let calls: string;
let counter: string;

interface Gh {
	/** What `gh api repos/o/r/issues/<child> --jq .id` prints. */
	dbId?: string;
	/** Non-zero exit on the db-id lookup — the transient-network case. */
	idFails?: boolean;
	/** How the POST answers: ok | dup (422, one parent) | layers (422) | err. */
	post?: "ok" | "dup" | "layers" | "err";
	/** Parent-side reads: numbers listed, once `lag` reads have gone by. */
	children?: string[];
	lag?: number;
}

/** A `gh` stub for WFC_GH, logging one line of argv per call. */
const stubGh = (g: Gh) => {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
args="$*"
case "$args" in
  *"--method POST"*)
    case "${g.post ?? "ok"}" in
      ok) echo '{"number":1}'; exit 0 ;;
      dup) echo 'gh: Sub issue may only have one parent (HTTP 422)' >&2; exit 1 ;;
      layers) echo "gh: You can't add more than 7 layers of sub-issues (HTTP 422)" >&2; exit 1 ;;
      err) echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1 ;;
    esac ;;
  *"/sub_issues"*)
    n=0; [[ -f "${counter}" ]] && n="$(cat "${counter}")"
    printf '%s' "$((n + 1))" > "${counter}"
    (( n < ${g.lag ?? 0} )) && exit 0
    ${(g.children ?? []).map((c) => `echo ${c}`).join("; ") || "true"}
    exit 0 ;;
  *"--jq"*)
    ${g.idFails ? "echo 'gh: network is unreachable' >&2; exit 1" : `printf '%s\\n' '${g.dbId ?? "987654"}'`}
    exit 0 ;;
esac
exit 0
`;
	const gh = path.join(bin, "gh");
	fs.writeFileSync(gh, script, { mode: 0o755 });
	return gh;
};

const run = (args: string[], g: Gh = {}) =>
	spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_GH: stubGh(g),
			WFC_LINK_REPO: "owner/repo",
			WFC_LINK_RETRIES: "3",
			WFC_LINK_SLEEP: "0",
		},
	});

/** Every stubbed gh invocation, in call order. */
const readLog = () =>
	fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean)
		: [];

const readPosts = () => readLog().filter((l) => l.includes("--method POST"));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-sub-issue-"));
	calls = path.join(dir, "calls.log");
	counter = path.join(dir, "reads");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
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
