// @vitest-environment node
/*
 * git-fixture.test.ts — tests of git-fixture.ts, the template-and-copy git
 * repository fixture most guard tests build on (mantahostels#2068, spec
 * mantahostels#2048). Every case runs real git in
 * scratch directories, because what the fixture promises is a working copy
 * isolated from its template; a loosened case here lets that isolation break
 * unseen in every file that builds on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	copyTemplate,
	defineTemplate,
	isSkippedFromLeakScan,
	mkDirOutsideRepo,
	mkScratchDir,
	resolveScratchBase,
	scratchBase,
} from "./git-fixture";

let root: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

const initRepo = (at: string) => {
	fs.mkdirSync(at, { recursive: true });
	git(at, "init", "-q", "-b", "main", ".");
	git(at, "config", "user.email", "test@example.com");
	git(at, "config", "user.name", "test");
	fs.writeFileSync(path.join(at, "a.md"), "a\n");
	git(at, "add", "a.md");
	git(at, "commit", "-qm", "init");
};

beforeEach(() => {
	root = mkScratchDir("git-fixture-test-");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.WFC_GIT_FIXTURE_DIRECT;
});

describe("a plain template", () => {
	const template = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
	});

	it("instantiates a working git repository", () => {
		const dest = path.join(root, "copy");
		template.instantiate(dest);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
		expect(fs.readFileSync(path.join(dest, "repo", "a.md"), "utf8")).toBe(
			"a\n",
		);
	});

	it("keeps a commit in the copy invisible to the template", () => {
		const first = path.join(root, "first");
		template.instantiate(first);
		fs.writeFileSync(path.join(first, "repo", "b.md"), "b\n");
		git(path.join(first, "repo"), "add", "b.md");
		git(path.join(first, "repo"), "commit", "-qm", "add b");

		const second = path.join(root, "second");
		template.instantiate(second);
		expect(fs.existsSync(path.join(second, "repo", "b.md"))).toBe(false);
		expect(
			git(path.join(second, "repo"), "log", "--oneline").trim().split("\n"),
		).toHaveLength(1);
	});
});

// #806: vitest.setup.ts's suite-level git config.
describe("a repo any test makes", () => {
	it("reports automatic maintenance and auto-gc off", () => {
		const repo = path.join(root, "repo");
		initRepo(repo);
		expect(git(repo, "config", "--get", "maintenance.auto").trim()).toBe(
			"false",
		);
		expect(git(repo, "config", "--get", "gc.auto").trim()).toBe("0");
	});
});

describe("a template counting its own builds", () => {
	// A separate describe block, not folded into "a plain template" above: its
	// build counter must see only this test's own instantiate() calls.
	let builds = 0;
	const counted = defineTemplate((dir) => {
		builds++;
		initRepo(path.join(dir, "repo"));
	});

	it("builds the template once across many instantiations", () => {
		for (let i = 0; i < 5; i++)
			counted.instantiate(path.join(root, `copy-${i}`));
		expect(builds).toBe(1);
	});
});

describe("a template carrying a worktree", () => {
	const template = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		git(
			path.join(dir, "repo"),
			"worktree",
			"add",
			"-q",
			"-b",
			"side",
			path.join(dir, "wt"),
		);
	});

	it("keeps a commit made in the copied worktree invisible to the template", () => {
		const first = path.join(root, "first");
		template.instantiate(first);
		fs.writeFileSync(path.join(first, "wt", "c.md"), "c\n");
		git(path.join(first, "wt"), "add", "c.md");
		git(path.join(first, "wt"), "commit", "-qm", "add c");

		const second = path.join(root, "second");
		template.instantiate(second);
		expect(fs.existsSync(path.join(second, "wt", "c.md"))).toBe(false);
		expect(
			git(path.join(second, "repo"), "log", "--all", "--oneline")
				.trim()
				.split("\n"),
		).toHaveLength(1);
		// The copy's worktree is genuinely usable, not just present on disk.
		expect(
			git(path.join(second, "wt"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});
});

describe("the leak check", () => {
	// Each template below is used by exactly one test, but is still defined
	// here at describe scope rather than inside its it(): defineTemplate()
	// registers an afterAll, and vitest only honours a hook registered while a
	// suite is being collected — never from inside a running test.

	// A build function that plants its own absolute path in a plain file —
	// exactly what a non-git absolute-path carrier (an arbiter store, say)
	// looks like when its caller forgets to list it in extraPaths.
	const leftoverTemplate = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		fs.writeFileSync(
			path.join(dir, "leftover.json"),
			JSON.stringify({ root: dir }),
		);
	});

	const extraPathTemplate = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		fs.writeFileSync(
			path.join(dir, "arbiter-store.json"),
			JSON.stringify({ root: dir }),
		);
	});

	const ordinaryTemplate = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		// Plants the template's own absolute path in the two locations the scan
		// is supposed to skip. Mutation-sensitive to the objects/ exclusion
		// regressing — a plain "no throw" case that never wrote there would pass
		// either way. NOT sensitive to the .git/index exclusion (mantahostels#2068 review,
		// finding F2): git's index is binary from its first bytes, so
		// looksBinary() already skips it regardless of isSkippedFromLeakScan();
		// the write below documents intent but proves nothing about that branch.
		fs.mkdirSync(path.join(dir, "repo", ".git", "objects", "aa"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, "repo", ".git", "objects", "aa", "fake-object"),
			dir,
		);
		fs.appendFileSync(path.join(dir, "repo", ".git", "index"), dir);
	});

	it("throws naming the file when a template path survives relinking", () => {
		expect(() => leftoverTemplate.instantiate(path.join(root, "copy"))).toThrow(
			/leftover\.json/,
		);
	});

	it("relinks a caller-supplied extra path instead of leaking it", () => {
		const dest = path.join(root, "copy");
		expect(() =>
			extraPathTemplate.instantiate(dest, {
				extraPaths: ["arbiter-store.json"],
			}),
		).not.toThrow();
		const written = fs.readFileSync(
			path.join(dest, "arbiter-store.json"),
			"utf8",
		);
		expect(JSON.parse(written).root).toBe(dest);
	});

	it("does not scan .git/objects or .git/index, so an ordinary copy never false-positives", () => {
		const dest = path.join(root, "copy");
		expect(() => ordinaryTemplate.instantiate(dest)).not.toThrow();
	});

	// mantahostels#2155: this template overwrites .git/index with plain text — no NUL byte
	// — so looksBinary() reads false, and it is the isSkippedFromLeakScan()
	// exclusion alone, not looksBinary(), that stops the throw: removing the
	// carve-out fails this test.
	const textIndexTemplate = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		fs.writeFileSync(path.join(dir, "repo", ".git", "index"), dir);
	});

	// A non-excluded .git/ file carrying the same kind of text leak, planted the
	// same way: proves checkForLeak still reaches into .git/ at all, so the case
	// below is the index carve-out specifically and not some wider skip of the
	// whole .git/ directory.
	const gitMarkerTemplate = defineTemplate((dir) => {
		initRepo(path.join(dir, "repo"));
		fs.writeFileSync(path.join(dir, "repo", ".git", "MANTA-TEST-MARKER"), dir);
	});

	it("does throw on a non-excluded .git/ file carrying the template path", () => {
		const dest = path.join(root, "copy");
		expect(() => gitMarkerTemplate.instantiate(dest)).toThrow(
			/MANTA-TEST-MARKER/,
		);
	});

	it("does not scan .git/index even when it carries no NUL byte", () => {
		const dest = path.join(root, "copy");
		expect(() => textIndexTemplate.instantiate(dest)).not.toThrow();
	});
});

describe("isSkippedFromLeakScan", () => {
	// Direct unit tests of the exclusion list, rather than only through
	// instantiate(): the objects/info/alternates carve-out has no path through
	// the public API that fails when it regresses, since relink() already
	// rewrites that file before the scan ever runs (mantahostels#2068 review, finding F3).
	const rel = (...segments: string[]) => segments.join(path.sep);

	it("skips ordinary pack/loose object data", () => {
		expect(
			isSkippedFromLeakScan(rel("repo", ".git", "objects", "aa", "x")),
		).toBe(true);
	});

	it("does not skip objects/info/alternates, nor the path down to it", () => {
		expect(isSkippedFromLeakScan(rel("repo", ".git", "objects"))).toBe(false);
		expect(isSkippedFromLeakScan(rel("repo", ".git", "objects", "info"))).toBe(
			false,
		);
		expect(
			isSkippedFromLeakScan(
				rel("repo", ".git", "objects", "info", "alternates"),
			),
		).toBe(false);
	});

	it("skips .git/index", () => {
		expect(isSkippedFromLeakScan(rel("repo", ".git", "index"))).toBe(true);
	});

	it("skips nothing outside a .git directory", () => {
		expect(isSkippedFromLeakScan(rel("objects", "index"))).toBe(false);
	});
});

describe("leakCheck: first-only", () => {
	const leftoverFromStart = defineTemplate(
		(dir) => {
			initRepo(path.join(dir, "repo"));
			fs.writeFileSync(
				path.join(dir, "leftover.json"),
				JSON.stringify({ root: dir }),
			);
		},
		{ leakCheck: "first-only" },
	);

	it('still scans the first instantiation, same as "always" would', () => {
		// Distinguishes first-only from an off switch: if it skipped the first
		// scan too, this would pass instead of throwing (mantahostels#2068 review, finding
		// F1/S1 — the version of this test with no leak on the template itself
		// cannot tell the two apart, since nothing has leaked yet either way).
		expect(() =>
			leftoverFromStart.instantiate(path.join(root, "copy")),
		).toThrow(/leftover\.json/);
	});

	let templateDir: string | undefined;
	const template = defineTemplate(
		(dir) => {
			templateDir = dir;
			initRepo(path.join(dir, "repo"));
		},
		{ leakCheck: "first-only" },
	);

	it("trusts every later copy once the first scan has passed", () => {
		const first = path.join(root, "first");
		expect(() => template.instantiate(first)).not.toThrow();

		// Planted straight into the template after the one scan already ran —
		// an "always" template would catch this on the next instantiate(); this
		// one must not, or first-only is silently scanning every time anyway.
		// The cast is safe: the build fn above set templateDir synchronously
		// inside the instantiate() call that already returned on the line above.
		fs.writeFileSync(
			path.join(templateDir as string, "leftover.json"),
			JSON.stringify({ root: templateDir }),
		);

		const second = path.join(root, "second");
		expect(() => template.instantiate(second)).not.toThrow();
		expect(fs.existsSync(path.join(second, "leftover.json"))).toBe(true);
	});
});

describe("a named-variant template", () => {
	const template = defineTemplate({
		empty: (dir) => {
			fs.mkdirSync(dir, { recursive: true });
			git(dir, "init", "-q", "-b", "main", ".");
			git(dir, "config", "user.email", "test@example.com");
			git(dir, "config", "user.name", "test");
		},
		withCommit: (dir) => {
			initRepo(dir);
		},
	});

	it("returns the state each variant was built with", () => {
		const emptyDest = path.join(root, "empty");
		template.instantiate(emptyDest, "empty");
		expect(git(emptyDest, "log", "--oneline", "--all").trim()).toBe("");

		const committedDest = path.join(root, "with-commit");
		template.instantiate(committedDest, "withCommit");
		expect(
			git(committedDest, "log", "--oneline").trim().split("\n"),
		).toHaveLength(1);
	});

	it("throws on an undefined variant name", () => {
		expect(() => template.instantiate(path.join(root, "x"), "nope")).toThrow(
			/nope/,
		);
	});
});

describe("the escape hatch", () => {
	let builds = 0;
	const template = defineTemplate((dir) => {
		builds++;
		initRepo(dir);
	});

	// The file-level afterEach above already clears WFC_GIT_FIXTURE_DIRECT.

	it("builds directly into the destination instead of copying", () => {
		process.env.WFC_GIT_FIXTURE_DIRECT = "1";
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		template.instantiate(a);
		template.instantiate(b);
		expect(builds).toBe(2);
		expect(git(a, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
		expect(git(b, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
	});
});

describe("copyTemplate", () => {
	// Unit tests of the retry helper directly (mantahostels#2379), against a real
	// standalone template rather than one built via defineTemplate: an
	// injected function stands in for the transient failure, per §X2, rather
	// than mocking `fs.cpSync` itself.
	let templateDir: string;
	let rebuiltDirs: string[];

	const buildRebuilt = (): string => {
		const dir = mkScratchDir("git-fixture-copy-tpl-rebuilt-");
		rebuiltDirs.push(dir);
		initRepo(path.join(dir, "repo"));
		return dir;
	};

	beforeEach(() => {
		templateDir = mkScratchDir("git-fixture-copy-tpl-");
		initRepo(path.join(templateDir, "repo"));
		rebuiltDirs = [];
	});

	afterEach(() => {
		fs.rmSync(templateDir, { recursive: true, force: true });
		for (const dir of rebuiltDirs)
			fs.rmSync(dir, { recursive: true, force: true });
	});

	it("retries once after a partial copy, and finishes it", () => {
		const dest = path.join(root, "copy");
		let calls = 0;
		copyTemplate(templateDir, dest, (source, destination, opts) => {
			calls++;
			if (calls === 1) {
				fs.mkdirSync(path.join(destination as string, "repo"), {
					recursive: true,
				});
				throw new Error("ENOENT, simulated");
			}
			fs.cpSync(source, destination, opts);
		});
		expect(calls).toBe(2);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});

	// mantahostels#2392 (the ticket that rebuilds a vanished template).
	it("rebuilds a vanished template before retrying, and copies from the new one", () => {
		const dest = path.join(root, "copy");
		let rebuilds = 0;
		let rebuilt = "";
		const source = copyTemplate(
			templateDir,
			dest,
			(from, to, opts) => {
				if (from === templateDir) {
					fs.rmSync(templateDir, { recursive: true, force: true });
					throw new Error("ENOENT, simulated");
				}
				fs.cpSync(from, to, opts);
			},
			() => {
				rebuilds++;
				rebuilt = buildRebuilt();
				return rebuilt;
			},
		);
		expect(rebuilds).toBe(1);
		expect(source).toBe(rebuilt);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});

	// The CI-only failure #124 traced: the template directory the test had just
	// deleted still read as present on the runner, so the existence fast path
	// was skipped and the doomed replay ran.
	it("rebuilds when the template survives the check but the replay fails anyway", () => {
		const dest = path.join(root, "copy");
		let rebuilds = 0;
		let rebuilt = "";
		let calls = 0;
		const source = copyTemplate(
			templateDir,
			dest,
			(from, to, opts) => {
				calls++;
				if (from === templateDir) throw new Error("ENOENT, simulated");
				fs.cpSync(from, to, opts);
			},
			() => {
				rebuilds++;
				rebuilt = buildRebuilt();
				return rebuilt;
			},
		);
		expect(fs.existsSync(templateDir)).toBe(true);
		// Three: the first attempt, the replay whose failure is what triggers
		// the rebuild, and the copy from the rebuilt dir. Two would mean the
		// existence fast path had fired and the case was not the CI one.
		expect(calls).toBe(3);
		expect(rebuilds).toBe(1);
		expect(source).toBe(rebuilt);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});

	it("retries a failed copy from the rebuilt template once", () => {
		const dest = path.join(root, "copy");
		let rebuilt = "";
		let rebuiltCopies = 0;
		const source = copyTemplate(
			templateDir,
			dest,
			(from, to, opts) => {
				if (from === templateDir) {
					fs.rmSync(templateDir, { recursive: true, force: true });
					throw new Error("ENOENT, simulated");
				}
				rebuiltCopies++;
				if (rebuiltCopies === 1) throw new Error("ENOENT, simulated rebuilt");
				fs.cpSync(from, to, opts);
			},
			() => {
				rebuilt = buildRebuilt();
				return rebuilt;
			},
		);
		expect(rebuiltCopies).toBe(2);
		expect(source).toBe(rebuilt);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});

	it("throws the second copy error when the copy from the rebuilt template fails twice", () => {
		let rebuiltCopies = 0;
		expect(() =>
			copyTemplate(
				templateDir,
				path.join(root, "copy"),
				(from) => {
					if (from === templateDir) {
						fs.rmSync(templateDir, { recursive: true, force: true });
						throw new Error("ENOENT, simulated");
					}
					rebuiltCopies++;
					throw new Error("ENOENT, simulated rebuilt");
				},
				buildRebuilt,
			),
		).toThrow(/simulated rebuilt/);
		expect(rebuiltCopies).toBe(2);
	});

	it("does not rebuild when the template is still there", () => {
		const dest = path.join(root, "copy");
		let rebuilds = 0;
		let calls = 0;
		const source = copyTemplate(
			templateDir,
			dest,
			(from, to, opts) => {
				calls++;
				if (calls === 1) throw new Error("ENOENT, simulated");
				fs.cpSync(from, to, opts);
			},
			() => {
				rebuilds++;
				return templateDir;
			},
		);
		expect(rebuilds).toBe(0);
		expect(calls).toBe(2);
		expect(source).toBe(templateDir);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});

	it("does not retry a second time — a repeat failure still throws, with the error the copy raised", () => {
		expect(() =>
			copyTemplate(templateDir, path.join(root, "copy"), () => {
				throw new Error("ENOENT, simulated");
			}),
		).toThrow(/ENOENT, simulated/);
	});

	// mantahostels#2437: the real `fs.cpSync` throws EACCES on `.git/objects/<xx>` when
	// retried over a destination that already holds a full copy — git's loose
	// objects are read-only, and cpSync's open-for-write has no unlink first.
	// The sweep's other failure, an ENOENT into a destination never written to
	// before, is a different cause and not fixed here (mantahostels#2460).
	it("retries over a destination that already holds a full copy, real cpSync", () => {
		const dest = path.join(root, "copy");
		let calls = 0;
		copyTemplate(templateDir, dest, (source, destination, opts) => {
			calls++;
			fs.cpSync(source, destination, opts);
			if (calls === 1) throw new Error("simulated transient failure");
		});
		expect(calls).toBe(2);
		expect(
			git(path.join(dest, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});
});

describe("a template whose directory vanishes between instantiations", () => {
	// End to end through instantiate(), so the production rebuild closure runs
	// — the two copyTemplate tests above pass a closure of their own and would
	// stay green with Template's own reset deleted (mantahostels#2392 review). The marker
	// file carries the template's absolute path, so relinking it to the
	// destination proves the copy was relinked against the REBUILT dir rather
	// than the vanished one.
	const built: string[] = [];
	const template = defineTemplate((dir) => {
		built.push(dir);
		initRepo(path.join(dir, "repo"));
		fs.writeFileSync(path.join(dir, "marker.txt"), dir);
	});

	it("rebuilds the template rather than replaying against the missing path", () => {
		const a = path.join(root, "a");
		template.instantiate(a, { extraPaths: ["marker.txt"] });
		expect(built).toHaveLength(1);

		fs.rmSync(built[0], { recursive: true, force: true });

		const b = path.join(root, "b");
		expect(() =>
			template.instantiate(b, { extraPaths: ["marker.txt"] }),
		).not.toThrow();
		expect(built).toHaveLength(2);
		expect(built[1]).not.toBe(built[0]);
		expect(fs.readFileSync(path.join(b, "marker.txt"), "utf8")).toBe(b);
		expect(
			git(path.join(b, "repo"), "rev-parse", "--is-inside-work-tree").trim(),
		).toBe("true");
	});
});

describe("a template with objects/info/alternates set", () => {
	// The same file git itself writes for a `git clone --reference` or a
	// shared submodule checkout — written directly here rather than via a
	// real clone, which also litters reflogs with the reference path and
	// would make this test about reflogs rather than about alternates. It is
	// the one relink target under .git/objects/ (mantahostels#2068 review), which the
	// leak scan must still be able to reach even though the rest of
	// .git/objects/ is skipped outright.
	const template = defineTemplate((dir) => {
		initRepo(path.join(dir, "a"));
		initRepo(path.join(dir, "b"));
		fs.mkdirSync(path.join(dir, "b", ".git", "objects", "info"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, "b", ".git", "objects", "info", "alternates"),
			`${path.join(dir, "a", ".git", "objects")}\n`,
		);
	});

	it("relinks objects/info/alternates instead of leaking the template path", () => {
		const dest = path.join(root, "copy");
		expect(() => template.instantiate(dest)).not.toThrow();
		const alternates = fs.readFileSync(
			path.join(dest, "b", ".git", "objects", "info", "alternates"),
			"utf8",
		);
		expect(alternates.trim()).toBe(path.join(dest, "a", ".git", "objects"));
		expect(
			git(path.join(dest, "b"), "log", "--oneline").trim().split("\n"),
		).toHaveLength(1);
	});
});

/* mantahostels#3149 moved every fixture root off the CI runner's shared `/tmp`, on the
 * theory something external deleted mid-copy there. It followed the move —
 * `git-fixture.ts`'s `copyTemplate` docstring has the falsification and the
 * candidate list mantahostels#3194 reopened. */
