/*
 * cpu-load.js — the guard-cpu-load core (#2801, #3224): a CPU load generator run
 * outside a CPU cap of at most half the machine's cores is refused, and the
 * capped form handed over (#2710).
 *
 * Why (#2710): the load ceiling (#830) gates new launches only; work inside a
 * running session is never gated, so the refusal has to come at the call.
 *
 * WHAT COUNTS AS A GENERATOR — #2710's delegated list:
 *  - `yes` whose output is not piped into a command: backgrounded, run in a
 *    subshell, sent to a file or `/dev/null`, or piped into a sink (`cat`,
 *    `tee`, `dd`, `pv`). `yes | head` passes.
 *  - `stress` and `stress-ng`, but for `--version` and `--help`.
 *  - A shell busy loop sent to the background — `while true`, `while :`,
 *    `while ((1))`, `until false` or `for ((;;))` — whose body runs only shell
 *    builtins (`:`, `true`, `echo`, `printf`, `let`, `test`, an assignment or
 *    arithmetic). A body running any other command, `sleep` or `read`
 *    included, is taken to block.
 *
 * WHAT COUNTS AS A CAP — at most half the machine's cores, #2710's delegated
 * value:
 *  - `systemd-run … -p CPUQuota=<n>%` with n at most 50 × cores (400 here);
 *  - `taskset` to at most half the cores.
 * A cap covers everything its command runs, a `bash -c` string or a script
 * included. TWO CAPS DO NOT ADD UP TO ONE: a second capped generator in the
 * same text, or one backgrounded inside a loop, is refused.
 *
 * WHERE IT LOOKS. The command; a `bash -c`/`sh -c` or `eval` string; and the
 * script a shell runs or sources — `bash x.sh`, `./x.sh`, `source x.sh`, or
 * `bg-run.sh run <name> bash x.sh` — read through the `readScript` port.
 *
 * NUMBERS READ AS BASH ARITHMETIC READS THEM: 64-bit, wrapping, a leading 0
 * octal and an invalid octal no number at all. The split is this core's own,
 * kept rather than lib/shell-parse.js's segments: it keeps each separator,
 * which the segments lose — `yes | head` and `yes & head` split alike there —
 * and it rewrites shell arithmetic, which theirs does not.
 *
 * DENY, NOT WARN (mantahostels#103). NO ESCAPE VARIABLE (mantahostels#109):
 * the capped form is the route.
 *
 * LIMITS
 *  - A script is read only where its path resolves against the payload's cwd;
 *    a `cd` before it is not followed. A script spelled through a variable, or
 *    past MAX_SCRIPT_BYTES, is unread.
 *  - A heredoc fed to a shell (`bash <<EOF`) and a string built at run time
 *    (`bash -c "$(cat x)"`) are unread.
 *  - An interpreter's own busy loop — `node -e 'for(;;);' &`,
 *    `python3 -c 'while True: pass' &` — and a compiled generator are not
 *    recognised.
 *  - `nice` is no cap. `cpulimit` and a cgroup set up by hand are not read.
 *  - A `yes` feeding a process substitution, `head < <(yes)`, is refused as a
 *    subshell is.
 *  - It FAILS OPEN on a core count that does not resolve, recorded
 *    (mantahostels#147), and takes a taskset affinity it cannot read as a cap,
 *    recorded.
 */

const { parseCommand, unmask } = require("./shell-parse.js");
const { literal, unwrap } = require("./shell-words.js");

/* bash arithmetic's constants: the BigInt literal outruns the ES2018 target
 * the type-check holds scripts/ to. */
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

/* How many shells deep a `-c` string or script is followed. A guess: the
 * incident was two (bg-run.sh, then `bash <script>`), and each level re-runs
 * the split. */
const MAX_DEPTH = 3;
/* The largest script read, 256 KB: past every tracked shell file. A 147 KB
 * script scans in 55 ms at load 17 — far inside the hook's 10 s ceiling,
 * every level of MAX_DEPTH included. */
const MAX_SCRIPT_BYTES = 262_144;

