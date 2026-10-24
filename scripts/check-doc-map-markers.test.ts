// @vitest-environment node
/*
 * Pins that check-doc-map-markers.js finds every ⚠ marker in the doc map — §B
 * entries, Section A register rows and sidecar prose alike (mantahostels#649) —
 * names each where it sits, and ages a dated one to WARN past 14 days and FAIL
 * past 30 while an undated standing hazard never gates.
 *
 * Each case spawns the real script on a map written into its own temp dir, so
 * no case depends on this repo's live doc map.
 *
 * Ages are written relative to the real current date rather than pinned to a
 * fixed one, so no test seam has to exist in the script for a test to move the
 * clock.
 *
 * It runs as a step of .github/workflows/roadmap-digest.yml on every scheduled
 * sweep: loosen a case and an unapplied propagation flag can sit past its
 * month with the sweep still green.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-doc-map-markers.js");

let dir: string;
let mapPath: string;

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/*
 * Fixture dates are reckoned on the WITA clock the script now ages against
 * (mantahostels#919), so `daysAgo(1)` really is one calendar day old whatever hour the
 * suite runs at — under UTC it was two for eight hours a day.
 */
const WITA_OFFSET_MS = 8 * 3_600_000;

/** The WITA calendar day `days` before today, as a Date. */
const witaDate = (days: number) =>
	new Date(Date.now() + WITA_OFFSET_MS - days * 86_400_000);

/** A date `days` before today in WITA, written the way §B writes one. */
const daysAgo = (days: number) => {
	const d = witaDate(days);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** The same day as `daysAgo`, written the way the sidecar writes one. */
const isoDaysAgo = (days: number) => witaDate(days).toISOString().slice(0, 10);

/** The map as the script parses it: `### B<n>` entries under a Section B heading. */
const mapDoc = (...lines: string[]) =>
	[
		"# Doc map",
		"",
		"## Section A — document register",
		"",
		"| `docs/a.md` | a doc | `derived` | Direct | — |",
		"",
		"## Section B — load-bearing figure registry",
		"",
		...lines,
		"",
		"## Section C — question routes",
		"",
		"### C1 · A question",
		"",
	].join("\n");

const registerRow = (marker: string) =>
	`| \`docs/research/x.md\` | a run. ${marker} | \`free-edit\` | Direct | \`docs/b.md\` (#123) |`;

const registerDoc = (register: string[], entries: string[]) =>
	[
		"# Doc map",
		"",
		"## Section A — document register",
		"",
		...register,
		"",
		"## Section B — load-bearing figure registry",
		"",
		...entries,
		"",
	].join("\n");

const write = (body: string) => fs.writeFileSync(mapPath, body);

const run = (...args: string[]) =>
	spawnSync("node", [SCRIPT, mapPath, ...args], { encoding: "utf8" });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "markers-"));
	mapPath = path.join(dir, "doc-map.md");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("finding markers", () => {
	it("reports every marker with the entry it sits on", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Known stale copy:** \`notes/x.md\` L1, at ${daysAgo(1)}.`,
				"",
				"### B2 · Another figure",
				"- **⚠ Collision hazard:** an unrelated 37% lives in `y.md`.",
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("B1");
		expect(r.stderr).toContain("Known stale copy");
		expect(r.stderr).toContain("B2");
		expect(r.stderr).toContain("Collision hazard");
	});

	it("counts two markers on one line separately", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- Prose. ⚠ **First hazard** — and more prose. ⚠ **Second hazard** — end.",
			),
		);

		const r = run("--json");
		const out = JSON.parse(r.stdout);
		expect(out.markers).toHaveLength(2);
		expect(out.markers[0].text).toContain("First hazard");
		expect(out.markers[1].text).toContain("Second hazard");
	});

	it("drops the bold closer left behind when the bold opens before the sign", () => {
		write(mapDoc("### B1 · A figure", "- **⚠ Two traps:** the first one."));

		const r = run("--json");
		expect(JSON.parse(r.stdout).markers[0].text).toBe(
			"Two traps: the first one.",
		);
	});

	it("drops the closer when the bold opened earlier in the line", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- **Applied 6 August 2026 (#171), ⚠ cleared.** `notes/x.md` L14 now reads it.",
			),
		);

		const r = run("--json");
		expect(JSON.parse(r.stdout).markers[0].text).toBe(
			"cleared. `notes/x.md` L14 now reads it.",
		);
	});

	it("ignores a ⚠ named in prose rather than opening a marker", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- #203 proposes retiring both the flag and the ⚠; until it rules, the bar stands.",
			),
		);

		const r = run("--json");
		expect(JSON.parse(r.stdout).markers).toHaveLength(0);
	});

	it("finds markers outside Section B, each located where it sits", () => {
		write(
			[
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				registerRow("**⚠ Superseded.**"),
				"",
				"## Section B — load-bearing figure registry",
				"",
				"**⚠ The preamble's own marker** — describes the convention.",
				"",
				"### B1 · A figure",
				"- **⚠ Collision hazard:** the real one.",
				"",
				"## Section C — question routes",
				"",
				"### C1 · A question",
				"- **⚠ A route's own hazard.**",
			].join("\n"),
		);

		const r = run("--json");
		const out = JSON.parse(r.stdout);
		expect(out.markers.map((m: { where: string }) => m.where)).toEqual([
			"docs/research/x.md",
			"Section B — load-bearing figure registry",
			"B1",
			"C1 · A question",
		]);
	});

	it("names the register row by its path, not by the Section A subheading", () => {
		write(
			registerDoc(
				["### Research runs", registerRow("**⚠ Superseded.** Do not cite.")],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("docs/research/x.md");
	});

	it("reports the whole map, never claiming §B scope", () => {
		write(mapDoc("### B1 · A figure", "- **⚠ Collision hazard.**"));

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("§B");
	});
});

