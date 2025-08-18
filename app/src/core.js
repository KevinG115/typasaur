const fs = require("fs");
const path = require("path");
const telemetry = require("./telemetry.js");



// Ask once per machine if telemetry is allowed


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

  // After you compute `args` from process.argv:
  args._rawArgv = process.argv.slice(2); // so telemetry can scrub flag names

  const telemetryAllowed = await telemetry.getOrEstablishTelemetryPreference(args);
  if (telemetryAllowed) {
    telemetry.captureRunEvent(args);
  }

  printUsage(args);
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

    // 7) Render TypeScript (uses field-key-based naming)
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
 * - unions flattened/deduped (singletons collapse)
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
 * - Nested types named from JSON field keys (preserve key casing; uppercase first char)
 * - Root name kept exactly as entered
 * - Arrays of unions are parenthesized: ("a" | "b")[]
 */
function renderTypescriptFromTree({ rootTypeName, useInterfaceKeyword, rootTypeTree }) {
  const namedTypeDefinitions = [];
  const objectNodeToTypeName = new Map(); // object node -> generated name
  const usedTypeNames = new Set([rootTypeName]); // avoid collisions with root
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

  // Preserve existing key case, just ensure first character is uppercase.
  function nameFromJsonKey(jsonKey, isArrayItem = false) {
    const baseRaw = isArrayItem ? singularizeWord(jsonKey || "Item") : (jsonKey || "Model");
    if (!baseRaw) return "Model";
    return baseRaw[0].toUpperCase() + baseRaw.slice(1);
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
    const inner = renderTypeNode(itemNode, parentArrayJsonKey, true);
    const needsParens =
      itemNode.kind === "union" ||
      (itemNode.kind === "string" && itemNode.enumValues && itemNode.enumValues.length > 0);
    return needsParens ? `(${inner})[]` : `${inner}[]`;
  }

  function renderTypeNode(typeNode, parentJsonKey, inArray = false) {
    switch (typeNode.kind) {
      case "any":     return "any";
      case "number":  return "number";
      case "boolean": return "boolean";
      case "string":
        if (typeNode.enumValues && typeNode.enumValues.length) {
          return typeNode.enumValues.map((v) => JSON.stringify(v)).join(" | ");
        }
        return typeNode.isDate ? "string | Date" : "string";
      case "union":
        return typeNode.types.map((t) => renderTypeNode(t, parentJsonKey, inArray)).join(" | ");
      case "array":
        return renderArrayType(typeNode.items, parentJsonKey);
      case "object": {
        const lines = ["{"];

        const sorted = [...typeNode.fields.entries()].sort(([a], [b]) => a.localeCompare(b));

        for (const [fieldName, fieldInfo] of sorted) {
          const optional = fieldInfo.required ? "" : "?";
          const safeKey = isValidTypescriptIdentifier(fieldName) ? fieldName : JSON.stringify(fieldName);

          let tsType;
          if (fieldInfo.type.kind === "object") {
            const child = ensureNamedTypeForObject(fieldInfo.type, fieldName, false);
            tsType = child;
          } else if (fieldInfo.type.kind === "array" && fieldInfo.type.items.kind === "object") {
            const itemName = ensureNamedTypeForObject(fieldInfo.type.items, fieldName, true);
            tsType = `${itemName}[]`;
          } else if (fieldInfo.type.kind === "array") {
            tsType = renderArrayType(fieldInfo.type.items, fieldName);
          } else {
            tsType = renderTypeNode(fieldInfo.type, fieldName);
          }

          lines.push(`  ${safeKey}${optional}: ${tsType};`);
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

  const rootBody = renderTypeNode(rootTypeTree, rootTypeName);
  const rootDecl = `export ${typeKeyword} ${rootTypeName} = ${rootBody};`;

  return [header, ...namedTypeDefinitions, rootDecl].join("\n\n") + "\n";
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

function printUsage(parsedArgs) {
  const useColor = !parsedArgs["no-color"];
  const cyan = useColor ? "\x1b[36m" : "";
  const yellow = useColor ? "\x1b[33m" : "";
  const reset = useColor ? "\x1b[0m" : "";

  console.log(`
${cyan}Usage:${reset}
  typasaur [options]

${cyan}Options:${reset}
  ${cyan}--model-name${reset} ${yellow}<Name>${reset}       Name of the root type (e.g., User, OrderItem)
  ${cyan}--input-json${reset} ${yellow}<file>${reset}       Path to a JSON file to generate from
  ${cyan}--out${reset} ${yellow}<file>${reset}              Output TypeScript file (default: <model-name>.ts)
  ${cyan}--interface${reset}               Use 'interface' instead of 'type'
  ${cyan}--no-dates${reset}                Do not infer ISO strings as Date
  ${cyan}--string-enum-min${reset} ${yellow}<n>${reset}     Minimum unique string values to form a union (default: 2)
  ${cyan}--string-enum-max${reset} ${yellow}<n>${reset}     Maximum unique string values to form a union (default: 12)
  ${cyan}--no-banner${reset}               Disable ASCII dinosaur banner
  ${cyan}--no-color${reset}                Disable colored output
`);
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
 * Interactive JSON input with multiple end mechanisms:
 * - Type ":end" on its own line
 * - Or wrap input in ``` code fences and close them
 * - Or press Enter on a blank line once the JSON is valid & balanced
 * - EOF still works where supported (Ctrl+D on macOS/Linux, Ctrl+Z+Enter on Windows)
 */
function promptJsonUntilValid(messageText) {
  return new Promise((resolve) => {
    const platform = process.platform;
    const eofHint = platform === "win32" ? "Ctrl+Z then Enter" : "Ctrl+D";

    console.log(messageText);
    console.log(
      `(Tip: multi-line paste is fine. End with :end on its own line, or close a \`\`\` code fence, or press Enter on an empty line after valid JSON. ${eofHint} may also work.)`
    );

    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    let buffer = "";
    let depth = 0;         // {} [] balance
    let inString = false;  // inside "..."
    let escaped = false;   // previous char was backslash
    let inFence = false;   // between ``` ... ```

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

    function bufferIsValidJson() {
      try { JSON.parse(buffer); return true; } catch { return false; }
    }

    rl.on("line", (line) => {
      const trimmed = line.trim();

      // 1) Sentinel end tokens
      if (trimmed === ":end" || trimmed === "END" || trimmed === "EOF") {
        rl.close();
        return;
      }

      // 2) Code fences: open/close with ```
      if (trimmed === "```") {
        if (!inFence) {
          inFence = true;
          buffer = ""; // start fresh inside fence
        } else {
          inFence = false;
          rl.close(); // close fence => finish
        }
        return;
      }

      // 3) Append line
      const chunk = (buffer ? "\n" : "") + line;
      buffer += chunk;

      // While inside code fence, skip balance checks; wait for closing fence
      if (!inFence) {
        updateBalance(chunk);

        // 4) If JSON is valid & balanced, allow a blank line to finish
        if (depth === 0 && !inString) {
          if (trimmed === "" && bufferIsValidJson()) {
            rl.close();
            return;
          }
          // 5) Auto-finish immediately when it parses cleanly (user pasted all at once)
          if (bufferIsValidJson()) {
            rl.close();
            return;
          }
        }
      }
    });

    rl.on("close", () => {
      // Final return of whatever we have; caller will validate and error if invalid
      resolve(buffer);
    });
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
function stringifyMaybeError(e) {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  try { return JSON.stringify(e); } catch { return String(e); }
}

module.exports = { main };