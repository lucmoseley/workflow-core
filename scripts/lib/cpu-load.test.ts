// @vitest-environment node
/*
 * lib/cpu-load.js, the guard-cpu-load core (#2801), in process: which
 * commands start CPU load outside a cap of at most half the cores, and which
 * pass (#2710).
 *
 * The first refused case and the first two passing cases are #2710's
 * acceptance criteria; do not thin them. The core count is a port, pinned at
 * 8 unless a case says otherwise, so a 2-core CI runner judges the cap as this
 * machine does. Scripts on disk are a fake reader over SCRIPTS; the real
 * reader is held to it by the contract cases at the foot of this file, and
 * crossed end to end in guard-cpu-load.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny: string } | null;

const { decide } = require("./cpu-load.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = require("./cpu-load-host.js") as {
	buildHostPorts: () => {
		coreCount: () => string;
		readScript: (p: string, maxBytes: number) => string | null;
	};
};

const PROJ = "/proj";
const LOOP = "for _ in 1 2 3 4 5 6 7 8; do yes >/dev/null & done";

const SCRIPTS: Record<string, string> = {
	"loaded.sh": `#!/usr/bin/env bash\n${LOOP}\nfor i in 1 2; do npx vitest run x; done\n`,
	"outer.sh": "#!/usr/bin/env bash\nbash loaded.sh\n",
	"outer2.sh": "#!/usr/bin/env bash\nbash outer.sh\n",
	"capped.sh":
		"systemd-run --user --scope -p CPUQuota=200% bash -c 'yes >/dev/null & wait'\n",
	"quiet.sh":
		"#!/usr/bin/env bash\nyes | head -3\nwhile :; do sleep 1; done &\n",
	"busy.sh": "while true; do :; done &\n\n\n",
	"nul.sh": "echo a\0b\nye\0s >/dev/null &\n",
};

interface Over {
	cores?: string;
	cwd?: string;
	fallbackCwd?: string;
	scripts?: Record<string, string>;
}

/** The script reader fake: `scripts` by name, a relative name under `base`. */
const fakeReader =
	(scripts: Record<string, string>, base: string) =>
	(p: string, maxBytes: number) => {
		for (const [name, text] of Object.entries(scripts)) {
			const at = name.startsWith("/") ? name : `${base}/${name}`;
			if (at === path.posix.normalize(p))
				return Buffer.byteLength(text) > maxBytes ? null : text;
		}
		return null;
	};

function harness(over: Over = {}) {
	const logs: string[] = [];
	const reads: { p: string; maxBytes: number }[] = [];
	const read = fakeReader(over.scripts ?? SCRIPTS, PROJ);
	const ctx = kitContextFake({
		cwd: "cwd" in over ? over.cwd : PROJ,
		fallbackCwd: over.fallbackCwd ?? "/fallback",
		log: (what: string) => logs.push(what),
		coreCount: () => over.cores ?? "8",
		readScript: (p: string, maxBytes: number) => {
			reads.push({ p, maxBytes });
			return read(p, maxBytes);
		},
	});
	return { judge: (command: string) => decide(command, ctx), logs, reads };
}

/** The refusal's text, or null where the command passes. */
const refusal = (command: string, over: Over = {}) =>
	harness(over).judge(command)?.deny ?? null;

const G = "is a CPU load generator with no CPU cap";
const M =
	"is a capped CPU load generator beside another, or started in a loop — two caps add up to more than one";

/** The whole refusal for 8 cores. */
const refused8 = (shown: string, why = G) =>
	`Refused: \`${shown}\` ${why}. Every session shares this machine's 8 cores; on 23 Oct 2026 eight uncapped \`yes\` loops starved the kernel's RCU thread and WSL had to be restarted (#2710).

Synthetic load runs inside a cap of at most 4 cores, the whole load under one cap:

  systemd-run --user --scope -p CPUQuota=400% -- bash -c '<the load>; wait'
  taskset -c 0-3 bash -c '<the load>; wait'

\`yes | <command>\`, feeding a command, passes.`;

