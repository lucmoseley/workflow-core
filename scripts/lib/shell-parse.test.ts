// @vitest-environment node
/*
 * In-process cases for scripts/lib/shell-parse.js, the guard parser (#2784):
 * the lexer, split, cd tracking, variable expansion, redirects, write targets
 * and command walk.
 *
 * The core does no I/O, so a variable arrives through `vars`, and a directory
 * test through an `isDir` stub. The paths under /fx stand in for a repo's
 * directories: no case here touches the filesystem.
 *
 * A Command's `redirects`, `writeTargets` and `resolveWord` read the walk's
 * cwd and assignments AS THEY STAND, so every helper calls them inside the
 * callback.
 */

import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import type {
	Command,
	GitCall,
	GitWalkOpts,
	GitWalkPorts,
	WalkPorts,
} from "./shell-parse.js";
import {
	asWritten,
	normAbs,
	parseCommand,
	unmask,
	unsetText,
	walkCommands,
	walkGit,
} from "./shell-parse.js";
import { literal, QUOTED } from "./shell-words.js";

/* A fixture's directories (`dir`, `shared`, `wt`, `elsewhere`), as plain
 * strings. */
const DIR = "/fx";
const SHARED = `${DIR}/shared`;
const WORKTREE = `${DIR}/wt`;
const ELSEWHERE = `${DIR}/elsewhere`;

/** The hook's environment: CLAUDE_PROJECT_DIR names the shared tree. */
const ENV = { CLAUDE_PROJECT_DIR: SHARED };

const ports = (over: Partial<WalkPorts> = {}): WalkPorts => ({
	cwd: "/start",
	fallbackCwd: SHARED,
	vars: {},
	isDir: () => false,
	...over,
});

/** `fn`'s answer for each command the walk hands over, asked in the callback. */
const walkMap = <T>(
	command: string,
	fn: (cmd: Command) => T,
	over: Partial<WalkPorts> = {},
): T[] => {
	const out: T[] = [];
	walkCommands(parseCommand(command), (cmd) => out.push(fn(cmd)), ports(over));
	return out;
};

/** `printf '[%s]' "$@"`: each word bracketed, `[]` for none. */
const bracket = (words: string[]) =>
	words.length > 0 ? words.map((w) => `[${w}]`).join("") : "[]";

/** The segment, then the command's words, one call per line. */
const shown = (command: string, over: Partial<WalkPorts> = {}) =>
	walkMap(command, (c) => `${bracket([c.segment, ...c.words])}\n`, over).join(
		"",
	);

/** The words of each `git checkout` the walk hands over, for the
 * logical-line and heredoc cases. */
const checkouts = (command: string) =>
	walkMap(command, (c) => c.words).filter(
		(w) => w[0] === "git" && w[1] === "checkout",
	);

/** Whether some `git checkout` the walk hands over carries the word `evil`. */
const seesEvil = (command: string) =>
	checkouts(command).some((w) => w.includes("evil"));

describe("unmask", () => {
	it("puts a readable placeholder where a quoted span was", () => {
		expect(unmask(`git checkout ${QUOTED}`)).toBe('git checkout "…"');
	});

	it("replaces every span, not just the first", () => {
		expect(unmask(`a ${QUOTED} b ${QUOTED}`)).toBe('a "…" b "…"');
	});

	it("drops the leading whitespace the segment flattening leaves", () => {
		expect(unmask("   git status")).toBe("git status");
	});

	it("leaves a segment with no quoted span alone", () => {
		expect(unmask("git status")).toBe("git status");
	});

	it("eats the index the masker glues on, so no sentinel byte reaches a human (mantahostels#183)", () => {
		const out = unmask(`cd ${QUOTED}12\x01 && git commit`);
		expect(out).toBe('cd "…" && git commit');
		expect(out.includes("\u0001")).toBe(false);
	});

	it("emits no trailing newline of its own", () => {
		expect(unmask("x")).toBe("x");
	});
});

describe("normAbs (mantahostels#3315)", () => {
	it("drops a `.` segment", () => {
		expect(normAbs("/repo/./docs/a.md")).toBe("/repo/docs/a.md");
	});

	it("collapses a doubled slash", () => {
		expect(normAbs("/repo//docs///a.md")).toBe("/repo/docs/a.md");
	});

	it("pops the previous segment on `..`", () => {
		expect(normAbs("/repo/sub/../docs/a.md")).toBe("/repo/docs/a.md");
	});

	it("does not walk above the root", () => {
		expect(normAbs("/../../a.md")).toBe("/a.md");
	});

	it("strips a trailing slash", () => {
		expect(normAbs("/repo/docs/")).toBe("/repo/docs");
	});

	it("answers `/` for the root itself", () => {
		expect(normAbs("/")).toBe("/");
	});

	it("does not glob a segment named `*`", () => {
		expect(normAbs("/repo/*/a.md")).toBe("/repo/*/a.md");
	});

	it("keeps a segment holding a space", () => {
		expect(normAbs("/repo/my docs/./a.md")).toBe("/repo/my docs/a.md");
	});

	it("is textual — the path need not exist", () => {
		expect(normAbs("/nowhere/./x")).toBe("/nowhere/x");
	});

	it("emits no trailing newline of its own", () => {
		expect(normAbs("/a")).toBe("/a");
	});
});

describe("literal (mantahostels#284)", () => {
	/** literal over a string masked as parseCommand masks it. */
	const read = (text: string) => {
		const p = parseCommand(text);
		return literal(p.masked, p.spans);
	};

	it("puts a single-quoted span back verbatim", () => {
		expect(read("-f query='mutation{updateIssue}'")).toEqual({
			text: "-f query=mutation{updateIssue}",
			known: true,
		});
	});

	it("reads a word with no span at all straight through", () => {
		expect(literal("-f state=closed", [])).toEqual({
			text: "-f state=closed",
			known: true,
		});
	});

	it("keeps a $ inside a single-quoted span, which the shell would not expand", () => {
		expect(read("-f query='a $b c'")).toEqual({
			text: "-f query=a $b c",
			known: true,
		});
	});

	it("reports a double-quoted span carrying an expansion as only partly read", () => {
		expect(read('-f query="updateIssue($BODY)"')).toEqual({
			text: "-f query=updateIssue($BODY)",
			known: false,
		});
	});

	it("reports an unmasked $VAR as only partly read", () => {
		expect(literal("-f query=$Q", [])).toEqual({
			text: "-f query=$Q",
			known: false,
		});
	});

	it("reports a sentinel naming a span that was never recorded", () => {
		expect(literal(`x${QUOTED}9\x01`, []).known).toBe(false);
	});

	it("reads on from right after an unrecorded sentinel's prefix", () => {
		expect(literal(`x${QUOTED}9\x01y`, [])).toEqual({
			text: "x9\x01y",
			known: false,
		});
	});

	it("reads a sentinel with no index as no span at all", () => {
		expect(literal(`a${QUOTED}\x01b`, ['"s'])).toEqual({
			text: "a\x01b",
			known: false,
		});
	});

	it("reports an expansion standing before a span", () => {
		expect(literal(`$X${QUOTED}0\x01`, ["'a"])).toEqual({
			text: "$Xa",
			known: false,
		});
	});

	it("leaves the spans it reads as they were", () => {
		// Safe in a command substitution, the span count unmoved.
		const p = parseCommand("-f query='a b'");
		expect(literal(p.masked, p.spans).text).toBe("-f query=a b");
		expect(p.spans).toHaveLength(1);
	});
});

