// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const {
	registeredGuards,
	subjectsFor,
	registryDrift,
} = require("./lib/guard-fires.js");
const { readRunningHooks } = require("./lib/core-hooks.js");
// code-edges loads: ../self-plugin/hooks/hooks.json
// code-edges loads: ../hooks/hooks.json
const { rows, scan, parseSince } = require("./count-guard-fires.js");

const ROOT = path.resolve(__dirname, "..");
const needles = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "scripts", "guard-fire-needles.json"),
		"utf8",
	),
);
const settings = { hooks: readRunningHooks(ROOT) };

const registeredKeys = [
	...new Set(registeredGuards(settings).map((r: { key: string }) => r.key)),
];

const { needleDrift } = require("./lib/needle-corpus.js");
const { readManifest } = require("./lib/guard-cores.js");
const {
	emissionMatches,
	RULE_ARG_RE,
} = require("./lib/rule-emission-calls.js");

describe("the guard set is derived from the core's registration", () => {
	it("gives every registered hook an entry, so a new hook cannot arrive uncounted", () => {
		expect(registryDrift(needles, settings).unkeyed).toEqual([]);
	});

	it("registers no entry for a hook the core does not run", () => {
		expect(registryDrift(needles, settings).stale).toEqual([]);
	});

	it("names a hook wired with no entry, rather than counting it as zero", () => {
		const withNewHook = {
			hooks: {
				...settings.hooks,
				PreToolUse: [
					...settings.hooks.PreToolUse,
					{
						matcher: "Bash",
						hooks: [
							{ command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-brand-new.sh' },
						],
					},
				],
			},
		};
		expect(registryDrift(needles, withNewHook).unkeyed).toEqual([
			"guard-brand-new.sh",
		]);
	});

	it("scans every keyed guard and every candidate", () => {
		const subjects = subjectsFor(needles, settings);
		const ids = subjects.map((s: { id: string }) => s.id);
		const keyed = registeredKeys.filter(
			(k) => needles.guards[k as string].needles.length,
		);
		for (const k of keyed) expect(ids).toContain(`guard:${k}`);
		for (const c of Object.keys(needles.candidates))
			if (needles.candidates[c].needles.length > 0)
				expect(ids).toContain(`cand:${c}`);
	});

	it("refuses the cli route on guards and allows it on candidates", () => {
		const subjects = subjectsFor(needles, settings);
		for (const s of subjects) {
			if (s.id.startsWith("guard:")) expect(s.routes).toEqual(["hook", "deny"]);
			else expect(s.routes).toBeUndefined();
		}
	});

	it("names an entry with no needles as silent rather than leaving it blank", () => {
		for (const [key, entry] of Object.entries<{
			needles: unknown[];
			silent?: string;
		}>(needles.guards)) {
			if (entry.needles.length > 0) continue;
			expect(
				entry.silent,
				`${key} has no needles and no silent note`,
			).toBeTruthy();
		}
	});
});

function readInjectedRuleIds(): [string, string][] {
	const out: [string, string][] = [];
	const manifest = readManifest(
		path.join(ROOT, "scripts", "lib", "guard-cores.json"),
	) as Record<string, { core: string }[]>;
	for (const { core } of Object.values(manifest).flat()) {
		const src = fs.readFileSync(
			path.join(ROOT, "scripts", "lib", core),
			"utf8",
		);
		for (const m of emissionMatches(src))
			for (const [, id] of (m[1] as string).matchAll(RULE_ARG_RE))
				out.push(["guard-dispatch.js", id as string]);
	}
	return out;
}

function needleForInjectedRule(
	file: string,
	id: string,
): { id: string; kind?: string } | undefined {
	const fragment = fs.readFileSync(
		path.join(ROOT, "docs", "agents", "rules", `${id}.txt`),
		"utf8",
	);
	const entry = needles.guards[file];
	return (entry?.needles ?? []).find(
		(n: { text: string | string[] }) =>
			typeof n.text === "string" && fragment.includes(n.text),
	);
}

describe("every rule a guard injects has a needle of its own", () => {
	const injected = readInjectedRuleIds();

	it("finds the injections at all, so a green run is not an empty list", () => {
		expect(injected.length).toBeGreaterThan(15);
	});

	it.each(injected)("%s injects %s, and a needle matches it", (file, id) => {
		expect(needles.guards[file], `${file} has no registry entry`).toBeTruthy();
		expect(
			needleForInjectedRule(file, id),
			`no needle under ${file} matches any text in ${id}.txt`,
		).toBeTruthy();
	});

	it.each(injected)('%s\'s needle for %s is kind "inject"', (file, id) => {
		expect(
			needleForInjectedRule(file, id)?.kind,
			`${file}'s needle for ${id}`,
		).toBe("inject");
	});
});

describe("every needle's kind is one of the defined values", () => {
	const knownKinds = new Set(["deny", "warn", "notice", "block", "inject"]);
	const all: [string, string, string][] = [];
	for (const [key, entry] of Object.entries<{
		needles?: Array<{ id: string; kind?: string }>;
	}>(needles.guards))
		for (const n of entry.needles ?? [])
			all.push([key, n.id, n.kind as string]);

	it("finds a needle count consistent with the registry, so a green run is not vacuous", () => {
		expect(all.length).toBeGreaterThan(100);
	});

	it.each(all)("%s/%s's kind %s is a defined value", (_key, _id, kind) => {
		expect(knownKinds.has(kind), kind).toBe(true);
	});
});

describe("a needle's routes", () => {
	it("names only routes its subject already allows", () => {
		for (const subject of subjectsFor(needles, settings))
			for (const n of subject.needles) {
				if (!n.routes) continue;
				expect(
					n.routes.length,
					`${subject.id}/${n.id} has empty routes`,
				).toBeGreaterThan(0);
				for (const r of n.routes)
					expect(subject.routes, `${subject.id}/${n.id}`).toContain(r);
			}
	});
});

describe("a needle's core", () => {
	it("names a core the dispatcher runs, on every dispatcher needle", () => {
		const names = new Set(
			Object.values<Array<{ name: string }>>(
				readManifest(path.join(ROOT, "scripts", "lib", "guard-cores.json")),
			)
				.flat()
				.map((r) => r.name),
		);
		const dispatcher = needles.guards["guard-dispatch.js"].needles;
		expect(dispatcher.length).toBeGreaterThan(0);
		for (const n of dispatcher)
			expect(names.has(n.core), `guard-dispatch.js/${n.id}`).toBe(true);
	});

	it("is carried by no needle of a guard other than the dispatcher", () => {
		for (const [key, entry] of Object.entries<{
			needles?: Array<{ id: string; core?: string }>;
		}>(needles.guards))
			if (key !== "guard-dispatch.js")
				for (const n of entry.needles ?? [])
					expect(n.core, `${key}/${n.id}`).toBeUndefined();
	});
});

describe("every needle is text this repo still prints", () => {
	it("leaves no needle keyed on text the tree does not print", () => {
		const registry = path.join("scripts", "guard-fire-needles.json");
		const { broken, failOpen } = needleDrift({
			root: ROOT,
			landing: [registry],
			readHead: (rel: string) => (rel === registry ? "{}" : null),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});
});

describe("the CLI, run as a command", () => {
	const cliPath = path.join(ROOT, "scripts", "count-guard-fires.js");

	const run = (args: string[], host?: string) => {
		const r = runInProcess(cliPath, args, {
			cwd: host ?? ROOT,
			env: { ...process.env, CLAUDE_PROJECT_DIR: host ?? ROOT },
		});
		return { out: r.stdout, err: r.stderr, code: r.status };
	};

	let corpus: string;
	beforeEach(() => {
		corpus = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fires-"));
	});
	afterEach(() => {
		fs.rmSync(corpus, { recursive: true, force: true });
	});

	const withCommitDeny = () =>
		fs.writeFileSync(
			path.join(corpus, "s1.jsonl"),
			`${JSON.stringify({
				type: "user",
				uuid: "u1",
				timestamp: "2026-08-17T13:22:14.026Z",
				message: {
					content: [
						{
							type: "tool_result",
							is_error: true,
							content:
								'This commit form sweeps in every dirty tracked file: git commit -am "wip"',
						},
					],
				},
			})}\n`,
		);

	it("refuses a --dir with no path after it, rather than reading the cwd", () => {
		const { err, code } = run(["--dir"]);
		expect(code).toBe(2);
		expect(err).toContain("--dir needs a value");
	});

	it("says an unreadable corpus out loud instead of printing zeroes", () => {
		const { err, code } = run(["--dir", path.join(corpus, "nope")]);
		expect(code).toBe(2);
		expect(err).toContain("Cannot read transcripts in");
	});

	it("reports every keyed guard as never fired against an empty corpus", () => {
		const { out, code } = run(["--dir", corpus]);
		expect(code).toBe(0);
		expect(out).toContain("CORPUS  0 transcripts");
		expect(out).toContain("FIRED (0)");
		expect(out).toContain("guard-dispatch.js");
		expect(out).toContain("may be a guard working by deterrence");
	});

	it("counts a real deny out of a transcript and names its date", () => {
		withCommitDeny();
		const { out } = run(["--dir", corpus]);
		expect(out).toContain("1         1  2026-08-17  guard-dispatch.js");
		expect(out).toContain("sweeps-dirty 1");
	});

	it("counts the settings canary's refusal under its own subject (#2473)", () => {
		fs.writeFileSync(
			path.join(corpus, "s1.jsonl"),
			`${JSON.stringify({
				type: "user",
				uuid: "u1",
				timestamp: "2026-10-22T09:00:00.000Z",
				message: {
					content: [
						{
							type: "tool_result",
							is_error: true,
							content:
								'PreToolUse:Bash hook error: ["$CLAUDE_PROJECT_DIR"/scripts/self-plugin-canary.sh]: Refused: the wfc-self self-plugin did not load in this session, so none of workflow-core\'s guards are running here.',
						},
					],
				},
			})}\n`,
		);
		const { out } = run(["--dir", corpus]);
		expect(out).toContain("1         1  2026-10-22  self-plugin-canary.sh");
		expect(out).toContain("self-plugin-not-loaded 1");
	});

	describe("in an adopter whose hooks come from the plugin", () => {
		let host: string;
		beforeEach(() => {
			host = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fires-host-"));
			fs.mkdirSync(path.join(host, ".claude"));
			fs.writeFileSync(
				path.join(host, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-brand-new.sh',
									},
								],
							},
						],
					},
				}),
			);
		});
		afterEach(() => {
			fs.rmSync(host, { recursive: true, force: true });
		});

		it("counts a hook registered only in hooks.json", () => {
			withCommitDeny();
			const { out, code } = run(["--dir", corpus], host);
			expect(code).toBe(0);
			expect(out).toContain("1         1  2026-08-17  guard-dispatch.js");
		});

		it("names the file an unkeyed hook is registered in", () => {
			const { err, code } = run(["--dir", corpus], host);
			expect(code).toBe(0);
			expect(err).toContain(
				`guard-brand-new.sh is registered in ${path.join(host, ".claude", "settings.json")} with no entry`,
			);
		});

		describe("with a needles file of its own", () => {
			const hostNeedles = () =>
				path.join(host, ".claude", "guard-fire-needles.json");
			const writeHostNeedles = (body: Record<string, unknown>) =>
				fs.writeFileSync(hostNeedles(), JSON.stringify(body));
			const pageRead = {
				needles: [
					{
						id: "page-read",
						kind: "warn",
						text: "agents read the markdown source, never its page",
					},
				],
			};
			beforeEach(() => {
				fs.writeFileSync(
					path.join(host, ".claude", "settings.json"),
					JSON.stringify({
						hooks: {
							PreToolUse: [
								{
									matcher: "Read",
									hooks: [
										{
											command:
												'"$CLAUDE_PROJECT_DIR"/scripts/guard-page-read.sh',
										},
									],
								},
							],
						},
					}),
				);
			});

			it("counts a guard keyed only there, merged with the core's", () => {
				writeHostNeedles({ guards: { "guard-page-read.sh": pageRead } });
				withCommitDeny();
				const { out, err, code } = run(["--dir", corpus], host);
				expect(code).toBe(0);
				expect(err).not.toContain("guard-page-read.sh is registered");
				const never = out.slice(out.indexOf("NEVER FIRED"));
				expect(never.slice(0, never.indexOf("SILENT BY DESIGN"))).toContain(
					"guard-page-read.sh",
				);
				expect(out).toContain("1         1  2026-08-17  guard-dispatch.js");
			});

			it("tells an unkeyed host-only guard to go in the host file", () => {
				const { err, code } = run(["--dir", corpus], host);
				expect(code).toBe(0);
				expect(err).toContain(
					`guard-page-read.sh is registered in ${path.join(host, ".claude", "settings.json")} with no entry in ${hostNeedles()}`,
				);
			});

			it("reports a host key nothing registers as stale", () => {
				writeHostNeedles({
					guards: { "guard-page-read.sh": pageRead, "guard-gone.sh": pageRead },
				});
				const { err, code } = run(["--dir", corpus], host);
				expect(code).toBe(0);
				expect(err).toContain(
					`guard-gone.sh has an entry in ${hostNeedles()} but no hook file here registers it`,
				);
				expect(err).toContain("Remove the entry, or register the hook.");
			});

			it("refuses a key the core already owns, naming it", () => {
				writeHostNeedles({
					guards: {
						"guard-page-read.sh": pageRead,
						"guard-dispatch.js": pageRead,
					},
				});
				const { out, err, code } = run(["--dir", corpus], host);
				expect(code).toBe(2);
				expect(err).toContain("guard-dispatch.js is keyed in both");
				expect(err).toContain("so remove it from the host file");
				expect(out).not.toContain("FIRED");
			});

			it("refuses anything but guards, naming the extra key and saying to remove it, rather than dropping it unread", () => {
				writeHostNeedles({ guards: {}, candidates: {} });
				const { err, code } = run(["--dir", corpus], host);
				expect(code).toBe(2);
				expect(err).toContain("carries candidates");
				expect(err).toContain("so remove the rest.");
			});

			it("refuses a guards that is not an object, rather than merging it", () => {
				writeHostNeedles({ guards: ["guard-page-read.sh"] });
				const { err, code } = run(["--dir", corpus], host);
				expect(code).toBe(2);
				expect(err).toContain("carries a `guards` that is not an object");
			});

			it("reads an absent host file as no host needles, silently", () => {
				expect(fs.existsSync(hostNeedles())).toBe(false);
				withCommitDeny();
				const { out, err, code } = run(["--dir", corpus], host);
				expect(code).toBe(0);
				expect(err).not.toContain("guard-fire-needles.json is absent");
				expect(out).toContain("1         1  2026-08-17  guard-dispatch.js");
			});
		});

		it("still counts the plugin's hooks where the host has no settings at all", () => {
			fs.rmSync(path.join(host, ".claude", "settings.json"));
			withCommitDeny();
			const { out, err, code } = run(["--dir", corpus], host);
			expect(code).toBe(0);
			expect(err).toContain(
				`${path.join(host, ".claude", "settings.json")} is absent`,
			);
			expect(out).toContain("guard-dispatch.js");
		});
	});

	const withBranchDenyAndInjection = () => {
		const fragment = "THE SHARED WORKING TREE STAYS ON `main`.";
		fs.writeFileSync(
			path.join(corpus, "s2.jsonl"),
			`${JSON.stringify({
				type: "user",
				uuid: "u1",
				timestamp: "2026-08-07T09:00:00.000Z",
				message: {
					content: [
						{
							type: "tool_result",
							is_error: true,
							content: `This moves the shared working tree off its branch: git checkout x\n\n${fragment}\n`,
						},
					],
				},
			})}\n${JSON.stringify({
				type: "attachment",
				uuid: "a1",
				timestamp: "2026-08-29T09:00:00.000Z",
				attachment: {
					type: "hook_additional_context",
					toolUseID: "toolu_02",
					content: [`${fragment}\n\nNever \`git checkout\` it.`],
				},
			})}\n`,
		);
	};

	it("counts the injected rule as well as the deny, and dates them apart", () => {
		withBranchDenyAndInjection();
		const { out } = run(["--dir", corpus]);
		expect(out).toContain("2026-08-29  guard-dispatch.js");
		expect(out).toContain("branch-move 1 across 1 session(s) (2026-08-07)");
		expect(out).toContain(
			"branch-shared-tree 1 across 1 session(s) (2026-08-29)",
		);
	});

	it("does not count the deny's reprint of the fragment as a second fire", () => {
		withBranchDenyAndInjection();
		const { out } = run(["--dir", corpus]);
		const row = out
			.split("\n")
			.find((l: string) => l.includes("guard-dispatch.js"));
		expect(row).toMatch(/^\s+2\s+1\s+2026-08-29\s+guard-dispatch\.js/);
	});

	it("keys the byNeedle session count by needle, distinct from the guard's own SESSIONS column", () => {
		withBranchDenyAndInjection();
		const fragment = "THE SHARED WORKING TREE STAYS ON `main`.";
		fs.writeFileSync(
			path.join(corpus, "s3.jsonl"),
			`${JSON.stringify({
				type: "attachment",
				uuid: "a2",
				timestamp: "2026-08-30T09:00:00.000Z",
				attachment: {
					type: "hook_additional_context",
					toolUseID: "toolu_03",
					content: [`${fragment}\n\nNever \`git checkout\` it.`],
				},
			})}\n`,
		);
		const { out } = run(["--dir", corpus]);
		const row = out
			.split("\n")
			.find((l: string) => l.includes("guard-dispatch.js"));
		expect(row).toMatch(/^\s+3\s+2\s+2026-08-30\s+guard-dispatch\.js/);
		expect(out).toContain("branch-move 1 across 1 session(s) (2026-08-07)");
		expect(out).toContain(
			"branch-shared-tree 2 across 2 session(s) (2026-08-30)",
		);
	});

	it("reproduces mantahostels#2119's '10 fires across 10 sessions' for branch-shared-tree off the report alone", () => {
		const fragment = "THE SHARED WORKING TREE STAYS ON `main`.";
		for (let i = 0; i < 10; i++) {
			fs.writeFileSync(
				path.join(corpus, `ten-${i}.jsonl`),
				`${JSON.stringify({
					type: "attachment",
					uuid: `a-${i}`,
					timestamp: `2026-08-${10 + i}T09:00:00.000Z`,
					attachment: {
						type: "hook_additional_context",
						toolUseID: `toolu-${i}`,
						content: [`${fragment}\n\nNever \`git checkout\` it.`],
					},
				})}\n`,
			);
		}
		const { out } = run(["--dir", corpus]);
		expect(out).toContain("branch-shared-tree 10 across 10 session(s)");
	});

	it("leads the candidate table with the one the registry flags", () => {
		const { out } = run(["--dir", corpus]);
		const first = out.slice(out.indexOf("PROVEN   +CLI")).split("\n")[1];
		expect(first).toContain("C4ii");
	});

	it("emits parseable JSON under --json, carrying the corpus it read", () => {
		withCommitDeny();
		const { out, code } = run(["--dir", corpus, "--json"]);
		expect(code).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.corpus).toMatchObject({ dirs: [corpus], transcripts: 1 });
		const dispatch = parsed.guards.find(
			(g: { key: string }) => g.key === "guard-dispatch.js",
		);
		expect(dispatch).toMatchObject({ total: 1, byRoute: { deny: 1 } });
	});

	it("counts mentions separately under --mentions, so the ratio is reproducible", () => {
		fs.writeFileSync(
			path.join(corpus, "s2.jsonl"),
			`${JSON.stringify({
				type: "user",
				uuid: "u2",
				toolUseResult: {
					stdout:
						"return 'This commit form sweeps in every dirty tracked file' + why;",
				},
			})}\n`,
		);
		const { out } = run(["--dir", corpus, "--mentions"]);
		expect(out).toContain("MENTIONS");
		expect(out).toContain(
			"guard-dispatch.js  [PreToolUse:Bash|Write|Edit|NotebookEdit|Skill|Read|Glob|ListAgents|Agent|Task, PostToolUse:Bash|Read|Write|Edit|NotebookEdit|WebFetch|WebSearch]  (1 mention(s))",
		);
	});

	describe("the --since window", () => {
		const withDenyAt = (name: string, ts: string | null) =>
			fs.writeFileSync(
				path.join(corpus, name),
				`${JSON.stringify({
					type: "user",
					uuid: name,
					...(ts ? { timestamp: ts } : {}),
					message: {
						content: [
							{
								type: "tool_result",
								is_error: true,
								content:
									'This commit form sweeps in every dirty tracked file: git commit -am "wip"',
							},
						],
					},
				})}\n`,
			);

		it("keeps a fire on or after the boundary and drops one before it", () => {
			withDenyAt("before.jsonl", "2026-08-17T13:00:00.000Z");
			withDenyAt("edge.jsonl", "2026-08-22T00:00:00.000Z");
			withDenyAt("after.jsonl", "2026-09-01T00:00:00.000Z");
			const { out, code } = run(["--dir", corpus, "--since", "2026-08-22"]);
			expect(code).toBe(0);
			expect(out).toContain("2         2  2026-09-01  guard-dispatch.js");
		});

		it("excludes an undated fire from the window and reports it, not as a zero", () => {
			withDenyAt("undated.jsonl", null);
			const { out, code } = run(["--dir", corpus, "--since", "2026-08-22"]);
			expect(code).toBe(0);
			expect(out).toContain("FIRED (0)");
			expect(out).toContain("0  guard-dispatch.js");
			expect(out).toContain(
				"1 fire(s) carry no timestamp and cannot be placed in or out of the",
			);
		});

		it("names which subject the undated fire belongs to, not just a corpus-wide count", () => {
			withDenyAt("undated.jsonl", null);
			const { out } = run(["--dir", corpus, "--since", "2026-08-22"]);
			expect(out).toContain(
				"0  guard-dispatch.js  [PreToolUse:Bash|Write|Edit|NotebookEdit|Skill|Read|Glob|ListAgents|Agent|Task, PostToolUse:Bash|Read|Write|Edit|NotebookEdit|WebFetch|WebSearch]  (1 undated fire(s) excluded)",
			);
		});

		it("applies the same window to --mentions", () => {
			fs.writeFileSync(
				path.join(corpus, "mention-old.jsonl"),
				`${JSON.stringify({
					type: "user",
					uuid: "old",
					timestamp: "2026-08-17T13:00:00.000Z",
					toolUseResult: {
						stdout:
							"return 'This commit form sweeps in every dirty tracked file' + why;",
					},
				})}\n`,
			);
			fs.writeFileSync(
				path.join(corpus, "mention-new.jsonl"),
				`${JSON.stringify({
					type: "user",
					uuid: "new",
					timestamp: "2026-09-01T00:00:00.000Z",
					toolUseResult: {
						stdout:
							"return 'This commit form sweeps in every dirty tracked file' + why;",
					},
				})}\n`,
			);
			const { out } = run([
				"--dir",
				corpus,
				"--mentions",
				"--since",
				"2026-08-22",
			]);
			expect(out).toContain(
				"guard-dispatch.js  [PreToolUse:Bash|Write|Edit|NotebookEdit|Skill|Read|Glob|ListAgents|Agent|Task, PostToolUse:Bash|Read|Write|Edit|NotebookEdit|WebFetch|WebSearch]  (1 mention(s))",
			);
		});

		it("excludes an undated mention from the window and reports it under --mentions", () => {
			fs.writeFileSync(
				path.join(corpus, "mention-undated.jsonl"),
				`${JSON.stringify({
					type: "user",
					uuid: "undated",
					toolUseResult: {
						stdout:
							"return 'This commit form sweeps in every dirty tracked file' + why;",
					},
				})}\n`,
			);
			const { out } = run([
				"--dir",
				corpus,
				"--mentions",
				"--since",
				"2026-08-22",
			]);
			expect(out).not.toContain("(1 mention(s))");
			expect(out).toContain(
				"1 mention(s) carry no timestamp and are excluded the same way.",
			);
		});

		it("carries the window and the undated counts in --json", () => {
			withDenyAt("undated.jsonl", null);
			withDenyAt("dated.jsonl", "2026-09-01T00:00:00.000Z");
			const { out, code } = run([
				"--dir",
				corpus,
				"--since",
				"2026-08-22",
				"--json",
			]);
			expect(code).toBe(0);
			const parsed = JSON.parse(out);
			expect(parsed.corpus).toMatchObject({
				since: "2026-08-22T00:00:00.000Z",
				undatedFires: 1,
				undatedMentions: 0,
			});
			const dispatch = parsed.guards.find(
				(g: { key: string }) => g.key === "guard-dispatch.js",
			);
			expect(dispatch).toMatchObject({ total: 1 });
		});

		it("refuses a --since with nothing after it", () => {
			const { err, code } = run(["--dir", corpus, "--since"]);
			expect(code).toBe(2);
			expect(err).toContain("--since needs a value");
		});

		it("refuses a spelling it cannot confidently place, rather than sorting it wrong", () => {
			const { err, code } = run([
				"--dir",
				corpus,
				"--since",
				"2026-08-22 12:00:00",
			]);
			expect(code).toBe(2);
			expect(err).toContain("--since needs an ISO date");
		});

		it("refuses a non-UTC offset, naming --since, rather than reading it as UTC", () => {
			const { err, code } = run([
				"--dir",
				corpus,
				"--since",
				"2026-08-22T00:00:00+07:00",
			]);
			expect(code).toBe(2);
			expect(err).toContain("--since must be UTC");
		});
	});
});

describe("parseSince", () => {
	it("normalises a bare date to midnight UTC", () => {
		expect(parseSince("2026-08-22")).toEqual({
			ok: true,
			since: "2026-08-22T00:00:00.000Z",
		});
	});

	it("accepts the corpus's own timestamp shape unchanged", () => {
		expect(parseSince("2026-08-22T13:04:05.123Z")).toEqual({
			ok: true,
			since: "2026-08-22T13:04:05.123Z",
		});
	});

	it("pads a short fractional-second spelling rather than misreading its magnitude", () => {
		expect(parseSince("2026-08-22T00:00:00.5Z")).toEqual({
			ok: true,
			since: "2026-08-22T00:00:00.500Z",
		});
	});

	it("accepts a +00:00 offset as the same thing as Z", () => {
		expect(parseSince("2026-08-22T00:00:00+00:00")).toEqual({
			ok: true,
			since: "2026-08-22T00:00:00.000Z",
		});
	});

	it("refuses a non-UTC offset instead of reading it as UTC, naming --since", () => {
		const r = parseSince("2026-08-22T00:00:00+07:00");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("--since must be UTC");
	});

	it("refuses a date that does not exist rather than rolling it forward", () => {
		const r = parseSince("2026-02-30");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("not a real date/time");
	});

	it("refuses a space-separated spelling", () => {
		const r = parseSince("2026-08-22 12:00:00");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("--since needs an ISO date");
	});

	it("refuses basic-format and week-date spellings rather than sorting them wrong", () => {
		expect(parseSince("20260822").ok).toBe(false);
		expect(parseSince("2026-W35-1").ok).toBe(false);
	});
});

describe("readNeedles", () => {
	const { hostNeedlesFile, readNeedles } = require("./lib/guard-fires.js");
	const coreKey = Object.keys(needles.guards)[0];
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-needles-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	const hostHolding = (host: object) => {
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(hostNeedlesFile(root), JSON.stringify(host));
		return readNeedles(root);
	};

	it("folds the host's guards into the core's, keeping the core's candidates", () => {
		const {
			needles: merged,
			hostKeys,
			clashes,
			extra,
		} = hostHolding({ guards: { "b.sh": { needles: [] } } });
		expect(Object.keys(merged.guards)).toEqual([
			...Object.keys(needles.guards),
			"b.sh",
		]);
		expect(merged.candidates).toEqual(needles.candidates);
		expect(hostKeys).toEqual(["b.sh"]);
		expect(clashes).toEqual([]);
		expect(extra).toEqual([]);
	});

	it("returns the core unchanged where there is no host file", () => {
		const { needles: merged, hostKeys, clashes, extra } = readNeedles(root);
		expect(merged).toEqual(needles);
		expect([hostKeys, clashes, extra]).toEqual([[], [], []]);
	});

	it("names a key both files carry as a clash", () => {
		expect(
			hostHolding({ guards: { [coreKey]: { needles: [] } } }).clashes,
		).toEqual([coreKey]);
	});
});

describe("rows", () => {
	const scanned = {
		rolled: new Map(),
		mentions: new Map(),
		sessions: new Map(),
		unreadable: [],
	};

	it("leads with the flagged candidate even when the registry lists it last", () => {
		const registry = {
			guards: {},
			candidates: {
				C1: { span: "first in file", needles: [{ id: "n", text: "x" }] },
				C4ii: {
					span: "flagged",
					leads: true,
					needles: [{ id: "n", text: "y" }],
				},
			},
		};
		const { candidates } = rows(registry, { hooks: {} }, scanned);
		expect(candidates.map((c: { id: string }) => c.id)).toEqual(["C4ii", "C1"]);
	});

	const narrowed = {
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{ command: "$CLAUDE_PROJECT_DIR/scripts/g.sh", if: "Bash(*cat *)" },
						{ command: "$CLAUDE_PROJECT_DIR/scripts/g.sh", if: "Bash(*sed *)" },
					],
				},
				{
					matcher: "Read",
					hooks: [{ command: "$CLAUDE_PROJECT_DIR/scripts/g.sh" }],
				},
			],
		},
	};

	it("names each narrowing, so a multiply-registered guard reads as distinct rows", () => {
		const { guards } = rows({ guards: {} }, narrowed, scanned);
		expect(guards).toHaveLength(1);
		expect(guards[0].events).toEqual([
			"PreToolUse:Bash if Bash(*cat *)",
			"PreToolUse:Bash if Bash(*sed *)",
			"PreToolUse:Read",
		]);
	});

	it("collapses two registrations that differ in nothing a reader can see", () => {
		const twice = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{
								command: "$CLAUDE_PROJECT_DIR/scripts/g.sh",
								if: "Bash(*cat *)",
							},
							{
								command: "$CLAUDE_PROJECT_DIR/scripts/g.sh",
								if: "Bash(*cat *)",
							},
						],
					},
				],
			},
		};
		const { guards } = rows({ guards: {} }, twice, scanned);
		expect(guards[0].events).toEqual(["PreToolUse:Bash if Bash(*cat *)"]);
	});
});

describe("scan", () => {
	let corpus: string;
	beforeEach(() => {
		corpus = fs.mkdtempSync(path.join(os.tmpdir(), "guard-fires-scan-"));
	});
	afterEach(() => {
		fs.rmSync(corpus, { recursive: true, force: true });
	});

	it("names a transcript it could not open, rather than passing over it", () => {
		const shut = path.join(corpus, "shut.jsonl");
		fs.writeFileSync(shut, "{}\n");
		fs.chmodSync(shut, 0o000);
		const result = scan([{ file: shut, tier: "main" }], [], false);
		expect(result.unreadable).toEqual([shut]);
		fs.chmodSync(shut, 0o600);
	});
});
