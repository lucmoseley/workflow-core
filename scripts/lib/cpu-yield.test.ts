// @vitest-environment node
/*
 * A run outside the whole-suite slot yielding its CPU to a running whole
 * suite in its own cgroup (#2955, #2956).
 *
 * Loosen it and the runs beside the lander's whole suite take the cores it
 * needs to finish inside the ceiling; widen it and the lander's own bisect
 * runs, a run with no whole suite to yield to, or one beside a suite in
 * another cgroup, where nice cannot reach, crawl at a tenth's weight.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { yieldToWhole } from "./cpu-yield.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-yield-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	for (const p of Object.keys(inCgroup)) delete inCgroup[Number(p)];
});

const stat = (pid: number, ppid: number) => `${pid} (node a) S ${ppid} 1 1`;
const tree: Record<number, number> = { 30: 20, 20: 10, 10: 1 };
const readStat = (p: number) => {
	if (!(p in tree)) throw new Error("ENOENT");
	return stat(p, tree[p]);
};

const inCgroup: Record<number, string> = {};
const readCgroup = (p: number) => {
	const at = inCgroup[p];
	if (at === undefined) throw new Error("ENOENT");
	return at;
};

const marker = (pid: number, fields: Record<string, unknown>) =>
	fs.writeFileSync(
		path.join(dir, `wfc-suite-queue-${pid}.json`),
		JSON.stringify({ pid, at: 1, ...fields }),
	);

const priority = (start: number) => {
	const set = vi.fn();
	return { set, os: { getPriority: () => start, setPriority: set } };
};

/* Process 30 (child of 20, child of 10) yielding child 7 at nice 5, unless
 * told otherwise. */
const run = ({
	alive = () => true,
	queueDir = dir,
	pid = 30,
	start = 5,
	os: given,
}: {
	alive?: (p: number) => boolean;
	queueDir?: string;
	pid?: number;
	start?: number;
	os?: { getPriority: () => number; setPriority: () => void };
} = {}) => {
	const p = priority(start);
	const said: string[] = [];
	const got = yieldToWhole(
		{ pid: 7 },
		{
			queueDir,
			pid,
			readStat,
			readCgroup,
			alive,
			priority: given ?? p.os,
			err: { write: (s: string) => said.push(s) },
		},
	);
	return { got, set: p.set, said: said.join("") };
};

describe("yieldToWhole", () => {
	it("raises the child's nice by 10 on another process's spawned whole marker, capped at 19", () => {
		marker(500, { spawned: true });
		const low = run();
		expect(low.got).toBe(true);
		expect(low.set).toHaveBeenCalledWith(7, 15);
		expect(run({ start: 15 }).set).toHaveBeenCalledWith(7, 19);
	});

	it.each([
		["a part-suite's", { spawned: true, part: true }],
		["a waiter not yet spawned", {}],
	])("leaves the child alone on %s marker", (_what, fields) => {
		marker(500, fields);
		const r = run();
		expect(r.got).toBe(false);
		expect(r.set).not.toHaveBeenCalled();
	});

	it("leaves the child alone on the marker of a process above this one", () => {
		marker(10, { spawned: true });
		expect(run().set).not.toHaveBeenCalled();
	});

	it("still yields where its own lineage stops on a stat that will not read", () => {
		marker(500, { spawned: true });
		const r = run({ pid: 99 });
		expect(r.got).toBe(true);
		expect(r.set).toHaveBeenCalledWith(7, 15);
	});

	it("leaves the child alone on a whole suite in another cgroup (#2956)", () => {
		marker(500, { spawned: true });
		inCgroup[30] = "0::/init.scope\n";
		inCgroup[500] = "0::/user.slice/run-1.scope\n";
		expect(run().set).not.toHaveBeenCalled();
		inCgroup[500] = inCgroup[30];
		expect(run().set).toHaveBeenCalledWith(7, 15);
	});

	it("leaves the child alone on a dead holder's marker", () => {
		marker(500, { spawned: true });
		expect(run({ alive: () => false }).set).not.toHaveBeenCalled();
	});

	it("leaves a child with no pid alone", () => {
		marker(500, { spawned: true });
		const p = priority(5);
		expect(yieldToWhole({}, { queueDir: dir, priority: p.os })).toBe(false);
		expect(p.set).not.toHaveBeenCalled();
	});

	it("prints why, rather than reading no whole suite, where the queue will not read (#2993)", () => {
		const blocked = path.join(dir, "not-a-dir");
		fs.writeFileSync(blocked, "x");
		const r = run({ queueDir: blocked });
		expect(r.got).toBe(false);
		expect(r.set).not.toHaveBeenCalled();
		expect(r.said).toMatch(/ENOTDIR.*full weight \(#2955\)/);
	});

	it("fails open, printing why, where the priority will not set", () => {
		marker(500, { spawned: true });
		const r = run({
			os: {
				getPriority: () => 5,
				setPriority: () => {
					throw new Error("EPERM");
				},
			},
		});
		expect(r.got).toBe(false);
		expect(r.said).toMatch(/EPERM.*full weight \(#2955\)/);
	});

	it("really lowers a live child's priority", async () => {
		const child = spawn("sleep", ["5"]);
		try {
			/* A child is never in its parent's lineage, and it is alive. */
			marker(child.pid as number, { spawned: true });
			const before = os.getPriority(child.pid);
			yieldToWhole(child, { queueDir: dir });
			expect(os.getPriority(child.pid)).toBe(Math.min(19, before + 10));
		} finally {
			child.kill();
		}
	});
});
