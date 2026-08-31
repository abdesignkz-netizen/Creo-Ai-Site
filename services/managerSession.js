import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "manager-session.json");

let pendingOutbound = null;
let lastSend = null;
let loaded = false;

async function ensureLoaded() {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const data = JSON.parse(raw);
    pendingOutbound = data.pendingOutbound || null;
    lastSend = data.lastSend || null;
  } catch {
    pendingOutbound = null;
    lastSend = null;
  }
}

async function persist() {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(
    STORE_PATH,
    JSON.stringify({ pendingOutbound, lastSend }, null, 2),
    "utf-8",
  );
}

export async function setPendingOutbound(payload) {
  await ensureLoaded();
  pendingOutbound = {
    phone: payload.phone || "",
    draft: payload.draft || "",
    instruction: payload.instruction || "",
    fileCaption: payload.fileCaption || "",
    files: Array.isArray(payload.files) ? payload.files : [],
    createdAt: Date.now(),
  };
  await persist();
}

export async function getPendingOutbound() {
  await ensureLoaded();
  if (!pendingOutbound) {
    return null;
  }
  if (Date.now() - pendingOutbound.createdAt > 30 * 60 * 1000) {
    pendingOutbound = null;
    await persist();
    return null;
  }
  return pendingOutbound;
}

export async function clearPendingOutbound() {
  await ensureLoaded();
  pendingOutbound = null;
  await persist();
}

export async function setLastSend(payload) {
  await ensureLoaded();
  lastSend = {
    phone: payload.phone,
    ok: Boolean(payload.ok),
    text: payload.text || "",
    error: payload.error || "",
    createdAt: Date.now(),
  };
  await persist();
}

export async function getLastSend() {
  await ensureLoaded();
  return lastSend;
}
