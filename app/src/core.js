const fs = require("fs");
const path = require("path");

/* ============================================================================
 * Entry
 * ==========================================================================*/

/**
 * Program entrypoint.
 * - Parses CLI args
 * - Prints banner (unless disabled)
 * - Prompts for model name and JSON (if not provided)
 * - Infers types and writes the generated TypeScript file
 */
async function main() {
  const argvList = process.argv.slice(2);
  const args = parseCommandLineArguments(argvList);
  const isTty = process.stdin.isTTY;

  printBanner(args);

  try {
    // 1) Model name
    const userProvidedModelName =
      args["model-name"] || (await promptSingleLine("Model name (e.g., User, OrderItem): ")).trim();

    if (!userProvidedModelName) {
      printError("No model name provided. Use --model-name or enter one when prompted.", args);
      process.exit(1);
    }

    // 2) Output file path (lowercased filename from model name unless overridden)
    const outputFilePath =
      args.out || path.resolve(process.cwd(), `${userProvidedModelName.toLowerCase()}.ts`);

    // 3) JSON input (file, piped stdin, or interactive paste)
    let rawJsonInput = "";
    try {
      if (args["input-json"]) {
        const inputPath = path.resolve(process.cwd(), args["input-json"]);
        rawJsonInput = fs.readFileSync(inputPath, "utf8");
      } else if (!isTty) {
        rawJsonInput = await readAllFromStdin();
      } else {
        rawJsonInput = await promptJsonUntilValid("Paste JSON and press Enter when done:");
      }
    } catch (e) {
      printError(`Failed to read input JSON. ${stringifyMaybeError(e)}`, args);
      process.exit(1);
    }

    if (!rawJsonInput || !rawJsonInput.trim()) {
      printError("No JSON input detected. Paste valid JSON or use --input-json <file>.", args);
      process.exit(1);
    }

    // 4) Parse JSON
    let parsedJsonValue;
    try {
      parsedJsonValue = JSON.parse(rawJsonInput);
    } catch {
      printError("Invalid JSON input. Please fix syntax (e.g., check commas and quotes).", args);
      process.exit(1);
    }

    // 5) Options for inference/rendering
    const options = {
      detectDatesFromIsoStrings: !args["no-dates"],
      stringEnumMinUniqueValues: numericOrDefault(args["string-enum-min"], 2),
      stringEnumMaxUniqueValues: numericOrDefault(args["string-enum-max"], 12),
      disableColorOutput: !!args["no-color"]
    };

    // 6) Infer internal type tree
    const inferredTypeTree = inferTypeFromValue(parsedJsonValue, options);

    // 7) Render TypeScript
    const tsText = renderTypescriptFromTree({
      rootTypeName: userProvidedModelName,
      useInterfaceKeyword: !!args.interface,
      rootTypeTree: inferredTypeTree
    });

    // 8) Write output
    try {
      fs.writeFileSync(outputFilePath, tsText, "utf8");
    } catch (e) {
      printError(
        `Could not write to output file "${path.relative(process.cwd(), outputFilePath)}". Check path or permissions.`,
        args
      );
      process.exit(2);
    }

    logInfo(options, `Generated ${path.relative(process.cwd(), outputFilePath)}`);
  } catch (e) {
    // Last-resort catch for unexpected issues
    printError(`Unexpected internal error. ${stringifyMaybeError(e)}`, { "no-color": false });
    process.exit(3);
  }
}

/* ============================================================================
 * Inference & Unions
 * ==========================================================================*/

/**
 * Infer an internal type tree from any JS value.
 * Rules:
 * - null -> any
 * - arrays: unify item types; [] -> any[]
 * - objects: fields map; required if present (value !== undefined)
 * - strings: optionally detect ISO-like date strings
 * - arrays of short token-like strings -> string-literal unions; otherwise string[]
 */
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

    // Array of strings -> maybe string enum
    if (arrayContainsOnlyStrings(value) && shouldUseStringEnumForArray(value, options)) {
      const unique = [...new Set(value.map(String))];
      return { kind: "array", items: { kind: "string", enumValues: unique } };
    }

    const itemNodes = value.map((v) => inferTypeFromValue(v, options));
    return { kind: "array", items: unifyTypesMany(itemNodes) };
  }

  if (t === "object") {
    const fields = new Map();
    for (const [k, v] of Object.entries(value)) {
      fields.set(k, {
        type: inferTypeFromValue(v, options),
        required: v !== undefined
      });
    }
    return { kind: "object", fields };
  }

  return { kind: "any" };
}

