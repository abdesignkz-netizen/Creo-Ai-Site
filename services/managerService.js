import {
  addManagerInstruction,
  appendConversation,
  getLeadById,
  getLeadByPhone,
  getOrCreateLeadByPhone,
  listActiveLeads,
  updateLead,
} from "./leadService.js";
import {
  parseManagerCommand,
  describeActions,
  cleanComposeInstruction,
  isCancelSend,
  isConfirmSend,
} from "./managerCommandService.js";
import { composeClientMessage } from "./aiService.js";
import { checkWhatsAppNumber, confirmOutgoingDelivery, inferFileName, sendWhatsAppFile, sendWhatsAppMessage } from "./whatsappService.js";
import { extractPhoneCandidate, formatPhoneDisplay, isManagerPhone, phoneFromChatId, stripPhoneFromText, toChatId } from "./phoneService.js";
import { notifyManagerRaw } from "./notificationService.js";
import {
  clearPendingOutbound,
  getLastSend,
  getPendingOutbound,
  setLastSend,
  setPendingOutbound,
} from "./managerSession.js";
import { log } from "./logger.js";

function formatLeadSummary(lead) {
  const name = lead.clientName || "не выяснено";
  const company = lead.company ? ` / ${lead.company}` : "";
  return [
    formatPhoneDisplay(lead.clientPhone),
    "",
    `Клиент: ${name}${company}`,
    lead.leadId ? `Лид: ${lead.leadId}` : null,
    `Услуга: ${lead.service || "не выяснено"}`,
    `Статус: ${lead.status}`,
    `Режим AI: ${lead.aiMode}`,
    "",
    `КП / резюме: ${lead.requestSummary || "не выяснено"}`,
    `Бюджет: ${lead.budget || "не выяснено"}`,
    `Срок: ${lead.deadline || "не выяснено"}`,
    lead.minPrice ? `Мин. цена: ${Number(lead.minPrice).toLocaleString("ru-RU")} ₸` : null,
    lead.goal ? `Цель: ${lead.goal}` : null,
    "",
    "Текущая ситуация:",
    lead.lastClientMessage
      ? `последнее сообщение клиента: ${lead.lastClientMessage.slice(0, 280)}`
      : "ожидаем следующее сообщение клиента.",
    "",
    "Следующий рекомендуемый шаг:",
    lead.aiMode === "HUMAN"
      ? "клиент у менеджера, AI не отвечает."
      : lead.aiMode === "PAUSED"
        ? "снимите паузу командой «продолжай», если нужно возобновить AI."
        : "AI продолжает квалификацию и ведёт к следующему шагу.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatActiveLeads(leads) {
  if (!leads.length) {
    return "АКТИВНЫЕ ЛИДЫ\n\nСейчас активных лидов нет.";
  }

  const lines = leads.map((lead) => {
    const name = lead.clientName || lead.company || formatPhoneDisplay(lead.clientPhone);
    return `${formatPhoneDisplay(lead.clientPhone)} — ${name} — ${lead.service || "не выяснено"} — ${lead.status}`;
  });

  return ["АКТИВНЫЕ ЛИДЫ", "", ...lines].join("\n");
}

async function resolveLead({ leadId, phone, createIfMissing, extras }) {
  if (phone) {
    const existing = await getLeadByPhone(phone);
    if (existing) {
      return existing;
    }
    if (createIfMissing) {
      return getOrCreateLeadByPhone(phone, extras);
    }
  }

  if (leadId) {
    const byId = await getLeadById(leadId);
    if (byId) {
      return byId;
    }
  }

  return null;
}

function normalizePendingFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && (file.url || file.idMessage))
    .map((file) => ({
      type: file.type || "",
      url: file.url || "",
      fileName: inferFileName(file),
      mimeType: file.mimeType || "",
      caption: file.caption || "",
      idMessage: file.idMessage || "",
      chatIdFrom: file.chatIdFrom || "",
    }));
}

function fileKindLabel(file) {
  const type = String(file?.type || "");
  const mime = String(file?.mimeType || "");
  if (type === "imageMessage" || type === "stickerMessage" || mime.startsWith("image/")) {
    return "фото";
  }
  if (type === "videoMessage" || mime.startsWith("video/")) {
    return "видео";
  }
  return "файл";
}