describe("an uncapped generator is refused (#2710)", () => {
	it.each([
		LOOP,
		"scripts/bg-run.sh run load bash loaded.sh",
		"bash scripts/bg-run.sh run load bash loaded.sh",
		"bash loaded.sh",
		"./loaded.sh",
		"bash outer.sh",
		`bash -c '${LOOP}'`,
		`systemd-run --user --scope -p CPUQuota=800% bash -c '${LOOP}'`,
		"systemd-run --user --scope bash loaded.sh",
		"taskset -c 0-7 bash loaded.sh",
		"taskset 0xff yes >/dev/null &",
		"yes > /dev/null",
		"nice -n 19 yes >/dev/null &",
		"(yes >/dev/null &)",
		"{ yes >/dev/null & }",
		"stress-ng --cpu 8 --timeout 60",
		"timeout 60 stress --cpu 8",
		"while true; do :; done &",
		"while :; do true; done >/dev/null 2>&1 &",
		"until false; do :; done &",
		"for ((;;)); do :; done &",
		"while ((1)); do :; done &",
		"while true; do i=$((i+1)); done &",
		"while true; do ((n++)); done &",
		"while true; do echo >/dev/null; done &",
		"source loaded.sh",
		". loaded.sh",
		'eval "yes >/dev/null &"',
		"(yes >/dev/null) &",
		"for i in 1 2 3 4; do (yes > /dev/null) & done",
		"yes | cat >/dev/null &",
		"yes >/dev/null | true &",
		"bash --rcfile x.sh -c 'yes >/dev/null &'",
		"systemd-run --user --scope -p CPUQuota=400.5% yes >/dev/null &",
	])("%s", (command) => {
		expect(refusal(command)).toContain(G);
	});

	it.each([
		"for c in 0 1 2 3 4 5 6 7; do systemd-run --user --scope -p CPUQuota=100% yes >/dev/null & done",
		"taskset -c 4-7 yes >/dev/null & taskset -c 0-3 yes >/dev/null &",
		"for i in 1 2; do bash capped.sh & done",
	])("adds up two caps: %s", (command) => {
		expect(refusal(command)).toContain("two caps add up");
	});

	it("names the generator, its script and the capped form, byte for byte", () => {
		expect(refusal("bash scripts/bg-run.sh run load bash loaded.sh")).toBe(
			refused8("yes >/dev/null & (in loaded.sh)"),
		);
	});

	it("names a capped pair and the loop it is started in, byte for byte", () => {
		expect(
			refusal(
				"taskset -c 4-7 yes >/dev/null & taskset -c 0-3 yes >/dev/null &",
			),
		).toBe(refused8("taskset -c 0-3 yes >/dev/null &", M));
		expect(
			refusal(
				"for c in 1 2; do systemd-run -p CPUQuota=100% yes >/dev/null & done",
			),
		).toBe(refused8("systemd-run -p CPUQuota=100% yes >/dev/null &", M));
	});

	it("names a busy loop by its header, and the string it ran in", () => {
		expect(refusal("for ((;;)); do :; done &")).toBe(
			refused8("while true; do …; done &"),
		);
		expect(refusal("bash -c 'until false; do :; done &'")).toBe(
			refused8('until false; do …; done & (in bash -c "…")'),
		);
		expect(refusal("bash busy.sh")).toBe(
			refused8("while true; do …; done & (in busy.sh)"),
		);
		expect(refusal("bash -c 'yes >/dev/null'")).toBe(
			refused8('yes >/dev/null (in bash -c "…")'),
		);
	});

	it("sizes the cap to half the cores, and to one core on a one-core machine", () => {
		const command = `systemd-run --user --scope -p CPUQuota=200% bash -c '${LOOP}'`;
		expect(refusal(command, { cores: "2" })).toContain(G);
		expect(refusal(command, { cores: "4" })).toBeNull();
		expect(refusal("taskset -c 0 yes >/dev/null &", { cores: "3" })).toBeNull();
		expect(
			refusal("taskset -c 0-1 yes >/dev/null &", { cores: "3" }),
		).toContain(G);
		const one = refusal("yes >/dev/null &", { cores: "1" });
		expect(one).toContain("this machine's 1 cores;");
		expect(one).toContain("a cap of at most 1 cores,");
		expect(one).toContain("-p CPUQuota=100% -- bash -c");
		expect(one).toContain("taskset -c 0-0 bash -c");
		expect(
			refusal("systemd-run -p CPUQuota=100% yes &", { cores: "1" }),
		).toBeNull();
	});
});

