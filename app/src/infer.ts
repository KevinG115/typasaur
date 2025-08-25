import { TypeTree, ObjectNode, InferOptions } from "./types";

export function inferTypeFromValue(
  value: unknown,
  options: InferOptions,
  suggestedName?: string
): TypeTree {
  if (value === null) return { kind: "null" };

  if (Array.isArray(value)) {
    const element = inferArrayElement(value, options, suggestedName);
    return { kind: "array", element };
  }

  switch (typeof value) {
    case "string":
      return { kind: "string", example: value };
    case "number":
      return { kind: "number", example: value };
    case "boolean":
      return { kind: "boolean", example: value };
    case "object":
      return inferObject(value as Record<string, unknown>, options, suggestedName);
    default:
      return { kind: "null" };
  }
}

function inferObject(
  obj: Record<string, unknown>,
  options: InferOptions,
  suggestedName?: string
): ObjectNode {
  const props: Record<string, TypeTree> = {};
  for (const [key, v] of Object.entries(obj)) {
    props[key] = inferTypeFromValue(v, options, key);
  }
  const maybeName = suggestedName ? toPascalCase(singularize(suggestedName)) : undefined;

  const node: ObjectNode = { kind: "object", props };
  if (maybeName) node.name = maybeName;   // don’t assign undefined
  return node;
}

function inferArrayElement(
  arr: unknown[],
  options: InferOptions,
  suggestedName?: string
): TypeTree {
  if (arr.length === 0) return { kind: "null" };
  const elements = arr.map((v) => inferTypeFromValue(v, options, suggestedName));
  return simplifyUnion(elements);
}

function simplifyUnion(nodes: TypeTree[]): TypeTree {
  // Deduplicate by kind (you can make this smarter later)
  const keyOf = (n: TypeTree) => JSON.stringify({ kind: n.kind });
  const map = new Map<string, TypeTree>();
  for (const n of nodes) map.set(keyOf(n), n);

  if (map.size === 0) {
    return { kind: "null" };
  }
  if (map.size === 1) {
    // values().next().value is TypeTree | undefined; guard handled above
    const only = map.values().next().value as TypeTree;
    return only;
  }
  return { kind: "union", options: Array.from(map.values()) };
}

function toPascalCase(s: string) {
  return s.replace(/(^|[_\-\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
}
function singularize(s: string) {
  return s.endsWith("s") && s.length > 1 ? s.slice(0, -1) : s;
}