import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from fail_open import fail_open

EXITS = {"sys.exit", "exit", "quit", "os._exit"}
PARSERS = {"p", "ap", "parser"}


REPORTERS = ("fail_open", "tallied", "expected")
BROAD = {
    "Exception",
    "BaseException",
    "OSError",
    "IOError",
    "EnvironmentError",
    "os.error",
    "socket.error",
    "select.error",
}


def imported_names(tree, module, wanted):
    out = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and (n.module or "").split(".")[-1] == module:
            for a in n.names:
                if a.name in wanted:
                    out[a.asname or a.name] = a.name
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name.split(".")[-1] == module:
                    for w in wanted:
                        out[f"{a.asname or a.name}.{w}"] = w
    return out


def narrow(types):
    return bool(types) and all(
        isinstance(t, (ast.Name, ast.Attribute))
        and ast.unparse(t).endswith("Error")
        and ast.unparse(t) not in BROAD
        and ast.unparse(t).split(".")[-1] not in BROAD
        for t in types
    )


def specific(handler):
    if handler.type is None:
        return False
    return narrow(
        handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
    )


def reports(handler, names):
    for stmt in handler.body:
        call = stmt.value if isinstance(stmt, ast.Expr) else None
        if (
            isinstance(call, ast.Call)
            and ast.unparse(call.func) in names
            and handler.name is not None
            and call.args
            and isinstance(call.args[0], ast.Name)
            and call.args[0].id == handler.name
            and (names[ast.unparse(call.func)] != "expected" or specific(handler))
        ):
            return True
    return False


def reports_or_ends(handler, names):
    if reports(handler, names):
        return True
    for n in ast.walk(handler):
        if isinstance(n, ast.Raise):
            return True
        if isinstance(n, ast.Call):
            name = ast.unparse(n.func)
            if name in EXITS or (
                name.endswith(".error") and name.split(".")[0] in PARSERS
            ):
                return True
    return False


def is_exit_code(value):
    return (
        isinstance(value, ast.Constant)
        and type(value.value) is int
        and value.value != 0
    )


def fails_loudly(handler, names):
    if reports_or_ends(handler, names):
        return True
    nodes = list(ast.walk(handler))
    prints = any(
        isinstance(n, ast.Call) and ast.unparse(n.func) == "print" for n in nodes
    )
    return prints and any(
        isinstance(n, ast.Return)
        and (
            is_exit_code(n.value)
            or (isinstance(n.value, ast.Tuple) and any(map(is_exit_code, n.value.elts)))
        )
        for n in nodes
    )


def owners(tree):
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
            if n is not fn:
                owner[n] = fn
    return owner, names


SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


def own_blocks(fn):
    stack = [fn]
    while stack:
        node = stack.pop()
        for _, value in ast.iter_fields(node):
            children = value if isinstance(value, list) else [value]
            if children and all(isinstance(c, ast.stmt) for c in children):
                yield children
            stack.extend(
                c
                for c in children
                if isinstance(c, ast.AST) and not isinstance(c, SCOPES)
            )


def catches(stmt):
    return (
        isinstance(stmt, ast.Return)
        and stmt.value is not None
        and not (isinstance(stmt.value, ast.Constant) and not stmt.value.value)
    )


def exit_swallows(fn, names):
    if fn.name not in ("__exit__", "__aexit__"):
        return None
    params = [*fn.args.posonlyargs, *fn.args.args]
    bound = params[-2].arg if len(params) >= 3 else None
    for block in own_blocks(fn):
        for at, stmt in enumerate(block):
            path = ast.ExceptHandler(type=None, name=bound, body=block[: at + 1])
            if catches(stmt) and not reports_or_ends(path, names):
                return stmt.lineno, f"{fn.name} returning {ast.unparse(stmt.value)}"
    return None


def breaches(src):
    tree = ast.parse(src)
    owner, names = owners(tree)
    via = imported_names(tree, "fail_open", REPORTERS)
    suppressors = imported_names(tree, "contextlib", ("suppress",))
    out = []

    def where(n):
        return names.get(owner.get(n), "<module>")

    for n in ast.walk(tree):
        if isinstance(n, ast.ExceptHandler) and not fails_loudly(n, via):
            caught = ast.unparse(n.type) if n.type else "<bare>"
            out.append((n.lineno, where(n), f"except {caught}"))
        if (
            isinstance(n, ast.Call)
            and ast.unparse(n.func) in suppressors
            and not narrow(n.args)
        ):
            out.append((n.lineno, where(n), ast.unparse(n)))
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            swallow = exit_swallows(n, via)
            if swallow:
                out.append((swallow[0], names[n], swallow[1]))
    return sorted(out)


def main():
    req = json.load(sys.stdin)
    results = []
    for s in req["sources"]:
        try:
            found = breaches(s["text"])
        except SyntaxError as error:
            fail_open(error, f"{s['name']} not judged")
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
