// @vitest-environment node
/*
 * lib/divergence-row.js, record-divergence.js's core (#2797), in process:
 * which Bash calls are a refused pull or a rejected push, which repo and ref
 * the divergence is counted in, and the row's exact text. The ports are plain
 * values (base §G7 (5)); the real git, ps, clock and filesystem are crossed
 * once each by record-divergence.test.ts's boundary set.
 *
 * Loosen a case and the refusal counts #289 rests on go wrong or silent, and
 * any reconcile recipe (#290) is aimed at a cause the record misstates.
 */

import { describe, expect, it } from "vitest";

interface Row {
	dir: string;
	file: string;
	line: string;
}
interface Ports {
	disabled: boolean;
	pwd: string;
	isDir: (p: string) => boolean;
	toplevel: (dir: string) => string | null;
	commonDir: (dir: string) => string | null;
	pushedRef: (top: string) => string;
	refExists: (top: string, ref: string) => boolean;
	upstream: (top: string) => string | null;
	counts: (top: string, ref: string) => string | null;
	sessions: () => number | null;
	now: () => Date;
	projectDir: (top: string) => string;
}

const { divergenceRow } = require("./divergence-row.js") as {
	divergenceRow: (payload: unknown, ports: Ports) => Row | null;
};

/** A repo the fake git answers for: its counts against each ref it has. */
interface Repo {
	top: string;
	common?: string;
	refs: Record<string, string>;
	upstream?: string;
}

const WORK = "/w/work";
const NOW = new Date("2026-10-25T01:02:03.987Z");

/**
 * Ports over `repos`, keyed by every directory git answers in. A directory
 * absent from the map is no repository; `dirs` adds plain directories; the
 * pushed ref is `origin/main` unless `pushed` says otherwise.
 */
function ports(
	repos: Record<string, Repo>,
	over: Partial<Ports> & { dirs?: string[]; pushed?: string } = {},
): Ports {
	const dirs = new Set([...Object.keys(repos), ...(over.dirs ?? [])]);
	const at = (dir: string) => repos[dir];
	const byTop = (top: string) =>
		Object.values(repos).find((r) => r.top === top);
	return {
		disabled: false,
		pwd: "/hook",
		isDir: (p) => dirs.has(p) || p === "/hook",
		toplevel: (dir) => at(dir)?.top ?? null,
		commonDir: (dir) => {
			const r = at(dir);
			return r ? (r.common ?? `${r.top}/.git`) : null;
		},
		pushedRef: () => over.pushed ?? "origin/main",
		refExists: (top, ref) => ref in (byTop(top)?.refs ?? {}),
		upstream: (top) => byTop(top)?.upstream ?? null,
		counts: (top, ref) => byTop(top)?.refs[ref] ?? null,
		sessions: () => 4,
		now: () => NOW,
		projectDir: (top) => `/cfg${top}`,
		...over,
	};
}

/** One repo at WORK, `ahead`/`behind` against origin/main. */
const repoAt = (ahead: number, behind: number, top = WORK) => ({
	[top]: { top, refs: { "origin/main": `${ahead}\t${behind}` } },
});

const FF_REFUSAL = {
	stdout: "",
	stderr: "fatal: Not possible to fast-forward, aborting.",
};
const PUSH_REJECT = {
	stdout: "",
	stderr:
		"! [rejected]        main -> main (fetch first)\nUpdates were rejected because the remote contains work",
};

/** A Bash payload; `cwd` defaults to WORK. */
const payload = (
	command: string,
	response: unknown = FF_REFUSAL,
	cwd: unknown = WORK,
) => ({
	tool_name: "Bash",
	cwd,
	tool_input: { command },
	tool_response: response,
});

const fields = (row: Row | null) => {
	expect(row).not.toBeNull();
	expect(row?.line.endsWith("\n")).toBe(true);
	return (row?.line ?? "").slice(0, -1).split("\t");
};

