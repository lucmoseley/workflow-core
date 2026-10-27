// @vitest-environment node
/*
 * Pins that check-host-root.js fails a core script that computes its own root
 * instead of using the host-root seam, in JS, shell and Python (#1), and
 * SKIPs a root that ships no plugin (#83).
 *
 * No case asserts that the LIVE tree is clean: that would put the gate in two
 * places, and an unrelated script's edit would fail this file instead of the
 * check. Every case plants its fault in a fixture root handed in with --root.
 *
 * Messages are asserted alongside tags, because a tag alone would survive the
 * message being rewritten into nonsense.
 *
 * It is a hard gate in .husky/pre-commit: loosen a case and a self-rooted
 * script lands, which installed as a plugin reads the plugin cache instead of
 * the adopter's repo.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-host-root.js");

const shipPlugin = (root: string) => {
	fs.mkdirSync(path.join(root, ".claude-plugin"));
	fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}");
};

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-root-check-"));
	fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
	shipPlugin(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
};

interface Envelope {
	outcome: string;
	count: number;
	findings: { severity: string; tag: string; message: string }[];
}

const run = (): Envelope =>
	JSON.parse(
		spawnSync("node", [SCRIPT, "--root", dir, "--json"], {
			encoding: "utf8",
		}).stdout,
	);

const tags = (e: Envelope) => e.findings.map((f) => f.tag);
const messages = (e: Envelope) => e.findings.map((f) => f.message).join("\n");

/*
 * The shell fixtures below quote `${CLAUDE_PROJECT_DIR:-…}`, which a plain
 * string literal cannot hold without tripping the JS-template lint and which
 * the formatter un-escapes back out of a template. Composed instead.
 */
const DOLLAR = "$";
const seam = (fallback: string) => `${DOLLAR}{CLAUDE_PROJECT_DIR:-${fallback}}`;
const HERE_WALK = '$(cd "$here/.." && pwd)';

/** A file that trips nothing, so a fixture is never empty. */
const clean = () =>
	write(
		"scripts/clean.js",
		'const { hostRoot } = require("./lib/host-root.js");\nconst ROOT = hostRoot();\n',
	);

describe("JavaScript", () => {
	it("fails a __dirname walk that climbs out of scripts/", () => {
		clean();
		write("scripts/bad.js", 'const ROOT = path.resolve(__dirname, "..");\n');
		const e = run();
		expect(tags(e)).toContain("SELF-ROOTED-JS");
		expect(messages(e)).toMatch(/bad\.js:1/);
		expect(messages(e)).toMatch(/hostRoot\(\)/);
		expect(e.outcome).toBe("FAIL");
	});

	it("passes a walk that names a sibling inside scripts/", () => {
		clean();
		write(
			"scripts/lib/ok.js",
			'const SCRIPT = path.join(__dirname, "..", "session-arbiter.js");\n',
		);
		expect(run().outcome).toBe("OK");
	});

	it("fails path.dirname(__dirname)", () => {
		clean();
		write("scripts/bad.js", "const REPO = path.dirname(__dirname);\n");
		expect(tags(run())).toContain("SELF-ROOTED-JS");
	});

	it("says nothing about a spelling that only appears in a comment", () => {
		clean();
		write(
			"scripts/commented.js",
			'/* Never path.resolve(__dirname, "..") — see #1. */\n// path.join(__dirname, "..", "..")\n',
		);
		expect(run().outcome).toBe("OK");
	});

	it("still reads a spelling on the same line as a comment", () => {
		clean();
		write(
			"scripts/bad.js",
			'const ROOT = path.resolve(__dirname, ".."); // the fault\n',
		);
		expect(tags(run())).toContain("SELF-ROOTED-JS");
	});

	it("says nothing about a walk it cannot read as literals", () => {
		clean();
		write("scripts/dynamic.js", "const p = path.join(__dirname, name);\n");
		expect(run().outcome).toBe("OK");
	});

	it("does not judge a test, a fixture or a testkit", () => {
		clean();
		for (const name of [
			"scripts/a.test.ts",
			"scripts/b-fixture.ts",
			"scripts/c-testkit.ts",
			"scripts/vitest.config.ts",
		])
			write(name, 'const ROOT = path.resolve(__dirname, "..");\n');
		expect(run().outcome).toBe("OK");
	});
});

