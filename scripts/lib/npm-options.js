/** @param {string} list */
const words = (list) => list.trim().split(/\s+/);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const VALUE_FLAGS = new Set(
	words(`
--_auth --access --allow-directory
--allow-file --allow-git --allow-remote --allow-scripts --also --audit-level
--auth-type --before --browser --ca --cache --cache-max --cache-min --cafile
--call --cert --cidr --cpu --depth --diff --diff-dst-prefix --diff-src-prefix
--diff-unified --editor --expect-result-count --expires --fetch-retries
--fetch-retry-factor --fetch-retry-maxtimeout --fetch-retry-mintimeout
--fetch-timeout --git --globalconfig --heading --https-proxy --include
--init-author-email --init-author-name --init-author-url --init-license
--init-module --init-type --init-version --init.author.email
--init.author.name --init.author.url --init.license --init.module
--init.version --install-strategy --key --libc --local-address --location
--lockfile-version --loglevel --logs-dir --logs-max --maxsockets --message
--min-release-age --name --node-gyp --node-options --noproxy --omit --only
--orgs --orgs-permission --os --otp --pack-destination --package --packages
--packages-and-scopes-permission --password --prefix --preid --provenance-file
--proxy --registry --replace-registry-host --save-prefix --sbom-format
--sbom-type --scope --scopes --script-shell --searchexclude --searchlimit
--searchopts --searchstaleness --shell --tag --tag-version-prefix
--token-description --umask --user-agent --userconfig --viewer --which
--workspace --no-_auth --no-allow-scripts --no-browser --no-ca --no-cert
--no-cidr --no-cpu --no-diff --no-key --no-libc --no-name --no-node-options
--no-noproxy --no-orgs --no-os --no-otp --no-package --no-packages
--no-password --no-replace-registry-host --no-scopes --no-script-shell
--no-token-description --no-workspace
`),
);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const BOOL_FLAGS = new Set(
	words(`
--all --allow-same-version --allow-scripts-pending --allow-scripts-pin --audit
--bin-links --bypass-2fa --color --commit-hooks
--dangerously-allow-all-scripts --description --dev --diff-ignore-all-space
--diff-name-only --diff-no-prefix --diff-text --dry-run --engine-strict
--expect-results --force --foreground-scripts --format-package-lock --fund
--git-tag-version --global --global-style --if-present --ignore-scripts
--include-attestations --include-staged --include-workspace-root
--init-private --install-links --json --legacy-bundling --legacy-peer-deps
--link --long --offline --omit-lockfile-registry-resolved --optional
--package-lock --package-lock-only --packages-all --parseable --prefer-dedupe
--prefer-offline --prefer-online --production --progress --provenance
--read-only --rebuild-bundle --save --save-bundle --save-dev --save-exact
--save-optional --save-peer --save-prod --shrinkwrap --sign-git-commit
--sign-git-tag --strict-allow-scripts --strict-peer-deps --strict-ssl --timing
--unicode --update-notifier --usage --version --versions --workspaces
--workspaces-update --yes
`),
);

/**
 * @param {string} flag
 */
const boolExact = (flag) => BOOL_FLAGS.has(flag);

const isBool = (/** @type {string} */ flag) =>
	boolExact(flag.replace(/^--no-/, "--"));

const CONFIG_LIST = [...VALUE_FLAGS, ...BOOL_FLAGS]
	.filter((f) => !f.startsWith("--no-"))
	.map((f) => f.slice(2));
const CONFIGS = new Set(CONFIG_LIST);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const STRING_FLAGS = new Set(
	words(`
--call --diff-dst-prefix --diff-src-prefix --editor --git --heading
--init-author-email --init-author-name --init-license --init-type
--init.author.email --init.author.name --init.license --message
--pack-destination --preid --save-prefix --scope --searchexclude --searchopts
--shell --tag --tag-version-prefix --user-agent --viewer
`),
);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const NULLABLE = new Set(
	words(`
access also audit-level before depth expect-result-count expect-results
expires https-proxy local-address lockfile-version logs-dir min-release-age
only optional orgs-permission packages-and-scopes-permission production proxy
which workspaces yes
`),
);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const NUMERIC = new Set(
	words("depth expect-result-count expires min-release-age which"),
);

// https://github.com/npm/cli/tree/v11.16.0/workspaces/config/lib/definitions
const LITERALS = new Set(
	words(`
access:restricted access:public access:private allow-directory:all
allow-directory:none allow-directory:root allow-file:all allow-file:none
allow-file:root allow-git:all allow-git:none allow-git:root allow-remote:all
allow-remote:none allow-remote:root also:dev also:development audit-level:info
audit-level:low audit-level:moderate audit-level:high audit-level:critical
audit-level:none auth-type:legacy auth-type:web color:always include:prod
include:dev include:optional include:peer install-strategy:hoisted
install-strategy:nested install-strategy:shallow install-strategy:linked
location:global location:user location:project lockfile-version:1
lockfile-version:2 lockfile-version:3 loglevel:silent loglevel:error
loglevel:warn loglevel:notice loglevel:http loglevel:info loglevel:verbose
loglevel:silly omit:dev omit:optional omit:peer only:prod only:production
replace-registry-host:npmjs replace-registry-host:never
replace-registry-host:always sbom-format:cyclonedx sbom-format:spdx
sbom-type:library sbom-type:application sbom-type:framework
packages-and-scopes-permission:read-only packages-and-scopes-permission:read-write
packages-and-scopes-permission:no-access orgs-permission:read-only
orgs-permission:read-write orgs-permission:no-access
`),
);

