// @vitest-environment node
/*
 * lib/unchecked-rm.js, guard-rm-unchecked.js's core (#2801), in process:
 * which `rm` commands Claude Code's built-in removal check cannot resolve
 * (#2436), what the refusal says, and when the once lets a re-send through.
 *
 * The latch read, its key and the writability probe are fakes passed as
 * values; the rule store is the real one, read in process. The production
 * adapters — the latch on disk, the markers directory's writability, the
 * session key — are crossed in guard-rm-unchecked.test.ts.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

type Decision = {
	deny: string;
	latchWrites: { name: string; text: string }[];
} | null;

const { decide } = require("./unchecked-rm.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const FALLBACK =
	"An rm Claude Code cannot check is a permission prompt no allow entry clears; the rule could not be read from docs/agents/rules/rm-unchecked.txt. Read that file before doing anything else.";

interface Over {
	vars?: Record<string, string>;
	latches?: string[];
	key?: { agent: string; sid: string } | null;
	isLatchWritable?: boolean;
	ruleText?: (id: string) => string;
	corePaths?: (t: string) => string;
}

/**
 * The core's context: `latches` held, the latch directory writable unless
 * said, and kitContextFake's defaults for the rest — a keyed main session, no
 * shell vars, the real rule store, paths spelt as written.
 */
function harness({ latches = [], isLatchWritable = true, ...over }: Over = {}) {
	const logs: string[] = [];
	const ctx = kitContextFake({
		isDir: () => true,
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		readLatch: (name: string) => (latches.includes(name) ? "" : null),
		isLatchWritable: () => isLatchWritable,
		...over,
	});
	return { ctx, logs };
}

const judge = (command: string, over: Over = {}) => {
	const { ctx, logs } = harness(over);
	return { decision: decide(command, ctx), logs };
};

/** The latch guard-entry.js's latchPath names for `command`: its hash, newlines chomped. */
const latchOf = (command: string) =>
	`rm-unchecked.${crypto
		.createHash("sha1")
		.update(command.replace(/\n+$/, ""))
		.digest("hex")
		.slice(0, 16)}`;

const varSlash = (t: string) =>
	`its target \`${t}\` opens on a variable, and holds one this command never sets, so the check reads it as \`/\` when that variable is empty`;
const cdGlob = (t: string) =>
	`its target \`${t}\` is a relative glob after a \`cd\`, which the check cannot resolve`;
const shell = (t: string) =>
	`it runs \`rm\` beside a shell running \`${t}\`, a script the check cannot read, so it refuses every \`rm\` in the command, a literal one included`;

const refusal = (clause: string, rule = readRuleText("rm-unchecked")) =>
	`Refused once: Claude Code's built-in removal check would prompt on this command — ${clause}. Re-send it unchanged and it goes through to that check.\n\n${rule}`;

const refused = (command: string, clause: string, over: Over = {}) => {
	const { decision, logs } = judge(command, over);
	expect(decision).toEqual({
		deny: refusal(clause),
		latchWrites: [{ name: latchOf(command), text: "" }],
	});
	expect(logs).toEqual([]);
};