describe("a capped generator, and every other command, passes (#2710)", () => {
	it.each([
		`systemd-run --user --scope -p CPUQuota=200% bash -c '${LOOP}; wait'`,
		`systemd-run --user --scope -p CPUQuota=200% -- bash -c '${LOOP}; wait'`,
		"systemd-run --user --scope --property=CPUQuota=400% bash loaded.sh",
		"systemd-run --user --scope -p CPUQuota=200% bash scripts/bg-run.sh run load bash loaded.sh",
		"taskset -c 0-1 bash loaded.sh",
		"taskset -c 0,2,4,6 stress-ng --cpu 4",
		"taskset 0x3 yes > /dev/null &",
		"yes | head",
		"yes | head -3",
		"yes y | npm init",
		"yes 2>&1 | head",
		"echo yes; done",
		"git log --oneline | head",
		"while :; do sleep 1; done &",
		"while true; do :; done",
		"bash quiet.sh",
		"bash missing.sh",
		'echo "yes >/dev/null &"',
		"yes 2>/dev/null | head",
		"stress-ng --version",
		"bash -n loaded.sh",
		"bash capped.sh",
		"while ((i < 10)); do :; done &",
		"while true; do nc -l 8080; done &",
		"case $x in stress | stress-ng) echo hi ;; esac",
		"systemd-run --user --scope -p CPUQuota=400.0% yes >/dev/null &",
		"systemd-run --user --scope -p CPUQuota=400% bash -c 'systemd-run --user --scope -p CPUQuota=100% yes >/dev/null & systemd-run --user --scope -p CPUQuota=100% yes >/dev/null & wait'",
		"taskset -c 0-7:2 yes >/dev/null &",
		'taskset -c "$HALF" yes >/dev/null &',
		"bash -n scripts/guard-cpu-load.sh",
	])("%s", (command) => {
		expect(refusal(command)).toBeNull();
	});
});