// https://github.com/npm/cli/blob/v11.16.0/workspaces/config/lib/definitions/index.js
/** @type {Map<string, string>} */
const SHORTHANDS = new Map([
	["enjoy-by", "--before"],
	["d", "--loglevel info"],
	["dd", "--loglevel verbose"],
	["ddd", "--loglevel silly"],
	["quiet", "--loglevel warn"],
	["q", "--loglevel warn"],
	["s", "--loglevel silent"],
	["silent", "--loglevel silent"],
	["verbose", "--loglevel verbose"],
	["desc", "--description"],
	["help", "--usage"],
	["local", "--no-global"],
	["n", "--no-yes"],
	["no", "--no-yes"],
	["porcelain", "--parseable"],
	["readonly", "--read-only"],
	["reg", "--registry"],
	["iwr", "--include-workspace-root"],
	["ws", "--workspaces"],
	["a", "--all"],
	["c", "--call"],
	["f", "--force"],
	["g", "--global"],
	["L", "--location"],
	["l", "--long"],
	["m", "--message"],
	["p", "--parseable"],
	["C", "--prefix"],
	["S", "--save"],
	["B", "--save-bundle"],
	["D", "--save-dev"],
	["E", "--save-exact"],
	["O", "--save-optional"],
	["P", "--save-prod"],
	["?", "--usage"],
	["H", "--usage"],
	["h", "--usage"],
	["v", "--version"],
	["w", "--workspace"],
	["y", "--yes"],
]);

/**
 * @param {string} key
 * @param {Iterable<string>} candidates
 * @returns {string | null}
 */