describe("an rm the harness cannot check is refused, naming both spellings", () => {
	it.each([
		[
			"rm -rf $T/*",
			"a variable the command never sets, then a slash",
			varSlash("$T/*"),
		],
		['rm -f "$S/$f"', "the same, quoted", varSlash("$S/$f")],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["rm -rf ${D}/x", "the same, braced", varSlash("${D}/x")],
		[
			"T=$(mktemp -d); rm -rf $T/*",
			"a variable set from a command substitution, probed denied on #2436",
			varSlash("$T/*"),
		],
		[
			"cd /tmp && rm -f corpus/*",
			"a relative glob after a cd",
			cdGlob("corpus/*"),
		],
		[
			"T=$(mktemp -d -p .claude/tmp p.XXXX); for c in a b; do g=x.sh; bash $g; done; rm -rf $T",
			"rm beside a shell running a variable's script",
			shell("$g"),
		],
		["bash -c 'rm -rf \"$x\"'", "an rm inside a shell -c script", shell("-c")],
		[
			"bash -c 'make'; rm -rf .claude/tmp/lit",
			"a literal rm beside a shell -c script",
			shell("-c"),
		],
		[
			"P=/home/x; for d in c d e; do rm -rf $P/$d; done",
			"a second variable in the target the command never sets",
			varSlash("$P/$d"),
		],
		[
			"bash -c 'echo; rm -rf x' arg0",
			"an rm after the -c script's first command, with a $0",
			shell("-c"),
		],
		["bash -o pipefail -c 'rm x'", "a -o value before -c", shell("-c")],
		['env bash -c "rm x"', "a shell behind env", shell("-c")],
		["sudo rm -rf $T/*", "an rm behind sudo", varSlash("$T/*")],
	])("%s is refused — %s", (command, _why, clause) => {
		refused(command, clause);
		expect(judge(command).decision?.deny).toContain("A LITERAL PATH");
		expect(judge(command).decision?.deny).toContain("NO `rm` AT ALL");
	});

	it("lets the same command through once its latch is there, and refuses a different one", () => {
		expect(
			judge("rm -rf $T/*", { latches: [latchOf("rm -rf $T/*")] }).decision,
		).toBeNull();
		refused("rm -rf $U/*", varSlash("$U/*"), {
			latches: [latchOf("rm -rf $T/*")],
		});
	});
});

describe("an rm the harness resolves passes silently", () => {
	it.each([
		["rm -rf .claude/tmp/abc-1234", "a literal path"],
		["rm file.txt", "a plain rm"],
		["T=.claude/tmp/x; rm -rf $T/*", "a variable the command sets first"],
		["export T=.claude/tmp/x; rm -rf $T/*", "a variable an export sets"],
		[
			"R=sub; S=v3; rm -f $R/$S/a",
			"every variable set first, passing on #2436",
		],
		["T=$(mktemp -d); rm -rf $T", "a bare variable, passing on #2436"],
		[
			'for f in a b; do rm "$f"; done',
			"a loop's bare variable, passing on #2436",
		],
		["rm -f corpus/*", "a relative glob with no cd"],
		["bash scripts/x.sh; rm -rf .claude/tmp/a", "a shell running a named file"],
		["bash -c 'echo hi'", "a shell -c script with no rm"],
		['echo "rm -rf $T/x"', "rm only quoted as text"],
		["git rm -r $T/x", "git rm, which the check does not read"],
	])("%s passes — %s", (command) => {
		expect(judge(command)).toEqual({ decision: null, logs: [] });
	});
});