describe("shell", () => {
	it("fails a second spelling of the seam", () => {
		clean();
		write(
			"scripts/bad.sh",
			`here="$(dirname "${DOLLAR}{BASH_SOURCE[0]}")"\nroot="${seam(HERE_WALK)}"\n`,
		);
		const e = run();
		expect(tags(e)).toContain("SELF-ROOTED-SH");
		expect(messages(e)).toMatch(/gr_root/);
	});

	it('fails git -C "$here" as SELF-ROOTED-SH', () => {
		clean();
		write("scripts/bad.sh", 'url="$(git -C "$here" config --get x)"\n');
		expect(tags(run())).toContain("SELF-ROOTED-SH");
	});

	it("fails a core file reached through the host root as HOST-ROOTED-CORE, pointing to $here", () => {
		clean();
		write("scripts/bad.sh", 'node "$(gr_root)/scripts/session-arbiter.js"\n');
		const e = run();
		expect(tags(e)).toContain("HOST-ROOTED-CORE");
		expect(messages(e)).toMatch(/\$here/);
	});

	it("says nothing about a bare $root, which names a different tree per file", () => {
		clean();
		write("scripts/ok.sh", 'for f in "$root"/scripts/*.js; do :; done\n');
		expect(run().outcome).toBe("OK");
	});

	it("says nothing about a commented-out spelling", () => {
		clean();
		write("scripts/ok.sh", `# root="${seam(HERE_WALK)}"\n`);
		expect(run().outcome).toBe("OK");
	});
});

describe("Python", () => {
	it("fails a parents[] climb out of scripts/ as SELF-ROOTED-PY, pointing to host_root()", () => {
		clean();
		write("scripts/bad.py", "ROOT = Path(__file__).resolve().parents[2]\n");
		const e = run();
		expect(tags(e)).toContain("SELF-ROOTED-PY");
		expect(messages(e)).toMatch(/host_root\(\)/);
	});

	it("passes parents[1], which stays inside scripts/", () => {
		clean();
		write("scripts/lib/ok.py", "HERE = Path(__file__).resolve().parents[1]\n");
		expect(run().outcome).toBe("OK");
	});
});

describe("the allowlist", () => {
	it("warns STALE-ALLOWLIST where an allowlisted file is present and trips nothing", () => {
		clean();
		write("scripts/proving-run.ts", "const ROOT = process.cwd();\n");
		const e = run();
		expect(tags(e)).toContain("STALE-ALLOWLIST");
		expect(messages(e)).toMatch(/allowlisted in check-host-root\.js/);
		expect(e.outcome).toBe("WARN");
	});

	it("still reports a tag the entry does not exempt", () => {
		clean();
		write(
			"scripts/wayfinder-frontier.js",
			'const top = execFileSync("git", ["rev-parse", "--show-toplevel"]);\nconst R = path.resolve(__dirname, "..");\n',
		);
		const e = run();
		expect(tags(e)).toContain("SELF-ROOTED-JS");
		expect(tags(e)).not.toContain("SECOND-SEAM-JS");
		expect(e.outcome).toBe("FAIL");
	});

	it("says nothing about an entry whose file this root does not have", () => {
		clean();
		expect(run().outcome).toBe("OK");
	});
});

describe("the seam's own files", () => {
	it("are not judged by the rule they implement", () => {
		clean();
		write(
			"scripts/lib/host-root.js",
			'const ROOT = path.resolve(__dirname, "..", "..");\n',
		);
		write("scripts/lib/guard-root.sh", `root="${seam(".")}"\n`);
		write(
			"scripts/lib/host_root.py",
			"R = Path(__file__).resolve().parents[2]\n",
		);
		expect(tags(run())).not.toContain("SELF-ROOTED-JS");
		expect(tags(run())).not.toContain("SELF-ROOTED-SH");
		expect(tags(run())).not.toContain("SELF-ROOTED-PY");
	});
});