describe("what counts as a generator", () => {
	it.each([
		["yes | tee f", G],
		["yes | dd of=/dev/null", G],
		["yes | pv -q", G],
		["yes | /usr/bin/cat", G],
		["yes |& cat", G],
		["yes 1>/dev/null | head", G],
		["yes &>/dev/null | head", G],
		["yes && echo", G],
		["yes; echo", G],
		["/usr/bin/yes > /dev/null", G],
		["stress --help --cpu 2", G],
		["stress", G],
		["yes", G],
	])("refuses %s", (command, why) => {
		expect(refusal(command)).toContain(why);
	});

	it.each([
		"yes |& head",
		"yes | sort",
		"yes 2> x | head",
		"stress -h",
		"stress -V",
		"stress -?",
		"stress-ng --help",
		'"yes" > /dev/null',
	])("passes %s", (command) => {
		expect(refusal(command)).toBeNull();
	});

	it("reads a pipe's reader off the segment after it, not the one before", () => {
		expect(refusal("cat | yes | head")).toBeNull();
		expect(refusal("head | yes | cat")).toContain(G);
		expect(refusal("yes |")).toBeNull();
	});

	it("shows a redirection's `&` as typed (#2801)", () => {
		expect(refusal("yes 2>&1")).toBe(refused8("yes 2>&1"));
		expect(refusal("yes &> x")).toBe(refused8("yes &> x"));
		expect(refusal("yes >| x")).toBe(refused8("yes >| x"));
	});

	it("reads a busy loop's body as builtins only", () => {
		for (const body of [
			"false",
			"printf x",
			"let x++",
			"test 1",
			"[ 1 ]",
			"[[ 1 ]]",
			"break",
			"continue",
			"x=1",
			"true; echo",
		])
			expect(refusal(`while true; do ${body}; done &`)).toContain(G);
		for (const body of ["sleep 0", "read x", "1x=2", "cat"])
			expect(refusal(`while true; do ${body}; done &`)).toBeNull();
	});

	it("takes a nested loop for a body that blocks", () => {
		expect(refusal("while true; do while true; do :; done; done &")).toBeNull();
		expect(refusal("while true; do for i in 1; do :; done; done &")).toBeNull();
		expect(refusal("while true; do :; done; done &")).toBeNull();
		expect(refusal("done &")).toBeNull();
	});

	it("knows a busy header only as `while true`, `while :` and `until false`", () => {
		expect(refusal("while : ; do : ; done &")).toContain(G);
		expect(refusal("while true\ndo\n:\ndone &")).toContain(G);
		for (const head of [
			"until true",
			"while false",
			"while true x",
			"while ((2))",
			"select x in a",
			"for x in a",
			"for ((i=0;;i++))",
		])
			expect(refusal(`${head}; do :; done &`)).toBeNull();
		expect(refusal("for (( ; ; )); do :; done &")).toContain(G);
		expect(refusal("while (( 1 )); do :; done &")).toContain(G);
	});

	it("skips a reserved word ahead of the command, and a comment", () => {
		expect(refusal("time yes >/dev/null")).toContain(G);
		expect(refusal("! yes >/dev/null")).toContain(G);
		expect(refusal("if true; then yes >/dev/null & fi")).toContain(G);
		expect(refusal("if :; then :; else stress; fi")).toContain(G);
		expect(refusal("# yes >/dev/null")).toBeNull();
		expect(refusal("echo hi # yes &")).toBeNull();
		expect(refusal("# x; yes &")).toBeNull();
		expect(refusal("x=1 # c\nyes &")).toContain(G);
	});

	it("runs nothing in a case pattern", () => {
		expect(refusal("case $x in yes) echo ;; stress) echo ;; esac")).toBeNull();
		expect(refusal("case $x in (yes) echo ;; esac")).toBeNull();
		expect(refusal("case $x in a) yes >/dev/null & ;; esac")).toContain(G);
		expect(refusal("case $x in a) echo; ;; b) yes & ;; esac")).toContain(G);
		expect(refusal("case x in a|b) :;; esac; yes &")).toContain(G);
		expect(
			refusal("case $x in a) case $y in b) :;; esac;; esac; stress &"),
		).toContain(G);
		expect(refusal("case $x in\n a) yes &\n ;;\nesac")).toContain(G);
	});
});

