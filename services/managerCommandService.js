import { extractPhoneCandidate, normalizePhone, stripPhoneFromText } from "./phoneService.js";
import { parseLeadId } from "./leadService.js";
import { parseManagerCommandWithAi } from "./aiService.js";
import { log } from "./logger.js";

const EXACT_RE =
  /(?:отправь|напиши дословно|передай дословно)\s*:\s*([\s\S]+)/i;

function cleanAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  const type = String(action.type || "").trim().toUpperCase();
  if (!type) {
    return null;
  }
  return {
    type,
    value: action.value ?? null,
    text: action.text ?? null,
  };
}

function parseByRules(message) {
  const text = String(message || "").trim();
  const leadId = parseLeadId(text);
  const phone = extractPhoneCandidate(text);
  const actions = [];

  if (/активные лиды|покажи лиды/i.test(text)) {
    actions.push({ type: "LIST_LEADS", value: null, text: null });
  }

  if (
    /что с\s+(lead-\d+|\+?[78][\d\s()-]{9,})|((lead-\d+)|(?:\+?[78]\d[\d\s()-]{8,})).+(что с ним|статус|как там)/i.test(
      text,
    ) ||
    /^(что с|статус|как там)\s/i.test(text)
  ) {
    actions.push({ type: "STATUS_QUERY", value: leadId || phone, text: null });
  }

  if (/остановись|пока не пиши/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "PAUSED", text: null });
  }

  if (/продолжай|верни ai/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "AUTO", text: null });
  }

  if (/отправил\??|ушло\??|дошло\??|отправилось\??|что написал/i.test(text)) {
    actions.push({ type: "LAST_SEND_STATUS", value: null, text: null });
  }

  const leftover = stripPhoneFromText(text).replace(/[!?.,]+/g, "").trim();
  const leftoverTask = leftover
    .replace(/на этот номер|на указанный номер|вот сюда|сюда|туда|отправь|перешли|направь/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (phone && leftover.length === 0) {
    actions.push({ type: "SEND_HERE", value: phone, text: null });
  } else if (phone && leftoverTask.length < 6 && /сюда|на этот номер|вот сюда/i.test(text)) {
    actions.push({ type: "SEND_HERE", value: phone, text: null });
  }

  if (/передай мне|забери клиента|human/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "HUMAN", text: null });
  }

  const exact = text.match(EXACT_RE);
  if (exact) {
    actions.push({
      type: "EXACT_MESSAGE",
      value: null,
      text: exact[1].trim(),
    });
  }

  const minPrice = text.match(/ниже\s+(\d[\d\s]*)\s*не опускайся|мин(?:имальн)?(?:ая)?\s*цен[аы]\s*(\d[\d\s]*)/i);
  if (minPrice) {
    const raw = minPrice[1] || minPrice[2];
    actions.push({
      type: "SET_MIN_PRICE",
      value: Number(String(raw).replace(/\s/g, "")),
      text: null,
    });
  }

  if (/скидк[ау]\s+(?:максимум\s+)?(\d{1,2})\s*%/i.test(text)) {
    const percent = text.match(/(\d{1,2})\s*%/);
    actions.push({
      type: "ADD_INSTRUCTION",
      value: `Максимальная скидка ${percent?.[1] || ""}%`,
      text: null,
    });
  }

  const fileHint = isFileSendCommand(text);
  if (fileHint) {
    actions.push({ type: "WAIT_FILE", value: phone, text: null });
  }

  const composeHint =
    !exact &&
    !fileHint &&
    /(скажи|объясни|предложи|уточни|узнай|напомин|нвпомин|напомани|попробуй|сделай акцент|отправь|закрой|доведи|подробност|заявк|напиши|свяжись|на этот номер|на указанный)/i.test(
      text,
    );
  if (composeHint && leftoverTask.length >= 6) {
    actions.push({
      type: "AI_COMPOSE",
      value: cleanComposeInstruction(text),
      text: null,
    });
  }

  return {
    leadId,
    phone,
    actions,
    source: "rules",
  };
}

function rulesAreComplete(parsed) {
  const types = new Set((parsed.actions || []).map((item) => item.type));
  if (types.has("LIST_LEADS") || types.has("LAST_SEND_STATUS")) {
    return true;
  }
  if (types.has("WAIT_FILE") && parsed.phone && !types.has("AI_COMPOSE") && !types.has("EXACT_MESSAGE")) {
    return true;
  }
  if (types.has("SEND_HERE") && parsed.phone && !types.has("AI_COMPOSE") && !types.has("EXACT_MESSAGE") && !types.has("ASK_CLIENT")) {
    return true;
  }
  if (types.has("STATUS_QUERY") && (parsed.phone || parsed.leadId)) {
    return true;
  }
  if (types.has("EXACT_MESSAGE") && (parsed.phone || parsed.leadId)) {
    return true;
  }
  if (types.has("SET_MODE") && (parsed.phone || parsed.leadId) && parsed.actions.length === 1) {
    return true;
  }
  if (
    (types.has("AI_COMPOSE") || types.has("ASK_CLIENT") || types.has("SET_MIN_PRICE")) &&
    (parsed.phone || parsed.leadId)
  ) {
    return true;
  }
  return false;
}