describe("nothing to scan", () => {
	const inEmptyRoot = (build: (dir: string) => void) => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "host-root-empty-"));
		try {
			build(empty);
			const r = spawnSync("node", [SCRIPT, "--root", empty, "--json"], {
				encoding: "utf8",
			});
			return JSON.parse(r.stdout).outcome;
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	};

	it("is BROKEN, not a vacuous pass, where the core HAS a scripts/", () => {
		expect(
			inEmptyRoot((root) => {
				fs.mkdirSync(path.join(root, "scripts"));
				shipPlugin(root);
			}),
		).toBe("BROKEN");
	});

	it("SKIPs an adopter's own self-rooting scripts (#83)", () => {
		/* No plugin.json: these scripts never run from the plugin cache. */
		expect(
			inEmptyRoot((root) => {
				fs.mkdirSync(path.join(root, "scripts"));
				fs.writeFileSync(
					path.join(root, "scripts", "x.js"),
					'const p = path.resolve(__dirname, "..", "docs");\n',
				);
			}),
		).toBe("SKIP");
	});

	it("SKIPs a plugin with no scripts/ of its own (#5)", () => {
		expect(inEmptyRoot(shipPlugin)).toBe("SKIP");
	});

	it("keys on the manifest the core really ships", () => {
		/* Moved or renamed, it would turn the core's own gate into a SKIP. */
		expect(
			fs.existsSync(
				path.resolve(__dirname, "..", ".claude-plugin", "plugin.json"),
			),
		).toBe(true);
	});
});

describe("the mirror fault through a variable (#14)", () => {
	const rooted = (body: string) =>
		`const { hostRoot } = require("./lib/host-root.js");\nconst root = hostRoot();\n${body}`;

	it("fails a core directory joined onto a variable holding the root as HOST-ROOTED-CORE, naming the file and line", () => {
		clean();
		write(
			"scripts/bad.js",
			rooted('const p = path.join(root, "scripts", "x.js");\n'),
		);
		const e = run();
		expect(tags(e)).toContain("HOST-ROOTED-CORE");
		expect(messages(e)).toMatch(/bad\.js:3/);
		expect(e.outcome).toBe("FAIL");
	});

	it("fails a core-path constant joined onto that variable as HOST-ROOTED-CORE, naming the constant", () => {
		clean();
		write(
			"scripts/bad.js",
			rooted(
				'const TARGET = "scripts/lib/guard-log.sh";\nconst p = path.join(root, TARGET);\n',
			),
		);
		const e = run();
		expect(tags(e)).toContain("HOST-ROOTED-CORE");
		expect(messages(e)).toMatch(/TARGET joined onto the root/);
	});

	it("fails a core-path constant destructured from a scanned module as HOST-ROOTED-CORE", () => {
		clean();
		write(
			"scripts/lib/consts.js",
			'const CAP = path.join("scripts", "lib", "guard-log.sh");\nmodule.exports = { CAP };\n',
		);
		write(
			"scripts/bad.js",
			rooted(
				'const { CAP } = require("./lib/consts.js");\nconst p = path.join(root, CAP);\n',
			),
		);
		expect(tags(run())).toContain("HOST-ROOTED-CORE");
	});

	it("fails a core directory templated onto the root as HOST-ROOTED-CORE", () => {
		clean();
		write(
			"scripts/bad.js",
			rooted(`const p = \`${DOLLAR}{root}/scripts/x.js\`;\n`),
		);
		expect(tags(run())).toContain("HOST-ROOTED-CORE");
	});

	it("fails a core path in a template literal joined onto that variable as HOST-ROOTED-CORE", () => {
		clean();
		write(
			"scripts/bad.js",
			rooted(`const p = path.join(root, \`scripts/${DOLLAR}{name}\`);\n`),
		);
		expect(tags(run())).toContain("HOST-ROOTED-CORE");
	});

	it("passes a host path joined onto the same variable", () => {
		clean();
		write(
			"scripts/ok.js",
			rooted(
				'const DOC = "docs/doc-map.md";\nconst a = path.join(root, DOC);\nconst b = path.join(root, "docs", "x.md");\n',
			),
		);
		expect(run().outcome).toBe("OK");
	});

	it("says nothing about a variable that does not hold the host root", () => {
		clean();
		write(
			"scripts/ok.js",
			'const root = fixtureDir;\nconst p = path.join(root, "scripts", "x.js");\n',
		);
		expect(run().outcome).toBe("OK");
	});
});

