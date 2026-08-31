const KZ_PHONE_RE =
  /(?:\+?7|8)[\s-]?\(?7\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/;
const WA_LINK_RE = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{10,15})/i;
const DEFAULT_MANAGER_PHONE = "77077471301";

export function normalizePhone(input) {
  if (input === undefined || input === null) {
    return null;
  }

  const raw = String(input).trim();
  if (!raw) {
    return null;
  }

  const withoutChat = raw.replace(/@c\.us$/i, "");
  const digits = withoutChat.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  let phone = digits;

  if (phone.length === 11 && phone.startsWith("8")) {
    phone = `7${phone.slice(1)}`;
  } else if (phone.length === 10) {
    phone = `7${phone}`;
  }

  if (phone.length === 11 && phone.startsWith("7")) {
    return phone;
  }

  return null;
}

export function toChatId(input) {
  const phone = normalizePhone(input);
  return phone ? `${phone}@c.us` : null;
}

export function phoneFromChatId(chatId) {
  return normalizePhone(chatId);
}

export function formatPhoneDisplay(input) {
  const phone = normalizePhone(input);
  if (!phone) {
    return "не выяснено";
  }

  return `+${phone[0]} ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7, 9)} ${phone.slice(9)}`;
}

export function extractPhoneFromVcard(vcard) {
  const match = String(vcard || "").match(/TEL[^:]*:([+\d\s()-]+)/i);
  return match ? normalizePhone(match[1]) : null;
}

export function extractPhoneCandidate(text) {
  const raw = String(text || "");
  const link = raw.match(WA_LINK_RE);
  if (link) {
    return normalizePhone(link[1]);
  }

  const match = raw.match(KZ_PHONE_RE);
  if (match) {
    return normalizePhone(match[0]);
  }

  const firstToken = raw.trim().split(/\s+/)[0];
  return normalizePhone(firstToken);
}

export function stripPhoneFromText(text) {
  return String(text || "")
    .replace(KZ_PHONE_RE, " ")
    .replace(/\bLEAD-\d+\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getManagerPhones() {
  const fromEnv = [process.env.MANAGER_PHONE, process.env.MANAGER_CHAT_ID]
    .filter(Boolean)
    .join(",");
  const raw = fromEnv || DEFAULT_MANAGER_PHONE;

  const phones = raw
    .split(/[,;]+/)
    .map((item) => normalizePhone(item))
    .filter(Boolean);

  return [...new Set(phones)];
}

export function getManagerPhone() {
  return getManagerPhones()[0] || null;
}

export function getManagerChatId() {
  const phone = getManagerPhone();
  return phone ? toChatId(phone) : null;
}

export function isManagerPhone(input) {
  const incoming = normalizePhone(input);
  return Boolean(incoming && getManagerPhones().includes(incoming));
}
