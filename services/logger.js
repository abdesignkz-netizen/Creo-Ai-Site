const SECRET_KEYS = /api[_-]?key|token|authorization|secret|password/i;

function sanitize(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = SECRET_KEYS.test(key) ? "[hidden]" : sanitize(item);
  }
  return next;
}

export function log(tag, payload) {
  if (payload === undefined) {
    console.log(`[${tag}]`);
    return;
  }

  if (typeof payload === "string") {
    console.log(`[${tag}]`, payload);
    return;
  }

  console.log(`[${tag}]`, sanitize(payload));
}
