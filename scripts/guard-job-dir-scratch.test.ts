// @vitest-environment node
/*
 * guard-job-dir-scratch.sh answers one question about a tool call: does it WRITE
 * session scratch under the harness's per-job directory? A file straight into
 * the job's own `tmp/` is refused; every other job-dir write is warned (#1139).
 *
 * THE SPELLINGS ARE THE POINT. The background-job preamble prints both the
 * variable and the path it resolved to, so a session pastes either — and the
 * unexpanded form must be caught even where the hook's environment lacks the
 * variable to expand it. Each is pinned below; do not thin them out.
 *
 * THE SILENT CASES ARE THE FALSE-POSITIVE SURFACE. A READ of the job directory
 * is how a session reads its own background job's output and must stay silent,
 * which is why the Bash limb walks redirect targets and not the command string.
 *
 * The guard reads no git and touches no repo, so unlike its sibling each case
 * needs only a temporary config directory to latch into.
 *
 * It runs on every Bash, `Write`, `Edit` and `NotebookEdit` call as a
 * `PreToolUse` hook (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`):
 * loosen a spelling and session scratch lands in a directory the harness owns;
 * widen the Bash limb and a session is nagged for reading its own job's output.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";
import { guardOutput, spawnGuard } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-job-dir-scratch.sh");

/* The shape the third predicate limb keys on, for the case where the hook
 * environment did not carry CLAUDE_JOB_DIR at all. */
const JOB_DIR = "/home/someone/.claude2/jobs/8d029a78";

let dir: string;
let config: string;
let session = 0;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-dir-scratch-"));
	config = path.join(dir, "config");
	fs.mkdirSync(config, { recursive: true });
	session += 1;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Verdict {
	kind: "deny" | "warn";
	text: string;
}

interface Payload {
	tool: string;
	command?: string;
	filePath?: string;
	notebookPath?: string;
}

interface Opts {
	jobDir?: string;
	sid?: string;
	home?: string;
}

function run(p: Payload, { jobDir, sid, home }: Opts = {}): Verdict | null {
	const out = guardOutput(
		GUARD,
		{
			session_id: sid ?? `s${session}`,
			tool_name: p.tool,
			tool_input: {
				...(p.command === undefined ? {} : { command: p.command }),
				...(p.filePath === undefined ? {} : { file_path: p.filePath }),
				...(p.notebookPath === undefined
					? {}
					: { notebook_path: p.notebookPath }),
			},
		},
		{
			project: dir,
			config,
			cwd: dir,
			env: {
				/* Unset where left off, not inherited: this session really runs
				 * under a job dir, and inheriting it would silently satisfy the
				 * limb a case means to exclude. */
				CLAUDE_JOB_DIR: jobDir,
				...(home === undefined ? {} : { HOME: home }),
			},
		},
	);
	if (!out) return null;
	if (out.permissionDecision === "deny")
		return { kind: "deny", text: out.permissionDecisionReason };
	return { kind: "warn", text: out.additionalContext };
}

const bash = (command: string, o?: Opts) => run({ tool: "Bash", command }, o);

const refused = (v: Verdict | null) => {
	expect(v?.kind).toBe("deny");
	return v?.text ?? "";
};

const warned = (v: Verdict | null) => {
	expect(v?.kind).toBe("warn");
	return v?.text ?? "";
};

