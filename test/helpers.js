// test/helpers.js — small builders for fake fetch Response objects.

export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A response whose body is not valid JSON (exercises sfRequest's text fallback).
export function textResponse(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}
