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
	literal,
	programSource,
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

describe("programSource (#3456, #4479)", () => {
	it.each([
		["node", ["-e", "x"], "inline"],
		["node", ["--no-warnings", "--eval=x"], "inline"],
		["node", ["-pe", "x"], "inline"],
		["node", ["-r", "dotenv/config", "-e", "x"], "inline"],
		["node", ["-c", "a.js"], "script"],
		["node", ["a.js", "-e"], "script"],
		["node", ["--", "a.js"], "script"],
		["node", ["-"], "stdin"],
		["nodejs", ["-p", "x"], "inline"],
		["bash", ["-c", "x"], "inline"],
		["bash", ["-ec", "x"], "inline"],
		["bash", ["-o", "pipefail", "-c", "x"], "inline"],
		["bash", ["-o", "pipefail", "a.sh"], "script"],
		["sh", ["-e", "a.sh"], "script"],
		["sh", ["-s", "arg"], "stdin"],
		["bash", ["+o", "pipefail", "-c", "x"], "inline"],
		["zsh", ["-c", "x"], "inline"],
		["perl", ["-e", "x"], "inline"],
		["ruby", ["-r", "json", "-e", "x"], "inline"],
		["python3", ["-c", "x"], "inline"],
		["python3", ["-uc", "x"], "inline"],
		["python3", ["-W", "ignore", "-c", "x"], "inline"],
		["python3", ["-Wignore", "-c", "x"], "inline"],
		["python3.12", ["-cprint(1)"], "inline"],
		["python3m", ["-c", "x"], "inline"],
		["python3", ["-m", "pip", "install", "-c", "x"], "script"],
		["python3", ["-u"], "stdin"],
		["python3", ["-", "arg"], "stdin"],
		["lua", ["-e", "x"], null],
	])("%s %j reads its program from %s", (interpreter, words, source) => {
		expect(programSource(interpreter, words)?.source ?? null).toBe(source);
	});

	it("names the script a valued flag's value precedes", () => {
		expect(programSource("node", ["-r", "a.js", "b.js", "-e"])).toEqual({
			source: "script",
			script: "b.js",
		});
		expect(programSource("python3", ["--", "x.py"])).toEqual({
			source: "script",
			script: "x.py",
		});
		expect(programSource("python3", ["-m", "pip"])).toEqual({
			source: "script",
		});
	});
});