describe("divergenceRow", () => {
	it("records a refused ff-only pull with the divergence that caused it", () => {
		const row = divergenceRow(
			payload("git pull --ff-only"),
			ports(repoAt(2, 3)),
		);
		expect(row).toEqual({
			dir: "/cfg/w/work",
			file: "/cfg/w/work/divergence.log",
			line: "2026-10-25T01:02:03.000Z\twork\tpull\t2\t3\tdiverged\t4\torigin/main\tNot possible to fast-forward\n",
		});
	});

	it("records nothing when switched off", () => {
		expect(
			divergenceRow(
				payload("git pull --ff-only"),
				ports(repoAt(2, 3), { disabled: true }),
			),
		).toBeNull();
	});

	it("calls a session with no commits of its own `behind`, not `diverged`", () => {
		const row = divergenceRow(
			payload("git pull --ff-only"),
			ports(repoAt(0, 2)),
		);
		expect(fields(row).slice(2, 6)).toEqual(["pull", "0", "2", "behind"]);
	});

	it("reads a tree with nothing either side as `level`", () => {
		const row = divergenceRow(
			payload("git pull --ff-only"),
			ports(repoAt(0, 0)),
		);
		expect(fields(row).slice(3, 6)).toEqual(["0", "0", "level"]);
	});

	it("records a rejected push, whose behind count is a lower bound", () => {
		const row = divergenceRow(
			payload("git push origin main", PUSH_REJECT),
			ports(repoAt(1, 0)),
		);
		expect(fields(row).slice(2, 6)).toEqual(["push", "1", "0", "ahead"]);
	});

	it("names the first refusal string in probe order, not the first in the text", () => {
		const row = divergenceRow(
			payload("git push origin main", PUSH_REJECT),
			ports(repoAt(1, 0)),
		);
		expect(fields(row)[8]).toBe("Updates were rejected because");
	});

	for (const marker of [
		"Not possible to fast-forward",
		"Need to specify how to reconcile divergent branches",
		"Updates were rejected because",
		"non-fast-forward",
		"! [rejected]",
		"fetch first",
	])
		it(`records git's "${marker}" on its own`, () => {
			const row = divergenceRow(
				payload("git pull", { stderr: `hint: ${marker}.` }),
				ports(repoAt(1, 1)),
			);
			expect(fields(row)[8]).toBe(marker);
		});

	it("reads git's subcommand past its global options", () => {
		const row = divergenceRow(
			payload(`git -c core.pager=cat -C ${WORK} pull --ff-only`),
			ports(repoAt(1, 1)),
		);
		expect(fields(row)[2]).toBe("pull");
	});

	it("files a `git -C` refusal under the repo it was refused in", () => {
		// Level, so a row misfiled here would read `level` — a state at which a
		// fast-forward cannot be refused at all.
		const repos = { ...repoAt(0, 0), ...repoAt(2, 3, "/w/elsewhere") };
		const row = divergenceRow(
			payload("git -C /w/elsewhere pull --ff-only"),
			ports(repos),
		);
		expect(fields(row).slice(1, 6)).toEqual([
			"elsewhere",
			"pull",
			"2",
			"3",
			"diverged",
		]);
		expect(row?.dir).toBe("/cfg/w/elsewhere");
	});

	it("resolves a relative `-C` against the command's own cwd", () => {
		const row = divergenceRow(
			payload("git -C relative-target pull --ff-only", FF_REFUSAL, "/w"),
			ports(repoAt(2, 1, "/w/relative-target"), { dirs: ["/w"] }),
		);
		expect(fields(row).slice(1, 5)).toEqual([
			"relative-target",
			"pull",
			"2",
			"1",
		]);
	});

	it("composes repeated `-C`, as git does", () => {
		// `hop/../nested` reaches the repo only if the two compose: a walker
		// taking the first `-C` lands in `hop`, one taking the last in
		// `../nested`, and neither is a repository.
		const row = divergenceRow(
			payload("git -C hop -C ../nested pull --ff-only", FF_REFUSAL, "/w"),
			ports(
				{
					"/w/hop/../nested": {
						top: "/w/nested",
						refs: { "origin/main": "1\t2" },
					},
				},
				{ dirs: ["/w", "/w/hop"] },
			),
		);
		expect(fields(row).slice(1, 5)).toEqual(["nested", "pull", "1", "2"]);
	});

	it("drops the row where the `-C` path does not resolve", () => {
		// #289 counts refusals per repo. Filing this under the session's own
		// repo would invent an observation there and hide one wherever it
		// really happened; the count is a lower bound instead.
		const p = ports(repoAt(1, 1));
		expect(
			divergenceRow(payload("git -C $WORKTREE pull --ff-only"), p),
		).toBeNull();
		expect(divergenceRow(payload("git -C ~/x pull --ff-only"), p)).toBeNull();
		expect(
			divergenceRow(payload("git -C /no/such pull --ff-only"), p),
		).toBeNull();
	});

	it("follows a `cd` before the git call to the repo it moves to", () => {
		const repos = { ...repoAt(0, 0), ...repoAt(2, 3, "/w/elsewhere") };
		const row = divergenceRow(
			payload("git fetch && cd /w/elsewhere && git pull --ff-only"),
			ports(repos),
		);
		expect(fields(row)[1]).toBe("elsewhere");
	});

	it("follows a quoted `-C` path, spaces and all", () => {
		const row = divergenceRow(
			payload('git -C "/w/a b" pull --ff-only'),
			ports(repoAt(1, 1, "/w/a b")),
		);
		expect(fields(row)[1]).toBe("a b");
	});

	it("finds a pull in a later segment of a compound command", () => {
		const row = divergenceRow(
			payload("git fetch origin && git pull --ff-only"),
			ports(repoAt(1, 1)),
		);
		expect(fields(row)[2]).toBe("pull");
	});

	it("records a pull after an empty segment", () => {
		const row = divergenceRow(
			payload("true; ( ); git pull --ff-only"),
			ports(repoAt(1, 1)),
		);
		expect(fields(row)[2]).toBe("pull");
	});

	it("records the first pull or push of several", () => {
		const row = divergenceRow(
			payload("git push origin main || git pull --ff-only", PUSH_REJECT),
			ports(repoAt(1, 1)),
		);
		expect(fields(row)[2]).toBe("push");
	});

	it("drops the row where the first pull's tree will not resolve, though a later one's would", () => {
		const row = divergenceRow(
			payload("git -C $W pull --ff-only; git pull --ff-only"),
			ports(repoAt(1, 1)),
		);
		expect(row).toBeNull();
	});

	it("finds no git call inside a quoted commit message, where the bash split found one (#2797)", () => {
		// The bash recorder's split was not quote-aware; the shared parser is.
		const row = divergenceRow(
			payload('git commit -m "a && git pull" && true'),
			ports(repoAt(1, 1)),
		);
		expect(row).toBeNull();
	});

	it("still finds a pull after a commit whose message holds `&&`", () => {
		const row = divergenceRow(
			payload('git commit -m "a && b" && git pull --ff-only'),
			ports(repoAt(1, 1)),
		);
		expect(fields(row)[2]).toBe("pull");
	});

	for (const [why, command, response] of [
		[
			"a pull that succeeded",
			"git pull --ff-only",
			{ stdout: "Already up to date." },
		],
		[
			"another subcommand entirely",
			"git status",
			{ stdout: "nothing to commit" },
		],
		[
			"a command that only mentions a pull",
			'grep -rn "git pull" docs',
			{ stdout: "Not possible to fast-forward" },
		],
		[
			"a config key whose value reads like a subcommand",
			"git -c alias.x=pull status",
			{ stdout: "Not possible to fast-forward" },
		],
		["an empty trailing segment, #2388", "ls; ", FF_REFUSAL],
		["a blank line between commands", "echo a\n\necho b", FF_REFUSAL],
		["a quoted subcommand", 'git "pull"', FF_REFUSAL],
	] as const) {
		it(`writes nothing for ${why}`, () => {
			expect(
				divergenceRow(payload(command, response), ports(repoAt(1, 1))),
			).toBeNull();
		});
	}

	it("writes nothing for a payload that is not a Bash call", () => {
		const p = ports(repoAt(1, 1));
		expect(divergenceRow(null, p)).toBeNull();
		expect(divergenceRow([payload("git pull")], p)).toBeNull();
		expect(divergenceRow("git pull", p)).toBeNull();
		expect(
			divergenceRow({ ...payload("git pull"), tool_name: "Write" }, p),
		).toBeNull();
		expect(divergenceRow(payload(""), p)).toBeNull();
		expect(
			divergenceRow({ ...payload("x"), tool_input: "git pull" }, p),
		).toBeNull();
	});

	it("reads tool_output ahead of tool_response, and the whole payload where neither is set", () => {
		const p = ports(repoAt(1, 1));
		const { tool_response: _, ...base } = payload("git pull --ff-only");
		expect(
			divergenceRow(
				{
					...base,
					tool_output: "Already up to date.",
					tool_response: FF_REFUSAL,
				},
				p,
			),
		).toBeNull();
		expect(
			divergenceRow(
				{ ...base, tool_output: null, tool_response: FF_REFUSAL },
				p,
			),
		).not.toBeNull();
		expect(
			divergenceRow(
				{ ...base, tool_output: false, tool_response: "non-fast-forward" },
				p,
			),
		).not.toBeNull();
		expect(
			fields(divergenceRow({ ...base, note: "! [rejected] x" }, p))[8],
		).toBe("! [rejected]");
	});

	it("reads a response that is not a string as compact JSON", () => {
		// `"a":"fetch first"` has no space after the colon only where it is
		// compact; the marker is the string inside, matched either way, so this
		// pins that a non-string response is read at all.
		const row = divergenceRow(
			payload("git push", { lines: ["x", "fetch first"] }),
			ports(repoAt(1, 0)),
		);
		expect(fields(row)[8]).toBe("fetch first");
	});

	it("falls back to the hook's own directory where the payload's cwd is no directory", () => {
		const p = ports(repoAt(1, 1, "/hook"));
		expect(
			fields(divergenceRow(payload("git pull", FF_REFUSAL, "/gone"), p))[1],
		).toBe("hook");
		expect(
			fields(divergenceRow(payload("git pull", FF_REFUSAL, 7), p))[1],
		).toBe("hook");
	});

	it("drops the row where git finds no top level", () => {
		expect(
			divergenceRow(payload("git pull"), ports({}, { dirs: [WORK] })),
		).toBeNull();
	});

	it("names the repository, not the worktree it was refused in", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports({
				[WORK]: {
					top: "/w/throwaway",
					common: "/w/mainline/.git",
					refs: { "origin/main": "1\t1" },
				},
			}),
		);
		expect(fields(row)[1]).toBe("mainline");
	});

	it("names the top level where git gives no common dir", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports(repoAt(1, 1), { commonDir: () => null }),
		);
		expect(fields(row)[1]).toBe("work");
	});

	it("counts against the pushed ref lib/landing-refs.js names (#2408)", () => {
		const repos = {
			[WORK]: {
				top: WORK,
				refs: { "origin/landing": "1\t0", "origin/main": "5\t5" },
			},
		};
		const row = divergenceRow(
			payload("git push origin main:landing", PUSH_REJECT),
			ports(repos, { pushed: "origin/landing" }),
		);
		expect(fields(row).slice(3, 8)).toEqual([
			"1",
			"0",
			"ahead",
			"4",
			"origin/landing",
		]);
	});

	it("counts against the upstream where the pushed ref does not exist", () => {
		const repos = {
			[WORK]: {
				top: WORK,
				refs: { "origin/trunk": "0\t1" },
				upstream: "origin/trunk",
			},
		};
		const row = divergenceRow(payload("git pull"), ports(repos));
		expect(fields(row).slice(3, 8)).toEqual([
			"0",
			"1",
			"behind",
			"4",
			"origin/trunk",
		]);
	});

	it("records `unknown` rather than nothing where there is no ref to count against", () => {
		const row = divergenceRow(
			payload("git pull --ff-only"),
			ports({ [WORK]: { top: WORK, refs: {} } }),
		);
		expect(fields(row).slice(3, 8)).toEqual(["-", "-", "unknown", "4", "-"]);
	});

	it("reads counts split by any blank, not a tab alone", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports({ [WORK]: { top: WORK, refs: { "origin/main": "2 3" } } }),
		);
		expect(fields(row).slice(3, 6)).toEqual(["2", "3", "diverged"]);
	});

	it("records `unknown` where the counts will not read", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports({ [WORK]: { top: WORK, refs: { "origin/main": "x y" } } }),
		);
		expect(fields(row).slice(3, 6)).toEqual(["-", "-", "unknown"]);
		expect(fields(row)[7]).toBe("origin/main");
	});

	it("records sessions as `-` where they will not count, and still writes the row", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports(repoAt(1, 1), { sessions: () => null }),
		);
		expect(fields(row)[6]).toBe("-");
		expect(
			fields(
				divergenceRow(
					payload("git pull"),
					ports(repoAt(1, 1), { sessions: () => 0 }),
				),
			)[6],
		).toBe("0");
	});

	it("collapses a tab or newline in the repo or ref to a space", () => {
		const row = divergenceRow(
			payload("git pull"),
			ports(
				{
					[WORK]: {
						top: WORK,
						common: "/w/a\tb\nc/.git",
						refs: { "origin/x\ry": "1\t1" },
					},
				},
				{ pushed: "origin/x\ry" },
			),
		);
		expect(fields(row)).toHaveLength(9);
		expect(fields(row)[1]).toBe("a b c");
		expect(fields(row)[7]).toBe("origin/x y");
	});
});
