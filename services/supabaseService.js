import { createClient } from "@supabase/supabase-js";

let supabase = null;

export function getSupabase() {
  if (supabase) {
    return supabase;
  }

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!secretKey) {
    throw new Error("Missing SUPABASE_SECRET_KEY");
  }

  supabase = createClient(url, secretKey);
  return supabase;
}

export default getSupabase;