describe("walkCommands", () => {
	it("hands the callback the segment, then the command's own words", () => {
		expect(shown("gh issue edit 12")).toBe(
			"[gh issue edit 12][gh][issue][edit][12]\n",
		);
	});

	it.each([
		["a && b", "&&"],
		["a || b", "||"],
		["a ; b", ";"],
		["a | b", "a pipe"],
		["a & b", "a background &"],
		["(a) (b)", "parentheses, so a subshell cannot hide a command"],
	])("splits %s on %s", (command) => {
		expect(walkMap(command, (c) => c.words[0])).toEqual(["a", "b"]);
	});

	it("strips leading environment assignments from the words", () => {
		// The segment itself still carries it, because that is what a deny quotes
		// back.
		expect(shown("FOO=bar gh issue edit 12")).toBe(
			"[FOO=bar gh issue edit 12][gh][issue][edit][12]\n",
		);
	});

	it.each([
		["{ FOO=1 gh x; }", "{"],
		["! FOO=1 gh x", "!"],
		["if FOO=1 gh x; then :; fi", "if"],
		["if :; then FOO=1 gh x; fi", "then"],
		["if :; then :; else FOO=1 gh x; fi", "else"],
		["if :; then :; elif FOO=1 gh x; then :; fi", "elif"],
		["while FOO=1 gh x; do :; done", "while"],
		["until FOO=1 gh x; do :; done", "until"],
		["for i in 1; do FOO=1 gh x; done", "do"],
		["time FOO=1 gh x", "time"],
		["time -p FOO=1 gh x", "time -p"],
		["time -- FOO=1 gh x", "time --"],
		["coproc FOO=1 gh x", "coproc"],
		["FOO=1 exec gh x", "exec"],
		["FOO=1 exec -a name gh x", "exec -a"],
		["! { if FOO=1 gh x; then :; fi; }", "a run of them"],
	])(
		"hands over the command behind a leading reserved word or exec: %s (%s, #1013)",
		(command) => {
			// The assignment must come through as well as the command.
			const out = walkMap(
				command,
				(c) =>
					`${bracket(c.words)}\n${c.words[0] === "gh" && c.resolveWord("$FOO") === "1" ? "HARVESTED\n" : ""}`,
			).join("");
			expect(out).toContain("[gh][x]\nHARVESTED\n");
		},
	);

	it("runs nothing for an exec with no command", () => {
		expect(shown("exec")).toBe("");
	});

	it("harvests no assignment from an exec -a name", () => {
		// `-a` names argv[0], not a variable.
		expect(
			walkMap("exec -a FOO=1 gh x", (c) =>
				c.resolveWord("$FOO") === null ? "UNSET" : "SET",
			),
		).toEqual(["UNSET"]);
	});

	it("skips a segment that runs nothing", () => {
		expect(walkMap("gh api ;  ; gh api", (c) => c.words)).toHaveLength(2);
	});

	it("skips a segment that is only an assignment", () => {
		expect(shown("FOO=bar")).toBe("");
	});

	it("blanks a quoted span before the callback sees it", () => {
		// The blanking is what stops `echo "git checkout x"` reading as a checkout.
		const out = shown(`gh issue close 3 -c "hi there"`);
		expect(out).not.toContain("hi there");
		expect(out).toContain("[-c]");
	});

	it("treats a heredoc body as data, not as commands", () => {
		const out = shown("gh api <<'EOF'\ngit checkout evil\nEOF\ngh issue list");
		expect(out).not.toContain("[evil]");
		expect(out).toContain("[list]");
	});

	it("lets a callback accumulate across segments", () => {
		let n = 0;
		walkCommands(
			parseCommand("a && b && c"),
			() => {
				n++;
			},
			ports(),
		);
		expect(n).toBe(3);
	});
});

describe("Command.cwd — the directory the walk's command runs in (mantahostels#3453)", () => {
	/** `<command word>=<cwd>` per call, for a payload whose cwd is `from`. */
	const cwds = (
		command: string,
		from: string | null = "/start",
		vars: Record<string, string> = {},
	) =>
		walkMap(command, (c) => `${c.words[0]}=${c.cwd}`, {
			cwd: from ?? undefined,
			vars,
		});

	it("seeds from the payload's cwd, else this process's own", () => {
		expect(cwds("gh x")).toEqual(["gh=/start"]);
		expect(cwds("gh x", null)).toEqual([`gh=${SHARED}`]);
	});

	it("moves after a cd, absolute or relative, and not before the cd's own callback", () => {
		expect(cwds("cd /a && cd b/c && gh x")).toEqual([
			"cd=/start",
			"cd=/a",
			"gh=/a/b/c",
		]);
	});

	it("resolves a target through the command's own assignment, and a leading ~", () => {
		expect(cwds('D=/x; cd "$D" && gh x')).toEqual(["cd=/start", "gh=/x"]);
		expect(cwds("cd ~/n && gh x", "/start", { HOME: "/home/u" })).toEqual([
			"cd=/start",
			"gh=/home/u/n",
		]);
		// Quoted, the ~ is a directory of that name.
		expect(cwds("cd '~' && gh x").at(-1)).toBe("gh=/start/~");
	});

	it("ends a subshell's cd at its closing bracket", () => {
		expect(cwds("(cd /a && gh x); gh y")).toEqual([
			"cd=/start",
			"gh=/a",
			"gh=/start",
		]);
		expect(cwds("cd /a && echo $(cd /b) && gh y").at(-1)).toBe("gh=/a");
	});

	it.each([
		"cd -",
		"cd",
		"cd -P /a",
		"cd ~other",
		"pushd /a",
		"popd",
		"builtin cd /a",
		"command cd /a",
		'cd "$UNSET_3453"',
	])("makes the directory unknown after %s", (lead) => {
		expect(cwds(`${lead}; gh x`).at(-1)).toBe("gh=");
	});

	it('keeps the directory through cd "", which stays put (#301)', () => {
		expect(cwds('cd ""; gh x').at(-1)).toBe("gh=/start");
	});

	it("keeps the directory through a case pattern's unopened )", () => {
		expect(cwds("cd /a; case x in x) true;; esac; gh x").at(-1)).toBe("gh=/a");
	});

	it("keeps an unknown directory unknown through a relative cd", () => {
		expect(cwds("cd -; cd b; gh x").at(-1)).toBe("gh=");
	});

	it("hands a nested walk's caller back its own cwd and assignments", () => {
		// commit-form's listRewritten walks again from inside walkGit's
		// callback (mantahostels#3327).
		const parsed = parseCommand('D=/x; cd /a; gh x; cd "$D"; gh y');
		const seen: string[] = [];
		walkCommands(
			parsed,
			(c) => {
				walkCommands(
					parsed,
					() => {
						// The inner walk only has to run.
					},
					ports(),
				);
				seen.push(`${c.words[0]}=${c.cwd}`);
			},
			ports(),
		);
		expect(seen).toEqual(["cd=/start", "gh=/a", "cd=/a", "gh=/x"]);
	});
});

describe("Command.redirects — redirections out of the words and into a lookup (#1488)", () => {
	/** Per command: its words, then one `fd kind target path` line per
	 * redirection, the target read back through literal. */
	const redirs = (command: string, bare = false, from = "/start") => {
		const parsed = parseCommand(command);
		let out = "";
		walkCommands(
			parsed,
			(c) => {
				out += `${bracket(c.words)}\n`;
				for (const r of c.redirects())
					out += `  ${r.fd} ${r.kind} ${literal(r.target, parsed.spans).text} ${r.path || "<none>"}\n`;
			},
			ports({ cwd: from, bareRedirects: bare }),
		);
		return out;
	};

	it.each([
		[
			"git push origin main 2>&1",
			"[git][push][origin][main]\n  2 copy 1 <none>\n",
		],
		["echo hi >| out.txt", "[echo][hi]\n  1 clobber out.txt /start/out.txt\n"],
		[
			"npm test &> log.txt",
			"[npm][test]\n  & truncate log.txt /start/log.txt\n",
		],
		["echo x 1>&2", "[echo][x]\n  1 copy 2 <none>\n"],
	])(
		"reads %s as one command, where the old split made a fake second one",
		(command, expected) => {
			expect(redirs(command)).toBe(expected);
		},
	);

	it.each([
		["cat > o", "1 truncate o /start/o"],
		["cat >> o", "1 append o /start/o"],
		["cat >| o", "1 clobber o /start/o"],
		["cat < i", "0 read i /start/i"],
		["cat 3<> f", "3 read-write f /start/f"],
		["cat &> o", "& truncate o /start/o"],
		["cat &>> o", "& append o /start/o"],
		["cat >&o", "& truncate o /start/o"],
		["cat 2>&1", "2 copy 1 <none>"],
		["cat 0<&3", "0 copy 3 <none>"],
		["cat 3>&-", "3 close - <none>"],
		["cat 4<&-", "4 close - <none>"],
		["cat 6>&3-", "6 copy 3- <none>"],
		["cat {fd}> o", "{fd} truncate o /start/o"],
		['cat <<< "a b"', "0 here-string a b <none>"],
		["cat <<'EOF'\nbody\nEOF", "0 heredoc EOF <none>"],
		["cat <<-EOF\nbody\nEOF", "0 heredoc EOF <none>"],
	])("takes %s out of the words and reports it", (command, line) => {
		expect(redirs(command)).toBe(`[cat]\n  ${line}\n`);
	});

	it("cuts a word an operator sits inside, as bash does", () => {
		expect(redirs("echo hi>out 2>/dev/null")).toBe(
			"[echo][hi]\n  1 truncate out /start/out\n  2 truncate /dev/null /dev/null\n",
		);
	});

	it("takes a redirection off before the command word", () => {
		expect(redirs("2>/dev/null FOO=1 gh x")).toBe(
			"[gh][x]\n  2 truncate /dev/null /dev/null\n",
		);
	});

	it("resolves a target through the cwd and the command's own assignments, and leaves an unknown one empty", () => {
		expect(redirs("cd sub && echo > x")).toContain("1 truncate x /start/sub/x");
		expect(redirs('D=/d; echo > "$D/x"')).toContain("1 truncate $D/x /d/x");
		expect(redirs("echo > $(mktemp)", true)).toContain("1 truncate $ <none>");
		expect(redirs("echo > $UNSET_FOR_TEST/x")).toContain(
			"1 truncate $UNSET_FOR_TEST/x <none>",
		);
	});

	it("reads >&$fd through the value it was given", () => {
		expect(redirs("F=3; echo >&$F")).toContain("1 copy $F <none>");
		expect(redirs("F=f; echo >&$F")).toContain("& truncate $F /start/f");
	});

	it("leaves a > or < inside [[ … ]] and arithmetic as words", () => {
		expect(redirs("[[ a > b ]] > out")).toBe(
			"[[[][a][>][b][]]]\n  1 truncate out /start/out\n",
		);
		expect(redirs("[[ a > b && c < d ]]")).toBe(
			"[[[][a][>][b]\n[c][<][d][]]]\n",
		);
		expect(redirs("echo $((x>5))")).toBe("[echo][$]\n[x>5]\n");
	});

	it("redirects an unescaped > in [ and test, as bash does, and keeps an escaped one a word", () => {
		expect(redirs("[ a > b ]")).toBe("[[][a][]]\n  1 truncate b /start/b\n");
		expect(redirs("test a \\> b")).toBe("[test][a][\\>][b]\n");
	});

	it("keeps a process substitution's split, dropping its bare operator", () => {
		expect(redirs("diff <(a) <(b)")).toBe("[diff]\n[a]\n[b]\n");
		expect(redirs("cmd 2> >(tee e)")).toBe("[cmd]\n[tee][e]\n");
		expect(redirs("done < <(ls)", true)).toBe("[done]\n[ls]\n");
	});

	it("reads a spaced nested subshell as commands, and a command substitution inside arithmetic as one", () => {
		expect(redirs("( (echo hi > out) )")).toBe(
			"[echo][hi]\n  1 truncate out /start/out\n",
		);
		expect(redirs("echo $(( $(wc -l < f) > 5 ))", true)).toBe(
			"[echo][$]\n[$]\n[wc][-l]\n  0 read f /start/f\n[>][5]\n",
		);
	});

	it("hands a command of redirections alone only to a walk asking for it", () => {
		expect(redirs("> o; exec 3> log")).toBe("");
		expect(redirs("> o; exec 3> log", true)).toBe(
			"[]\n  1 truncate o /start/o\n[]\n  3 truncate log /start/log\n",
		);
	});

	it("reads #1007's --queue behind a 2>&1 as the same command's word", () => {
		expect(redirs("npm run test 2>&1 -- --queue | tail -5")).toBe(
			"[npm][run][test][--][--queue]\n  2 copy 1 <none>\n[tail][-5]\n",
		);
	});
});