/**
 * Decide if an array of strings should be a string-literal union.
 * - unique count within thresholds
 * - each string is short token-like: [A-Za-z0-9_-], length <= 20
 */
function shouldUseStringEnumForArray(stringsArray, options) {
  const unique = [...new Set(stringsArray.map(String))];
  if (
    unique.length < options.stringEnumMinUniqueValues ||
    unique.length > options.stringEnumMaxUniqueValues
  ) {
    return false;
  }
  return unique.every((s) => s.length > 0 && s.length <= 20 && /^[A-Za-z0-9_-]+$/.test(s));
}

/** Unify many type nodes into one. */
function unifyTypesMany(nodes) {
  return nodes.reduce((a, b) => unifyTypes(a, b));
}

/**
 * Unify two type nodes.
 * - any dominates
 * - unions flattened/deduped
 * - objects unify by field, required only if required on both sides
 * - arrays unify item types
 * - strings merge date flags and enum sets
 */
function unifyTypes(a, b) {
  if (areTypesEqual(a, b)) return a;

  if (a.kind === "any" || b.kind === "any") return { kind: "any" };

  if (a.kind === "union") return normalizeUnionType({ kind: "union", types: [...a.types, b] });
  if (b.kind === "union") return normalizeUnionType({ kind: "union", types: [a, ...b.types] });

  if (a.kind === "string" && b.kind === "string") {
    const mergedEnum = mergeStringLiteralSets(a.enumValues, b.enumValues);
    return { kind: "string", isDate: !!(a.isDate || b.isDate), enumValues: mergedEnum };
  }

  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: unifyTypes(a.items, b.items) };
  }

  if (a.kind === "object" && b.kind === "object") {
    const unified = new Map();
    const all = new Set([...a.fields.keys(), ...b.fields.keys()]);
    for (const key of all) {
      const af = a.fields.get(key);
      const bf = b.fields.get(key);
      if (af && bf) {
        unified.set(key, { type: unifyTypes(af.type, bf.type), required: af.required && bf.required });
      } else if (af) {
        unified.set(key, { type: af.type, required: false });
      } else if (bf) {
        unified.set(key, { type: bf.type, required: false });
      }
    }
    return { kind: "object", fields: unified };
  }

  return normalizeUnionType({ kind: "union", types: [a, b] });
}

/** Normalize union: any -> any, flatten, dedupe, collapse singletons. */
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

