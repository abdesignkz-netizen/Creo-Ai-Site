import { normalizePhone } from "./phoneService.js";
import { withStore, getStoreSnapshot } from "./leadStore.js";
import { log } from "./logger.js";

const ACTIVE_STATUSES = new Set([
  "new",
  "qualified",
  "proposal",
  "negotiation",
  "hot",
  "paused",
]);

function nowIso() {
  return new Date().toISOString();
}

function createLeadId(counter) {
  return `LEAD-${String(counter).padStart(4, "0")}`;
}

export function parseLeadId(text) {
  const match = String(text || "").toUpperCase().match(/LEAD-(\d{1,6})/);
  if (!match) {
    return null;
  }
  return `LEAD-${String(Number(match[1])).padStart(4, "0")}`;
}

export function createEmptyLead({
  leadId,
  clientPhone,
  source = "inbound",
  direction = "inbound",
}) {
  const timestamp = nowIso();
  return {
    leadId,
    clientPhone,
    clientName: null,
    company: null,
    service: null,
    requestSummary: null,
    budget: null,
    deadline: null,
    source,
    direction,
    status: "new",
    aiMode: "AUTO",
    managerInstructions: [],
    conversationHistory: [],
    notificationEvents: [],
    lastClientMessage: "",
    lastAIMessage: "",
    lastGreetingDate: null,
    minPrice: null,
    goal: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function getLeadById(leadId) {
  if (!leadId) {
    return null;
  }
  const store = await getStoreSnapshot();
  return store.leads[leadId] || null;
}

export async function getLeadByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return null;
  }
  const store = await getStoreSnapshot();
  const leadId = store.phoneIndex[normalized];
  return leadId ? store.leads[leadId] || null : null;
}

export async function getOrCreateLeadByPhone(phone, extras = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error("Некорректный номер телефона");
  }

  return withStore((store) => {
    const existingId = store.phoneIndex[normalized];
    if (existingId && store.leads[existingId]) {
      return store.leads[existingId];
    }

    store.counter += 1;
    const leadId = createLeadId(store.counter);
    const lead = createEmptyLead({
      leadId,
      clientPhone: normalized,
      source: extras.source || "inbound",
      direction: extras.direction || "inbound",
    });
    store.leads[leadId] = lead;
    store.phoneIndex[normalized] = leadId;
    log("NEW LEAD", {
      leadId,
      clientPhone: normalized,
      source: lead.source,
    });
    return lead;
  });
}

export async function updateLead(leadId, updater) {
  return withStore((store) => {
    const lead = store.leads[leadId];
    if (!lead) {
      return null;
    }

    const patch = typeof updater === "function" ? updater(lead) : updater;
    const next = {
      ...lead,
      ...patch,
      leadId: lead.leadId,
      clientPhone: lead.clientPhone,
      updatedAt: nowIso(),
    };
    store.leads[leadId] = next;
    store.phoneIndex[next.clientPhone] = leadId;
    log("LEAD UPDATE", {
      leadId,
      status: next.status,
      aiMode: next.aiMode,
    });
    return next;
  });
}

export async function addManagerInstruction(leadId, instruction) {
  return updateLead(leadId, (lead) => ({
    managerInstructions: [
      ...(lead.managerInstructions || []),
      {
        ...instruction,
        createdAt: instruction.createdAt || nowIso(),
      },
    ],
  }));
}

export async function markNotification(leadId, eventKey) {
  return updateLead(leadId, (lead) => {
    const events = new Set(lead.notificationEvents || []);
    events.add(eventKey);
    return { notificationEvents: [...events] };
  });
}

export function hasNotification(lead, eventKey) {
  return Boolean(lead?.notificationEvents?.includes(eventKey));
}

export async function appendConversation(leadId, entries) {
  return updateLead(leadId, (lead) => {
    const history = [...(lead.conversationHistory || []), ...entries].slice(-120);
    const lastClient = [...entries].reverse().find((item) => item.role === "user");
    const lastAi = [...entries].reverse().find((item) => item.role === "assistant");
    return {
      conversationHistory: history,
      lastClientMessage: lastClient?.content || lead.lastClientMessage || "",
      lastAIMessage: lastAi?.content || lead.lastAIMessage || "",
    };
  });
}

export async function listActiveLeads() {
  const store = await getStoreSnapshot();
  return Object.values(store.leads)
    .filter((lead) => ACTIVE_STATUSES.has(lead.status) || lead.aiMode === "HUMAN")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function listAllLeads() {
  const store = await getStoreSnapshot();
  return Object.values(store.leads).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
}

export function isClosedStatus(status) {
  return status === "won" || status === "lost";
}
