// @vitest-environment node
/*
 * The browser-profile guard refuses only a command that would really open a
 * URL, not the same words in a heredoc body or a quoted argument (#1547), and
 * names the Chrome profile it derives from the session's own account (#5339).
 *
 * The fixtures pin the two undocumented stores the guard reads: `.claude.json`'s
 * `oauthAccount.emailAddress` and Chrome's `Local State` `.profile.info_cache`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "browser-profile-guard.sh");

const CHROME = '"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"';
const OPENER_OFF =
	"BROWSER='C:\\Windows\\System32\\where.exe' WSLENV=BROWSER/w";

const ACCOUNT = "travel@example.test";
const INFO_CACHE = {
	Default: { name: "Person 1", user_name: "other@example.test" },
	"Profile 1": { name: "Travel", user_name: ACCOUNT },
	"Profile 2": { name: "Work", user_name: "work@example.test" },
};
const LOCAL_STATE = "AppData/Local/Google/Chrome/User Data/Local State";

let dir: string;
let fixtures = 0;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-profile-guard-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory holding `files`, each a path and its JSON or raw text. */
const tree = (files: Record<string, unknown>): string => {
	const root = path.join(dir, `f${fixtures++}`);
	fs.mkdirSync(root, { recursive: true });
	for (const [rel, body] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			typeof body === "string" ? body : JSON.stringify(body),
		);
	}
	return root;
};

const store = (infoCache: unknown) => ({ profile: { info_cache: infoCache } });
const account = (email: string) => ({
	oauthAccount: { emailAddress: email, displayName: "x" },
});

interface World {
	/** `.claude.json`'s contents, or null for no file. */
	claudeJson?: unknown;
	/** One `Local State` per Windows user. */
	stores?: unknown[];
}

/** Runs the guard on one command against a world's two stores. */
const run = (
	command: string,
	{ claudeJson = account(ACCOUNT), stores = [store(INFO_CACHE)] }: World = {},
	bashArgs: string[] = [],
) => {
	const configDir = tree(
		claudeJson === null ? {} : { ".claude.json": claudeJson },
	);
	const users = tree(
		Object.fromEntries(stores.map((s, i) => [`u${i}/${LOCAL_STATE}`, s])),
	);
	return spawnSync("bash", [...bashArgs, HOOK], {
		input: JSON.stringify({ tool_input: { command } }),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: configDir,
			BROWSER_GUARD_WINDOWS_USERS: users,
		},
		encoding: "utf8",
		timeout: 10_000,
	});
};

/** The guard's refusal reason for one command, or "" where it allows. */
const readReasonFor = (command: string, world: World = {}): string => {
	const r = run(command, world);
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");
	if (!r.stdout.trim()) return "";
	return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
};

/** The guard's verdict on one command: which refusal, or `allow`. */
const verdict = (command: string) => {
	const reason = readReasonFor(command);
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
	])("refuses a written file run as %s", (launch) => {
		expect(verdict(`cat > o.sh <<'EOF'\nnpm login\nEOF\n${launch}`)).toBe(
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
		const reason = readReasonFor("chrome.exe https://x");
		expect(reason).toContain("without --profile-directory");
		expect(reason).toContain('--profile-directory="Profile 1" "<url>"');
	});

	it.each(["chrome.exe https://x", "xdg-open https://x", "npm login"])(
		"names the derived profile and its account, and no other address: %s",
		(command) => {
			const reason = readReasonFor(command);
			expect(reason).toContain('--profile-directory="Profile 1"');
			expect(reason).toContain(`signed in to ${ACCOUNT}`);
			expect(reason.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)).toEqual([ACCOUNT]);
		},
	);

	it.each(["chrome.exe https://x", "xdg-open https://x", "npm login"])(
		"carries no account map and no machine path: %s",
		(command) => {
			const reason = readReasonFor(command);
			expect(reason).not.toContain("machine-facts.md");
			expect(reason).not.toContain("~/");
			expect(reason).not.toMatch(/\.claude\d/);
			expect(reason).toContain(
				"the machine note the `browser-ladder` skill names",
			);
		},
	);

	it("a default-browser opener is told the chrome.exe command", () => {
		expect(readReasonFor("xdg-open https://x")).toContain(
			'Open it with: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory',
		);
	});

	it("a login tool is told the opener-disabling prefix", () => {
		expect(readReasonFor("npm login")).toContain(OPENER_OFF);
	});
});

describe("an underivable profile still refuses, naming none (#5339)", () => {
	it.each<[string, World]>([
		["no .claude.json", { claudeJson: null }],
		["no email in .claude.json", { claudeJson: { oauthAccount: {} } }],
		["an unreadable .claude.json", { claudeJson: "{not json" }],
		["no Local State", { stores: [] }],
		[
			"two Local State files",
			{ stores: [store(INFO_CACHE), store(INFO_CACHE)] },
		],
		[
			"no profile signed in to the account",
			{ claudeJson: account("nobody@example.test") },
		],
		[
			"two profiles signed in to the account",
			{
				stores: [store({ ...INFO_CACHE, "Profile 3": { user_name: ACCOUNT } })],
			},
		],
		["a Local State with no profile store", { stores: [{ browser: {} }] }],
	])("%s", (_, world) => {
		for (const command of [
			"chrome.exe https://x",
			"xdg-open https://x",
			"npm login",
		]) {
			const reason = readReasonFor(command, world);
			expect(reason).not.toBe("");
			expect(reason).not.toContain("--profile-directory=");
			expect(reason).not.toMatch(/@/);
			expect(reason).toContain("No single Chrome profile could be matched");
		}
	});
});

describe("a command naming no trigger reads neither store", () => {
	it("allows it without touching .claude.json or Local State", () => {
		const r = run("git status", {}, ["-x"]);
		expect(r.stdout).toBe("");
		expect(r.stderr).not.toContain(".claude.json");
		expect(r.stderr).not.toContain("Local State");
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

describe("a payload it cannot judge passes", () => {
	const raw = (input: string) =>
		spawnSync("bash", [HOOK], { input, encoding: "utf8", timeout: 10_000 });

	it.each(["not json", "[1,2]", '"npm login"'])(
		"names %s on stderr as unjudged",
		(input) => {
			const r = raw(input);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe(
				"browser-profile-guard: the hook payload is not JSON, so nothing is judged\n",
			);
		},
	);

	it("passes a payload with no command silently", () => {
		const r = raw(JSON.stringify({ tool_input: {} }));
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
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