describe("Command.writeTargets — every write spelling the guard tier reads (#1827)", () => {
	/** What `print` makes of each command's write targets, under a bare-redirect
	 * walk from /start. */
	const answer = (
		print: (
			rows: ReturnType<Command["writeTargets"]>,
			spans: string[],
		) => string,
		command: string,
	) => {
		const parsed = parseCommand(command);
		return walkMap(command, (c) => print(c.writeTargets(), parsed.spans), {
			bareRedirects: true,
		}).join("");
	};

	/** One `mode target path` line per target, the target read back through
	 * literal. */
	const targets = (command: string) =>
		answer(
			(rows, spans) =>
				rows
					.map(
						(r) =>
							`${r.mode} ${literal(r.target, spans).text} ${r.path || "<none>"}\n`,
					)
					.join(""),
			command,
		);

	it.each([
		["echo x > o", "write o /start/o\n"],
		["tee -a o p", "write o /start/o\nwrite p /start/p\n"],
		["cp a b", "write b /start/b\n"],
		["mv a b", "move-source a /start/a\nwrite b /start/b\n"],
		["mv -S .bak a b", "move-source a /start/a\nwrite b /start/b\n"],
		["cp a b /d", "write /d/a /d/a\nwrite /d/b /d/b\n"],
		["cp a ./", "write ./a /start/a\n"],
		["cp $UNSET_FOR_TEST/a.md /d/", "write /d/a.md /d/a.md\n"],
		["cp a b /d/", "write /d/a /d/a\nwrite /d/b /d/b\n"],
		["cp -t /d a", "write /d/a /d/a\n"],
		["sed -i -e s/a/b/ f", "write f /start/f\n"],
		["sed -e s/a/b/ f", ""],
		["perl -Ilib -pe 1 f", ""],
		["truncate -s 0 f", "write f /start/f\n"],
		["git restore f", "write f /start/f\n"],
		["git restore --staged f", ""],
		["git checkout -- f", "write f /start/f\n"],
		["git checkout f", ""],
		["rm -f -- -x", "delete -x /start/-x\n"],
		["git mv a b", "delete a /start/a\ndelete b /start/b\n"],
	])("reads %s as its write and delete targets", (command, expected) => {
		expect(targets(command)).toBe(expected);
	});

	it("resolves a target through the cwd and the command's own assignments, and leaves an unknown one empty", () => {
		expect(targets("cd sub && tee x")).toBe("write x /start/sub/x\n");
		// The slash sits inside the quoted span, out of reach of the join, so the
		// text doubles it; the path folds it.
		expect(targets('D=/d; cp a "$D/"')).toBe("write $D//a /d/a\n");
		expect(targets('cp "$UNSET_FOR_TEST" /d/')).toBe(
			"write /d/$UNSET_FOR_TEST /d/$UNSET_FOR_TEST\n",
		);
		expect(targets("tee $UNSET_FOR_TEST/x")).toBe(
			"write $UNSET_FOR_TEST/x <none>\n",
		);
	});

	it("reads a heredoc's redirect and not its body", () => {
		expect(targets("cat > o <<'EOF'\ntee p\nEOF")).toBe("write o /start/o\n");
	});

	it.each([
		["echo x > o", "redirect"],
		["cp a b > log", "redirect\ncp"],
		["git restore -- f", "git restore"],
		["/usr/bin/git checkout -- f", "git checkout"],
	])(
		"names the route that read each row of %s (#2142)",
		(command, expected) => {
			// One line per row, or one empty.
			const routes = answer(
				(rows) =>
					rows.length > 0 ? rows.map((r) => `${r.route}\n`).join("") : "\n",
				command,
			);
			expect(routes).toBe(`${expected}\n`);
		},
	);
});

