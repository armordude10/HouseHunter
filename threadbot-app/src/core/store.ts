/**
 * Persistence seams. In-memory + local-disk implementations so the pipeline runs
 * out of the box; swap for Supabase (Postgres for specs, Storage for images) in prod.
 *
 * LocalImageStore is also what keeps the supplier hidden: composited previews are
 * written under PUBLIC_BASE_URL (your domain), never served from the provider CDN.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignSpec } from "./designSpec.js";

export interface SpecStore {
  save(spec: DesignSpec): Promise<void>;
  get(id: string): Promise<DesignSpec | null>;
}

export class InMemorySpecStore implements SpecStore {
  private map = new Map<string, DesignSpec>();
  async save(spec: DesignSpec): Promise<void> {
    this.map.set(spec.id, spec);
  }
  async get(id: string): Promise<DesignSpec | null> {
    return this.map.get(id) ?? null;
  }
}

export interface ImageStore {
  /** Store bytes and return a public URL under your own domain. */
  put(buffer: Buffer, key: string, contentType: string): Promise<string>;
}

export class LocalImageStore implements ImageStore {
  constructor(
    private dir: string,
    private publicBase: string
  ) {}

  async put(buffer: Buffer, key: string, _contentType: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), buffer);
    return `${this.publicBase.replace(/\/$/, "")}/${key}`;
  }
}
