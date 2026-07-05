/**
 * Supabase-backed persistence: DesignSpecs in Postgres, preview/art images in Storage.
 * Implements the same SpecStore / ImageStore seams as the in-memory/local versions.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DesignSpec } from "./designSpec.js";
import type { ImageStore, SpecStore } from "./store.js";

export function createSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

export class SupabaseSpecStore implements SpecStore {
  constructor(private sb: SupabaseClient) {}

  async save(spec: DesignSpec): Promise<void> {
    const { error } = await this.sb.from("design_specs").upsert({
      id: spec.id,
      order_hash: spec.orderHash,
      spec,
      created_at: spec.createdAt,
    });
    if (error) throw new Error(`save spec failed: ${error.message}`);
  }

  async get(id: string): Promise<DesignSpec | null> {
    const { data, error } = await this.sb
      .from("design_specs")
      .select("spec")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`get spec failed: ${error.message}`);
    return (data?.spec as DesignSpec) ?? null;
  }
}

export class SupabaseImageStore implements ImageStore {
  constructor(
    private sb: SupabaseClient,
    private bucket: string
  ) {}

  async put(buffer: Buffer, key: string, contentType: string): Promise<string> {
    const { error } = await this.sb.storage
      .from(this.bucket)
      .upload(key, buffer, { contentType, upsert: true });
    if (error) throw new Error(`image upload failed: ${error.message}`);
    return this.sb.storage.from(this.bucket).getPublicUrl(key).data.publicUrl;
  }
}
