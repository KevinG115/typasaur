function promptSingleLine(questionText) {
  return new Promise((resolve) => {
    process.stdout.write(questionText);
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => { rl.close(); resolve(line); });
  });
}

/**
 * Interactive JSON input with multiple end mechanisms:
 * - Type ":end" on its own line
 * - Or wrap input in ``` code fences and close them
 * - Or press Enter on a blank line once the JSON is valid & balanced
 * - EOF still works where supported (Ctrl+D / Ctrl+Z+Enter)
 */
function promptJsonUntilValid(messageText) {
  return new Promise((resolve) => {
    const platform = process.platform;
    const eofHint = platform === "win32" ? "Ctrl+Z then Enter" : "Ctrl+D";

    console.log(messageText);
    console.log(
      `(Tip: End with :end on its own line, or close a \`\`\` code fence, or press Enter on an empty line after valid JSON. ${eofHint} may also work.)`
    );

    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    let buffer = "";
    let depth = 0, inString = false, escaped = false, inFence = false;

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
    function bufferIsValidJson() { try { JSON.parse(buffer); return true; } catch { return false; } }

    rl.on("line", (line) => {
      const trimmed = line.trim();

      if (trimmed === ":end" || trimmed === "END" || trimmed === "EOF") {
        rl.close(); return;
      }
      if (trimmed === "```") {
        if (!inFence) { inFence = true; buffer = ""; }
        else { inFence = false; rl.close(); }
        return;
      }

      const chunk = (buffer ? "\n" : "") + line;
      buffer += chunk;

      if (!inFence) {
        updateBalance(chunk);

        if (depth === 0 && !inString) {
          if (trimmed === "" && bufferIsValidJson()) { rl.close(); return; }
          if (bufferIsValidJson()) { rl.close(); return; }
        }
      }
    });

    rl.on("close", () => resolve(buffer));
  });
}

function readAllFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", (e) => reject(e));
  });
}

module.exports = { promptSingleLine, promptJsonUntilValid, readAllFromStdin };