import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { writeFile, unlink } from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import { join } from "path";
import { generateAiReply, getTranscriptionClient } from "./services/aiService.js";
import { validateAiEnv } from "./services/llmClient.js";
import { handleClientMessage, buildClientMessageWithMedia } from "./services/clientService.js";
import { handleFailedOutboundStatus, handleManagerMessage } from "./services/managerService.js";
import { noteOutgoingStatus } from "./services/whatsappService.js";
import {
  extractPhoneCandidate,
  extractPhoneFromVcard,
  formatPhoneDisplay,
  isManagerPhone,
  phoneFromChatId,
} from "./services/phoneService.js";
import { log } from "./services/logger.js";
import {
  createWebLead,
  ensureWebSession,
  getWebMessages,
  saveWebMessage,
} from "./services/webDataService.js";

dotenv.config();

const app = express();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5176",
  "http://localhost:4173",
  "https://creolab.kz",
  "https://www.creolab.kz",
  "https://site.creolab.kz",
  process.env.FRONTEND_ORIGIN,
].filter(Boolean);

const leadUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 8,
    fileSize: 12 * 1024 * 1024,
  },
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ type: "application/json", limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const pendingMessages = new Map();
const recentIncomingIds = new Map();
const MESSAGE_BUFFER_MS = Number(process.env.MESSAGE_BUFFER_MS || 4000);
const FOLLOWUP_BUFFER_MS = Math.max(1500, Math.round(MESSAGE_BUFFER_MS / 2));
const WEB_CHAT_FOLLOWUP_SILENCE_MS = Number(
  process.env.WEB_CHAT_FOLLOWUP_SILENCE_MS || 60000,
);
const pendingWebChatFollowups = new Map();

function validateEnv() {
  return validateAiEnv();
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLength);
}

function validateSupabaseEnv() {
  if (!process.env.SUPABASE_URL) {
    return "Missing SUPABASE_URL";
  }
  if (!process.env.SUPABASE_SECRET_KEY) {
    return "Missing SUPABASE_SECRET_KEY";
  }
  return null;
}

function makeWebSessionId() {
  return `WEB-${Date.now()}`;
}

function makeWebLeadId() {
  return `WEB-LEAD-${Date.now()}`;
}

function readUtm(body = {}, searchParams) {
  return {
    utmSource:
      cleanText(body.utmSource || body.utm_source, 120) ||
      searchParams?.get("utm_source") ||
      "",
    utmMedium:
      cleanText(body.utmMedium || body.utm_medium, 120) ||
      searchParams?.get("utm_medium") ||
      "",
    utmCampaign:
      cleanText(body.utmCampaign || body.utm_campaign, 120) ||
      searchParams?.get("utm_campaign") ||
      "",
    utmTerm:
      cleanText(body.utmTerm || body.utm_term, 120) ||
      searchParams?.get("utm_term") ||
      "",
    utmContent:
      cleanText(body.utmContent || body.utm_content, 120) ||
      searchParams?.get("utm_content") ||
      "",
  };
}

function parseWebTracking(body = {}) {
  const pageUrl = cleanText(body.pageUrl || body.currentPage, 500);
  let parsed = null;
  try {
    parsed = pageUrl ? new URL(pageUrl) : null;
  } catch {
    parsed = null;
  }

  const pathFromUrl = parsed ? `${parsed.pathname}${parsed.search}` : "";
  const utm = readUtm(body, parsed?.searchParams);

  return {
    sessionId: cleanText(body.sessionId, 80) || makeWebSessionId(),
    landingPage: cleanText(body.landingPage, 500) || pathFromUrl || pageUrl,
    currentPage: cleanText(body.currentPage, 500) || pathFromUrl || pageUrl,
    referrer: cleanText(body.referrer, 500),
    ...utm,
  };
}

function toAiHistory(messages) {
  return (messages || []).map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.message || "",
  }));
}

function phoneFromWebHistory(history) {
  for (const item of history || []) {
    if (item.role !== "user") continue;
    const phone = extractPhoneCandidate(item.content);
    if (phone) return phone;
  }
  return "";
}