describe("path resolution", () => {
	/**
	 * The tree each `git checkout` the walk hands over would be judged in,
	 * walked from an unrelated directory so only the cd or the `-C` word can
	 * reach the shared tree: the `-C` word (absolute in every case below)
	 * through the command's own resolveWord, else the walk's cwd. null where it
	 * will not resolve — the walk's "could not resolve the working tree"
	 * record — and false for a command that is no checkout.
	 */
	const treeOf = (c: Command): string | null | false => {
		const [head, flag, value, sub] = c.words;
		if (head !== "git") return false;
		if (flag === "-C") return sub === "checkout" && c.resolveWord(value ?? "");
		return flag === "checkout" && (c.cwd || null);
	};

	const trees = (command: string, vars: Record<string, string> = ENV) =>
		walkMap(command, treeOf, { cwd: ELSEWHERE, vars }).filter(
			(t) => t !== false,
		);

	const tree = (command: string, vars?: Record<string, string>) => {
		const all = trees(command, vars);
		expect(all).toHaveLength(1);
		return all[0];
	};

	it("resolves a cd target that was quoted but fully literal (mantahostels#183)", () => {
		expect(tree(`cd "${SHARED}" && git checkout x`)).toBe(SHARED);
	});

	it("resolves a single-quoted literal cd target", () => {
		expect(tree(`cd '${SHARED}' && git checkout x`)).toBe(SHARED);
	});

	it("expands an environment variable in a cd target", () => {
		expect(tree('cd "$CLAUDE_PROJECT_DIR" && git checkout x')).toBe(SHARED);
	});

	it("expands the braced spelling as well as the bare name", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the point of the case — rewriting them would test the bare form twice.
		expect(tree('cd "${CLAUDE_PROJECT_DIR}" && git checkout x')).toBe(SHARED);
	});

	it("expands a variable in git -C", () => {
		expect(tree('git -C "$CLAUDE_PROJECT_DIR" checkout x')).toBe(SHARED);
	});

	it("expands a variable that is only part of the path", () => {
		expect(
			tree('cd "$WFC_ROOT/shared" && git checkout x', {
				...ENV,
				WFC_ROOT: DIR,
			}),
		).toBe(SHARED);
	});

	it("resolves a linked worktree reached through a variable", () => {
		// The tree resolves, so nothing is recorded. Exempting the worktree
		// is #2785's tree scope.
		expect(
			tree('cd "$WFC_WT" && git checkout x', { ...ENV, WFC_WT: WORKTREE }),
		).toBe(WORKTREE);
	});

	/*
	 * Variables the command string assigns to ITSELF (mantahostels#208). The
	 * assignment happens inside the Bash call, so the hook's own environment
	 * never sees it.
	 */
	it("resolves a variable the command assigned on the same line (mantahostels#208)", () => {
		expect(tree(`WT=${WORKTREE} && git -C "$WT" checkout x`)).toBe(WORKTREE);
	});

	it("resolves through an assignment that names the shared tree", () => {
		expect(tree(`WT=${SHARED} && git -C "$WT" checkout x`)).toBe(SHARED);
	});

	it("resolves the sanctioned recipe end to end (mantahostels#301)", () => {
		expect(
			tree(
				'WT=$WFC_ROOT/fresh && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side2',
				{ ...ENV, WFC_ROOT: DIR },
			),
		).toBe(`${DIR}/fresh`);
	});

	it("resolves an assignment reached through a cd rather than git -C", () => {
		expect(tree(`WT=${SHARED} && cd "$WT" && git checkout x`)).toBe(SHARED);
	});

	it("lets an assignment shadow the environment, as shell does", () => {
		expect(
			tree(`WFC_WT=${SHARED} && git -C "$WFC_WT" checkout x`, {
				...ENV,
				WFC_WT: WORKTREE,
			}),
		).toBe(SHARED);
	});

	it("reads an assignment prefixed onto the command itself", () => {
		expect(tree(`WT=${SHARED} git -C "$WT" checkout x`)).toBe(SHARED);
	});

	it("sees an assignment only from the commands after it", () => {
		expect(tree(`git -C "$WT" checkout x && WT=${SHARED}`)).toBeNull();
	});

	it("refuses an assignment from command substitution (mantahostels#183)", () => {
		expect(tree('WT=$(mktemp -d) && git -C "$WT" checkout x')).toBeNull();
	});

	it("refuses a name assigned twice with different values", () => {
		expect(
			tree(`WT=${SHARED}; WT=${WORKTREE}; git -C "$WT" checkout x`),
		).toBeNull();
	});

	it("harvests nothing at or after a string's first ||", () => {
		expect(
			tree(`[ -d ${WORKTREE} ] || WT=${SHARED}; git -C "$WT" checkout x`),
		).toBeNull();
	});

	it("kills a name reassigned after a ||, rather than keeping the first value", () => {
		expect(
			tree(`WT=${WORKTREE}; false || WT=${SHARED}; git -C "$WT" checkout x`),
		).toBeNull();
	});

	it("harvests an assignment before the first ||, which a || cannot skip (#328)", () => {
		expect(
			tree(`WT=${SHARED} && [ -d "$WT" ] || exit 1; git -C "$WT" checkout x`),
		).toBe(SHARED);
	});

	it("counts the segments a subshell and a case arm add ahead of the || (#319's shape)", () => {
		expect(
			tree(
				`WT=${SHARED} && S=m && (true) && case "$S" in *) [ -n "$S" ] || exit 1;; esac && git -C $WT checkout x`,
			),
		).toBe(SHARED);
	});

	it("ignores a || inside a quoted span when counting", () => {
		expect(
			tree(`WT=${SHARED}; echo "a || b"; X=1 || true; git -C "$WT" checkout x`),
		).toBe(SHARED);
	});

	it("does not fall back to the environment for a name it refused", () => {
		expect(
			tree('WFC_WT=$(mktemp -d) && git -C "$WFC_WT" checkout x', {
				...ENV,
				WFC_WT: WORKTREE,
			}),
		).toBeNull();
	});

	it("does not expand a variable inside single quotes", () => {
		expect(tree(`cd '$CLAUDE_PROJECT_DIR' && git checkout x`)).toBeNull();
	});

	it("refuses command substitution rather than resolving it", () => {
		expect(tree('cd "$(mktemp -d)" && git checkout x')).toBeNull();
	});

	it("refuses a brace-operator form even when the variable is set", () => {
		const command =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the operator inside them is exactly what must not be expanded.
			'cd "${CLAUDE_PROJECT_DIR:-/tmp}" && git checkout x';
		expect(tree(command)).toBeNull();
	});

	it("refuses a variable whose value carries whitespace", () => {
		expect(
			tree('cd "$WFC_ODD" && git checkout x', {
				...ENV,
				WFC_ODD: `${DIR} spaced`,
			}),
		).toBeNull();
	});

	it("refuses a variable whose value carries a shell metacharacter", () => {
		expect(
			tree('cd "$WFC_ODD" && git checkout x', {
				...ENV,
				WFC_ODD: `${DIR}/$(id)`,
			}),
		).toBeNull();
	});

	it("refuses a variable that is set but empty", () => {
		expect(
			tree('cd "$WFC_EMPTY" && git checkout x', { ...ENV, WFC_EMPTY: "" }),
		).toBeNull();
	});

	it("reads an empty cd path as the cwd, which is where the shell leaves it (#301)", () => {
		expect(tree('cd "" && git checkout x')).toBe(ELSEWHERE);
		expect(tree(`cd "${SHARED}" && cd "" && git checkout x`)).toBe(SHARED);
	});

	it("reads a quote nested in the other kind as literal, as shell does (#490)", () => {
		// `"'a'"` is one double-quoted span holding two apostrophes, so the cd
		// target is a directory named with them — never the shared tree.
		expect(tree(`cd "'${SHARED}'" && git checkout x`)).toBe(
			`${ELSEWHERE}/'${SHARED}'`,
		);
	});

	it("leaves an unterminated quote alone", () => {
		// A lone quote is not a span; every guard must see the same command shape.
		expect(shown(`git commit -m "unterminated`)).toContain('["unterminated]');
	});
});

/*
 * Logical lines (mantahostels#182). Physical lines are still the unit for
 * heredoc detection; only the masking and the segment split moved to logical
 * ones.
 */
