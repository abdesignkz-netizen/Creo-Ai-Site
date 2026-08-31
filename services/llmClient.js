import OpenAI from "openai";
import { log } from "./logger.js";

const ANYMODEL_DEFAULT_BASE_URL = "https://anymodel.org/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL = "qwen/qwen3-235b-a22b:free";
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "low";

const ALLOWED_PROVIDERS = new Set(["openai", "anymodel", "openrouter"]);

export class LlmRequestError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "LlmRequestError";
    this.cause = cause;
  }
}

export function getAiProvider() {
  return String(process.env.AI_PROVIDER || "openai").trim().toLowerCase();
}

export function getAiModel() {
  const provider = getAiProvider();
  if (provider === "anymodel") {
    return process.env.ANYMODEL_MODEL;
  }
  if (provider === "openrouter") {
    return process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  }
  return process.env.OPENAI_MODEL;
}

export function validateAiEnv() {
  const provider = getAiProvider();

  if (!ALLOWED_PROVIDERS.has(provider)) {
    return `Неизвестный AI_PROVIDER=${provider}. Допустимо: openai, anymodel, openrouter.`;
  }

  if (provider === "anymodel") {
    if (!process.env.ANYMODEL_API_KEY) {
      return "ANYMODEL_API_KEY не задан. Скопируйте .env.example в .env и укажите ключ AnyModel.";
    }
    if (!process.env.ANYMODEL_MODEL) {
      return "ANYMODEL_MODEL не задан. Скопируйте .env.example в .env и укажите модель AnyModel.";
    }
    return null;
  }

  if (provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) {
      return "OPENROUTER_API_KEY не задан. Скопируйте .env.example в .env и укажите ключ OpenRouter.";
    }
    return null;
  }

  if (!process.env.OPENAI_API_KEY) {
    return "OPENAI_API_KEY не задан. Скопируйте .env.example в .env и укажите ключ OpenAI.";
  }
  if (!process.env.OPENAI_MODEL) {
    return "OPENAI_MODEL не задан. Скопируйте .env.example в .env и укажите доступную модель OpenAI.";
  }
  return null;
}

function withOpenAIReasoning(params, effort = OPENAI_REASONING_EFFORT) {
  if (getAiProvider() !== "openai") {
    return params;
  }
  return {
    ...params,
    reasoning: { effort },
  };
}

function toUserText(input) {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.content === undefined) return JSON.stringify(item);
        if (typeof item.content === "string") return item.content;
        if (Array.isArray(item.content)) {
          return item.content
            .map((part) => part?.text || part?.content || "")
            .filter(Boolean)
            .join("\n");
        }
        return String(item.content);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof input === "object" && input.content !== undefined) {
    return String(input.content);
  }
  return String(input);
}

export function formatLlmError(error) {
  const provider = getAiProvider();
  const prefix =
    provider === "openrouter" ? "OpenRouter" : provider === "anymodel" ? "AnyModel" : "OpenAI";
  const status = error?.status ?? error?.statusCode ?? error?.response?.status ?? null;
  const rawBody = error?.error?.message || error?.error || error?.message || "";
  const bodyText = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  const combined = `${status || ""} ${bodyText}`.toLowerCase();

  if (
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNABORTED" ||
    /timeout|timed out|abort/.test(combined)
  ) {
    return `${prefix}: истекло время ожидания ответа модели.`;
  }
  if (status === 401 || /invalid api key|unauthorized|incorrect api key/.test(combined)) {
    return `${prefix}: неверный API-ключ. Проверьте ключ в .env.`;
  }
  if (status === 429 || /rate limit|too many requests/.test(combined)) {
    return `${prefix}: превышен лимит запросов. Подождите и попробуйте снова.`;
  }
  if (status === 402 || /payment required|credits|quota|balance/.test(combined)) {
    return `${prefix}: недостаточно кредитов или исчерпан лимит.`;
  }
  if (
    /no endpoints found|no allowed providers|free.*(unavailable|not available)|model is not available/.test(
      combined,
    )
  ) {
    return `${prefix}: бесплатная модель сейчас недоступна. Проверьте OPENROUTER_MODEL или попробуйте позже.`;
  }
  if (status === 404 || /not found|unavailable|does not exist/.test(combined)) {
    return `${prefix}: модель временно недоступна. Проверьте имя модели в .env.`;
  }

  const short = String(bodyText || "ошибка API").slice(0, 400);
  return `${prefix}: ${short}`;
}

let llmClient = null;

export function getOpenAIClient() {
  if (!llmClient) {
    const provider = getAiProvider();

    if (provider === "anymodel") {
      llmClient = new OpenAI({
        apiKey: process.env.ANYMODEL_API_KEY,
        baseURL: process.env.ANYMODEL_BASE_URL || ANYMODEL_DEFAULT_BASE_URL,
      });
    } else if (provider === "openrouter") {
      llmClient = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        timeout: Number(process.env.OPENROUTER_TIMEOUT_MS || 60000),
        defaultHeaders: {
          "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://creolab.kz",
          "X-Title": process.env.OPENROUTER_APP_TITLE || "CREOLAB AI Manager",
        },
      });
    } else {
      llmClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }
  return llmClient;
}

export function getTranscriptionClient() {
  if (process.env.OPENAI_API_KEY && getAiProvider() !== "openai") {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return getOpenAIClient();
}

async function createOpenRouterChatResponse({ instructions, input }) {
  const messages = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push({ role: "user", content: toUserText(input) });

  const completion = await getOpenAIClient().chat.completions.create({
    model: getAiModel(),
    messages,
  });

  const output_text = completion.choices?.[0]?.message?.content || "";
  return { output_text };
}

export async function createLlmResponse({
  instructions,
  input,
  reasoningEffort = OPENAI_REASONING_EFFORT,
}) {
  const provider = getAiProvider();
  const model = getAiModel();

  try {
    if (provider === "openrouter") {
      return await createOpenRouterChatResponse({ instructions, input });
    }

    const params = {
      model,
      input,
    };
    if (instructions) {
      params.instructions = instructions;
    }

    return await getOpenAIClient().responses.create(withOpenAIReasoning(params, reasoningEffort));
  } catch (error) {
    const message = formatLlmError(error);
    log("LLM ERROR", {
      provider,
      model,
      status: error?.status || error?.statusCode || null,
      message,
    });
    throw new LlmRequestError(message, error);
  }
}