describe("the scratch base", () => {
	it("prefers the runner's own per-job temp where it is set", () => {
		expect(resolveScratchBase({ RUNNER_TEMP: "/w/_temp" }, "/repo")).toBe(
			path.join("/w/_temp", "wfc-fixtures"),
		);
	});

	it("falls back to the repo's sanctioned scratch directory off CI", () => {
		expect(resolveScratchBase({}, "/repo")).toBe(
			path.join("/repo", ".claude", "tmp", "git-fixture"),
		);
	});

	/* A relative RUNNER_TEMP would make the base depend on each caller's cwd,
	 * which the fixtures do change. */
	it("ignores a relative RUNNER_TEMP rather than joining onto it", () => {
		expect(resolveScratchBase({ RUNNER_TEMP: "_temp" }, "/repo")).toBe(
			path.join("/repo", ".claude", "tmp", "git-fixture"),
		);
	});

	it("exists, is absolute, and is its own realpath", () => {
		const base = scratchBase();
		expect(path.isAbsolute(base)).toBe(true);
		expect(fs.realpathSync(base)).toBe(base);
		expect(fs.statSync(base).isDirectory()).toBe(true);
	});

	it("is not os.tmpdir(), nor anywhere under it", () => {
		const tmp = fs.realpathSync(os.tmpdir());
		expect(scratchBase().startsWith(tmp + path.sep)).toBe(false);
		expect(scratchBase()).not.toBe(tmp);
	});

	/* WHY the regrow branch exists: the base is memoised, so a neighbour or
	 * the 24-hour reaper removing it mid-run would otherwise leave every
	 * later call ENOENTing. WHAT THIS CASE PROVES is narrower — that
	 * `mkScratchDir` recreates a base that has gone, on a private one passed
	 * in. Never the memoised base, which every other file in the run shares
	 * (mantahostels#3168). The first mint is what makes the removal
	 * load-bearing: without it the case would pass against a base that had
	 * simply never existed. */
	it("recreates the base when something has removed it", () => {
		const base = path.join(root, "base");
		expect(fs.existsSync(mkScratchDir("scratch-base-first-", base))).toBe(true);
		fs.rmSync(base, { recursive: true, force: true });
		const dir = mkScratchDir("scratch-base-regrow-", base);
		expect(path.dirname(dir)).toBe(base);
		expect(fs.statSync(dir).isDirectory()).toBe(true);
	});

	it("mints under itself, keeping the prefix", () => {
		const dir = mkScratchDir("scratch-base-probe-");
		try {
			expect(path.dirname(dir)).toBe(scratchBase());
			expect(path.basename(dir).startsWith("scratch-base-probe-")).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mkDirOutsideRepo", () => {
	it("mints on os.tmpdir(), with no .git anywhere above it", () => {
		const dir = mkDirOutsideRepo("outside-repo-probe-");
		try {
			expect(path.dirname(dir)).toBe(fs.realpathSync(os.tmpdir()));
			expect(path.basename(dir).startsWith("outside-repo-probe-")).toBe(true);
			for (let p = dir; path.dirname(p) !== p; p = path.dirname(p))
				expect(fs.existsSync(path.join(p, ".git"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	/* `git init`s its own base so "inside a repository" holds regardless of
	 * where scratchBase() lands — resolveScratchBase's RUNNER_TEMP branch put
	 * it outside every repository on CI, where this case wrongly reddened
	 * (mantahostels#3174). */
	it("refuses a base that sits inside a repository, leaving nothing behind", () => {
		const base = fs.mkdtempSync(
			path.join(fs.realpathSync(os.tmpdir()), "outside-repo-inside-"),
		);
		try {
			git(base, "init", "-q");
			expect(() => mkDirOutsideRepo("probe-", base)).toThrow(
				/sits inside a repository/,
			);
			expect(fs.readdirSync(base)).toEqual([".git"]);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
