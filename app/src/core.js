// typasaur core: JSON -> TypeScript generator
const fs = require("fs");
const path = require("path");

async function main() {
  const argvList = process.argv.slice(2);
  const parsedArgs = parseCommandLineArguments(argvList);
  const stdinIsInteractiveTty = process.stdin.isTTY;

  printBanner(parsedArgs);

  try {
    const userProvidedModelName =
      parsedArgs["model-name"] || (await promptSingleLine("Model name (e.g., User, OrderItem): ")).trim();
    if (!userProvidedModelName) throw new Error("Model name is required.");

    const outputFilePath =
      parsedArgs.out || path.resolve(process.cwd(), `${userProvidedModelName.toLowerCase()}.ts`);

    let rawJsonInput = "";
    if (parsedArgs["input-json"]) {
      rawJsonInput = fs.readFileSync(path.resolve(process.cwd(), parsedArgs["input-json"]), "utf8");
    } else if (!stdinIsInteractiveTty) {
      rawJsonInput = await readAllFromStdin();
    } else {
      rawJsonInput = await promptJsonUntilValid("Paste JSON and press Enter when done:");
    }
    if (!rawJsonInput || !rawJsonInput.trim()) throw new Error("No JSON provided.");

    let parsedJsonValue;
    try {
      parsedJsonValue = JSON.parse(rawJsonInput);
    } catch {
      throw new Error("Invalid JSON. Make sure it is valid and try again.");
    }

    const generatorOptions = {
      detectDatesFromIsoStrings: !parsedArgs["no-dates"],
      stringEnumMinUniqueValues: numericOrDefault(parsedArgs["string-enum-min"], 2),
      stringEnumMaxUniqueValues: numericOrDefault(parsedArgs["string-enum-max"], 12),
      disableColorOutput: !!parsedArgs["no-color"]
    };

    const inferredTypeTree = inferTypeFromValue(parsedJsonValue, generatorOptions);
    const typescriptOutput = renderTypescriptFromTree({
      rootTypeName: userProvidedModelName,
      useInterfaceKeyword: !!parsedArgs.interface,
      rootTypeTree: inferredTypeTree
    });

    fs.writeFileSync(outputFilePath, typescriptOutput, "utf8");
    logInfo(generatorOptions, `Generated ${path.relative(process.cwd(), outputFilePath)}`);
  } catch (error) {
    logError(`Error: ${error.message || error}`);
    process.exit(1);
  }
}

/* ========================================================================== */
/*                             Inference & Unions                              */
/* ========================================================================== */

function inferTypeFromValue(value, options) {
  if (value === null) return { kind: "any" };
  const valueType = typeof value;

  if (valueType === "string") {
    return {
      kind: "string",
      isDate: options.detectDatesFromIsoStrings && isIsoLikeDateString(value),
      sample: value
    };
  }
  if (valueType === "number") return { kind: "number" };
  if (valueType === "boolean") return { kind: "boolean" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", items: { kind: "any" } };
    if (arrayContainsOnlyStrings(value) && shouldUseStringEnumForArray(value, options)) {
      const unique = [...new Set(value.map(String))];
      return { kind: "array", items: { kind: "string", enumValues: unique } };
    }
    const itemTypes = value.map((item) => inferTypeFromValue(item, options));
    return { kind: "array", items: unifyTypesMany(itemTypes) };
  }

  if (valueType === "object") {
    const fields = new Map();
    for (const [k, v] of Object.entries(value)) {
      fields.set(k, { type: inferTypeFromValue(v, options), required: v !== undefined });
    }
    return { kind: "object", fields };
  }

  return { kind: "any" };
}

