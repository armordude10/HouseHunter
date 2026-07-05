/**
 * Catalog retrieval seam. The understand+select call reasons over a SHORT list of
 * candidates, not the whole catalog. Static for a tiny seed list; pgvector for scale.
 */

import type { CatalogProduct } from "./ai.js";

export interface CatalogRetriever {
  retrieve(query: string, k: number): Promise<CatalogProduct[]>;
}

/** Returns the whole (small) catalog. Fine for a seed list; the model does the picking. */
export class StaticCatalogRetriever implements CatalogRetriever {
  constructor(private catalog: CatalogProduct[]) {}
  async retrieve(): Promise<CatalogProduct[]> {
    return this.catalog;
  }
}

export function rowToCatalogProduct(row: any): CatalogProduct {
  return {
    id: row.id,
    name: row.name,
    keywords: row.keywords ?? [],
    defaultColor: row.default_color,
    default: !!row.is_default,
    technique: row.technique,
    primaryPlacement: row.primary_placement,
    providers: row.providers ?? {},
  };
}
