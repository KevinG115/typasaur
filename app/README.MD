# Typasaur 

### JSON → TypeScript Model CLI

[![npm version](https://img.shields.io/npm/v/typasaur.svg)](https://www.npmjs.com/package/typasaur)
[![npm downloads](https://img.shields.io/npm/dw/typasaur.svg)](https://www.npmjs.com/package/typasaur)
[![license](https://img.shields.io/npm/l/typasaur.svg)](./LICENSE)


Convert raw JSON into clean, readable TypeScript types or interfaces in seconds.

<img src="https://raw.githubusercontent.com/KevinG115/typasaur/main/app/assets/Typasaur.png " width="300">

## Features

- **One-step generation**: paste JSON and press Enter to generate a `.ts` file.
- **Readable names**: nested types are named from JSON keys  
  e.g. `profile` → `Profile`, `projects` → `Project[]`, `settings.notifications` → `Notifications`.
- **Smart inference**
  - `null` becomes `any` (and `any` dominates unions).
  - ISO-like date strings become `string | Date`.
  - Arrays of short token-like strings become string-literal unions, e.g. `("admin" | "editor")[]`.
- **File naming**: output file uses the model name lowercased, e.g. `User` → `user.ts`.
- **No dependencies**: single-file Node CLI.

## Install

```bash
npm install -g typasaur
```

## Usage

### Interactive (paste JSON)
```bash
typasaur
# Prompts:
# Model name (e.g., User, OrderItem): User
# Paste JSON and press Enter when done:
# { ...your JSON... }
# => generates user.ts in the current directory
```

### From a file
```bash
typasaur --model-name Order --input-json ./order.json
```

### With options
- `--interface` → generate `interface` instead of `type`
- `--no-dates` → don’t convert ISO strings to `Date`
- `--no-color` → plain log output
- `--out path.ts` → specify output file path

## Example

Input JSON:

```json
{
  "id": 123,
  "name": "Patrick",
  "profile": { "bio": "Dev", "age": 30 },
  "tags": ["typescript", "node"]
}
```

Output:

```ts
export type Profile = {
  age: number;
  bio: string;
};

export type User = {
  id: number;
  name: string;
  profile: Profile;
  tags: ("typescript" | "node")[];
};
```

## Contributing

PRs welcome! Ideas: smarter naming heuristics, config file, VS Code extension.

---

## Future Enhancements

- **Option to generate `interface` instead of `type`** (CLI flag)  
- **Config file support** (`typasaur.config.json`) to set defaults  
- **Smarter type inference**  
  - Detect `UUID` patterns → `string` but with a `Uuid` alias  
  - Detect currency/decimal numbers → `number` but optionally `Decimal`  
- **Custom naming strategies** (PascalCase, camelCase, etc.)  
- **Nested file output** → split models into multiple `.ts` files instead of one big file  
- **Array union collapsing** → automatically detect and compress unions of string literals  
- **VS Code extension** → right-click JSON → *Generate TypeScript Interface*  
- **Web playground** → paste JSON in browser → copy TS interface  
- **Schema support** → convert JSON Schema → TS  
- **Testing framework integration** → option to also generate fake/mock data for testing  

---

## License

MIT © Kevin Gleeson
