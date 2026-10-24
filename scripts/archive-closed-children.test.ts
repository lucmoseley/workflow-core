// @vitest-environment node
/*
 * Pins that archive-closed-children.js moves only a map's closed children into
 * one archival container — made once, then reused or recovered, never
 * duplicated — leaves container-like children where they are, and reports a
 * refused move or an unreachable GitHub by its own exit (#92).
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's own tracker state. The harness itself runs
 * in-process (scripts/lib/run-in-process.js, §X3) — only the stub `gh` the
 * script shells out to is a real subprocess.
 *
 * file-issue.js, promote-spec.js and check-open-maps.js send a session here
 * when a map reaches GitHub's 100-child cap: loosen a case and a run can move
 * an open child off its map, mint a second container, or leave the map full so
 * no new issue can be linked under it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_LOGGED_OUT_NODE, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "archive-closed-children.js");

let dir: string;

interface Kid {
	number: number;
	id: number;
	title?: string;
	state: "open" | "closed";
	/** the map number this issue is a direct child of, or null (unparented) */
	parent: number | null;
	/** non-zero marks a closed child as already holding sub-issues of its own */
	subIssuesTotal?: number;
}

interface Fixture {
	map: number;
	kids: Kid[];
	unreachable?: boolean;
	/** a 7-layers 422 on the move, for these child numbers */
	sevenLayers?: number[];
	/** the move POST fails for this child number, with this stderr line */
	moveFails?: Record<number, string>;
	createFails?: boolean;
	linkFails?: boolean;
	closeFails?: boolean;
}

const STATE = () => path.join(dir, "state.json");
const CALLS = () => path.join(dir, "calls.log");

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.ARCHIVE_STATE;
const callsPath = process.env.ARCHIVE_CALLS;
const argv = process.argv.slice(2);
fs.appendFileSync(callsPath, argv.join(" ") + "\\n");
const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const die = (msg) => { process.stderr.write("gh: " + msg + "\\n"); process.exit(1); };

const s0 = state();
if (s0.fx.unreachable) { ${GH_LOGGED_OUT_NODE} }

const p = argv.find((a) => a.startsWith("repos/")) || "";
const fValues = argv.filter((a, i) => argv[i - 1] === "-F");
const fVal = (name) => {
  const hit = fValues.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : undefined;
};

if (argv[0] === "issue" && argv[1] === "create") {
  if (s0.fx.createFails) die("HTTP 500 (issue create)");
  const s = state();
  const number = s.nextNumber++;
  const id = s.nextId++;
  const title = argv[argv.indexOf("--title") + 1];
  s.kids.push({ number, id, title, state: "open", parent: null });
  save(s);
  process.stdout.write("https://github.com/o/r/issues/" + number + "\\n");
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "close") {
  if (s0.fx.closeFails) die("HTTP 500 (issue close)");
  const n = Number(argv[2]);
  const s = state();
  const k = s.kids.find((x) => x.number === n);
  if (k) k.state = "closed";
  save(s);
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "list") {
  const s = state();
  const searchArg = argv[argv.indexOf("--search") + 1] || "";
  const m = /in:title "(.*)"/.exec(searchArg);
  const wanted = m ? m[1] : null;
  const rows = s.kids
    .filter((k) => wanted === null || k.title === wanted)
    .map((k) => ({ number: k.number, title: k.title, id: k.id, state: k.state }));
  process.stdout.write(JSON.stringify(rows) + "\\n");
  process.exit(0);
}

const postMatch = /issues\\/(\\d+)\\/sub_issues$/.exec(p);
if (argv.includes("--method") && argv.includes("POST") && postMatch) {
  const target = Number(postMatch[1]);
  const childId = Number(fVal("sub_issue_id"));
  const replaceParent = fVal("replace_parent") === "true";
  const s = state();
  const child = s.kids.find((k) => k.id === childId);
  if (!child) die("HTTP 404 (no such sub_issue_id)");
  if (s0.fx.sevenLayers && s0.fx.sevenLayers.includes(child.number))
    die("You can't add more than 7 layers of sub-issues (HTTP 422)");
  if (s0.fx.moveFails && s0.fx.moveFails[child.number])
    die(s0.fx.moveFails[child.number]);
  if (!replaceParent && s0.fx.linkFails) die("HTTP 422 (link under map)");
  child.parent = target;
  save(s);
  process.exit(0);
}