/* Shell builtins a busy loop's body may run and still never block. */
const BUSY_BODY = [
	":",
	"true",
	"false",
	"echo",
	"printf",
	"let",
	"test",
	"[",
	"[[",
	"break",
	"continue",
];

/* Reserved words ahead of the command a segment runs. */
const RESERVED = ["do", "then", "else", "elif", "!", "{", "}", "if", "time"];

/* The words judge acts on; any word ending `.sh` besides. */
const RELEVANT = [
	"yes",
	"stress",
	"stress-ng",
	"systemd-run",
	"taskset",
	"source",
	".",
	"eval",
	"bash",
	"sh",
	"dash",
	"zsh",
	"ksh",
];

const SHELLS = ["bash", "sh", "dash", "zsh", "ksh"];

/* The sinks a piped `yes` is still load into. */
const SINKS = ["cat", "tee", "dd", "pv"];

/* systemd-run's flags taking their value as a separate word. */
const QUOTA_VALUE_FLAGS = [
	"-u",
	"--unit",
	"-E",
	"--setenv",
	"-M",
	"--machine",
	"-H",
	"--host",
	"--slice",
	"--description",
	"--uid",
	"--gid",
	"--nice",
	"--working-directory",
	"--on-calendar",
	"--on-active",
	"--timer-property",
	"--path-property",
	"--socket-property",
	"--service-type",
];

/* A shell's flags taking their value as a separate word. */
const SHELL_VALUE_FLAGS = ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

/** `[[:space:]]`, as GNU sed's `\s` reads it. */
const WS = "[ \\t\\n\\v\\f\\r]*";

/**
 * @typedef {object} CpuLoadPorts
 * @property {() => string} coreCount the core count as the environment
 *   gives it: `WFC_CPU_COUNT` where set, else the online count
 * @property {(path: string, maxBytes: number) => string | null} readScript a
 *   script's text; null where it is no readable regular file or is over
 *   `maxBytes`
 * @typedef {import("./kit-context.js").KitContext & CpuLoadPorts} CpuLoadContext
 * @typedef {object} Scan what every level of the scan reads
 * @property {bigint} maxCpus
 * @property {bigint} maxQuota
 * @property {string} base the directory a relative script resolves against
 * @property {CpuLoadContext} ctx
 * @typedef {{ capped: boolean, runFrom: number }} Cap whether a cap's words
 *   cap, and the index of the command they run
 * @typedef {object} Verdict
 * @property {"generator" | "capped" | "multi"} kind a generator outside any
 *   cap; one under a cap; or capped generators whose caps add up past one
 * @property {string} where the command it names
 */

/**
 * A word's literal text, its trailing newlines dropped as a command
 * substitution drops them.
 * @param {string} word masked
 * @param {string[]} spans
 */
function lit(word, spans) {
	const { text, known } = literal(word, spans);
	return { text: text.replace(/\n+$/, ""), known };
}

/** @param {string} w */
const afterSlash = (w) => w.slice(w.lastIndexOf("/") + 1);

/**
 * A run of digits as bash arithmetic reads it: 64-bit and wrapping, a leading
 * 0 octal; null where it is an invalid octal, which bash refuses.
 * @param {string} digits
 */
function arith(digits) {
	if (digits.length > 1 && digits.startsWith("0")) {
		if (/[89]/.test(digits)) return null;
		return BigInt.asIntN(64, BigInt(`0o${digits.slice(1)}`));
	}
	return BigInt.asIntN(64, BigInt(digits));
}

/**
 * The masked text split one line per segment, each ending
 * `\x05<separator>` but a line's last. A redirection's
 * `&` and `|` are no separators; the two arithmetic headers are spelt as
 * `while true`, any other arithmetic as the `let` it is.
 * @param {string} masked
 */