describe("the var-slash limb", () => {
	it.each([
		["/bin/rm -rf $T/x", "an rm named by its path", "$T/x"],
		['rm -f "$T"/x', "a quoted variable, then the slash", "$T/x"],
		["rm -rf $_/x", "an underscore name", "$_/x"],
		["rm -rf -- $T/x", "a target after the options' end", "$T/x"],
		["rm -f $A/x $B/y", "two targets: the first is quoted", "$A/x"],
		["export R=a; rm $R/$S", "a declared name beside one never set", "$R/$S"],
		[
			"export T=$(pwd); rm -rf $T/x",
			"an export of a value it cannot read",
			"$T/x",
		],
		["export T; rm -rf $T/x", "an export with no value", "$T/x"],
		["X=/a; rm -rf $T/$X", "the unset name second", "$T/$X"],
		["rm -f '$T/x'", "a single-quoted dollar, read as its text", "$T/x"],
		["rm -rf $T1/x", "a name with a digit", "$T1/x"],
		[
			"export -T=/a; rm -rf $T/x",
			"a flag word, which declares nothing",
			"$T/x",
		],
		["rm -rf $T/x -f", "an option after the target", "$T/x"],
		[
			"export T='/q'; rm -f $S/x",
			"a quoted declaration beside an unset name (#2801)",
			"$S/x",
		],
		["T=/a || T=/b; rm -rf $T/x", "a name assigned past a `||`", "$T/x"],
		[
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
			"T=/a; rm -rf ${T}/$U",
			"a braced set name before an unset one",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
			"${T}/$U",
		],
		[
			"T=$HOME/x; rm -rf $T/*",
			"a value off a variable the environment lacks",
			"$T/*",
		],
	])("%s is refused — %s", (command, _why, target) => {
		refused(command, varSlash(target));
	});

	it.each([
		["declare -x T=/a; rm -rf $T/x", "a declare"],
		["typeset T=/a; rm -rf $T/x", "a typeset"],
		["readonly T='/q'; rm -rf $T/x", "a readonly, single-quoted"],
		["local T=/q; rm -rf $T/x", "a local"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["D=/a; rm -rf ${D}/x", "a braced name the command sets"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["rm -rf ${T:-a}/x", "a default expansion, which the shape does not name"],
		["rm -rf $1/x", "a positional parameter"],
		["rm -rf ~/x/*", "a tilde"],
		["rm -rf $(pwd)/x", "a command substitution, which this does not read"],
		["$RM -rf $T/x", "an rm named by a variable"],
		["$D/rm -rf $T/x", "an rm under a variable's directory"],
		["rm -f a$T/x", "a target opening on a literal"],
		["T1=/a; rm -rf $T1/x", "a set name with a digit"],
		["timeout 5", "a wrapper with nothing left to run"],
	])("%s passes — %s", (command) => {
		expect(judge(command)).toEqual({ decision: null, logs: [] });
	});

	it("reads a variable the environment holds through an assignment", () => {
		expect(
			judge("T=$HOME/x; rm -rf $T/*", { vars: { HOME: "/h" } }).decision,
		).toBeNull();
	});

	it("quotes a target with its trailing newline gone", () => {
		refused('rm "$T/x\n"', varSlash("$T/x"));
	});
});

describe("the cd-glob limb", () => {
	it.each([
		["cd x && rm a?b", "a question mark", "a?b"],
		["cd x && rm 'x[1]'", "a bracket", "x[1]"],
		["cd /a && rm -- -x*", "a dash-led glob after the options' end", "-x*"],
		["cd x; rm -f a/*.log b/*", "two globs: the first is quoted", "a/*.log"],
		["cd x; rm -i -- *", "a bare star", "*"],
	])("%s is refused — %s", (command, _why, target) => {
		refused(command, cdGlob(target));
	});

	it.each([
		["rm -f corpus/*; cd /a", "a glob before the cd"],
		["cd /a && rm -f /abs/*", "an absolute glob"],
		["cd /a && rm -f $T*", "a variable-led glob, no slash"],
		["cd /a && rm -f plain", "no glob at all"],
		["cd /a && rm -f -x*", "a dash-led word, read as an option"],
	])("%s passes — %s", (command) => {
		expect(judge(command)).toEqual({ decision: null, logs: [] });
	});

	it("names a var-slash target ahead of a cd glob in the same command", () => {
		refused("cd /a && rm -f c/* $T/x", varSlash("$T/x"));
	});
});

describe("the shell limb", () => {
	it.each([
		["sh -c 'rm x'", "sh", "-c"],
		["zsh -c 'rm x'", "zsh", "-c"],
		["dash -c 'rm x'", "dash", "-c"],
		["bash -xc 'rm y'", "a joined -c", "-c"],
		["bash +o pipefail -c 'rm x'", "a +o value before -c", "-c"],
		["bash -c 'a;rm b'", "rm after a ;", "-c"],
		["bash -c 'a|rm b'", "rm after a |", "-c"],
		["bash -c 'a&rm b'", "rm after an &", "-c"],
		["bash -c '(rm b)'", "rm after a (", "-c"],
		["bash -c 'a\nrm b'", "rm after a newline", "-c"],
		["bash -c 'rm\tb'", "rm before a tab", "-c"],
		["bash --rcfile $F; rm lit", "a long option's c read as no -c", "$F"],
		["bash +x $S; rm lit", "a + flag skipped", "$S"],
		["bash -e $S; rm lit", "a - flag skipped", "$S"],
		["bash -c 'x'; rm lit; bash $g", "only the first shell is read", "-c"],
		[
			"bash $g; bash -c 'x'; rm lit",
			"the first shell, a variable's script",
			"$g",
		],
		[
			"bash scripts/a.sh; bash -c 'x'; rm lit",
			"a shell on a named file leaves the next one read",
			"-c",
		],
		["rm lit; bash -c 'make'", "the rm before the shell", "-c"],
		["/bin/bash -c 'rm x'", "a shell named by its path", "-c"],
	])("%s is refused — %s", (command, _why, run) => {
		refused(command, shell(run));
	});

	it.each([
		["bash -c 'a\\rm b'", "rm after a backslash"],
		["bash -c 'xrm b'", "rm inside a word"],
		["bash -c 'rm'", "rm with nothing after it"],
		["bash -c 'echo' 'rm x'", "rm in the $0, not the script"],
		["bash -o c x.sh; rm lit", "a -o value that holds a c"],
		["bash; rm lit", "a shell on no script"],
		["bash -x; rm lit", "a shell on flags alone"],
		["bash -c 'make'", "a -c script, and no rm"],
		["bash $g", "a variable's script, and no rm"],
		["fish -c 'rm x'", "a shell this does not read"],
	])("%s passes — %s", (command) => {
		expect(judge(command)).toEqual({ decision: null, logs: [] });
	});

	it("names a cd glob ahead of a shell in the same command", () => {
		refused("cd x; bash -c 'y'; rm c/*", cdGlob("c/*"));
	});
});

describe("the once", () => {
	it("keys the latch on the command with its trailing newlines gone", () => {
		const name = latchOf("rm -rf $T/x");
		expect(judge("rm -rf $T/x\n\n", { latches: [name] }).decision).toBeNull();
		expect(judge("rm -rf $T/x\n\n").decision?.latchWrites).toEqual([
			{ name, text: "" },
		]);
	});

	it("allows, logged, where the latch has no session key, ahead of any latch read", () => {
		for (const latches of [[], [latchOf("rm -rf $T/x")]])
			expect(judge("rm -rf $T/x", { key: null, latches })).toEqual({
				decision: null,
				logs: ["latch path unresolved — an unchecked rm allowed unrefused"],
			});
	});

	it("allows, logged, where the latch directory is unwritable — and silently where the latch is already there", () => {
		expect(judge("rm -rf $T/x", { isLatchWritable: false })).toEqual({
			decision: null,
			logs: ["latch directory unwritable — an unchecked rm allowed unrefused"],
		});
		expect(
			judge("rm -rf $T/x", {
				isLatchWritable: false,
				latches: [latchOf("rm -rf $T/x")],
			}),
		).toEqual({ decision: null, logs: [] });
	});
});

describe("the refusal's text", () => {
	it("carries the fallback where the rule store cannot give the fragment", () => {
		expect(
			judge("rm -rf $T/x", {
				ruleText: () => {
					throw new Error("no store");
				},
			}).decision?.deny,
		).toBe(refusal(varSlash("$T/x"), FALLBACK));
	});

	it("spells core paths at the plugin root, over the whole text", () => {
		const { decision } = judge("rm -rf $T/x", {
			corePaths: (t) => `<${t}>`,
		});
		expect(decision?.deny).toBe(`<${refusal(varSlash("$T/x"))}>`);
	});

	it("reads a CMD placeholder as nothing", () => {
		refused("rm -rf $T/@CMD@", varSlash("$T/"));
	});
});
