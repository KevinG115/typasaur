const fs = require("fs");
const path = require("path");
const { inferTypeFromValue } = require("../infer");

describe("inferTypeFromValue", () => {
  const options = {
    detectDatesFromIsoStrings: true,
    stringEnumMinUniqueValues: 2,
    stringEnumMaxUniqueValues: 12
  };

  test("infers primitives correctly", () => {
    expect(inferTypeFromValue("hello", options)).toMatchObject({ kind: "string", isDate: false });
    expect(inferTypeFromValue(42, options)).toEqual({ kind: "number" });
    expect(inferTypeFromValue(true, options)).toEqual({ kind: "boolean" });
    expect(inferTypeFromValue(null, options)).toEqual({ kind: "any" });
  });

  test("detects ISO-like date strings", () => {
    const t = inferTypeFromValue("2025-08-16T12:34:56Z", options);
    expect(t.kind).toBe("string");
    expect(t.isDate).toBe(true);
  });

  test("treats arrays of short token-like strings as enums", () => {
    const t = inferTypeFromValue(["admin", "editor", "editor"], options);
    expect(t.kind).toBe("array");
    expect(t.items.kind).toBe("string");
    expect(new Set(t.items.enumValues)).toEqual(new Set(["admin", "editor"]));
  });

  test("unifies arrays of objects and preserves optional fields", () => {
    const value = [{ a: 1, b: "x" }, { a: 2 }];
    const t = inferTypeFromValue(value, options);
    expect(t.kind).toBe("array");
    expect(t.items.kind).toBe("object");
    const map = t.items.fields;
    expect(map.get("a").required).toBe(true);
    expect(map.get("b").required).toBe(false);
  });

  test("complex fixture parses into object tree", () => {
    const json = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "test-data", "complex.json"), "utf8")
    );
    const t = inferTypeFromValue(json, options);
    expect(t.kind).toBe("object");
    expect(t.fields.has("profile")).toBe(true);
    expect(t.fields.has("projects")).toBe(true);
  });
});