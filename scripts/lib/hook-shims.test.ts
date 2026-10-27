// @vitest-environment node
/*
 * hook-shims.js's module cases (#2879), all through `keepShims`. Every port is
 * a fake; keep-hook-shims.test.ts crosses
 * the production ones against a real git repository.
 */

import { describe, expect, it } from "vitest";

const { keepShims } = require("./hook-shims.js");

/** A hooks file naming each script, alternating the two prefix spellings. */
const hooksNaming = (...scripts: string[]) =>
	JSON.stringify({
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: scripts.map((s, i) => ({
						type: "command",
						command:
							i % 2 === 0
								? `command -v node >/dev/null 2>&1 || exit 0; node "$CLAUDE_PROJECT_DIR"/${s}`
								: `\${CLAUDE_PROJECT_DIR}/${s}`,
					})),
				},
			],
		},
	});

interface Listing {
	agents?: { startedAt?: unknown }[];
	why?: string;
}

function fakePorts(o: {
	disk?: Record<string, string>;
	tracked?: string[];
	hooksByRev: Record<string, string>;
	reflog?: { sha: string; at: number }[] | null;
	agents: Listing;
	deleted?: string[] | null;
	exclude?: string;
}) {
	const disk: Record<string, string> = { ...(o.disk ?? {}) };
	const tracked = new Set(o.tracked ?? []);
	const calls = { agents: 0, exclude: o.exclude ?? "", runs: 0 };
	const ports = {
		untracked: () => Object.keys(disk).filter((p) => !tracked.has(p)),
		tracked: () => tracked,
		readFile: (rel: string) => disk[rel] ?? null,
		exists: (rel: string) => rel in disk,
		deletedSinceLastRun: () => (o.deleted === undefined ? [] : o.deleted),
		recordRun: () => {
			calls.runs++;
		},
		reflog: () => (o.reflog === undefined ? REFLOG : o.reflog),
		hooksAt: (shas: string[]) =>
			shas.flatMap((s) => (o.hooksByRev[s] ? [o.hooksByRev[s]] : [])),
		agents: () => {
			calls.agents++;
			return o.agents;
		},
		writeShim: (rel: string, text: string) => {
			disk[rel] = text;
		},
		removeShim: (rel: string) => {
			delete disk[rel];
		},
		readExclude: () => calls.exclude,
		writeExclude: (text: string) => {
			calls.exclude = text;
		},
	};
	return { ports, disk, calls };
}

/* Rev "old" (HEAD from 100) names guard-x.sh; the port landed at 200 as rev
 * "new", which names guard-x.js instead. */
const REFLOG = [
	{ sha: "new", at: 200 },
	{ sha: "old", at: 100 },
];
const PORTED = {
	hooksByRev: {
		old: hooksNaming("scripts/guard-x.sh"),
		new: hooksNaming("scripts/guard-x.js"),
	},
	tracked: ["scripts/guard-x.js"],
	disk: { "scripts/guard-x.js": "real" },
};
const startedAt = (t: number): Listing => ({ agents: [{ startedAt: t }] });

/** PORTED after a run for a session started at 150, which wrote the shim. */
function shimmed(extra: Partial<Parameters<typeof fakePorts>[0]>) {
	const first = fakePorts({ ...PORTED, agents: startedAt(150) });
	keepShims(first.ports);
	return fakePorts({
		...PORTED,
		agents: startedAt(250),
		disk: first.disk,
		exclude: first.calls.exclude,
		...extra,
	});
}

