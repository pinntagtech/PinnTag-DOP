// Loads the real BusinessIndustry + BusinessCategory taxonomy from staging
// so the category judge can map Claude's proposed labels to actual
// ObjectIds. Same collections PostPublishService / MigrationService read
// from (see post-publish.service.ts:65) — never rebuilds them.
//
// Cache is per-service-instance and lazy: first call opens a staging
// connection, snapshots the two collections, closes the connection. No
// TTL — the process is short-lived (deploy restarts pm2) and the
// taxonomy churn is measured in weeks. If the pipeline evolves into a
// long-running consumer we'll add a refresh call.
//
// Name matching is normalized: lowercase, whitespace-collapsed. That
// mirrors how PostPublishService.resolveIndustryAndCategories does its
// case-insensitive regex lookup, without paying per-record round trips.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';

export interface TaxonomyEntry {
  id: string;
  name: string;
  title: string | null;
}

export interface CategoryEntry extends TaxonomyEntry {
  industryId: string | null;
}

export interface TaxonomySnapshot {
  industries: TaxonomyEntry[];
  categories: CategoryEntry[];
  industryByName: Map<string, TaxonomyEntry>;
  categoryByName: Map<string, CategoryEntry>;
  loadedAt: Date;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

@Injectable()
export class TaxonomyLoader {
  private readonly logger = new Logger(TaxonomyLoader.name);
  private cache: TaxonomySnapshot | null = null;
  private loading: Promise<TaxonomySnapshot> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async load(): Promise<TaxonomySnapshot> {
    if (this.cache) return this.cache;
    if (this.loading) return this.loading;
    this.loading = this.doLoad().finally(() => (this.loading = null));
    this.cache = await this.loading;
    return this.cache;
  }

  private async doLoad(): Promise<TaxonomySnapshot> {
    const uri = this.configService.get<string>('database.pinntagStaging');
    if (!uri) throw new Error('No URI configured for pinntagStaging');
    const t0 = Date.now();
    const conn = await mongoose.createConnection(uri).asPromise();
    try {
      const industryDocs = (await conn
        .collection('businessindustries')
        .find({}, { projection: { name: 1, title: 1 } })
        .toArray()) as any[];
      const categoryDocs = (await conn
        .collection('businesscategories')
        .find({}, { projection: { name: 1, title: 1, industry: 1 } })
        .toArray()) as any[];

      const industries: TaxonomyEntry[] = industryDocs
        .map((d) => ({
          id: String(d._id),
          name: String(d.name ?? d.title ?? '').trim(),
          title: d.title ? String(d.title) : null,
        }))
        .filter((e) => e.name.length > 0);

      const categories: CategoryEntry[] = categoryDocs
        .map((d) => ({
          id: String(d._id),
          name: String(d.name ?? d.title ?? '').trim(),
          title: d.title ? String(d.title) : null,
          industryId: d.industry ? String(d.industry) : null,
        }))
        .filter((e) => e.name.length > 0);

      const industryByName = new Map<string, TaxonomyEntry>();
      for (const i of industries) {
        industryByName.set(normalize(i.name), i);
        if (i.title) industryByName.set(normalize(i.title), i);
      }
      const categoryByName = new Map<string, CategoryEntry>();
      for (const c of categories) {
        categoryByName.set(normalize(c.name), c);
        if (c.title) categoryByName.set(normalize(c.title), c);
      }

      const snapshot: TaxonomySnapshot = {
        industries,
        categories,
        industryByName,
        categoryByName,
        loadedAt: new Date(),
      };
      this.logger.log(
        `Taxonomy loaded: ${industries.length} industries, ` +
          `${categories.length} categories (${Date.now() - t0}ms)`,
      );
      return snapshot;
    } finally {
      await conn.close();
    }
  }

  matchIndustry(label: string | null | undefined, snap: TaxonomySnapshot): TaxonomyEntry | null {
    if (!label) return null;
    return snap.industryByName.get(normalize(label)) ?? null;
  }

  matchCategory(label: string | null | undefined, snap: TaxonomySnapshot): CategoryEntry | null {
    if (!label) return null;
    return snap.categoryByName.get(normalize(label)) ?? null;
  }
}
