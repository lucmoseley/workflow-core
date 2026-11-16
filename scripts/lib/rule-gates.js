/*
 * rule-gates.js — the rule ids a Node core's injection skips by the host's
 * modules (#2785).
 *
 * Called statement-initial with a literal module and a literal id array,
 * `...ruleModule(ctx, "suites", ["x"])`, because lib/rule-emission.js reads
 * the call there to leave the ids out of the budget of a host with the module
 * off.
 */

/** @typedef {import("./workflow-core-config.js").Module} Module */

/**
 * The ids, unless the host lists `module` (#449).
 * @param {{ moduleOn: (module: Module) => boolean }} ctx
 * @param {Module} module
 * @param {string[]} ids
 */
const ruleModule = (ctx, module, ids) => (ctx.moduleOn(module) ? [] : ids);

module.exports = { ruleModule };