describe("a Bash redirect straight into the job's tmp folder", () => {
	it.each([
		["gh issue view 1 > $CLAUDE_JOB_DIR/tmp/x.out", "the bare variable"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["gh issue view 1 > ${CLAUDE_JOB_DIR}/tmp/x.out", "a braced expansion"],
		['echo hi > "$CLAUDE_JOB_DIR/tmp/x.out"', "a double-quoted span"],
		["echo hi >> $CLAUDE_JOB_DIR/tmp/x.out", "the append form"],
		["echo hi >$CLAUDE_JOB_DIR/tmp/x.out", "glued to the operator"],
		["node x.js 2> $CLAUDE_JOB_DIR/tmp/x.err", "a leading file descriptor"],
		[
			"for c in a b; do node x.js > $CLAUDE_JOB_DIR/tmp/$c.out; done",
			"loop-wrapped, which the flattener still reaches",
		],
	])("refuses %s — %s, offering .claude/tmp/ instead", (command) => {
		expect(refused(bash(command))).toContain(".claude/tmp/");
	});

	it("refuses the expanded absolute path against the live variable, offering .claude/tmp/ instead", () => {
		expect(
			refused(bash(`echo hi > ${JOB_DIR}/tmp/x.out`, { jobDir: JOB_DIR })),
		).toContain(".claude/tmp/");
	});

	it("refuses the `~/.claude*/jobs/<id>/tmp/` spelling", () => {
		expect(
			refused(
				bash("echo x > ~/.claude2/jobs/abc/tmp/a.md", { home: "/home/u" }),
			),
		).toContain("lands at /home/u/.claude2/jobs/abc/tmp/a.md");
	});

	/* ISOLATES THE LIVE-VARIABLE LIMB. JOB_DIR above also matches the shape
	 * fallback below, so a mutation of this limb alone survives against it — a
	 * job directory the harness put somewhere else is the only case that fails
	 * when it goes. */
	it("refuses in a job directory that only the live variable can identify", () => {
		const odd = "/var/opt/harness-scratch/run-91";
		expect(
			refused(bash(`echo hi > ${odd}/tmp/x.out`, { jobDir: odd })),
		).toContain(".claude/tmp/");
	});

	it("refuses the expanded path with CLAUDE_JOB_DIR unset, on the shape alone, offering .claude/tmp/ instead", () => {
		expect(refused(bash(`echo hi > ${JOB_DIR}/tmp/x.out`))).toContain(
			".claude/tmp/",
		);
	});

	it("quotes the target back, and the sanctioned spelling of it", () => {
		const r = refused(bash("echo hi > $CLAUDE_JOB_DIR/tmp/x.out"));
		expect(r).toContain("$CLAUDE_JOB_DIR/tmp/x.out");
		expect(r).toMatch(/sanctioned target: \S*\/\.claude\/tmp\/x\.out/);
	});

	it("names the subfolder a fixture or child-session directory goes in", () => {
		expect(refused(bash("echo hi > $CLAUDE_JOB_DIR/tmp/x.out"))).toContain(
			"`<job dir>/tmp/<name>/<file>`",
		);
	});

	it("refuses a command that also writes a nested job-dir path, naming the unnested path it refuses", () => {
		expect(
			refused(
				bash(
					"echo a > $CLAUDE_JOB_DIR/tmp/fx/a.out; echo b > $CLAUDE_JOB_DIR/tmp/b.out",
				),
			),
		).toContain("$CLAUDE_JOB_DIR/tmp/b.out");
	});

	/* NOT LATCHED: a latched deny would allow every stray after the first
	 * (mantahostels#2436). */
	it("refuses every time in one session", () => {
		for (const f of ["a", "b", "c"])
			refused(bash(`echo hi > $CLAUDE_JOB_DIR/tmp/${f}.out`, { sid: "one" }));
	});
});

describe("a write elsewhere under the job directory", () => {
	it.each([
		["echo hi > $CLAUDE_JOB_DIR/tmp/fx/a.out", "a subfolder of tmp/"],
		[`echo hi > ${JOB_DIR}/tmp/band-3/a.md`, "a subfolder, expanded"],
		["echo hi > $CLAUDE_JOB_DIR/notes.md", "outside tmp/"],
		["echo hi > $CLAUDE_JOB_DIR/tmp", "the tmp folder itself"],
	])("warns on %s — %s, offering .claude/tmp/ instead", (command) => {
		expect(warned(bash(command))).toContain(".claude/tmp/");
	});
});

/* Every write spelling lib/guard-parse.sh's gp_write_targets reads is judged as
 * the `>` beside it is: one verdict kind, one quoted target. */
describe("a write by any spelling the shared reader reads (#1827)", () => {
	const spellings: [string, (t: string) => string][] = [
		["tee", (t) => `gh issue view 1 | tee ${t}`],
		["tee appending", (t) => `gh issue view 1 | tee -a ${t}`],
		["a cp destination", (t) => `cp /tmp/a ${t}`],
		["an mv destination", (t) => `mv /tmp/a ${t}`],
		["an in-place sed", (t) => `sed -i s/a/b/ ${t}`],
		["a heredoc's redirect", (t) => `cat > ${t} <<'EOF'\nbody\nEOF`],
		["a heredoc's redirect after it", (t) => `cat <<'EOF' > ${t}\nbody\nEOF`],
		["tee fed by a heredoc", (t) => `tee ${t} <<'EOF'\nbody\nEOF`],
	];
	const targets = [
		"$CLAUDE_JOB_DIR/tmp/x.out",
		"$CLAUDE_JOB_DIR/tmp/fx/a.out",
		`${JOB_DIR}/notes.md`,
	];
	it.each(
		spellings.flatMap(([name, spell]) =>
			targets.map((t) => [name, t, spell(t)] as const),
		),
	)("judges %s into %s as a redirect there: %s", (_name, target, command) => {
		const redirect = bash(`echo hi > ${target}`, { sid: "redirect" });
		const v = bash(command, { sid: "spelling" });
		expect(redirect).not.toBeNull();
		expect(v?.kind).toBe(redirect?.kind);
		expect(v?.text).toBe(redirect?.text);
	});

	it("refuses a cp into the tmp folder named with a trailing slash, naming the file it lands as", () => {
		const r = refused(bash("cp /tmp/a.md $CLAUDE_JOB_DIR/tmp/"));
		expect(r).toContain("$CLAUDE_JOB_DIR/tmp/a.md");
		expect(r).not.toContain("//");
	});

	it("refuses a cp into the tmp folder by its bare name where that folder exists", () => {
		const job = path.join(dir, "jobs", "abc");
		fs.mkdirSync(path.join(job, "tmp"), { recursive: true });
		expect(
			refused(bash("cp /tmp/a.md $CLAUDE_JOB_DIR/tmp", { jobDir: job })),
		).toContain(`lands at ${job}/tmp/a.md`);
	});

	it.each([
		["cp $HOME/a.md $CLAUDE_JOB_DIR/tmp/", "a source behind a variable"],
		['cp "$F" $CLAUDE_JOB_DIR/tmp/', "a source it cannot read at all"],
		["cp /tmp/a /tmp/b $CLAUDE_JOB_DIR/tmp", "two sources, no trailing slash"],
	])("refuses %s — %s", (command) => {
		expect(refused(bash(command))).toContain(".claude/tmp/");
	});

	it("refuses a cp -t into the tmp folder", () => {
		expect(
			refused(bash("cp -t $CLAUDE_JOB_DIR/tmp /tmp/a.md", { jobDir: JOB_DIR })),
		).toContain(`lands at ${JOB_DIR}/tmp/a.md`);
	});

	it.each([
		["mv $CLAUDE_JOB_DIR/tmp/x.out .claude/tmp/", "an mv OUT of the job dir"],
		["cp $CLAUDE_JOB_DIR/tasks/x.output .claude/tmp/y", "a cp out of it"],
		["rm $CLAUDE_JOB_DIR/tmp/x.out", "a deletion"],
		["tee .claude/tmp/y < $CLAUDE_JOB_DIR/tasks/x.output", "a tee reading it"],
	])("is silent on %s — %s", (command) => {
		expect(bash(command)).toBeNull();
	});
});

// #1030
describe("a redirect target resolved as the shell lands it", () => {
	it("refuses a relative target after a leading cd into the job directory, naming where it lands and the .claude/tmp/ path to use", () => {
		const r = refused(
			bash("cd /home/u/.claude3/jobs/abc/tmp && python3 - > li_max.py"),
		);
		expect(r).toContain(".claude/tmp/li_max.py");
		expect(r).toContain("lands at /home/u/.claude3/jobs/abc/tmp/li_max.py");
	});

	it("refuses after a cd through the variable, against the live variable, naming where the write lands", () => {
		expect(
			refused(
				bash("cd $CLAUDE_JOB_DIR/tmp; echo hi > x.out", { jobDir: JOB_DIR }),
			),
		).toContain(`lands at ${JOB_DIR}/tmp/x.out`);
	});

	it.each([
		["T=$CLAUDE_JOB_DIR/tmp; cat > $T/prof.js", "the bare variable"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["T=$CLAUDE_JOB_DIR/tmp; cat > ${T}/prof.js", "a braced expansion"],
		['T="$CLAUDE_JOB_DIR/tmp" && cat > "$T/prof.js"', "both quoted"],
	])(
		"refuses a variable the command assigned — %s, %s, naming where the write lands",
		(command) => {
			expect(refused(bash(command, { jobDir: JOB_DIR }))).toContain(
				`lands at ${JOB_DIR}/tmp/prof.js`,
			);
		},
	);

	it.each([
		"T=$CLAUDE_JOB_DIR/tmp; cat > $T/prof.js",
		"cd $CLAUDE_JOB_DIR/tmp && cat > prof.js",
	])(
		"refuses %s with CLAUDE_JOB_DIR unset in the hook, naming where the write lands",
		(command) => {
			expect(refused(bash(command))).toContain(
				"lands at $CLAUDE_JOB_DIR/tmp/prof.js",
			);
		},
	);

	it("refuses an assigned literal path with CLAUDE_JOB_DIR unset, on the shape, naming where the write lands", () => {
		expect(refused(bash(`T=${JOB_DIR}/tmp; cat > $T/prof.js`))).toContain(
			`lands at ${JOB_DIR}/tmp/prof.js`,
		);
	});

	it("warns on a relative target in a subfolder after a cd, naming where the write lands", () => {
		expect(warned(bash(`cd ${JOB_DIR}/tmp/fx && echo x > a.txt`))).toContain(
			`lands at ${JOB_DIR}/tmp/fx/a.txt`,
		);
	});

	it("is silent on a relative redirect after a cd into the sanctioned directory", () => {
		expect(bash("cd .claude/tmp && echo x > a.txt")).toBeNull();
	});

	it("is silent once a later cd has left the job directory", () => {
		expect(
			bash(
				`cd ${JOB_DIR}/tmp && cat x.output > /dev/null; cd /repo && echo x > a.txt`,
			),
		).toBeNull();
	});

	it("is silent reading in the job directory and writing out of it", () => {
		expect(
			bash(`cd ${JOB_DIR}/tasks && cat x.output > /repo/.claude/tmp/y.txt`),
		).toBeNull();
	});

	it("is silent on a job-dir variable passed to a script, not redirected into", () => {
		expect(
			bash('T=$CLAUDE_JOB_DIR/tmp; bash scripts/bg-run.sh run x "$T"', {
				jobDir: JOB_DIR,
			}),
		).toBeNull();
	});

	/* A named LIMIT, pinned so a widening shows up here: pushd makes the
	 * directory unknown, and the relative target is judged as written. */
	it("is silent after a pushd, which it does not follow", () => {
		expect(bash(`pushd ${JOB_DIR}/tmp && echo x > a.txt`)).toBeNull();
	});
});

describe("a Write, Edit or NotebookEdit into the job directory", () => {
	it("refuses a Write of a flat tmp/ file, naming the sanctioned path", () => {
		expect(
			refused(run({ tool: "Write", filePath: `${JOB_DIR}/tmp/note.md` })),
		).toContain("Same write, sanctioned path: ");
	});

	it("refuses an Edit of one, saying to move it first", () => {
		expect(
			refused(run({ tool: "Edit", filePath: `${JOB_DIR}/tmp/note.md` })),
		).toMatch(/Move it to \S*\/\.claude\/tmp\/note\.md, then edit it there/);
	});

	it.each([`${JOB_DIR}/tmp/./note.md`, `${JOB_DIR}//tmp/note.md`])(
		"refuses a Write of %s, folded as the Bash limb folds it",
		(filePath) => {
			refused(run({ tool: "Write", filePath }));
		},
	);

	it("refuses on NotebookEdit's own field name", () => {
		expect(
			refused(
				run({ tool: "NotebookEdit", notebookPath: `${JOB_DIR}/tmp/n.ipynb` }),
			),
		).toContain(".claude/tmp/");
	});

	it("warns on a Write into a subfolder of tmp/, offering .claude/tmp/ instead", () => {
		expect(
			warned(run({ tool: "Write", filePath: `${JOB_DIR}/tmp/fx/note.md` })),
		).toContain(".claude/tmp/");
	});
});

describe("what it leaves alone", () => {
	it("is silent on the sanctioned spelling", () => {
		expect(bash("echo hi > .claude/tmp/x.out")).toBeNull();
	});

	it("is silent on a READ of the job directory", () => {
		expect(bash("cat $CLAUDE_JOB_DIR/tasks/x.output")).toBeNull();
	});

	it("is silent on a descriptor duplication", () => {
		expect(bash("node x.js > .claude/tmp/x.out 2>&1")).toBeNull();
	});

	it("is silent inside a conditional, where `>` compares strings", () => {
		expect(bash('[[ "$a" > $CLAUDE_JOB_DIR ]] && echo yes')).toBeNull();
	});

	/* The shape limb is anchored on a dot-prefixed config directory precisely so
	 * an ordinary `jobs/` directory in a repo is not swept in. */
	it("is silent on an ordinary jobs/ directory in a project", () => {
		expect(bash("echo hi > /home/someone/work/jobs/42/tmp/x.out")).toBeNull();
	});

	it("is silent on a Write to a sanctioned path", () => {
		expect(
			run({ tool: "Write", filePath: "/home/someone/repo/.claude/tmp/n.md" }),
		).toBeNull();
	});
});

describe("the warn's per-session bound", () => {
	const nested = "echo hi > $CLAUDE_JOB_DIR/tmp/fx/a.out";

	it("warns once, offering .claude/tmp/, and then goes silent for that session", () => {
		expect(warned(bash(nested, { sid: "one" }))).toContain(".claude/tmp/");
		expect(bash(nested, { sid: "one" })).toBeNull();
	});

	it("warns again in a different session", () => {
		warned(bash(nested, { sid: "one" }));
		warned(bash(nested, { sid: "two" }));
	});

	it("is not spent by a refusal", () => {
		refused(bash("echo hi > $CLAUDE_JOB_DIR/tmp/a.out", { sid: "one" }));
		warned(bash(nested, { sid: "one" }));
	});

	it("does not silence a refusal once spent", () => {
		warned(bash(nested, { sid: "one" }));
		refused(bash("echo hi > $CLAUDE_JOB_DIR/tmp/a.out", { sid: "one" }));
	});
});

describe("the rule text it splices", () => {
	it.each([
		["refusal", "echo hi > $CLAUDE_JOB_DIR/tmp/x.out"],
		["warning", "echo hi > $CLAUDE_JOB_DIR/tmp/fx/x.out"],
	])(
		"the %s carries the override, the gh trap and the script exemption",
		(_, command) => {
			const w = bash(command)?.text ?? "";
			expect(w).toContain("OVERRIDES THE BACKGROUND-JOB PREAMBLE");
			expect(w).toContain("not `gh`'s fault");
			expect(w).toContain("scripts/bg-run.sh");
		},
	);
});

/*
 * THE FAIL-OPEN (mantahostels#2652). The control below is what makes the case
 * mean anything: a detached copy that still refuses proves the silence in the
 * first case is the missing lib and not a broken fixture.
 */
describe("the gate on its predicate not loading", () => {
	const rules = path.resolve(__dirname, "..", "docs", "agents", "rules");

	/** A copy of the guard whose libraries can be removed one at a time. */
	const detach = (drop: string[] = []) => {
		const at = fs.mkdtempSync(path.join(dir, "detached-"));
		copyLibs(path.join(at, "lib"), sourcedLibs(GUARD), drop);
		const guard = path.join(at, "guard-job-dir-scratch.sh");
		fs.copyFileSync(GUARD, guard);
		fs.chmodSync(guard, 0o755);
		return guard;
	};

	/* The detached guard needs a project root of its own for the fail-open
	 * record's slug, and WFC_RULES_DIR because it can no longer find the rule
	 * store from its own location. */
	const detachedRun = (guard: string, command: string) => {
		const project = fs.mkdtempSync(path.join(dir, "project-"));
		const r = spawnGuard(
			guard,
			{
				/* The guard path is the fixture's only discriminator between the two
				 * cases below, `session` being fixed within one test. */
				session_id: `detached-${session}-${path.basename(path.dirname(guard))}`,
				tool_name: "Bash",
				tool_input: { command },
			},
			{
				project,
				config,
				cwd: project,
				env: { CLAUDE_JOB_DIR: JOB_DIR, WFC_RULES_DIR: rules },
			},
		);
		return { r, project };
	};

	const write = "echo hi > $CLAUDE_JOB_DIR/tmp/x.out";

	it("still refuses with every library present, offering .claude/tmp/ — the control", () => {
		const { r } = detachedRun(detach(), write);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(".claude/tmp/");
	});

	it("stands down, silently and on the record, without lib/guard-job-dir.sh", () => {
		const { r, project } = detachedRun(detach(["guard-job-dir.sh"]), write);
		expect(r.status).toBe(0);
		expect(r.stderr ?? "").toBe("");
		expect(r.stdout.trim()).toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toMatch(
			/guard-job-dir\.sh did not load/,
		);
	});
});