function describeFiles(files) {
  return normalizePendingFiles(files).map(
    (file) => `${fileKindLabel(file)}: ${file.fileName}`,
  );
}

const SEND_FILE_COMMAND_RE =
  /(отправь|перешли|направь|прикрепи)(\s+(этот|вот|это|данный))?(\s+(файл|фото|документ|пдф|картинку|картинка|вложение))?|(этот|вот|это|данный)\s+(файл|фото|документ|пдф|картинку|картинка|вложение)/gi;

const FILE_DESTINATION_RE =
  /на\s+(этот\s+|указанный\s+)?номер|по\s+(этому\s+)?номеру|этому\s+клиенту|клиенту|вот\s+сюда|(^|\s)(сюда|туда)(?=\s|$)/gi;

function fileCaptionFromMessage(message) {
  SEND_FILE_COMMAND_RE.lastIndex = 0;
  FILE_DESTINATION_RE.lastIndex = 0;
  const cleaned = stripPhoneFromText(message)
    .replace(SEND_FILE_COMMAND_RE, " ")
    .replace(FILE_DESTINATION_RE, " ")
    .replace(/[!?.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !cleaned ||
    /^(этот|вот|это|файл|фото|документ|пдф|пожалуйста)$/i.test(cleaned) ||
    isConfirmSend(cleaned) ||
    isCancelSend(cleaned)
  ) {
    return "";
  }
  return cleaned;
}

function hasPendingContent(pending) {
  return Boolean(
    pending && (pending.phone || pending.draft || pending.files?.length),
  );
}

async function requireWhatsAppNumber(phone) {
  const check = await checkWhatsAppNumber(phone);
  if (check.exists === false) {
    throw new Error(check.reason || "Номер не зарегистрирован в WhatsApp");
  }
  return check;
}

async function sendToClient({ lead, text, phone, files = [] }) {
  const destinationPhone = lead?.clientPhone || phone;
  const chatId = toChatId(destinationPhone);
  if (!chatId) {
    throw new Error("Не удалось определить номер получателя");
  }

  const outgoingFiles = normalizePendingFiles(files);
  const outgoingText = String(text || "").trim();
  if (!outgoingText && !outgoingFiles.length) {
    throw new Error("Нет текста или файла для отправки");
  }

  const check = await checkWhatsAppNumber(destinationPhone);
  if (check.exists === false) {
    throw new Error(check.reason || "Номер не зарегистрирован в WhatsApp");
  }

  const summary = [
    outgoingFiles.length ? `[${describeFiles(outgoingFiles).join(", ")}]` : "",
    outgoingText,
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const sentIds = [];
    for (let index = 0; index < outgoingFiles.length; index += 1) {
      const file = outgoingFiles[index];
      const sent = await sendWhatsAppFile(chatId, {
        ...file,
        caption: index === 0 ? file.caption || "" : "",
      });
      if (sent?.idMessage) {
        sentIds.push(sent.idMessage);
      }
      await confirmOutgoingDelivery(sent?.idMessage, {
        requireStatus: false,
        timeoutMs: 2000,
      });
    }
    if (outgoingText) {
      const sent = await sendWhatsAppMessage(chatId, outgoingText);
      if (sent?.idMessage) {
        sentIds.push(sent.idMessage);
      }
      await confirmOutgoingDelivery(sent?.idMessage, {
        requireStatus: false,
        timeoutMs: 2000,
      });
    }
    if (!sentIds.length) {
      throw new Error("WhatsApp не принял сообщение");
    }
    await setLastSend({
      phone: destinationPhone,
      ok: true,
      text: summary,
    });
    log("DIRECT SEND", {
      leadId: lead?.leadId,
      phone: destinationPhone,
      chars: outgoingText.length,
      files: outgoingFiles.map((file) => file.fileName),
      idMessage: sentIds[0],
    });
  } catch (error) {
    await setLastSend({
      phone: destinationPhone,
      ok: false,
      text: summary,
      error: error.message,
    });
    log("GREEN API ERROR", { phone: destinationPhone, error: error.message });
    throw error;
  }

  return { chatId, phone: destinationPhone };
}

function dedupeActions(actions) {
  const sendTypes = new Set(["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"]);
  const other = actions.filter((item) => !sendTypes.has(item.type));
  const sends = actions.filter((item) => sendTypes.has(item.type));
  if (sends.some((item) => item.type === "EXACT_MESSAGE")) {
    return [...other, sends.find((item) => item.type === "EXACT_MESSAGE")];
  }
  if (sends.length) {
    return [...other, sends[0]];
  }
  return other;
}

function draftPreviewText({ phone, draft, instruction, files, fileCaption }) {
  const fileLines = describeFiles(files);
  return [
    phone ? `Черновик для ${formatPhoneDisplay(phone)}` : "Черновик без номера клиента",
    "",
    fileLines.length ? `Вложение: ${fileLines.join(", ")}` : null,
    fileLines.length && fileCaption ? `Подпись к файлу: «${fileCaption}»` : null,
    draft ? `«${draft}»` : null,
    "",
    instruction && !draft ? `Задача: ${instruction}` : null,
    "",
    phone ? "Отправить клиенту?" : "Укажите номер клиента, затем напишите: да / отправь",
    phone ? "Напишите: да / отправь" : null,
    "Или: нет / отмена",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function confirmationText({ lead, actions, sentText, sentPhone, sentFiles }) {
  const header = formatPhoneDisplay(lead?.clientPhone || sentPhone);
  const details = describeActions(actions);
  const lines = ["✅ " + header, "", "Принято."];

  if (details.length) {
    lines.push("", ...details);
  }

  if (sentFiles?.length) {
    lines.push("", `WhatsApp принял файл для клиента: ${describeFiles(sentFiles).join(", ")}`);
  }

  if (sentText) {
    lines.push("", `WhatsApp принял сообщение для клиента: «${sentText.slice(0, 240)}»`);
  }

  if (lead?.aiMode === "HUMAN") {
    lines.push("", "AI больше не отвечает этому клиенту.");
  } else if (lead?.aiMode === "PAUSED") {
    lines.push("", "AI временно не пишет этому клиенту.");
  } else {
    lines.push("", "AI продолжает вести клиента автоматически.");
  }

  return lines.join("\n");
}

async function deliverToClient({ phone, text, instruction, files, fileCaption }) {
  const targetPhone = phone;
  const outgoingFiles = normalizePendingFiles(files).map((file, index) => ({
    ...file,
    caption: index === 0 ? file.caption || fileCaption || "" : "",
  }));
  const outgoingText = String(text || "").trim();
  if (!targetPhone || (!outgoingText && !outgoingFiles.length)) {
    throw new Error("Нет номера, текста или файла для отправки");
  }

  await sendToClient({ text: outgoingText, phone: targetPhone, files: outgoingFiles });

  let lead = await getLeadByPhone(targetPhone);
  if (!lead) {
    lead = await getOrCreateLeadByPhone(targetPhone, {
      source: "manager_outbound",
      direction: "outbound",
    });
    log("OUTBOUND LEAD", { leadId: lead.leadId, phone: targetPhone });
  }

  const historyText = [
    outgoingFiles.length ? `[Файл: ${outgoingFiles.map((file) => file.fileName).join(", ")}]` : "",
    outgoingText,
  ]
    .filter(Boolean)
    .join("\n");

  lead = await appendConversation(lead.leadId, [
    { role: "assistant", content: historyText },
  ]);

  if (instruction) {
    await addManagerInstruction(lead.leadId, {
      type: "AI_COMPOSE",
      value: instruction,
    });
    lead = await getLeadById(lead.leadId);
  }

  await clearPendingOutbound();
  return lead;
}

export async function handleManagerMessage({ message, media = [], senderChatId }) {
  if (senderChatId && !isManagerPhone(senderChatId)) {
    log("MANAGER", { rejected: true, sender: senderChatId });
    return { ok: false, error: "not_manager" };
  }

  const incomingFiles = normalizePendingFiles(media);
  log("MANAGER", {
    message: String(message || "").slice(0, 300),
    files: incomingFiles.map((file) => file.fileName),
  });
  const notify = (text) => notifyManagerRaw(text, senderChatId);

  const pending = await getPendingOutbound();

  if (incomingFiles.length) {
    const phone = extractPhoneCandidate(message) || pending?.phone || "";
    const caption = fileCaptionFromMessage(message) || pending?.fileCaption || "";
    const files = incomingFiles.map((file, index) => ({
      ...file,
      caption: index === 0 ? caption : "",
    }));
    await setPendingOutbound({
      phone,
      draft: pending?.draft || "",
      instruction: pending?.instruction || "",
      fileCaption: caption,
      files,
    });
    if (!phone) {
      await notify("Файл принят. Укажите номер клиента, например: +77082555595");
      return { ok: true, kind: "need_phone" };
    }
    try {
      await requireWhatsAppNumber(phone);
    } catch (error) {
      await clearPendingOutbound();
      await notify(
        [
          "❌ Нельзя отправить",
          "",
          `Номер: ${formatPhoneDisplay(phone)}`,
          `Причина: ${error.message}`,
        ].join("\n"),
      );
      return { ok: false, error: error.message };
    }
    await notify(
      draftPreviewText({
        phone,
        draft: pending?.draft || "",
        instruction: pending?.instruction || "",
        files,
        fileCaption: caption,
      }),
    );
    return { ok: true, kind: "preview", phone };
  }

  if (isCancelSend(message) && hasPendingContent(pending)) {
    await clearPendingOutbound();
    await notify("Отправка отменена. Клиенту ничего не ушло.");
    return { ok: true, kind: "cancelled" };
  }

  if (isConfirmSend(message) && pending?.files?.length && !pending?.phone) {
    await notify("Файл принят. Укажите номер клиента, например: +77082555595");
    return { ok: true, kind: "need_phone" };
  }

  if (isConfirmSend(message) && pending?.phone) {
    try {
      const files = normalizePendingFiles(pending.files);
      let text = pending.draft || "";
      if (!text && !files.length) {
        text = await composeClientMessage({
          lead: (await getLeadByPhone(pending.phone)) || { clientPhone: pending.phone },
          instruction: pending.instruction || "Напиши клиенту короткое сообщение по текущему контексту переписки.",
        });
      }
      const lead = await deliverToClient({
        phone: pending.phone,
        text,
        instruction: pending.instruction,
        files,
        fileCaption: pending.fileCaption,
      });
      await notify(
        confirmationText({
          lead,
          actions: files.length
            ? [{ type: "WAIT_FILE", value: pending.phone }]
            : [{ type: "AI_COMPOSE", value: pending.instruction }],
          sentText: text,
          sentPhone: pending.phone,
          sentFiles: files,
        }),
      );
      return { ok: true, sent: true, leadId: lead.leadId };
    } catch (error) {
      await notify(
        [
          "❌ Не удалось отправить сообщение",
          "",
          `Номер: ${formatPhoneDisplay(pending.phone)}`,
          `Причина: ${error.message}`,
        ].join("\n"),
      );
      return { ok: false, error: error.message };
    }
  }

  const parsed = await parseManagerCommand(message);
  let actions = dedupeActions(parsed.actions || []);

  if (
    parsed.phone &&
    !actions.some((item) =>
      ["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT", "WAIT_FILE"].includes(item.type),
    ) &&
    /узнай|уточни|подробност|заявк|напиши|скажи|предложи|свяжись|отправь|напомин/i.test(message)
  ) {
    actions = [
      ...actions,
      { type: "AI_COMPOSE", value: cleanComposeInstruction(message) || message, text: null },
    ];
  }

  if (actions.some((item) => item.type === "LIST_LEADS")) {
    const leads = await listActiveLeads();
    await notify(formatActiveLeads(leads));
    return { ok: true, kind: "list" };
  }

  if (actions.some((item) => item.type === "LAST_SEND_STATUS")) {
    const last = await getLastSend();
    if (!last) {
      await notify("Пока не было попытки отправки клиенту.");
      return { ok: true, kind: "last_send" };
    }
    await notify(
      last.ok
        ? `✅ Последняя отправка прошла.\n\nНомер: ${formatPhoneDisplay(last.phone)}\nСообщение: «${String(last.text).slice(0, 240)}»`
        : `❌ Последняя отправка не прошла.\n\nНомер: ${formatPhoneDisplay(last.phone)}\nПричина: ${last.error}`,
    );
    return { ok: last.ok, kind: "last_send" };
  }

  if (actions.some((item) => item.type === "WAIT_FILE")) {
    const phone = parsed.phone || pending?.phone;
    if (!phone) {
      await notify("Укажите номер клиента и пришлите фото или файл.");
      return { ok: false };
    }
    try {
      await requireWhatsAppNumber(phone);
    } catch (error) {
      await notify(
        [
          "❌ Нельзя отправить",
          "",
          `Номер: ${formatPhoneDisplay(phone)}`,
          `Причина: ${error.message}`,
        ].join("\n"),
      );
      return { ok: false, error: error.message };
    }
    const caption = fileCaptionFromMessage(message) || pending?.fileCaption || "";
    await setPendingOutbound({
      phone,
      draft: pending?.draft || "",
      instruction: pending?.instruction || "",
      fileCaption: caption,
      files: pending?.files || [],
    });
    if (pending?.files?.length) {
      await notify(
        draftPreviewText({
          phone,
          draft: pending.draft,
          instruction: pending.instruction,
          files: pending.files,
          fileCaption: caption,
        }),
      );
      return { ok: true, kind: "preview", phone };
    }
    await notify(
      `Номер принят: ${formatPhoneDisplay(phone)}\n\nПришлите фото или файл, который нужно отправить клиенту.`,
    );
    return { ok: true, kind: "wait_file", phone };
  }

  if (
    actions.some((item) => item.type === "SEND_HERE") &&
    parsed.phone &&
    !actions.some((item) => ["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(item.type))
  ) {
    const draft = await getPendingOutbound();
    if (draft?.draft || draft?.files?.length) {
      await setPendingOutbound({
        phone: parsed.phone,
        draft: draft.draft,
        instruction: draft.instruction,
        fileCaption: draft.fileCaption,
        files: draft.files,
      });
      await notify(
        draftPreviewText({
          phone: parsed.phone,
          draft: draft.draft,
          instruction: draft.instruction,
          files: draft.files,
          fileCaption: draft.fileCaption,
        }),
      );
      return { ok: true, kind: "preview" };
    }

    await setPendingOutbound({ phone: parsed.phone, draft: "", instruction: "" });
    await notify(
      `Номер принят: ${formatPhoneDisplay(parsed.phone)}\n\nНапишите, что отправить, или пришлите фото/файл.`,
    );
    return { ok: true, kind: "target" };
  }

  const needsSend = actions.some((item) =>
    ["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(item.type),
  );
  const commandPhone = parsed.phone || (needsSend && pending?.phone ? pending.phone : null);
  let lead = await resolveLead({
    leadId: parsed.leadId,
    phone: commandPhone,
    createIfMissing: false,
  });

  if (actions.some((item) => item.type === "STATUS_QUERY")) {
    if (!lead) {
      await notify("❌ Клиент не найден. Укажите номер телефона.");
      return { ok: false };
    }
    await notify(formatLeadSummary(lead));
    return { ok: true, kind: "status", leadId: lead.leadId };
  }

  if (!lead && !commandPhone && !parsed.leadId) {
    await notify(
      "Не понял, к какому клиенту относится команда. Достаточно указать номер телефона.",
    );
    return { ok: false };
  }

  if (!lead && parsed.leadId && !commandPhone) {
    await notify(`❌ ${parsed.leadId} не найден.`);
    return { ok: false };
  }

  let sentText = null;

  for (const action of actions) {
    if (action.type === "SET_MODE") {
      const mode = String(action.value || "AUTO").toUpperCase();
      if (!lead && commandPhone) {
        lead = await getOrCreateLeadByPhone(commandPhone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      if (!lead) {
        continue;
      }
      lead = await updateLead(lead.leadId, {
        aiMode: mode,
        status: mode === "PAUSED" ? "paused" : lead.status === "paused" && mode === "AUTO" ? "new" : lead.status,
      });
      await addManagerInstruction(lead.leadId, {
        type: "SET_MODE",
        value: mode,
      });
      log("MODE CHANGE", { leadId: lead.leadId, aiMode: mode });
    }

    if (action.type === "SET_MIN_PRICE" && (lead || commandPhone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(commandPhone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      lead = await updateLead(lead.leadId, { minPrice: Number(action.value) || lead.minPrice });
      await addManagerInstruction(lead.leadId, {
        type: "SET_MIN_PRICE",
        value: Number(action.value),
      });
    }

    if (action.type === "SET_GOAL" && (lead || commandPhone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(commandPhone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      lead = await updateLead(lead.leadId, { goal: action.value });
      await addManagerInstruction(lead.leadId, {
        type: "SET_GOAL",
        value: action.value,
      });
    }

    if (action.type === "ADD_INSTRUCTION" && (lead || commandPhone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(commandPhone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      await addManagerInstruction(lead.leadId, {
        type: "ADD_INSTRUCTION",
        value: action.value,
      });
      lead = await getLeadById(lead.leadId);
    }

    if (["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(action.type)) {
      const targetPhone = lead?.clientPhone || commandPhone;
      if (!targetPhone) {
        await notify("❌ Не указан номер клиента для отправки.");
        return { ok: false };
      }

      if (!lead) {
        // create only after successful send
      }

      try {
        await requireWhatsAppNumber(targetPhone);
        const instruction =
          cleanComposeInstruction(action.value || action.text || message) ||
          String(action.value || action.text || message).trim();
        if (action.type === "EXACT_MESSAGE") {
          sentText = String(action.text || "").trim();
        } else {
          const last = await getLastSend();
          const extraContext = [
            last?.ok && last.phone === targetPhone
              ? `Недавно уже отправили клиенту: ${last.text}`
              : "",
            pending?.files?.length
              ? `К этому сообщению приложен файл: ${describeFiles(pending.files).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join(". ");
          sentText = await composeClientMessage({
            lead: lead || { clientPhone: targetPhone, service: /презентац/i.test(message) ? "presentation" : lead?.service },
            instruction,
            extraContext,
          });
        }

        if (!sentText) {
          throw new Error("Пустой текст сообщения");
        }

        const keepFiles = Boolean(pending?.files?.length);
        await setPendingOutbound({
          phone: targetPhone,
          draft: sentText,
          instruction,
          fileCaption: keepFiles ? pending.fileCaption || "" : "",
          files: keepFiles ? pending.files : [],
        });

        await notify(
          draftPreviewText({
            phone: targetPhone,
            draft: sentText,
            instruction,
            files: keepFiles ? pending.files : [],
            fileCaption: keepFiles ? pending.fileCaption || "" : "",
          }),
        );
        return { ok: true, kind: "preview", phone: targetPhone };
      } catch (error) {
        await notify(
          [
            "❌ Не удалось подготовить сообщение",
            "",
            `Номер: ${formatPhoneDisplay(targetPhone)}`,
            `Причина: ${error.message}`,
          ].join("\n"),
        );
        return { ok: false, error: error.message };
      }
    }
  }

  if (!actions.length && !needsSend) {
    if (lead) {
      await addManagerInstruction(lead.leadId, {
        type: "ADD_INSTRUCTION",
        value: message,
      });
    } else {
      await notify(
        "Не понял команду. Пример: 87071234567 узнай бюджет",
      );
      return { ok: false };
    }
  }

  try {
    await notify(
      confirmationText({
        lead,
        actions: actions.length ? actions : [{ type: "ADD_INSTRUCTION", value: message }],
        sentText,
        sentPhone: commandPhone,
      }),
    );
  } catch (error) {
    log("NOTIFICATION", { confirmFailed: true, error: error.message });
  }

  return { ok: true, leadId: lead?.leadId, sent: Boolean(sentText) };
}

export async function handleFailedOutboundStatus({ chatId, status, description }) {
  if (!/noAccount|failed/i.test(String(status || ""))) {
    return;
  }

  const phone = phoneFromChatId(chatId);
  const last = await getLastSend();
  if (!last?.ok || !phone || last.phone !== phone) {
    return;
  }

  const reason = /noAccount/i.test(status)
    ? "Номер не зарегистрирован в WhatsApp"
    : description || "WhatsApp не доставил сообщение";

  await setLastSend({
    phone,
    ok: false,
    text: last.text,
    error: reason,
  });

  await notifyManagerRaw(
    [
      "❌ Уточнение по отправке",
      "",
      `Номер: ${formatPhoneDisplay(phone)}`,
      `Причина: ${reason}. Сообщение клиенту не ушло.`,
    ].join("\n"),
  );
}
