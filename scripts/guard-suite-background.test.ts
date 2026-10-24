// @vitest-environment node
/*
 * guard-suite-background.sh denies a suite DETACHED INSIDE THE SHELL, where the
 * tool call registers no job for the run and nothing will ever wake the session
 * (mantahostels#2485).
 *
 * The deny's own TEXT carries its escape. And the escape is read from the
 * COMMAND STRING, a hook running before the command, so one read from the
 * hook's environment is unreachable from a Bash tool call (mantahostels#2486).
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`) and denies: loosen a case and a suite detached in the
 * shell runs unwatched while its session waits for a wake that never comes;
 * widen it and a properly backgrounded suite is refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";

const GUARD = path.resolve(__dirname, "guard-suite-background.sh");

let dir: string;

/*
 * CLAUDE_CONFIG_DIR is redirected at `dir` because every guard records its
 * fail-opens there since mantahostels#147, and inheriting the real one appends to the
 * developer's live guard-errors.log on every suite run (mantahostels#1452).
 */
const run = (command: string, background?: boolean, guard = GUARD) =>
	spawnSync(guard, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input:
				background === undefined
					? { command }
					: { command, run_in_background: background },
		}),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		},
	});

const FIX_OPENER =
	"Run instead, in the foreground with the Bash tool's `timeout: 600000`: ";

/*
 * Every deny's first line is the command to re-issue (#519): the opener, then
 * a command still carrying the suite and no detachment of any spelling.
 */
const expectFixFirst = (command: string, reason: string) => {
	const first = reason.split("\n")[0];
	expect(first.startsWith(FIX_OPENER), `first line for: ${command}`).toBe(true);
	const fix = first.slice(FIX_OPENER.length);
	expect(fix, `fix for: ${command}`).toMatch(
		/npm|run-vitest\.js|pytest|node --test/,
	);
	/* The command's own words, in order: only a detaching `&` became `;`. */
	const words = command.split(/\s+/);
	let at = 0;
	for (const word of fix.split(/\s+/).filter((w) => w && w !== ";")) {
		at = words.indexOf(word, at) + 1;
		expect(at, `${word} in ${command}`).toBeGreaterThan(0);
	}
	expect(fix, `fix for: ${command}`).not.toMatch(
		/(^|[\s;|&(/])(nohup|setsid|disown)(\s|$)/,
	);
	expect(
		fix.replace(/&&|&>|\|&|>&|<&/g, ""),
		`fix for: ${command}`,
	).not.toContain("&");
};

const verdict = (command: string, background?: boolean) => {
	const r = run(command, background);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status, `exit status for: ${command}`).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) {
		expectFixFirst(
			command,
			JSON.parse(out).hookSpecificOutput.permissionDecisionReason,
		);
		return "deny";
	}
	expect(out).toBe("");
	return "allow";
};