describe("what counts as a cap", () => {
	it.each([
		"systemd-run -pCPUQuota=200% yes &",
		"systemd-run --property=-pCPUQuota=200% yes &",
		"systemd-run -u name -p CPUQuota=100% yes &",
		"systemd-run --unit name --slice s -p CPUQuota=100% yes &",
		"systemd-run -p CPUQuota=900% -p CPUQuota=200% yes &",
		"systemd-run -p CPUQuota=100.% yes &",
		"systemd-run -p CPUQuota=100.00% yes &",
		"systemd-run -p CPUQuota=399.9% yes &",
		"systemd-run -p 'CPUQuota=100%' yes &",
		"systemd-run -p CPUQuota=0400% yes &",
		"systemd-run -p CPUQuota=0617% yes &",
		"systemd-run -p CPUQuota=18446744073709551616% yes &",
		"/usr/bin/systemd-run -p CPUQuota=100% yes &",
		"systemd-run -p CPUQuota=100% taskset 0xff yes &",
		"taskset 3 yes &",
		"taskset 0x0f yes &",
		"taskset f0 yes &",
		"taskset -c 0-3 yes &",
		"taskset -c 0,1,2,3 yes &",
		"taskset -c 0-6:2 yes &",
		"taskset -c 0-7:3 yes &",
		"taskset -c 00-03 yes &",
		"taskset -c 0,1,2,3, yes &",
		"taskset --cpu-list 0-1 yes &",
		"taskset -a -c 0-1 yes &",
		"taskset -c 0-0:18446744073709551616 yes &",
		"taskset -c 0-3 taskset -c 0-7 yes &",
		"systemd-run -p CPUQuota=100% bash loaded.sh",
	])("caps %s", (command) => {
		expect(refusal(command)).toBeNull();
	});

	it.each([
		"systemd-run -p CPUQuota=401% yes &",
		"systemd-run -p CPUQuota=400.01% yes &",
		"systemd-run -p CPUQuota=200% -p CPUQuota=900% yes &",
		"systemd-run -p CPUQuota=0777% yes &",
		"systemd-run -p CPUQuota=08% yes &",
		"systemd-run -p CPUQuota=08.5% yes &",
		"systemd-run -p MemoryMax=1G yes &",
		"systemd-run -p CPUQuota=100 yes &",
		'systemd-run -p "$Q" yes &',
		"systemd-run --user yes &",
		"taskset 0x1f yes &",
		"taskset -c 0-4 yes &",
		"taskset -c 0,1,2,3,4 yes &",
		"taskset 0xff systemd-run -p CPUQuota=900% yes &",
	])("does not cap %s", (command) => {
		expect(refusal(command)).toContain(G);
	});

	it("caps under a CPUQuota that names nothing to run, and lets it pass", () => {
		expect(refusal("systemd-run -p CPUQuota=100% --")).toBeNull();
		expect(refusal("systemd-run -p CPUQuota=100%")).toBeNull();
		expect(refusal("systemd-run -p")).toBeNull();
		expect(refusal("taskset -c")).toBeNull();
		expect(refusal("taskset 0x3")).toBeNull();
	});

	it("re-pins no load with `taskset -p`, and runs nothing past it", () => {
		expect(refusal("taskset -p 0x3 yes")).toBeNull();
		expect(refusal("taskset --pid 0xff yes")).toBeNull();
		expect(refusal("taskset -p 0xff yes")).toBeNull();
		expect(refusal("taskset -c -p 0-1 stress")).toBeNull();
	});

	it("takes an affinity it cannot read as a cap, and records it", () => {
		for (const spec of [
			"zz",
			"0xfffffffffffffffff",
			"-c 3-0",
			"-c 08-09",
			"-c ,0",
			"-c 0,,1",
			"-c a",
			"-c 1-",
		]) {
			const h = harness();
			expect(h.judge(`taskset ${spec} yes >/dev/null &`)).toBeNull();
			const w = spec.replace(/^-c /, "");
			expect(h.logs).toEqual([
				`taskset affinity '${w}' unreadable — taken as a cap`,
			]);
		}
	});

	it("counts an empty affinity list as no cores", () => {
		const h = harness();
		expect(h.judge("taskset -c '' yes &")).toBeNull();
		expect(h.logs).toEqual([]);
	});

	it("counts a mask's bits, up to fifteen hex digits", () => {
		expect(refusal("taskset 0x10101010 yes &")).toBeNull();
		expect(refusal("taskset 0x11111 yes &")).toContain(G);
		expect(refusal("taskset 000000000000003 yes &")).toBeNull();
	});

	it("reads a cpu list only on its first line", () => {
		expect(refusal("taskset -c '0-1\n0-7' yes &")).toBeNull();
		expect(refusal("taskset -c '0-4\n0-1' yes &")).toContain(G);
	});

	it("covers what a capped shell or script runs, but a second cap adds", () => {
		expect(refusal("taskset -c 0-3 bash -c 'yes & yes &'")).toBeNull();
		expect(refusal("systemd-run -p CPUQuota=100% yes; stress")).toContain(G);
		expect(
			refusal(
				"systemd-run -p CPUQuota=100% yes; systemd-run -p CPUQuota=100% yes",
			),
		).toContain("two caps add up");
		expect(refusal("for i in 1; do taskset -c 0-1 yes; done &")).toBeNull();
		expect(refusal("source capped.sh; source capped.sh")).toContain(
			"two caps add up",
		);
	});

	it("keeps a capped pair inside one cap under that cap", () => {
		expect(
			refusal("taskset -c 0-3 bash -c 'taskset -c 0 yes & taskset -c 1 yes &'"),
		).toBeNull();
	});
});

