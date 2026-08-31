import { getSupabase } from "./supabaseService.js";

function emptyToNull(value) {
  if (value === undefined || value === "") {
    return null;
  }
  return value ?? null;
}

function handleSupabaseResult(operation, { data, error }) {
  if (error) {
    const message = error.message || String(error);
    console.error(`[SUPABASE ERROR] ${operation}: ${message}`);
    throw new Error(`[SUPABASE ERROR] ${operation}: ${message}`);
  }

  return data;
}

export async function createWebSession({
  sessionId,
  landingPage,
  currentPage,
  referrer,
  utmSource,
  utmMedium,
  utmCampaign,
  utmTerm,
  utmContent,
} = {}) {
  if (!sessionId) {
    throw new Error("createWebSession: sessionId is required");
  }

  const result = await getSupabase()
    .from("web_sessions")
    .insert({
      session_id: sessionId,
      landing_page: emptyToNull(landingPage),
      current_page: emptyToNull(currentPage),
      referrer: emptyToNull(referrer),
      utm_source: emptyToNull(utmSource),
      utm_medium: emptyToNull(utmMedium),
      utm_campaign: emptyToNull(utmCampaign),
      utm_term: emptyToNull(utmTerm),
      utm_content: emptyToNull(utmContent),
    })
    .select()
    .single();

  return handleSupabaseResult("createWebSession", result);
}

export async function getWebSession(sessionId) {
  if (!sessionId) {
    throw new Error("getWebSession: sessionId is required");
  }

  const result = await getSupabase()
    .from("web_sessions")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  return handleSupabaseResult("getWebSession", result);
}

export async function updateWebSession(sessionId, fields = {}) {
  if (!sessionId) {
    throw new Error("updateWebSession: sessionId is required");
  }

  const patch = {};
  if (fields.landingPage !== undefined) patch.landing_page = emptyToNull(fields.landingPage);
  if (fields.currentPage !== undefined) patch.current_page = emptyToNull(fields.currentPage);
  if (fields.referrer !== undefined) patch.referrer = emptyToNull(fields.referrer);
  if (fields.utmSource !== undefined) patch.utm_source = emptyToNull(fields.utmSource);
  if (fields.utmMedium !== undefined) patch.utm_medium = emptyToNull(fields.utmMedium);
  if (fields.utmCampaign !== undefined) patch.utm_campaign = emptyToNull(fields.utmCampaign);
  if (fields.utmTerm !== undefined) patch.utm_term = emptyToNull(fields.utmTerm);
  if (fields.utmContent !== undefined) patch.utm_content = emptyToNull(fields.utmContent);
  patch.updated_at = new Date().toISOString();

  if (Object.keys(patch).length === 1) {
    return getWebSession(sessionId);
  }

  const result = await getSupabase()
    .from("web_sessions")
    .update(patch)
    .eq("session_id", sessionId)
    .select()
    .single();

  return handleSupabaseResult("updateWebSession", result);
}

export async function ensureWebSession(payload = {}) {
  const sessionId = payload.sessionId;
  if (!sessionId) {
    throw new Error("ensureWebSession: sessionId is required");
  }

  const existing = await getWebSession(sessionId);
  if (existing) {
    const patch = {};
    if (payload.currentPage) patch.currentPage = payload.currentPage;
    if (!existing.landing_page && payload.landingPage) {
      patch.landingPage = payload.landingPage;
    }
    if (!existing.referrer && payload.referrer) patch.referrer = payload.referrer;
    if (!existing.utm_source && payload.utmSource) patch.utmSource = payload.utmSource;
    if (!existing.utm_medium && payload.utmMedium) patch.utmMedium = payload.utmMedium;
    if (!existing.utm_campaign && payload.utmCampaign) {
      patch.utmCampaign = payload.utmCampaign;
    }
    if (!existing.utm_term && payload.utmTerm) patch.utmTerm = payload.utmTerm;
    if (!existing.utm_content && payload.utmContent) patch.utmContent = payload.utmContent;

    if (Object.keys(patch).length > 0) {
      return updateWebSession(sessionId, patch);
    }
    return existing;
  }

  try {
    return await createWebSession(payload);
  } catch (error) {
    const raced = await getWebSession(sessionId);
    if (raced) {
      return raced;
    }
    throw error;
  }
}

export async function saveWebMessage({ sessionId, role, message } = {}) {
  if (!sessionId) {
    throw new Error("saveWebMessage: sessionId is required");
  }
  if (!role) {
    throw new Error("saveWebMessage: role is required");
  }
  if (message === undefined || message === null) {
    throw new Error("saveWebMessage: message is required");
  }

  const result = await getSupabase()
    .from("web_messages")
    .insert({
      session_id: sessionId,
      role,
      message,
    })
    .select()
    .single();

  return handleSupabaseResult("saveWebMessage", result);
}

export async function createWebLead({
  leadId,
  sessionId,
  name,
  phone,
  company,
  service,
  task,
  deadline,
  budget,
} = {}) {
  if (!leadId) {
    throw new Error("createWebLead: leadId is required");
  }
  if (!sessionId) {
    throw new Error("createWebLead: sessionId is required");
  }

  const result = await getSupabase()
    .from("web_leads")
    .insert({
      lead_id: leadId,
      session_id: sessionId,
      name: emptyToNull(name),
      phone: emptyToNull(phone),
      company: emptyToNull(company),
      service: emptyToNull(service),
      task: emptyToNull(task),
      deadline: emptyToNull(deadline),
      budget: emptyToNull(budget),
    })
    .select()
    .single();

  return handleSupabaseResult("createWebLead", result);
}

export async function getWebMessages(sessionId) {
  if (!sessionId) {
    throw new Error("getWebMessages: sessionId is required");
  }

  const result = await getSupabase()
    .from("web_messages")
    .select("*")
    .eq("session_id", sessionId);

  const rows = handleSupabaseResult("getWebMessages", result) || [];

  return [...rows].sort((a, b) => {
    if (a.created_at && b.created_at) {
      return new Date(a.created_at) - new Date(b.created_at);
    }
    return 0;
  });
}