function splitLines(masked) {
	return masked
		.split("\n")
		.map((line) =>
			line
				.replace(/([<>])&/g, "$1\x03")
				.replace(/&>/g, "\x03>")
				.replace(/>\|/g, ">\x04")
				.replace(
					new RegExp(`for${WS}\\(\\(${WS};${WS};${WS}\\)\\)`, "g"),
					"while true",
				)
				.replace(
					new RegExp(`while${WS}\\(\\(${WS}1${WS}\\)\\)`, "g"),
					"while true",
				)
				.replace(/\$\(\([^()]*\)\)/g, "0")
				.replace(/\(\([^()]*\)\)/g, "let")
				.replace(/(&&|\|\||\|&|[;&|()])/g, "\x05$1\n"),
		)
		.join("\n")
		.split("\n");
}

/** A line as `read -ra` splits it: on runs of IFS whitespace. @param {string} s */
const ifsWords = (s) => s.split(/[ \t\n]+/).filter((w) => w !== "");

/**
 * One systemd-run word: how far it steps and the property it sets, or where
 * the command they run starts.
 * @param {string[]} words
 * @param {number} i
 * @param {string[]} spans
 * @returns {{ step: number, v: string } | { runFrom: number }}
 */
function quotaWord(words, i, spans) {
	const w = lit(words[i] ?? "", spans).text;
	if (w === "--") return { runFrom: i + 1 };
	if (w === "-p" || w === "--property")
		return { step: 2, v: lit(words[i + 1] ?? "", spans).text };
	if (w.startsWith("-p") || w.startsWith("--property="))
		return { step: 1, v: w.replace(/^--property=/, "").replace(/^-p/, "") };
	if (QUOTA_VALUE_FLAGS.includes(w)) return { step: 2, v: "" };
	if (w.startsWith("-")) return { step: 1, v: "" };
	return { runFrom: i };
}

/**
 * The CPUQuota a property sets: undefined where it sets none, null where
 * bash could not read its number. A fraction rounds up: 400.5% is more than
 * four cores.
 * @param {string} v
 * @returns {bigint | null | undefined}
 */
function quotaOf(v) {
	const m = /^CPUQuota=([0-9]+)(\.([0-9]*))?%$/.exec(v);
	if (!m) return;
	const quota = arith(m[1] ?? "");
	if (quota === null || !/[1-9]/.test(m[3] ?? "")) return quota;
	return BigInt.asIntN(64, quota + ONE);
}

/**
 * The systemd-run words: capped where the last CPUQuota they set is at most
 * the scan's quota.
 * @param {string[]} words
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Cap}
 */
function cappedQuota(words, spans, scan) {
	/** @type {bigint | null | undefined} */
	let quota;
	let runFrom = words.length;
	for (let i = 1; i < words.length; ) {
		const r = quotaWord(words, i, spans);
		if ("runFrom" in r) {
			runFrom = r.runFrom;
			break;
		}
		const q = quotaOf(r.v);
		if (q !== undefined) quota = q;
		i += r.step;
	}
	return {
		capped: typeof quota === "bigint" && quota <= scan.maxQuota,
		runFrom,
	};
}

/**
 * The cores one cpu-list part names; null where it cannot be read.
 * @param {string} part
 * @returns {bigint | null}
 */
function partCount(part) {
	const range = /^([0-9]+)-([0-9]+)(:([1-9][0-9]*))?$/.exec(part);
	if (!range) return /^[0-9]+$/.test(part) ? ONE : null;
	const lo = arith(range[1] ?? "");
	const hi = arith(range[2] ?? "");
	if (lo === null || hi === null || hi < lo) return null;
	const stride = arith(range[4] ?? "1") ?? ONE;
	/* A stride wrapped to 0 is bash's division by zero: that sum is dropped,
	 * the count read on. */
	if (stride === ZERO) return ZERO;
	const width = BigInt.asIntN(64, hi - lo);
	return width / stride + ONE;
}

/**
 * The cores a taskset affinity names, a cpu list or a hex mask; null where
 * it cannot be read.
 * @param {string} spec
 * @param {boolean} isList
 * @returns {bigint | null}
 */
