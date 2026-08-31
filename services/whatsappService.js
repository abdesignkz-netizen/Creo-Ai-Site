import { getManagerChatId, normalizePhone } from "./phoneService.js";
import { log } from "./logger.js";

function getGreenApiBase() {
  const idInstance = process.env.GREEN_API_INSTANCE_ID;
  const apiToken = process.env.GREEN_API_TOKEN;
  if (!idInstance || !apiToken) {
    throw new Error("Green API не настроен");
  }
  return {
    idInstance,
    apiToken,
    base: `https://7107.api.greenapi.com/waInstance${idInstance}`,
  };
}

function isQuotaStatus(status) {
  return /EXCEED|QUOTE_EXCEED/i.test(String(status || ""));
}

function formatGreenApiFailure(data, httpStatus) {
  const blocks = [data?.correspondentsStatus, data?.invokeStatus, data?.quotaData].filter(Boolean);
  const quota = blocks.find((item) => isQuotaStatus(item.status) || item.description);
  if (quota?.description || blocks.length) {
    const description = quota?.description || blocks[0]?.description || "";
    const allowed = String(description).match(/(\d{10,15}@c\.us)/g) || [];
    const lines = [
      "Green API не доставил сообщение: лимит тарифа Developer.",
      "На этом тарифе можно писать только уже открытым чатам (обычно 3 номера).",
    ];
    if (allowed.length) {
      lines.push(`Разрешённые номера: ${allowed.map((item) => item.replace("@c.us", "")).join(", ")}`);
    }
    lines.push("Смените тариф на Business: https://console.green-api.com");
    return lines.join(" ");
  }

  if (typeof data === "string") {
    return data;
  }

  return `Green API HTTP ${httpStatus || ""}`.trim();
}

export function assertGreenApiSent(data, httpStatus) {
  if (data?.existsWhatsapp === false) {
    throw new Error("Номер не зарегистрирован в WhatsApp");
  }

  if (data?.idMessage) {
    const blocked = [data.correspondentsStatus, data.invokeStatus].some((item) =>
      isQuotaStatus(item?.status),
    );
    if (!blocked) {
      return data;
    }
  }

  throw new Error(formatGreenApiFailure(data, httpStatus));
}

const lastOutgoingStatus = new Map();
const outgoingStatusWaiters = new Map();

export function noteOutgoingStatus({ idMessage, status, chatId, description }) {
  if (!idMessage || !status) {
    return;
  }

  const payload = { status, chatId: chatId || "", description: description || "" };
  lastOutgoingStatus.set(idMessage, payload);

  const waiters = outgoingStatusWaiters.get(idMessage) || [];
  outgoingStatusWaiters.delete(idMessage);
  for (const resolve of waiters) {
    resolve(payload);
  }
}

export function waitForOutgoingStatus(idMessage, timeoutMs = 6000) {
  if (!idMessage) {
    return Promise.resolve({ status: "timeout" });
  }
  if (lastOutgoingStatus.has(idMessage)) {
    return Promise.resolve(lastOutgoingStatus.get(idMessage));
  }

  return new Promise((resolve) => {
    const list = outgoingStatusWaiters.get(idMessage) || [];
    const timer = setTimeout(() => {
      outgoingStatusWaiters.set(
        idMessage,
        (outgoingStatusWaiters.get(idMessage) || []).filter((item) => item !== onStatus),
      );
      resolve({ status: "timeout" });
    }, timeoutMs);
    const onStatus = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    list.push(onStatus);
    outgoingStatusWaiters.set(idMessage, list);
  });
}

function deliveryFailureReason(status, description) {
  if (/noAccount/i.test(status)) {
    return "Номер не зарегистрирован в WhatsApp";
  }
  if (/failed/i.test(status)) {
    return description || "WhatsApp не смог отправить сообщение";
  }
  if (/notInGroup/i.test(status)) {
    return "Нельзя отправить: номер не в этом чате";
  }
  return "";
}

export async function confirmOutgoingDelivery(
  idMessage,
  { requireStatus = false, timeoutMs = 6000 } = {},
) {
  const result = await waitForOutgoingStatus(idMessage, timeoutMs);
  const failure = deliveryFailureReason(result.status, result.description);
  if (failure) {
    throw new Error(failure);
  }
  if (requireStatus && result.status === "timeout") {
    throw new Error(
      "Не удалось подтвердить, что номер есть в WhatsApp. Сообщение не считаем доставленным.",
    );
  }
  return result;
}

