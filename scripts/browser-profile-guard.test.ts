// @vitest-environment node
/*
 * The browser-profile guard refuses only a command that would really open a
 * URL, not the same words in a heredoc body or a quoted argument (#1547).
 *
 * The guard is machine-level, at ~/.claude/hooks/browser-profile-guard.sh, so
 * what runs here is its reference copy in docs/claude-user-settings.md;
 * `npm run check:settings` holds that copy to the live file.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyBlockPattern } from "./lib/settings-copy";

const DOC = path.resolve(__dirname, "..", "docs", "claude-user-settings.md");
const PATTERN = copyBlockPattern("browser-profile-guard.sh", "```bash");

const CHROME = '"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"';
const OPENER_OFF =
	"BROWSER='C:\\Windows\\System32\\where.exe' WSLENV=BROWSER/w";

let dir: string;
let hook: string;

beforeAll(() => {
	const found = fs.readFileSync(DOC, "utf8").match(PATTERN);
	if (!found) throw new Error(`no browser-profile-guard.sh block in ${DOC}`);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-profile-guard-"));
	hook = path.join(dir, "browser-profile-guard.sh");
	fs.writeFileSync(hook, `${found[1]}\n`, { mode: 0o755 });
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The guard's refusal reason for one command, or "" where it allows; a null config dir runs it with none set. */
const reasonFor = (
	command: string,
	configDir: string | null = "/home/u/.claude3",
): string => {
	const { CLAUDE_CONFIG_DIR: _, ...env } = process.env;
	const r = spawnSync("bash", [hook], {
		input: JSON.stringify({ tool_input: { command } }),
		env:
			configDir === null
				? { ...env, HOME: "/home/u" }
				: { ...env, CLAUDE_CONFIG_DIR: configDir },
		encoding: "utf8",
		timeout: 10_000,
	});
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");
	if (!r.stdout.trim()) return "";
	return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
};

/** The guard's verdict on one command: which refusal, or `allow`. */
const verdict = (command: string) => {
	const reason = reasonFor(command);
	if (!reason) return "allow";
	if (reason.startsWith("chrome.exe without --profile-directory"))
		return "chrome";
	if (reason.startsWith("This opens the URL in the Windows default browser"))
		return "default-browser";
	if (reason.startsWith("This tool opens the Windows default browser itself"))
		return "login-tool";
	return reason;
};

describe("words that do not run are allowed (#1547)", () => {
	it.each([
		[
			"a heredoc body naming every opener",
			[
				"cat > cases.txt <<'EOF'",
				"xdg-open https://x",
				"wslview https://x",
				"explorer.exe https://x",
				"cmd.exe /c start https://x",
				"powershell.exe Start-Process https://x",
				"rundll32 url.dll,FileProtocolHandler https://x",
				"chrome.exe https://x",
				"claude auth login",
				"gh auth login --web",
				"npm login",
				"EOF",
			].join("\n"),
		],
		["an echo naming the login command", 'echo "run claude auth login"'],
		[
			"a jq --arg holding an opener",
			"jq -n --arg x 'explorer.exe https://x' '{a: $x}'",
		],
		[
			"a heredoc inside a quoted $(…)",
			"gh issue comment 1 --body \"$(cat <<'EOF'\nUse claude auth login.\nEOF\n)\"",
		],
		["a commit message", "git commit -m 'never bare chrome.exe'"],
		["a comment", "# chrome.exe https://x\nls"],
		[
			"a heredoc fed to a script, not to an interpreter",
			"node scripts/file-issue.js --body-file - <<'EOF'\nnpm login\nEOF",
		],
	])("%s", (_, command) => {
		expect(verdict(command)).toBe("allow");
	});
});

describe("every opener refused before #1547 is still refused", () => {
	it.each([
		["chrome", "chrome.exe https://x"],
		["chrome", `${CHROME} https://x`],
		["chrome", `timeout 5 ${CHROME} https://x`],
		["chrome", `if true; then ${CHROME} https://x; fi`],
		["default-browser", "xdg-open https://x"],
		["default-browser", "ls; wslview https://x"],
		["default-browser", "/usr/bin/xdg-open https://x"],
		["default-browser", "explorer.exe https://x"],
		["default-browser", 'explorer.exe "https://x"'],
		["default-browser", "cmd.exe /c start https://x"],
		["default-browser", 'cmd.exe /c start "" "https://x"'],
		["default-browser", "powershell.exe Start-Process https://x"],
		[
			"default-browser",
			"powershell.exe -Command \"Start-Process 'https://x'\"",
		],
		["default-browser", "rundll32.exe url.dll,FileProtocolHandler https://x"],
		["login-tool", "claude auth login"],
		["login-tool", "claude.exe auth login --claudeai"],
		["login-tool", '"/mnt/c/x/claude.exe" auth login'],
		["login-tool", "gh auth login --web"],
		["login-tool", "npm login"],
		["login-tool", "sudo npm login"],
	])("%s: %s", (want, command) => {
		expect(verdict(command)).toBe(want);
	});
});

describe("a string that is itself run is read inside", () => {
	it.each([
		["login-tool", "bash -c 'claude auth login'"],
		["default-browser", "bash -lc \"explorer.exe 'https://x'\""],
		["default-browser", "echo $(explorer.exe https://x)"],
		["default-browser", 'echo "$(explorer.exe https://x)"'],
		["login-tool", "echo `npm login`"],
		["login-tool", "eval 'npm login'"],
		["default-browser", "bash <<'EOF'\nexplorer.exe https://x\nEOF"],
		["default-browser", "cat <<'EOF' | sh\nexplorer.exe https://x\nEOF"],
		["login-tool", "cat <<EOF\n$(npm login)\nEOF"],
		[
			"default-browser",
			"python3 - <<'EOF'\nimport os; os.system('explorer.exe https://x')\nEOF",
		],
		[
			"default-browser",
			'node -e \'require("child_process").execSync("cmd.exe /c start https://x")\'',
		],
	])("%s: %s", (want, command) => {
		expect(verdict(command)).toBe(want);
	});
});