function cpuCount(spec, isList) {
	let n = ZERO;
	if (!isList) {
		const mask = spec.replace(/^0x/, "");
		/* 15 hex digits, 60 bits: a mask shell arithmetic still reads as positive. */
		if (!/^[0-9a-fA-F]{1,15}$/.test(mask)) return null;
		for (let m = BigInt(`0x${mask}`); m; m >>= ONE) n += m & ONE;
		return n;
	}
	/* `IFS=, read -ra`: the first line, split on commas, a trailing one
	 * ending the last field rather than opening an empty one. */
	const parts = (spec.split("\n")[0] ?? "").split(",");
	if (parts.at(-1) === "") parts.pop();
	for (const part of parts) {
		const count = partCount(part);
		if (count === null) return null;
		n = BigInt.asIntN(64, n + count);
	}
	return n;
}

/**
 * The taskset words: capped where they pin to at most half the cores. `-p`
 * re-pins a running process and runs nothing.
 * @param {string[]} words
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Cap}
 */
function cappedTaskset(words, spans, scan) {
	let isList = false;
	for (let i = 1; i < words.length; i++) {
		const w = lit(words[i] ?? "", spans).text;
		if (w === "-p" || w === "--pid")
			return { capped: false, runFrom: words.length };
		if (w === "-c" || w === "--cpu-list") isList = true;
		else if (!w.startsWith("-")) {
			const n = cpuCount(w, isList);
			if (n === null) {
				scan.ctx.log(`taskset affinity '${w}' unreadable — taken as a cap`);
				return { capped: true, runFrom: i + 1 };
			}
			return { capped: n <= scan.maxCpus, runFrom: i + 1 };
		}
	}
	return { capped: false, runFrom: words.length };
}

/**
 * Scan other text — a `-c` string, an `eval`'s words, a script — one shell
 * deeper.
 * @param {string} text
 * @param {number} depth
 * @param {string} where
 * @param {Scan} scan
 */
function scanText(text, depth, where, scan) {
	if (depth >= MAX_DEPTH) return null;
	return scanSubject(text, depth, where, scan);
}

/**
 * Scan the script file a shell runs, named by `word`.
 * @param {string} word masked
 * @param {string[]} spans
 * @param {number} depth
 * @param {Scan} scan
 */
function scanScript(word, spans, depth, scan) {
	const { text: shown, known } = lit(word, spans);
	if (!known) return null;
	const path = shown.startsWith("/") ? shown : `${scan.base}/${shown}`;
	const text = scan.ctx.readScript(path, MAX_SCRIPT_BYTES);
	if (text === null) return null;
	/* As `$(<file)` reads it: no NUL, no trailing newline. */
	return scanText(
		text.replaceAll("\0", "").replace(/\n+$/, ""),
		depth,
		shown,
		scan,
	);
}

/** @param {string} where @returns {Verdict} */
const buildGenerator = (where) => ({ kind: "generator", where });

/**
 * @typedef {{ sep: string, next: string, depth: number, where: string }} At
 *   the separator after the command; `next`, the command word of the segment
 *   after it, for a pipe's reader; how deep the scan is; and how a verdict
 *   names the command
 * @typedef {(at: At, words: string[], spans: string[], scan: Scan) =>
 *   Verdict | null} Judge one command's verdict, its words unwrapped
 */

/**
 * The verdict of the command a cap runs, marked capped where the cap holds.
 * @param {Cap} cap
 * @param {(runFrom: number) => Verdict | null} judgeRest
 * @returns {Verdict | null}
 */
function underCap({ capped, runFrom }, judgeRest) {
	const inner = judgeRest(runFrom);
	return capped && inner ? { ...inner, kind: "capped" } : inner;
}

/** @type {Judge} */
const judgeQuota = (at, words, spans, scan) =>
	underCap(cappedQuota(words, spans, scan), (from) =>
		judge(at, words.slice(from), spans, scan),
	);

/** @type {Judge} */
const judgeTaskset = (at, words, spans, scan) =>
	underCap(cappedTaskset(words, spans, scan), (from) =>
		judge(at, words.slice(from), spans, scan),
	);