describe("a Section A register-row marker", () => {
	it("is standing when undated, and never gates", () => {
		write(
			registerDoc(
				[registerRow("**⚠ The unit is the stay, not the route node.**")],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const r = run("--json");
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.markers[0].standing).toBe(true);
		expect(out.markers[0].where).toBe("docs/research/x.md");
	});

	it("FAILs when undated and its own text says work is outstanding", () => {
		write(
			registerDoc(
				[registerRow("**⚠ Known stale copy:** the headline still reads $18.")],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("date it");
		expect(r.stderr).toContain("docs/research/x.md");
	});

	it("WARNs past 14 days and FAILs past 30, exactly as a §B marker does", () => {
		const at = (days: number) =>
			registerDoc(
				[registerRow(`**⚠ Unapplied** in 3 files at ${daysAgo(days)}.`)],
				["### B1 · A figure", "- Nothing raised."],
			);

		write(at(20));
		const warned = run();
		expect(warned.status).toBe(0);
		expect(warned.stderr).toContain("WARN:");

		write(at(40));
		const failed = run();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("FAIL:");
	});
});

/* mantahostels#2743 renders `Research runs` as a path list, so a listed file's `role` and
 * `route` prose is in the sidecar and nowhere in the map. The markers inside
 * it would otherwise leave the census the day it stopped being a table. */
describe("a marker in a listed path's sidecar prose", () => {
	const listedDoc = () =>
		[
			"# Doc map",
			"",
			"## Section A — document register",
			"",
			"### Research runs",
			"",
			"<!-- register-list: free-edit -->",
			"- `docs/research/x.md`",
			"<!-- /register-list -->",
			"",
			"## Section B — load-bearing figure registry",
			"",
			"### B1 · A figure",
			"- Nothing raised.",
			"",
		].join("\n");

	const writeClasses = (role: string | null, route: string | null = null) =>
		fs.writeFileSync(
			path.join(dir, "doc-map-classes.json"),
			JSON.stringify({
				"docs/research/x.md": {
					section: "Research runs",
					class: "free-edit",
					classQualifier: null,
					role,
					route,
					consumes: null,
				},
			}),
		);

	it("reports it under its own path, aged as the table row was", () => {
		write(listedDoc());
		writeClasses(
			`**⚠ Unresolved, ${daysAgo(20)}:** the figure is unconfirmed.`,
		);

		const r = run("--json");
		const out = JSON.parse(r.stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("docs/research/x.md");
		expect(out.markers[0].ageDays).toBe(20);
		expect(out.markers[0].standing).toBe(false);
	});

	it("reads the route field too", () => {
		write(listedDoc());
		writeClasses(null, "**⚠ Never retro-edit.**");

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("docs/research/x.md");
	});

	it("runs a marker to the end of the field, there being no cell wall", () => {
		write(listedDoc());
		writeClasses("**⚠ A marker | with a pipe in it.**");

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers[0].text).toContain("with a pipe in it");
	});

	it("adds nothing where the run has no sidecar to read", () => {
		write(listedDoc());

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toEqual([]);
	});

	it("does not report twice where the path is still a table row", () => {
		write(
			registerDoc(
				[registerRow("**⚠ Known stale copy:** the headline still reads $18.")],
				["### B1 · A figure", "- Nothing raised."],
			),
		);
		writeClasses(
			"a run. **⚠ Known stale copy:** the headline still reads $18.",
		);

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
	});
});

describe("what is not a register row", () => {
	it("does not name a table row above Section A by a registered path", () => {
		write(
			[
				"# Doc map",
				"",
				"## Authority classes",
				"",
				"| `docs/research/x.md` | **⚠ A class table, not the register.** |",
				"",
				"## Section A — document register",
				"",
				registerRow("no marker here."),
				"",
				"## Section B — load-bearing figure registry",
				"",
				"### B1 · A figure",
				"- Nothing raised.",
			].join("\n"),
		);

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("Authority classes");
	});

	it("does not name a table row after Section A by a registered path", () => {
		write(
			[
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				registerRow("no marker here."),
				"",
				"## Section B — load-bearing figure registry",
				"",
				"### B1 · A figure",
				"- Nothing raised.",
				"",
				"## Section C — question routes",
				"",
				"### C1 · A question",
				"| `docs/research/x.md` | **⚠ A route table, not the register.** |",
			].join("\n"),
		);

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("C1 · A question");
	});

	it("names a row by the register's own path set, not by path shape", () => {
		write(
			[
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				"| `AGENTS.md` | a doc. **⚠ Superseded.** | `derived` | Direct | — |",
				"",
				"## Section B — load-bearing figure registry",
				"",
				"### B1 · A figure",
				"- Nothing raised.",
			].join("\n"),
		);

		expect(JSON.parse(run("--json").stdout).markers[0].where).toBe("AGENTS.md");
	});

	it("names a row by its first cell, not by a path cited in a later one", () => {
		write(
			[
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				"| `docs/a.md` | a doc | `derived` | Direct | — |",
				"| `docs/b.md` | a doc. **⚠ Superseded.** | `derived` | Direct | `docs/a.md` |",
				"",
				"## Section B — load-bearing figure registry",
				"",
				"### B1 · A figure",
				"- Nothing raised.",
			].join("\n"),
		);

		expect(JSON.parse(run("--json").stdout).markers[0].where).toBe("docs/b.md");
	});

	it("does not name a prose line in Section A by a path it quotes", () => {
		write(
			registerDoc(
				[
					"### Research runs",
					registerRow("no marker here."),
					"",
					"Prose citing `docs/research/x.md`. **⚠ Not a register row.**",
				],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].where).toBe("Research runs");
	});

	it("does not stop a §B marker at a pipe in its own prose", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** — the \`a | b\` split, at ${daysAgo(40)}.`,
			),
		);

		const r = run("--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.stdout).markers[0].standing).toBe(false);
	});

	it("stops a register row's marker at the cell wall", () => {
		write(
			registerDoc(
				[
					`| \`docs/research/x.md\` | a run. **⚠ (standing) Hazard.** | \`free-edit\` | Direct | final ${daysAgo(400)} |`,
				],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const r = run("--json");
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.markers[0].standing).toBe(true);
		expect(out.markers[0].text).toBe("(standing) Hazard.");
	});
});

describe("ageing a dated marker", () => {
	it("passes a marker inside the WARN threshold", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(13)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
	});

	it("WARNs past 14 days without failing, naming the entry and its age", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(20)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN:");
		// Exactly 20 — both sides of the comparison now read the WITA calendar.
		expect(r.stderr).toMatch(/B1\s+20 days/);
	});

	it("FAILs past 30 days, naming the entry and its age", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(40)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FAIL:");
		expect(r.stderr).toMatch(/B1\s+40 days/);
	});

	it("takes the latest date on the marker, not the first", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Ruled ${daysAgo(300)}, still unapplied at ${daysAgo(2)}.**`,
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
	});

	/* A marker may state when it was written and, separately, a date a reader
	 * is told to act on — mantahostels#689's re-measure (mantahostels#1052). */
	it("ages from the latest past date when a later one is an action date", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ One day and one operator, ${daysAgo(3)}.** #766 owns the re-measure, on or after ${daysAgo(-12)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).toMatch(/B1\s+3 days/);
		expect(r.stderr).not.toContain("dated in the future");
	});

	/* Hiding a future date must not hide the staleness of the past one beside
	 * it: the anchor is the latest date that is not in the future, not the
	 * earliest date on the marker. */
	it("still FAILs STALE when the past date beside an action date is old, naming the entry and its age", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(40)}; re-measure on ${daysAgo(-12)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FAIL:");
		expect(r.stderr).toMatch(/B1\s+40 days/);
	});

	/* The typo case — 2027 written for 2026 — has no past date to fall back on,
	 * and is what the FUTURE finding is for. */
	it("FAILs a marker whose every date is in the future", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** at ${daysAgo(-30)}, re-checked ${daysAgo(-12)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("dated in the future");
	});

	it("reads an ISO date as well as a written one", () => {
		const d = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
		write(mapDoc("### B1 · A figure", `- **⚠ Unapplied** as at ${d}.`));

		expect(run().status).toBe(1);
	});

	/* Whole-day ages moved both walls a day later than the fractional UTC ages
	 * they replaced, so the walls are pinned on both sides rather than left to
	 * a fixture that happens to sit well clear of them. */
	it.each([
		[14, 0, "OK:"],
		[15, 0, "WARN:"],
		[30, 0, "WARN:"],
		[31, 1, "FAIL:"],
	])("at %i days old exits %i and reports %s", (days, status, severity) => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(days)}.`,
			),
		);

		const r = run();
		expect(r.status).toBe(status);
		expect(r.stderr).toContain(severity);
		expect(r.stderr).toMatch(new RegExp(`B1\\s+${days} days`));
	});

	it("ages on the WITA clock, so a marker written today is nought days old", () => {
		/* The regression mantahostels#919 filed: between 16:00 and 24:00 UTC the local date is
		 * already tomorrow, so a marker dated off the clock every writer is told to
		 * read was called FUTURE and reddened the build. A written date carries no
		 * hour, so the age is whole days — never a fraction that invents one. */
		write(mapDoc("### B1 · A figure", `- **⚠ Unapplied** at ${daysAgo(0)}.`));

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/\s0 days/);
		// No fractional age anywhere: "0.4 days" would be a UTC-clock reading.
		expect(r.stderr).not.toMatch(/\d\.\d days/);
		expect(r.stderr).not.toContain("dated in the future");
	});

	it("FAILs a marker dated in the future", () => {
		write(mapDoc("### B1 · A figure", `- **⚠ Unapplied** at ${daysAgo(-30)}.`));

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("dated in the future");
	});

	it("ages a standing hazard that states a measurement date", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Collision hazard — do not bulk-replace \`15%\`.** 15 files / 50 hits at ${daysAgo(40)}.`,
			),
		);

		expect(run().status).toBe(1);
	});

	it("ignores a date carrying no year", () => {
		write(
			mapDoc("### B1 · A figure", "- **⚠ Collision hazard** — ruled 2 Aug."),
		);

		const r = run("--json");
		const out = JSON.parse(r.stdout);
		expect(out.markers[0].standing).toBe(true);
	});
});