describe("openers hidden from the first scan are refused (#1547 review)", () => {
	it.each([
		["chrome", `chrome=${CHROME}; "$chrome" https://x`],
		["chrome", `sudo -u someone ${CHROME} https://x`],
		["chrome", `setsid ${CHROME} https://x`],
		["chrome", `find . -name x -exec ${CHROME} https://x \\;`],
		[
			"default-browser",
			"bash -c \"$(cat <<'EOF'\nxdg-open https://x\nEOF\n)\"",
		],
		["default-browser", "eval \"$(cat <<'EOF'\nxdg-open https://x\nEOF\n)\""],
		[
			"default-browser",
			"powershell.exe -Command - <<'EOF'\nStart-Process https://x\nEOF",
		],
		["login-tool", 'script -qc "claude auth login" /dev/null'],
		[
			"default-browser",
			"cat <<'EOF' > o.sh\nxdg-open https://x\nEOF\nbash o.sh",
		],
		[
			"login-tool",
			"cat > o.sh <<'EOF'\nnpm login\nEOF\nchmod +x o.sh && ./o.sh",
		],
	])("%s: %s", (want, command) => {
		expect(verdict(command)).toBe(want);
	});

	it.each([
		"timeout 5 ./o.sh",
		"FOO=1 ./o.sh",
		"env FOO=1 ./o.sh",
		"echo `./o.sh`",
		">log ./o.sh",
		"sudo -u root ./o.sh",
		"watch ./o.sh",
	])("refuses a written file run as %s", (run) => {
		expect(verdict(`cat > o.sh <<'EOF'\nnpm login\nEOF\n${run}`)).toBe(
			"login-tool",
		);
	});

	it("allows a heredoc written to a file the command never runs", () => {
		expect(
			verdict("cat > notes.md <<'EOF'\nnpm login\nEOF\ngit add notes.md"),
		).toBe("allow");
	});

	it("allows a written file passed to a script as data (#1986)", () => {
		expect(
			verdict(
				"cat > .claude/tmp/x.md <<'EOF'\nnever bare chrome.exe https://x\nEOF\nnode scripts/resolve-ticket.js 1 --comment-file .claude/tmp/x.md",
			),
		).toBe("allow");
	});
});

describe("each refusal names its fix", () => {
	it("a bare chrome.exe is told to pass --profile-directory, and which", () => {
		const reason = reasonFor("chrome.exe https://x");
		expect(reason).toContain("without --profile-directory");
		expect(reason).toContain('--profile-directory="Profile 1" "<url>"');
	});

	// #1952
	it.each([
		["/home/u/.claude3", '--profile-directory="Profile 1" "<url>"'],
		["/home/u/.claude2/", '--profile-directory="Profile 2" "<url>"'],
		["/home/u/.claude", '--profile-directory="Default" "<url>"'],
		[null, '--profile-directory="Default" "<url>"'],
	])("a session under %s is told its own profile", (configDir, command) => {
		expect(reasonFor("xdg-open https://x", configDir)).toContain(command);
	});

	// #1986: Default is the profile every refusal warns against.
	it("a session under an unknown config dir is given the map, not a profile", () => {
		const reason = reasonFor("xdg-open https://x", "/home/u/.other");
		expect(reason).not.toContain("--profile-directory=");
		expect(reason).toContain(
			'the travel account, 3rd in the picker (directory "Profile 1"',
		);
	});

	it.each(["chrome.exe https://x", "xdg-open https://x", "npm login"])(
		"names the inactive subscription one way throughout: %s (#1986)",
		(command) => {
			const reason = reasonFor(command);
			expect(reason).toContain("the inactive subscription");
			expect(reason).not.toContain("inactive account");
		},
	);

	it.each(["chrome.exe https://x", "xdg-open https://x", "npm login"])(
		"names no account's address: %s (#1962)",
		(command) => {
			const reason = reasonFor(command);
			expect(reason).not.toBe("");
			expect(reason).not.toMatch(/@/);
		},
	);

	it("a default-browser opener is told the chrome.exe command", () => {
		expect(reasonFor("xdg-open https://x")).toContain(
			'Open it with: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory',
		);
	});

	it("a login tool is told the opener-disabling prefix", () => {
		expect(reasonFor("npm login")).toContain(OPENER_OFF);
	});
});

describe("the sanctioned forms pass", () => {
	it("chrome.exe with --profile-directory", () => {
		expect(
			verdict(`${CHROME} --profile-directory="Profile 1" "https://x"`),
		).toBe("allow");
	});

	it("a login tool with its opener disabled", () => {
		expect(
			verdict(`${OPENER_OFF} claude.exe auth login --claudeai --email a@b.c`),
		).toBe("allow");
	});
});

describe("malformed input ends", () => {
	it.each([
		'echo "unterminated npm login',
		"echo 'unterminated npm login",
		"cat <<EOF\nnever closed npm login",
		"echo $(unclosed npm login",
		"echo `unclosed npm login",
	])("returns a verdict for %s", (command) => {
		expect(["allow", "login-tool"]).toContain(verdict(command));
	});
});
