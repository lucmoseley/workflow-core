/*
 * rule-gates.js — the rule ids a Node core picks by the host's modules: the
 * ids an injection skips (#2785), and the one `-landing` twin a deny prints.
 *
 * Called statement-initial with a literal module and a literal id array,
 * `...ruleModule(ctx, "suites", ["x"])`, because lib/rule-emission.js reads
 * the call there to leave the ids out of the budget of a host with the module
 * off.
 *
 * landingTwin takes its id literally too, handed straight to the accessor
 * with a bare-named ctx: check-guard-registry.js reads that call as printing
 * both the id and its `-landing` twin. Its ctx is the kit's, or one holding
 * workflow-core-config.js's moduleReader, so a config fault reads as off and
 * the twin choice never throws.
 */

/** @typedef {import("./workflow-core-config.js").Module} Module */

/**
 * The ids, unless the host lists `module` (#449).
 * @param {{ moduleOn: (module: Module) => boolean }} ctx
 * @param {Module} module
 * @param {string[]} ids
 */
const ruleModule = (ctx, module, ids) => (ctx.moduleOn(module) ? [] : ids);

/**
 * The ids, where the host lists `module`: the text a module replaces (#2409).
 * @param {{ moduleOn: (module: Module) => boolean }} ctx
 * @param {Module} module
 * @param {string[]} ids
 */
const ruleUnlessModule = (ctx, module, ids) =>
	ctx.moduleOn(module) ? ids : [];

/**
 * `id`'s `-landing` twin where the host lists `landing`, `id` otherwise
 * (#2409).
 * @template {string} I
 * @param {{ moduleOn: (module: Module) => boolean }} ctx
 * @param {I} id
 * @returns {I | `${I}-landing`}
 */
const landingTwin = (ctx, id) =>
	ctx.moduleOn("landing") ? `${id}-landing` : id;

module.exports = { landingTwin, ruleModule, ruleUnlessModule };
