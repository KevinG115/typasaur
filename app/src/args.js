function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--model-name") out["model-name"] = v;
    else if (k === "--input-json") out["input-json"] = v;
    else if (k === "--out") out["out"] = v;
    else if (k === "--interface") out["interface"] = true;
    else if (k === "--no-dates") out["no-dates"] = true;
    else if (k === "--string-enum-min") out["string-enum-min"] = v;
    else if (k === "--string-enum-max") out["string-enum-max"] = v;
    else if (k === "--no-banner") out["no-banner"] = true;
    else if (k === "--no-color") out["no-color"] = true;
    else if (k === "--target") out["target"] = v;
    else if (k === "--no-telemetry") out["no-telemetry"] = true;
  }
  return out;
}

module.exports = { parseArgs };