/** @type {Judge} */
function judgeYes(at, words) {
	if (at.sep !== "|" && at.sep !== "|&") return buildGenerator(at.where);
	if (words.slice(1).some((w) => /^(1?>|&>)/.test(w)))
		return buildGenerator(at.where);
	return SINKS.includes(at.next) ? buildGenerator(at.where) : null;
}

/** @type {Judge} */
function judgeStress(at, words, spans) {
	const only = lit(words[1] ?? "", spans).text;
	if (words.length === 2 && /^(--version|--help|-V|-h|-\?)$/.test(only))
		return null;
	return buildGenerator(at.where);
}

/** @type {Judge} */
const judgeSource = (at, words, spans, scan) =>
	words.length > 1
		? scanScript(words[1] ?? "", spans, at.depth + 1, scan)
		: null;

/** @type {Judge} */
function judgeEval(at, words, spans, scan) {
	const arg = words
		.slice(1)
		.map((w) => `${lit(w, spans).text} `)
		.join("");
	return scanText(arg, at.depth + 1, at.where, scan);
}

/**
 * One shell word ahead of its operand: how far it steps and whether it
 * opens a `-c` string; "check" for `-n`, a syntax check that runs nothing;
 * null for the operand itself.
 * @param {string} w
 * @returns {{ step: number, code: boolean } | "check" | null}
 */
function shellFlag(w) {
	if (SHELL_VALUE_FLAGS.includes(w)) return { step: 2, code: false };
	const flag = w.startsWith("-");
	const long = w.startsWith("--");
	if (flag && w.slice(1).includes("n"))
		return long ? { step: 1, code: false } : "check";
	if (flag && w.slice(1).includes("c")) return { step: 1, code: !long };
	if (flag || w.startsWith("+")) return { step: 1, code: false };
	return null;
}

/**
 * Where a shell's operand stands and whether it is a `-c` string; null for a
 * syntax check.
 * @param {string[]} words
 * @param {string[]} spans
 */
function shellOperand(words, spans) {
	let code = false;
	let i = 1;
	while (i < words.length) {
		const w = lit(words[i] ?? "", spans).text;
		if (w === "--") return { i: i + 1, code };
		const f = shellFlag(w);
		if (f === "check") return null;
		if (f === null) break;
		code ||= f.code;
		i += f.step;
	}
	return { i, code };
}

/**
 * A shell's words: its `-c` string, the command `bg-run.sh run` starts, or
 * the script it runs.
 * @type {Judge}
 */
function judgeShell(at, words, spans, scan) {
	const op = shellOperand(words, spans);
	if (op === null || op.i >= words.length) return null;
	const { i } = op;
	const arg = lit(words[i] ?? "", spans).text;
	if (op.code) return scanText(arg, at.depth + 1, at.where, scan);
	if (afterSlash(arg) === "bg-run.sh") {
		if (lit(words[i + 1] ?? "", spans).text !== "run") return null;
		return judge(at, words.slice(i + 3), spans, scan);
	}
	return scanScript(words[i] ?? "", spans, at.depth + 1, scan);
}

/** @type {Judge} */
const judgeScript = (at, words, spans, scan) =>
	scanScript(words[0] ?? "", spans, at.depth + 1, scan);

/** @type {Map<string, Judge>} */
const JUDGES = new Map([
	["systemd-run", judgeQuota],
	["taskset", judgeTaskset],
	["yes", judgeYes],
	["stress", judgeStress],
	["stress-ng", judgeStress],
	["source", judgeSource],
	[".", judgeSource],
	["eval", judgeEval],
	...SHELLS.map((s) => /** @type {[string, Judge]} */ ([s, judgeShell])),
]);

/**
 * The verdict where the command, or what it runs, generates load; null where
 * it does not.
 * @param {At} at
 * @param {string[]} raw the segment's words, masked
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Verdict | null}
 */
function judge(at, raw, spans, scan) {
	const { words } = unwrap(raw, spans);
	if (words.length === 0) return null;
	const cmd = afterSlash(lit(words[0] ?? "", spans).text);
	const by = JUDGES.get(cmd) ?? (cmd.endsWith(".sh") ? judgeScript : null);
	return by ? by(at, words, spans, scan) : null;
}

