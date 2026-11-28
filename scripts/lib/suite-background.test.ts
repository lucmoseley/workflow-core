// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	runCore,
	splitCheckout,
	toolCall,
	writeHostConfig,
} from "./guard-core-testkit";

let dir: string;

const run = (command: string, background?: boolean) =>
	runCore(
		"guard-suite-background",
		{
			session_id: "test",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input:
				background === undefined
					? { command }
					: { command, run_in_background: background },
		},
		{ root: dir },
	).output;

const FIX_OPENER =
	/^Run instead, in the foreground with the Bash tool's `timeout: (30000|600000)`: /;

const SNAPSHOT_OPENER =
	"Run instead, in the foreground with the Bash tool's `timeout: 30000`: ";
const HELD_OPENER =
	"Run instead, in the foreground with the Bash tool's `timeout: 600000`: ";

const expectFixFirst = (command: string, reason: string) => {
	const first = reason.split("\n")[0];
	const opener = FIX_OPENER.exec(first);
	expect(opener, `first line for: ${command}`).not.toBe(null);
	const fix = first.slice(opener?.[0].length);
	expect(fix, `fix for: ${command}`).toMatch(
		/npm|run-vitest\.js|pytest|node --test/,
	);
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
	const out = run(command, background);
	if (out?.permissionDecision === "deny") {
		expectFixFirst(command, out.permissionDecisionReason ?? "");
		return "deny";
	}
	expect(out).toBeNull();
	return "allow";
};

