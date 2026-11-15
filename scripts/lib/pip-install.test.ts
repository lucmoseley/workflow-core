// @vitest-environment node
/*
 * lib/pip-install.js, the guard-pip-install core (#5232), in process: the
 * Python install boundary, the twin of lib/npm-install.js's checks 1 and 2.
 *
 * The floors are lib/package-vetting.js's.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE DISK.
 */

import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import {
	buildPassingPyPI,
	type Get,
	type PyPI,
	pypiAnswer,
	statsAnswer,
} from "./pypi-registry-fake";
import { readRuleText } from "./rule-text";

const { decide } = require("./pip-install.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const RULE = readRuleText("new-package-vetted");
const ESCAPE = `The escape is \`WFC_ALLOW_NEW_PACKAGE=1\` in the environment Claude Code itself
was started in — NOT on this command line, which is read but never honoured: ${readRuleText("self-spelt-escape")} Otherwise ask the
founder to run the install from their own terminal, which sees no hook.`;

const PYPROJECT = `[project]
name = "the-repo"
dependencies = [
  "httpx>=0.27",  # a comment, "not-a-dep"
  'Jinja2[i18n] ~= 3.1',
]

[project.optional-dependencies]
docs = ["mkdocs"]

[dependency-groups]
dev = [{ include-group = "lint" }, "pytest-cov>=5"]
lint = ["ruff==0.16.4"]

[tool.other]
dependencies = ["not-declared"]
`;

const REQUIREMENTS = `# pinned
requests==2.32.3 \\
    --hash=sha256:abc
-r other.txt
-e ./local
git+https://example.com/x.git#egg=from-git
Pillow>=10 ; python_version >= "3.9"
`;

const FILES: Record<string, string> = {
	"pyproject.toml": PYPROJECT,
	"requirements.txt": REQUIREMENTS,
	"requirements/dev.in": "pytest\n",
};

interface Over {
	files?: Record<string, string | Error>;
	/** git's answer; null where it fails. */
	listed?: string[] | null;
	allow?: boolean;
	now?: () => number;
}

function harness(reg: Partial<PyPI> = {}, over: Over = {}) {
	const logs: string[] = [];
	const calls: string[] = [];
	const full = { ...buildPassingPyPI(NOW), ...reg };
	const files = over.files ?? FILES;
	const ctx = kitContextFake({
		log: (what: string) => logs.push(what),
		tree: () => ({
			root: "/repo",
			git: (args: string[]) => {
				calls.push(`git ${args.join(" ")}`);
				const listed =
					over.listed === undefined ? Object.keys(files) : over.listed;
				return listed === null
					? { ok: false, why: "not a git repository" }
					: { ok: true, out: listed.map((f) => `${f}\0`).join("") };
			},
			readText: (rel: string) => {
				const got = files[rel];
				if (got instanceof Error) throw got;
				return got ?? null;
			},
			repoRel: (f: string) => f,
		}),
		pypi: (name: string): Get => {
			calls.push(`pypi ${name}`);
			return pypiAnswer(full);
		},
		stats: (name: string): Get => {
			calls.push(`stats ${name}`);
			return statsAnswer(full);
		},
		now: over.now ?? (() => NOW),
		startedAt: () => NOW,
		allowNewPackage: over.allow ?? false,
	});
	return { ctx, logs, calls };
}

const denial = (
	command: string,
	reg: Partial<PyPI> = {},
	over: Over = {},
): string | null => decide(command, harness(reg, over).ctx)?.deny ?? null;

const allows = (command: string, reg: Partial<PyPI> = {}, over: Over = {}) =>
	denial(command, reg, over) === null;

const callsOf = (command: string, reg: Partial<PyPI> = {}, over: Over = {}) => {
	const h = harness(reg, over);
	decide(command, h.ctx);
	return h.calls.filter((c) => !c.startsWith("git "));
};

const BIN = "--only-binary :all:";

describe("what it does not judge", () => {
	it.each([
		"pip install",
		"pip install -r requirements.txt",
		"pip3 install --require-hashes -r requirements-dev.txt",
		"python3 -m pip install -r requirements.txt -c constraints.txt",
		"pip install --group dev",
		"pip list",
		"pip download left-pad",
		"pip install --help left-pad",
		"python3 -m pip --version",
		"python3 -m venv .venv",
		"python3 setup.py install left-pad",
		"python3 -c 'import pip' -m pip install left-pad",
		"uv sync",
		"uv run pytest",
		"uv pip sync requirements.txt",
		"uv pip compile requirements.in",
		"uvx ruff check",
		"pipx install left-pad",
		"echo pip install left-pad",
		"grep 'pip install left-pad' README.md",
	])("allows `%s`", (command) => {
		expect(allows(command, { created: "404" })).toBe(true);
	});

	it.each([
		// Declared in requirements.txt, read through its hash continuation.
		"pip install requests",
		// PEP 503: case, `_` and `.` fold into one name.
		"pip install PILLOW",
		"pip install 'jinja2>=3'",
		"pip install JINJA2",
		// pyproject.toml's three tables.
		"pip install httpx mkdocs ruff",
		"uv add 'pytest-cov[toml]>=5'",
		// requirements/dev.in, which git's pathspec reaches.
		"uv pip install pytest",
	])("allows a declared package: `%s`", (command) => {
		expect(allows(command, { created: "404" })).toBe(true);
	});

	const Inline = {
		"pyproject.toml": `dependency-groups = { lint = ["ruff"] }

[project]
name = "the-repo"
optional-dependencies = { docs = ["mkdocs", { x = "not-a-dep" }], "themes" = [
  "pydata-sphinx-theme",  # a comment
] }
`,
	};

	it("allows a package declared in an inline `optional-dependencies` or `dependency-groups` table (#5238)", () => {
		expect(
			allows(
				"pip install mkdocs pydata-sphinx-theme ruff",
				{ created: "404" },
				{ files: Inline },
			),
		).toBe(true);
	});

	it("does not read a string in an inline table nested in that table's array as declared (#5238)", () => {
		expect(denial("pip install not-a-dep", {}, { files: Inline })).toMatch(
			/does not yet declare/,
		);
	});

	it.each([
		[
			"a quoted dotted key, which is one key",
			`"project.optional-dependencies" = { docs = ["evil"] }\n`,
		],
		[
			"a key under an array of tables",
			`[[tool.foo]]\ndependency-groups = { a = ["evil"] }\n`,
		],
		[
			"an inline table a header breaks into",
			`[project]\noptional-dependencies = { docs = ["a"]\n[dependency-groups]\nb = ["c"]\n[tool.x]\nfoo = ["evil"]\n`,
		],
		["a nested array", `[project.optional-dependencies]\ndocs = [["evil"]]\n`],
		["an array that never closes", `[project]\ndependencies = ["evil"\n`],
	])("does not read %s as declared (#5238)", (_what, pyproject) => {
		const files = { "pyproject.toml": pyproject };
		expect(denial("pip install evil", {}, { files })).toMatch(
			/does not yet declare/,
		);
	});

	it("reads the header an unclosed inline table runs into (#5238)", () => {
		const files = {
			"pyproject.toml": `[project]\noptional-dependencies = { docs = ["a"]\n[dependency-groups]\nb = ["c"]\n`,
		};
		expect(allows("pip install c", { created: "404" }, { files })).toBe(true);
	});

	it.each([
		"pip install not-a-dep",
		"pip install not-declared",
		"pip install lint",
		"pip install from-git",
	])(
		"does not read a comment, another table, a group include or a URL line as declared: `%s`",
		(command) => {
			expect(denial(command)).toMatch(/does not yet declare/);
		},
	);
});

describe("check 1 — the build window", () => {
	it("refuses a new package without --only-binary :all:, in full", () => {
		expect(denial("pip install left-pad")).toBe(
			`This install adds 1 package(s) this repo does not yet declare — left-pad — and does not carry \`--only-binary :all:\`: pip install left-pad

Without it, a package published as a source distribution runs its own build code — \`setup.py\` or its build backend — as you, before anything reads a byte of it. A wheel runs nothing at install.

Re-run with \`--only-binary :all:\`. A package that publishes no wheel then fails to install, and whether to build it from source is the founder's call.

Then declare it in the repo's requirements or \`pyproject.toml\`.

${RULE}`,
		);
	});

	it("asks nothing of PyPI before it refuses", () => {
		expect(callsOf("pip install left-pad")).toEqual([]);
	});

	it.each([
		["uv add left-pad", "--no-build"],
		["uv pip install left-pad", "--no-build"],
		["python3 -m pip install left-pad", BIN],
		["python3.12 -Im pip install left-pad", BIN],
		[".venv/bin/pip3.12 install left-pad", BIN],
	])("names the flag that shuts it: `%s`", (command, flag) => {
		expect(denial(command)).toContain(`does not carry \`${flag}\`:`);
	});

	it.each([
		`pip install ${BIN} left-pad`,
		"pip install --only-binary=:all: left-pad",
		"pip install --only-binary :all:,numpy left-pad",
		"uv add --no-build left-pad",
		"uv pip install --no-build left-pad",
		`uv pip install ${BIN} left-pad`,
		`python3 -m pip install ${BIN} left-pad`,
	])("passes the window shut: `%s`", (command) => {
		expect(allows(command)).toBe(true);
	});

	it.each([
		`pip install ${BIN} --only-binary :none: left-pad`,
		`pip install ${BIN} --no-binary left-pad left-pad`,
		"pip install --only-binary numpy left-pad",
		"pip install --only-bin :all: left-pad",
		"uv add --only-binary :all: left-pad",
		"uv add --no-build --no-binary left-pad",
	])("refuses the window reopened or never shut: `%s`", (command) => {
		expect(denial(command)).toMatch(/does not carry/);
	});

	it("counts an unvettable spec, and names every new one", () => {
		expect(denial("pip install left-pad ./local -e ../other")).toMatch(
			/^This install adds 3 package\(s\) this repo does not yet declare — left-pad \.\/local \.\.\/other —/,
		);
	});

	it("names each new package once", () => {
		expect(denial("pip install left-pad Left_Pad")).toMatch(
			/adds 1 package\(s\)/,
		);
	});

	it("reads a value-taking option's value as no spec", () => {
		expect(
			allows(
				"pip install -i https://example.com/simple -r requirements.txt --target out requests",
			),
		).toBe(true);
		expect(allows("uv add --group dev --optional docs mkdocs")).toBe(true);
		expect(allows("pip install --local-log out.log requests")).toBe(true);
		expect(
			allows("uv pip install --no-build --no-install-package x requests"),
		).toBe(true);
	});

	it.each([
		["uv add --no-build --no-binary left-pad", "left-pad"],
		["uv add --no-build --editable ./evil", "./evil"],
	])(
		"reads `uv add`'s plain flags as taking no value: `%s`",
		(command, spec) => {
			expect(denial(command)).toContain(spec);
		},
	);
});

describe("check 2 — new-package legitimacy", () => {
	const install = `pip install ${BIN} left-pad`;

	it("asks PyPI and pypistats for the PEP 503 name", () => {
		expect(callsOf(`pip install ${BIN} Left_Pad.Py==1.0`)).toEqual([
			"pypi left-pad-py",
			"stats left-pad-py",
		]);
	});

	it("refuses a name PyPI does not hold, carrying the rule whole", () => {
		expect(denial(install, { created: "404" })).toBe(
			`No package named \`left-pad\` exists on PyPI: ${install}

That is the shape of a hallucinated name. Roughly one in five package references generated by a code model does not exist (Spracklen et al., USENIX Security 2025), and 43% of those names recur across re-runs — which is what makes pre-registering them worth an attacker's time. Check the name against the tool's own documentation before trying again.

${RULE}`,
		);
	});

	it("refuses a name with no file uploaded as missing", () => {
		expect(
			denial(install, {
				pypiOut: { code: 200, body: JSON.stringify({ releases: { "1": [] } }) },
			}),
		).toMatch(/^No package named `left-pad` exists on PyPI/);
	});

	it("dates a package by its earliest upload, not its latest", () => {
		expect(allows(install, { created: daysAgo(400) })).toBe(true);
	});

	it("refuses a package under the age floor, in full", () => {
		expect(denial(install, { created: daysAgo(179) })).toBe(
			`\`left-pad\` was first published 179 days ago, under this guard's 180-day floor: ${install}

A squat registered against a hallucinated name is days old. A genuinely new package that this project needs is a founder decision, not a session's.

${RULE}

${ESCAPE}`,
		);
		expect(allows(install, { created: daysAgo(180) })).toBe(true);
	});

	it("asks no downloads of a package too young to pass", () => {
		expect(callsOf(install, { created: daysAgo(10) })).toEqual([
			"pypi left-pad",
		]);
	});

	it("refuses thin download history, and passes the floor", () => {
		expect(denial(install, { downloads: 999 })).toMatch(
			/^`left-pad` was downloaded 999 time\(s\) last month, under this guard's floor of 1000:/,
		);
		expect(allows(install, { downloads: 1000 })).toBe(true);
	});

	it("reads a name pypistats has no record of as no downloads", () => {
		expect(denial(install, { downloads: "404" })).toMatch(
			/was downloaded 0 time\(s\) last month/,
		);
	});

	it.each([
		["PyPI unanswered", { created: "FAIL" }],
		["pypistats unanswered", { downloads: "FAIL" }],
		["PyPI erroring", { pypiOut: { code: 503, body: "" } }],
		["PyPI's JSON not JSON", { pypiOut: { code: 200, body: "<html>" } }],
		[
			"an upload time not a date",
			{
				pypiOut: {
					code: 200,
					body: JSON.stringify({
						releases: { "1": [{ upload_time_iso_8601: "soon" }] },
					}),
				},
			},
		],
	] as const)("refuses on %s, in full", (_who, reg) => {
		expect(denial(install, reg as Partial<PyPI>)).toBe(
			`PyPI could not be reached to check \`left-pad\`, so this install proceeds on nothing: ${install}

An install whose name, age and download history went unchecked is what this guard exists to prevent, so an unreachable registry refuses rather than waving it through (mantahostels#1767).

${RULE}

${ESCAPE}`,
		);
	});

	it("refuses and logs where curl will not start", () => {
		const h = harness({ created: "MISSING" });
		expect(decide(install, h.ctx)?.deny).toMatch(/^PyPI could not be reached/);
		expect(h.logs).toEqual([
			"curl not found — legitimacy of left-pad could not be checked, denying",
		]);
	});

	it.each([
		"git+https://github.com/x/y.git",
		"https://example.com/left_pad-1.0.tar.gz",
		"./dist/left_pad-1.0-py3-none-any.whl",
		"left_pad-1.0-py3-none-any.whl",
		"left-pad @ https://example.com/l.zip",
		"/abs/path",
		"../sibling",
	])("refuses the unvettable spec `%s`, in full", (spec) => {
		/* The refusal echoes the command with its quoted span masked. */
		expect(denial(`pip install ${BIN} '${spec}'`)).toBe(
			`This install names a spec the registry cannot be asked about, so its legitimacy is unverifiable: \`${spec}\`

pip install ${BIN} "…"

A local path, a wheel or sdist file, a VCS or other URL and a \`name @ url\` direct reference all bypass the checks this guard runs on a new package — that the name exists, its age, its download history. None of them can be answered for a spec that never touches the registry.

${RULE}

${ESCAPE}`,
		);
	});

	it("refuses an editable install of a path", () => {
		expect(denial(`pip install ${BIN} -e .`)).toMatch(
			/cannot be asked about, so its legitimacy is unverifiable: `\.`/,
		);
	});

	it("refuses a package the budget ran out before", () => {
		let t = NOW;
		const now = () => {
			const at = t;
			t += 16_000;
			return at;
		};
		expect(denial(`pip install ${BIN} aaa bbb`, {}, { now })).toMatch(
			/^This guard ran out of its own time budget before it could check `bbb`/,
		);
	});

	it("judges each command of a compound one", () => {
		expect(
			denial(`cd /tmp && pip install ${BIN} requests && pip install x-y`),
		).toMatch(/— x-y — and does not carry/);
	});
});

describe("the escape", () => {
	it("stands down check 2 alone", () => {
		expect(
			allows(
				`pip install ${BIN} left-pad`,
				{ created: "404" },
				{ allow: true },
			),
		).toBe(true);
		expect(allows(`pip install ${BIN} ./local`, {}, { allow: true })).toBe(
			true,
		);
		expect(denial("pip install left-pad", {}, { allow: true })).toMatch(
			/does not carry/,
		);
	});

	it("is not honoured on the command line", () => {
		expect(
			denial(`WFC_ALLOW_NEW_PACKAGE=1 pip install ${BIN} left-pad`, {
				created: "404",
			}),
		).toMatch(/^No package named `left-pad` exists on PyPI/);
	});
});

describe("the declaring files", () => {
	it("reads the root's three files where git does not answer, saying so", () => {
		const h = harness({ created: "404" }, { listed: null });
		expect(decide("pip install requests httpx", h.ctx)).toBeNull();
		expect(decide("uv pip install pytest", h.ctx)?.deny).toMatch(
			/does not yet declare — pytest/,
		);
		expect(h.logs[0]).toMatch(
			/^git ls-files did not answer \(not a git repository\)/,
		);
	});

	it("vets a file's packages as new where it will not read, saying so", () => {
		const h = harness(
			{},
			{ files: { ...FILES, "requirements.txt": new Error("EACCES") } },
		);
		expect(decide("pip install requests", h.ctx)?.deny).toMatch(
			/does not yet declare — requests/,
		);
		expect(h.logs).toEqual([
			"requirements.txt did not read — its packages are vetted as new",
		]);
	});

	it("lists the declaring files once a command, and only for an install naming a package", () => {
		const h = harness();
		decide(`pip install ${BIN} a && pip install ${BIN} b`, h.ctx);
		decide("pip install -r requirements.txt", h.ctx);
		expect(h.calls.filter((c) => c.startsWith("git ")).length).toBe(1);
	});
});
