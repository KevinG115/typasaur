const {
  isIsoLikeDateString,
  isValidTypescriptIdentifier,
  singularizeWord
} = require("../utils");

test("isIsoLikeDateString", () => {
  expect(isIsoLikeDateString("2025-08-16")).toBe(true);
  expect(isIsoLikeDateString("2025-08-16T12:34:56Z")).toBe(true);
  expect(isIsoLikeDateString("16/08/2025")).toBe(false);
});

test("isValidTypescriptIdentifier", () => {
  expect(isValidTypescriptIdentifier("goodName_1")).toBe(true);
  expect(isValidTypescriptIdentifier("1bad")).toBe(false);
  expect(isValidTypescriptIdentifier("has-dash")).toBe(false);
});

test("singularizeWord", () => {
  expect(singularizeWord("projects")).toBe("project");
  expect(singularizeWord("companies")).toBe("company");
  expect(singularizeWord("boss")).toBe("boss"); // not "bos"
});