describe("logical lines (mantahostels#182)", () => {
	const lines = (command: string) => shown(command).trim().split("\n");

	it("keeps a multi-line quoted argument on one segment with what follows it", () => {
		const command = 'git commit -m "Subject line\n\nBody." -- a.md';
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--][a.md]");
	});

	it("joins on a single-quoted argument too, not only a double-quoted one", () => {
		const command = "git commit -m 'Subject line\n\nBody.' -- a.md";
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--][a.md]");
	});

	it("blanks a metacharacter inside a multi-line quoted argument", () => {
		const command = 'git commit -m "Subject\n\nBody (x); y." -- a.md';
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).not.toContain("[y.]");
	});

	it("joins across a heredoc body, which is not part of the command", () => {
		const command =
			"git commit -m \"$(cat <<'EOF'\nSubject\n\nBody.\nEOF\n)\" -- a.md";
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--][a.md]");
		expect(shown(command)).not.toContain("Subject");
	});

	it("joins a `\\` continuation into one segment (#490)", () => {
		const command = "git commit \\\n  -m x \\\n  -- a.md";
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--][a.md]");
	});

	it("never continues a comment, so the next line is still a command", () => {
		for (const command of [
			"# see the note \\\ngit checkout -b evil",
			"echo hi # trailing \\\ngit checkout -b evil",
		]) {
			expect(shown(command)).toContain("[git][checkout]");
		}
	});

	it("reads $$ as the pid, so the quote after it takes no escapes", () => {
		expect(shown("echo $$'a\\' ; git checkout -b evil ; echo 'x'")).toContain(
			"[git][checkout]",
		);
	});

	it("keeps one quote kind literal inside the other and honours escapes", () => {
		const command =
			'gh issue create --title "burn mode\'s \\"off\\"" --body "$(cat <<\'EOF\'\nsee "x" (and a stray ) too)\nEOF\n)" --label takes:triage';
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--label][takes:triage]");
	});

	it("leaves a quote that never closes reading line by line", () => {
		// A stray apostrophe is not a multi-line string.
		expect(checkouts("echo it's fine\ngit checkout evil")).toEqual([
			["git", "checkout", "evil"],
		]);
	});

	it.each([
		['\\"', "double"],
		["\\'", "single"],
	])(
		"declines to join anything once %s appears — an escaped %s quote",
		(escaped) => {
			expect(
				seesEvil(`echo ${escaped}\ngit checkout -b evil\necho ${escaped}`),
			).toBe(true);
		},
	);

	it.each([
		["two apostrophes in prose", "echo it's fine", "echo that's all"],
		["ANSI-C quoting", "echo $'a", "echo x'"],
		["an even count of unclosed double quotes", 'echo "a', 'echo x"'],
	])("keeps the command visible through %s", (_label, before, after) => {
		expect(seesEvil(`${before}\ngit checkout -b evil\n${after}`)).toBe(true);
	});

	it("keeps a gh command visible too, not only a git one", () => {
		const heads = walkMap(
			"echo it's fine\ngh issue edit 5 --body x\necho that's all",
			(c) => c.words[0],
		);
		expect(heads).toContain("gh");
	});

	it("checks every segment of an absorbed line, not just its first word", () => {
		expect(
			seesEvil("echo it's fine\nfoo; git checkout -b evil\necho that's all"),
		).toBe(true);
	});

	it("keeps the join through a message body that reads as a command (mantahostels#232)", () => {
		const command =
			'git commit -m "Subject\n\ngit add is banned here." -- a.md';
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[--][a.md]");
	});

	it.each([
		["-m", 'git commit -m "Subject'],
		["--message", 'git commit --message "Subject'],
		["--message=", 'git commit --message="Subject'],
		["gh --body", 'gh issue comment 1 --body "Subject'],
	])("reads a command named in a %s argument as prose", (_label, opener) => {
		expect(
			checkouts(`${opener}\n\ngit checkout -b x is denied." -- a.md`),
		).toEqual([]);
	});

	it("reads a message opening with an apostrophe in it", () => {
		expect(
			checkouts(
				'git commit -m "It\'s a subject\n\ngit checkout -b x is denied." -- a.md',
			),
		).toEqual([]);
	});

	it("finds the message flag when the commit is not the first command", () => {
		expect(
			checkouts(
				'echo start && git commit -m "Subject\n\ngit checkout -b x is denied." -- a.md',
			),
		).toEqual([]);
	});

	it("does not treat a CLOSED line as an open message", () => {
		expect(
			seesEvil(
				"git commit -m \"don't\" 'a'\ngit checkout -b evil\necho \"b'c\"",
			),
		).toBe(true);
	});

	it.each([["if"], ["then"]])(
		"keeps the join through a prose line opening %s git (#1013)",
		(word) => {
			expect(
				lines(
					`node scripts/issue-body.js comment 1 "first line\n${word} git commit --no-verify is run, the gate fires\nend"`,
				),
			).toHaveLength(1);
		},
	);

	it("reads the message of a commit behind a reserved word as prose (#1013)", () => {
		expect(
			checkouts(
				'if true; then git commit -m "Subject\n\ngit checkout -b x is denied." -- a.md; fi',
			),
		).toEqual([]);
	});

	it("still gives up the join when the open quote is not a message argument", () => {
		expect(seesEvil('echo "Subject\n\ngit checkout -b evil\n" ')).toBe(true);
	});

	it("still gives up the join on a flag that is not a message flag", () => {
		expect(
			seesEvil(
				'git commit --author "Someone\n\ngit checkout -b evil\n" -- a.md',
			),
		).toBe(true);
	});

	it("hands over a real branch move that follows a closed message", () => {
		expect(
			checkouts(
				'git commit -m "Subject\n\ngit add is banned here." -- a.md\ngit checkout -b real',
			).some((w) => w.includes("real")),
		).toBe(true);
	});

	it("falls back to per-line when a message quote never closes", () => {
		// The fail-CLOSED net behind the message test: believing a message is open
		// forever must not hide the commands inside it.
		expect(seesEvil('git commit -m "Subject\n\ngit checkout -b evil')).toBe(
			true,
		);
	});

	it("keeps a body's join through a phrase it quotes inside `$(cat <<'EOF'` (#510)", () => {
		expect(
			seesEvil(
				'gh issue create --title t --body "$(cat <<\'EOF\'\nSee "the phrase" here.\ngit checkout -b evil\nEOF\n)"',
			),
		).toBe(false);
	});

	it("opens no heredoc on a `<<` inside such a body, after a lone quote", () => {
		expect(
			seesEvil(
				'gh issue create --title t --body "$(cat <<\'EOF\'\nA lone " quote.\nThen cat << EOF2 in prose.\nEOF\n)"\ngit checkout -b evil',
			),
		).toBe(true);
	});

	it("reads a `$'…'` inside a `$(…)` with its escapes (#510)", () => {
		const command = "git commit -m \"$(printf $'it\\'s')\" -- a.md";
		expect(lines(command)).toHaveLength(1);
		expect(shown(command)).toContain("[commit][-m]");
		expect(shown(command)).toContain("[--][a.md]");
	});

	const prose = (n: number, line: (i: number) => string) =>
		Array.from({ length: n }, (_, i) => line(i)).join("\n");
	it.each([
		[
			"a 60-line message body",
			`gh issue create --title t --body "$(cat <<'EOF'\n${prose(60, (i) => (i % 7 ? `Line ${i} of the body.` : `- it's "quoted" (${i})`))}\nEOF\n)" --label takes:triage`,
		],
		[
			"a 60-line body that is no message, each line asked whether it runs a command",
			`echo "${prose(60, (i) => `Line ${i} goes through, high and right enough.`)}" --label takes:triage`,
		],
		[
			"a 40 KB body on one physical line",
			`gh issue create --title t --body "${`it's \\"q\\" line. `.repeat(2500)}" --label takes:triage`,
		],
	])("joins %s (#510)", (_, command) => {
		const out = lines(command);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("[--label][takes:triage]");
	});

	it("resolves a path argument after a joined line", () => {
		// A join given up re-masks its lines one by one, so the attempt must leave
		// no span behind — an off-by-one in the spans would make the cd
		// unresolvable and fail open silently.
		expect(
			walkMap(
				`echo "a\n\nb"\ncd "${SHARED}" && git checkout x`,
				(c) => (c.words[0] === "git" ? c.cwd : undefined),
				{ cwd: ELSEWHERE },
			).filter(Boolean),
		).toEqual([SHARED]);
	});
});

/*
 * Heredoc openers (mantahostels#201). A heredoc body is dropped as data, so a
 * `<<` read as an opener where the shell reads none takes every command after
 * it out of the sight of every guard that walks a command string.
 */
describe("heredoc openers (mantahostels#201)", () => {
	it.each([
		["a double-quoted string", 'echo "a\nb << EOF\nc"'],
		["a single-quoted string", "echo 'a\nb << EOF\nc'"],
		["the tab-stripping <<- form", 'echo "a\nb <<- EOF\nc"'],
		["a quoted delimiter", "echo \"a\nb <<'EOF'\nc\""],
	])("opens no heredoc from a << inside %s", (_label, prefix) => {
		expect(seesEvil(`${prefix}\ngit checkout -b evil`)).toBe(true);
	});

	it("names each body and terminator line in heredocLines (#2384)", () => {
		const at = (command: string) => parseCommand(command).heredocLines;
		expect(at("cat <<'EOF'\na & b\nEOF\nnpm test")).toEqual([1, 2]);
		expect(at("gh api <<EOF\nx\nEOF\ngh api <<E2\ny\nE2")).toEqual([
			1, 2, 4, 5,
		]);
		expect(at('echo "a\nb << EOF\nc"\ntrue')).toEqual([]);
	});

	it("still opens one from a << outside any string", () => {
		// The control for the four above: suppressing every opener would pass them
		// while reading heredoc bodies as commands.
		const out = shown("gh api <<EOF\ngit checkout evil\nEOF\ngh issue list");
		expect(out).not.toContain("[evil]");
		expect(out).toContain("[list]");
	});

	it("closes the carried span, so a later heredoc still opens", () => {
		expect(
			checkouts('echo "a\nb"\ngh api <<EOF\ngit checkout -b evil\nEOF'),
		).toEqual([]);
	});

	it("ends the carry at an opener, so a quote after the << leaks no further", () => {
		expect(
			checkouts(
				"gh api <<EOF   # don't\nx\nEOF\ngh api <<EOF2\ngit checkout -b evil\nEOF2",
			),
		).toEqual([]);
	});

	it("reads a heredoc body's own quotes as data, not as an open string", () => {
		expect(
			checkouts(
				"gh api <<EOF\nit's fine\nEOF\ngh api <<EOF\ngit checkout -b evil\nEOF",
			),
		).toEqual([]);
	});

	it("invents no opener by closing up the text a span leaves behind", () => {
		// `a<"x"<b` would read as `a<<b` if a blanked span became nothing at all.
		expect(seesEvil('echo a<"x"<b\ngit checkout -b evil')).toBe(true);
	});

	it("leaves an unterminated heredoc swallowing its tail, as the shell does", () => {
		expect(checkouts("gh api <<EOF\ngit checkout -b evil")).toEqual([]);
	});
});

/*
 * ---------------------------------------------------------------------------
 * The git walk (#2785): the tree class is the fake over the /fx stand-ins, and
 * every fail-open record is a call to a `log` stub.
 * ---------------------------------------------------------------------------
 */

