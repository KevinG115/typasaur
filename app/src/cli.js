const fs = require("fs");
const path = require("path");

const { parseArgs } = require("./args");
const { printBanner, printUsage, logInfo, printError } = require("./banner");
const { promptSingleLine, promptJsonUntilValid, readAllFromStdin } = require("./input");
// BEFORE (example)
// const { inferTypeFromValue } = require("./infer");
// const { renderTypescriptFromTree } = require("./renderers/typescript");

// AFTER (use compiled TS output)
const { inferTypeFromValue } = require("../dist/infer");
const { renderTypescriptFromTree } = require("../dist/renderers/typescript");

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  args._rawArgv = argv;

  printBanner(args);
  printUsage(args);

  // Telemetry TODO: Implement telemetry capture
  // This is currently commented out to avoid telemetry collection.
//   try {
//     const allowed = await telemetry.getOrEstablishTelemetryPreference(args);
//     if (allowed) telemetry.captureRunEvent(args);
//   } catch { /* non-fatal */ }

  try {
    // 1) Model name
    const modelName = (args["model-name"] || (await promptSingleLine("Model name (e.g., User, OrderItem): "))).trim();
    if (!modelName) {
      printError("No model name provided. Use --model-name or enter one when prompted.", args);
      process.exit(1);
    }

    // 2) Output target (for now only TypeScript; Java/Rust/Python later)
    const target = (args.target || "ts").toLowerCase();
    if (target !== "ts") {
      printError(`Unsupported target "${target}". Only "ts" is currently available.`, args);
      process.exit(1);
    }

    // 3) Gather JSON input
    const isTty = process.stdin.isTTY;
    let rawJson = "";
    if (args["input-json"]) {
      const p = path.resolve(process.cwd(), args["input-json"]);
      rawJson = fs.readFileSync(p, "utf8");
    } else if (!isTty) {
      rawJson = await readAllFromStdin();
    } else {
      rawJson = await promptJsonUntilValid("Paste JSON and press Enter when done:");
    }

    if (!rawJson || !rawJson.trim()) {
      printError("No JSON input detected. Paste valid JSON or use --input-json <file>.", args);
      process.exit(1);
    }

    // 4) Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      printError("Invalid JSON input. Please fix syntax (e.g., check commas and quotes).", args);
      process.exit(1);
    }

    // 5) Inference options
    const inferOptions = {
      detectDatesFromIsoStrings: !args["no-dates"],
      stringEnumMinUniqueValues: numberOr(args["string-enum-min"], 2),
      stringEnumMaxUniqueValues: numberOr(args["string-enum-max"], 12)
    };

    // 6) Infer internal tree
    const tree = inferTypeFromValue(parsed, inferOptions);

    // 7) Render
    let outText;
    let outPath = args.out;
    if (target === "ts") {
      outText = renderTypescriptFromTree({
        rootTypeName: modelName,
        useInterfaceKeyword: !!args.interface,
        rootTypeTree: tree
      });
      outPath = outPath || path.resolve(process.cwd(), `${modelName.toLowerCase()}.ts`);
    }

    // 8) Write file
    try {
      fs.writeFileSync(outPath, outText, "utf8");
    } catch {
      printError(
        `Could not write to output file "${path.relative(process.cwd(), outPath)}". Check path or permissions.`,
        args
      );
      process.exit(2);
    }

    logInfo(args, `Generated ${path.relative(process.cwd(), outPath)}`);
  } catch (e) {
    printError(`Unexpected internal error. ${e && e.message ? e.message : String(e)}`, args);
    process.exit(3);
  }
}

function numberOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { main };