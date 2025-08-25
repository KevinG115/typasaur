import { inferTypeFromValue } from "../infer";
import { renderTypescriptFromTree } from "../renderers/typescript";

describe("TypeScript renderer naming & shapes", () => {
  test("keys map to PascalCase types; arrays singularize", () => {
    const sample = {
      id: 101,
      name: "Jane Doe",
      isActive: true,
      profile: {
        age: 29,
        city: "New York"
      },
      projects: [
        { id: "p1", title: "Build" },
        { id: "p2", title: "Ship" }
      ],
      misc: null
    };

    const tree = inferTypeFromValue(sample, {
      detectDatesFromIsoStrings: true,
      stringEnumMinUniqueValues: 2,
      stringEnumMaxUniqueValues: 12
    });

    const code = renderTypescriptFromTree({
      rootTypeName: "User",
      rootTypeTree: tree,
      useInterfaceKeyword: false
    });

    // Root type exists
    expect(code).toContain("export type User = {");

    // profile -> Profile (object becomes named type)
    expect(code).toContain("profile: Profile;");
    expect(code).toContain("export type Profile = {");
    expect(code).toContain("age: number;");
    expect(code).toContain("city: string;");

    // projects -> Project[] (array of objects becomes singular named type)
    expect(code).toContain("projects: Project[];");
    expect(code).toContain("export type Project = {");
    expect(code).toContain("id: string;");
    expect(code).toContain("title: string;");

    // null -> any
    expect(code).toContain("misc: any;");
  });

  test("interface mode uses 'interface' keyword", () => {
    const sample = { profile: { age: 1 } };
    const tree = inferTypeFromValue(sample, {
      detectDatesFromIsoStrings: true,
      stringEnumMinUniqueValues: 2,
      stringEnumMaxUniqueValues: 12
    });

    const code = renderTypescriptFromTree({
      rootTypeName: "User",
      rootTypeTree: tree,
      useInterfaceKeyword: true
    });

    expect(code).toContain("export interface User = {"); // if your renderer uses “interface” without “=”, adjust:
    // If your implementation defines interfaces as:
    //   export interface User { ... }
    // then use:
    // expect(code).toContain("export interface User {");
  });
});