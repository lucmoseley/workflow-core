// @vitest-environment node
/*
 * In-process cases for scripts/lib/shell-words.js, the guard parser's word
 * helpers in Node (#2785). Each reads its command through walkCommands, so
 * the words arrive masked, with the parse's spans.
 */

import { describe, expect, it } from "vitest";
import type { Command } from "./shell-parse.js";
import { parseCommand, walkCommands } from "./shell-parse.js";
import {
	carriesVar,
	commandName,
	commitPathsArgs,
	commitPathsParse,
	findStarts,
	ghWords,
	gitValueFlags,
	gitWords,
	isGhCommand,
	isInlineCode,
	literal,
	scanFlags,
	unwrap,
} from "./shell-words.js";

/** `fn`'s answer for each command the walk hands over. */
const each = <T>(
	command: string,
	fn: (cmd: Command, spans: string[]) => T,
): T[] => {
	const parsed = parseCommand(command);
	const out: T[] = [];
	walkCommands(parsed, (c) => out.push(fn(c, parsed.spans)), {
		cwd: "/start",
		fallbackCwd: "/fx/shared",
		vars: {},
		isDir: () => false,
	});
	return out;
};

/** The one command's answer, for a command string running one. */
const one = <T>(command: string, fn: (cmd: Command, spans: string[]) => T) => {
	const all = each(command, fn);
	expect(all).toHaveLength(1);
	return all[0] as T;
};

/** Each word read back through literal, bracketed. */
const bracket = (words: string[], spans: string[]) =>
	words.map((w) => `[${literal(w, spans).text}]`).join("");

describe("commandName and isGhCommand (#2885)", () => {
	it.each([
		["gh", "gh", true],
		["/usr/bin/gh", "gh", true],
		["gh/", "gh", true],
		["/usr/bin/gh//", "gh", true],
		["ghx", "ghx", false],
		["/gh/x", "x", false],
		["/", "/", false],
		["", "", false],
	])("%j reads as %j, gh: %j", (word, name, gh) => {
		expect(commandName(word)).toBe(name);
		expect(isGhCommand(word)).toBe(gh);
	});
});

describe("isInlineCode (#3456)", () => {
	it.each([
		["node", ["-e", "x"], true],
		["node", ["--no-warnings", "--eval=x"], true],
		["node", ["-c", "a.js"], false],
		["node", ["a.js", "-e"], false],
		["bash", ["-c", "x"], true],
		["sh", ["-e", "a.sh"], false],
		["python3", ["-c", "x"], false],
	])("%s %j is %s", (interpreter, words, inline) => {
		expect(isInlineCode(interpreter, words)).toBe(inline);
	});
});

describe("ghWords (#772)", () => {
	/** What ghWords answered for each command: its words read back, `none`
	 * where it answered null. */
	const read = (command: string) =>
		each(command, (c, spans) => {
			const r = ghWords(c.words, spans);
			return r ? bracket(r.args, spans) : "none";
		});

	it.each([
		["gh pr create", "[pr][create]"],
		["/usr/bin/gh pr create", "[pr][create]"],
		[`"gh" "pr" create`, "[pr][create]"],
		["gh -R o/r pr create", "[pr][create]"],
		["gh --repo o/r workflow run ci.yml", "[workflow][run][ci.yml]"],
		["timeout 60 gh workflow run ci.yml", "[workflow][run][ci.yml]"],
		["timeout -s KILL 5 gh api /x", "[api][/x]"],
		["watch -n 2 gh run list", "[run][list]"],
		// watch's -C is --no-color: it takes no value (#3376).
		["watch -C -d gh run list", "[run][list]"],
		// watch runs one word through `sh -c`, so it is split back (#3376).
		["watch -n 2 -- 'gh run list'", "[run][list]"],
		["env A=1 nohup gh api /x", "[api][/x]"],
		// An expansion in a flag leaves literal unknown; it is still a flag.
		["gh --repo=$R workflow run ci.yml", "[workflow][run][ci.yml]"],
		["gh -R$R pr create", "[pr][create]"],
	])("reads %s from its command word on", (command, words) => {
		expect(read(command)).toEqual([words]);
	});

	it.each([
		"gh pr create --help",
		"gh pr create -h",
		"gh --help pr create",
		`gh pr create "--help"`,
	])("answers nothing for %s, which only prints usage", (command) => {
		expect(read(command)).toEqual(["none"]);
	});

	it("answers nothing for a command that is not gh", () => {
		expect(read("git push origin main")).toEqual(["none"]);
	});

	it("answers each segment on its own", () => {
		expect(read("gh pr create && gh issue list")).toEqual([
			"[pr][create]",
			"[issue][list]",
		]);
	});

	it.each([
		["gh -R o/r pr create", "o/r"],
		["gh --repo o/r pr create", "o/r"],
		["gh --repo=o/r pr create", "o/r"],
		["gh -Ro/r pr create", "o/r"],
		["gh pr create", ""],
	])("keeps the repo %s stepped over", (command, repo) => {
		expect(one(command, (c, spans) => ghWords(c.words, spans)?.repo)).toBe(
			repo,
		);
	});

	it("answers nothing where -R has no value left", () => {
		expect(one("gh -R", (c, spans) => ghWords(c.words, spans))).toBeNull();
	});
});

