// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshSandbox, live, store, storeAt } from "./arbiter-testkit";
import { plan } from "./bash-write-plan.js";
import { decide } from "./claimed-bash-write.js";
import { buildHostPorts } from "./claimed-bash-write-host.js";
import { cutWorktree } from "./git-fixture";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";
import { hostAdapters } from "./guard-host-ports.js";
import { registrationsOf } from "./hook-wiring";
import { kitContext } from "./kit-context.js";
import { buildBashPayload } from "./pretool-guard-testkit";
import { readRuleText } from "./rule-text.js";

const NAME = "guard-claimed-bash-write";

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.repo, "scripts", "lib"), { recursive: true });
	fs.mkdirSync(path.join(fresh.repo, "docs", "agents"), { recursive: true });
	fs.mkdirSync(path.join(fresh.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(fresh.repo, "package.json"),
		'{"scripts":{"test":"node scripts/run-vitest.js"}}',
	);
});

let logs: string[] = [];

function ctxFor(command: string) {
	logs = [];
	const log = (what: string) => {
		logs.push(what);
	};
	const payload = buildBashPayload(command, "mine");
	const ports = hostAdapters(sb.repo, log);
	return {
		...kitContext(
			{ root: sb.repo, payload, log },
			{
				...ports,
				fallbackCwd: sb.repo,
				vars: {},
				env: {},
			},
		),
		session: "mine",
		tree: () => ports,
		...buildHostPorts(),
	};
}

function judgeSplit(command: string): {
	parts: { credits: string[]; targets: string[] };
	selects: string[];
} | null {
	const p = plan(command, ctxFor(command));
	if (p.targets.length + p.credit.length + p.select.length === 0) return null;
	return {
		parts: {
			credits: p.credit,
			targets: p.targets.map((t) => path.relative(sb.repo, t)),
		},
		selects: p.select,
	};
}

function judgeParts(
	command: string,
): { credits: string[]; targets: string[] } | null {
	return judgeSplit(command)?.parts ?? null;
}

function selectsOf(command: string): string[] | null {
	return judgeSplit(command)?.selects.sort() ?? null;
}

function targets(command: string): string[] | null {
	return judgeParts(command)?.targets ?? null;
}

function credits(command: string): string[] | null {
	return judgeParts(command)?.credits ?? null;
}

function run(
	command: string,
	session: string | null = "mine",
	extra: Record<string, unknown> = {},
) {
	return runCore(
		NAME,
		{ ...buildBashPayload(command, session), ...extra },
		{
			root: sb.repo,
		},
	);
}

function claimedBy(subject: string, sessionId: string) {
	store.acquire(subject, live(sb, sessionId));
}

const ledgerFile = (agent: string) =>
	path.join(
		sb.repo,
		".claude",
		"tmp",
		"markers",
		`.rule-injected-led.claimed-bash-write-${agent}-mine`,
	);

describe("the session ledger it keeps (mantahostels#2345)", () => {
	it("writes it inside clear-rule-latch.sh's own glob", () => {
		claimedBy("docs/x.md", "theirs");
		expect(run("echo hi > docs/x.md").output?.additionalContext).toContain(
			"HELD  docs/x.md",
		);
		expect(fs.existsSync(ledgerFile("main"))).toBe(true);
	});

	it("keys it on the AGENT too, so a subagent does not inherit its parent's", () => {
		claimedBy("docs/x.md", "theirs");
		run("echo hi > docs/x.md", "mine", { agent_id: "sub" });
		expect(fs.existsSync(ledgerFile("asub"))).toBe(true);
		expect(fs.existsSync(ledgerFile("main"))).toBe(false);
	});

	it("says a pair once a session through it", () => {
		claimedBy("docs/x.md", "theirs");
		expect(run("echo hi > docs/x.md").output).not.toBe(null);
		expect(run("echo hi > docs/x.md").output).toBe(null);
	});
});