/** A `.git` naming a gitdir that is gone: git cannot answer for it. */
const BROKEN = `${DIR}/broken-repo`;

/** The tree class of each /fx stand-in. */
const treeClass: GitWalkPorts["treeClass"] = fakeTreeClassifier({
	[SHARED]: "shared",
	[WORKTREE]: "linked",
	[BROKEN]: "unknown",
});

/** The record the walk writes for a checkout whose tree did not resolve. */
const FAIL_OPEN =
	"could not resolve the working tree for a git checkout — branch move allowed unchecked";

interface GitWalkRun {
	/** One `[segment][sub][tree][arg]…` line per call. */
	out: string;
	calls: GitCall[];
	/** Each record's text. */
	logged: string[];
	/** Each record's detail, "" where it has none (#320). */
	details: string[];
}

/** Every call a git walk made, judged from `cwd`, the hook's own directory. */
const walkGitRun = (
	command: string,
	opts: Partial<GitWalkOpts> = {},
	cwd = SHARED,
	vars: Record<string, string> = ENV,
): GitWalkRun => {
	const run: GitWalkRun = { out: "", calls: [], logged: [], details: [] };
	walkGit(
		parseCommand(command),
		(call) => {
			run.calls.push(call);
			run.out += `${bracket([call.segment, call.sub, call.tree, ...call.args])}\n`;
		},
		{
			...ports({ fallbackCwd: cwd, vars }),
			treeClass,
			log: (what, detail) => {
				run.logged.push(what);
				run.details.push(detail ?? "");
			},
		},
		{
			subs: ["checkout", "switch"],
			noun: "branch move",
			scope: "shared",
			...opts,
		},
	);
	return run;
};

const repoWalk = (command: string, cwd?: string) =>
	walkGitRun(command, { scope: "repo" }, cwd);

describe('walkGit, scope "repo" — the same walk, widened past the shared tree (mantahostels#1213)', () => {
	it("calls back in a linked worktree, which the shared walk filters out", () => {
		expect(walkGitRun("git checkout x", {}, WORKTREE).out).toBe("");
		expect(repoWalk("git checkout x", WORKTREE).out).toBe(
			`[git checkout x][checkout][${WORKTREE}][x]\n`,
		);
	});

	it("still calls back in the shared tree", () => {
		expect(repoWalk("git checkout x").out).toContain(`[checkout][${SHARED}]`);
	});

	it("still filters out an unrelated repository", () => {
		expect(repoWalk("git checkout x", ELSEWHERE).out).toBe("");
	});

	it("records the same fail-open when the tree cannot be resolved", () => {
		const r = repoWalk('cd "$SOMEWHERE" && git checkout x');
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	});
});