function shouldUseStringEnumForArray(arr, options) {
  const unique = [...new Set(arr.map(String))];
  if (unique.length < options.stringEnumMinUniqueValues || unique.length > options.stringEnumMaxUniqueValues) {
    return false;
  }
  return unique.every((v) => v.length > 0 && v.length <= 20 && /^[A-Za-z0-9_-]+$/.test(v));
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
    const merged = mergeStringLiteralSets(a.enumValues, b.enumValues);
    return { kind: "string", isDate: !!(a.isDate || b.isDate), enumValues: merged };
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: unifyTypes(a.items, b.items) };
  }
  if (a.kind === "object" && b.kind === "object") {
    const unified = new Map();
    const allKeys = new Set([...a.fields.keys(), ...b.fields.keys()]);
    for (const key of allKeys) {
      const af = a.fields.get(key);
      const bf = b.fields.get(key);
      if (af && bf) {
        unified.set(key, { type: unifyTypes(af.type, bf.type), required: af.required && bf.required });
      } else if (af) unified.set(key, { type: af.type, required: false });
      else if (bf) unified.set(key, { type: bf.type, required: false });
    }
    return { kind: "object", fields: unified };
  }

  return normalizeUnionType({ kind: "union", types: [a, b] });
}

function normalizeUnionType(union) {
  if (union.types.some((t) => t.kind === "any")) return { kind: "any" };
  const flat = [];
  for (const t of union.types) {
    if (t.kind === "union") flat.push(...t.types);
    else if (!flat.some((e) => areTypesEqual(e, t))) flat.push(t);
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
      return !!a.isDate === !!b.isDate && JSON.stringify(a.enumValues || []) === JSON.stringify(b.enumValues || []);
    case "array":
      return areTypesEqual(a.items, b.items);
    case "union":
      return a.types.length === b.types.length && a.types.every((t, i) => areTypesEqual(t, b.types[i]));
    case "object":
      if (a.fields.size !== b.fields.size) return false;
      for (const [k, va] of a.fields) {
        const vb = b.fields.get(k);
        if (!vb || va.required !== vb.required || !areTypesEqual(va.type, vb.type)) return false;
      }
      return true;
  }
}

/* ========================================================================== */
/*                               Type Rendering                               */
/* ========================================================================== */

function renderTypescriptFromTree({ rootTypeName, useInterfaceKeyword, rootTypeTree }) {
  const named = [];
  const map = new Map();
  const used = new Set([rootTypeName]);
  const typeKw = useInterfaceKeyword ? "interface" : "type";

  function nextName(base) {
    if (!used.has(base)) { used.add(base); return base; }
    let i = 2;
    while (used.has(base + i)) i++;
    used.add(base + i);
    return base + i;
  }

  function nameFromKey(key, isArrayItem = false) {
    const base = isArrayItem ? singularizeWord(key || "Item") : (key || "Model");
    return toPascalCase(base) || "Model";
  }

  function ensureNamed(obj, key, isArrayItem = false) {
    if (map.has(obj)) return map.get(obj);
    const name = nextName(nameFromKey(key, isArrayItem));
    map.set(obj, name);
    const body = render(obj, key);
    named.push(`export ${typeKw} ${name} = ${body};`);
    return name;
  }

  function renderArray(item, key) {
    const inner = render(item, key, true);
    const needsParens = item.kind === "union" || (item.kind === "string" && item.enumValues?.length);
    return needsParens ? `(${inner})[]` : `${inner}[]`;
  }

  function render(node, key, inArr = false) {
    switch (node.kind) {
      case "any": return "any";
      case "number": return "number";
      case "boolean": return "boolean";
      case "string":
        if (node.enumValues?.length) return node.enumValues.map((v) => JSON.stringify(v)).join(" | ");
        return node.isDate ? "string | Date" : "string";
      case "union": return node.types.map((t) => render(t, key, inArr)).join(" | ");
      case "array": return renderArray(node.items, key);
      case "object": {
        const lines = ["{"];
        for (const [f, info] of [...node.fields.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const opt = info.required ? "" : "?";
          const safeKey = isValidTypescriptIdentifier(f) ? f : JSON.stringify(f);
          let ts;
          if (info.type.kind === "object") ts = ensureNamed(info.type, f, false);
          else if (info.type.kind === "array" && info.type.items.kind === "object") ts = ensureNamed(info.type.items, f, true) + "[]";
          else if (info.type.kind === "array") ts = renderArray(info.type.items, f);
          else ts = render(info.type, f);
          lines.push(`  ${safeKey}${opt}: ${ts};`);
        }
        lines.push("}");
        return lines.join("\n");
      }
    }
  }

  const header = `
/**
 * Generated by typasaur
 *
 *                    __
 *                   / _)
 *          .-^^^-/ /
 *      __/       /
 *     <__.|_|-|_|
 *
 * JSON to TypeScript Model CLI
 */
`.trim();

  const rootBody = render(rootTypeTree, rootTypeName);
  const rootDecl = `export ${typeKw} ${rootTypeName} = ${rootBody};`;
  return [header, ...named, rootDecl].join("\n\n") + "\n";
}

/* ========================================================================== */
/*                               Helpers                                      */
/* ========================================================================== */

function isIsoLikeDateString(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(s);
}
function arrayContainsOnlyStrings(arr) { return arr.every((v) => typeof v === "string"); }
function mergeStringLiteralSets(a, b) {
  const merged = new Set([...(a || []), ...(b || [])]); return merged.size ? [...merged] : undefined;
}
function toPascalCase(str) { return str.replace(/(^|_|-|\s)+(.)/g, (_, __, c) => c.toUpperCase()); }
function singularizeWord(word) { return word.endsWith("s") ? word.slice(0, -1) : word; }
function isValidTypescriptIdentifier(name) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name); }
function numericOrDefault(val, def) { const n = parseInt(val, 10); return isNaN(n) ? def : n; }

