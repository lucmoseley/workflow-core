// @vitest-environment node

/*
 * Pins the load point for the adopter's own pre-commit gates,
 * `.husky/pre-commit.local` (#437, #426): sourced last and only if present, a
 * failing command refuses the commit, and a `scripts/` or `.claude/` script it
 * names but the repo lacks refuses every commit.
 *
 * The block is cut from the real hook and run under `sh -e` in a throwaway
 * repo, so a case stages into its own index and never the shared tree's.
 *
 * Breaking it costs every adopter's own gates: a red local gate commits
 * unrefused, or one whose script has gone missing passes every commit silently.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	cutLocalGateBlock,
	HOOK,
	LIB,
	LOCAL_GATE_OPEN,
} from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

/** The refusal's way out, which every missing-script case must print. */
const WAY_OUT =
	"Every commit is refused until it exists or the local file stops naming it";

/** A repo with one commit, `files` written into it and `staged` staged. */
function fixture(opts: {
	local?: string;
	files?: Record<string, string>;
	staged?: Record<string, string>;
}) {
	const { root } = stagedRepo("local-gate-", temps, {}, opts.staged ?? {});
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), body);
	};
	if (opts.local !== undefined) write(".husky/pre-commit.local", opts.local);
	for (const [rel, body] of Object.entries(opts.files ?? {})) write(rel, body);
	return root;
}

function run(root: string) {
	const script = `${LIB}\n\n${cutLocalGateBlock()}\necho REACHED-END\n`;
	const r = spawnSync("sh", ["-e", "-c", script], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, WFC_PLUGIN_ROOT: "/nonexistent/plugin" },
	});
	return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("the pre-commit.local load point", () => {
	it("sits after every core gate and before the stand-down stamp", () => {
		const at = HOOK.indexOf(LOCAL_GATE_OPEN);
		expect(at).toBeGreaterThan(HOOK.indexOf("check-ruff-introduced.js"));
		expect(at).toBeLessThan(HOOK.indexOf("wfc-precommit-stamp"));
	});

	it("changes nothing where the file is absent", () => {
		const r = run(fixture({}));
		expect(r.status).toBe(0);
		expect(r.out.trim()).toBe("REACHED-END");
	});

	it("refuses the commit on a local gate that exits non-zero, passing on its exit code and output and stopping there", () => {
		const r = run(fixture({ local: 'echo "local gate ran" >&2\nexit 3\n' }));
		expect(r.status).toBe(3);
		expect(r.out).toContain("local gate ran");
		expect(r.out).not.toContain("REACHED-END");
	});

	it("refuses on a bare failing command, the hook being `sh -e`", () => {
		const r = run(fixture({ local: "false\necho after\n" }));
		expect(r.status).not.toBe(0);
		expect(r.out).not.toContain("after");
	});

	it("runs a staged_gate declared there against the staged copy", () => {
		const local = [
			"staged_gate local-note live status 'note.txt' \\",
			"\t'grep -q ok \"$sg_dir/note.txt\"' \\",
			"\t'  note.txt must say ok'",
		].join("\n");
		const bad = run(fixture({ local, staged: { "note.txt": "bad\n" } }));
		expect(bad.status).toBe(1);
		expect(bad.out).toContain("note.txt must say ok");
		const good = run(fixture({ local, staged: { "note.txt": "ok\n" } }));
		expect(good.status).toBe(0);
		expect(good.out).toContain("REACHED-END");
	});

	it("refuses every commit on a missing script, arming path staged or not, naming the script and the way out (#426)", () => {
		const local = [
			"if git diff --cached --name-only | grep -q '^docs/tax\\.md$'; then",
			'\tnode scripts/x.js || exit "$?"',
			"fi",
		].join("\n");
		const r = run(fixture({ local }));
		expect(r.status).toBe(1);
		expect(r.out).toContain("  scripts/x.js");
		expect(r.out).toContain(WAY_OUT);
		expect(r.out).not.toContain("REACHED-END");
	});

	it("names a missing .claude script, and each missing path once", () => {
		const local = [
			'bash .claude/hooks/gone.sh "$1" && bash ./.claude/hooks/gone.sh',
			'python3 "$root"/scripts/gone.py',
		].join("\n");
		const r = run(fixture({ local }));
		expect(r.status).toBe(1);
		expect(r.out.match(/^ {2}\.claude\/hooks\/gone\.sh$/gm)).toHaveLength(1);
		expect(r.out).toContain("  scripts/gone.py");
		expect(r.out).toContain(WAY_OUT);
	});

	it("reads no scripts/ inside another directory as the repo's own", () => {
		const local = [
			"node node_modules/pkg/scripts/tool.js || :",
			"bash /opt/other/scripts/tool.sh || :",
			"node myscripts/tool.js || :",
			"echo local-ok",
		].join("\n");
		const r = run(fixture({ local }));
		expect(r.out).not.toContain(WAY_OUT);
		expect(r.status).toBe(0);
	});

	it("checks the paths a trailing comment or a `||` would otherwise hide", () => {
		const local = [
			"node scripts/mine.js # was scripts/old.js",
			'node scripts/gone.js||node "$WFC_PLUGIN_ROOT"/scripts/y.js',
		].join("\n");
		const r = run(
			fixture({ local, files: { "scripts/mine.js": "process.exit(0);\n" } }),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("  scripts/gone.js");
		expect(r.out).not.toContain("old.js");
	});

	it("passes a script that exists, and one under $WFC_PLUGIN_ROOT, quoted or not", () => {
		const local = [
			"# node scripts/commented-out.js",
			"node scripts/mine.js",
			'node "$WFC_PLUGIN_ROOT"/scripts/y.js --check || :',
			"node $WFC_PLUGIN_ROOT/scripts/z.js --check || :",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'node "${WFC_PLUGIN_ROOT}/scripts/w.cjs" || :',
			"grep -q '^scripts/arming\\.js$' /dev/null || :",
			"echo local-ok",
		].join("\n");
		const r = run(
			fixture({
				local,
				files: { "scripts/mine.js": "process.exit(0);\n" },
			}),
		);
		expect(r.out).not.toContain("does not have");
		expect(r.status).toBe(0);
		expect(r.out).toContain("local-ok");
	});
});
