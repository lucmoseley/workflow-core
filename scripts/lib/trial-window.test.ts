// @vitest-environment node
/*
 * trial-window.js parses gate 2's trial declaration, and the fortnight it
 * describes runs ONCE and cannot be replayed (mantahostels#2835). So the tests that matter
 * are the ones on refusal: a declaration this parser accepts wrongly suppresses
 * the ordinary ceiling trigger for two weeks (mantahostels#2845), and one it drops silently
 * leaves the gate unread on the only occasion it could ever be read.
 *
 * Declarations are built as ladder text in-process, one line overridden per
 * case, and read from a temp file through the reader the hooks call, so each
 * refusal is reached without editing the real ladder. The parse feeds
 * `check-seat-utilisation.js`, a SessionStart hook in `.claude/settings.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const {
	LADDER,
	readTrialWindow,
	windowPhase,
	// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("./trial-window.js");

const parseDir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-window-parse-"));
afterAll(() => fs.rmSync(parseDir, { recursive: true, force: true }));
let parses = 0;
const readLadder = (text: string) => {
	const file = path.join(parseDir, `ladder-${parses++}.md`);
	fs.writeFileSync(file, text);
	return readTrialWindow(file);
};

const START = "2026-09-10T21:00:00Z";
const END = "2026-09-24T21:00:00Z";

/** A ladder holding one declaration, with `over` replacing named lines. */
const ladder = (over: Record<string, string | null> = {}) => {
	const lines: Record<string, string> = {
		seat: "- **seat:** `.claude3`",
		account: "- **account:** `acct-3`",
		basis:
			"- **start basis:** `.claude` resets `2026-09-08T21:00:00Z` read 2.0h ago · " +
			"`.claude2` resets `2026-09-10T21:00:00Z` read 0.5h ago",
		window: `- **measured window:** \`${START}\` → \`${END}\``,
		baseline:
			"- **seat 3 at declaration:** 7d 62% · resets `2026-09-09T21:00:00Z` · fetched `2026-09-04T07:00:00Z`",
	};
	const body = Object.entries(lines)
		.map(([k, v]) => (k in over ? over[k] : v))
		.filter((v) => v !== null)
		.join("\n");
	return [
		"### Seat 3's probation",
		"",
		"#### Gate 2 trial declaration",
		"",
		body,
		"",
		"### Founder override",
		"",
		"- 2026-08-28 something dated, well outside the section.",
	].join("\n");
};

describe("the resting state", () => {
	it("reads a ladder with no declaration section at all as no trial", () => {
		expect(readLadder("# ladder\n\nnothing here\n").state).toBe("none");
	});

	it("reads an empty section as no trial rather than as malformed", () => {
		expect(
			readLadder(
				ladder({
					seat: null,
					account: null,
					basis: null,
					window: null,
					baseline: null,
				}),
			).state,
		).toBe("none");
	});
});

describe("a well-formed declaration", () => {
	it("carries both instants, the account, and the advisory directory", () => {
		const d = readLadder(ladder());
		expect(d.state).toBe("declared");
		expect(d.accountUuid).toBe("acct-3");
		expect(d.dir).toBe(".claude3");
		expect(d.startMs).toBe(Date.parse(START));
		expect(d.endMs).toBe(Date.parse(END));
		expect(d.excludedBaseline).toEqual({
			sevenDay: 62,
			resetsAt: "2026-09-09T21:00:00Z",
			fetchedAtMs: Date.parse("2026-09-04T07:00:00Z"),
		});
	});

	it("does not read a field only present past the heading boundary", () => {
		/* Leave `seat` unset INSIDE the section, and place a matching line past
		 * the next heading. `field()` returns the first match it finds, so if
		 * `parseSectionLines()` failed to stop at "### Founder override" this would be
		 * read as the seat line and the declaration would parse as `declared`
		 * rather than refuse. This is the case the length assertion above does
		 * not exercise: it never gives the boundary anything to wrongly admit. */
		const text = [
			"### Seat 3's probation",
			"",
			"#### Gate 2 trial declaration",
			"",
			"- **account:** `acct-3`",
			"- **start basis:** `.claude` resets `2026-09-08T21:00:00Z` read 2.0h ago · " +
				"`.claude2` resets `2026-09-10T21:00:00Z` read 0.5h ago",
			`- **measured window:** \`${START}\` → \`${END}\``,
			"- **seat 3 at declaration:** 7d 62% · resets `2026-09-09T21:00:00Z` · " +
				"fetched `2026-09-04T07:00:00Z`",
			"",
			"### Founder override",
			"",
			"- **seat:** `.claude9`",
		].join("\n");
		const d = readLadder(text);
		expect(d.state).toBe("malformed");
		expect(d.reason).toMatch(/no `seat` line/);
	});
});