export async function parseManagerCommand(message) {
  const fallback = parseByRules(message);

  if (rulesAreComplete(fallback)) {
    log("MANAGER COMMAND", {
      leadId: fallback.leadId,
      phone: fallback.phone,
      actions: fallback.actions.map((item) => item.type),
      source: "rules",
    });
    return fallback;
  }

  try {
    const parsed = await parseManagerCommandWithAi(message);
    const actions = (parsed.actions || []).map(cleanAction).filter(Boolean);
    const merged = {
      leadId: parseLeadId(parsed.leadId) || fallback.leadId,
      phone: normalizePhone(parsed.phone) || fallback.phone,
      actions: actions.length ? actions : fallback.actions,
      source: "ai",
    };

    if (!merged.actions.length && fallback.actions.length) {
      merged.actions = fallback.actions;
    }

    log("MANAGER COMMAND", {
      leadId: merged.leadId,
      phone: merged.phone,
      actions: merged.actions.map((item) => item.type),
      source: merged.source,
    });
    return merged;
  } catch (error) {
    log("MANAGER COMMAND", { parseFallback: true, error: error.message });
    return fallback;
  }
}

const COMMAND_HINT_RE =
  /отправь|напиши|скажи|узнай|уточни|предложи|напомни|подробност|заявк|свяжись|остановись|продолжай|ниже|скидк|что с|активные лиды|покажи лиды/i;

const CONFIRM_SEND_RE =
  /^(да|ок|можно|подтверждаю)([,!.\s]+(отправь|перешли|направь|это|его|сообщение|клиенту|пожалуйста)*)*[.!]?\s*$/i;

const CONFIRM_SEND_SHORT_RE =
  /^(отправь|перешли|направь)(\s+(это|его|сообщение|номер|туда|клиенту|пожалуйста))*[.!]?\s*$/i;

const CANCEL_SEND_RE = /^(нет|не надо|отмена|отмени|стоп)([,!.\s]+(отправь|не надо|отмена|пожалуйста)*)*[.!]?\s*$/i;

export function looksLikeManagerCommand(message, senderPhone) {
  const text = String(message || "").trim();
  const target = extractPhoneCandidate(text);
  if (target && target !== normalizePhone(senderPhone) && COMMAND_HINT_RE.test(text)) {
    return true;
  }
  if (CONFIRM_SEND_RE.test(text) || CONFIRM_SEND_SHORT_RE.test(text)) {
    return true;
  }
  return /активные лиды|покажи лиды/i.test(text);
}

export function isConfirmSend(message) {
  const text = String(message || "").trim();
  if (extractPhoneCandidate(text) && stripPhoneFromText(text).length > 8) {
    return false;
  }
  return CONFIRM_SEND_RE.test(text) || CONFIRM_SEND_SHORT_RE.test(text);
}

export function isCancelSend(message) {
  return CANCEL_SEND_RE.test(String(message || "").trim());
}

export function isFileSendCommand(message) {
  const text = String(message || "").trim();
  if (/(напомин|нвпомин|напомани|скажи|узнай|уточни|напиши|предложи|объясни)/i.test(text)) {
    return false;
  }
  if (/прикрепи|вот (файл|фото|документ)/i.test(text)) {
    return true;
  }
  return /(отправь|перешли|направь)(\s+\S+){0,4}\s+(этот\s+|вот\s+|это\s+)?(файл|фото|документ|пдф|вложение|картинку|картинка)(\s|$|[.,!?])/i.test(
    text,
  );
}

export function cleanComposeInstruction(message) {
  return stripPhoneFromText(message)
    .replace(/(отправь|перешли|направь|напиши)\s+/gi, " ")
    .replace(
      /на\s+(этот\s+|указанный\s+)?номер|по\s+(этому\s+)?номеру|этому\s+клиенту|клиенту|вот\s+сюда|(^|\s)(сюда|туда)(?=\s|$)/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function describeActions(actions) {
  return (actions || [])
    .map((action) => {
      if (action.type === "SET_MIN_PRICE") {
        return `Минимальная цена: ${Number(action.value).toLocaleString("ru-RU")} ₸`;
      }
      if (action.type === "SET_GOAL") {
        return `Цель: ${action.value}`;
      }
      if (action.type === "SET_MODE") {
        return `Режим: ${action.value}`;
      }
      if (action.type === "EXACT_MESSAGE") {
        return `Точная отправка: «${String(action.text || "").slice(0, 80)}»`;
      }
      if (action.type === "AI_COMPOSE" || action.type === "ASK_CLIENT") {
        return `Сообщение клиенту по смыслу: ${action.value || action.text || ""}`;
      }
      if (action.type === "ADD_INSTRUCTION") {
        return `Инструкция: ${action.value}`;
      }
      if (action.type === "STATUS_QUERY") {
        return "Запрос статуса";
      }
      if (action.type === "LIST_LEADS") {
        return "Список активных лидов";
      }
      if (action.type === "LAST_SEND_STATUS") {
        return "Проверка последней отправки";
      }
      if (action.type === "SEND_HERE") {
        return `Отправить на ${action.value}`;
      }
      if (action.type === "WAIT_FILE") {
        return "Ожидаем фото или файл для клиента";
      }
      return action.type;
    })
    .filter(Boolean);
}