describe("gitWords (#2383)", () => {
	/** The subcommand, then each word after it read back; `none` for null. */
	const read = (command: string) =>
		each(command, (c, spans) => {
			const r = gitWords(c.words, spans);
			return r ? `${r.sub}:${bracket(r.args, spans)}` : "none";
		});

	it.each([
		["git commit -m x", "commit:[-m][x]"],
		["/usr/bin/git commit -m x", "commit:[-m][x]"],
		["git -C /r -c a.b=1 --no-pager commit -m x", "commit:[-m][x]"],
		["git --git-dir=/r/.git commit", "commit:"],
		[
			"git --namespace n --work-tree /w --git-dir /g --exec-path /e commit",
			"commit:",
		],
		["timeout 60 git commit -m x", "commit:[-m][x]"],
		["env A=1 git commit -m 'a b'", "commit:[-m][a b]"],
	])("reads %s from its subcommand on", (command, words) => {
		expect(read(command)).toEqual([words]);
	});

	it.each(["git", "git -C /r", "gh pr create"])(
		"answers nothing for %s, which runs no git subcommand",
		(command) => {
			expect(read(command)).toEqual(["none"]);
		},
	);

	it("reads a quoted subcommand through literal", () => {
		expect(read(`git "commit" -m x`)).toEqual(["commit:[-m][x]"]);
	});

	it("hands the words after the subcommand over raw, still masked", () => {
		const args = one(
			'git commit -m "a b"',
			(c, spans) => gitWords(c.words, spans)?.args,
		);
		expect(args?.[1]).not.toBe("a b");
	});
});

describe("carriesVar (#1499)", () => {
	const carriesFoo = (command: string) =>
		each(command, (c, spans) =>
			carriesVar("FOO", c.leading, c.words, spans) ? "yes" : "no",
		);

	it.each([
		["FOO=1 npm run test", "a leading assignment"],
		["env FOO=1 npm run test", "an assignment an env carried"],
		["env A=/x/y FOO=1 npm run test", "env with a /-valued earlier assignment"],
		["time FOO=1 npm run test", "a keyword-led command (#1013)"],
	])("answers yes for %s (%s)", (command) => {
		expect(carriesFoo(command)).toEqual(["yes"]);
	});

	it.each([
		["FOO= npm run test", "an empty value"],
		["npm run test -- FOO=1", "a NAME after the command word"],
		["BAR=1 npm run test", "a different NAME"],
		["env BAR=1 npm run test", "a different NAME through env"],
	])("answers no for %s (%s)", (command) => {
		expect(carriesFoo(command)).toEqual(["no"]);
	});

	it("answers each segment on its own", () => {
		expect(carriesFoo("FOO=1 npm run test && npm run test")).toEqual([
			"yes",
			"no",
		]);
	});

	it("leaves unwrap's answer over the words it was handed", () => {
		expect(
			one("env FOO=1 nohup npm test", (c, spans) => unwrap(c.words, spans)),
		).toEqual({
			words: ["npm", "test"],
			wrapperWords: ["FOO=1"],
			watched: false,
		});
	});
});