describe('walkGit, scope "shared"', () => {
	it("hands the callback the segment, subcommand, tree and arguments", () => {
		expect(walkGitRun("git checkout -b feature").out).toBe(
			`[git checkout -b feature][checkout][${SHARED}][-b][feature]\n`,
		);
	});

	it("reads git through a path to its binary, as basename does", () => {
		expect(walkGitRun("/usr/bin/git checkout x").out).toBe(
			`[/usr/bin/git checkout x][checkout][${SHARED}][x]\n`,
		);
	});

	it("calls back only for the subcommands the guard asked for", () => {
		const r = walkGitRun("git status && git checkout x && git commit -m y");
		expect(r.calls).toHaveLength(1);
		expect(r.out).toContain("[checkout]");
	});

	it("resolves the tree through a cd, and never calls back for the cd", () => {
		const r = walkGitRun(`cd ${WORKTREE} && git checkout x`, {}, ELSEWHERE);
		// The worktree is a linked one, so it is exempt.
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
	});

	it("judges against the outer tree once a subshell's cd has ended (mantahostels#3453)", () => {
		expect(
			walkGitRun(`(cd ${WORKTREE} && true); git checkout x`).out,
		).toContain(`[checkout][${SHARED}]`);
		expect(
			walkGitRun("case x in x) true;; esac; git checkout x").out,
		).toContain(`[checkout][${SHARED}]`);
	});

	it("expands a leading ~ in git -C (mantahostels#3453)", () => {
		const r = walkGitRun("git -C ~/shared checkout x", {}, ELSEWHERE, {
			HOME: DIR,
		});
		expect(r.out).toContain(`[checkout][${DIR}/shared]`);
	});

	it("judges against the tree git -C names", () => {
		const r = walkGitRun(`git -C ${SHARED} checkout x`, {}, ELSEWHERE);
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	it("filters out a linked worktree of the same repo", () => {
		expect(walkGitRun("git checkout x", {}, WORKTREE).out).toBe("");
	});

	it("filters out an unrelated repository", () => {
		expect(walkGitRun("git checkout x", {}, ELSEWHERE).out).toBe("");
	});

	it("records a fail-open when the tree cannot be resolved", () => {
		// An unexpanded variable in the cd target.
		const r = walkGitRun('cd "$SOMEWHERE" && git checkout x');
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	});

	it("records nothing for a tree judged as no repo of this one (mantahostels#253, mantahostels#208)", () => {
		// git-tree.test.ts proves a directory in no repository and a path with
		// nothing at it both class `other`; the walk records neither.
		const r = walkGitRun(`cd ${DIR}/not-a-repo && git checkout x`);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
	});

	it("still records a tree git could not answer for (mantahostels#253)", () => {
		const r = walkGitRun(`cd ${BROKEN} && git checkout x`);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([
			`git could not answer for ${BROKEN} — a git checkout there was allowed unchecked`,
		]);
	});

	it("records nothing for a subcommand the guard never asked about", () => {
		const r = walkGitRun('cd "$SOMEWHERE" && git status');
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
	});

	it("agrees with walkCommands over one parse", () => {
		const parsed = parseCommand("git checkout x && gh issue list && ls");
		const calls: string[] = [];
		walkGit(
			parsed,
			(c) => calls.push(bracket([c.sub, c.tree])),
			{ ...ports(), treeClass, log: () => undefined },
			{ subs: ["checkout"], noun: "branch move", scope: "shared" },
		);
		walkCommands(parsed, (c) => calls.push(bracket(c.words)), ports());
		expect(calls).toEqual([
			`[checkout][${SHARED}]`,
			"[git][checkout][x]",
			"[gh][issue][list]",
			"[ls]",
		]);
	});

	it("seeds from the hook's own directory, not the payload's cwd", () => {
		// walkGit seeds from fallbackCwd, where walkCommands reads `cwd` first.
		const r = walkGitRun("git checkout x");
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	it("matches the subcommand as written, so a quoted one is not asked for", () => {
		expect(walkGitRun('git "checkout" x').calls).toEqual([]);
	});

	it("hands the arguments over raw, still masked", () => {
		const [call] = walkGitRun('git checkout -m "a b"').calls;
		expect(call?.args[1]).toContain(QUOTED);
	});

	it("judges a git command behind a wrapper only under unwrap (#1731)", () => {
		expect(walkGitRun("env X=1 git checkout x").calls).toEqual([]);
		expect(
			walkGitRun("timeout 60 git checkout x", { unwrap: true }).out,
		).toContain(`[checkout][${SHARED}]`);
		// A wrapper's own `-C DIR` is swept, not followed.
		expect(
			walkGitRun(`env -C ${ELSEWHERE} git checkout x`, { unwrap: true }).out,
		).toContain(`[checkout][${SHARED}]`);
	});

	it('reads a git -C relative to the tree before it, and a -C "" as no move', () => {
		expect(walkGitRun("git -C wt checkout x", {}, DIR).out).toBe("");
		expect(walkGitRun("git -C shared checkout x", {}, DIR).out).toContain(
			`[checkout][${SHARED}]`,
		);
		expect(walkGitRun(`git -C "" checkout x`).out).toContain(
			`[checkout][${SHARED}]`,
		);
	});

	it("steps git's own valued options to find the subcommand", () => {
		expect(walkGitRun("git -c a.b=1 --git-dir x checkout y").out).toContain(
			"[checkout]",
		);
		expect(walkGitRun("git -c checkout x").calls).toEqual([]);
	});
});

describe("path resolution through the git walk", () => {
	/** Judged from an unrelated repo, so only the cd/-C can reach the shared tree. */
	const judged = (command: string, vars: Record<string, string> = ENV) =>
		walkGitRun(command, { subs: ["checkout"] }, ELSEWHERE, vars);

	/*
	 * Asserts the REASON, not the number of records. A path that resolves to a
	 * directory that happens not to exist also logs nothing — so counting alone
	 * lets a refusal and a resolution look identical.
	 */
	const unresolved = (command: string, vars?: Record<string, string>) => {
		const r = judged(command, vars);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	};

	it.each([
		[
			"a cd target that was quoted but fully literal",
			`cd "${SHARED}" && git checkout x`,
		],
		["a single-quoted literal cd target", `cd '${SHARED}' && git checkout x`],
		[
			"an environment variable in a cd target",
			'cd "$CLAUDE_PROJECT_DIR" && git checkout x',
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, the braced spelling under test.
		["the braced spelling", 'cd "${CLAUDE_PROJECT_DIR}" && git checkout x'],
		["a variable in git -C", 'git -C "$CLAUDE_PROJECT_DIR" checkout x'],
		[
			"an assignment naming the shared tree (mantahostels#208)",
			`WT=${SHARED} && git -C "$WT" checkout x`,
		],
		[
			"an assignment reached through a cd",
			`WT=${SHARED} && cd "$WT" && git checkout x`,
		],
		[
			"an assignment prefixed onto the command",
			`WT=${SHARED} git -C "$WT" checkout x`,
		],
		[
			"an assignment before the first || (#328)",
			`WT=${SHARED} && [ -d "$WT" ] || exit 1; git -C "$WT" checkout x`,
		],
		[
			"a subshell and a case arm ahead of the || (#319's shape)",
			`WT=${SHARED} && S=m && (true) && case "$S" in *) [ -n "$S" ] || exit 1;; esac && git -C $WT checkout x`,
		],
		[
			"a || inside a quoted span",
			`WT=${SHARED}; echo "a || b"; X=1 || true; git -C "$WT" checkout x`,
		],
	])("resolves %s, recording nothing", (_, command) => {
		const r = judged(command);
		expect(r.out).toContain(`[checkout][${SHARED}]`);
		expect(r.logged).toEqual([]);
	});

	it("expands a variable that is only part of the path", () => {
		const r = judged('cd "$WFC_ROOT/shared" && git checkout x', {
			WFC_ROOT: DIR,
		});
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	it("lets an assignment shadow the environment, as shell does", () => {
		const r = judged(`WFC_WT=${SHARED} && git -C "$WFC_WT" checkout x`, {
			WFC_WT: WORKTREE,
		});
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	it.each([
		[
			"a linked worktree reached through a variable",
			'cd "$WFC_WT" && git checkout x',
			{ WFC_WT: WORKTREE },
		],
		[
			"a variable the command assigned on the same line",
			`WT=${WORKTREE} && git -C "$WT" checkout x`,
			ENV,
		],
		[
			"the sanctioned recipe end to end (mantahostels#301)",
			'WT=$WFC_ROOT/fresh && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side2',
			{ WFC_ROOT: DIR },
		],
	])("exempts %s, recording nothing", (_, command, vars) => {
		const r = judged(command, vars);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
	});

	it.each([
		[
			"sees an assignment only from the commands after it",
			`git -C "$WT" checkout x && WT=${SHARED}`,
		],
		[
			"refuses an assignment from command substitution (mantahostels#183)",
			'WT=$(mktemp -d) && git -C "$WT" checkout x',
		],
		[
			"refuses a name assigned twice with different values",
			`WT=${SHARED}; WT=${WORKTREE}; git -C "$WT" checkout x`,
		],
		[
			"harvests nothing at or after a string's first ||",
			`[ -d ${WORKTREE} ] || WT=${SHARED}; git -C "$WT" checkout x`,
		],
		[
			"kills a name reassigned after a ||",
			`WT=${WORKTREE}; false || WT=${SHARED}; git -C "$WT" checkout x`,
		],
		[
			"does not expand a variable inside single quotes",
			`cd '$CLAUDE_PROJECT_DIR' && git checkout x`,
		],
		[
			"refuses command substitution rather than resolving it",
			'cd "$(mktemp -d)" && git checkout x',
		],
		[
			"refuses a brace-operator form even when the variable is set",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the operator inside them is exactly what must not be expanded.
			'cd "${CLAUDE_PROJECT_DIR:-/tmp}" && git checkout x',
		],
	])("%s, so the checkout is logged as allowed unchecked", (_, command) => {
		unresolved(command);
	});

	it.each([
		[
			"does not fall back to the environment for a name it refused",
			'WFC_WT=$(mktemp -d) && git -C "$WFC_WT" checkout x',
			{ WFC_WT: WORKTREE },
		],
		[
			"refuses a variable whose value carries whitespace",
			'cd "$WFC_ODD" && git checkout x',
			{ WFC_ODD: `${DIR} spaced` },
		],
		[
			"refuses a variable whose value carries a shell metacharacter",
			'cd "$WFC_ODD" && git checkout x',
			{ WFC_ODD: `${DIR}/$(id)` },
		],
		[
			"refuses a variable that is set but empty",
			'cd "$WFC_EMPTY" && git checkout x',
			{ WFC_EMPTY: "" },
		],
	])("%s, logging it", (_, command, vars) => {
		unresolved(command, { ...ENV, ...vars });
	});

	it("reads an empty path as the cwd, which is where the shell leaves it (#301)", () => {
		// Judged from `elsewhere`, so staying put means no verdict — and no
		// fail-open record either, which is the half that matters.
		expect(judged('cd "" && git checkout x').out).toBe("");
		const r = judged('git -C "" checkout x');
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
		expect(judged(`cd "${SHARED}" && cd "" && git checkout x`).out).toContain(
			`[checkout][${SHARED}]`,
		);
	});

	it("reads a quote nested in the other kind as literal, as shell does (#490)", () => {
		expect(judged(`cd "'${SHARED}'" && git checkout x`).out).toBe("");
	});

	describe("the strict walkers hand the unresolved tree over (#301, #311)", () => {
		it("calls back with an empty tree instead of logging and skipping", () => {
			const r = walkGitRun('git -C "$UNSET_301" checkout x', { strict: true });
			expect(r.out).toContain("[checkout][]");
			// Nothing logged: the callback owns the record now.
			expect(r.logged).toEqual([]);
		});

		it("leaves the ordinary walker failing open and recording, as before", () => {
			const r = walkGitRun('git -C "$UNSET_301" checkout x');
			expect(r.out).toBe("");
			expect(r.logged).toEqual([FAIL_OPEN]);
		});

		it("a tree it CAN resolve reaches the callback unchanged", () => {
			const r = walkGitRun("git checkout x", { strict: true });
			expect(r.out).toContain(`[checkout][${SHARED}]`);
		});

		it("the repo-wide strict walker hands it over too (#311)", () => {
			const r = walkGitRun('git -C "$UNSET_311" checkout x', {
				strict: true,
				scope: "repo",
			});
			expect(r.out).toContain("[checkout][]");
			expect(r.logged).toEqual([]);
		});

		it("the repo-wide strict walker still reaches a linked worktree", () => {
			const r = walkGitRun(
				"git checkout x",
				{ strict: true, scope: "repo" },
				WORKTREE,
			);
			expect(r.out).toContain(`[checkout][${WORKTREE}]`);
		});

		it.each(["shared", "repo"] as const)(
			"a %s walk inside a strict walk's callback does not inherit strict mode",
			(scope) => {
				const command = 'git -C "$UNSET_311" checkout x';
				let inner: GitWalkRun | undefined;
				walkGit(
					parseCommand(command),
					() => {
						inner = walkGitRun(command, { scope });
					},
					{ ...ports(), treeClass, log: () => undefined },
					{
						subs: ["checkout"],
						noun: "branch move",
						scope: "repo",
						strict: true,
					},
				);
				expect(inner?.out).toBe("");
				expect(inner?.logged).toEqual([FAIL_OPEN]);
			},
		);
	});
});

describe("the unresolved-tree record's fourth field (#320)", () => {
	const details = (command: string) =>
		walkGitRun(command, {}, ELSEWHERE).details;

	it("carries an unresolved -C value as typed, $W unexpanded, and both cwds", () => {
		expect(details('git -C "$UNSET_320" checkout x')).toEqual([
			`target=-C "$UNSET_320" pwd=${ELSEWHERE} cwd=${ELSEWHERE}`,
		]);
	});

	it("carries an unquoted $W as typed too", () => {
		expect(details("git -C $UNSET_320 checkout x")).toEqual([
			`target=-C $UNSET_320 pwd=${ELSEWHERE} cwd=${ELSEWHERE}`,
		]);
	});

	it("names the cd that lost the cwd, and the cwd as unknown", () => {
		expect(details('cd "$UNSET_320" && git checkout x')).toEqual([
			`target=cd "$UNSET_320" pwd=${ELSEWHERE} cwd=<unknown>`,
		]);
	});

	it("puts back a single-quoted span nested in a double-quoted one", () => {
		expect(details(`git -C "a'b'$UNSET_320" checkout x`)[0]).toMatch(
			/^target=-C "a'b'\$UNSET_320" /,
		);
	});

	it("hands a tab or newline in the typed path over whole, for the log port to collapse", () => {
		// The `log` port (lib/guard-entry.js) collapses both, so neither can
		// shift a field or forge a record.
		expect(details('git -C "a\tb$UNSET_320" checkout x')[0]).toMatch(
			/^target=-C "a\tb\$UNSET_320" /,
		);
		expect(details('git -C "a\nb$UNSET_320" checkout x')).toHaveLength(1);
	});

	it("writes a fixed <quoted> for a span index never recorded, and no \\x01", () => {
		// No command reaches it: every sentinel the masker writes has its span
		// recorded. #315 ruled the marker for that case anyway.
		expect(asWritten(`a${QUOTED}7\x01b`, [])).toBe("a<quoted>b");
	});

	it("leaves the walker's other record at three fields", () => {
		const r = walkGitRun(`cd ${BROKEN} && git checkout x`);
		expect(r.logged).toHaveLength(1);
		expect(r.details).toEqual([""]);
	});
});

describe("--empty-unset reads a provably empty target as the cwd (#310, #325)", () => {
	/** A walk opted in, through either scope, from `cwd`. */
	const walkEmpty = (
		command: string,
		cwd: string,
		opts: Partial<GitWalkOpts> = {},
		vars: Record<string, string> = ENV,
	) =>
		walkGitRun(
			command,
			{ subs: ["checkout"], emptyUnset: true, ...opts },
			cwd,
			vars,
		);

	it.each([
		'cd "$UNSET_325" && git checkout x',
		'git -C "$UNSET_325" checkout x',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, the braced spelling under test.
		'git -C "${UNSET_325}" checkout x',
		'git -C "$UNSET_325$UNSET_325B" checkout x',
	])("judges %s in the cwd, unlogged", (command) => {
		const r = walkEmpty(command, SHARED);
		expect(r.out).toContain(`[checkout][${SHARED}]`);
		expect(r.logged).toEqual([]);
	});

	it("judges it where the cwd is, not the shared tree", () => {
		const r = walkEmpty('cd "$UNSET_325" && git checkout x', ELSEWHERE);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([]);
	});

	it("reaches a linked worktree through the repo-wide walker", () => {
		const r = walkEmpty('git -C "$UNSET_325" checkout x', WORKTREE, {
			scope: "repo",
		});
		expect(r.out).toContain(`[checkout][${WORKTREE}]`);
	});

	it.each(['U=""; git -C "$U" checkout x', 'U=; git -C "$U" checkout x'])(
		"reads a name this command set empty the same way: %s",
		(command) => {
			const r = walkEmpty(command, SHARED);
			expect(r.out).toContain(`[checkout][${SHARED}]`);
			expect(r.logged).toEqual([]);
		},
	);

	it.each([
		// Unquoted, an empty expansion drops the word: `cd` alone goes to $HOME.
		["an unquoted reference", "cd $UNSET_325 && git checkout x"],
		["a command substitution", 'cd "$(pwd)" && git checkout x'],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the operator inside them is what must not be expanded.
		["an operator form", 'git -C "${UNSET_325:-/x}" checkout x'],
		// The harvest sees leading `NAME=` words alone.
		[
			"an assignment it cannot harvest",
			'export UNSET_325=/x; git -C "$UNSET_325" checkout x',
		],
		[
			"a name `read` assigns",
			'read UNSET_325 < f; git -C "$UNSET_325" checkout x',
		],
		[
			"a `||`, which may skip an assignment it cannot see",
			'true || true; git -C "$UNSET_325" checkout x',
		],
		["a name assigned from $(…)", 'U=$(pwd); git -C "$U" checkout x'],
		["a name set empty twice over", 'U=; U=; git -C "$U" checkout x'],
		// Each can assign the name without the command text ever naming it.
		["a `source` before it", 'source ./env.sh; git -C "$UNSET_325" checkout x'],
		["a `.` before it", '. ./env.sh && git -C "$UNSET_325" checkout x'],
		["an `eval` before it", 'eval "$X"; git -C "$UNSET_325" checkout x'],
	])("keeps the logged fail-open for %s", (_, command) => {
		const r = walkEmpty(command, SHARED);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	});

	it("keeps it for a name the hook's environment sets empty", () => {
		const r = walkEmpty(
			'git -C "$WFC_EMPTY" checkout x',
			SHARED,
			{},
			{
				...ENV,
				WFC_EMPTY: "",
			},
		);
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	});

	it("leaves a walk without the opt-in failing open, as before", () => {
		const r = walkGitRun('git -C "$UNSET_325" checkout x');
		expect(r.out).toBe("");
		expect(r.logged).toEqual([FAIL_OPEN]);
	});

	it("still reads `git add .` as no `.` builtin", () => {
		const r = walkEmpty('git add . && git -C "$UNSET_325" checkout x', SHARED);
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	it("takes the opt-in on a strict walker too", () => {
		const r = walkEmpty('git -C "$UNSET_325" checkout x', SHARED, {
			strict: true,
		});
		expect(r.out).toContain(`[checkout][${SHARED}]`);
	});

	/** Each call's emptyVars, `<name>` each, `<>` for none. */
	const names = (command: string, subs: string[]) =>
		walkEmpty(command, SHARED, { subs }).calls.map(
			(c) => c.emptyVars.map((n) => `<${n}>`).join("") || "<>",
		);

	it("names only what led to the judged tree", () => {
		expect(
			names(
				'git -C "$UNSET_325" status; (cd "$UNSET_325B"); git checkout x; cd "$UNSET_325C" && git checkout y',
				["checkout", "status"],
			),
		).toEqual(["<UNSET_325>", "<>", "<UNSET_325C>"]);
	});

	it("names only the unset ones", () => {
		expect(
			names('U=""; cd "$UNSET_325" && git -C "$U" checkout x', ["checkout"]),
		).toEqual(["<UNSET_325>"]);
	});

	it("names each once, in order", () => {
		expect(
			names('cd "$UNSET_A" && git -C "$UNSET_B$UNSET_A" checkout x', [
				"checkout",
			]),
		).toEqual(["<UNSET_A><UNSET_B>"]);
	});

	it("drops the names an absolute cd leaves behind", () => {
		expect(
			names(`cd "$UNSET_A" && cd ${SHARED} && git checkout x`, ["checkout"]),
		).toEqual(["<>"]);
	});

	it("counts no mention inside a longer name", () => {
		const r = walkEmpty(
			'true UNSET_325X; cd "$UNSET_325" && git checkout x',
			SHARED,
		);
		expect(r.out).toContain(`[checkout][${SHARED}]`);
		expect(r.logged).toEqual([]);
	});

	it.each(["shared", "repo"] as const)(
		"a %s walk nested in an opted-in callback does not inherit it",
		(scope) => {
			const command = 'git -C "$UNSET_325" checkout x';
			let inner: GitWalkRun | undefined;
			walkGit(
				parseCommand(command),
				() => {
					inner = walkGitRun(command, { scope });
				},
				{ ...ports(), treeClass, log: () => undefined },
				{
					subs: ["checkout"],
					noun: "branch move",
					scope: "shared",
					emptyUnset: true,
				},
			);
			expect(inner?.out).toBe("");
			expect(inner?.logged).toEqual([FAIL_OPEN]);
		},
	);
});

describe("unsetText", () => {
	it("is empty where no name led to the tree", () => {
		expect(unsetText([])).toBe("");
	});

	it("names one variable in the singular, with a blank line after", () => {
		expect(unsetText(["A"])).toBe(
			"`$A` is unset in this call; shell variables do not carry over between Bash calls.\n\n",
		);
	});

	it("names several once each, in the plural", () => {
		expect(unsetText(["A", "B", "A"])).toBe(
			"`$A`, `$B` are unset in this call; shell variables do not carry over between Bash calls.\n\n",
		);
	});
});

/*
 * The guarded-head class test (mantahostels#2346, on mantahostels#1818's
 * near-miss): the logical-line join abandons only at a `git` or `gh` line, so
 * a quoted multi-line argument whose prose line begins with any other command
 * name stays one argument. Widen the list and an issue body reaches the deny
 * guards as commands. The heads are illustrative; the bait
 * line is an `npm install`, which guard-npm-install.js refuses.
 */
describe("the guarded heads stay git and gh (mantahostels#2346)", () => {
	const Heads = ["cp", "mv", "sed", "perl", "cat", "grep", "awk", "rm", "tee"];

	it.each(Heads)(
		"keeps a quoted prose line opening with %s inside its argument",
		(head) => {
			const command = `node scripts/issue-body.js comment 1 "Line one is prose.\n${head} docs/a docs/b was the write.\nnpm install left-pad was refused."`;
			expect(walkMap(command, (c) => c.words[0])).toEqual(["node"]);
		},
	);
});