describe("ghWords (#772)", () => {
	/** What ghWords answered for each command: its words read back, `none`
	 * where it answered null. */
	const read = (command: string) =>
		each(command, (c, spans) => {
			const [r] = ghWords(c.words, spans);
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

	/** The repo ghWords kept, as `text`, `?text` where unknown, or `none`. */
	const repoOf = (command: string) =>
		one(command, (c, spans) => {
			const r = ghWords(c.words, spans)[0]?.repo;
			return r ? `${r.known ? "" : "?"}${r.text}` : "none";
		});

	it.each([
		["gh -R o/r pr create", "o/r"],
		["gh --repo o/r pr create", "o/r"],
		["gh --repo=o/r pr create", "o/r"],
		["gh -Ro/r pr create", "o/r"],
		["gh -R o/r --repo=p/q pr create", "p/q"],
		["gh pr create", "none"],
		// An empty value names none: gh falls back to GH_REPO (#4268).
		["gh --repo= pr create", "none"],
		[`gh -R "" pr create`, "none"],
		["gh -R o/r --repo= pr create", "none"],
		// Quoted or escaped, the flag reads as the unquoted one (#4268).
		[`gh "--repo=o/r" pr create`, "o/r"],
		[`gh '-Ro/r' pr create`, "o/r"],
		[`gh -R"o/r" pr create`, "o/r"],
		[`gh "-R"o/r pr create`, "o/r"],
		["gh \\-Ro/r pr list", "o/r"],
		["gh -R 'o/r' pr create", "o/r"],
		// An expansion in it, quoted or not, stays unknown.
		["gh --repo=$R pr create", "?$R"],
		[`gh "--repo=$R" pr create`, "?$R"],
		[`gh "-R$R" pr create`, "?$R"],
		[`gh '--repo=$R' pr create`, "$R"],
	])("keeps the repo %s stepped over", (command, repo) => {
		expect(repoOf(command)).toBe(repo);
	});

	it("answers nothing where -R has no value left", () => {
		expect(one("gh -R", (c, spans) => ghWords(c.words, spans))).toEqual([]);
	});
});

describe("gitWords (#2383)", () => {
	/** The subcommand, then each word after it read back; `none` for null. */
	const read = (command: string) =>
		each(command, (c, spans) => {
			const [r] = gitWords(c.words, spans);
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
			(c, spans) => gitWords(c.words, spans)[0]?.args,
		);
		expect(args?.[1]).not.toBe("a b");
	});
});

describe("carriesVar (#1499)", () => {
	const carriesFoo = (command: string) =>
		each(command, (c, spans) =>
			carriesVar("FOO", c.leading, unwrap(c.words, spans)[0].wrapperWords)
				? "yes"
				: "no",
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
});

describe("unwrap (mantahostels#2511, mantahostels#2524, mantahostels#2552)", () => {
	it("answers one run for words that run one command", () => {
		expect(
			one("env FOO=1 nohup npm test", (c, spans) => unwrap(c.words, spans)),
		).toEqual([
			{
				words: ["npm", "test"],
				wrapperWords: ["FOO=1"],
				chdirs: [],
				unread: [],
				watched: false,
			},
		]);
	});

	const strip = (command: string) =>
		one(command, (c, spans) => unwrap(c.words, spans)[0]);

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

	it.each([
		["env -C /x git status", ["/x"]],
		["env -C/x git status", ["/x"]],
		["env --chdir /x git status", ["/x"]],
		["env --chdir=/x git status", ["/x"]],
		["sudo -D /x git status", ["/x"]],
		["sudo -C 3 git status", []],
		["timeout 5 git status", []],
	])("reads the directory %s moves to", (command, chdirs) => {
		const stripped = strip(command);
		expect(stripped.chdirs.map((c) => c.dir)).toEqual(chdirs);
		expect(stripped.words[0]).toBe("git");
	});

	it("stops at an assignment after any wrapper but env, which execs it", () => {
		expect(strip("nohup FOO=1 npm test")).toEqual({
			words: ["FOO=1", "npm", "test"],
			wrapperWords: [],
			chdirs: [],
			unread: [],
			watched: false,
		});
	});

	it("keeps env's assignments as wrapper words, whole (#1499)", () => {
		expect(strip("env A=/x/y FOO=1 npm test")).toEqual({
			words: ["npm", "test"],
			wrapperWords: ["A=/x/y", "FOO=1"],
			chdirs: [],
			unread: [],
			watched: false,
		});
	});

	it("strips bg-run.sh run and its job name (mantahostels#1900)", () => {
		expect(strip("scripts/bg-run.sh run suite npm test").words).toEqual([
			"npm",
			"test",
		]);
	});

	it("answers no words for bg-run.sh run with a job name and no command (mantahostels#1900)", () => {
		expect(strip("bg-run.sh run suite").words).toEqual([]);
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
			chdirs: [],
			unread: [],
			watched: false,
		});
	});

	it("splits a --split-string= value the same way", () => {
		expect(strip("env --split-string=npm test").words).toEqual(["npm", "test"]);
	});
});