describe("keepShims", () => {
	it("writes an exit-0 shim at a deleted script a live session's start still names", () => {
		const { ports, disk, calls } = fakePorts({
			...PORTED,
			agents: startedAt(150),
			exclude: "*.log\n",
		});
		expect(keepShims(ports)).toEqual({
			wrote: ["scripts/guard-x.sh"],
			removed: [],
			lines: [
				"wrote hook shim scripts/guard-x.sh: a live session still runs its retired line (#2879)",
			],
		});
		expect(disk["scripts/guard-x.sh"]).toMatch(/^#!\/usr\/bin\/env bash\n/);
		expect(disk["scripts/guard-x.sh"]).toMatch(/\nexit 0\n$/);
		expect(calls.exclude).toMatch(
			/^\*\.log\n# .*\n\/scripts\/guard-x\.sh\n# end /,
		);
		expect(calls.runs).toBe(1);
	});

	it("reads both spellings of the project-dir prefix, and shims a .js as node", () => {
		const { ports, disk } = fakePorts({
			hooksByRev: {
				old: hooksNaming("scripts/guard-a.js", "scripts/guard-b.sh"),
				new: "{}",
			},
			agents: startedAt(150),
		});
		expect(keepShims(ports).wrote.sort()).toEqual([
			"scripts/guard-a.js",
			"scripts/guard-b.sh",
		]);
		expect(disk["scripts/guard-a.js"]).toMatch(
			/^\/\/ .*\nprocess\.stdin\.resume\(\);\n$/,
		);
	});

	it("names nothing in a hooks file that will not parse", () => {
		const { ports } = fakePorts({
			hooksByRev: { old: "{not json", new: "{}" },
			agents: startedAt(150),
		});
		expect(keepShims(ports).wrote).toEqual([]);
	});

	it("writes none where every live session started after the port", () => {
		const { ports } = fakePorts({ ...PORTED, agents: startedAt(250) });
		expect(keepShims(ports).wrote).toEqual([]);
	});

	it("writes none where no session is live", () => {
		const { ports } = fakePorts({ ...PORTED, agents: { agents: [] } });
		expect(keepShims(ports).wrote).toEqual([]);
	});

	it("leaves a path still in the index to the commit that deletes it", () => {
		const { ports } = fakePorts({
			...PORTED,
			tracked: [...PORTED.tracked, "scripts/guard-x.sh"],
			agents: startedAt(150),
		});
		expect(keepShims(ports).wrote).toEqual([]);
	});

	it("removes a shim, and its exclude block, once no live session's start names it", () => {
		const { ports, disk, calls } = shimmed({ exclude: undefined });
		calls.exclude = `*.log\n${calls.exclude.replace(/^\*\.log\n/, "")}`;
		expect(keepShims(ports)).toEqual({
			wrote: [],
			removed: ["scripts/guard-x.sh"],
			lines: [
				"removed hook shim scripts/guard-x.sh: no live session runs its line",
			],
		});
		expect(disk).not.toHaveProperty(["scripts/guard-x.sh"]);
		expect(calls.exclude).toBe("*.log\n");
	});

	it("keeps one exclude block however often it runs", () => {
		const { ports, calls } = shimmed({ agents: startedAt(150) });
		keepShims(ports);
		expect(calls.exclude.match(/\/scripts\/guard-x\.sh/g)).toHaveLength(1);
	});

	it("never takes an untracked file whose bytes differ from a shim's for one", () => {
		const { ports, disk } = fakePorts({
			...PORTED,
			disk: {
				...PORTED.disk,
				"scripts/guard-y.sh": "#!/usr/bin/env bash\nexit 0\n",
			},
			agents: startedAt(250),
		});
		expect(keepShims(ports).removed).toEqual([]);
		expect(disk).toHaveProperty(["scripts/guard-y.sh"]);
	});

	it.each([
		["the listing will not read", { why: "oracle down" }, "oracle down"],
		[
			"a record has no start time",
			{ agents: [{ sessionId: "s1" }] },
			"session s1 has no start time",
		],
	])("writes, removes and records nothing where %s", (_, agents, why) => {
		const { ports, disk, calls } = shimmed({ agents: agents as Listing });
		const before = { ...disk };
		calls.runs = 0;
		expect(keepShims(ports)).toEqual({
			wrote: [],
			removed: [],
			lines: [`keep-hook-shims: no shim kept or removed: ${why}`],
			why,
		});
		expect(disk).toEqual(before);
		expect(calls.runs).toBe(0);
	});

	it("writes and removes nothing where the reflog will not read", () => {
		const { ports } = fakePorts({
			...PORTED,
			reflog: null,
			agents: startedAt(150),
		});
		expect(keepShims(ports).why).toBe("no reflog to read");
	});

	it("lazy: returns without the liveness read where nothing was deleted and no shim exists", () => {
		const { ports, calls } = fakePorts({ ...PORTED, agents: startedAt(150) });
		expect(keepShims(ports, { lazy: true })).toEqual({
			wrote: [],
			removed: [],
			lines: [],
		});
		expect(calls.agents).toBe(0);
		expect(calls.runs).toBe(1);
	});

	it.each([
		["a script was deleted since the last run", ["scripts/guard-x.sh"]],
		["no last run is on record", null],
	])("lazy: runs where %s", (_, deleted) => {
		const { ports } = fakePorts({ ...PORTED, deleted, agents: startedAt(150) });
		expect(keepShims(ports, { lazy: true }).wrote).toEqual([
			"scripts/guard-x.sh",
		]);
	});

	it("lazy: runs where a shim exists", () => {
		const { ports, disk } = shimmed({});
		keepShims(ports, { lazy: true });
		expect(disk).not.toHaveProperty(["scripts/guard-x.sh"]);
	});
});
