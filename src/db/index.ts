import { config, hasSupabase } from "../config.ts";
import { MemoryRepo } from "./memory.ts";
import type { Repo } from "./repo.ts";
import { SupabaseRepo } from "./supabase.ts";

/** Supabase when configured, otherwise an in-memory store (state is lost on restart). */
export function createRepo(): Repo {
  if (hasSupabase()) return new SupabaseRepo(config.supabase.url, config.supabase.serviceRoleKey);
  console.warn("[db] SUPABASE_URL not set — using in-memory store");
  return new MemoryRepo();
}

export type { Repo } from "./repo.ts";