describe("unwrap (mantahostels#2511, mantahostels#2524, mantahostels#2552)", () => {
	const strip = (command: string) =>
		one(command, (c, spans) => unwrap(c.words, spans));

	it.each([
		["nohup npm test", ["npm", "test"]],
		["/usr/bin/env npm test", ["npm", "test"]],
		["setsid nice -n 5 ionice -c 3 npm test", ["npm", "test"]],
		["stdbuf -o L xargs -n 1 rm", ["rm"]],
		["sudo -u root -g wheel npm test", ["npm", "test"]],
		// `-S` splits only under env; to sudo it is a flag taking nothing.
		["sudo -S npm test", ["npm", "test"]],
		// The wrapper's own `-C DIR` is swept (#1731).
		["env -C /x git push", ["git", "push"]],
		["command time npm test", ["npm", "test"]],
	])("strips the wrappers off %s", (command, words) => {
		expect(strip(command).words).toEqual(words);
	});

	it("steps timeout's duration, a bare positional, and its valued flags", () => {
		expect(strip("timeout -k 5 -s KILL 60 npm test").words).toEqual([
			"npm",
			"test",
		]);
	});

	it.each(["timeout 60", "timeout -k", "sudo -u", "nice -n"])(
		"answers no words for %s, which runs out mid-strip",
		(command) => {
			expect(strip(command).words).toEqual([]);
		},
	);

	it("stops at an assignment after any wrapper but env, which execs it", () => {
		expect(strip("nohup FOO=1 npm test")).toEqual({
			words: ["FOO=1", "npm", "test"],
			wrapperWords: [],
			watched: false,
		});
	});

	it("keeps env's assignments as wrapper words, whole (#1499)", () => {
		expect(strip("env A=/x/y FOO=1 npm test")).toEqual({
			words: ["npm", "test"],
			wrapperWords: ["A=/x/y", "FOO=1"],
			watched: false,
		});
	});

	it("strips bg-run.sh run and its job name (mantahostels#1900)", () => {
		expect(strip("scripts/bg-run.sh run suite npm test").words).toEqual([
			"npm",
			"test",
		]);
	});

	it.each(["bg-run.sh run", "bg-run.sh status suite"])(
		"leaves %s standing, a malformed or other bg-run.sh call",
		(command) => {
			expect(strip(command).words[0]).toBe("bg-run.sh");
		},
	);

	it("splits env -S's string, not skipping it", () => {
		expect(strip(`env -S 'FOO=1 npm run test'`)).toEqual({
			words: ["npm", "run", "test"],
			wrapperWords: ["FOO=1"],
			watched: false,
		});
	});

	it("splits a --split-string= value the same way", () => {
		expect(strip("env --split-string=npm test").words).toEqual(["npm", "test"]);
	});

	it("keeps a quote inside the -S string welded to its word", () => {
		expect(strip(`env -S 'npm run "test"'`).words).toEqual([
			"npm",
			"run",
			'"test"',
		]);
	});

	it("reads only the -S string's first line, as read -ra does", () => {
		expect(strip(`env -S 'npm test\nrm -rf x'`).words).toEqual(["npm", "test"]);
	});
});

describe("findStarts (#2060)", () => {
	/** The start points of the one `find`, read back through literal. */
	const starts = (command: string) =>
		one(command, (c, spans) =>
			findStarts(c.words.slice(1), spans).map((w) => literal(w, spans).text),
		);

	it.each([
		["find . -name x", ["."]],
		["find a b -type f", ["a", "b"]],
		["find -L -H -P a", ["a"]],
		["find -D tree a -print", ["a"]],
		["find -O3 a", ["a"]],
		["find -- a -print", ["a"]],
		[`find "a b" c`, ["a b", "c"]],
	])("reads %s's start points", (command, want) => {
		expect(starts(command)).toEqual(want);
	});

	it.each([
		"find",
		"find -name x",
		"find -D",
		`find "(" -name x ")"`,
		`find "\\(" -name x`,
		"find ! -name x",
		"find , -print",
		"find -- -weird",
	])("answers no start point for %s, find defaulting to .", (command) => {
		expect(starts(command)).toEqual([]);
	});

	it("stops at an expression word read through literal", () => {
		expect(starts(`find a "-name" x`)).toEqual(["a"]);
	});
});

