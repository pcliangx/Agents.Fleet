// Deterministic JSON hashing shared by confirmation and immutable snapshots.
//
// Object keys use a locale-independent code-point ordering. Arrays retain
// order; nested objects are normalized recursively before serialization.

import { createHash } from "node:crypto";

const compareKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, sortDeep(child)]),
    );
  }
  return value;
};

export const canonicalizeJson = (value: unknown): string => {
  const serialized = JSON.stringify(sortDeep(value));
  if (serialized === undefined) {
    throw new TypeError("value is not JSON serializable");
  }
  return serialized;
};

export const canonicalSha256Hex = (value: unknown): string =>
  createHash("sha256").update(canonicalizeJson(value)).digest("hex");

export const canonicalSha256 = (value: unknown): string => `sha256:${canonicalSha256Hex(value)}`;