/** Structural equality for type nodes. */
function areTypesEqual(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "any":
    case "number":
    case "boolean":
      return true;
    case "string":
      return (
        !!a.isDate === !!b.isDate &&
        JSON.stringify(a.enumValues || []) === JSON.stringify(b.enumValues || [])
      );
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

/* ============================================================================
 * Rendering
 * ==========================================================================*/

/**
 * Convert internal type tree to TypeScript.
 * - Header with ASCII dinosaur
 * - Nested types named from JSON keys (Profile, Project, Settings, Notifications, etc.)
 * - Root name kept exactly as entered
 * - Arrays of unions are parenthesized: ("a" | "b")[]
 */
function renderTypescriptFromTree({ rootTypeName, useInterfaceKeyword, rootTypeTree }) {
  const namedTypeDefinitions = [];
  const objectNodeToTypeName = new Map();
  const usedTypeNames = new Set([rootTypeName]);
  const typeKeyword = useInterfaceKeyword ? "interface" : "type";

  function nextAvailableTypeName(baseName) {
    if (!usedTypeNames.has(baseName)) {
      usedTypeNames.add(baseName);
      return baseName;
    }
    let n = 2;
    while (usedTypeNames.has(baseName + n)) n++;
    const finalName = baseName + n;
    usedTypeNames.add(finalName);
    return finalName;
  }

  function nameFromJsonKey(jsonKey, isArrayItem = false) {
    const base = isArrayItem ? singularizeWord(jsonKey || "Item") : (jsonKey || "Model");
    const pascal = toPascalCase(base);
    return pascal || "Model";
  }

  function ensureNamedTypeForObject(objectNode, jsonKeyForThisObject, isArrayItem = false) {
    if (objectNodeToTypeName.has(objectNode)) return objectNodeToTypeName.get(objectNode);
    const baseName = nameFromJsonKey(jsonKeyForThisObject, isArrayItem);
    const finalName = nextAvailableTypeName(baseName);
    objectNodeToTypeName.set(objectNode, finalName);
    const body = renderTypeNode(objectNode, jsonKeyForThisObject);
    namedTypeDefinitions.push(`export ${typeKeyword} ${finalName} = ${body};`);
    return finalName;
  }

  function renderArrayType(itemNode, parentArrayJsonKey) {
    const itemRendered = renderTypeNode(itemNode, parentArrayJsonKey, true);
    const needsParens =
      itemNode.kind === "union" ||
      (itemNode.kind === "string" && itemNode.enumValues && itemNode.enumValues.length > 0);
    return needsParens ? `(${itemRendered})[]` : `${itemRendered}[]`;
  }

  function renderTypeNode(typeNode, parentJsonKey, inArrayContext = false) {
    switch (typeNode.kind) {
      case "any":
        return "any";
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "string":
        if (typeNode.enumValues && typeNode.enumValues.length) {
          return typeNode.enumValues.map((lit) => JSON.stringify(lit)).join(" | ");
        }
        return typeNode.isDate ? "string | Date" : "string";
      case "union":
        return typeNode.types.map((t) => renderTypeNode(t, parentJsonKey, inArrayContext)).join(" | ");
      case "array":
        return renderArrayType(typeNode.items, parentJsonKey);
      case "object": {
        const lines = ["{"];

        const sorted = [...typeNode.fields.entries()].sort(([a], [b]) => a.localeCompare(b));

        for (const [fieldName, fieldInfo] of sorted) {
          const optional = fieldInfo.required ? "" : "?";
          const safeKey = isValidTypescriptIdentifier(fieldName) ? fieldName : JSON.stringify(fieldName);

          let fieldTs;
          if (fieldInfo.type.kind === "object") {
            const childTypeName = ensureNamedTypeForObject(fieldInfo.type, fieldName, false);
            fieldTs = childTypeName;
          } else if (fieldInfo.type.kind === "array" && fieldInfo.type.items.kind === "object") {
            const itemTypeName = ensureNamedTypeForObject(fieldInfo.type.items, fieldName, true);
            fieldTs = `${itemTypeName}[]`;
          } else if (fieldInfo.type.kind === "array") {
            fieldTs = renderArrayType(fieldInfo.type.items, fieldName);
          } else {
            fieldTs = renderTypeNode(fieldInfo.type, fieldName);
          }

          lines.push(`  ${safeKey}${optional}: ${fieldTs};`);
        }

        lines.push("}");
        return lines.join("\n");
      }
    }
  }

  const headerBlock = `
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

  const rootBody = renderTypeNode(rootTypeTree, rootTypeName);
  const rootDecl = `export ${typeKeyword} ${rootTypeName} = ${rootBody};`;

  return [headerBlock, ...namedTypeDefinitions, rootDecl].join("\n\n") + "\n";
}

/* ============================================================================
 * Banner & Logs
 * ==========================================================================*/

/** Static banner (respects --no-banner and --no-color). */
function printBanner(args) {
  if (!process.stdout.isTTY || args["no-banner"]) return;

  const useColor = !args["no-color"];
  const reset = useColor ? "\x1b[0m" : "";
  const green = useColor ? "\x1b[32m" : "";
  const cyan = useColor ? "\x1b[36m" : "";
  const white = useColor ? "\x1b[37m" : "";

  const block = `
${green}                   __
                  / _)
         .-^^^-/ /
     __/       /
    <__.|_|-|_|    ${reset}

${cyan}              T Y P A S A U R${reset}
${white}       JSON to TypeScript Model CLI${reset}
`;

  console.log(block);
}

function logInfo(options, message) {
  if (options && options.disableColorOutput) console.log(message);
  else console.log("\x1b[32m%s\x1b[0m", message);
}

/** Consistent error output (no emojis). */
function printError(message, args) {
  const useColor = !(args && args["no-color"]);
  const red = useColor ? "\x1b[31m" : "";
  const reset = useColor ? "\x1b[0m" : "";
  console.error(`${red}Error:${reset} ${message}`);
}

/* ============================================================================
 * CLI / Prompt Helpers
 * ==========================================================================*/

function parseCommandLineArguments(argvList) {
  const parsed = {};
  for (let i = 0; i < argvList.length; i++) {
    const key = argvList[i];
    const next = argvList[i + 1];

    if (key === "--model-name") parsed["model-name"] = next;
    else if (key === "--input-json") parsed["input-json"] = next;
    else if (key === "--out") parsed["out"] = next;
    else if (key === "--interface") parsed["interface"] = true;
    else if (key === "--no-dates") parsed["no-dates"] = true;
    else if (key === "--string-enum-min") parsed["string-enum-min"] = next;
    else if (key === "--string-enum-max") parsed["string-enum-max"] = next;
    else if (key === "--no-banner") parsed["no-banner"] = true;
    else if (key === "--no-color") parsed["no-color"] = true;
  }
  return parsed;
}

function promptSingleLine(questionText) {
  return new Promise((resolve) => {
    process.stdout.write(questionText);
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      rl.close();
      resolve(line);
    });
  });
}

/**
 * Read JSON from user until it's valid and balanced. Generates as soon as JSON parses.
 * Clear error messages are printed by main() if parse fails at the end.
 */
function promptJsonUntilValid(messageText) {
  return new Promise((resolve) => {
    console.log(messageText);
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    let buffer = "";
    let depth = 0;        // {} and [] balance
    let inString = false; // within "
    let escaped = false;  // previous char was backslash

    function updateBalance(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (inString) {
          if (escaped) { escaped = false; continue; }
          if (ch === "\\") { escaped = true; continue; }
          if (ch === "\"") { inString = false; continue; }
        } else {
          if (ch === "\"") { inString = true; continue; }
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          else if (ch === "[") depth++;
          else if (ch === "]") depth--;
        }
      }
    }

    rl.on("line", (line) => {
      const chunk = (buffer ? "\n" : "") + line;
      buffer += chunk;
      updateBalance(chunk);

      if (depth === 0 && !inString) {
        try {
          JSON.parse(buffer);
          rl.close();
          resolve(buffer);
          return;
        } catch {
          // keep reading until it's valid or user closes input
        }
      }
    });

    rl.on("close", () => {
      // Final attempt; main() will print a clear error if invalid
      resolve(buffer);
    });

    process.stdout.write("(Tip: multi-line paste is fine. Press Enter after the last line, or Ctrl+D to finish.)\n");
  });
}

function readAllFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", (e) => reject(e));
  });
}

/* ============================================================================
 * Utilities
 * ==========================================================================*/

function isIsoLikeDateString(s) {
  // YYYY-MM-DD or full ISO with time/zone
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(s);
}
function arrayContainsOnlyStrings(arr) {
  return arr.every((v) => typeof v === "string");
}
function mergeStringLiteralSets(a, b) {
  if (!a && !b) return undefined;
  const set = new Set([...(a || []), ...(b || [])]);
  return [...set];
}
function numericOrDefault(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}
function isValidTypescriptIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
function singularizeWord(word) {
  const text = String(word || "");
  if (/ies$/i.test(text)) return text.replace(/ies$/i, "y");
  if (/ses$/i.test(text)) return text.replace(/es$/i, "s");
  if (/xes$|zes$|ches$|shes$/i.test(text)) return text.replace(/es$/i, "");
  if (/s$/i.test(text) && !/ss$/i.test(text)) return text.slice(0, -1);
  return text || "Item";
}
function toPascalCase(input) {
  return String(input)
    .replace(/[#@~`^$%&*()+={}$begin:math:display$$end:math:display$|\\:;"'<>,.?/!-]/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
function stringifyMaybeError(e) {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  try { return JSON.stringify(e); } catch { return String(e); }
}

module.exports = { main };