/** @param {string[]} words */
const isRelevant = (words) =>
	words.some((w) => {
		const name = afterSlash(w);
		return RELEVANT.includes(name) || name.endsWith(".sh");
	});

/**
 * @typedef {object} ScanState one level's walk over its lines
 * @property {string[]} lines
 * @property {string[]} spans
 * @property {number} depth
 * @property {string} suffix ` (in <file>)`, or "" for the command
 * @property {Scan} scan
 * @property {number} caseDepth
 * @property {boolean} pattern whether the line is in a `case` pattern
 * @property {string} prev the last line's separator
 * @property {Verdict | null} capped the lone capped generator so far
 * @property {{ busy: boolean, head: string }[]} frames the open loops
 */

/**
 * A line's separator and words, reserved words ahead of the command taken
 * off.
 * @param {string} line
 */
function readLine(line) {
	const cut = line.indexOf("\x05");
	const sep = cut === -1 ? "\n" : line.slice(cut + 1);
	const seg = (cut === -1 ? line : line.slice(0, cut))
		.replaceAll("\x03", "&")
		.replaceAll("\x04", "|");
	let words = ifsWords(seg);
	while (words.length > 0 && RESERVED.includes(words[0] ?? ""))
		words = words.slice(1);
	return { sep, words };
}

/**
 * True where the line is a `case`'s own: a pattern runs nothing, so it is
 * skipped from `in` or `;;` to its `)`.
 * @param {ScanState} st accumulator: caseDepth, pattern and prev advance here
 * @param {string[]} words
 * @param {string} sep
 */
function skipsCase(st, words, sep) {
	const first = words[0] ?? "";
	if (st.caseDepth && first === "esac") {
		st.caseDepth -= 1;
		st.pattern = false;
		st.prev = sep;
		return true;
	}
	if (st.pattern) {
		if (sep === ")") st.pattern = false;
		st.prev = sep;
		return true;
	}
	if (st.caseDepth && words.length === 0 && sep === ";" && st.prev === ";")
		st.pattern = true;
	st.prev = sep;
	if (first !== "case") return false;
	st.caseDepth += 1;
	st.pattern = sep !== ")";
	return true;
}

/**
 * A loop's own word: a header opens a frame, `done` closes one, a busy loop
 * sent to the background its verdict. Undefined where the line is no loop
 * word.
 * @param {ScanState} st accumulator: frames are pushed and popped here
 * @param {string[]} words
 * @param {string} sep
 * @returns {Verdict | null | undefined}
 */
function loopWord(st, words, sep) {
	const first = words[0] ?? "";
	if (first === "while" || first === "until") {
		const head = words.join(" ");
		st.frames.push({
			busy: /^(while (true|:)|until false)$/.test(head),
			head,
		});
		return null;
	}
	if (first === "for" || first === "select") {
		st.frames.push({ busy: false, head: "" });
		return null;
	}
	if (first !== "done") return;
	const top = st.frames.pop();
	if (!top) return null;
	const parent = st.frames.at(-1);
	if (parent) parent.busy = false;
	return top.busy && sep === "&"
		? buildGenerator(`${unmask(top.head)}; do …; done &${st.suffix}`)
		: null;
}

/**
 * The command word of the line after a pipe, its reader.
 * @param {string[]} lines
 * @param {number} idx
 */
function readerAfter(lines, idx) {
	const after = lines[idx + 1] ?? "";
	const cut = after.indexOf("\x05");
	return afterSlash(
		ifsWords(cut === -1 ? after : after.slice(0, cut))[0] ?? "",
	);
}

/**
 * Where a judged line stands, for its verdict.
 * @param {ScanState} st
 * @param {string[]} words
 * @param {string} sep
 * @param {number} idx
 * @returns {At}
 */
