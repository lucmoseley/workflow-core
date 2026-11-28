// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runMorning, runNight } from "./combining-trial.js";

const TASKS = {
	on: "Verifier 5743 combining on",
	off: "Verifier 5743 combining off",
	dump: "Verifier 5743 live dump",
};

type LogName = "combining.log" | "dumps.log";

function fake(opts: {
	start: string;
	ended?: boolean;
	holdError?: string | null;
	combining?: string[];
	writes: Record<string, [LogName, string] | null>;
	scanError?: string | null;
}) {
	let t = new Date(opts.start).getTime();
	const logs: Record<LogName, string[]> = {
		"combining.log": [...(opts.combining ?? [])],
		"dumps.log": [],
	};
	const calls: string[] = [];
	const posts: string[] = [];
	const scans: string[] = [];
	return {
		calls,
		posts,
		scans,
		ports: {
			now: () => t,
			ended: () => opts.ended === true,
			readLog: (name: LogName) => `\uFEFF${logs[name].join("\r\n")}`,
			startTask: (name: string) => {
				calls.push(`start ${name}`);
				const w = opts.writes[name];
				if (w) logs[w[0]].push(w[1]);
				return null;
			},
			sleep: (ms: number) => {
				t += ms;
			},
			hold: () => {
				calls.push("hold");
				return opts.holdError ?? null;
			},
			release: () => {
				calls.push("release");
				return null;
			},
			scan: (dump: string) => {
				scans.push(dump);
				return opts.scanError ?? null;
			},
			post: (body: string) => {
				posts.push(body);
				return null;
			},
			say: () => undefined,
		},
	};
}

const ON = "2026-11-27T23:00:04 on PageCombining=True";
const OFF = "2026-11-28T07:01:30 off PageCombining=False";
const DUMP =
	"2026-11-28T07:01:10 ok path=C:\\diag\\5743\\dumps\\live-261128-0700.dmp bytes=2400000000";

describe("runNight", () => {
	it("turns combining on, holding no launches", () => {
		const f = fake({
			start: "2026-11-27T23:00:00",
			writes: { [TASKS.on]: ["combining.log", ON] },
		});
		expect(runNight(f.ports)).toBe(0);
		expect(f.calls).toEqual([`start ${TASKS.on}`]);
	});

	it("leaves combining off once the Verifier pass has ended", () => {
		const f = fake({ start: "2026-11-27T23:00:00", ended: true, writes: {} });
		expect(runNight(f.ports)).toBe(0);
		expect(f.calls).toEqual([]);
	});

	it("fails where combining did not turn on", () => {
		const f = fake({
			start: "2026-11-27T23:00:00",
			writes: {
				[TASKS.on]: [
					"combining.log",
					"2026-11-27T23:00:04 on PageCombining=False",
				],
			},
		});
		expect(runNight(f.ports)).toBe(1);
	});
});

describe("runMorning", () => {
	it("dumps before turning combining off, then scans, posting no problem", () => {
		const f = fake({
			start: "2026-11-28T07:00:00",
			combining: [ON],
			writes: {
				[TASKS.dump]: ["dumps.log", DUMP],
				[TASKS.off]: ["combining.log", OFF],
			},
		});
		expect(runMorning(f.ports)).toBe(0);
		expect(f.calls).toEqual([
			"hold",
			`start ${TASKS.dump}`,
			`start ${TASKS.off}`,
			"release",
		]);
		expect(f.scans).toEqual(["C:\\diag\\5743\\dumps\\live-261128-0700.dmp"]);
		expect(f.posts).toEqual([]);
	});

	it("renews the hold while a dump that never logs is waited on", () => {
		const f = fake({
			start: "2026-11-28T07:00:00",
			combining: [ON],
			writes: { [TASKS.dump]: null, [TASKS.off]: ["combining.log", OFF] },
		});
		expect(runMorning(f.ports)).toBe(1);
		expect(f.calls.filter((c) => c === "hold").length).toBeGreaterThan(2);
		expect(f.calls.at(-1)).toBe("release");
	});

	it("holds nothing on a morning after a night with combining off", () => {
		const f = fake({
			start: "2026-12-02T07:00:00",
			combining: [OFF],
			writes: {
				[TASKS.dump]: ["dumps.log", DUMP],
				[TASKS.off]: ["combining.log", OFF],
			},
		});
		expect(runMorning(f.ports)).toBe(0);
		expect(f.calls).not.toContain("hold");
	});

	it("posts a failed dump and still turns combining off", () => {
		const f = fake({
			start: "2026-11-28T07:00:00",
			combining: [ON],
			writes: {
				[TASKS.dump]: [
					"dumps.log",
					"2026-11-28T07:00:40 failed step=dump status=0xC000009A bytes=0",
				],
				[TASKS.off]: ["combining.log", OFF],
			},
		});
		expect(runMorning(f.ports)).toBe(1);
		expect(f.calls).toContain(`start ${TASKS.off}`);
		expect(f.scans).toEqual([]);
		expect(f.posts).toHaveLength(1);
		expect(f.posts[0]).toContain("No live dump this morning");
		expect(f.posts[0]).toContain("status=0xC000009A");
	});

	it("posts where combining did not turn off, naming the task to start", () => {
		const f = fake({
			start: "2026-11-28T07:00:00",
			combining: [ON],
			writes: { [TASKS.dump]: ["dumps.log", DUMP], [TASKS.off]: null },
		});
		expect(runMorning(f.ports)).toBe(1);
		expect(f.posts[0]).toContain("Page combining did not turn off");
		expect(f.posts[0]).toContain(`/TN "${TASKS.off}"`);
	});
});
