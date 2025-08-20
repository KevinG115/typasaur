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

  const platform = process.platform;
  const eofHint = platform === "win32" ? "Ctrl+Z then Enter" : "Ctrl+D";
  console.log(
    `Hint: End JSON input with ":end" on its own line, or close a \`\`\` code fence, or press Enter on a blank line after valid JSON. ${eofHint} may also work.\n`
  );
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
  ${cyan}--out${reset} ${yellow}<file>${reset}              Output file (default: <model-name>.ts)
  ${cyan}--interface${reset}               Use 'interface' instead of 'type'
  ${cyan}--no-dates${reset}                Do not infer ISO strings as Date
  ${cyan}--string-enum-min${reset} ${yellow}<n>${reset}     Min unique strings to form a union (default: 2)
  ${cyan}--string-enum-max${reset} ${yellow}<n>${reset}     Max unique strings to form a union (default: 12)
  ${cyan}--no-banner${reset}               Disable ASCII banner
  ${cyan}--no-color${reset}                Disable colored output
  ${cyan}--target${reset} ${yellow}<ts>${reset}            Target language (default: ts)
  ${cyan}--no-telemetry${reset}            Disable telemetry for this run
`);
}

function logInfo(args, message) {
  const useColor = !args["no-color"];
  if (!useColor) console.log(message);
  else console.log("\x1b[32m%s\x1b[0m", message);
}

function printError(message, args) {
  const useColor = !args["no-color"];
  const red = useColor ? "\x1b[31m" : "";
  const reset = useColor ? "\x1b[0m" : "";
  console.error(`${red}Error:${reset} ${message}`);
}

module.exports = { printBanner, printUsage, logInfo, printError };