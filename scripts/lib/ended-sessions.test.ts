// @vitest-environment node
/*
 * Pins lib/ended-sessions.js's judgement — which processes outlived their
 * Claude session and what each kill takes — against a fake /proc (#4342).
 *
 * Loosen a case and a live session's worker, the lander, or the daemon that
 * holds every session is SIGKILLed; tighten one and a dead session's worker
 * spins on unseen.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findEndedSessions } from "./ended-sessions.js";
import { makeProcRoot, type ProcSpec, writeEnviron } from "./proc-fake";
import { readProcTable } from "./proc-table.js";

const LEADER = 5000;
const SESSION = "aead2193-0000";
const WORKER = "node /x/node_modules/vitest/dist/workers/forks.js";

let fixture: ReturnType<typeof makeProcRoot>;

beforeEach(() => {
	fixture = makeProcRoot();
});

afterEach(() => {
	fixture.remove();
});

/** A process carrying `env`, the session's two keys by default. */
function proc(
	pid: number,
	spec: ProcSpec,
	env: string[] = [`CLAUDE_CODE_SESSION_ID=${SESSION}`, `CLAUDE_PID=${LEADER}`],
) {
	fixture.proc(pid, spec);
	writeEnviron(fixture.root, pid, ["PATH=/bin", ...env]);
}

function find(opts: { mine?: number[]; skip?: number[] } = {}) {
	const table = readProcTable(fixture.root);
	if (!table) throw new Error("fake root will not list");
	return findEndedSessions(table.procs, {
		root: fixture.root,
		bootAgo: fixture.uptime,
		mine: new Set(opts.mine ?? []),
		skip: new Set(opts.skip ?? []),
	});
}

const pids = (r: { targets: { pid: number }[] }) =>
	r.targets.map((t) => t.pid).sort();

describe("findEndedSessions", () => {
	it("takes an init-parented process whose leader is gone, with its tree, naming the session", () => {
		proc(6001, { ppid: 1, argv: WORKER, ageS: 7200 });
		proc(6002, { ppid: 6001, argv: "sleep 300", ageS: 7000 });
		const reaps = find();
		expect(reaps).toEqual([
			expect.objectContaining({
				pid: 6001,
				scope: "tree",
				argv: WORKER.split(" "),
				session: { id: SESSION, leader: LEADER },
			}),
		]);
		expect(pids(reaps[0] ?? { targets: [] })).toEqual([6001, 6002]);
	});

	it("reads WSL's session /init, by argv, as an init", () => {
		fixture.proc(342, { ppid: 1, argv: "/init" });
		proc(6001, { ppid: 342, argv: WORKER });
		expect(find().map((r) => r.pid)).toEqual([6001]);
	});

	it("never takes a process of a live session", () => {
		fixture.proc(LEADER, { ppid: 1, argv: "claude", ageS: 9000 });
		proc(6001, { ppid: 1, argv: WORKER, ageS: 7200 });
		expect(find()).toEqual([]);
	});

	it("takes one whose leader's pid was reused by a process started after it", () => {
		fixture.proc(LEADER, { ppid: 1, argv: "claude", ageS: 60 });
		proc(6001, { ppid: 1, argv: WORKER, ageS: 7200 });
		expect(find().map((r) => r.pid)).toEqual([6001]);
	});

	it("never takes one with no session in its environ, nor one forgetSession stripped", () => {
		proc(6001, { ppid: 1, argv: "node lander.js run" }, [
			`CLAUDE_PID=${LEADER}`,
		]);
		proc(6002, { ppid: 1, argv: WORKER }, []);
		proc(6003, { ppid: 1, argv: WORKER }, [
			`CLAUDE_CODE_SESSION_ID=${SESSION}`,
		]);
		expect(find()).toEqual([]);
	});

	it("never takes one whose parent is alive and no init: its parent's to end", () => {
		fixture.proc(6000, { ppid: 1, argv: "bash" });
		proc(6001, { ppid: 6000, argv: WORKER });
		expect(find()).toEqual([]);
	});

	it("never takes a Claude process, the one-word spare's argv included, nor walks into one", () => {
		proc(6001, { ppid: 1, argv: ["claude daemon run"] });
		proc(6002, { ppid: 1, argv: ["claude bg-spare --bg-spare /tmp/s.sock"] });
		proc(6010, { ppid: 1, argv: "sh -c work" });
		proc(6011, { ppid: 6010, argv: "claude -p hi" });
		proc(6012, { ppid: 6011, argv: "sleep 300" });
		const reaps = find();
		expect(reaps.map((r) => r.pid)).toEqual([6010]);
		expect(pids(reaps[0] ?? { targets: [] })).toEqual([6010]);
	});

	it("stops its walk at a child with no session in its environ, a forgetSession child's", () => {
		proc(6001, { ppid: 1, argv: WORKER });
		proc(6002, { ppid: 6001, argv: "node lander.js run" }, [
			`CLAUDE_PID=${LEADER}`,
		]);
		proc(6003, { ppid: 6002, argv: "sleep 300" });
		expect(pids(find()[0] ?? { targets: [] })).toEqual([6001]);
	});

	it("leaves out its own tree and what another part already takes", () => {
		proc(6001, { ppid: 1, argv: WORKER });
		proc(6002, { ppid: 1, argv: WORKER });
		proc(6003, { ppid: 6002, argv: "sleep 300" });
		const reaps = find({ mine: [6001], skip: [6003] });
		expect(reaps.map((r) => r.pid)).toEqual([6002]);
		expect(pids(reaps[0] ?? { targets: [] })).toEqual([6002]);
	});

	it("lists the oldest first", () => {
		proc(6001, { ppid: 1, argv: WORKER, ageS: 100 });
		proc(6002, { ppid: 1, argv: WORKER, ageS: 9000 });
		expect(find().map((r) => r.pid)).toEqual([6002, 6001]);
	});
});