const denyReason = (command: string) => {
	const out = run(command).stdout ?? "";
	const reason = JSON.parse(out).hookSpecificOutput?.permissionDecisionReason as
		| string
		| undefined;
	if (!reason) throw new Error(`no deny reason for: ${command}`);
	return reason;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-suite-bg-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("guard-suite-background.sh", () => {
	it("denies a suite detached by any of the four spellings", () => {
		for (const command of [
			"npm run test &",
			"nohup npm run test",
			"setsid npm run test",
			"npm run test & disown",
			"nohup scripts/bg-run.sh run suite2 npm run test >/dev/null 2>&1 &",
			"npm run test:changed &",
			"node scripts/run-vitest.js --queue &",
		])
			expect(verdict(command), command).toBe("deny");
	});

	/*
	 * The wrapper shell exits at once, so the registered job describes the
	 * wrapper and reports exit 0 in seconds while the suite runs on unattached.
	 */
	it("denies a detached suite even when run_in_background is set", () => {
		expect(verdict("npm run test &", true)).toBe("deny");
		expect(verdict("nohup npm run test", true)).toBe("deny");
	});

	/*
	 * A foreground call that overruns its timeout is backgrounded by the
	 * harness and does notify.
	 */
	it("allows a plain foreground suite", () => {
		for (const command of [
			"npm test",
			"npm run test",
			"npm run test:changed",
			"npm run test -- --queue",
			"node scripts/run-vitest.js",
		])
			expect(verdict(command), command).toBe("allow");
	});

	it("allows an undetached suite that is a registered background job", () => {
		expect(verdict("npm run test", true)).toBe("allow");
		expect(verdict("scripts/bg-run.sh run s1 npm run test", true)).toBe(
			"allow",
		);
	});

	it("sees through a detacher's path, an env prefix and bg-run.sh", () => {
		for (const command of [
			"/usr/bin/nohup npm run test",
			"nohup env npm run test",
			"nohup env NODE_OPTIONS=--max-old-space-size=2048 npm run test",
			"nohup scripts/bg-run.sh run s2 npm run test",
		])
			expect(verdict(command), command).toBe("deny");
	});

	it("strips every wrapper before looking for the command word", () => {
		for (const command of [
			"env -u FOO npm run test &",
			"env -C /tmp npm run test &",
			"env --unset FOO npm run test &",
			"env -uFOO npm run test &",
			"env --unset=FOO npm run test &",
			"timeout 900 npm run test &",
			"timeout -k 30 900 npm run test &",
			"timeout --signal TERM 900 npm run test &",
			"time npm run test &",
			"command npm run test &",
			"stdbuf -oL npm run test &",
			"nohup timeout 900 env -u FOO npm run test",
			"sudo npm run test &",
			"sudo -u root npm run test &",
			"nice npm run test &",
			"nice -n 5 npm run test &",
			/* Reading `nice`'s obsolete adjustment spelling as a value-taker
			 * would eat `npm` (mantahostels#2524, mantahostels#2552). */
			"nice -5 npm run test &",
			"ionice -c2 npm run test &",
			"ionice -c 2 -n 0 npm run test &",
			"xargs npm run test &",
			"xargs -n 1 npm run test &",
			"xargs -I {} npm run test &",
			"nice ionice -c 2 npm run test &",
			"stdbuf -o L npm run test &",
			"stdbuf -i 0 -e L npm run test &",
			"env -S 'npm run test' &",
			"env --split-string 'npm run test' &",
			"env --split-string='npm run test' &",
			/* An OPTIONAL-value flag must NOT be swept as a value-taker: swept,
			 * it eats `npm` and the launch goes unjudged. */
			"xargs --eof npm run test &",
			"xargs --replace npm run test &",
			"sudo -h npm run test &",
			"sudo -D /tmp npm run test &",
			"sudo --user root npm run test &",
			"sudo --close-from 3 npm run test &",
		])
			expect(verdict(command), command).toBe("deny");
	});

	it("honours the escape carried through a wrapper", () => {
		for (const command of [
			"env WFC_SUITE_DETACH=1 npm run test &",
			"nohup env WFC_SUITE_DETACH=1 npm run test",
			"env WFC_SUITE_DETACH=1 -u FOO npm run test &",
			/* The timeout limb has its own escape (#1186). */
			"WFC_SUITE_DETACH=1 WFC_SUITE_TIMEOUT=1 timeout 900 npm run test &",
			"WFC_SUITE_DETACH=1 stdbuf -oL npm run test &",
			"WFC_SUITE_DETACH=1 time npm run test &",
			"WFC_SUITE_DETACH=1 command npm run test &",
			"WFC_SUITE_DETACH=1 setsid npm run test",
			"WFC_SUITE_DETACH=1 scripts/bg-run.sh run s3 npm run test &",
			"env WFC_SUITE_DETACH=1 scripts/bg-run.sh run s4 npm run test &",
			"WFC_SUITE_DETACH=1 sudo npm run test &",
			"WFC_SUITE_DETACH=1 nice -n 5 npm run test &",
			"WFC_SUITE_DETACH=1 ionice -c 2 npm run test &",
			"WFC_SUITE_DETACH=1 xargs -n 1 npm run test &",
			"WFC_SUITE_DETACH=1 stdbuf -o L npm run test &",
			"WFC_SUITE_DETACH=1 stdbuf -i 0 -e L npm run test &",
			"env WFC_SUITE_DETACH=1 stdbuf -o L npm run test &",
			"WFC_SUITE_DETACH=1 env -S 'npm run test' &",
			"WFC_SUITE_DETACH=1 env --split-string 'npm run test' &",
			"WFC_SUITE_DETACH=1 env --split-string='npm run test' &",
		])
			expect(verdict(command), command).toBe("allow");
	});

	/*
	 * The empty-valued row is the discriminating half: the escape needs a
	 * non-empty value, so a working split reaches the suite and denies, where a
	 * broken one leaves a word the recogniser does not know and allows for the
	 * wrong reason.
	 */
	it("reads the detach escape from inside the split string", () => {
		expect(verdict("env -S 'WFC_SUITE_DETACH=1 npm run test' &")).toBe("allow");
		expect(verdict("env -S 'WFC_SUITE_DETACH= npm run test' &")).toBe("deny");
	});

	it("reads an assignment as an escape only after env", () => {
		/*
		 * The first two are the discriminating case. An assignment after a
		 * non-`env` wrapper must STOP the strip, so the words left to judge
		 * begin with the assignment and no suite is seen at all — drop that
		 * limb and the strip runs on to `npm run test`, a suite carrying no
		 * escape, and both deny.
		 */
		expect(verdict("nohup FOO=1 npm run test")).toBe("allow");
		expect(verdict("timeout 900 FOO=1 npm run test &")).toBe("allow");
		expect(verdict("nohup WFC_SUITE_DETACH=1 npm run test")).toBe("allow");
		expect(verdict("npm run test -- WFC_SUITE_DETACH=1 &")).toBe("deny");
	});

	it("allows a wrapper with no command left after it", () => {
		for (const command of ["nohup env -u &", "nohup timeout &", "nohup env &"])
			expect(verdict(command), command).toBe("allow");
	});

	it("covers test:py, the one deviation from the sibling recogniser", () => {
		expect(verdict("npm run test:py &")).toBe("deny");
		expect(verdict("nohup npm test:py")).toBe("deny");
		expect(verdict("npm run test:py")).toBe("allow");
	});

	/* #1528: lib/suite-launch.sh's other runners and quoted script names. */
	it("denies a detached pytest, node --test and a quoted npm script", () => {
		for (const command of [
			"pytest &",
			"node --test &",
			"nohup python3 -m pytest",
			`npm run "test" &`,
		])
			expect(verdict(command), command).toBe("deny");
		expect(verdict("pytest")).toBe("allow");
	});

	it("does not read a redirection or a pipe as a detachment", () => {
		for (const command of [
			"npm run test 2>&1",
			"npm run test >out.txt 2>&1",
			"npm run test >&2",
			"npm run test &>log",
			"npm run test 2>&1 |& cat",
			"npm run lint && npm run test",
		])
			expect(verdict(command), command).toBe("allow");
	});

	it("matches the three commands as words, not substrings", () => {
		expect(verdict("npm run test -- scripts/nohup-helper.test.ts")).toBe(
			"allow",
		);
		expect(verdict("npm run test -- --grep nohup.json")).toBe("allow");
	});

	it("opens with the command less its detachment, and nothing else changed", () => {
		for (const [command, fix] of [
			["npm run test &", "npm run test"],
			["nohup npm run test", "npm run test"],
			["/usr/bin/nohup npm run test", "npm run test"],
			["setsid -f npm run test:py", "npm run test:py"],
			["npm run test & disown", "npm run test"],
			["npm run test & disown -h %1; echo done", "npm run test ; echo done"],
			["sleep 1 & npm run test", "sleep 1 ; npm run test"],
			[
				"nohup scripts/bg-run.sh run s1 npm run test >/dev/null 2>&1 &",
				"scripts/bg-run.sh run s1 npm run test >/dev/null 2>&1",
			],
			["npm run test 2>&1 | tee log &", "npm run test 2>&1 | tee log"],
			["env -S 'npm run test' &", "env -S 'npm run test'"],
			[
				"npm run test -- scripts/nohup-helper.test.ts &",
				"npm run test -- scripts/nohup-helper.test.ts",
			],
		])
			expect(denyReason(command).split("\n")[0], command).toBe(
				`${FIX_OPENER}${fix}`,
			);
	});

	/*
	 * A heredoc's body is data (#2384): read as a detachment it refused a
	 * foreground run, and rewritten it re-issued a script that wrote
	 * `[;;|]` for `[;&|]`. The timeout limb's re-spelling reached a body too.
	 */
	it("reads no detachment in a heredoc, and re-issues its body unchanged", () => {
		const write = [
			"cat > /tmp/x.sh <<'EOF'",
			'[[ "$c" == [;&|] ]] && nohup sleep 1 &',
			"EOF",
		].join("\n");
		const unquoted = write.replace("'EOF'", "EOF");
		const piped = ["npm run test <<EOF", "a & b", "EOF"].join("\n");
		const pipedAway = piped.replace("<<EOF", "<<EOF &");
		const timedBody = write.replace(
			'[[ "$c" == [;&|] ]] && nohup sleep 1 &',
			"timeout 600 npm run test &",
		);
		for (const command of [
			`${write}\nnpm run test`,
			`${unquoted}\nnpm run test`,
			piped,
		])
			expect(verdict(command), command).toBe("allow");
		for (const [command, fix] of [
			[`${write}\nnpm run test &`, `${write}\nnpm run test`],
			[`${write}\nsleep 1 & npm run test`, `${write}\nsleep 1 ; npm run test`],
			[pipedAway, piped],
			[`${timedBody}\ntimeout 600 npm run test`, `${timedBody}\nnpm run test`],
		]) {
			const reason = denyReason(command);
			expect(reason.split("\nThis suite is ")[0], command).toBe(
				`${FIX_OPENER}${fix}`,
			);
		}
	});

	/*
	 * The deny must assert no wake: backgrounding buys a notification that may
	 * never be delivered.
	 */
	it("keeps the escape, the no-tool-call ending and the check before a relaunch", () => {
		const reason = denyReason("nohup npm run test");
		expect(reason).toContain("WFC_SUITE_DETACH=1");
		expect(reason).toContain("NO tool call");
		expect(reason).toContain("scripts/bg-run.sh check");
		expect(reason).toContain("before relaunching");
		expect(reason).toContain("`--full=<cause>` or `--queue` run");
		expect(reason).toContain("scripts/bg-run.sh run <name>` in the same call");
		expect(reason).not.toMatch(/will (wake|notify)/);
		for (const figure of ["67.8%", "70%", "192 of 427", "123 of 1,286"])
			expect(reason, figure).not.toContain(figure);
	});

	it("keeps the measurements in its header", () => {
		const header = fs.readFileSync(GUARD, "utf8").split("\nset -uo")[0];
		for (const figure of [
			"#482",
			"67.8%",
			"70%",
			"192 of 427",
			"123 of 1,286",
			"238 of 5,589",
		])
			expect(header, figure).toContain(figure);
	});

	it("reads the escape from the command string, not the hook's environment", () => {
		expect(verdict("WFC_SUITE_DETACH=1 nohup npm run test")).toBe("allow");
		// `?*` requires a value, so a bare `=` is not set and does not escape.
		expect(verdict("WFC_SUITE_DETACH= nohup npm run test")).toBe("deny");
	});

	it("ignores a detached command that is not a suite", () => {
		for (const command of [
			"nohup npm run lint",
			"node scripts/check-doc-map.js &",
			"npm run build &",
		])
			expect(verdict(command), command).toBe("allow");
	});

	/* #1186, ruled at #1181: the wrapper kills the run with no result. */
	it("denies an unbounded suite wrapped in a shell timeout", () => {
		for (const command of [
			"timeout 590 npm run test",
			"timeout 590 npm test",
			"timeout 590 npm run test:changed",
			"timeout 590s npm run test -- --full=pre-push",
			"timeout 590 npm run test -- --queue",
			"timeout 590 npm run test:changed -- --queue",
			"timeout 590 node scripts/run-vitest.js",
			"timeout 590 node scripts/run-vitest.js --full=pre-push --queue",
			"timeout -k 30 590 npm run test",
			"timeout --signal TERM --kill-after=5 590 npm run test",
			"/usr/bin/timeout 590 npm run test",
			"env timeout 590 npm run test",
			"timeout 590 scripts/bg-run.sh run s1 npm run test -- --full=pre-push",
			"cd /tmp && timeout 590 npm run test 2>&1 | tail -5",
			"npm run lint; timeout 590 npm run test:changed",
		])
			expect(verdict(command), command).toBe("deny");
	});

	/* #1196: a flag's value is no test file, so the run takes every file. */
	it("denies a timed run whose only bare word is a flag's value", () => {
		for (const command of [
			"timeout 590 node scripts/run-vitest.js -t foo",
			"timeout 590 node scripts/run-vitest.js --testNamePattern foo",
			"timeout 590 npm run test -- -t foo",
			"timeout 590 npm run test:changed -- --testNamePattern foo",
		])
			expect(verdict(command), command).toBe("deny");
	});

	it("denies a timed `--changed` run whose only test file is its ref (#2454)", () => {
		for (const command of [
			"timeout 590 npm run test:changed -- scripts/a.test.ts",
			"timeout 590 node scripts/run-vitest.js --changed scripts/a.test.ts",
		])
			expect(verdict(command), command).toBe("deny");
	});

	/* #1213: an adoption run selects every reader of its paths. */
	it("denies a timed adoption run even where it names a test file", () => {
		for (const command of [
			"timeout 590 npm run test -- --adopt scripts/a.test.ts",
			"timeout 590 node scripts/run-vitest.js --adopt docs/x.md scripts/a.test.ts",
		])
			expect(verdict(command), command).toBe("deny");
	});

	it("keeps SUITE_TEST_FILE_RE equal to test-kind.js's JS_TEST_FILE", () => {
		const lib = fs.readFileSync(
			path.resolve(__dirname, "lib/suite-bounded.sh"),
			"utf8",
		);
		const { JS_TEST_FILE } = createRequire(import.meta.url)(
			"./lib/test-kind.js",
		);
		const shell = lib.match(/^SUITE_TEST_FILE_RE='([^']*)'$/m)?.[1];
		// Bash's ERE has no non-capturing group.
		expect(shell).toBe(JS_TEST_FILE.source.replaceAll("(?:", "("));
	});

	it("denies a timed suite whatever run_in_background says", () => {
		expect(verdict("timeout 590 npm run test", true)).toBe("deny");
		expect(verdict("timeout 590 npm run test", false)).toBe("deny");
	});

	it("allows a timed run naming its own files, and every untimed launch", () => {
		for (const command of [
			"timeout 590 node scripts/run-vitest.js scripts/a.test.ts",
			"timeout 590 node scripts/run-vitest.js --queue scripts/a.test.ts",
			"timeout 590 node scripts/run-vitest.js -t foo scripts/a.test.ts",
			'timeout 590 node scripts/run-vitest.js "scripts/a.test.ts"',
			"timeout 590 node scripts/run-vitest.js 'scripts/a.test.ts'",
			"timeout 590 npm run test -- scripts/a.test.ts",
			"timeout 590 npm test -- scripts/a.test.ts",
			/* A named file outranks --full: run-vitest.js runs no whole suite. */
			"timeout 590 npm run test -- --full=pre-push scripts/a.test.ts",
			"npm run test",
			"npm run test -- --full=pre-push",
			"node scripts/run-vitest.js --queue",
			"scripts/bg-run.sh run s1 npm run test -- --full=pre-push --queue",
			/* Not the wrapper: an argument after the command word, or a
			 * timeout around another segment. */
			"npm run test -- --grep timeout 5",
			"timeout 5 curl -s example.com && npm run test",
			/* Out of the limb: a watcher and the Python suite. */
			"timeout 590 npm run test:watch",
			"timeout 590 npm run test:py",
		])
			expect(verdict(command), command).toBe("allow");
	});

	it("honours WFC_SUITE_TIMEOUT per segment, and only a non-empty one", () => {
		expect(verdict("WFC_SUITE_TIMEOUT=1 timeout 590 npm run test")).toBe(
			"allow",
		);
		expect(verdict("timeout 590 env WFC_SUITE_TIMEOUT=1 npm run test")).toBe(
			"allow",
		);
		expect(verdict("WFC_SUITE_TIMEOUT= timeout 590 npm run test")).toBe("deny");
		expect(
			verdict("timeout 590 npm run test -- --grep=WFC_SUITE_TIMEOUT=1"),
		).toBe("deny");
		/* Per segment: the escaped first segment does not cover the second. */
		expect(
			verdict(
				"WFC_SUITE_TIMEOUT=1 timeout 5 npm run test; timeout 5 npm run test:changed",
			),
		).toBe("deny");
		/* Each limb has its own escape, so the detachment escaped stays. */
		expect(
			denyReason("WFC_SUITE_DETACH=1 timeout 590 npm run test &").split(
				"\n",
			)[0],
		).toBe(`${FIX_OPENER}WFC_SUITE_DETACH=1 npm run test &`);
	});

	it("opens with the command less its timeout, and adds no --queue", () => {
		for (const [command, fix] of [
			["timeout 590 npm run test", "npm run test"],
			[
				"timeout -k 30 -s KILL 590 npm run test:changed",
				"npm run test:changed",
			],
			[
				"timeout --kill-after=5 590 node scripts/run-vitest.js --full=pre-push",
				"node scripts/run-vitest.js --full=pre-push",
			],
			["env timeout 590 npm test", "env npm test"],
			[
				"cd '/tmp/a b' && timeout 590 npm run test -- --queue 2>&1 | tail -5",
				"cd '/tmp/a b' && npm run test -- --queue 2>&1 | tail -5",
			],
			[
				"timeout 5 npm run test; timeout 5 npm run test",
				"npm run test; npm run test",
			],
			["timeout 590 npm run test &", "npm run test"],
			/* A timeout outside an env -S string is still stripped. */
			["timeout 590 env -S 'npm run test'", "env -S 'npm run test'"],
		])
			expect(denyReason(command).split("\n")[0], command).toBe(
				`${FIX_OPENER}${fix}`,
			);
	});

	it("says why the shell timeout is refused and names its escape", () => {
		const reason = denyReason("timeout 590 npm run test");
		expect(reason).toContain("This suite is WRAPPED IN A SHELL `timeout`");
		expect(reason).toContain("no pass/fail marker");
		expect(reason).toContain("`--queue` too");
		expect(reason).toContain("WFC_SUITE_TIMEOUT=1");
		expect(reason).not.toContain("DETACHED INSIDE THE SHELL");
		const both = denyReason("timeout 590 npm run test &");
		expect(both).toContain("DETACHED INSIDE THE SHELL");
		expect(both).toContain("WRAPPED IN A SHELL");
	});

	it("records the timeout limb in its header and the guard registry", () => {
		const header = fs.readFileSync(GUARD, "utf8").split("\nset -uo")[0];
		for (const needle of [
			"#1186",
			"#1181",
			"lib/suite-bounded.sh",
			"WFC_SUITE_TIMEOUT",
		])
			expect(header, needle).toContain(needle);
		const env = fs.readFileSync(
			path.resolve(__dirname, "../docs/environment.md"),
			"utf8",
		);
		const region = env
			.split("<!-- guard-registry:begin -->")
			.slice(1)
			.map((r) => r.split("<!-- guard-registry:end -->")[0])
			.join("\n");
		const entry = region
			.split("\n")
			.find((l) => l.includes("wrapped in a shell `timeout N`"));
		expect(entry).toBeDefined();
		for (const needle of [
			"**Enforced** (#1186",
			"`scripts/guard-suite-background.sh`",
			"`WFC_SUITE_TIMEOUT=<non-empty>`",
		])
			expect(entry, needle).toContain(needle);
	});

	it("reads every wrapper run as bounded when lib/suite-bounded.sh is missing", () => {
		const scripts = path.join(dir, "scripts");
		copyLibs(path.join(scripts, "lib"), sourcedLibs(GUARD), [
			"suite-bounded.sh",
		]);
		fs.copyFileSync(GUARD, path.join(scripts, "guard-suite-background.sh"));
		const guard = path.join(scripts, "guard-suite-background.sh");
		const r = run("timeout 590 node scripts/run-vitest.js", undefined, guard);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").not.toContain('"deny"');
		/* The detachment limb does not lean on the lib. */
		expect(
			run("timeout 590 npm run test", undefined, guard).stdout ?? "",
		).not.toContain('"deny"');
		expect(run("npm run test &", undefined, guard).stdout ?? "").toContain(
			'"deny"',
		);
	});

	it("fails open on a payload it cannot read", () => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: "not json at all",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			},
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").not.toContain('"deny"');
	});
});
