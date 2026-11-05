import type { ApiContractStore } from "./types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function contractKey(method: string, pathname: string): string {
  const normalized = pathname
    .split("?")[0]!
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
  return `${method.toUpperCase()} ${normalized}`;
}

export function stripRejectedFields(body: unknown, rejected: ReadonlyArray<string>): unknown {
  if (!isObject(body) || !rejected.length) return body;
  const next = { ...body };
  for (const key of rejected) delete next[key];
  return next;
}

export function recordRejected(contracts: ApiContractStore, key: string, rejected: ReadonlyArray<string>): void {
  if (!rejected.length) return;
  const current = contracts[key];
  contracts[key] = {
    rejected: [...new Set([...(current?.rejected ?? []), ...rejected])],
    updatedAt: new Date().toISOString()
  };
}

function getContainer(body: unknown, path: ReadonlyArray<string | number>): unknown {
  let current = body;
  for (const part of path) {
    if (!isObject(current) && !Array.isArray(current)) return null;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function setContainerValue(body: unknown, path: ReadonlyArray<string | number>, value: unknown): boolean {
  if (!path.length) return false;
  let current = body;
  for (const part of path.slice(0, -1)) {
    if (!isObject(current) && !Array.isArray(current)) return false;
    current = (current as Record<string | number, unknown>)[part];
  }
  if (!isObject(current) && !Array.isArray(current)) return false;
  (current as Record<string | number, unknown>)[path.at(-1)!] = value;
  return true;
}

function validationIssues(errorBody: unknown): Array<Record<string, unknown>> {
  if (!isObject(errorBody)) return [];
  const details = errorBody.details;
  if (!Array.isArray(details)) return [];
  return details.filter(isObject);
}

export function repairApiBody(body: unknown, errorBody: unknown): { body: unknown; changed: boolean; rejected: string[] } | null {
  if (!isObject(body)) return null;
  const next = structuredClone(body);
  const rejected: string[] = [];
  let changed = false;

  for (const issue of validationIssues(errorBody)) {
    const path = Array.isArray(issue.path) ? issue.path as Array<string | number> : [];
    if (issue.code === "unrecognized_keys") {
      const keys = Array.isArray(issue.keys) ? issue.keys.filter((key): key is string => typeof key === "string") : [];
      const container = getContainer(next, path);
      if (isObject(container)) {
        for (const key of keys) {
          if (key in container) {
            delete container[key];
            rejected.push(key);
            changed = true;
          }
        }
      }
      continue;
    }
    if (issue.code === "too_big" && typeof issue.maximum === "number") {
      const current = getContainer(next, path);
      if (typeof current === "string" && current.length > issue.maximum) {
        changed = setContainerValue(next, path, current.slice(0, issue.maximum)) || changed;
      } else if (Array.isArray(current) && current.length > issue.maximum) {
        changed = setContainerValue(next, path, current.slice(0, issue.maximum)) || changed;
      }
    }
  }

  if (isObject(errorBody) && typeof errorBody.field === "string" && errorBody.field in next) {
    delete next[errorBody.field];
    rejected.push(errorBody.field);
    changed = true;
  }

  return changed ? { body: next, changed, rejected } : null;
}

export function formatApiErrorDetails(errorBody: unknown): string {
  const issues = validationIssues(errorBody);
  if (!issues.length) return "";
  const text = issues
    .slice(0, 3)
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
      const message = typeof issue.message === "string" ? issue.message : "";
      return [path, message].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
  return text ? ` (${text})` : "";
}
