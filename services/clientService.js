import {
  appendConversation,
  getOrCreateLeadByPhone,
  hasNotification,
  updateLead,
} from "./leadService.js";
import { generateAiReply, detectGreeting, todayAlmatyDate } from "./aiService.js";
import { sendWhatsAppMessage } from "./whatsappService.js";
import { toChatId } from "./phoneService.js";
import {
  notifyClientReplied,
  notifyImportantEvent,
  notifyNewLead,
} from "./notificationService.js";
import { log } from "./logger.js";

const chatLocks = new Map();

const TRIVIAL_RE =
  /^(здравствуйте|здравстуйте|добрый день|добрый вечер|доброе утро|привет|хай|hello|hi|сколько стоит\??|цена\??|стоимость\??)[\s!.?]*$/i;

const SERVICE_RE =
  /сайт|лендинг|реклам|презентац|магазин|ai[\s-]?менеджер|google ads|tiktok/i;

function withChatLock(chatId, task) {
  const key = String(chatId || "unknown");
  const run = (chatLocks.get(key) || Promise.resolve())
    .catch(() => {})
    .then(task);
  const tracked = run.finally(() => {
    if (chatLocks.get(key) === tracked) {
      chatLocks.delete(key);
    }
  });
  chatLocks.set(key, tracked);
  return run;
}

export function describeIncomingMedia(file) {
  if (!file) {
    return "";
  }

  const kind =
    file.type === "imageMessage" || file.type === "stickerMessage"
      ? "изображение"
      : file.type === "videoMessage"
        ? "видео"
        : file.type === "documentMessage"
          ? "файл"
          : "вложение";
  const name = String(file.fileName || "").trim();
  const caption = String(file.caption || "").trim();
  const label = name ? `${kind} «${name}»` : kind;
  return `[Клиент отправил ${label}]${caption ? `\n${caption}` : ""}`;
}

export function buildClientMessageWithMedia(message, media = []) {
  const text = String(message || "").trim();
  const mediaNotes = (Array.isArray(media) ? media : [])
    .map((file) => {
      const caption = String(file.caption || "").trim();
      const note = describeIncomingMedia({
        ...file,
        caption: caption && text.includes(caption) ? "" : caption,
      });
      return note;
    })
    .filter(Boolean);
  if (text && mediaNotes.every((note) => text.includes(note))) {
    return text;
  }
  return [...mediaNotes, text].filter(Boolean).join("\n").trim();
}

function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSimilarReply(next, previous) {
  const a = normalizeForCompare(next);
  const b = normalizeForCompare(previous);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.includes(b) || b.includes(a)) {
    return a.length > 24 && b.length > 24;
  }

  const stop = new Set([
    "это",
    "для",
    "или",
    "как",
    "что",
    "вам",
    "вас",
    "мы",
    "нас",
    "если",
    "здесь",
    "сюда",
    "этот",
    "этой",
    "также",
    "просто",
    "очень",
  ]);
  const tokens = (text) =>
    text.split(" ").filter((word) => word.length >= 4 && !stop.has(word));
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) {
    return false;
  }

  let overlap = 0;
  for (const word of left) {
    if (right.has(word)) {
      overlap += 1;
    }
  }

  if (overlap >= 3 && overlap / Math.min(left.size, right.size) >= 0.55) {
    return true;
  }

  const sameAsk = [
    /сайт[аеу]?.{0,20}реклам.{0,20}презентац/i,
    /отправ.{0,24}картин/i,
    /картинк[уиа].{0,24}отправ/i,
  ];
  return sameAsk.some((pattern) => pattern.test(next) && pattern.test(previous));
}

function isTrivialMessage(message) {
  return TRIVIAL_RE.test(String(message || "").trim());
}

function mentionsService(message) {
  return SERVICE_RE.test(String(message || ""));
}

function mapPipelineStatus(result, current) {
  if (result?.pipeline_status) {
    return result.pipeline_status;
  }
  if (result?.lead_status === "hot") {
    return current === "new" ? "hot" : current === "qualified" ? "hot" : "hot";
  }
  if (result?.lead_status === "warm" && current === "new") {
    return "qualified";
  }
  return current || "new";
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "" && value !== "unknown") {
      return value;
    }
  }
  return null;
}

function hasSubstantiveData(lead, result, message) {
  const service = pickValue(lead.service, result?.service);
  return Boolean(
    lead.company ||
      lead.clientName ||
      lead.requestSummary ||
      lead.budget ||
      lead.deadline ||
      (service && service !== "unknown") ||
      result?.brief_completed ||
      mentionsService(message) ||
      (!isTrivialMessage(message) && String(message).trim().length >= 18),
  );
}