describe("an undated marker", () => {
	it("is standing, and never gates", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- **⚠ Assumed, never measured.** No study produced it.",
			),
		);

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("standing");
	});

	it("FAILs when its own text says work is outstanding", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- **⚠ Known stale copy:** `notes/x.md` L1 still reads $18.",
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("date it");
	});

	it("names the phrase that put it under the clock", () => {
		write(mapDoc("### B1 · A figure", "- **⚠ Still open:** the manual's §8."));

		const r = run("--json");
		const out = JSON.parse(r.stdout);
		expect(out.findings[0].message).toContain("still open");
	});
});

describe("the checker itself", () => {
	it("is BROKEN on a map it cannot read", () => {
		const r = spawnSync("node", [SCRIPT, path.join(dir, "absent.md")], {
			encoding: "utf8",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
	});

	it("is BROKEN on a file holding no Section B entries", () => {
		write("# Not the map\n\nNothing here.\n");
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
	});

	it("passes on a Section B heading with no ### B<n> entries under it (#52)", () => {
		write(mapDoc("None registered."));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("BROKEN:");
	});

	it("is BROKEN on a Section B heading that does not parse as ### B<n> (#52)", () => {
		write(mapDoc("### Bx · A malformed figure", "- prose"));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("does not parse");
	});

	it("caps a FAIL to WARN under --warn", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Unapplied** in 3 files at ${daysAgo(40)}.`,
			),
		);

		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN:");
	});
});

/*
 * A date is not always a confirmation stamp (mantahostels#1357): a marker may state one as a
 * fact — a supersession, a corpus bound — which no work can ever clear.
 */
describe("a date the marker states rather than confirms", () => {
	const classedRow = (marker: string, cls: string) =>
		`| \`docs/research/x.md\` | a run. ${marker} | \`${cls}\` | Never | \`docs/b.md\` (#123) |`;

	it("ages a stale-dated marker on a register row", () => {
		write(
			registerDoc(
				[
					classedRow(
						`**⚠ Superseded ${daysAgo(400)} by the round-2 note.**`,
						"free-edit",
					),
				],
				["### B1 · A figure", "- Nothing raised."],
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("STALE");
		expect(r.stderr).toContain("docs/research/x.md");
		expect(r.stderr).toContain("(standing)");
	});

	it("does not age a §B marker tagged (standing)", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ (standing) Corrected ${daysAgo(400)} by #985:** two machines, not one.`,
			),
		);

		const r = run("--json");
		expect(r.status).toBe(0);
		const marker = JSON.parse(r.stdout).markers[0];
		expect(marker.standing).toBe(true);
		expect(marker.permanent).toBe("tagged (standing)");
	});

	it("reads the tag through the emphasis wrapped round it", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Corrected ${daysAgo(400)} by #985** *(Standing)* — two machines.`,
			),
		);

		const marker = JSON.parse(run("--json").stdout).markers[0];
		expect(marker.permanent).toBe("tagged (standing)");
		expect(marker.at).not.toBeNull();
	});

	it("does not take a bare 'standing' in the prose as the tag", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ A standing hazard, dated ${daysAgo(400)}:** the collision is permanent.`,
			),
		);

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("STALE");
		expect(r.stderr).toContain("B1");
		expect(r.stderr).toContain("(standing)");
	});

	it("refuses the tag to a marker whose own text says work is outstanding", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ (standing) Unapplied** in 3 files at ${daysAgo(40)}.`,
			),
		);

		expect(JSON.parse(run("--json").stdout).markers[0].permanent).toBeNull();

		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("STALE");
		expect(r.stderr).toContain("B1");
		expect(r.stderr).toContain("work is outstanding");
	});

	it.each([
		["Restated-in is known incomplete", "known incomplete"],
		["Unresolved, and the SKB may not survive", "unresolved"],
		["Unverified: nobody has re-run the scan", "unverified"],
	])(
		"refuses the tag to the outstanding shape %s, which OUTSTANDING alone misses, so it fails as STALE",
		(text) => {
			write(
				mapDoc(
					"### B1 · A figure",
					`- **⚠ (standing) ${text}** — written ${daysAgo(40)}.`,
				),
			);

			expect(JSON.parse(run("--json").stdout).markers[0].permanent).toBeNull();

			const r = run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("STALE");
		},
	);

	it("names both escapes in the STALE finding itself, not only the footer", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ A superseded reading, dated ${daysAgo(40)}.**`,
			),
		);

		const finding = JSON.parse(run("--json").stdout).findings[0];
		expect(finding.tag).toBe("STALE");
		expect(finding.message).toContain("(standing)");
		expect(finding.message).toContain("re-confirm");
	});

	it("teaches both escapes in the closing report", () => {
		write(mapDoc("### B1 · A figure", "- **⚠ Collision hazard.**"));

		const r = run();
		expect(r.stderr).toContain("(standing)");
		expect(r.stderr).toContain("re-confirmed");
	});
});

/*
 * The same fact — a §B entry's Restated-in list being known incomplete — is
 * written twice while mantahostels#1450's migration runs: as a dated ⚠ marker in the map's
 * prose, and as `knownIncomplete` in docs/doc-map-restatements.json. Both age on
 * the same 14/30 thresholds, and the pair never reports twice (mantahostels#1471).
 */
describe("a sidecar knownIncomplete date", () => {
	/** Writes the restatement sidecar the checker reads beside the map. */
	const sidecar = (entries: Record<string, unknown>) =>
		fs.writeFileSync(
			path.join(dir, "doc-map-restatements.json"),
			JSON.stringify(entries),
		);

	/** A sidecar entry whose Restated-in list was known incomplete on `iso`. */
	const known = (iso: string) => ({
		paths: [{ path: "docs/a.md" }],
		knownIncomplete: iso,
	});

	it("passes a sidecar date inside the WARN threshold", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		sidecar({ B1: known(isoDaysAgo(13)) });

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).toMatch(/B1\s+13 days/);
	});

	it("WARNs past 14 days without failing, naming the entry and its age", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		sidecar({ B1: known(isoDaysAgo(20)) });

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN:");
		expect(r.stderr).toMatch(/B1\s+20 days/);
	});

	it("FAILs past 30 days, naming the entry and the field to re-date", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		sidecar({ B1: known(isoDaysAgo(40)) });

		const r = run();
		expect(r.status).toBe(1);
		const finding = JSON.parse(run("--json").stdout).findings[0];
		expect(finding.tag).toBe("STALE");
		expect(finding.message).toContain("B1");
		expect(finding.message).toContain("knownIncomplete");
		expect(finding.message).toContain("doc-map-restatements.json");
	});

	it("FAILs a sidecar date in the future, as FUTURE, naming the entry and the date", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		sidecar({ B1: known(isoDaysAgo(-3)) });

		const r = run("--json");
		expect(r.status).toBe(1);
		const finding = JSON.parse(r.stdout).findings[0];
		expect(finding.tag).toBe("FUTURE");
		expect(finding.message).toContain("B1");
		expect(finding.message).toContain(isoDaysAgo(-3));
	});

	it("ages from the sidecar where its date is the older of the two", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Restated-in is known incomplete** — re-confirmed ${daysAgo(2)}.`,
			),
		);
		sidecar({ B1: known(isoDaysAgo(40)) });

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].ageDays).toBe(40);
		expect(out.markers[0].dateFrom).toBe("sidecar");
		expect(out.findings[0].tag).toBe("STALE");
		expect(out.findings[0].message).toContain("knownIncomplete");
	});

	it("leaves a sidecar date no older than the prose marker's to it", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Restated-in is known incomplete** — written ${daysAgo(40)}.`,
			),
		);
		sidecar({ B1: known(isoDaysAgo(2)) });

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].ageDays).toBe(40);
		expect(out.markers[0].dateFrom).toBe("prose");
		expect(out.findings[0].message).toContain("appending today's date");
	});

	it("reports the sidecar date once, not twice, beside a dated prose marker", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Restated-in is known incomplete** — written at settling time, ${daysAgo(20)}.`,
			),
		);
		sidecar({ B1: known(isoDaysAgo(20)) });

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].dateFrom).toBe("prose");
		expect(out.findings).toHaveLength(1);
	});

	it("gives an undated prose marker the date its sidecar carries", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- **⚠ Restated-in is known incomplete** — the bullet carries no date.",
			),
		);
		sidecar({ B1: known(isoDaysAgo(40)) });

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(1);
		expect(out.markers[0].standing).toBe(false);
		expect(out.markers[0].ageDays).toBe(40);
		expect(out.findings.map((f: { tag: string }) => f.tag)).toEqual(["STALE"]);
		// The row is prose; the date is not, so the remedy names the field.
		expect(out.findings[0].message).toContain("knownIncomplete");
	});

	it("ages a marker of any other kind on that entry independently", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				"- **⚠ Collision hazard:** an unrelated 37% lives in `y.md`.",
			),
		);
		sidecar({ B1: known(isoDaysAgo(40)) });

		const out = JSON.parse(run("--json").stdout);
		expect(out.markers).toHaveLength(2);
		expect(out.markers[1].dateFrom).toBe("sidecar");
	});

	it("ignores an entry carrying no knownIncomplete", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		sidecar({ B1: { paths: [{ path: "docs/a.md" }] } });

		const r = run("--json");
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).markers).toHaveLength(0);
	});

	it("says so when no sidecar sits beside the map, rather than passing silently", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));

		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).toContain(
			`no doc-map-restatements.json beside ${mapPath}`,
		);
	});

	it("says what it read from the sidecar even when nothing it read spoke", () => {
		write(
			mapDoc(
				"### B1 · A figure",
				`- **⚠ Restated-in is known incomplete** — written at settling time, ${daysAgo(2)}.`,
			),
		);
		sidecar({ B1: known(isoDaysAgo(2)) });

		expect(run().stderr).toContain(
			"1 knownIncomplete date(s) in doc-map-restatements.json: 1 left to an entry's own no-older marker",
		);
	});

	it("is BROKEN on a sidecar it cannot parse, naming the file", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		fs.writeFileSync(path.join(dir, "doc-map-restatements.json"), "{ not json");

		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("restatement sidecar unreadable");
		expect(r.stderr).toContain("doc-map-restatements.json");
	});

	it("reads the sidecar from --data-dir when it is given one", () => {
		write(mapDoc("### B1 · A figure", "- The figure."));
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "markers-data-"));
		fs.writeFileSync(
			path.join(elsewhere, "doc-map-restatements.json"),
			JSON.stringify({ B1: known(isoDaysAgo(40)) }),
		);

		const r = run("--data-dir", elsewhere, "--json");
		expect(r.status).toBe(1);
		const finding = JSON.parse(r.stdout).findings[0];
		expect(finding.tag).toBe("STALE");
		expect(finding.message).toContain("B1");
		expect(finding.message).toContain("knownIncomplete");
		fs.rmSync(elsewhere, { recursive: true, force: true });
	});
});
