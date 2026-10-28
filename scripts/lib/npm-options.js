/*
 * npm-options.js — npm's option parser, `npmCanon`, read against npm 11.16.0's
 * config list (#563, #571), with the exact-match lookups npx makes instead,
 * `shorthandExact` and `boolExact` (#1972). lib/suite-concurrency.js reads with
 * it whether `npm … run <name>` launches a build or a dev server, and
 * lib/npm-install.js the install and the npx argv it judges.
 *
 * A config a later npm adds is read as a name npm does not know.
 */

/** @param {string} list */
const words = (list) => list.trim().split(/\s+/);

/* Every npm config that takes the next word as its value. Derived from npm
 * 11.16.0's `@npmcli/config` definitions — each config whose type lacks
 * Boolean, plus `--browser`, which also takes a String — and the `--no-` form
 * of each whose type is a list holding String, which npm still hands a word. */
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

/* npm 11.16.0's Boolean configs. */
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
 * Whether `flag` is a Boolean config matched whole, as npx matches it
 * (#1972).
 * @param {string} flag
 */
const boolExact = (flag) => BOOL_FLAGS.has(flag);

/* A `--no-` form read as its config, as npm reads it. */
const isBool = (/** @type {string} */ flag) =>
	boolExact(flag.replace(/^--no-/, "--"));

/* Every config name, which an abbreviation resolves against. */
const CONFIG_LIST = [...VALUE_FLAGS, ...BOOL_FLAGS]
	.filter((f) => !f.startsWith("--no-"))
	.map((f) => f.slice(2));
const CONFIGS = new Set(CONFIG_LIST);

/* npm 11.16.0's String configs, which refuse a next word that looks like an
 * option — `--tag --no-ignore-scripts` leaves the flag an option. Every other
 * value config takes any word but a bare `--`, except `--browser` and the
 * `--no-` forms, which take `--` too but never a single-dash word. */
const STRING_FLAGS = new Set(
	words(`
--call --diff-dst-prefix --diff-src-prefix --editor --git --heading
--init-author-email --init-author-name --init-license --init-type
--init.author.email --init.author.name --init.license --message
--pack-destination --preid --save-prefix --scope --searchexclude --searchopts
--shell --tag --tag-version-prefix --user-agent --viewer
`),
);

/* npm 11.16.0's configs whose list type takes `null` but no String, which npm
 * reads as their value after `--no-<config>` and, for the Boolean ones, after
 * `--<config>` too. */
const NULLABLE = new Set(
	words(`
access also audit-level before depth expect-result-count expect-results
expires https-proxy local-address lockfile-version logs-dir min-release-age
only optional orgs-permission packages-and-scopes-permission production proxy
which workspaces yes
`),
);

/* npm 11.16.0's configs whose list type takes a Number, read the same way. */
const NUMERIC = new Set(
	words("depth expect-result-count expires min-release-age which"),
);

/* npm 11.16.0's literal list-type values, as <config>:<value>, read the same
 * way. `local-address` lists this machine's interfaces and is left out. */
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

/* npm 11.16.0's CLI shorthands and what each expands to (`@npmcli/config`'s
 * definitions). A one-letter key may also be glued into a run, as `-DE`. */
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
 * The one candidate `key` names: itself where it is one, else the only
 * candidate it prefixes — npm's `abbrev`.
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
 * What a dash-stripped `key` expands to where it is itself a shorthand, else
 * null — the only lookup npx makes (#1972).
 * @param {string} key
 * @returns {string[] | null}
 */
function shorthandExact(key) {
	const exp = /^[A-Za-z0-9?.-]+$/.test(key) ? SHORTHANDS.get(key) : undefined;
	return exp === undefined ? null : words(exp);
}

/**
 * What a dash-stripped option `key` expands to where npm reads it as a
 * shorthand — nopt's resolveShort, in its order — else null. An exact config
 * name, and an abbreviation of one, are never shorthands.
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
 * Whether npm takes `next` as the value of `flag`, read as a `kind` option:
 * `value` for a config that needs one, `bool` for a Boolean, a `--no-` form or
 * a name npm does not know — nopt's look-ahead, in its order.
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
 * npm's argv rewritten as nopt reads it, so a scan sees only full
 * `--<config>` spellings, each value joined to its option by `=`:
 * `-cafile ca.pem` and `--cafi ca.pem` are `--cafile=ca.pem`, `-y null` is
 * `--yes=null`, `-d` is `--loglevel=info` (#563). Words after `--` are
 * untouched.
 * @param {string[]} argv the words after `npm`
 * @returns {string[]}
 */
function npmCanon(argv) {
	const args = [...argv];
	/** @type {string[]} */
	const canon = [];
	for (let w = args.shift(); w !== undefined; w = args.shift()) {
		if (/^--+$/.test(w)) return [...canon, "--", ...args];
		if (/^-./s.test(w)) canonOption(w, args, canon);
		else canon.push(w);
	}
	return canon;
}

/**
 * One option word read off `args` into `canon`: a shorthand put back on
 * `args` expanded, anything else pushed as its full `--<config>`, taking the
 * next word as its value where npm would.
 * @param {string} word
 * @param {string[]} args accumulator: the words still to read, its value
 *   word taken off the front
 * @param {string[]} canon accumulator: the canonical words, this option's pushed
 */
function canonOption(word, args, canon) {
	const eqAt = word.indexOf("=");
	const eq = eqAt >= 0;
	const val = eq ? word.slice(eqAt + 1) : "";
	const key = (eq ? word.slice(0, eqAt) : word).replace(/^-+/, "");
	const exp = shorthand(key);
	if (exp !== null) {
		args.unshift(...exp, ...(eq ? [val] : []));
		return;
	}
	const { flag, kind } = optionOf(key, eq);
	/* nopt reads an `=` word as the next argument, under the same look-ahead:
	 * `--save-dev=pkg` installs `pkg` (#559). */
	if (eq) args.unshift(val);
	const next = args[0];
	if (next !== undefined && takes(kind, flag, next)) {
		canon.push(`${flag}=${next}`);
		args.shift();
	} else canon.push(kind === "value" ? `${flag}=` : flag);
}

/**
 * A dash-stripped key as npm resolves it: its full flag, and whether it takes
 * a value. Each `no-` flips a Boolean, and any makes a value config one.
 * @param {string} given
 * @param {boolean} eq whether the word carried `=`
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

module.exports = { boolExact, npmCanon, shorthandExact };