describe("the write routes it reads", () => {
	it("reads a redirect target, spaced and glued, appending and clobbering", () => {
		expect(targets("echo hi > docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >> docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi 1>docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi >| docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("echo hi &> docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("> docs/x.md")).toEqual(["docs/x.md"]);
	});

	it("does not read a `>` inside a conditional as a redirect", () => {
		expect(targets('[[ "$a" > docs/x.md ]]')).toBe(null);
		expect(targets('[ "$a" \\> docs/x.md ]')).toBe(null);
	});

	it("reads cp and mv destinations, and never cp's sources", () => {
		expect(targets("cp /tmp/a docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("mv /tmp/a CLAUDE.md")).toEqual(["CLAUDE.md"]);
		expect(targets("cp docs/x.md /tmp/a")).toBe(null);
	});

	it("reads mv's SOURCE too, which mv destroys", () => {
		expect(targets("mv docs/x.md /tmp/a")).toEqual(["docs/x.md"]);
		expect(targets("mv docs/x.md docs/y.md")).toEqual([
			"docs/x.md",
			"docs/y.md",
		]);
	});

	it("reads cp -t, which moves the destination out of the positionals", () => {
		expect(targets("cp -t docs/agents /tmp/a.md /tmp/b.md")).toEqual([
			"docs/agents/a.md",
			"docs/agents/b.md",
		]);
	});

	it("expands a cp into an existing directory to dir/<basename>", () => {
		expect(targets("cp /tmp/a.md docs/agents")).toEqual(["docs/agents/a.md"]);
		expect(targets("cp /tmp/a.md /tmp/b.md docs/agents/")).toEqual([
			"docs/agents/a.md",
			"docs/agents/b.md",
		]);
	});

	it("reads in-place sed and perl, bundled flags included", () => {
		expect(targets("sed -i s/a/b/ docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("sed -i.bak s/a/b/ docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("perl -pi -e s/a/b/ AGENTS.md")).toEqual(["AGENTS.md"]);
		expect(targets("sed -n 1p docs/x.md")).toBe(null);
		expect(targets("perl -ne print docs/x.md")).toBe(null);
	});

	it("does not read perl's -I directory as an in-place switch", () => {
		expect(targets("perl -Ilib -ne print docs/x.md")).toBe(null);
	});

	it("reads truncate and tee", () => {
		expect(targets("truncate -s 0 docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("cat /tmp/a | tee .claude/settings.json")).toEqual([
			".claude/settings.json",
		]);
	});

	it("reads git restore, and git checkout only past its --", () => {
		expect(targets("git restore docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("git checkout -- docs/x.md")).toEqual(["docs/x.md"]);
		expect(targets("git checkout docs/x.md")).toBe(null);
	});

	it("does not read a restore that rewrites only the index", () => {
		expect(targets("git restore --staged docs/x.md")).toBe(null);
		expect(targets("git restore --staged --worktree docs/x.md")).toEqual([
			"docs/x.md",
		]);
	});

	it("gives up on a git global option rather than guessing", () => {
		expect(targets("git -C . checkout -- docs/x.md")).toBe(null);
	});
});

describe("what it must stay silent about", () => {
	it("says nothing about a path merely mentioned", () => {
		expect(targets("grep foo docs/x.md")).toBe(null);
		expect(targets("cat docs/x.md")).toBe(null);
		expect(targets("echo 'sed -i s/a/b/ docs/x.md'")).toBe(null);
	});

	it("says nothing about a write outside tier 1", () => {
		expect(targets("echo hi > scripts/x.js")).toEqual([]);
		expect(targets("echo hi > /tmp/x")).toBe(null);
		expect(targets("echo hi > package.json")).toBe(null);
	});

	it("does not read a descriptor duplication as a file", () => {
		expect(targets("echo ok 2>&1")).toBe(null);
		expect(targets("echo ok >&2")).toBe(null);
	});

	it("does not guess at a path it cannot read literally", () => {
		expect(targets("echo hi > $DEST/docs/x.md")).toBe(null);
		expect(targets("echo hi > $(mktemp)")).toBe(null);
	});

	it("never denies, whatever it finds", () => {
		claimedBy("CLAUDE.md", "theirs");
		const { output } = run("sed -i s/a/b/ CLAUDE.md");
		expect(output?.additionalContext).toContain("HELD  CLAUDE.md");
		expect(output?.permissionDecision).toBeUndefined();
	});

	it("stays silent when the judge has nothing to say", () => {
		expect(run("sed -i s/a/b/ CLAUDE.md").output).toBe(null);
	});
});

describe("the code paths it hands the judge to credit (mantahostels#2778)", () => {
	it("credits a code write the warning half is not allowed to name", () => {
		expect(credits("echo hi > scripts/x.js")).toEqual(["scripts/x.js"]);
		expect(credits("sed -i s/a/b/ scripts/x.sh")).toEqual(["scripts/x.sh"]);
		expect(credits("tee app/page.tsx")).toEqual(["app/page.tsx"]);
	});

	it("credits a code write even with no tier-1 target at all", () => {
		run("echo hi > scripts/x.js");
		expect(store.readWritesBy("mine")).toContain("scripts/x.js");
	});

	it("credits a path repo-relative, never absolute", () => {
		for (const c of credits("echo hi > scripts/x.js") ?? [])
			expect(path.isAbsolute(c)).toBe(false);
	});

	it("credits a tier-1 path that is also code, on both lists", () => {
		const parts = judgeParts("sed -i s/a/b/ .claude/hooks/x.sh");
		expect(parts?.credits).toEqual([".claude/hooks/x.sh"]);
		expect(parts?.targets).toEqual([".claude/hooks/x.sh"]);
	});

	it("credits nothing that is not code by the backstop's own globs", () => {
		expect(credits("echo hi > docs/x.md")).toEqual([]);
		expect(credits("echo hi > package.json")).toBe(null);
		expect(credits("echo hi > public/x.css")).toBe(null);
	});

	it("credits nothing outside the repo, however code-shaped", () => {
		expect(credits("echo hi > /tmp/x.js")).toBe(null);
		expect(credits("echo hi > ../elsewhere/x.ts")).toBe(null);
	});

	it("credits nothing it could not read literally", () => {
		expect(credits("echo hi > $DEST/x.js")).toBe(null);
		expect(credits('echo hi > "$(mktemp).js"')).toBe(null);
	});

	it("credits nothing for a path merely mentioned", () => {
		expect(credits("grep foo scripts/x.js")).toBe(null);
		expect(credits("node scripts/x.js")).toBe(null);
	});

	it("credits mv's source, which mv destroys, as well as its destination", () => {
		expect(credits("mv scripts/a.js scripts/b.js")?.sort()).toEqual([
			"scripts/a.js",
			"scripts/b.js",
		]);
	});

	it("credits cp's destination only, cp leaving its source alone", () => {
		expect(credits("cp scripts/a.js scripts/b.js")).toEqual(["scripts/b.js"]);
	});
});

describe("the line join mantahostels#287 named as a gap, left open", () => {
	it("misses a write swallowed between two stray apostrophes", () => {
		expect(targets("echo it's fine\ncp /tmp/a docs/x.md\necho don't")).toBe(
			null,
		);
	});

	it("still reads the write where nothing swallows it", () => {
		expect(targets('echo "fine"\ncp /tmp/a docs/x.md\necho "done"')).toEqual([
			"docs/x.md",
		]);
	});
});

describe("the code globs it duplicates from the backstop (mantahostels#2778)", () => {
	it("credits every path lib/code-signal.sh's CODE array counts", () => {
		const backstop = fs.readFileSync(
			path.join(__dirname, "code-signal.sh"),
			"utf8",
		);
		const array = backstop.match(/^CODE=\(\n([\s\S]*?)^\)$/m);
		expect(array).not.toBeNull();
		const body = (array?.[1] ?? "")
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n");
		const globs = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
		expect(globs.length).toBeGreaterThan(0);
		for (const glob of globs) {
			const file = glob.startsWith("*.")
				? `scripts/a.${glob.slice(2)}`
				: `${glob}pre-commit`;
			expect(credits(`echo hi > ${file}`)).toEqual([file]);
		}
	});

	it("credits a Husky hook, which carries no extension at all", () => {
		expect(credits("sed -i s/a/b/ .husky/pre-commit")).toEqual([
			".husky/pre-commit",
		]);
	});
});

describe("the tier prefix test", () => {
	it("covers every prefix the arbiter's warned tier holds", () => {
		const core = fs.readFileSync(
			path.join(__dirname, "arbiter-core.js"),
			"utf8",
		);
		const warned = core.match(/^const WARNED = \[(.*)\];$/m);
		expect(warned).not.toBeNull();
		const tier = [...(warned?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(tier.length).toBeGreaterThan(0);
		for (const prefix of tier) {
			const rel = prefix.endsWith("/") ? `${prefix}x.md` : prefix;
			expect(targets(`echo hi > ${rel}`)).toEqual([rel]);
		}
	});
});

describe("failing open", () => {
	it("allows unchecked, and records, when the payload names no session", () => {
		claimedBy("CLAUDE.md", "theirs");
		const r = run("sed -i s/a/b/ CLAUDE.md", null);
		expect(r.output).toBe(null);
		expect(r.logs.join("\n")).toContain("no session_id in payload");
	});

	it("gives up on a ledger write that hangs, inside the hook timeout its registration gives it", () => {
		const [{ timeout }] = registrationsOf("PreToolUse", "guard-dispatch.js");
		if (typeof timeout !== "number")
			throw new Error("the hook registration no longer carries a timeout");
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/proc/nonexistent/nope");
		const started = Date.now();
		const r = run(`echo hi > scripts/a.js; node -e "r('scripts/q.js')"`);
		expect(Date.now() - started).toBeLessThan(timeout * 1000);
		expect(r.output).toBe(null);
		expect(r.logs).toEqual([
			"claimed-bash-write: recordWrite timed out on scripts/a.js",
			"claimed-bash-write: recordSelect skipped — the claim store hung",
		]);
	}, 40_000);

	it("records a ledger write that fails, and allows the command", () => {
		fs.mkdirSync(sb.stateDir(), { recursive: true });
		fs.writeFileSync(path.join(sb.stateDir(), "writes"), "");
		const r = run("echo hi > scripts/a.js");
		expect(r.output).toBe(null);
		expect(r.logs).toEqual([
			"claimed-bash-write: recordWrite exited 1 on scripts/a.js",
		]);
	});

	it("records a store it cannot read, and warns and credits nothing", () => {
		claimedBy("CLAUDE.md", "theirs");
		fs.chmodSync(path.join(sb.stateDir(), "locks"), 0o000);
		try {
			const r = run("sed -i s/a/b/ CLAUDE.md scripts/x.sh");
			if (process.getuid?.() === 0) return;
			expect(r.output).toBe(null);
			expect(r.logs.join("\n")).toContain("the lock store could not be read");
		} finally {
			fs.chmodSync(path.join(sb.stateDir(), "locks"), 0o755);
		}
	});
});

describe("the cwd a relative target resolves against (mantahostels#2807)", () => {
	it("drops a relative target once a cd has moved off the hook's cwd", () => {
		expect(credits("cd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(null);
		expect(targets("cd /elsewhere && cp /tmp/a docs/x.md")).toBe(null);
	});

	it("keeps a relative target where the cd lands back on the hook's cwd", () => {
		expect(credits(`cd ${sb.repo} && sed -i s/a/b/ scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
		expect(credits("cd . && sed -i s/a/b/ scripts/x.sh")).toEqual([
			"scripts/x.sh",
		]);
		expect(credits(`cd ${sb.repo}/scripts/.. && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("keeps an absolute target, which names the same file from any cwd", () => {
		expect(credits(`cd /elsewhere && tee ${sb.repo}/scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("counts an unreadable cd target as moved, never as staying put", () => {
		expect(credits('cd "$WT" && sed -i s/a/b/ scripts/x.sh')).toBe(null);
		expect(credits("cd $(mktemp -d) && sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("counts a bare cd, a pushd and a popd as moved", () => {
		expect(credits("cd && sed -i s/a/b/ scripts/x.sh")).toBe(null);
		expect(credits("pushd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(
			null,
		);
		expect(credits("popd; sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("tracks a relative hop, so a cd down and back reads as unmoved", () => {
		expect(credits("cd docs && cd .. && sed -i s/a/b/ scripts/x.sh")).toEqual([
			"scripts/x.sh",
		]);
		expect(credits("cd docs && sed -i s/a/b/ scripts/x.sh")).toBe(null);
	});

	it("stays unknown after an unreadable cd, however it is followed", () => {
		expect(credits('cd "$WT" && cd . && tee scripts/x.sh')).toBe(null);
	});

	it("finds the cd past a grouping or builtin prefix", () => {
		expect(credits("{ cd /elsewhere; sed -i s/a/b/ scripts/x.sh; }")).toBe(
			null,
		);
		expect(credits("builtin cd /elsewhere && sed -i s/a/b/ scripts/x.sh")).toBe(
			null,
		);
		expect(credits("command cd /elsewhere && tee scripts/x.sh")).toBe(null);
	});

	it("reads a write before the cd, which really is against this tree", () => {
		expect(credits("sed -i s/a/b/ scripts/x.sh && cd /elsewhere")).toEqual([
			"scripts/x.sh",
		]);
	});

	it("drops a redirect target too, not just the named-route ones", () => {
		expect(credits("cd /elsewhere && echo hi > scripts/x.js")).toBe(null);
		expect(targets("cd /elsewhere && echo hi >> docs/x.md")).toBe(null);
	});

	it("keeps an absolute TIER-1 target under a moved cwd, as it keeps a code one", () => {
		expect(targets(`cd /elsewhere && cp /tmp/a ${sb.repo}/docs/x.md`)).toEqual([
			"docs/x.md",
		]);
	});

	it("reads a cd back to the root after moving away", () => {
		expect(
			credits(`cd /elsewhere && cd ${sb.repo} && sed -i s/a/b/ scripts/x.sh`),
		).toEqual(["scripts/x.sh"]);
	});

	it("normalises a trailing and a doubled slash in the cd target", () => {
		expect(credits(`cd ${sb.repo}/ && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
		expect(credits(`cd ${sb.repo}//scripts/.. && tee scripts/x.sh`)).toEqual([
			"scripts/x.sh",
		]);
	});

	it("credits nothing for the cd itself", () => {
		expect(credits("cd scripts/x.sh")).toBe(null);
	});
});

describe("the inline-interpreter arm (mantahostels#2854)", () => {
	it("names a path a python heredoc writes", () => {
		expect(
			targets(
				[
					"python3 - <<'PY'",
					"from pathlib import Path",
					"Path('docs/x.md').write_text('hi')",
					"PY",
				].join("\n"),
			),
		).toEqual(["docs/x.md"]);
	});

	it("names a path python3 -c writes", () => {
		expect(targets(`python3 -c "open('docs/w.md','w').write('a')"`)).toEqual([
			"docs/w.md",
		]);
	});

	it("names a path node -e writes", () => {
		expect(
			targets(`node -e 'require("fs").writeFileSync("docs/y.md","z")'`),
		).toEqual(["docs/y.md"]);
	});

	it("names a path a node heredoc writes", () => {
		expect(
			targets(
				["node <<'EOF'", "fs.writeFileSync('docs/z.md','q')", "EOF"].join("\n"),
			),
		).toEqual(["docs/z.md"]);
	});

	it("reads a node template literal, the ordinary spelling in a node heredoc", () => {
		expect(targets("node -e 'fs.writeFileSync(`docs/t.md`, x)'")).toEqual([
			"docs/t.md",
		]);
	});

	it("says nothing without the interpreter limb, however the path is quoted", () => {
		expect(targets("grep 'docs/x.md' notes.txt")).toBe(null);
		expect(targets('grep "docs/x.md" notes.txt')).toBe(null);
		expect(targets("python3 script.py 'docs/x.md'")).toBe(null);
	});

	it("says nothing without the path limb", () => {
		expect(targets("node --version")).toBe(null);
		expect(targets(`node -e 'console.log(1)'`)).toBe(null);
	});

	it("says nothing about a program arriving down a pipe", () => {
		expect(targets(`echo "open('docs/x.md','w')" | python3`)).toBe(null);
		expect(targets(`echo "open('docs/x.md','w')" | python3 -`)).toBe(null);
	});

	it("hands every tier-1 path it quotes, resolving none of them", () => {
		expect(
			targets(
				`python3 -c "a=open('docs/a.md');b=open('docs/b.md','w')"`,
			)?.sort(),
		).toEqual(["docs/a.md", "docs/b.md"]);
	});

	it("emits candidates grouped by quote kind, not in source order", () => {
		expect(targets(`node -e "w(\`docs/b.md\`); r('docs/a.md')"`)).toEqual([
			"docs/a.md",
			"docs/b.md",
		]);
	});

	it("never warns about a scripts/ path the interpreter quotes", () => {
		expect(
			judgeParts(`node -e "fs.writeFileSync('scripts/foo.sh','')"`),
		).toEqual({ credits: [], targets: [] });
		expect(
			judgeParts(`python3 -c "open('scripts/a.sh');open('docs/a.md','w')"`),
		).toEqual({ credits: [], targets: ["docs/a.md"] });
	});

	it("names a path quoted by a neighbouring command, not the interpreter", () => {
		expect(targets(`node -e 'x=1' && grep "docs/x.md" y`)).toEqual([
			"docs/x.md",
		]);
	});

	it("credits nothing, a quoted candidate not being a resolved target", () => {
		expect(judgeParts(`node -e "fs.writeFileSync('.claude/x.sh','')"`)).toEqual(
			{ credits: [], targets: [".claude/x.sh"] },
		);
	});

	it("leaves the CREDIT list of a real route untouched", () => {
		expect(judgeParts(`node -e 'x' > .claude/z.sh`)).toEqual({
			credits: [".claude/z.sh"],
			targets: [".claude/z.sh"],
		});
	});

	it("drops a relative candidate once a cd has moved off the hook's cwd", () => {
		expect(targets(`cd /tmp && python3 -c "open('docs/x.md','w')"`)).toBe(null);
	});

	it("requires a quote to be closed by its own kind", () => {
		expect(targets(`node -e 'x' ; echo "docs/a.md'`)).toBe(null);
	});

	it("reads a versioned interpreter name", () => {
		expect(targets(`python3.12 -c "open('docs/v.md','w')"`)).toEqual([
			"docs/v.md",
		]);
	});
});

describe("the selection paths it notes (#1220)", () => {
	it("hands every path-shaped quoted path, of any tier", () => {
		expect(
			selectsOf(
				[
					"python3 - <<'EOF'",
					"from pathlib import Path",
					"p = Path('scripts/lib/x.js')",
					"p.write_text(p.read_text().replace('a', 'b'))",
					"open(\"docs/y.md\", 'w')",
					"EOF",
				].join("\n"),
			),
		).toEqual(["docs/y.md", "scripts/lib/x.js"]);
	});

	it("keeps a token with no slash or dot, or a byte no path carries, off it", () => {
		expect(
			selectsOf(
				`python3 -c "open('x', 'w', encoding='utf-8'); print('%s.md')"`,
			),
		).toBe(null);
	});

	it("notes nothing for a command with no inline interpreter", () => {
		expect(selectsOf("grep 'scripts/x.js' notes.txt")).toBe(null);
		expect(selectsOf("python3 scripts/x.py 'scripts/y.js'")).toBe(null);
	});

	it("drops a relative quoted path once a cd has moved off the hook's cwd", () => {
		expect(selectsOf(`cd /tmp && node -e "w('scripts/x.js')"`)).toBe(null);
	});

	it("drops a quoted path outside the repo", () => {
		expect(selectsOf(`node -e "w('/etc/x.conf')"`)).toBe(null);
	});

	it("credits none of them to the write ledger", () => {
		expect(credits(`node -e "fs.writeFileSync('scripts/x.js','')"`)).toEqual(
			[],
		);
	});

	it("records them on the selection ledger through the real store", () => {
		run(`node -e "w('scripts/x.js')"`);
		expect(
			store.readSelectsBy("mine").map((r: { path: string }) => r.path),
		).toContain("scripts/x.js");
	});

	it("notes nothing in a host whose test script never runs run-vitest.js (#1245)", () => {
		const pkg = path.join(sb.repo, "package.json");
		fs.writeFileSync(pkg, '{"scripts":{"test":"vitest run"}}');
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
		fs.writeFileSync(
			pkg,
			'{"scripts":{"test":"vitest run"},"comments":{"x":"see run-vitest.js"}}',
		);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
		fs.rmSync(pkg);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toBe(null);
	});

	it("notes them in a host reaching run-vitest.js through resolve-core.js, as mantahostels does", () => {
		fs.writeFileSync(
			path.join(sb.repo, "package.json"),
			'{"scripts":{"test": "node scripts/lib/resolve-core.js scripts/run-vitest.js"}}',
		);
		expect(selectsOf(`node -e "w('scripts/x.js')"`)).toEqual(["scripts/x.js"]);
	});

	it("notes the tracked files an rm, git rm or git mv names, and warns on and credits none (#1791)", () => {
		const tracked = [
			"scripts/gone.js",
			"docs/gone.md",
			"docs/old.md",
			"scripts/lib/a.test.ts",
			"scripts/old/x.js",
			"scripts/old/y.js",
		];
		for (const f of tracked) {
			fs.mkdirSync(path.dirname(path.join(sb.repo, f)), { recursive: true });
			fs.writeFileSync(path.join(sb.repo, f), "");
		}
		const git = (...args: string[]) =>
			spawnSync("git", ["-C", sb.repo, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("add", "--", ...tracked);
		for (const [command, paths] of [
			[
				"rm -f scripts/gone.js docs/gone.md .claude/scratch.md",
				["docs/gone.md", "scripts/gone.js"],
			],
			["git rm -q -- docs/old.md", ["docs/old.md"]],
			[
				"git mv scripts/lib/a.test.ts scripts/lib/b.test.ts",
				["scripts/lib/a.test.ts"],
			],
			["rm -r scripts/old", ["scripts/old/x.js", "scripts/old/y.js"]],
		] as const) {
			const split = judgeSplit(command);
			expect(split?.selects.sort()).toEqual(paths);
			expect(split?.parts).toEqual({ credits: [], targets: [] });
		}
	});

	it("logs a git that will not list the deletion's files, and notes none (#1950)", () => {
		expect(judgeSplit("rm -f docs/gone.md")).toBe(null);
		expect(logs.join("\n")).toMatch(/git ls-files failed .* — a deletion's/);
	});

	it("logs nothing where git lists the deletion's files (#1950)", () => {
		spawnSync("git", ["-C", sb.repo, "init", "-q"]);
		judgeSplit("rm -f docs/gone.md");
		expect(logs).toEqual([]);
	});

	it("never reaches the judge for an rm of untracked scratch (#1791)", () => {
		spawnSync("git", ["-C", sb.repo, "init", "-q"]);
		expect(judgeSplit("rm -f .claude/scratch.md scripts/tmp.js")).toBe(null);
	});

	it("still warns on, and notes nothing for, a quoted tier-1 path in a host with no package.json (#1245)", () => {
		fs.rmSync(path.join(sb.repo, "package.json"));
		const split = judgeSplit(`node -e "w('docs/x.md')"`);
		expect(split?.parts.targets).toEqual(["docs/x.md"]);
		expect(split?.selects).toEqual([]);
	});

	it("matches this repo's own test script, so renaming run-vitest.js cannot empty the ledger unseen", () => {
		const real = fs.readFileSync(
			path.join(__dirname, "..", "..", "package.json"),
			"utf8",
		);
		expect(real).toMatch(/"test": *"[^"]*run-vitest\.js/);
	});
});

describe("what ends the inline-interpreter scan", () => {
	it("says nothing about a flag belonging to the program, not the interpreter", () => {
		expect(targets(`python3 -m pip install -c "docs/x.md"`)).toBe(null);
		expect(targets(`node scripts/foo.js -e "docs/x.md"`)).toBe(null);
	});

	it("still reads the bare - a python heredoc needs", () => {
		expect(
			targets(["python3 - <<'PY'", "open('docs/x.md','w')", "PY"].join("\n")),
		).toEqual(["docs/x.md"]);
	});

	it("says nothing about a heredoc feeding DATA to a script file", () => {
		expect(
			targets(
				["node script.js <<'EOF'", '{"out": "docs/x.md"}', "EOF"].join("\n"),
			),
		).toBe(null);
	});
});

describe("the whole-file restore rule it hands over (#2028)", () => {
	const rule = readRuleText("whole-file-restore");

	function gitHost(dirty: boolean) {
		const git = (...args: string[]) =>
			spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
				cwd: sb.repo,
				encoding: "utf8",
			});
		git("init", "-q");
		fs.writeFileSync(path.join(sb.repo, "f.txt"), "a\n");
		fs.writeFileSync(path.join(sb.repo, "docs", "x.md"), "a\n");
		git("add", "f.txt", "docs/x.md");
		git("commit", "-qm", "base");
		if (dirty) {
			fs.appendFileSync(path.join(sb.repo, "f.txt"), "b\n");
			fs.appendFileSync(path.join(sb.repo, "docs", "x.md"), "b\n");
		}
	}

	function told(command: string, session = "mine"): string {
		return run(command, session).output?.additionalContext ?? "";
	}

	it.each([
		"git restore -- f.txt",
		"git checkout -- f.txt",
		"git checkout f.txt",
		"git checkout HEAD f.txt",
		"cp /tmp/f.bak f.txt",
		"mv f.bak f.txt",
		"cp /tmp/f.bak f.txt > log",
	])("hands over the whole rule on %s over uncommitted changes", (command) => {
		gitHost(true);
		expect(told(command)).toBe(rule);
	});

	it("says it once a session", () => {
		gitHost(true);
		expect(told("git restore -- f.txt")).toBe(rule);
		expect(told("git restore -- f.txt")).toBe("");
		expect(told("git restore -- f.txt", "other")).toBe(rule);
	});

	it.each([
		["a clean file", false, "git restore -- f.txt"],
		["an untracked file", true, "cp /tmp/f.bak new.txt"],
		["an unstage", true, "git restore --staged f.txt"],
		["a redirect", true, "echo b > f.txt"],
		["a redirect beside a cp", true, "cp /tmp/f.bak log > f.txt"],
		["a cp reading the file", true, "cp f.txt /tmp/f.bak"],
		["a branch switch", true, "git checkout -b f.txt"],
		["a word naming no path", true, "git checkout main"],
	])("stays silent on %s", (_, dirty, command) => {
		gitHost(dirty as boolean);
		expect(told(command as string)).toBe("");
	});

	it("stays silent where git cannot answer, and logs why", () => {
		fs.writeFileSync(path.join(sb.repo, "f.txt"), "a\n");
		const r = run("git restore -- f.txt");
		expect(r.output).toBe(null);
		expect(r.logs.join("\n")).toContain("a whole-file restore went unjudged");
	});

	it("carries the claim warning ahead of the rule in one envelope", () => {
		gitHost(true);
		claimedBy("docs/x.md", "theirs");
		const said = told("git restore -- docs/x.md");
		expect(said.endsWith(`\n\n${rule}`)).toBe(true);
		expect(said.startsWith("This command writes through Bash")).toBe(true);
		expect(said).toContain("HELD  docs/x.md");
	});
});

describe("cases a mutant must not survive", () => {
	it("credits nothing outside the repo whose path is longer than the root's", () => {
		expect(
			credits(`echo hi > ${path.dirname(sb.repo)}/outside-the-repo/x.js`),
		).toBe(null);
	});

	it("reads node -p as inline", () => {
		expect(targets(`node -p 'fs.writeFileSync("docs/p.md","")'`)).toEqual([
			"docs/p.md",
		]);
	});

	it("reads a ./-led target as the path it names", () => {
		expect(targets("cp /tmp/a ./docs/x.md")).toEqual(["docs/x.md"]);
	});

	it("reads an interpreter named by its path", () => {
		expect(targets(`/usr/bin/python3 -c "open('docs/x.md','w')"`)).toEqual([
			"docs/x.md",
		]);
	});

	it("notes no tracked file for a command that deletes nothing", () => {
		const git = (...args: string[]) =>
			spawnSync("git", ["-C", sb.repo, ...args], { encoding: "utf8" });
		fs.writeFileSync(path.join(sb.repo, "scripts", "a.js"), "");
		git("init", "-q");
		git("add", "--", "scripts/a.js");
		expect(selectsOf(`node -e "w('docs/x.md')"`)).toEqual(["docs/x.md"]);
	});

	it("hands the warning through the core's path rewrite", () => {
		claimedBy("docs/x.md", "theirs");
		const ctx = {
			...ctxFor("echo hi > docs/x.md"),
			corePaths: (t: string) => t.replaceAll("Leave the path", "REWRITTEN"),
		};
		const d = decide("echo hi > docs/x.md", ctx);
		expect(d && "prelude" in d ? d.prelude : null).toContain("REWRITTEN");
	});

	describe("the whole-file restore", () => {
		function dirtyHost() {
			const git = (...args: string[]) =>
				spawnSync(
					"git",
					["-c", "user.email=t@t", "-c", "user.name=t", ...args],
					{ cwd: sb.repo, encoding: "utf8" },
				);
			git("init", "-q");
			fs.writeFileSync(path.join(sb.repo, "f.txt"), "a\n");
			git("add", "f.txt");
			git("commit", "-qm", "base");
			fs.appendFileSync(path.join(sb.repo, "f.txt"), "b\n");
		}

		it("stays silent on an mv carrying the file away", () => {
			dirtyHost();
			expect(run("mv f.txt /tmp/f.bak").output).toBe(null);
		});

		it("reads a word before -- as a revision, never a path", () => {
			dirtyHost();
			expect(run("git checkout f.txt -- new.txt").output).toBe(null);
		});

		it("logs a repo with no commit as HEAD not resolving", () => {
			spawnSync("git", ["-C", sb.repo, "init", "-q"]);
			fs.writeFileSync(path.join(sb.repo, "f.txt"), "a\n");
			const r = run("git restore -- f.txt");
			expect(r.output).toBe(null);
			expect(r.logs.join("\n")).toContain("HEAD did not resolve");
		});
	});
});

describe("a restore from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	const split = freshSandbox((fresh) => {
		at = splitCheckout(path.join(fresh.dir, "split"));
	});

	const told = () =>
		runCore(NAME, toolCall("Bash", { command: "git restore -- a.md" }), {
			root: at.main,
			worktree: at.worktree,
		}).output?.additionalContext ?? "";

	const Rule = "A WHOLE-FILE RESTORE THROWS AWAY EVERY UNCOMMITTED EDIT";

	it("hands the rule where the worktree's own copy holds uncommitted edits", () => {
		fs.appendFileSync(path.join(at.worktree, "a.md"), "mine\n");
		expect(told()).toContain(Rule);
	});

	it("is silent where only the main checkout's copy is dirty", () => {
		fs.appendFileSync(path.join(at.main, "a.md"), "theirs\n");
		expect(told()).not.toContain(Rule);
	});

	it("credits a code write against the host root's claims and ledger (#4274)", () => {
		const write = (rel: string) =>
			runCore(
				NAME,
				toolCall(
					"Bash",
					{ command: `echo hi > ${rel}` },
					{ session_id: "mine" },
				),
				{ root: at.main, worktree: at.worktree },
			);
		storeAt(at.main);
		store.acquire("scripts/b.js", live(split, "theirs"));
		write("scripts/a.js");
		write("scripts/b.js");
		expect(store.readWritesBy("mine")).toEqual(["scripts/a.js"]);
	});

	const heldWrite = (rel: string) => {
		const nested = cutWorktree(at.main);
		storeAt(at.main);
		store.acquire(
			path.relative(at.main, path.join(nested, rel)),
			live(split, "theirs"),
		);
		live(split, "mine");
		return (
			runCore(
				NAME,
				toolCall(
					"Bash",
					{ command: `echo hi > ${rel}` },
					{ session_id: "mine" },
				),
				{ root: at.main, worktree: nested },
			).output?.additionalContext ?? ""
		);
	};

	it("warns on no claim the host's store holds on the worktree's own .claude/tmp/", () => {
		expect(heldWrite(".claude/tmp/x.out")).not.toContain("HELD");
	});

	it("warns on the claim the host's store holds on the same worktree's doc", () => {
		expect(heldWrite("docs/x.md")).toContain("HELD");
	});
});