describe("refusals", () => {
	const reason = (over: Record<string, string | null>) => {
		const d = readLadder(ladder(over));
		expect(d.state).toBe("malformed");
		return d.reason as string;
	};

	it("refuses a start basis read 24h or more stale, as carried forward (mantahostels#2697, mantahostels#2848)", () => {
		expect(
			reason({
				basis:
					"- **start basis:** `.claude` resets `2026-09-08T21:00:00Z` read 2.0h ago · " +
					`\`.claude2\` resets \`${START}\` read 24.0h ago`,
			}),
		).toMatch(/carried forward/);
	});

	it("trusts a start basis read just under 24h ago", () => {
		const d = readLadder(
			ladder({
				basis:
					"- **start basis:** `.claude` resets `2026-09-08T21:00:00Z` read 2.0h ago · " +
					`\`.claude2\` resets \`${START}\` read 23.9h ago`,
			}),
		);
		expect(d.state).toBe("declared");
	});

	it("refuses a window not starting at the later of the basis resets", () => {
		expect(
			reason({
				window: `- **measured window:** \`2026-09-08T21:00:00Z\` → \`${END}\``,
			}),
		).toMatch(/LATER of the start basis/);
	});

	it("refuses a window longer than the bound, which is a mistyped end, naming the 21-day bound", () => {
		/* Without a ceiling a slipped year suppresses the repo's only upward
		 * spend trigger for as long as the typo says — the unbounded suppression
		 * mantahostels#2847 chose two written instants to avoid. */
		expect(
			reason({
				window: `- **measured window:** \`${START}\` → \`2027-09-24T21:00:00Z\``,
			}),
		).toMatch(/over the 21-day bound/);
	});

	it("refuses a window that ends before it starts", () => {
		expect(
			reason({
				window: `- **measured window:** \`${START}\` → \`2026-09-01T21:00:00Z\``,
			}),
		).toMatch(/ends at or before/);
	});

	it("refuses a staleness figure that is not a number, naming the config dir it was read for", () => {
		/* `NaN >= 24` is false, so an unguarded parse ACCEPTS this — the expensive
		 * direction, a fortnight of suppressed upward trigger off a `resets_at`
		 * that may be carried forward. */
		expect(
			reason({
				basis: `- **start basis:** \`.claude\` resets \`${START}\` read 2.0.1h ago`,
			}),
		).toMatch(/staleness for `\.claude` is not a number/);
	});

	it("refuses a declaration with no start basis to check the start against", () => {
		expect(reason({ basis: null })).toMatch(/no `start basis` line/);
	});

	it("refuses a basis entry in the wrong shape, naming the shape it expects", () => {
		expect(
			reason({ basis: "- **start basis:** `.claude` resets soon" }),
		).toMatch(/not `<dir>` resets/);
	});

	it("refuses a declaration with no account to match on", () => {
		expect(reason({ account: null })).toMatch(/no `account` line/);
	});

	it("refuses a declaration with no seat 3 baseline to judge use against", () => {
		expect(reason({ baseline: null })).toMatch(/seat 3 at declaration/);
	});

	it("refuses instants that do not parse as dates", () => {
		expect(
			reason({
				window: "- **measured window:** `tuesday` → `a fortnight later`",
			}),
		).toMatch(/do not parse as dates/);
	});
});

describe("windowPhase", () => {
	const d = readLadder(ladder());

	it("is pending before the measured window opens", () => {
		expect(windowPhase(d, Date.parse("2026-09-05T00:00:00Z"))).toBe("pending");
	});

	it("is live from the start instant, inclusive", () => {
		expect(windowPhase(d, Date.parse(START))).toBe("live");
		expect(windowPhase(d, Date.parse("2026-09-17T00:00:00Z"))).toBe("live");
	});

	it("has ended by the end instant, so the window expires by arithmetic", () => {
		expect(windowPhase(d, Date.parse(END))).toBe("ended");
		expect(windowPhase(d, Date.parse("2027-01-01T00:00:00Z"))).toBe("ended");
	});
});