const getMatch = /issues\\/(\\d+)\\/sub_issues$/.exec(p);
if (getMatch && !argv.includes("--method")) {
  const n = Number(getMatch[1]);
  const s = state();
  const rows = s.kids.filter((k) => k.parent === n);
  process.stdout.write(JSON.stringify([rows.map(({ parent, subIssuesTotal, ...r }) => ({
    ...r,
    ...(subIssuesTotal ? { sub_issues_summary: { total: subIssuesTotal } } : {}),
  }))]) + "\\n");
  process.exit(0);
}

const oneMatch = /issues\\/(\\d+)$/.exec(p);
if (oneMatch && argv.includes("--jq")) {
  const n = Number(oneMatch[1]);
  const s = state();
  const k = s.kids.find((x) => x.number === n);
  process.stdout.write(String(k ? k.id : 0) + "\\n");
  process.exit(0);
}

die("unexpected call: " + argv.join(" "));
`;

const stubGh = (fx: Fixture) => {
	const statePath = STATE();
	fs.writeFileSync(
		statePath,
		JSON.stringify({
			fx,
			kids: fx.kids,
			nextNumber: 9000,
			nextId: 90_000,
		}),
	);
	fs.writeFileSync(CALLS(), "");
	const stub = stubGhScript(dir, STUB);
	return {
		...stub,
		env: { ...stub.env, ARCHIVE_STATE: statePath, ARCHIVE_CALLS: CALLS() },
	};
};

const spawn = (stub: ReturnType<typeof stubGh>, args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...stub.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

const calls = () =>
	fs.existsSync(CALLS())
		? fs.readFileSync(CALLS(), "utf8").trim().split("\n").filter(Boolean)
		: [];

const state = () => JSON.parse(fs.readFileSync(STATE(), "utf8"));

const run = (fx: Fixture, args: string[] = []) => {
	const stub = stubGh(fx);
	return spawn(stub, [String(fx.map), ...args]);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-children-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("nothing to archive", () => {
	it("does nothing when the map has no sub-issues at all", () => {
		const r = run({ map: 8, kids: [] });
		expect(r.status).toBe(0);
		expect(r.out).toContain("nothing to archive");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
	});

	it("does nothing when every direct child is open", () => {
		const r = run({
			map: 8,
			kids: [{ number: 9, id: 1, state: "open", parent: 8 }],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("nothing to archive");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
	});
});

describe("creating the container", () => {
	it("creates, moves, links last, and closes, in one run", () => {
		const r = run({
			map: 8,
			kids: [
				{ number: 9, id: 1, state: "open", parent: 8 },
				{ number: 10, id: 2, state: "closed", parent: 8 },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("moved 1 closed child(ren)");

		const c = calls();
		const createIdx = c.findIndex((l) => l.startsWith("issue create"));
		const moveIdx = c.findIndex(
			(l) => l.includes("/sub_issues") && l.includes("replace_parent=true"),
		);
		const linkIdx = c.findIndex(
			(l) =>
				l.includes("/sub_issues") &&
				l.includes("sub_issue_id=") &&
				!l.includes("replace_parent"),
		);
		const closeIdx = c.findIndex((l) => l.startsWith("issue close"));
		expect(createIdx).toBeGreaterThanOrEqual(0);
		expect(moveIdx).toBeGreaterThan(createIdx);
		expect(linkIdx).toBeGreaterThan(moveIdx);
		expect(closeIdx).toBeGreaterThan(linkIdx);

		const s = state();
		const container = s.kids.find((k: Kid) => k.number >= 9000);
		expect(container.parent).toBe(8);
		expect(container.state).toBe("closed");
		const child = s.kids.find((k: Kid) => k.number === 10);
		expect(child.parent).toBe(container.number);
	});

	it("writes nothing under --dry-run", () => {
		const r = run(
			{
				map: 8,
				kids: [{ number: 10, id: 2, state: "closed", parent: 8 }],
			},
			["--dry-run"],
		);
		expect(r.out).toContain("would move");
		expect(r.out).toContain("--dry-run wrote nothing");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(false);
		expect(calls().every((c) => !c.includes("--method"))).toBe(true);
	});

	it("is BROKEN, never a duplicate container, when create fails, saying none was created and closing nothing", () => {
		const r = run({
			map: 8,
			kids: [{ number: 10, id: 2, state: "closed", parent: 8 }],
			createFails: true,
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("no container was created");
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(false);
	});

	it("FAILs on link failure as ARCHIVE-LINK-FAILED and never closes an unlinked container, which a re-run heals (#92)", () => {
		const fx: Fixture = {
			map: 8,
			kids: [{ number: 10, id: 2, state: "closed", parent: 8 }],
			linkFails: true,
		};
		const stub = stubGh(fx);
		const r = spawn(stub, [String(fx.map)]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("ARCHIVE-LINK-FAILED");
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(false);

		const s = state();
		const container = s.kids.find((k: Kid) => k.number >= 9000);
		expect(container.state).toBe("open");
		const child = s.kids.find((k: Kid) => k.number === 10);
		expect(child.parent).toBe(container.number);

		// #92 — a re-run must find the orphan and self-heal, never spawn a
		// second container, even with nothing newly closed to move.
		fs.writeFileSync(CALLS(), "");
		fs.writeFileSync(
			STATE(),
			JSON.stringify({
				...JSON.parse(fs.readFileSync(STATE(), "utf8")),
				fx: { ...fx, linkFails: false },
			}),
		);
		const second = spawn(stub, [String(fx.map)]);
		expect(second.status).toBe(0);
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(true);

		const s2 = state();
		const containers = s2.kids.filter((k: Kid) => k.number >= 9000);
		expect(containers.length).toBe(1);
		expect(containers[0].parent).toBe(8);
		expect(containers[0].state).toBe("closed");
	});

	it("FAILs with ARCHIVE-CLOSE-FAILED on close failure but leaves the container linked, which a re-run closes (#92)", () => {
		const fx: Fixture = {
			map: 8,
			kids: [{ number: 10, id: 2, state: "closed", parent: 8 }],
			closeFails: true,
		};
		const stub = stubGh(fx);
		const r = spawn(stub, [String(fx.map)]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("ARCHIVE-CLOSE-FAILED");

		const s = state();
		const container = s.kids.find((k: Kid) => k.number >= 9000);
		expect(container.parent).toBe(8);
		expect(container.state).toBe("open");

		// #92 — a re-run finds the container already linked and closes it,
		// with nothing newly closed to move.
		fs.writeFileSync(CALLS(), "");
		fs.writeFileSync(
			STATE(),
			JSON.stringify({
				...JSON.parse(fs.readFileSync(STATE(), "utf8")),
				fx: { ...fx, closeFails: false },
			}),
		);
		const second = spawn(stub, [String(fx.map)]);
		expect(second.status).toBe(0);
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);

		const s2 = state();
		const container2 = s2.kids.find((k: Kid) => k.number >= 9000);
		expect(container2.state).toBe("closed");
	});
});

describe("reusing an existing container", () => {
	it("moves only the newly closed direct children, creating nothing", () => {
		const r = run({
			map: 8,
			kids: [
				{
					number: 50,
					id: 5,
					title: "Archive: closed children of #8",
					state: "closed",
					parent: 8,
				},
				{ number: 11, id: 3, state: "closed", parent: 8 },
			],
		});
		expect(r.status).toBe(0);
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(false);

		const s = state();
		const child = s.kids.find((k: Kid) => k.number === 11);
		expect(child.parent).toBe(50);
	});

	it("running it twice creates no second empty container", () => {
		const fx: Fixture = {
			map: 8,
			kids: [{ number: 10, id: 2, state: "closed", parent: 8 }],
		};
		const stub = stubGh(fx);
		const first = spawn(stub, [String(fx.map)]);
		expect(first.status).toBe(0);

		fs.writeFileSync(CALLS(), "");
		const second = spawn(stub, [String(fx.map)]);
		expect(second.status).toBe(0);
		expect(second.out).toContain("nothing to archive");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);

		const s = state();
		const containers = s.kids.filter((k: Kid) => k.number >= 9000);
		expect(containers.length).toBe(1);
	});

	it("finds an orphaned container by search and links + closes it (#92)", () => {
		const r = run({
			map: 8,
			kids: [
				{
					number: 50,
					id: 5,
					title: "Archive: closed children of #8",
					state: "open",
					parent: null,
				},
				{ number: 11, id: 3, state: "closed", parent: 8 },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("reusing it");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);

		const s = state();
		const container = s.kids.find((k: Kid) => k.number === 50);
		expect(container.parent).toBe(8);
		expect(container.state).toBe("closed");
	});

	it("closes a container found already linked but not yet closed", () => {
		const r = run({
			map: 8,
			kids: [
				{
					number: 50,
					id: 5,
					title: "Archive: closed children of #8",
					state: "open",
					parent: 8,
				},
				{ number: 11, id: 3, state: "closed", parent: 8 },
			],
		});
		expect(r.status).toBe(0);
		expect(calls().some((c) => c.startsWith("issue close"))).toBe(true);

		const s = state();
		const container = s.kids.find((k: Kid) => k.number === 50);
		expect(container.state).toBe("closed");
	});
});

describe("container-like closed children", () => {
	it("never nests a closed child that already holds sub-issues of its own (#92)", () => {
		const r = run({
			map: 8,
			kids: [
				{ number: 20, id: 7, state: "closed", parent: 8, subIssuesTotal: 89 },
				{ number: 11, id: 3, state: "closed", parent: 8 },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("already holding sub-issues");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(true);

		const s = state();
		const preexisting = s.kids.find((k: Kid) => k.number === 20);
		expect(preexisting.parent).toBe(8);
	});

	it("reports nothing to archive when only container-like children are closed", () => {
		const r = run({
			map: 8,
			kids: [
				{ number: 20, id: 7, state: "closed", parent: 8, subIssuesTotal: 89 },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("nothing to archive");
		expect(r.out).toContain("already holding sub-issues");
		expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
	});
});

describe("the 7-layer cap", () => {
	it("leaves a maximally deep child as a direct child, reported, not fatal", () => {
		const r = run({
			map: 8,
			kids: [{ number: 12, id: 4, state: "closed", parent: 8 }],
			sevenLayers: [12],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("7 layers deep");
		expect(r.out).not.toContain("FAIL");

		const s = state();
		const child = s.kids.find((k: Kid) => k.number === 12);
		expect(child.parent).toBe(8);
	});
});

describe("failure handling", () => {
	it("FAILs with ARCHIVE-MOVE-FAILED when a move is refused for an ordinary reason, naming the issue", () => {
		const r = run({
			map: 8,
			kids: [{ number: 13, id: 6, state: "closed", parent: 8 }],
			moveFails: { 13: "HTTP 500 (transient)" },
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain("ARCHIVE-MOVE-FAILED");
		expect(r.out).toContain("#13");
	});

	it("SKIPs at exit 0 when GitHub is unreachable", () => {
		const r = run({ map: 8, kids: [], unreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN (exit 2) with no map argument", () => {
		const stub = stubGh({ map: 8, kids: [] });
		const r = spawn(stub, []);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});
});