/* ========================================================================== */
/*                               CLI Helpers                                  */
/* ========================================================================== */

function parseCommandLineArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--model-name") args["model-name"] = v;
    else if (k === "--input-json") args["input-json"] = v;
    else if (k === "--out") args["out"] = v;
    else if (k === "--interface") args["interface"] = true;
    else if (k === "--no-dates") args["no-dates"] = true;
    else if (k === "--string-enum-min") args["string-enum-min"] = v;
    else if (k === "--string-enum-max") args["string-enum-max"] = v;
    else if (k === "--no-banner") args["no-banner"] = true;
    else if (k === "--no-color") args["no-color"] = true;
  }
  return args;
}

function promptSingleLine(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (l) => { rl.close(); resolve(l); });
  });
}

function promptJsonUntilValid(msg) {
  return new Promise((resolve) => {
    console.log(msg);
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let buf = "", depth = 0, str = false, esc = false;
    rl.on("line", (line) => {
      buf += (buf ? "\n" : "") + line;
      for (const ch of line) {
        if (str) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === "\"") str = false;
        } else {
          if (ch === "\"") str = true;
          if (ch === "{" || ch === "[") depth++;
          if (ch === "}" || ch === "]") depth--;
        }
      }
      if (depth === 0 && !str) {
        try { JSON.parse(buf); rl.close(); resolve(buf); return; } catch {}
      }
    });
    rl.on("close", () => { try { JSON.parse(buf); resolve(buf); } catch { resolve(buf); } });
    process.stdout.write("(Tip: multi-line paste is fine. Press Enter after last line, Ctrl+D to finish.)\n");
  });
}

function readAllFromStdin() {
  return new Promise((resolve) => {
    let buf = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => buf += c);
    process.stdin.on("end", () => resolve(buf));
  });
}

/* ========================================================================== */
/*                               Banner & Logs                                */
/* ========================================================================== */

function printBanner(args) {
  if (!process.stdout.isTTY || args["no-banner"]) return;
  const useColor = !args["no-color"];
  const g = useColor ? "\x1b[32m" : "", c = useColor ? "\x1b[36m" : "", w = useColor ? "\x1b[37m" : "", r = useColor ? "\x1b[0m" : "";
  console.log(`
${g}                   __
                  / _)
         .-^^^-/ /
     __/       /
    <__.|_|-|_|    ${r}

${c}              T Y P A S A U R${r}
${w}       JSON to TypeScript Model CLI${r}
`);
}

function logInfo(options, msg) {
  if (options.disableColorOutput) console.log(msg);
  else console.log("\x1b[32m%s\x1b[0m", msg);
}
function logError(msg) { console.error("\x1b[31m%s\x1b[0m", msg); }

module.exports = { main };