describe("reading the file", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-window-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const hostWith = (config: string) => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(path.join(dir, ".claude", "workflow-core.json"), config);
		return { root: dir };
	};

	/** Runs `fn` with the host root at `dir` and no `WFC_LADDER` seam, so
	 *  LADDER() resolves through the host config. */
	const atHost = (fn: () => void) => {
		const saved = {
			project: process.env.CLAUDE_PROJECT_DIR,
			ladder: process.env.WFC_LADDER,
		};
		process.env.CLAUDE_PROJECT_DIR = dir;
		delete process.env.WFC_LADDER;
		try {
			fn();
		} finally {
			for (const [k, env] of [
				["project", "CLAUDE_PROJECT_DIR"],
				["ladder", "WFC_LADDER"],
			] as const) {
				if (saved[k] === undefined) delete process.env[env];
				else process.env[env] = saved[k];
			}
		}
	};

	it("opens the ladder at the host's declared capacityLadderPath (#401)", () => {
		hostWith('{"capacityLadderPath": "docs/machinery/ladder.md"}');
		atHost(() =>
			expect(LADDER()).toBe(
				path.join(fs.realpathSync(dir), "docs/machinery/ladder.md"),
			),
		);
	});

	it("opens the default ladder at a rejected capacityLadderPath, and says so once (#406)", () => {
		hostWith('{"capacityLadderPath": "/abs/ladder.md"}');
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			atHost(() => {
				const expected = path.join(
					fs.realpathSync(dir),
					"docs/capacity-procurement-ladder.md",
				);
				expect(LADDER()).toBe(expected);
				expect(LADDER()).toBe(expected);
			});
			expect(write).toHaveBeenCalledTimes(1);
			expect(String(write.mock.calls[0][0])).toContain(
				'"capacityLadderPath" is not a repo-relative path',
			);
		} finally {
			write.mockRestore();
		}
	});

	it('never throws on a missing ladder, but reads it as unreadable rather than as no trial where the host declares `"capacityLadder": true` (mantahostels#2871)', () => {
		/* Distinct from `state: "none"`, which means the ladder WAS read and holds
		 * no declaration section — collapsing the two let an I/O failure sail
		 * past `check-seat-utilisation.js`'s loud not-honoured branch and read as
		 * no trial at all, on a fortnight that cannot be replayed. */
		const d = readTrialWindow(
			path.join(dir, "nope.md"),
			hostWith('{"capacityLadder": true}'),
		);
		expect(d.state).toBe("unreadable");
		expect(d.reason).toMatch(/could not be read/);
	});

	it('reads a missing ladder as no trial where the host declares `"capacityLadder": false`', () => {
		const host = hostWith('{"capacityLadder": false}');
		expect(readTrialWindow(path.join(dir, "nope.md"), host).state).toBe("none");
	});

	it("reads a missing ladder as no trial where the host declares no capacityLadder at all (#735)", () => {
		expect(
			readTrialWindow(path.join(dir, "nope.md"), hostWith("{}")).state,
		).toBe("none");
		expect(
			readTrialWindow(path.join(dir, "nope.md"), { root: dir }).state,
		).toBe("none");
	});

	it("keeps a ladder that exists but cannot be opened unreadable, whatever the host declares", () => {
		const host = hostWith('{"capacityLadder": false}');
		expect(readTrialWindow(dir, host).state).toBe("unreadable");
	});

	it("still reads a ladder that exists where the host declares none", () => {
		const host = hostWith('{"capacityLadder": false}');
		const file = path.join(dir, "ladder.md");
		fs.writeFileSync(file, ladder());
		expect(readTrialWindow(file, host).accountUuid).toBe("acct-3");
	});

	it("never throws on a config that does not parse, reading a missing ladder as no trial (#735)", () => {
		const host = hostWith("{not json");
		expect(readTrialWindow(path.join(dir, "nope.md"), host).state).toBe("none");
	});

	it("reads a declaration off disk", () => {
		const file = path.join(dir, "ladder.md");
		fs.writeFileSync(file, ladder());
		expect(readTrialWindow(file).accountUuid).toBe("acct-3");
	});
});
