// @vitest-environment node
/*
 * lib/queue-alert.js (#4485, spec #4458): one alert per crossing of the
 * queue's wait or depth limit, re-armed once back within it, over a canned
 * queue log and a tracker held in memory. Prior art: the landing-stall and
 * stall-ticket tests.
 *
 * Loosen it and every refill-loop tick past a limit files or refreshes a
 * ticket, a second crossing after a return within the limit goes unalerted,
 * or a ticket stays open over a queue that has recovered.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueAlertTender } from "./queue-alert.js";
import { queueCrossings } from "./queue-gauge.js";
import { queueBaseline } from "./queue-log.js";
import { QUEUE_ALERT_TITLES } from "./queue-tickets.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const A = "a".repeat(40);
const EMPTY = queueBaseline([], NOW);

const gauge = (...ages: number[]) => ({
	now: NOW,
	waiting: ages.map((age, i) => ({
		name: `w${i}`,
		sha: A,
		since: NOW - age * MIN,
	})),
	baseline: EMPTY,
});

describe("queueAlertTender", () => {
	let markers: string;
	let open: Map<string, { number: number; body: string }>;
	let calls: string[];
	let next: number;

	beforeEach(() => {
		markers = fs.mkdtempSync(path.join(os.tmpdir(), "queue-alert-"));
		open = new Map();
		calls = [];
		next = 1;
	});
	afterEach(() => fs.rmSync(markers, { recursive: true, force: true }));

	const tend = () =>
		queueAlertTender(
			{
				openIssue: (title) => {
					calls.push(`read ${title}`);
					const f = open.get(title);
					return f ? { ...f, labels: [] } : null;
				},
				similar: () => [],
				fileIssue: (args, body) => {
					const title = args[args.indexOf("--title") + 1] ?? "";
					calls.push(`file ${title}`);
					open.set(title, { number: next, body });
					return {
						status: 0,
						stdout: `Filed #${next}: https://x/${next++}\n`,
						stderr: "",
					};
				},
				refresh: (n) => {
					calls.push(`refresh #${n}`);
					return "refreshed";
				},
				addLabels: () => undefined,
				close: (n) => {
					calls.push(`close #${n}`);
					for (const [t, f] of open) if (f.number === n) open.delete(t);
				},
			},
			markers,
		);

	const pass = (g: ReturnType<typeof gauge>) => tend()(g, queueCrossings(g));

	it("alerts the wait once per crossing, and again after a return below", () => {
		expect(pass(gauge(61))).toEqual(["Filed #1: https://x/1"]);
		expect(open.get(QUEUE_ALERT_TITLES.age)?.body).toContain(
			"queue/w0 has waited 1 h 1 min",
		);
		calls = [];
		expect(pass(gauge(90))).toEqual([]);
		expect(calls).toEqual([]);
		expect(pass(gauge(5))).toEqual(["queue alert: closed #1."]);
		expect(open.size).toBe(0);
		expect(pass(gauge(5))).toEqual([]);
		expect(pass(gauge(70))).toEqual(["Filed #2: https://x/2"]);
	});

	it("alerts the depth once per crossing, and again after a return below", () => {
		const deep = new Array(11).fill(1);
		expect(pass(gauge(...deep))).toEqual(["Filed #1: https://x/1"]);
		expect([...open.keys()]).toEqual([QUEUE_ALERT_TITLES.depth]);
		expect(pass(gauge(...deep, 1))).toEqual([]);
		expect(pass(gauge(...new Array(10).fill(1)))).toEqual([
			"queue alert: closed #1.",
		]);
		expect(pass(gauge(...deep))).toEqual(["Filed #2: https://x/2"]);
	});

	it("reads no tracker on a pass within both limits with nothing on record", () => {
		expect(pass(gauge(5, 6))).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("names a torn record, drops it, and files again, refreshing the open ticket", () => {
		pass(gauge(61));
		const record = path.join(markers, ".queue-alert.json");
		fs.writeFileSync(record, "{torn");
		expect(pass(gauge(61))).toEqual([
			expect.stringMatching(/^queue alert: .* would not parse and is dropped/),
			expect.stringMatching(/^queue alert: refreshed/),
		]);
		expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({
			age: true,
			depth: false,
		});
	});

	it("throws where the record cannot be read for any reason but absence", () => {
		fs.mkdirSync(path.join(markers, ".queue-alert.json"));
		expect(() => pass(gauge(61))).toThrow(/EISDIR/);
		expect(calls).toEqual([]);
	});
});
