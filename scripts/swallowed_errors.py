"""swallowed_errors.py — base §N5 over Python source: an `except` that neither raises nor exits says
why at the site and cites the ticket that chose it (workflow-core#1274, workflow-core#1830).

The reason is lexical — a ticket citation is all that is checked. It may sit
in a comment from two lines above the `except` to the handler's end, in the
enclosing function's docstring, or in the comment above the first assignment of
the counter the handler increments. Whether the drop is also printed is §N5's
third part, which no walk can see.

A citation is a bare `#N`, or `<repo>#N` for a repo in the host's corpus,
owner-qualified or not. A `#N` glued to any other word (`design-vault#3` in a
repo whose corpus lacks design-vault) cites a tracker the host cannot read, so
it is no citation.

Run by scripts/check-swallowed-errors.js, which picks the program-routed paths
and the corpus from the host's config. stdin is
`{"prefixes": [...], "sources": [{"name": ..., "text": ...}]}`; stdout is
`{"results": [{"name": ..., "breaches": [{"line", "function", "caught"}]}]}`,
a source that does not parse carrying `"error"` instead. `function` and `caught` let the judge count a file's
breaches against HEAD's without line numbers, which any edit above them moves.
"""

import ast
import json
import re
import sys

EXITS = {"sys.exit", "exit", "quit", "os._exit"}
# The names the core binds an argparse parser to. A host binding one to another
# name has its `.error()` read as a swallow: a false failure, never a missed
# one, fixed by a citation at the site.
PARSERS = {"p", "ap", "parser"}


def cite_pattern(prefixes):
    """A bare `#N` not glued to a word, or `#N` after one of `prefixes`."""
    named = "|".join(re.escape(p) for p in sorted(prefixes, key=len, reverse=True))
    head = rf"(?<!\w)(?:{named})|(?<!\w)" if named else r"(?<!\w)"
    return re.compile(rf"(?:{head})#\d+", re.IGNORECASE)


def fails_loudly(handler):
    """Raises, exits, calls an argparse `.error`, or prints and returns a
    non-zero exit code from the handler."""
    prints = any(
        isinstance(n, ast.Call) and ast.unparse(n.func) == "print"
        for n in ast.walk(handler)
    )
    for n in ast.walk(handler):
        if isinstance(n, ast.Raise):
            return True
        if isinstance(n, ast.Call):
            name = ast.unparse(n.func)
            if name in EXITS or (
                name.endswith(".error") and name.split(".")[0] in PARSERS
            ):
                return True
        if (
            prints
            and isinstance(n, ast.Return)
            and isinstance(n.value, ast.Constant)
            and type(n.value.value) is int
            and n.value.value != 0
        ):
            return True
    return False


def comments_above(lines, lineno):
    """The contiguous comment block directly above 1-based `lineno`."""
    out, i = [], lineno - 2
    while i >= 0 and lines[i].lstrip().startswith("#"):
        out.append(lines[i])
        i -= 1
    return " ".join(out)


def counters(handler):
    """Names the handler increments: `n += 1` and `DROPS[k] += 1` alike."""
    out = set()
    for n in ast.walk(handler):
        if isinstance(n, ast.AugAssign):
            target = n.target.value if isinstance(n.target, ast.Subscript) else n.target
            if isinstance(target, ast.Name):
                out.add(target.id)
    return out


def first_assignment(scope, name):
    for n in ast.walk(scope):
        if isinstance(n, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in n.targets
        ):
            return n
    return None


def owners(tree):
    """Each handler's innermost enclosing function, and that function's dotted
    name through its enclosing functions and classes."""
    owner, names = {}, {}

    def visit(node, trail):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                inner = [*trail, child.name]
                if not isinstance(child, ast.ClassDef):
                    names[child] = ".".join(inner)
                visit(child, inner)
            else:
                visit(child, trail)

    visit(tree, [])
    for fn in names:
        for n in ast.walk(fn):
            if isinstance(n, ast.ExceptHandler):
                owner[n] = fn  # walk order is outer first, so inner wins
    return owner, names


def breaches(src, cite):
    """`(line, function, caught)` for each handler that swallows and cites
    nothing `cite` matches; `function` is `<module>` outside one, `caught`
    `<bare>` for a bare `except:`."""
    lines = src.splitlines()
    tree = ast.parse(src)
    owner, names = owners(tree)
    out = []
    for h in ast.walk(tree):
        if not isinstance(h, ast.ExceptHandler) or fails_loudly(h):
            continue
        fn = owner.get(h)
        site = "\n".join(lines[max(0, h.lineno - 3) : h.end_lineno])
        where = [
            " ".join(re.findall(r"#.*", site)),
            (fn and ast.get_docstring(fn)) or "",
        ]
        for name in counters(h):
            for scope in (fn, tree):
                a = scope and first_assignment(scope, name)
                if a:
                    where.append(comments_above(lines, a.lineno))
                    break
        if not any(cite.search(w) for w in where):
            caught = ast.unparse(h.type) if h.type else "<bare>"
            out.append((h.lineno, names.get(fn, "<module>"), caught))
    return sorted(out)


def main():
    req = json.load(sys.stdin)
    cite = cite_pattern(req["prefixes"])
    results = []
    for s in req["sources"]:
        try:
            found = breaches(s["text"], cite)
        except SyntaxError as error:
            # Reported, not judged: ruff's E9 refuses the commit (workflow-core#1830).
            results.append({"name": s["name"], "error": str(error)})
            continue
        results.append(
            {
                "name": s["name"],
                "breaches": [
                    {"line": n, "function": f, "caught": c} for n, f, c in found
                ],
            }
        )
    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