async function persistWebsiteLead(body, { name, phone, service, comment, deadline }) {
  try {
    const tracking = parseWebTracking(body);
    await ensureWebSession(tracking);

    let quiz = body?.quizAnswers;
    if (typeof quiz === "string") {
      try {
        quiz = JSON.parse(quiz);
      } catch {
        quiz = {};
      }
    }

    await createWebLead({
      leadId: makeWebLeadId(),
      sessionId: tracking.sessionId,
      name,
      phone,
      company: cleanText(body.company || quiz?.company, 200),
      service,
      task: comment,
      deadline,
      budget: cleanText(body.budget || quiz?.budget, 120),
    });
  } catch (error) {
    console.error("[SUPABASE ERROR] persistWebsiteLead:", error.message);
  }
}

function formatAlmatyDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function getTelegramCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is not configured");
  }

  return { token, chatId };
}

async function sendTelegramMessage(message) {
  const { token, chatId } = getTelegramCredentials();

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    },
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    console.error("Telegram API error:", data || `HTTP ${response.status}`);
    throw new Error("Telegram API request failed");
  }

  return data;
}

async function sendTelegramDocument(file, caption = "") {
  const { token, chatId } = getTelegramCredentials();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 900));
  form.append(
    "document",
    new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
    file.originalname || "file",
  );

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendDocument`,
    {
      method: "POST",
      body: form,
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    console.error("Telegram sendDocument error:", data || `HTTP ${response.status}`);
    throw new Error("Telegram document upload failed");
  }
  return data;
}

function buildWebChatFollowupTelegramMessage({
  name,
  phone,
  messages = [],
  managerNote,
  managerEvent,
  service,
  pageUrl,
}) {
  const clientLines = (messages || []).filter(Boolean);
  const lines = [
    "📝 Обновление по заявке · CREOLAB",
    "",
    `Имя: ${name}`,
    `Телефон: ${phone}`,
  ];

  if (service) lines.push(`Услуга: ${service}`);
  lines.push("", "Обновлённые запросы клиента:");
  if (clientLines.length > 1) {
    lines.push(...clientLines.map((item) => `• ${item}`));
  } else if (clientLines.length === 1) {
    lines.push(clientLines[0]);
  } else {
    lines.push("—");
  }

  if (managerNote && !clientLines.includes(managerNote)) {
    lines.push("", `Кратко (ИИ): ${managerNote}`);
  }
  if (managerEvent && managerEvent !== "null") {
    lines.push("", `Событие: ${managerEvent}`);
  }

  lines.push("");
  if (pageUrl) lines.push(`Страница: ${pageUrl}`);
  lines.push(`Время: ${formatAlmatyDateTime()}`);

  return lines.join("\n").slice(0, 4000);
}

function scheduleWebChatFollowupNotify(sessionId, payload) {
  const existing = pendingWebChatFollowups.get(sessionId);
  const merged = {
    name: payload.name || existing?.name || "не указано",
    phone: payload.phone || existing?.phone || "",
    pageUrl: payload.pageUrl || existing?.pageUrl || "",
    service: payload.service || existing?.service || "",
    managerNote: payload.managerNote || existing?.managerNote || "",
    managerEvent: payload.managerEvent || existing?.managerEvent || "",
    messages: [...(existing?.messages || []), payload.message].filter(Boolean),
    version: (existing?.version || 0) + 1,
  };

  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const version = merged.version;
  const timer = setTimeout(() => {
    flushWebChatFollowup(sessionId, version).catch((error) => {
      console.error("WEB CHAT FOLLOWUP FLUSH ERROR:", error.message);
    });
  }, WEB_CHAT_FOLLOWUP_SILENCE_MS);

  pendingWebChatFollowups.set(sessionId, { ...merged, timer });
}

async function flushWebChatFollowup(sessionId, expectedVersion) {
  const pending = pendingWebChatFollowups.get(sessionId);
  if (!pending || pending.version !== expectedVersion) {
    return;
  }

  pendingWebChatFollowups.delete(sessionId);

  if (!pending.messages.length || !pending.phone) {
    return;
  }

  try {
    await sendTelegramMessage(
      buildWebChatFollowupTelegramMessage({
        name: pending.name,
        phone: pending.phone,
        messages: pending.messages,
        managerNote: pending.managerNote,
        managerEvent: pending.managerEvent,
        service: pending.service,
        pageUrl: pending.pageUrl,
      }),
    );
  } catch (notifyError) {
    console.error("WEB CHAT FOLLOWUP TELEGRAM ERROR:", notifyError.message);
  }
}

function buildLeadTelegramMessage({
  name,
  phone,
  service,
  comment,
  pageUrl,
  source,
  presentationType,
  deadline,
  fileNames,
}) {
  const isPresentation =
    source === "presentation" ||
    /\/presentation/i.test(pageUrl || "") ||
    /презентац/i.test(service || "");

  const lines = [
    isPresentation
      ? "🟢 Новая заявка · Презентации CREOLAB"
      : "🟢 Новая заявка с сайта CREOLAB",
    "",
    `Имя: ${name}`,
    `Телефон: ${phone}`,
  ];

  if (service) lines.push(`Услуга: ${service}`);
  if (presentationType) lines.push(`Тип презентации: ${presentationType}`);
  if (deadline) lines.push(`Срок: ${deadline}`);
  if (comment) lines.push(`Комментарий: ${comment}`);
  if (fileNames?.length) lines.push(`Файлы: ${fileNames.join(", ")}`);

  lines.push("");
  if (pageUrl) lines.push(`Страница: ${pageUrl}`);
  lines.push(`Время: ${formatAlmatyDateTime()}`);

  return lines.join("\n").slice(0, 4000);
}

app.get("/", (_req, res) => {
  const supabaseEnvError = validateSupabaseEnv();
  const aiEnvError = validateEnv();
  res.json({
    status: supabaseEnvError || aiEnvError ? "degraded" : "ok",
    message: "CREOLAB website AI is running",
    supabase: supabaseEnvError ? "missing" : "ok",
    ai: aiEnvError ? "missing" : "ok",
  });
});

app.post("/api/lead", leadUpload.array("files", 8), async (req, res) => {
  try {
    const website = cleanText(req.body?.website, 200);
    if (website) {
      return res.json({ success: true });
    }

    const name = cleanText(req.body?.name, 120);
    const phone = cleanText(req.body?.phone, 40);
    const service = cleanText(req.body?.service, 200);
    const comment = cleanText(req.body?.comment, 3500);
    const pageUrl = cleanText(req.body?.pageUrl, 500);
    const source = cleanText(req.body?.source, 80);
    const presentationType = cleanText(
      req.body?.presentationType || req.body?.type,
      120,
    );
    const deadline = cleanText(req.body?.deadline, 120);
    const files = Array.isArray(req.files) ? req.files : [];
    const fileNames = files.map((f) => f.originalname).filter(Boolean);

    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: "Укажите имя и номер телефона",
      });
    }

    const message = buildLeadTelegramMessage({
      name,
      phone,
      service,
      comment,
      pageUrl,
      source,
      presentationType,
      deadline,
      fileNames,
    });

    await sendTelegramMessage(message);

    for (const file of files) {
      try {
        await sendTelegramDocument(file, `${name} · ${phone}`);
      } catch (fileError) {
        console.error("LEAD FILE TELEGRAM ERROR:", fileError);
      }
    }

    await persistWebsiteLead(req.body, {
      name,
      phone,
      service,
      comment,
      deadline,
    });

    return res.json({
      success: true,
      message: "Заявка успешно отправлена",
    });
  } catch (error) {
    console.error("LEAD TELEGRAM ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Не удалось отправить заявку",
    });
  }
});

app.post("/api/web/session", async (req, res) => {
  const supabaseEnvError = validateSupabaseEnv();
  if (supabaseEnvError) {
    return res.status(500).json({
      success: false,
      error: supabaseEnvError,
    });
  }

  try {
    const tracking = parseWebTracking(req.body || {});
    const session = await ensureWebSession(tracking);

    return res.json({
      success: true,
      sessionId: tracking.sessionId,
      session,
    });
  } catch (error) {
    console.error("[SUPABASE ERROR] /api/web/session:", error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/web/chat", async (req, res) => {
  const envError = validateEnv();
  if (envError) {
    return res.status(500).json({
      success: false,
      error: envError,
    });
  }

  const supabaseEnvError = validateSupabaseEnv();
  if (supabaseEnvError) {
    return res.status(500).json({
      success: false,
      error: supabaseEnvError,
    });
  }

  const message = cleanText(req.body?.message, 4000);
  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Поле message обязательно и должно быть непустой строкой.",
    });
  }

  try {
    const tracking = parseWebTracking(req.body || {});
    await ensureWebSession(tracking);

    const previous = await getWebMessages(tracking.sessionId);
    const history = toAiHistory(previous);
    const knownPhone = phoneFromWebHistory(history);

    await saveWebMessage({
      sessionId: tracking.sessionId,
      role: "user",
      message,
    });

    const { reply, result, latencyMs } = await generateAiReply({
      message,
      history,
      channel: "web",
      lead: {
        leadId: tracking.sessionId,
        aiMode: "AUTO",
        status: knownPhone ? "qualified" : "new",
        clientPhone: knownPhone || "",
      },
    });

    await saveWebMessage({
      sessionId: tracking.sessionId,
      role: "assistant",
      message: reply,
    });

    const capturedPhone =
      extractPhoneCandidate(message) ||
      extractPhoneCandidate(result?.client_phone) ||
      "";
    if (capturedPhone && !knownPhone) {
      const name = cleanText(result?.client_name, 120) || "не указано";
      await persistWebsiteLead(req.body, {
        name,
        phone: capturedPhone,
        service: cleanText(result?.service, 80),
        comment: cleanText(result?.summary || message, 3500),
        deadline: cleanText(result?.deadline, 120),
      });
      try {
        await sendTelegramMessage(
          buildLeadTelegramMessage({
            name,
            phone: formatPhoneDisplay(capturedPhone),
            service: cleanText(result?.service, 80),
            comment: cleanText(result?.summary || message, 3500),
            pageUrl: tracking.pageUrl || tracking.currentPage || "",
            source: "web_chat",
          }),
        );
      } catch (notifyError) {
        console.error("WEB CHAT TELEGRAM ERROR:", notifyError.message);
      }
    } else if (knownPhone) {
      scheduleWebChatFollowupNotify(tracking.sessionId, {
        name: cleanText(result?.client_name, 120) || "не указано",
        phone: formatPhoneDisplay(knownPhone),
        message,
        managerNote: cleanText(result?.manager_event_note || result?.summary, 500),
        managerEvent: cleanText(result?.manager_event, 80),
        service: cleanText(result?.service, 80),
        pageUrl: tracking.pageUrl || tracking.currentPage || "",
      });
    }

    if (result?.llm_error) {
      return res.status(502).json({
        success: false,
        error: result.llm_error,
        latencyMs,
      });
    }

    return res.json({
      success: true,
      sessionId: tracking.sessionId,
      reply,
      result,
      latencyMs,
    });
  } catch (error) {
    console.error("[SUPABASE ERROR] /api/web/chat:", error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/test-ai", async (req, res) => {
  const envError = validateEnv();
  if (envError) {
    return res.status(500).json({
      success: false,
      error: envError,
    });
  }

  const { message, sessionId = "test-user", history = [] } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Поле message обязательно и должно быть непустой строкой.",
    });
  }

  try {
    const { raw, result, latencyMs } = await generateAiReply({
      message: message.trim(),
      history,
      lead: { leadId: sessionId, aiMode: "AUTO", status: "new" },
    });

    if (result?.llm_error) {
      return res.status(502).json({
        success: false,
        error: result.llm_error,
        result,
        latencyMs,
      });
    }

    return res.json({
      success: true,
      raw,
      result,
      latencyMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Ошибка при обращении к AI API.",
      details: error.message,
    });
  }
});

async function transcribeAudioFromUrl(fileUrl) {
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Не удалось скачать голосовое: ${await response.text()}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFilePath = join(os.tmpdir(), `voice-${Date.now()}.ogg`);

  await writeFile(tempFilePath, buffer);

  try {
    const transcription = await getTranscriptionClient().audio.transcriptions.create({
      file: createReadStream(tempFilePath),
      model: "whisper-1",
    });

    return transcription.text || "";
  } finally {
    await unlink(tempFilePath).catch(() => {});
  }
}

async function extractIncomingText(body) {
  const typeMessage = body?.messageData?.typeMessage;
  const parts = [];

  if (typeMessage === "textMessage") {
    parts.push(body.messageData?.textMessageData?.textMessage || "");
  } else if (typeMessage === "extendedTextMessage") {
    const extra = body.messageData?.extendedTextMessageData || {};
    parts.push(extra.text || extra.description || extra.title || "");
  } else if (typeMessage === "quotedMessage") {
    parts.push(body.messageData?.extendedTextMessageData?.text || "");
  } else if (typeMessage === "audioMessage") {
    const fileUrl = body.messageData?.fileMessageData?.downloadUrl;
    if (fileUrl) {
      const text = await transcribeAudioFromUrl(fileUrl);
      if (text) parts.push(`[Голосовое сообщение]: ${text}`);
    }
  } else if (typeMessage === "contactMessage") {
    const contact = body.messageData?.contactMessageData || {};
    const phone =
      extractPhoneFromVcard(contact.vcard) ||
      extractPhoneCandidate(contact.displayName || "");
    if (phone) parts.push(phone);
    if (contact.displayName) parts.push(contact.displayName);
  }

  const caption = body.messageData?.fileMessageData?.caption;
  if (caption) parts.push(caption);

  return parts.filter(Boolean).join("\n").trim();
}

const FORWARDABLE_MEDIA = new Set([
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
]);

function extractIncomingMedia(body) {
  const typeMessage = body?.messageData?.typeMessage;
  if (!FORWARDABLE_MEDIA.has(typeMessage)) {
    return null;
  }

  const file = body.messageData?.fileMessageData || {};
  if (!file.downloadUrl && !body.idMessage) {
    return null;
  }

  return {
    type: typeMessage,
    url: file.downloadUrl || "",
    fileName: file.fileName || "",
    mimeType: file.mimeType || "",
    caption: file.caption || "",
    idMessage: body.idMessage || "",
    chatIdFrom: body.senderData?.chatId || "",
  };
}

function rememberIncomingId(sessionId, idMessage) {
  if (!idMessage) {
    return false;
  }

  let seen = recentIncomingIds.get(sessionId);
  if (!seen) {
    seen = [];
    recentIncomingIds.set(sessionId, seen);
  }

  if (seen.includes(idMessage)) {
    return true;
  }

  seen.push(idMessage);
  if (seen.length > 80) {
    seen.splice(0, seen.length - 80);
  }
  return false;
}

function takePendingBundle(pending) {
  const messages = [...(pending.messages || [])];
  const media = [...(pending.media || [])];
  pending.messages = [];
  pending.media = [];
  return {
    messages,
    media,
    version: pending.version,
    senderName: pending.senderName,
  };
}

function scheduleFlush(sessionId, chatId, delayMs = MESSAGE_BUFFER_MS) {
  const pending = pendingMessages.get(sessionId);
  if (!pending || pending.generating) {
    return;
  }

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    flushPendingChat(sessionId, chatId).catch((error) => {
      console.error("BUFFERED MESSAGE ERROR:", error);
      pendingMessages.delete(sessionId);
    });
  }, delayMs);
}

async function flushPendingChat(sessionId, chatId) {
  const pending = pendingMessages.get(sessionId);
  if (!pending || pending.generating) {
    return;
  }

  pending.generating = true;
  pending.timer = null;

  const bundle = takePendingBundle(pending);
  const combinedMessage = buildClientMessageWithMedia(
    bundle.messages.join("\n"),
    bundle.media,
  );
  const startedAt = Date.now();
  let aborted = false;

  try {
    if (!combinedMessage) {
      return;
    }

    if (isManagerPhone(chatId)) {
      await handleManagerMessage({
        message: bundle.messages.join("\n"),
        media: bundle.media,
        senderChatId: chatId,
      });
    } else {
      const result = await handleClientMessage({
        chatId,
        message: bundle.messages.join("\n"),
        senderName: bundle.senderName,
        media: bundle.media,
        shouldAbort: () => {
          const latest = pendingMessages.get(sessionId);
          return Boolean(latest && latest.version !== bundle.version);
        },
      });
      aborted = Boolean(result?.aborted);
    }
  } finally {
    const latest = pendingMessages.get(sessionId);
    if (latest && (aborted || latest.version !== bundle.version)) {
      if (aborted) {
        latest.messages = [...bundle.messages, ...latest.messages];
        latest.media = [...bundle.media, ...latest.media];
      }
      latest.generating = false;
      scheduleFlush(sessionId, chatId, FOLLOWUP_BUFFER_MS);
    } else {
      pendingMessages.delete(sessionId);
    }
  }

  log("AI RESPONSE", {
    chatId,
    role: isManagerPhone(chatId) ? "MANAGER" : "CLIENT",
    bufferMs: MESSAGE_BUFFER_MS,
    aborted,
    totalMs: Date.now() - startedAt + MESSAGE_BUFFER_MS,
  });
}

app.post("/webhook", async (req, res) => {
  console.log("WEBHOOK RECEIVED:", Date.now());
  try {
    const body = req.body;

    console.log(
      "TYPE:",
      body.typeWebhook,
      "CHAT:",
      body.senderData?.chatId,
    );

    if (body.typeWebhook === "outgoingMessageStatus") {
      noteOutgoingStatus({
        idMessage: body.idMessage,
        status: body.status,
        chatId: body.chatId,
        description: body.description,
      });
      await handleFailedOutboundStatus({
        chatId: body.chatId,
        status: body.status,
        description: body.description,
      });
      return res.json({ success: true, kind: "outgoing_status" });
    }

    if (body.typeWebhook !== "incomingMessageReceived") {
      return res.json({ success: true, skipped: "not incoming message" });
    }

    const chatId = body.senderData?.chatId;
    const senderName =
      body.senderData?.senderName || body.senderData?.chatName || "";
    const message = await extractIncomingText(body);
    const media = extractIncomingMedia(body);
    const isManager = isManagerPhone(chatId);

    if (!chatId || (!message && !media)) {
      return res.json({ success: true, skipped: "no text message" });
    }

    const sessionId = chatId;
    if (rememberIncomingId(sessionId, body.idMessage)) {
      return res.json({ success: true, skipped: "duplicate incoming" });
    }

    const role = isManager ? "MANAGER" : "CLIENT";
    log(role, { phone: phoneFromChatId(chatId), buffered: true, hasFile: Boolean(media) });

    const existing = pendingMessages.get(sessionId);

    const pending = existing || {
      messages: [],
      media: [],
      version: 0,
      generating: false,
      timer: null,
    };

    if (message.trim()) {
      pending.messages = [...pending.messages, message.trim()];
    }
    if (media) {
      pending.media = [...(pending.media || []), media];
    }
    pending.version += 1;
    pending.senderName = pending.senderName || senderName;
    pendingMessages.set(sessionId, pending);

    if (!pending.generating) {
      scheduleFlush(sessionId, chatId);
    }

    return res.json({
      success: true,
      buffered: true,
      role,
      messagesCount: pending.messages.length,
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const supabaseEnvError = validateSupabaseEnv();
if (supabaseEnvError) {
  console.error(`[BOOT] ${supabaseEnvError}. Website chat will return 500 until this is set in Render Environment.`);
}

const aiEnvError = validateEnv();
if (aiEnvError) {
  console.error(`[BOOT] ${aiEnvError}`);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CREOLAB website AI running on port ${PORT}`);
});