describe("where it looks", () => {
	it("follows a shell's flags to its string or script", () => {
		expect(refusal("bash -x -c 'yes &'")).toContain(G);
		expect(refusal("bash -o pipefail -c 'yes &'")).toContain(G);
		expect(refusal("bash -O extglob -c 'yes &'")).toContain(G);
		expect(refusal("bash +O extglob -c 'yes &'")).toContain(G);
		expect(refusal("bash +o posix -c 'yes &'")).toContain(G);
		expect(refusal("bash --init-file x.sh -c 'yes &'")).toContain(G);
		expect(refusal("bash --norc -c 'yes &'")).toContain(G);
		expect(refusal("bash --noprofile loaded.sh")).toContain(G);
		expect(refusal("bash -e loaded.sh")).toContain(G);
		expect(refusal("bash +x loaded.sh")).toContain(G);
		expect(refusal("bash -- loaded.sh")).toContain(G);
		expect(refusal("bash -- -c 'yes &'")).toBeNull();
		expect(refusal("sh -c 'stress --cpu 2'")).toContain(G);
		expect(refusal("dash -c 'yes &'")).toContain(G);
		expect(refusal("zsh -c 'yes &'")).toContain(G);
		expect(refusal("ksh loaded.sh")).toContain(G);
		expect(refusal("ksh -c 'yes &'")).toContain(G);
		expect(refusal("bash -nc 'yes &'")).toBeNull();
		expect(refusal("bash")).toBeNull();
		expect(refusal("bash -c")).toBeNull();
		expect(refusal("bash -o")).toBeNull();
	});

	it("follows bg-run.sh's `run` to the command it starts, and nothing else", () => {
		expect(refusal("bash scripts/bg-run.sh run x stress")).toContain(G);
		expect(refusal("bash bg-run.sh run x bash busy.sh")).toContain(G);
		expect(refusal("bash scripts/bg-run.sh status x")).toBeNull();
		expect(refusal("bash scripts/bg-run.sh run x")).toBeNull();
		expect(refusal("bash scripts/bg-run.sh")).toBeNull();
	});

	it("reads `source`, `.`, `eval` and a `.sh` command", () => {
		expect(refusal(". busy.sh")).toContain(G);
		expect(refusal("source")).toBeNull();
		expect(refusal("eval yes")).toContain(G);
		expect(refusal("eval echo yes")).toBeNull();
		expect(refusal("eval yes \\>/dev/null")).toBe(
			refused8("yes >/dev/null (in eval yes \\>/dev/null)"),
		);
		expect(refusal('eval "$CMD"')).toBeNull();
		expect(refusal("./busy.sh")).toContain(G);
		expect(refusal("./capped.sh & ./capped.sh")).toContain("two caps add up");
	});

	it("follows a string or script two shells past the command, and no further", () => {
		expect(refusal("bash -c stress")).toContain(G);
		expect(refusal("bash -c 'bash -c \"stress\"'")).toContain(G);
		expect(refusal("bash -c 'bash -c \"bash -c stress\"'")).toBeNull();
		expect(refusal("bash outer.sh")).toContain(G);
		expect(refusal("bash outer2.sh")).toBeNull();
	});

	it("resolves a script against the payload's cwd, else the hook's own", () => {
		expect(refusal("bash busy.sh", { cwd: "/elsewhere" })).toBeNull();
		const h = harness({ cwd: undefined, fallbackCwd: "/fb" });
		h.judge("bash busy.sh");
		expect(h.reads).toEqual([{ p: "/fb/busy.sh", maxBytes: 262_144 }]);
		const rel = harness({ cwd: "proj", fallbackCwd: "/fb" });
		rel.judge("bash ./busy.sh");
		expect(rel.reads[0]?.p).toBe("/fb/./busy.sh");
		const abs = harness();
		abs.judge("bash /abs/x.sh");
		expect(abs.reads[0]?.p).toBe("/abs/x.sh");
	});

	it("reads a script past 256 KiB no further", () => {
		const big = `yes >/dev/null &\n${"#".repeat(262_144 - 17)}`;
		expect(refusal("bash big.sh", { scripts: { "big.sh": big } })).toContain(G);
		expect(
			refusal("bash big.sh", { scripts: { "big.sh": `${big}#` } }),
		).toBeNull();
	});

	it("reads no script spelled through a variable", () => {
		const h = harness();
		expect(h.judge("bash $X.sh")).toBeNull();
		expect(h.judge('bash "$X"')).toBeNull();
		expect(h.reads).toEqual([]);
		expect(refusal('bash "loaded.sh"')).toContain(G);
	});

	it("reads a script's text as `$(<file)` does, NULs dropped", () => {
		expect(refusal("bash nul.sh")).toContain(G);
	});

	it("takes a quoted word's trailing newlines off, as `$(…)` did", () => {
		expect(refusal("stress '--version\n'")).toBeNull();
		expect(refusal("bash 'loaded.sh\n'")).toContain("(in loaded.sh)");
	});
});

