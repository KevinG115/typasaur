const fs = require("fs");
const path = require("path");
const { inferTypeFromValue } = require("../infer");
const { renderTypescriptFromTree } = require("../renderers/typescript");

describe("renderTypescriptFromTree", () => {
  const options = {
    detectDatesFromIsoStrings: true,
    stringEnumMinUniqueValues: 2,
    stringEnumMaxUniqueValues: 12
  };

  test("renders clean types with field-based names and header", () => {
    const input = {
      email: "a@b.com",
      id: 1,
      isActive: true,
      signupDate: "2025-08-16T12:34:56Z",
      profile: { age: 30, bio: null, socialLinks: ["x", "y"] },
      projects: [{ id: "p1", title: "T", completed: false }],
      roles: ["admin", "editor"]
    };

    const tree = inferTypeFromValue(input, options);
    const ts = renderTypescriptFromTree({
      rootTypeName: "User",
      useInterfaceKeyword: false,
      rootTypeTree: tree
    });

    expect(ts).toMatchSnapshot();
  });

  test("renders complex fixture deterministically", () => {
    const json = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "test-data", "complex.json"), "utf8")
    );
    const tree = inferTypeFromValue(json, options);
    const ts = renderTypescriptFromTree({
      rootTypeName: "Model",
      useInterfaceKeyword: true,
      rootTypeTree: tree
    });

    expect(ts).toMatchSnapshot();
  });
});