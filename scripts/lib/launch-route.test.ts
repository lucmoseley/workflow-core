// @vitest-environment node
/*
 * launch-route.test.ts — whether a run-vitest.js launch is full-shaped
 * (`isFullRunArgv`), where it runs and what it selects from (`launchRoute`, one
 * table over argv and session id, #1498), and which runner flag npm swallowed
 * (`npmSwallowedRefusal`, #2284). Called in process: the route is a pure
 * function of argv and id, which the program's own tests reach only through a
 * whole suite launch (#1633). Break it and a session's narrowed run reads a
 * neighbour's half-written tree, a full run skips its frozen worktree, or a
 * flag npm swallowed is dropped from the launch unrefused.
 */

import { describe, expect, it } from "vitest";

const {
	isFullRunArgv,
	isTouchedRun,
	launchRoute,
	npmSwallowedRefusal,
} = require("./launch-route.js");

describe("`launchRoute`, the one place a launch's route is decided (#1498)", () => {
	/* argv, session id, then `kind tree/fallback escalation source`. */
	it.each([
		["", null, "bare shared/shared worktree diff"],
		["", "s", "bare overlay/shared worktree own"],
		["--shared", "s", "bare shared/shared shared diff"],
		["--isolated", null, "bare worktree/worktree worktree diff"],
		["--isolated", "s", "bare overlay/worktree worktree own"],
		["--isolated --shared", "s", "bare shared/shared shared diff"],
		["--changed", null, "changed shared/shared - changed"],
		["--changed", "s", "changed overlay/shared - own"],
		["--changed --shared", "s", "changed shared/shared - changed"],
		["--changed --isolated", null, "changed worktree/worktree - changed"],
		["--changed --isolated", "s", "changed worktree/worktree - changed"],
		["--changed HEAD", "s", "changed shared/shared - changed"],
		["--changed=HEAD --isolated", "s", "changed worktree/worktree - changed"],
		["--changed -t x", "s", "changed shared/shared - changed"],
		["a.test.ts", "s", "named shared/shared - named"],
		["-t corpus", null, "named shared/shared - named"],
		["-t corpus --isolated", null, "named worktree/worktree - named"],
		["-t corpus --isolated --shared", null, "named shared/shared - named"],
		["--adopt docs/a.md", "s", "named shared/shared - adopt"],
		["--full=coverage", null, "full worktree/worktree - full"],
		["--full=coverage", "s", "full worktree/worktree - full"],
		["--full=coverage --shared", "s", "full shared/shared - full"],
		["--full=coverage --changed", "s", "full worktree/worktree - changed"],
		["--full=coverage a.test.ts", null, "full worktree/worktree - named"],
	] as const)(
		"routes `%s` with session %s to %s",
		(argv, sessionId, expected) => {
			const words = argv ? argv.split(" ") : [];
			const route = launchRoute([...words, "--queue"], sessionId);
			expect(
				`${route.kind} ${route.tree}/${route.fallback} ${route.escalation ?? "-"} ${route.source}`,
			).toBe(expected);
			expect(route.rest).toEqual(
				words.filter(
					(w) =>
						w !== "--shared" && w !== "--isolated" && !w.startsWith("--full="),
				),
			);
			expect(route.sessionId).toBe(sessionId);
		},
	);

	it.each([
		["", null, "touched shared/shared - diff"],
		["", "s", "touched overlay/shared - own"],
		["--shared", "s", "touched shared/shared - diff"],
		["--isolated", "s", "touched overlay/worktree - own"],
		["--retest a.test.ts", "s", "named overlay/shared - retest"],
		["a.test.ts", "s", "named shared/shared - named"],
		["--changed", "s", "changed overlay/shared - own"],
		["--full=coverage", "s", "full worktree/worktree - full"],
	] as const)(
		"under `landing`, routes `%s` with session %s to %s (#2930)",
		(argv, sessionId, expected) => {
			const words = argv ? argv.split(" ") : [];
			const route = launchRoute(words, sessionId, { landing: true });
			expect(
				`${route.kind} ${route.tree}/${route.fallback} ${route.escalation ?? "-"} ${route.source}`,
			).toBe(expected);
		},
	);

	it("reads an empty id as no session, which is what the suite stubs", () => {
		expect(launchRoute([], "")).toMatchObject({
			tree: "shared",
			sessionId: null,
		});
	});
});

describe("`isTouchedRun`, a run that never takes the whole-suite slot (#2935)", () => {
	const named200 = Array.from({ length: 200 }, (_, i) => `t${i}.test.ts`);
	it.each([
		["", true, true],
		["", false, false],
		["--retest a.test.ts", false, true],
		["a.test.ts b.test.ts", false, true],
		["--isolated a.test.ts", false, true],
		["--changed", true, false],
		["--changed a.test.ts", true, false],
		["--adopt lib/a.js", true, false],
		["--full=flag", true, false],
	])("`%s` with landing %s is touched: %s", (argv, landing, touched) => {
		const words = argv ? argv.split(" ") : [];
		expect(isTouchedRun(launchRoute(words, "s", { landing }))).toBe(touched);
	});

	it("reads a 200-file named run as touched", () => {
		expect(isTouchedRun(launchRoute(named200, null))).toBe(true);
	});
});