describe("unwrap reads a wrapper as the shell hands it over (#4046)", () => {
	const strip = (command: string) =>
		one(command, (c, spans) => unwrap(c.words, spans)[0]);

	it.each([
		[`env -S 'npm run "test"'`, ["npm", "run", "test"], "its double quotes"],
		[`env -S "npm run 'te st'"`, ["npm", "run", "te st"], "its single quotes"],
		[
			`env -S 'npm test\nrm -rf x'`,
			["npm", "test", "rm", "-rf", "x"],
			"a newline",
		],
		[`env -S 'npm\\_test'`, ["npm", "test"], "\\_ outside quotes"],
		[`env -S '"npm\\_test"'`, ["npm test"], "\\_ inside quotes"],
		[`env -S 'npm test #x'`, ["npm", "test"], "a comment"],
		[`env -S 'npm test\\c x'`, ["npm", "test"], "\\c"],
	])("splits %s as env does, with %j (%s)", (command, words) => {
		expect(strip(command).words).toEqual(words);
	});

	it("keeps a space inside env -S's double quotes in its word (#4046)", () => {
		expect(strip(`env -S 'npm run "te st"'`).words).toEqual([
			"npm",
			"run",
			"te st",
		]);
	});

	it("reads \\' inside env -S's single quotes as a quote (#4046)", () => {
		expect(strip(`env -S "'it\\\\'s'"`).words).toEqual(["it's"]);
	});

	it.each([
		[`env -S 'flock /l -c "\\ngit push"'`, "flock -c"],
		[`env -S 'watch "\\n  \\ngit push"'`, "watch, past a whitespace-only line"],
		[`env -S 'flock /l -c "# note\\ngit push"'`, "past a comment line"],
		[`env -S 'flock /l -c "git push # x\\ntrue"'`, "stopping at its first"],
	])("reads %s's first command past its blank lines (%s, #4281)", (command) => {
		expect(strip(command).words).toEqual(["git", "push"]);
	});

	it("answers no words for a -c string of blank lines alone (#4281)", () => {
		expect(strip(`env -S 'flock /l -c "\\n\\n"'`).words).toEqual([]);
	});

	it("answers no words for flock -c with no string after it (#4046)", () => {
		expect(strip("flock /l -c").words).toEqual([]);
	});

	it("moves nowhere on a --chdir its wrapper does not take (#4134)", () => {
		const stripped = strip("nice --chdir npm test");
		expect(stripped.chdirs).toEqual([]);
		expect(stripped.words).toEqual(["npm", "test"]);
	});

	it.each([
		[`'env' npm test`, "a quoted wrapper"],
		[`"timeout" 5 npm test`, "a double-quoted wrapper"],
		["\\env npm test", "an escaped wrapper"],
		[`env "-C" /x npm test`, "a quoted flag"],
		["env -iC /x npm test", "a cluster ending in a valued flag"],
		["env -vC/x npm test", "a cluster with its value stuck on"],
		["env --ch=/x npm test", "an abbreviated long flag"],
		["env --ch /x npm test", "an abbreviated long flag apart"],
		[`env -vS "npm test"`, "-S at a cluster's end"],
		[`env -S"npm test"`, "-S with its string stuck on"],
		[`env --s="npm test"`, "an abbreviated --split-string"],
		[`env -S "-C /x npm test"`, "a flag inside the -S string"],
		["env - npm test", "a lone dash"],
		["env -- npm test", "a bare --"],
		["builtin command npm test", "builtin"],
		["exec -a name npm test", "exec"],
		["flock /l npm test", "flock's file"],
		["flock -w 1 /l npm test", "flock -w"],
		["flock -nw1 /l npm test", "flock's cluster"],
		["flock --w 1 /l npm test", "flock's abbreviation"],
		[`flock /l -c "npm test"`, "flock -c"],
		[`flock /l --command "npm test"`, "flock --command"],
		["taskset 1 npm test", "taskset's mask"],
		["taskset -ac 0 npm test", "taskset's cluster"],
		["/usr/bin/time -o f npm test", "time's -o"],
		["/usr/bin/time -ao f npm test", "time's cluster"],
		["/usr/bin/time --out=f npm test", "time's abbreviation"],
		["timeout -vs KILL 5 npm test", "timeout's cluster"],
		["timeout -k1 5 npm test", "timeout's stuck value"],
		["timeout --sig KILL 5 npm test", "timeout's abbreviation"],
		["nice --adj 5 npm test", "nice's abbreviation"],
		["nice -5 npm test", "nice's old form"],
		["ionice -tc 3 npm test", "ionice's cluster"],
		["xargs --max-lines npm test", "an optional value, never the next word"],
		["xargs -i npm test", "a short optional value"],
	])("strips %s (%s)", (command) => {
		expect(strip(command).words).toEqual(["npm", "test"]);
	});

	it.each([
		["env -iC /x git status", ["/x"]],
		["env -vC/x git status", ["/x"]],
		["env --ch=/x git status", ["/x"]],
		[`env -S "-C /x git status"`, ["/x"]],
		["sudo -nD /x git status", ["/x"]],
		["sudo --chd /x git status", ["/x"]],
	])("reads the directory %s's spelling moves to", (command, chdirs) => {
		const stripped = strip(command);
		expect(stripped.chdirs.map((c) => c.dir)).toEqual(chdirs);
		expect(stripped.words[0]).toBe("git");
	});

	it.each([
		[`env "FOO=1" npm test`, "FOO=1"],
		[`env 'FOO'=1 npm test`, "FOO=1"],
		["env 1=2 npm test", "1=2"],
		["env ./a=b npm test", "./a=b"],
	])("takes %s's assignment, however spelt", (command, word) => {
		const stripped = strip(command);
		expect(stripped.wrapperWords).toEqual([word]);
		expect(stripped.words).toEqual(["npm", "test"]);
	});

	it("reads no flag after env's first assignment, which it would exec", () => {
		expect(strip("env A=1 -C /x git status")).toEqual({
			words: ["-C", "/x", "git", "status"],
			wrapperWords: ["A=1"],
			chdirs: [],
			unread: [],
			watched: false,
		});
	});

	it.each([
		["flock /l nice npm test", ["npm", "test"]],
		["flock /l exec npm test", ["npm", "test"]],
		["flock /l echo hi", ["echo", "hi"]],
		["flock /l /usr/local/bin/npm test", ["/usr/local/bin/npm", "test"]],
		["flock - npm test", ["npm", "test"]],
		["flock /l -n npm test", ["-n", "npm", "test"]],
	])(
		"reads no option in the command after flock's file: %s",
		(command, words) => {
			expect(strip(command).words).toEqual(words);
		},
	);

	it("splits each word watch hands sh -c, joined or not", () => {
		const stripped = strip(`watch npm 'run test'`);
		expect(stripped.words).toEqual(["npm", "run", "test"]);
		expect(stripped.watched).toBe(true);
	});

	it("takes sudo's assignment as a word of its own", () => {
		const stripped = strip("sudo FOO=1 npm test");
		expect(stripped.wrapperWords).toEqual(["FOO=1"]);
		expect(stripped.words).toEqual(["npm", "test"]);
	});

	it("leaves a wrapper its caller judges standing, past the ones it strips", () => {
		const { words } = one(
			"nohup taskset 1 yes",
			(c, spans) => unwrap(c.words, spans, ["taskset"])[0],
		);
		expect(words).toEqual(["taskset", "1", "yes"]);
	});

	it("reads no flags on a word it cannot name", () => {
		expect(strip("$W -C /x git status").words[0]).toBe("$W");
	});
});

