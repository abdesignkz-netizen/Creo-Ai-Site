import { formatPhoneDisplay } from "./phoneService.js";
import { hasNotification, markNotification } from "./leadService.js";
import { sendManagerMessage, sendWhatsAppMessage } from "./whatsappService.js";
import { getManagerChatId } from "./phoneService.js";
import { log } from "./logger.js";

function label(value) {
  if (value === undefined || value === null || value === "" || value === "unknown") {
    return "не выяснено";
  }
  return value;
}

function serviceLabel(service) {
  const labels = {
    site: "сайт",
    ads: "реклама",
    site_ads: "сайт + реклама",
    presentation: "презентация",
    ai_manager: "AI-менеджер",
  };
  return labels[service] || label(service);
}

export function formatNewLeadNotification(lead) {
  return [
    "🔥 НОВЫЙ ЛИД",
    "",
    lead.leadId,
    "",
    `Клиент: ${label(lead.clientName)}`,
    `Телефон: ${formatPhoneDisplay(lead.clientPhone)}`,
    `Компания: ${label(lead.company)}`,
    `Интерес: ${serviceLabel(lead.service)}`,
    `Задача: ${label(lead.requestSummary)}`,
    `Бюджет: ${label(lead.budget)}`,
    `Срок: ${label(lead.deadline)}`,
    "",
    "Статус: первичный контакт состоялся.",
    "",
    "🤖 AI продолжает вести клиента автоматически.",
    "",
    "Вы можете дать AI рекомендацию или команду.",
    "",
    "Например:",
    `${lead.clientPhone} узнай бюджет`,
    `${lead.clientPhone} сделай акцент на скорости`,
    `${lead.clientPhone} отправь КП`,
    `${lead.clientPhone} попробуй довести до созвона`,
    `${lead.clientPhone} ниже 350000 не опускайся`,
    `${lead.clientPhone} остановись`,
  ].join("\n");
}

export async function notifyIfNeeded(lead, eventKey, text) {
  if (!lead?.leadId || !eventKey || hasNotification(lead, eventKey)) {
    return false;
  }

  await sendManagerMessage(text);
  await markNotification(lead.leadId, eventKey);
  log("NOTIFICATION", { leadId: lead.leadId, eventKey });
  return true;
}

export async function notifyNewLead(lead) {
  return notifyIfNeeded(lead, "new_lead", formatNewLeadNotification(lead));
}

export async function notifyClientReplied(lead, message) {
  const text = [
    "💬 КЛИЕНТ ОТВЕТИЛ",
    "",
    lead.leadId,
    `Телефон: ${formatPhoneDisplay(lead.clientPhone)}`,
    lead.clientName ? `Клиент: ${lead.clientName}` : null,
    "",
    "Ответ:",
    `"${String(message || "").slice(0, 500)}"`,
    "",
    "AI продолжает диалог автоматически.",
  ]
    .filter(Boolean)
    .join("\n");

  return notifyIfNeeded(lead, "client_replied", text);
}

export async function notifyImportantEvent(lead, eventKey, note) {
  const titles = {
    hot_lead: "🔥 ГОРЯЧИЙ ЛИД",
    price_request: "💰 PRICE / DISCOUNT REQUEST",
    decision_required: "⚠️ ТРЕБУЕТСЯ РЕШЕНИЕ",
    ready_to_start: "✅ CLIENT READY TO START",
    refused: "❌ CLIENT REFUSED",
    wants_call: "📞 CLIENT WANTS CALL",
    client_message_while_paused: "⏸ КЛИЕНТ НАПИСАЛ, AI НА ПАУЗЕ",
  };

  const title = titles[eventKey] || "⚠️ СОБЫТИЕ";
  const who = [lead.clientName, lead.company].filter(Boolean).join(" / ") || "клиент";

  const lines = [
    title,
    "",
    lead.leadId,
    who,
    "",
    note || "Требуется внимание менеджера.",
  ];

  if (eventKey === "decision_required") {
    lines.push("", "Как действовать?");
  } else if (eventKey !== "client_message_while_paused") {
    lines.push("", "AI продолжает диалог автоматически.");
  }

  return notifyIfNeeded(lead, eventKey, lines.join("\n"));
}

export async function notifyManagerRaw(text, senderChatId) {
  const destinations = [...new Set([senderChatId, getManagerChatId()].filter(Boolean))];
  let lastError = null;

  for (const chatId of destinations) {
    try {
      await sendWhatsAppMessage(chatId, text);
      log("NOTIFICATION", { raw: true, chatId });
      return true;
    } catch (error) {
      lastError = error;
      log("NOTIFICATION", { failed: true, chatId, error: error.message });
    }
  }

  if (!destinations.length) {
    await sendManagerMessage(text);
    return true;
  }

  if (lastError) {
    throw lastError;
  }
  return false;
}