describe("commitPathsArgs (#1727, #2022)", () => {
	const args = (command: string) =>
		one(command, (c, spans) => {
			const r = commitPathsArgs(c.words, spans);
			return r ? r.map((w) => literal(w, spans).text) : null;
		});

	it.each([
		'node scripts/commit-paths.js -m "x" -- a.md',
		'node "$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js -m "x" -- a.md',
		'nodejs commit-paths.js -m "x" -- a.md',
		'timeout 60 node scripts/commit-paths.js -m "x" -- a.md',
		'node --require ./r.js --inspect scripts/commit-paths.js -m "x" -- a.md',
	])("reads the arguments after the script in %s", (command) => {
		expect(args(command)).toEqual(["-m", "x", "--", "a.md"]);
	});

	it.each([
		"node scripts/other.js -m x",
		"npm run commit-paths.js",
		"node -r",
		"node",
		// A node flag taking a value outside the list leaves the value in the
		// script's place: the named residual.
		"node --title t scripts/commit-paths.js -m x",
	])("answers nothing for %s", (command) => {
		expect(args(command)).toBeNull();
	});
});

describe("commitPathsParse (#2147, #2383)", () => {
	/** The parse, every word read back through literal. */
	const parse = (argv: string) =>
		one(`node scripts/commit-paths.js ${argv}`, (c, spans) => {
			const a = commitPathsArgs(c.words, spans);
			const r = a && commitPathsParse(a, spans);
			const read = (w: string) => literal(w, spans).text;
			return (
				r && {
					...r,
					paths: r.paths.map(read),
					patch: read(r.patch),
					message: read(r.message),
				}
			);
		});

	it("splits the message, its flag and the paths after --", () => {
		expect(parse('-m "a b" -- x.md y.md')).toEqual({
			paths: ["x.md", "y.md"],
			patch: "",
			messageFlag: "-m",
			message: "a b",
			tree: false,
		});
	});

	it("keeps a -- that is the message's value a message", () => {
		expect(parse('-m "--" -- a.md')).toMatchObject({
			message: "--",
			paths: ["a.md"],
		});
	});

	it("reads --patch, -F and --tree", () => {
		expect(parse("--tree -F msg.txt --patch own.patch")).toEqual({
			paths: [],
			patch: "own.patch",
			messageFlag: "-F",
			message: "msg.txt",
			tree: true,
		});
	});

	it.each([
		["--help", "an unknown option"],
		["-m x -m y", "a second message"],
		["-m x -F y", "a second message by the other flag"],
		["--patch a --patch b", "a second --patch"],
		["-m", "a message flag with no value"],
		["-m x a.md", "a path before any --"],
	])("refuses %s (%s)", (argv) => {
		expect(parse(argv)).toBeNull();
	});
});