function lineAt(st, words, sep, idx) {
	const piped = sep === "|" || sep === "|&";
	const shown = `${unmask(words.join(" "))}${sep === "&" ? " &" : ""}`;
	return {
		sep,
		next: piped && idx + 1 < st.lines.length ? readerAfter(st.lines, idx) : "",
		depth: st.depth,
		where: `${shown}${st.suffix}`,
	};
}

/**
 * One line's verdict, where it settles the scan: a generator, a multi, or a
 * capped generator that adds to another cap. A lone capped one is held on
 * `st`.
 * @param {ScanState} st accumulator: capped is set here
 * @param {string} line
 * @param {number} idx
 * @returns {Verdict | null}
 */
function scanLine(st, line, idx) {
	const { sep, words } = readLine(line);
	if (skipsCase(st, words, sep)) return null;
	const first = words[0] ?? "";
	if (words.length === 0 || first.startsWith("#")) return null;
	const loop = loopWord(st, words, sep);
	if (loop !== undefined) return loop;
	/* A loop body running anything but a builtin may block, so is no busy
	 * loop. */
	const top = st.frames.at(-1);
	if (top && !BUSY_BODY.includes(first) && !/^[A-Za-z_].*=/s.test(first))
		top.busy = false;
	if (!isRelevant(words)) return null;
	const verdict = judge(lineAt(st, words, sep, idx), words, st.spans, st.scan);
	if (verdict === null) return null;
	if (verdict.kind !== "capped") return verdict;
	/* A second capped generator, or one started over and over in a loop, adds
	 * its cap to the first. */
	if (st.capped !== null || (st.frames.length > 0 && sep === "&"))
		return { ...verdict, kind: "multi" };
	st.capped = verdict;
	return null;
}

/**
 * The verdict for `text`: its first generator or multi, else a lone capped
 * generator, else null.
 * @param {string} text
 * @param {number} depth
 * @param {string} file the script or string it came from; "" for the command
 * @param {Scan} scan
 * @returns {Verdict | null}
 */
function scanSubject(text, depth, file, scan) {
	const { masked, spans } = parseCommand(text);
	/** @type {ScanState} */
	const st = {
		lines: splitLines(masked),
		spans,
		depth,
		suffix: file ? ` (in ${file})` : "",
		scan,
		caseDepth: 0,
		pattern: false,
		prev: "",
		capped: null,
		frames: [],
	};
	for (const [idx, line] of st.lines.entries()) {
		const verdict = scanLine(st, line, idx);
		if (verdict !== null) return verdict;
	}
	return st.capped;
}

const WHY = {
	generator: "is a CPU load generator with no CPU cap",
	multi:
		"is a capped CPU load generator beside another, or started in a loop — two caps add up to more than one",
};

/**
 * @param {string} command
 * @param {CpuLoadContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const cores = ctx.coreCount();
	if (!/^[1-9][0-9]*$/.test(cores)) {
		ctx.log("the core count did not resolve — every command allowed unchecked");
		return null;
	}
	const half = BigInt.asIntN(64, BigInt(cores)) / TWO;
	const maxCpus = half || ONE;
	const maxQuota = BigInt.asIntN(64, maxCpus * HUNDRED);
	const base = ctx.cwd?.startsWith("/") ? ctx.cwd : ctx.fallbackCwd;
	const verdict = scanSubject(command, 0, "", {
		maxCpus,
		maxQuota,
		base,
		ctx,
	});
	if (verdict === null || verdict.kind === "capped") return null;
	const reason = `Refused: \`${verdict.where}\` ${WHY[verdict.kind]}. Every session shares this machine's ${cores} cores; on 23 Oct 2026 eight uncapped \`yes\` loops starved the kernel's RCU thread and WSL had to be restarted (#2710).

Synthetic load runs inside a cap of at most ${maxCpus} cores, the whole load under one cap:

  systemd-run --user --scope -p CPUQuota=${maxQuota}% -- bash -c '<the load>; wait'
  taskset -c 0-${BigInt.asIntN(64, maxCpus - ONE)} bash -c '<the load>; wait'

\`yes | <command>\`, feeding a command, passes.`;
	return { deny: reason };
}

module.exports = { field: "command", noun: "command", decide };
