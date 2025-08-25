export type PrimitiveKind = "string" | "number" | "boolean" | "null";
export type TreeKind = PrimitiveKind | "object" | "array" | "union";

export type StringNode = { kind: "string"; example?: string };
export type NumberNode = { kind: "number"; example?: number };
export type BooleanNode = { kind: "boolean"; example?: boolean };
export type NullNode = { kind: "null" };

export type ObjectNode = {
  kind: "object";
  name?: string;                // <-- optional
  props: Record<string, TypeTree>;
};

export type ArrayNode = {
  kind: "array";
  element: TypeTree;
};

export type UnionNode = {
  kind: "union";
  options: TypeTree[];
};

export type TypeTree =
  | StringNode
  | NumberNode
  | BooleanNode
  | NullNode
  | ObjectNode
  | ArrayNode
  | UnionNode;

export interface InferOptions {
  detectDatesFromIsoStrings: boolean;
  stringEnumMinUniqueValues: number;
  stringEnumMaxUniqueValues: number;
}

export interface TsRenderOptions {
  useInterfaceKeyword: boolean;
  readonlyProps?: boolean;
  addDocComments?: boolean;
}