function uniquePrefix(key, candidates) {
	if (!key) return null;
	const all = [...candidates];
	if (all.includes(key)) return key;
	const hits = all.filter((c) => c.startsWith(key));
	return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * @param {string} key
 * @returns {string[] | null}
 */
function shorthandExact(key) {
	const exp = /^[A-Za-z0-9?.-]+$/.test(key) ? SHORTHANDS.get(key) : undefined;
	return exp === undefined ? null : words(exp);
}

/**
 * @param {string} key
 * @returns {string[] | null}
 */
function shorthand(key) {
	if (key && CONFIGS.has(key)) return null;
	const exact = shorthandExact(key);
	if (exact !== null) return exact;
	/** @type {string[]} */
	const run = [];
	let i = 0;
	for (; i < key.length; i++) {
		const one = key.charAt(i);
		const exp = /[A-Za-z?]/.test(one) ? SHORTHANDS.get(one) : undefined;
		if (exp === undefined) break;
		run.push(...words(exp));
	}
	if (i === key.length) return run;
	if (uniquePrefix(key, CONFIG_LIST) !== null) return null;
	const hit = uniquePrefix(key, SHORTHANDS.keys());
	return hit === null ? null : words(SHORTHANDS.get(hit) ?? "");
}

/**
 * Whether `next` is a number to JavaScript's `isNaN`, as nopt asks.
 * @param {string} next
 */
const isNumber = (next) => {
	const w = next.trim();
	return (
		!w ||
		/^[+-]?(Infinity|([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?)$/.test(
			w,
		) ||
		/^0([xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$/.test(w)
	);
};

/**
 * @param {"value" | "bool"} kind
 * @param {string} flag
 * @param {string} next
 */
function takes(kind, flag, next) {
	const base = flag.replace(/^--/, "").replace(/^no-/, "");
	if (kind === "value") {
		if (/^--+$/.test(next)) return false;
		if (!STRING_FLAGS.has(flag)) return true;
		return !/^--?[^-]/.test(next);
	}
	if (next === "true" || next === "false") return true;
	if (LITERALS.has(`${base}:${next}`)) return true;
	if (next === "null" && NULLABLE.has(base)) return true;
	if (NUMERIC.has(base) && !/^--+[^-]/.test(next) && isNumber(next))
		return true;
	return VALUE_FLAGS.has(`--no-${base}`) && !/^-[^-]/.test(next);
}

/**
 * @param {string[]} argv
 * @returns {string[]}
 */
const npmCanon = (argv) =>
	canonFrom(argv.map((value) => ({ value }))).map(({ value }) => value);

/**
 * @template {{value: string}} W
 * @param {W[]} argv
 * @returns {{value: string, from: W}[]}
 */
function canonFrom(argv) {
	const args = argv.map((from) => ({ value: from.value, from }));
	/** @type {typeof args} */
	const canon = [];
	for (let a = args.shift(); a !== undefined; a = args.shift()) {
		if (/^--+$/.test(a.value))
			return [...canon, { value: "--", from: a.from }, ...args];
		if (/^-./s.test(a.value)) canonOption(a, args, canon);
		else canon.push(a);
	}
	return canon;
}

/**
 * @template W
 * @param {{value: string, from: W}} option
 * @param {{value: string, from: W}[]} args
 * @param {{value: string, from: W}[]} canon
 */
function canonOption({ value: word, from }, args, canon) {
	const eqAt = word.indexOf("=");
	const eq = eqAt >= 0;
	const val = eq ? word.slice(eqAt + 1) : "";
	const key = (eq ? word.slice(0, eqAt) : word).replace(/^-+/, "");
	const exp = shorthand(key);
	const fromThisWord = (/** @type {string} */ value) => ({ value, from });
	if (exp !== null) {
		args.unshift(...[...exp, ...(eq ? [val] : [])].map(fromThisWord));
		return;
	}
	const { flag, kind } = optionOf(key, eq);
	if (eq) args.unshift(fromThisWord(val));
	const next = args[0];
	if (next !== undefined && takes(kind, flag, next.value)) {
		canon.push(fromThisWord(`${flag}=${next.value}`));
		args.shift();
	} else canon.push(fromThisWord(kind === "value" ? `${flag}=` : flag));
}

/**
 * @param {string} given
 * @param {boolean} eq
 * @returns {{ flag: string, kind: "value" | "bool" }}
 */
function optionOf(given, eq) {
	let key = given;
	let no = 0;
	while (key.toLowerCase().startsWith("no-")) {
		no++;
		key = key.slice(3);
	}
	key = uniquePrefix(key, CONFIG_LIST) ?? key;
	const negated = no % 2 === 1 || (no > 0 && !isBool(`--${key}`));
	const flag = negated ? `--no-${key}` : `--${key}`;
	const bool =
		no > 0 ||
		isBool(flag) ||
		flag === "--browser" ||
		(!eq && !CONFIGS.has(key));
	return { flag, kind: bool ? "bool" : "value" };
}

/**
 * @template {{value: string}} W
 * @param {W[]} argv
 * @returns {{options: string[], operands: {value: string, from: W}[]}}
 */
function parseNpmArgv(argv) {
	const canon = canonFrom(argv);
	const cut = canon.findIndex(({ value }) => value === "--");
	const before = cut < 0 ? canon : canon.slice(0, cut);
	return {
		options: before.filter(isOption).map(({ value }) => value),
		operands: [
			...before.filter((c) => !isOption(c)),
			...(cut < 0 ? [] : canon.slice(cut + 1)),
		],
	};
}

/** @param {{value: string}} canon */
const isOption = ({ value }) => value.startsWith("-");

/**
 * @param {string} word
 */
function isNpmRun(word) {
	const kebab = word.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
	return (
		["run", "rum", "urn", "ur"].includes(kebab) ||
		(kebab.startsWith("run-") && "run-script".startsWith(kebab))
	);
}

// https://github.com/npm/cli/blob/v11.16.0/lib/utils/cmd-list.js
const SCRIPT_COMMANDS = new Map(
	Object.entries({
		t: "test",
		ts: "test",
		tst: "test",
		tes: "test",
		test: "test",
		start: "start",
		sto: "stop",
		stop: "stop",
		res: "restart",
		rest: "restart",
		resta: "restart",
		restar: "restart",
		restart: "restart",
	}),
);

/**
 * @param {string} word
 */
const scriptOfNpmCommand = (word) => SCRIPT_COMMANDS.get(word);

// https://github.com/npm/cli/blob/v11.16.0/lib/utils/cmd-list.js
const TREE_COMMANDS = new Map(
	Object.entries({
		install: "add i in ins inst insta instal install isnt isnta isntal isntall",
		ci: "ci clean-install ic install-cl install-cle install-clea install-clean isntall- isntall-c isntall-cl isntall-cle isntall-clea isntall-clean",
		"install-test": "install-t install-te install-tes install-test it",
		"install-ci-test":
			"cit clean-install- clean-install-t clean-install-te clean-install-tes clean-install-test install-ci install-ci- install-ci-t install-ci-te install-ci-tes install-ci-test si sit",
		uninstall:
			"r rem remo remov remove rm un uni unin unins uninst uninsta uninstal uninstall unl unli unlin unlink",
		update:
			"u ud udp udpa udpat udpate up upd upda updat update upg upgr upgra upgrad upgrade",
		dedupe: "dd ddp ded dedu dedup dedupe",
		prune: "pru prun prune",
		rebuild: "rb reb rebu rebui rebuil rebuild",
		link: "lin link ln",
		audit: "aud audi audit",
	}).flatMap(([command, list]) => words(list).map((w) => [w, command])),
);

/**
 * @param {string} word
 */
const treeCommandOf = (word) =>
	TREE_COMMANDS.get(word.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

module.exports = {
	boolExact,
	isNpmRun,
	npmCanon,
	parseNpmArgv,
	scriptOfNpmCommand,
	shorthandExact,
	treeCommandOf,
};