describe("unwrap reads every command a -c string runs (#4699)", () => {
	const runs = (command: string) =>
		one(command, (c, spans) =>
			unwrap(c.words, spans).map((r) => r.words.join(" ")),
		);

	it.each([
		[`env -S 'flock /l -c "true\\ngit push"'`, "a second line"],
		[`env -S 'flock /l -c "true\\r\\ngit push"'`, "a \\r\\n line end"],
		[`flock /l -c "true; git push"`, "a ;"],
		[`flock /l -c "true && git push"`, "a &&"],
		[`flock /l -c "true | git push"`, "a |"],
		[`flock /l -c "true |& git push"`, "a |&"],
	])("reads git push from %s (%s)", (command) => {
		expect(runs(command)).toContain("git push");
	});

	it.each([
		[`flock /l -c "git push 2>&1"`, "2>&1"],
		[`flock /l -c "git push >| log"`, ">|"],
		[`flock /l -c "git push &> log"`, "&>"],
	])("leaves %s one command, its %s a redirection", (command) => {
		expect(runs(command)).toHaveLength(1);
	});

	it("answers the runs in the order sh runs them", () => {
		expect(runs(`flock /l -c "a\nflock /m -c b\nd"`)).toEqual(["a", "b", "d"]);
	});

	it("drops the rest of a line from its comment, not the lines after it", () => {
		expect(runs(`flock /l -c "a # b; c\nd"`)).toEqual(["a", "d"]);
	});

	it("strips each later command's own wrappers", () => {
		expect(runs(`flock /l -c "true\nnohup git push"`)).toEqual([
			"true",
			"git push",
		]);
	});

	it("carries the wrappers stripped before the string to each later run", () => {
		const later = one(
			`env -C /d A=1 flock /l -c "true; git push"`,
			(c, spans) => unwrap(c.words, spans).at(1),
		);
		expect(later).toEqual({
			words: ["git", "push"],
			wrapperWords: ["A=1"],
			chdirs: [{ dir: "/d", holds: "always" }],
			unread: [],
			watched: false,
		});
	});

	it("keeps a first run's own env off the runs after it", () => {
		const later = one(`flock /l -c "env A=1 true; git push"`, (c, spans) =>
			unwrap(c.words, spans).at(1),
		);
		expect(later?.wrapperWords).toEqual([]);
	});

	it("reads watch -x's words as one command", () => {
		expect(runs(`watch -x echo "a; git push"`)).toHaveLength(1);
	});

	it("marks each of watch's runs watched", () => {
		const watched = one(`watch "true; git push"`, (c, spans) =>
			unwrap(c.words, spans).map((r) => r.watched),
		);
		expect(watched).toEqual([true, true]);
	});

	/** Each run's words, env and directories read through literal, `|` apart,
	 * each directory with how it holds. */
	const read = (command: string) =>
		one(command, (c, spans) =>
			unwrap(c.words, spans).map((r) =>
				[
					bracket(r.words, spans),
					bracket(r.wrapperWords, spans),
					r.chdirs
						.map((d) => `[${literal(d.dir, spans).text} ${d.holds}]`)
						.join(""),
				].join("|"),
			),
		);

	it.each([
		[`flock /l -c "if true; then git push; fi"`, "then"],
		[`flock /l -c "{ git push; }"`, "{"],
		[`flock /l -c "(git push)"`, "("],
		[`flock /l -c "! git push"`, "!"],
		[`flock /l -c 'git "push"'`, "a quoted word"],
		[`flock /l -c 'echo $(git push)'`, "a $(…)"],
	])("reads git push from %s (%s, #4863)", (command) => {
		expect(read(command)).toContain("[git][push]||");
	});

	it("leaves a ; inside quotes in its command (#4863)", () => {
		expect(read(`flock /l -c 'echo "a; git push"'`)).toEqual([
			"[echo][a; git push]||",
		]);
	});

	it.each([
		[`flock /l -c "GIT_DIR=/x git push"`, "[git][push]|[GIT_DIR=/x]|"],
		[
			`flock /l -c "GH_REPO=a/b gh issue close 1"`,
			"[gh][issue][close][1]|[GH_REPO=a/b]|",
		],
	])(
		"puts the leading assignment of %s in its run's wrapperWords (#4863)",
		(command, run) => {
			expect(read(command)).toEqual([run]);
		},
	);

	it("moves the runs after a cd, and not those a subshell or pipe ends (#4863)", () => {
		expect(
			read(`flock /l -c "cd /s; git a; (cd /t; git b); cd /u | true; git c"`),
		).toEqual([
			"[cd][/s]||",
			"[git][a]||[/s if-dir]",
			"[cd][/t]||[/s if-dir]",
			"[git][b]||[/s if-dir][/t if-dir]",
			"[cd][/u]||[/s if-dir]",
			"[true]||[/s if-dir]",
			"[git][c]||[/s if-dir]",
		]);
	});

	it("reads a cd whose target no word gives as unresolved (#4863)", () => {
		expect(read(`flock /l -c "cd -; git a"`).at(1)).toBe(
			"[git][a]||[$(cd -) if-dir]",
		);
	});

	it("holds a cd as stepCwd does: sure for its && chain, else maybe (#4863)", () => {
		expect(read(`flock /l -c "cd /a && git x; git y"`).slice(1)).toEqual([
			"[git][x]||[/a always]",
			"[git][y]||[/a if-dir]",
		]);
		expect(read(`flock /l -c "true && cd /a; git x"`).at(-1)).toBe(
			"[git][x]||[/a maybe]",
		);
		expect(read(`flock /l -c "if true; then cd /a; fi; git x"`).at(-1)).toBe(
			"[git][x]||[/a maybe]",
		);
	});

	it("exports a name alone with the value the script gave it (#4863)", () => {
		expect(
			read(`flock /l -c "export A=1; export A; gh a; B=2; export B; gh b"`),
		).toContain("[gh][b]|[A=1][B=2]|");
		expect(read(`flock /l -c "export A=1; A=3; gh a"`).at(-1)).toBe(
			"[gh][a]|[A=3]|",
		);
	});

	it.each([
		[`flock /l -c "GIT_DIR=/x; git a"`, "an assignment alone"],
		[`flock /l -c "eval export GIT_DIR=/x; git a"`, "eval"],
		[`flock /l -c "export GIT_DIR=/y; set -a; GIT_DIR=/x; git a"`, "set -a"],
	])(
		"marks a repo variable %s moves unread for the runs after it (#4863)",
		(command) => {
			const unread = one(command, (c, spans) => unwrap(c.words, spans).at(-1));
			expect(unread?.unread).toEqual(["GIT_DIR"]);
		},
	);

	it("reads each export and unset in order (#4863)", () => {
		expect(
			read(
				`env -C /d flock /l -c "export A=1 B=2; gh a; unset A; gh b; export -n B; gh c"`,
			),
		).toEqual([
			"[export][A=1][B=2]||[/d always]",
			"[gh][a]|[A=1][B=2]|[/d always]",
			"[unset][A]|[A=1][B=2]|[/d always]",
			"[gh][b]|[B=2]|[/d always]",
			"[export][-n][B]|[B=2]|[/d always]",
			"[gh][c]||[/d always]",
		]);
	});

	it("hands gitWords the git push a later line runs", () => {
		const subs = one(`env -S 'flock /l -c "true\\ngit push"'`, (c, spans) =>
			gitWords(c.words, spans).map((g) => g.sub),
		);
		expect(subs).toEqual(["push"]);
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
			const [r] = commitPathsArgs(c.words, spans);
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
			const [a] = commitPathsArgs(c.words, spans);
			const r = a ? commitPathsParse(a, spans) : null;
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

	it("ends the options at --end-of-options under git's reading alone (#4008)", () => {
		const read = (gitLong?: (flag: string) => string) => {
			const seen: string[] = [];
			scanFlags(
				"",
				["-f", "--end-of-options", "--no-force", "--"],
				(kind, name, value) => {
					seen.push(`${kind}:${name || value}`);
				},
				gitLong,
			);
			return seen;
		};
		expect(read((flag) => flag)).toEqual([
			"flag:-f",
			"flag:--end-of-options",
			"arg:--no-force",
			"arg:--",
		]);
		expect(read()).toEqual([
			"flag:-f",
			"flag:--end-of-options",
			"flag:--no-force",
			"flag:--",
		]);
	});

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