const readDenyReason = (command: string) => {
	const reason = run(command)?.permissionDecisionReason;
	if (!reason) throw new Error(`no deny reason for: ${command}`);
	return reason;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-background-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("lib/suite-background.js", () => {
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

	it("denies a detached suite even when run_in_background is set", () => {
		expect(verdict("npm run test &", true)).toBe("deny");
		expect(verdict("nohup npm run test", true)).toBe("deny");
	});

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

	it("reads the detach escape from inside the split string", () => {
		expect(verdict("env -S 'WFC_SUITE_DETACH=1 npm run test' &")).toBe("allow");
		expect(verdict("env -S 'WFC_SUITE_DETACH= npm run test' &")).toBe("deny");
	});

	it("reads an assignment as an escape only after env", () => {
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
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("reads no detachment inside a quoted string, and re-issues it as typed (#5822)", () => {
		for (const command of [
			"npm run test -- -t 'a & b'",
			"echo 'a & b'; npm run test",
			'echo "a & b"; npm run test',
			"sed -i 's/a \\&\\& b/a/' f.py; npm run test",
			"echo 'run nohup later'; npm run test",
		])
			expect(verdict(command), command).toBe("allow");
		expect(
			readDenyReason("git commit -m 'a & b' && npm run test &").split("\n")[0],
		).toBe(`${SNAPSHOT_OPENER}git commit -m 'a & b' && npm run test`);
	});

	it("reads a detachment in a substitution inside double quotes (#5822)", () => {
		for (const [command, fix] of [
			['echo "$(npm run test &)"', 'echo "$(npm run test)"'],
			['echo "x `npm run test &` y"', 'echo "x `npm run test` y"'],
			[
				'echo "x `npm run test \\"a\\" &` y"',
				'echo "x `npm run test \\"a\\"` y"',
			],
		])
			expect(readDenyReason(command).split("\n")[0], command).toBe(
				`${SNAPSHOT_OPENER}${fix}`,
			);
	});

	it("reads the script a wrapper runs as commands, quotes and all (#5822)", () => {
		for (const command of [
			`flock /l -c "echo 'a & b'; npm run test"`,
			'flock "/tmp/a & b.lock" -c "npm run test"',
			'flock /l -c "npm run test" "a & b"',
		])
			expect(verdict(command), command).toBe("allow");
		expect(
			readDenyReason('flock /l -c "cd scripts && nohup npm run test &"').split(
				"\n",
			)[0],
		).toBe(`${SNAPSHOT_OPENER}flock /l -c "cd scripts && npm run test"`);
	});

	it("rewrites only the words a wrapper took its script from (#5846)", () => {
		const fixOf = (command: string) =>
			(readDenyReason(command).split("\n")[0] ?? "").slice(
				SNAPSHOT_OPENER.length,
			);
		for (const [command, fix] of [
			[
				'flock "npm run test &" -c "npm run test &"',
				'flock "npm run test &" -c "npm run test"',
			],
			[
				"watch -n 5 \"npm run test\" 'x & y'",
				"watch -n 5 \"npm run test\" 'x ; y'",
			],
			["watch -n 5 npm run test '&' true", "watch -n 5 npm run test '' true"],
		]) {
			expect(fixOf(command), command).toBe(fix);
			expect(verdict(fix), fix).toBe("allow");
		}
	});

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
			const reason = readDenyReason(command);
			expect(reason.split("\nThis suite is ")[0], command).toBe(
				`${SNAPSHOT_OPENER}${fix}`,
			);
		}
	});

	it("keeps the escape, the no-tool-call ending and the check before a relaunch", () => {
		const reason = readDenyReason("nohup npm run test");
		expect(reason).toContain("WFC_SUITE_DETACH=1");
		expect(reason).toContain("NO tool call");
		expect(reason).toContain("scripts/bg-run.sh check");
		expect(reason).toContain("before relaunching");
		expect(reason).toContain("`--full=<cause>` or `--queue` run");
		expect(reason).toContain("scripts/bg-run.sh run <name>` in the same call");
		expect(reason).not.toMatch(/will (wake|notify)/);
	});

	it("reads the escape from the command string, not the hook's environment", () => {
		expect(verdict("WFC_SUITE_DETACH=1 nohup npm run test")).toBe("allow");
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

	it("denies a timed adoption run even where it names a test file", () => {
		for (const command of [
			"timeout 590 npm run test -- --adopt scripts/a.test.ts",
			"timeout 590 node scripts/run-vitest.js --adopt docs/x.md scripts/a.test.ts",
		])
			expect(verdict(command), command).toBe("deny");
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
			"timeout 590 npm run test -- --full=pre-push scripts/a.test.ts",
			"npm run test",
			"npm run test -- --full=pre-push",
			"node scripts/run-vitest.js --queue",
			"scripts/bg-run.sh run s1 npm run test -- --full=pre-push --queue",
			"npm run test -- --grep timeout 5",
			"timeout 5 curl -s example.com && npm run test",
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
		expect(
			verdict(
				"WFC_SUITE_TIMEOUT=1 timeout 5 npm run test; timeout 5 npm run test:changed",
			),
		).toBe("deny");
		expect(
			readDenyReason("WFC_SUITE_DETACH=1 timeout 590 npm run test &").split(
				"\n",
			)[0],
		).toBe(`${SNAPSHOT_OPENER}WFC_SUITE_DETACH=1 npm run test &`);
	});

	it("names `timeout: 30000` for a touched or named run, and `timeout: 600000` for a full, queued, shared, isolated or test:py run (#5717)", () => {
		for (const [command, opener] of [
			["npm run test &", SNAPSHOT_OPENER],
			["npm run test -- scripts/a.test.ts &", SNAPSHOT_OPENER],
			["node scripts/run-vitest.js &", SNAPSHOT_OPENER],
			["npm run test -- --full=coverage &", HELD_OPENER],
			["npm run test -- --queue &", HELD_OPENER],
			["npm run test:py &", HELD_OPENER],
			["npm run test -- --shared &", HELD_OPENER],
			["npm run test -- --isolated &", HELD_OPENER],
			["npm run test & npm run test:py", HELD_OPENER],
		])
			expect(
				readDenyReason(command).split("\n")[0].startsWith(opener),
				command,
			).toBe(true);
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
			["timeout 590 env -S 'npm run test'", "env -S 'npm run test'"],
		])
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("strips a timeout whole when a flag value is quoted, and reads a script launch's wrappers from the walk (#5867)", () => {
		for (const [command, fix] of [
			['timeout -s "KILL" 60 npm run test', "npm run test"],
			['"timeout" 60 npm run test', "npm run test"],
			["timeout --kill-after '5' -s KILL 60 npm run test", "npm run test"],
			[
				'timeout -s "KILL" 60 flock /l -c "npm run test &"',
				'flock /l -c "npm run test"',
			],
			[
				'timeout -s "KILL" 60 flock "npm run test &" -c "npm run test &"',
				'flock "npm run test &" -c "npm run test"',
			],
			[
				'timeout 590 flock /l -c "npm run test -- --full=pre-push --queue"',
				'flock /l -c "npm run test -- --full=pre-push --queue"',
			],
		])
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("strips a timeout from inside a wrapper's script string, keeping its quotes (#5874)", () => {
		for (const [command, fix] of [
			['flock /l -c "timeout 590 npm run test"', 'flock /l -c "npm run test"'],
			[
				'timeout 5 flock /l -c "timeout 590 npm run test"',
				'flock /l -c "npm run test"',
			],
			["watch 'timeout 590 npm run test'", "watch 'npm run test'"],
			[
				'timeout -s "KILL" 5 flock /l -c "timeout 590 npm run test &"',
				'flock /l -c "npm run test"',
			],
			[
				'flock /l -c "cd scripts && timeout 590 npm run test"',
				'flock /l -c "cd scripts && npm run test"',
			],
			[
				`flock /l -c "flock /m -c 'timeout 590 npm run test'"`,
				`flock /l -c "flock /m -c 'npm run test'"`,
			],
			[
				'timeout 5 flock /l -c "timeout 590 npm run test &"',
				'flock /l -c "npm run test"',
			],
			[
				'flock /l -c "timeout 590 npm run test -- -t $(date)"',
				'flock /l -c "npm run test -- -t $(date)"',
			],
		])
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("strips a timeout from a launch holding a backtick substitution, keeping the backticks (#5882)", () => {
		for (const [command, fix] of [
			["timeout 590 npm run test -- -t `date`", "npm run test -- -t `date`"],
			[
				"timeout 590 npm run test -- -t `date` --queue",
				"npm run test -- -t `date` --queue",
			],
			["timeout 590 npm run test -- -t a$", "npm run test -- -t a$"],
			[
				'flock /l -c "timeout 590 npm run test -- -t `date`"',
				'flock /l -c "npm run test -- -t `date`"',
			],
		])
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("re-issues a timed script as one single-quoted word where its own quotes cannot hold the rewrite (#5874)", () => {
		for (const [command, fix] of [
			[
				'flock /l -c "timeout 590 npm run test -- -t \\"a b\\""',
				`flock /l -c 'npm run test -- -t "a b"'`,
			],
			["watch timeout 590 npm run test", "watch 'npm run test'"],
			[
				`watch 'flock /m -c "timeout 590 npm run test -- -t \\"a\\""'`,
				`watch 'flock /m -c '\\''npm run test -- -t "a"'\\'''`,
			],
			['watch "timeout 590 npm run" test', "watch 'npm run test'"],
			[
				'flock /l -c "timeout 590 npm"" run test"',
				"flock /l -c 'npm run test'",
			],
			[
				'flock /l -c "echo \\$X; timeout 590 npm run test"',
				"flock /l -c 'echo $X; npm run test'",
			],
			[
				`flock /l -c "echo \\"it's\\"; timeout 590 npm run test &"`,
				`flock /l -c 'echo "it'\\''s"; npm run test'`,
			],
			[
				'flock /l -c "flock /m -c \\"timeout 590 npm run test\\""',
				`flock /l -c 'flock /m -c "npm run test"'`,
			],
			[
				'timeout -s "KILL" 5 flock /l -c "echo \\"x\\"; timeout 590 npm run test &"',
				`flock /l -c 'echo "x"; npm run test'`,
			],
			[
				'WFC_SUITE_DETACH=1 flock /l -c "echo \\"x\\"; timeout 590 npm run test &"',
				`WFC_SUITE_DETACH=1 flock /l -c 'echo "x"; npm run test &'`,
			],
		])
			expect(
				readDenyReason(command).split("\n")[0].replace(FIX_OPENER, ""),
				command,
			).toBe(fix);
	});

	it("reads a typed timeout over a script whose launch is not its first command (#5874)", () => {
		expect(
			readDenyReason('timeout 5 flock /l -c "echo x; npm run test"')
				.split("\n")[0]
				.replace(FIX_OPENER, ""),
		).toBe('flock /l -c "echo x; npm run test"');
	});

	it.each([
		'WFC_SUITE_TIMEOUT=1 flock /l -c "timeout 590 npm run test"',
		'flock /l -c "WFC_SUITE_TIMEOUT=1 timeout 590 npm run test"',
		'flock /l -c "timeout 60 pytest"',
	])("passes a script's escaped or bounded timed launch: `%s`", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("leaves a timed script holding an expansion it cannot re-quote unjudged, and logs it", () => {
		const { output, logs } = runCore(
			"guard-suite-background",
			toolCall("Bash", {
				command: 'flock /l -c "echo \\"x\\" $Y; timeout 590 npm run test"',
			}),
			{ root: dir },
		);
		expect(output).toBeNull();
		expect(logs).toContain(
			"the timed script carries an expansion the re-issue cannot re-quote — its launch is left unjudged",
		);
	});

	it("says why the shell timeout is refused and names its escape", () => {
		const reason = readDenyReason("timeout 590 npm run test");
		expect(reason).toContain("This suite is WRAPPED IN A SHELL `timeout`");
		expect(reason).toContain("no pass/fail marker");
		expect(reason).toContain("`--queue` too");
		expect(reason).toContain("WFC_SUITE_TIMEOUT=1");
		expect(reason).not.toContain("DETACHED INSIDE THE SHELL");
		const both = readDenyReason("timeout 590 npm run test &");
		expect(both).toContain("DETACHED INSIDE THE SHELL");
		expect(both).toContain("WRAPPED IN A SHELL");
	});

	it("records the timeout limb in the guard registry", () => {
		const env = fs.readFileSync(
			path.resolve(__dirname, "../../docs/environment.md"),
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
			"`scripts/guard-dispatch.js`",
			"`WFC_SUITE_TIMEOUT=<non-empty>`",
		])
			expect(entry, needle).toContain(needle);
	});
});

describe("a queued suite detached from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});

	const Plain = JSON.stringify({ scripts: { test: "vitest run" } });
	const wrappedScript = JSON.stringify({
		scripts: { test: "node scripts/run-vitest.js" },
	});
	const queuedVerdict = () =>
		runCore(
			"guard-suite-background",
			toolCall("Bash", {
				command: "node scripts/queue-run.js -- npm run test &",
			}),
			{ root: at.main, worktree: at.worktree },
		).output?.permissionDecision;

	it("refuses it where the worktree's test script skips run-vitest.js, so the queue takes it", () => {
		fs.writeFileSync(path.join(at.worktree, "package.json"), Plain);
		fs.writeFileSync(path.join(at.main, "package.json"), wrappedScript);
		expect(queuedVerdict()).toBe("deny");
	});

	it("reads no suite where the worktree's test script runs run-vitest.js, whatever the main checkout's says", () => {
		fs.writeFileSync(path.join(at.worktree, "package.json"), wrappedScript);
		fs.writeFileSync(path.join(at.main, "package.json"), Plain);
		expect(queuedVerdict()).toBeUndefined();
	});

	it("counts the suite runners the host root declares, not the worktree's (#4274)", () => {
		const declare = (root: string, runners: string[]) =>
			writeHostConfig(root, { suiteRunners: runners });
		const detached = () =>
			runCore(
				"guard-suite-background",
				toolCall("Bash", { command: "node scripts/build-site.js &" }),
				{ root: at.main, worktree: at.worktree },
			).output?.permissionDecision;
		declare(at.worktree, ["scripts/build-site.js"]);
		declare(at.main, []);
		expect(detached()).toBeUndefined();
		declare(at.main, ["scripts/build-site.js"]);
		expect(detached()).toBe("deny");
	});
});

describe("its deliberate limits", () => {
	it.each([
		"sh -c 'npm run test &'",
		["bash <<'EOF'", "npm run test &", "EOF"].join("\n"),
	])(
		"leaves a launch behind a wrapper it does not strip unjudged: `%s`",
		(command) => {
			expect(verdict(command)).toBe("allow");
		},
	);

	it.each([
		"echo 'npm run test' | at now",
		"systemd-run --user npm run test",
		"tmux new-session -d 'npm run test'",
	])("passes a detachment through `%s` unseen", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("reads a detachment past a tab-indented `<<-` terminator as heredoc body", () => {
		expect(
			verdict(["cat <<-EOF", "\tbody", "\tEOF", "npm run test &"].join("\n")),
		).toBe("allow");
	});

	it("reads a second heredoc opened on one line as commands", () => {
		const command = ["cat <<A <<B", "a", "A", "b &", "B", "npm run test"].join(
			"\n",
		);
		expect(run(command)?.permissionDecision).toBe("deny");
	});

	it("refuses a subagent's detached suite as it refuses the session's", () => {
		const out = runCore(
			"guard-suite-background",
			{
				session_id: "test",
				agent_id: "sub",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "npm run test &" },
			},
			{ root: dir },
		).output;
		expect(out?.permissionDecision).toBe("deny");
	});

	describe("a subagent's snapshot run (#5724)", () => {
		const reasonFor = (command: string, agent?: string) =>
			runCore(
				"guard-suite-background",
				{
					session_id: "test",
					...(agent === undefined ? {} : { agent_id: agent }),
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command },
				},
				{ root: dir },
			).output?.permissionDecisionReason ?? "";

		it("tells a subagent to hold its turn on the moved run", () => {
			const lines = reasonFor("npm run test &", "sub").split("\n");
			expect(lines[0]).toBe(`${SNAPSHOT_OPENER}npm run test`);
			expect(lines[1]).toMatch(
				/^Past 30 s the run moves to the background; then wait inside the turn — /,
			);
			expect(lines[1]).toContain("`node scripts/in-flight-runs.js wait`");
			expect(lines[1]).toContain("re-run on `CEILING`");
		});

		it.each([
			["npm run test &", ". A "],
			["timeout 300 npm run test", ". If "],
		])(
			"tells the parent's snapshot run `%s` to keep working on independent work before ending its turn",
			(command, next) => {
				const reason = reasonFor(command);
				expect(reason.split("\n")[0]).toBe(`${SNAPSHOT_OPENER}npm run test`);
				expect(reason).not.toContain("Past 30 s");
				expect(reason).not.toContain("You are a subagent");
				expect(reason).toContain(
					`keep working on independent work; with none left, end the turn with NO tool call, or in a background job hold it on \`node scripts/in-flight-runs.js wait\` in the foreground with \`timeout: 600000\`${next}`,
				);
			},
		);

		it("tells a subagent's held 600000 run to wait inside the turn", () => {
			const reason = reasonFor("npm run test -- --full=x &", "sub");
			expect(reason.split("\n")[0]).toBe(
				`${HELD_OPENER}npm run test -- --full=x`,
			);
			expect(reason).not.toContain("Past 30 s");
			expect(reason).toContain("and notifies: then wait inside the turn — ");
			expect(reason).toContain("since nothing wakes you to resume it. A ");
		});

		it.each([
			"npm run test &",
			"timeout 300 npm run test",
			"timeout 300 npm run test -- --full=x &",
		])("never tells a subagent to end its turn on `%s`", (command) => {
			expect(reasonFor(command, "sub")).not.toContain("end the turn");
		});

		it("tells a subagent's detached snapshot run to hold its turn", () => {
			expect(reasonFor("npm run test &", "sub")).toContain(
				"and notifies: then hold your turn on it as the line above says, never ending it. A ",
			);
		});

		it("still tells the parent's held run to end its turn", () => {
			const reason = reasonFor("timeout 300 npm run test -- --full=x &");
			expect(reason).toContain("almost never delivered. A ");
			expect(reason).toContain("end the turn with NO tool call. If ");
		});
	});

	it("honours one segment's detach escape for the whole command", () => {
		expect(verdict("WFC_SUITE_DETACH=1 npm run test; npm run test:py &")).toBe(
			"allow",
		);
	});

	it.each([
		"timeout 60 pytest",
		"timeout 60 node --test",
		"env -S 'timeout 590 npm run test'",
	])("reads no shell timeout on `%s`", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		'sh -c "timeout 590 npm run test"',
		'flock /l sh -c "timeout 590 npm run test"',
		"flock /l -c timeout\\ 590\\ npm\\ run\\ test",
		"flock /l -c $'timeout 590 npm run test'",
		'flock /l --command="timeout 590 npm run test"',
		'flock /l -xc "timeout 590 npm run test"',
	])(
		"reads no shell timeout in a script the walk hands no launch from: `%s`",
		(command) => {
			expect(verdict(command)).toBe("allow");
		},
	);

	it.each([
		'flock /l -c "echo \\"x\\" $Y; timeout 590 npm run test"',
		"watch timeout 590 npm run test -- $X",
	])(
		"reads no shell timeout in a script holding an expansion the re-issue cannot re-quote: `%s`",
		(command) => {
			expect(verdict(command)).toBe("allow");
		},
	);

	it("re-joins a timed segment's words on single spaces", () => {
		expect(readDenyReason("timeout 590 npm  run   test").split("\n")[0]).toBe(
			`${SNAPSHOT_OPENER}npm run test`,
		);
	});
});
