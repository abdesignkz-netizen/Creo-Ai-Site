import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "data", "leads.json");

const emptyStore = () => ({
  counter: 0,
  leads: {},
  phoneIndex: {},
});

let cache = null;
let writeChain = Promise.resolve();

async function readStore() {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    cache = {
      counter: Number(parsed.counter) || 0,
      leads: parsed.leads || {},
      phoneIndex: parsed.phoneIndex || {},
    };
  } catch {
    cache = emptyStore();
  }

  return cache;
}

async function persist(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
}

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch((error) => {
    log("LEAD UPDATE", { persistError: error.message });
  });
  return run;
}

export async function withStore(mutator) {
  return enqueue(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await persist(store);
    return result;
  });
}

export async function getStoreSnapshot() {
  const store = await readStore();
  return store;
}

export function getStorePath() {
  return STORE_PATH;
}