describe("`isFullRunArgv`, which decides mantahostels#2278's default", () => {
	it("is true on an empty argv — the ordinary `npm run test`", () => {
		expect(isFullRunArgv([])).toBe(true);
	});

	it("is false where --changed is present, in either spelling", () => {
		expect(isFullRunArgv(["--changed"])).toBe(false);
		expect(isFullRunArgv(["--changed", "HEAD~1"])).toBe(false);
		expect(isFullRunArgv(["--changed=HEAD~1"])).toBe(false);
	});

	it("is false where a name filter is present, in either spelling", () => {
		expect(isFullRunArgv(["-t", "corpus"])).toBe(false);
		expect(isFullRunArgv(["--testNamePattern", "corpus"])).toBe(false);
		expect(isFullRunArgv(["--testNamePattern=corpus"])).toBe(false);
	});

	it("is false where a test file is named", () => {
		expect(isFullRunArgv(["scripts/run-vitest.test.ts"])).toBe(false);
		expect(isFullRunArgv(["scripts/foo.spec.tsx"])).toBe(false);
	});

	it("is still true where argv carries a flag whose value is not test-file-shaped", () => {
		expect(isFullRunArgv(["--reporter", "dot"])).toBe(true);
	});

	it("is true on --full alone (mantahostels#3206)", () => {
		expect(isFullRunArgv(["--full"])).toBe(true);
	});

	it("is false on an `--adopt` run, so bare argv's narrowed default never takes it (#1213)", () => {
		expect(isFullRunArgv(["--adopt", "lib/a.js"])).toBe(false);
	});
});

describe("`npmSwallowedRefusal`, a runner flag npm took as its own config (#2284)", () => {
	const testScript = {
		npm_lifecycle_event: "test",
		npm_lifecycle_script:
			"NODE_OPTIONS=--max-old-space-size=2048 node scripts/run-vitest.js",
	};
	const changedScript = {
		npm_lifecycle_event: "test:changed",
		npm_lifecycle_script: "node scripts/run-vitest.js --changed",
	};

	it.each([
		[
			"--queue",
			[],
			{ ...testScript, npm_config_queue: "true" },
			"npm run test -- --queue",
		],
		[
			"test:changed's --queue",
			["--changed"],
			{ ...changedScript, npm_config_queue: "true" },
			"npm run test:changed -- --queue",
		],
		[
			"--changed's value, landed as a positional",
			["HEAD~1"],
			{ ...testScript, npm_config_changed: "true" },
			"npm run test -- --changed HEAD~1",
		],
		[
			"--retest's file",
			["a.test.ts"],
			{ ...testScript, npm_config_retest: "true" },
			"npm run test -- --retest a.test.ts",
		],
		[
			"--adopt's path",
			["docs/a.md"],
			{ ...testScript, npm_config_adopt: "true" },
			"npm run test -- --adopt docs/a.md",
		],
		[
			"--full=<cause>, kept as npm's value",
			[],
			{ ...testScript, npm_config_full: "flake" },
			"npm run test -- --full=flake",
		],
		[
			"two flags at once",
			["a.test.ts"],
			{ ...testScript, npm_config_queue: "true", npm_config_isolated: "true" },
			"npm run test -- --queue --isolated a.test.ts",
		],
		[
			"two flags that take words, whose order npm lost",
			["HEAD~1", "a.test.ts"],
			{ ...testScript, npm_config_changed: "true", npm_config_retest: "true" },
			"npm run test -- --changed <its words> --retest <its words>",
		],
	])("names the command that passes %s", (_, argv, env, command) => {
		const refusal = npmSwallowedRefusal(argv, env);
		expect(refusal).toContain(`\n  ${command}\n`);
		expect(refusal).toContain("Nothing ran");
	});

	it("is null where npm swallowed none, whatever argv carries", () => {
		expect(
			npmSwallowedRefusal(["--queue", "--changed"], testScript),
		).toBeNull();
	});

	it("names `npm run test` where no npm script launched it", () => {
		expect(npmSwallowedRefusal([], { npm_config_queue: "true" })).toContain(
			"\n  npm run test -- --queue\n",
		);
	});

	it("lists the words npm passed with no flag where their order is lost", () => {
		const refusal = npmSwallowedRefusal(["HEAD~1", "a.test.ts"], {
			...testScript,
			npm_config_changed: "true",
			npm_config_retest: "true",
		});
		expect(refusal).toContain("npm passed HEAD~1 a.test.ts with no flag");
	});
});
