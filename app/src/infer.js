const { isIsoLikeDateString } = require("./utils");

function inferTypeFromValue(value, options) {
  if (value === null) return { kind: "any" };

  const t = typeof value;
  if (t === "string") {
    return {
      kind: "string",
      isDate: options.detectDatesFromIsoStrings && isIsoLikeDateString(value),
      sample: value
    };
    }
  if (t === "number") return { kind: "number" };
  if (t === "boolean") return { kind: "boolean" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", items: { kind: "any" } };

    if (value.every(v => typeof v === "string")) {
      const unique = [...new Set(value.map(String))];
      const within = unique.length >= options.stringEnumMinUniqueValues &&
                     unique.length <= options.stringEnumMaxUniqueValues;
      const tokenLike = unique.every(s => s.length > 0 && s.length <= 20 && /^[A-Za-z0-9_-]+$/.test(s));
      if (within && tokenLike) {
        return { kind: "array", items: { kind: "string", enumValues: unique } };
      }
    }

    const itemNodes = value.map(v => inferTypeFromValue(v, options));
    return { kind: "array", items: unifyTypesMany(itemNodes) };
  }

  if (t === "object") {
    const fields = new Map();
    for (const [k, v] of Object.entries(value)) {
      fields.set(k, { type: inferTypeFromValue(v, options), required: v !== undefined });
    }
    return { kind: "object", fields };
  }

  return { kind: "any" };
}

function unifyTypesMany(nodes) {
  return nodes.reduce((a, b) => unifyTypes(a, b));
}

function unifyTypes(a, b) {
  if (areTypesEqual(a, b)) return a;
  if (a.kind === "any" || b.kind === "any") return { kind: "any" };

  if (a.kind === "union") return normalizeUnionType({ kind: "union", types: [...a.types, b] });
  if (b.kind === "union") return normalizeUnionType({ kind: "union", types: [a, ...b.types] });

  if (a.kind === "string" && b.kind === "string") {
    const mergedEnum = mergeStringLiterals(a.enumValues, b.enumValues);
    return { kind: "string", isDate: !!(a.isDate || b.isDate), enumValues: mergedEnum };
  }

  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: unifyTypes(a.items, b.items) };
  }

  if (a.kind === "object" && b.kind === "object") {
    const unified = new Map();
    const keys = new Set([...a.fields.keys(), ...b.fields.keys()]);
    for (const k of keys) {
      const af = a.fields.get(k);
      const bf = b.fields.get(k);
      if (af && bf) unified.set(k, { type: unifyTypes(af.type, bf.type), required: af.required && bf.required });
      else if (af) unified.set(k, { type: af.type, required: false });
      else unified.set(k, { type: bf.type, required: false });
    }
    return { kind: "object", fields: unified };
  }

  return normalizeUnionType({ kind: "union", types: [a, b] });
}

function normalizeUnionType(union) {
  if (union.types.some(t => t.kind === "any")) return { kind: "any" };
  const flat = [];
  for (const t of union.types) {
    if (t.kind === "union") flat.push(...t.types);
    else if (!flat.some(e => areTypesEqual(e, t))) flat.push(t);
  }
  if (flat.length === 1) return flat[0];
  return { kind: "union", types: flat };
}

function areTypesEqual(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "any":
    case "number":
    case "boolean":
      return true;
    case "string":
      return !!a.isDate === !!b.isDate &&
        JSON.stringify(a.enumValues || []) === JSON.stringify(b.enumValues || []);
    case "array":
      return areTypesEqual(a.items, b.items);
    case "union":
      return a.types.length === b.types.length && a.types.every((t, i) => areTypesEqual(t, b.types[i]));
    case "object":
      if (a.fields.size !== b.fields.size) return false;
      for (const [k, fa] of a.fields) {
        const fb = b.fields.get(k);
        if (!fb || fa.required !== fb.required || !areTypesEqual(fa.type, fb.type)) return false;
      }
      return true;
  }
}

function mergeStringLiterals(a, b) {
  if (!a && !b) return undefined;
  const set = new Set([...(a || []), ...(b || [])]);
  return [...set];
}

module.exports = { inferTypeFromValue };