describe("a second spelling of the seam in JavaScript (#14)", () => {
	it("fails a direct read of CLAUDE_PROJECT_DIR as SECOND-SEAM-JS, pointing to hostRoot()", () => {
		clean();
		write(
			"scripts/bad.js",
			"const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();\n",
		);
		const e = run();
		expect(tags(e)).toContain("SECOND-SEAM-JS");
		expect(messages(e)).toMatch(/hostRoot\(\)/);
	});

	it("fails a direct git rev-parse --show-toplevel as SECOND-SEAM-JS", () => {
		clean();
		write(
			"scripts/bad.js",
			'const top = execFileSync("git", ["rev-parse", "--show-toplevel"]);\n',
		);
		expect(tags(run())).toContain("SECOND-SEAM-JS");
	});

	it("fails --show-toplevel inside a single command string as SECOND-SEAM-JS", () => {
		clean();
		write(
			"scripts/bad.js",
			'const top = execSync("git rev-parse --show-toplevel");\n',
		);
		expect(tags(run())).toContain("SECOND-SEAM-JS");
	});

	it("says nothing about --show-toplevel named only in a comment", () => {
		clean();
		write("scripts/ok.js", "// never git rev-parse --show-toplevel here\n");
		expect(run().outcome).toBe("OK");
	});

	it("says nothing about CLAUDE_PROJECT_DIR set for a child", () => {
		clean();
		write(
			"scripts/ok.js",
			"const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO };\n",
		);
		expect(run().outcome).toBe("OK");
	});
});

describe("--against HEAD (#917)", () => {
	let hooks: string;

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });

	const against = () => {
		// Off, not inherited: a real Actions run sets it, and runCheck's
		// ::error:: annotation would leak into `out` (mantahostels#2427).
		const r = runInProcess(SCRIPT, ["--against", "HEAD"], {
			cwd: dir,
			env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: dir },
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	};

	const bad = 'const ROOT = path.resolve(__dirname, "..");\n';

	beforeEach(() => {
		hooks = fs.mkdtempSync(path.join(os.tmpdir(), "host-root-check-hooks-"));
		initGitRepo(dir, hooks);
		clean();
		git("add", ".");
		git("commit", "-qm", "seed");
	});

	afterEach(() => {
		fs.rmSync(hooks, { recursive: true, force: true });
	});

	it("passes a fault that sits only in the working tree, untracked", () => {
		write("scripts/bad.js", bad);
		expect(tags(run())).toContain("SELF-ROOTED-JS");
		const r = against();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: no gating fault in the index that HEAD does not already carry.",
		);
	});

	it("refuses the same fault once staged, naming its file, line and fix", () => {
		write("scripts/bad.js", bad);
		git("add", "scripts/bad.js");
		const r = against();
		expect(r.status).toBe(1);
		expect(r.out).toContain("NOT in HEAD — this commit adds them");
		expect(r.out).toContain("scripts/bad.js:1");
		expect(r.out).toContain("Use hostRoot() from lib/host-root.js");
	});

	it("reports a fault HEAD already carries as inherited, not new", () => {
		write("scripts/bad.js", bad);
		git("add", "scripts/bad.js");
		git("commit", "-qm", "fault");
		write("scripts/bad.js", `// moved down a line\n${bad}`);
		git("add", "scripts/bad.js");
		const r = against();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN: 1 inherited fault(s)");
	});
});