describe("scanFlags", () => {
	/** Every event the scan emits, as `kind|name|value`. */
	const scan = (spec: string, ...words: string[]) => {
		const out: string[] = [];
		scanFlags(spec, words, (kind, name, value) => {
			out.push(`${kind}|${name}|${value}`);
		});
		return out;
	};

	it("skips a value-taking flag's value in pairs", () => {
		// Without the pair-skip a masked `--comment "…"` has its value read as the
		// next argument, and a guard looking for an issue number judges the wrong
		// word.
		expect(scan("-c --comment", "--comment", "-r", "12")).toEqual([
			"opt|--comment|-r",
			"arg||12",
		]);
	});

	it("reads a long flag's value from an = as well as from the next word", () => {
		expect(scan("--label", "--label=takes:human")).toEqual([
			"opt|--label|takes:human",
		]);
		expect(scan("--label", "--label", "takes:human")).toEqual([
			"opt|--label|takes:human",
		]);
	});

	it("reads a --flag=value whether or not the spec names that flag", () => {
		expect(scan("-c", "--strategy-option=theirs")).toEqual([
			"opt|--strategy-option|theirs",
		]);
	});

	it("reads a short flag's value attached, with or without the =", () => {
		// gh's flag reader (pflag) takes `-l=x` as x, not as =x.
		expect(scan("-l", "-ltakes:human")).toEqual(["opt|-l|takes:human"]);
		expect(scan("-l", "-l=takes:human")).toEqual(["opt|-l|takes:human"]);
		expect(scan("-l", "-l", "takes:human")).toEqual(["opt|-l|takes:human"]);
	});

	it("walks a short-flag bundle letter by letter", () => {
		// `git pull -qr` is a rebase: the r is a flag in its own right.
		expect(scan("-s -X", "-qr")).toEqual(["flag|-q|", "flag|-r|"]);
	});

	it("lets a value-taking letter take the rest of its bundle", () => {
		// This is what stops the r inside `-Xtheirs` reading as `git pull -r`.
		expect(scan("-s -X", "-Xtheirs")).toEqual(["opt|-X|theirs"]);
		expect(scan("-s -X", "-s", "recursive")).toEqual(["opt|-s|recursive"]);
	});

	it("gives an optional-value letter its stuck value and never the next word", () => {
		// `git merge -S --no-verify` signs with the default key AND skips hooks.
		expect(scan("-S?", "-Skey", "--no-verify")).toEqual([
			"opt|-S|key",
			"flag|--no-verify|",
		]);
		expect(scan("-S?", "-S", "--no-verify")).toEqual([
			"flag|-S|",
			"flag|--no-verify|",
		]);
		expect(scan("-S?", "-qShx")).toEqual(["flag|-q|", "opt|-S|hx"]);
	});

	it("keeps a leading = on an optional-value letter's value, as git does", () => {
		expect(scan("-S?", "-S=key")).toEqual(["opt|-S|=key"]);
	});

	it("reports a value-taking flag with nothing left to take", () => {
		expect(scan("--label -l", "--label")).toEqual(["dangling|--label|"]);
		expect(scan("--label -l", "-l")).toEqual(["dangling|-l|"]);
	});

	it("calls a lone - a flag, not a bare word", () => {
		// `--body-file -` reads the body from stdin. Read as a bare word it would
		// become the guard-issue-close core's issue number.
		expect(scan("-c", "-", "12")).toEqual(["flag|-|", "arg||12"]);
	});

	it("calls every word after a bare -- an arg, however it is spelled", () => {
		// mantahostels#495. git and gh both stop reading options at `--`, so a flag-shaped
		// word past it is a pathspec.
		expect(scan("-m", "-m", "msg", "--", "-weird-file", "--all", "-")).toEqual([
			"opt|-m|msg",
			"flag|--|",
			"arg||-weird-file",
			"arg||--all",
			"arg||-",
		]);
	});

	it("does not end the options on a -- that is a flag's value", () => {
		// Both git's parse-options and pflag hand the next word to a value-taking
		// flag whatever it is, so this `--` is the comment, not the separator, and
		// `-x` after it is still an option.
		expect(scan("-c --comment", "--comment", "--", "-x")).toEqual([
			"opt|--comment|--",
			"flag|-x|",
		]);
	});

	it("reports a flag that takes no value, and a bare word", () => {
		expect(scan("-c", "--ff-only", "origin", "-q")).toEqual([
			"flag|--ff-only|",
			"arg||origin",
			"flag|-q|",
		]);
	});

	it("stops where the callback returns false, and says so", () => {
		const seen: string[] = [];
		const done = scanFlags("-c", ["--title", "--help", "--label"], (_, n) => {
			seen.push(n);
			return n !== "--help";
		});
		expect(seen).toEqual(["--title", "--help"]);
		expect(done).toBe(false);
	});

	it("stops inside a short-flag bundle too", () => {
		const seen: string[] = [];
		const done = scanFlags("-l", ["-qhl", "x"], (_, n) => {
			seen.push(n);
			return n !== "-h";
		});
		expect(seen).toEqual(["-q", "-h"]);
		expect(done).toBe(false);
	});

	it("emits nothing, and succeeds, on no arguments at all", () => {
		const seen: string[] = [];
		const done = scanFlags("-c", [], (k) => {
			seen.push(k);
		});
		expect(done).toBe(true);
		expect(seen).toEqual([]);
	});
});

describe("gitValueFlags (#302)", () => {
	it.each([
		["merge", "-m"],
		["rebase", "-x"],
		["commit", "--fixup"],
	])("gives %s's spec, %s among its value flags", (sub, flag) => {
		expect(` ${gitValueFlags(sub)} `).toContain(` ${flag} `);
	});

	it("reads rebase's -m as --merge, taking nothing", () => {
		expect(` ${gitValueFlags("rebase")} `).not.toContain(" -m ");
	});

	it("marks -S optional-value under merge and rebase", () => {
		expect(gitValueFlags("merge")).toContain("-S?");
		expect(gitValueFlags("rebase")).toContain("-r?");
	});

	it("answers nothing for another subcommand", () => {
		expect(gitValueFlags("push")).toBe("");
	});
});