describe("what it fails open on", () => {
	it.each(["", "0", "08", "x", "8 ", "-2"])(
		"allows every command on a core count of %j, and records it",
		(cores) => {
			const h = harness({ cores });
			expect(h.judge("yes >/dev/null &")).toBeNull();
			expect(h.logs).toEqual([
				"the core count did not resolve — every command allowed unchecked",
			]);
		},
	);

	it("records nothing on a command it judges", () => {
		const h = harness();
		expect(h.judge("yes >/dev/null &")).not.toBeNull();
		expect(h.judge("yes | head")).toBeNull();
		expect(h.logs).toEqual([]);
	});
});

describe("the edges each rule turns on", () => {
	it("splits on `&&`, `||` and `|&` as the separators they are", () => {
		expect(refusal("while true; do :; done && echo")).toBeNull();
		expect(refusal("yes || echo")).toContain(G);
		expect(refusal("yes\t> /dev/null")).toContain(G);
	});

	it("reads systemd-run's flags to the command they run", () => {
		expect(refusal("systemd-run -p CPUQuota=900% -- yes &")).toContain(G);
		expect(refusal("systemd-run --property CPUQuota=900% yes &")).toContain(G);
		expect(refusal("systemd-run --property CPUQuota=100% yes &")).toBeNull();
		expect(refusal("systemd-run -u name yes &")).toContain(G);
		expect(refusal("systemd-run -p CPUQuota=100% --user yes &")).toBeNull();
		expect(refusal('systemd-run --user "yes" >/dev/null &')).toContain(G);
	});

	it("counts a cpu list's parts as bash does", () => {
		expect(refusal("taskset -c 0-0,1-1,2-2,3-3,4-4 yes &")).toContain(G);
		expect(refusal("taskset -c 0-3,4-4:18446744073709551616 yes &")).toBeNull();
		expect(
			refusal("taskset -c 9223372036854775808-9223372036854775807 yes &"),
		).toBeNull();
		/* The range's width wraps before the stride divides it: -1 / 3 + 1. */
		expect(
			refusal("taskset -c 9223372036854775808-9223372036854775807:3 yes &"),
		).toBeNull();
		expect(refusal("taskset -c 0,1,2,3,4, yes &")).toContain(G);
		expect(refusal("taskset --cpu-list 0-4 yes &")).toContain(G);
		expect(refusal('taskset 0xff "yes" &')).toContain(G);
		for (const spec of ["-c 08-9", "-c 0-08", "0xffffffffffffffff"]) {
			const h = harness();
			expect(h.judge(`taskset ${spec} yes &`)).toBeNull();
			expect(h.logs).toHaveLength(1);
		}
		expect(refusal("taskset zz yes & taskset zz yes &")).toContain(
			"two caps add up",
		);
	});

	it("counts each shell, eval and script one level deeper", () => {
		expect(refusal("source outer2.sh")).toBeNull();
		expect(refusal('source "loaded.sh"')).toContain(G);
		expect(refusal('. "busy.sh"')).toContain(G);
		expect(refusal("eval eval stress")).toContain(G);
		expect(refusal("eval eval eval stress")).toBeNull();
		expect(refusal("./outer.sh")).toContain(G);
		expect(refusal("./outer2.sh")).toBeNull();
		expect(refusal("bash --restricted outer.sh")).toContain(G);
		expect(refusal("bash -c -x 'yes &'")).toContain(G);
		expect(refusal("bash scripts/bg-run.sh status x stress")).toBeNull();
	});

	it("skips every reserved word, a brace's close included", () => {
		expect(
			refusal("if false; then :; elif yes >/dev/null; then :; fi"),
		).toContain(G);
		expect(refusal("if yes >/dev/null; then :; fi")).toContain(G);
		expect(refusal("time yes &")).toBe(refused8("yes &"));
		expect(refusal("while true; do time :; done &")).toContain(G);
		expect(refusal("{ :; } yes >/dev/null")).toContain(G);
		expect(refusal("while true; do { :; }; done &")).toContain(G);
	});

	it("reads a `;;` as a pattern's start only inside a case, after a `;`", () => {
		expect(refusal("esac;; yes &")).toContain(G);
		expect(refusal("echo;; yes &")).toContain(G);
		expect(refusal("case $x in a) echo; echo; yes & ;; esac")).toContain(G);
		expect(refusal("case $x in a) echo ;& yes & ;; esac")).toContain(G);
		expect(refusal("case $x in a) echo & ; yes & ;; esac")).toContain(G);
		/* Each line's separator is the next line's `prev`: an `esac`'s, a
		 * pattern's `)`. */
		expect(refusal("case a in a) :;; esac; echo ;; yes &")).toContain(G);
		expect(
			refusal("case a in a) case b in b) :;; esac\n; (yes &);; esac"),
		).toContain(G);
		expect(refusal("case a in a) :;; b) ; (yes &);; esac")).toContain(G);
	});

	it("rewrites `$((…))` to the 0 it shows, before any other arithmetic", () => {
		expect(refusal("yes $((2+2)) >/dev/null &")).toBe(
			refused8("yes 0 >/dev/null &"),
		);
	});

	it("frames a `select` loop, so a cap started in it adds up", () => {
		expect(refusal("select x in a; do taskset -c 0 yes & done")).toContain(
			"two caps add up",
		);
	});

	it("settles on the first G or M, never on a later line", () => {
		expect(
			refusal("bash -c 'taskset -c 0 yes & taskset -c 1 yes &'; stress"),
		).toContain("two caps add up");
		expect(refusal("yes >/dev/null; taskset -c 0 yes")).toBe(
			refused8("yes >/dev/null"),
		);
		expect(refusal("yes | cat; echo")).toContain(G);
	});
});

describe("the quoted command", () => {
	it("is shown as typed, a path and a placeholder-like token included", () => {
		expect(refusal("yes scripts/x @CMD@ &")).toBe(
			refused8("yes scripts/x @CMD@ &"),
		);
	});
});

describe("the script reader port (contract: fake against production)", () => {
	it("answers alike for a script, a missing one, a directory and one over the limit", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-load-"));
		try {
			fs.writeFileSync(path.join(dir, "a.sh"), "yes &\n");
			fs.mkdirSync(path.join(dir, "d.sh"));
			const real = buildHostPorts().readScript;
			const fake = fakeReader({ "a.sh": "yes &\n" }, dir);
			for (const [p, max] of [
				[path.join(dir, "a.sh"), 6],
				[path.join(dir, "a.sh"), 5],
				[path.join(dir, "missing.sh"), 100],
				[path.join(dir, "d.sh"), 100],
			] as const)
				expect(real(p, max)).toBe(fake(p, max));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