function shouldNotifyNewLead(lead, result, message) {
  if (hasNotification(lead, "new_lead")) {
    return false;
  }
  if (lead.source === "manager_outbound") {
    return false;
  }
  if (isTrivialMessage(message) && !lead.company && !lead.clientName && !mentionsService(message)) {
    return false;
  }
  return hasSubstantiveData(lead, result, message);
}

async function handleClientMessageUnlocked({
  chatId,
  message,
  senderName,
  media = [],
  shouldAbort,
}) {
  const fullMessage = buildClientMessageWithMedia(message, media);
  log("CLIENT", {
    chatId,
    message: fullMessage.slice(0, 240),
    files: (Array.isArray(media) ? media : []).map((file) => file.fileName || file.type),
  });

  if (!fullMessage) {
    return { skipped: true, reason: "empty" };
  }

  const lead = await getOrCreateLeadByPhone(chatId, {
    source: "inbound",
    direction: "inbound",
  });

  let current = lead;
  if (senderName && !current.clientName) {
    current = await updateLead(current.leadId, { clientName: senderName });
  }

  if (current.aiMode === "HUMAN" || current.aiMode === "PAUSED") {
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    await notifyImportantEvent(
      current,
      "client_message_while_paused",
      `Клиент написал:\n«${fullMessage.slice(0, 400)}»`,
    );
    log("MODE CHANGE", {
      leadId: current.leadId,
      skippedReply: true,
      aiMode: current.aiMode,
    });
    return { skipped: true, reason: current.aiMode, leadId: current.leadId };
  }

  if (shouldAbort?.()) {
    return { aborted: true, leadId: current.leadId };
  }

  const history = current.conversationHistory || [];
  const lastAi = current.lastAIMessage || "";
  let { reply, result, latencyMs } = await generateAiReply({
    message: fullMessage,
    history,
    lead: current,
  });

  if (shouldAbort?.()) {
    return { aborted: true, leadId: current.leadId };
  }

  if (isSimilarReply(reply, lastAi)) {
    ({ reply, result, latencyMs } = await generateAiReply({
      message: fullMessage,
      history,
      lead: current,
      extraInstruction: [
        `Ты уже отправил клиенту: «${lastAi}».`,
        "Не повторяй те же вопросы и формулировки.",
        "Не проси прислать файл, картинку или данные, которые уже есть в истории.",
        "Ответь по-новому с учётом всех свежих сообщений и вложений.",
      ].join(" "),
    }));
  }

  if (shouldAbort?.()) {
    return { aborted: true, leadId: current.leadId };
  }

  if (isSimilarReply(reply, lastAi)) {
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    log("AI RESPONSE", {
      leadId: current.leadId,
      skippedReply: true,
      reason: "repeat",
    });
    return { skipped: true, reason: "repeat", leadId: current.leadId };
  }

  const nextStatus = mapPipelineStatus(result, current.status);
  const patch = {
    clientName: pickValue(result.client_name, current.clientName),
    company: pickValue(result.company, current.company),
    service: pickValue(result.service, current.service),
    requestSummary: pickValue(result.summary, result.requestSummary, current.requestSummary),
    budget: pickValue(result.budget, current.budget),
    deadline: pickValue(result.deadline, current.deadline),
    status: nextStatus,
  };

  if (detectGreeting(reply) && !current.lastGreetingDate) {
    patch.lastGreetingDate = todayAlmatyDate();
  } else if (detectGreeting(reply) && current.lastGreetingDate !== todayAlmatyDate()) {
    patch.lastGreetingDate = todayAlmatyDate();
  }

  current = await updateLead(current.leadId, patch);
  current = await appendConversation(current.leadId, [
    { role: "user", content: fullMessage },
    { role: "assistant", content: reply },
  ]);

  await sendWhatsAppMessage(toChatId(current.clientPhone) || chatId, reply);

  if (current.source === "manager_outbound" && !hasNotification(current, "client_replied")) {
    await notifyClientReplied(current, fullMessage);
    current = { ...current, notificationEvents: [...(current.notificationEvents || []), "client_replied"] };
  }

  if (shouldNotifyNewLead(current, result, fullMessage)) {
    await notifyNewLead(current);
  }

  const event = result?.manager_event;
  if (event && event !== "null") {
    await notifyImportantEvent(current, event, result.manager_event_note || result.summary);
  }

  log("AI RESPONSE", {
    leadId: current.leadId,
    latencyMs,
    status: current.status,
  });

  return { leadId: current.leadId, reply, result, latencyMs };
}

export async function handleClientMessage(args) {
  return withChatLock(args.chatId, () => handleClientMessageUnlocked(args));
}