async function postGreenApi(path, payload) {
  const { apiToken, base } = getGreenApiBase();
  const response = await fetch(`${base}/${path}/${apiToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok || response.status === 466) {
    log("GREEN API ERROR", { path, status: response.status });
    throw new Error(formatGreenApiFailure(data, response.status));
  }

  return { data, status: response.status };
}

export function inferFileName(file = {}) {
  const named = String(file.fileName || "").trim();
  if (named && /\.[a-z0-9]{2,8}$/i.test(named)) {
    return named;
  }

  const mime = String(file.mimeType || "").toLowerCase();
  const byMime = {
    "image/jpeg": "photo.jpg",
    "image/jpg": "photo.jpg",
    "image/png": "photo.png",
    "image/webp": "photo.webp",
    "image/gif": "photo.gif",
    "video/mp4": "video.mp4",
    "video/3gpp": "video.3gp",
    "application/pdf": "document.pdf",
    "application/msword": "document.doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document.docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation.pptx",
    "application/vnd.ms-powerpoint": "presentation.ppt",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table.xlsx",
  };

  if (byMime[mime]) {
    return byMime[mime];
  }
  if (file.type === "imageMessage" || file.type === "stickerMessage") {
    return "photo.jpg";
  }
  if (file.type === "videoMessage") {
    return "video.mp4";
  }
  return named || "file.bin";
}

export async function downloadWhatsAppFileUrl(chatId, idMessage) {
  const { data } = await postGreenApi("downloadFile", { chatId, idMessage });
  if (!data?.downloadUrl) {
    throw new Error("Green API не вернул ссылку на файл");
  }
  return data.downloadUrl;
}

export async function sendWhatsAppFile(chatId, file) {
  let urlFile = file?.url || "";
  if (!urlFile && file?.idMessage && file?.chatIdFrom) {
    urlFile = await downloadWhatsAppFileUrl(file.chatIdFrom, file.idMessage);
  }
  if (!urlFile) {
    throw new Error("Нет ссылки на файл для отправки");
  }

  const { data, status } = await postGreenApi("sendFileByUrl", {
    chatId,
    urlFile,
    fileName: inferFileName(file),
    caption: file?.caption || "",
  });

  try {
    return assertGreenApiSent(data, status);
  } catch (error) {
    log("GREEN API ERROR", { chatId, path: "sendFileByUrl", quota: true });
    throw error;
  }
}

export async function sendWhatsAppMessage(chatId, message) {
  const { data, status } = await postGreenApi("sendMessage", {
    chatId,
    message,
  });

  try {
    return assertGreenApiSent(data, status);
  } catch (error) {
    log("GREEN API ERROR", { chatId, path: "sendMessage", quota: true });
    throw error;
  }
}

export async function sendManagerMessage(message) {
  const chatId = getManagerChatId();
  if (!chatId) {
    throw new Error("MANAGER_PHONE не задан");
  }
  return sendWhatsAppMessage(chatId, message);
}

export async function checkWhatsAppNumber(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { exists: false, reason: "Некорректный номер" };
  }

  try {
    const { apiToken, base } = getGreenApiBase();
    const response = await fetch(`${base}/checkWhatsapp/${apiToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phoneNumber: Number(normalized),
      }),
    });

    const data = await response.json().catch(() => null);
    const raw = JSON.stringify(data || "");
    log("WHATSAPP CHECK", {
      phone: normalized,
      http: response.status,
      exists: data?.existsWhatsapp,
    });

    if (data?.existsWhatsapp === false) {
      return { exists: false, reason: "Номер не зарегистрирован в WhatsApp" };
    }
    if (data?.existsWhatsapp === true) {
      return { exists: true };
    }
    if (/bad phone number|valid from 11 to 16 digits/i.test(raw)) {
      return { exists: false, reason: "Некорректный номер WhatsApp" };
    }

    return {
      exists: null,
      skipped: true,
      reason: "Не удалось проверить, есть ли WhatsApp на номере",
    };
  } catch (error) {
    log("WHATSAPP CHECK", { phone: normalized, error: error.message });
    return {
      exists: null,
      skipped: true,
      reason: error.message || "Не удалось проверить номер в WhatsApp",
    };
  }
}

export function getManagerDestination() {
  return getManagerChatId();
}
