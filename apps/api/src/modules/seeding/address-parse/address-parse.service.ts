// Address-parse batch service.
//
// Reads businesses with googleFormattedAddress set + addressStatus
// 'address_unparsed', POSTs each raw line to the apps/address-parser
// microservice, builds a proposedAddress, decides 'address_mismatch'
// vs 'correct' against the currently-stored address fields, and writes
// the decision back. NEVER auto-overwrites the live address fields —
// the operator applies via the Data Repair "Fix address" tab.
//
// Mirrors the structure of CoverB2SyncService (limit handling, per-item
// try/catch that doesn't kill the batch, dry-run report, openTargetConn
// + LOOSE_SCHEMA pattern) so future drift between the two stays low.
//
// Parser microservice unreachability is intentionally NOT a batch
// failure: we log + leave the row at 'address_unparsed' and continue.
// That makes the batch resumable after the operator brings the parser
// back up, with no manual state cleanup.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
} from '../../../common/constants';
import { andSeeded } from '../data-repair/data-repair.constants';
import {
  inferCountryFromLatLng,
  lookupCountryPhoneCode,
} from './country-phone-map';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

export interface ParsedAddressComponents {
  road: string | null;
  house: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  raw?: Array<{ label: string; value: string }>;
}

export interface ProposedAddress {
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string | null;
  countryCode: string | null;
}

export interface AddressParseBatchResult {
  environment: string;
  total: number;
  mismatch: number;
  correct: number;
  unparsed: number;
  parserUnreachable: number;
  failed: number;
  dryRun?: boolean;
  details?: Array<{
    businessId: string;
    outcome:
      | 'address_mismatch'
      | 'correct'
      | 'address_unparsed'
      | 'parser_unreachable'
      | 'failed';
    reason?: string;
    proposed?: ProposedAddress;
  }>;
}

@Injectable()
export class AddressParseService {
  private readonly logger = new Logger(AddressParseService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    const baseURL =
      this.configService.get<string>('app.addressParserUrl') ||
      'http://localhost:4101';
    this.http = axios.create({
      baseURL,
      timeout: 4000,
      // Keep failure modes loud: 5xx + network errors throw so the
      // per-item catch in runBatch can mark them parser_unreachable.
    });
  }

  // Count of rows the next batch would consider. Used by the portal
  // for the "Parse addresses (N)" button label / banner.
  async countPending(environment: string): Promise<{
    environment: string;
    count: number;
  }> {
    const conn = await this.openTargetConn(environment);
    try {
      const Business = this.businessModel(conn);
      const count = await Business.countDocuments(this.pendingQuery());
      return { environment, count };
    } finally {
      await conn.close();
    }
  }

  async runBatch(args: {
    environment: string;
    limit?: number;
    dryRun?: boolean;
  }): Promise<AddressParseBatchResult> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const dryRun = args.dryRun === true;

    const conn = await this.openTargetConn(args.environment);
    const result: AddressParseBatchResult = {
      environment: args.environment,
      total: 0,
      mismatch: 0,
      correct: 0,
      unparsed: 0,
      parserUnreachable: 0,
      failed: 0,
      dryRun: dryRun || undefined,
      details: [],
    };

    try {
      const Business = this.businessModel(conn);

      const docs = (await Business.find(this.pendingQuery())
        .select(
          '_id name googleFormattedAddress addressStatus ' +
            'address1 addressLine1 city state postalCode ' +
            'country countryCode latitude longitude',
        )
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean()) as any[];

      result.total = docs.length;

      if (dryRun) {
        for (const d of docs) {
          result.details!.push({
            businessId: String(d._id),
            outcome: 'address_unparsed',
            reason: 'dry_run',
          });
        }
        result.unparsed = docs.length;
        this.logger.log(
          `[ADDR-PARSE] dry-run env=${args.environment} ` +
            `count=${docs.length}`,
        );
        return result;
      }

      for (const d of docs) {
        const businessId = String(d._id);
        let outcome: {
          outcome:
            | 'address_mismatch'
            | 'correct'
            | 'address_unparsed'
            | 'parser_unreachable'
            | 'failed';
          reason?: string;
          proposed?: ProposedAddress;
        };
        try {
          outcome = await this.parseOne(Business, d);
        } catch (err: any) {
          outcome = {
            outcome: 'failed',
            reason: err?.message ?? 'unknown',
          };
        }
        result.details!.push({ businessId, ...outcome });
        switch (outcome.outcome) {
          case 'address_mismatch':
            result.mismatch += 1;
            break;
          case 'correct':
            result.correct += 1;
            break;
          case 'address_unparsed':
            result.unparsed += 1;
            break;
          case 'parser_unreachable':
            result.parserUnreachable += 1;
            break;
          case 'failed':
            result.failed += 1;
            break;
        }
      }

      this.logger.log(
        `[ADDR-PARSE] env=${args.environment} ` +
          `mismatch=${result.mismatch} ` +
          `correct=${result.correct} ` +
          `unparsed=${result.unparsed} ` +
          `parserUnreachable=${result.parserUnreachable} ` +
          `failed=${result.failed} ` +
          `of total=${result.total}`,
      );

      return result;
    } finally {
      await conn.close();
    }
  }

  // ── Internals ───────────────────────────────────────────────

  private async parseOne(
    Business: mongoose.Model<any>,
    d: any,
  ): Promise<{
    outcome:
      | 'address_mismatch'
      | 'correct'
      | 'address_unparsed'
      | 'parser_unreachable'
      | 'failed';
    reason?: string;
    proposed?: ProposedAddress;
  }> {
    const raw: string = (d.googleFormattedAddress ?? '').trim();
    if (!raw) {
      // Shouldn't happen given pendingQuery, but defend anyway —
      // shouldn't pollute the addressStatus on a now-empty doc.
      return { outcome: 'address_unparsed', reason: 'no_raw_address' };
    }

    let parsed: ParsedAddressComponents;
    try {
      const resp = await this.http.post<ParsedAddressComponents>(
        '/parse',
        { address: raw },
      );
      parsed = resp.data;
    } catch (err: any) {
      const status = err?.response?.status;
      // 503 = libpostal not loaded; anything network-level = unreachable.
      // We treat both as 'parser_unreachable' — addressStatus stays at
      // 'address_unparsed' so the next batch tries again.
      this.logger.warn(
        `[ADDR-PARSE] parser http ${status ?? 'net'} for ` +
          `${String(d._id)}: ${err?.message}`,
      );
      return {
        outcome: 'parser_unreachable',
        reason: `parser_http_${status ?? 'net'}`,
      };
    }

    // Country-only fallback from coordinates (e.g. India panel omits
    // the country token). Never override a libpostal-derived country.
    let country = parsed.country?.trim() || null;
    if (!country) {
      const inferred = inferCountryFromLatLng(
        typeof d.latitude === 'number' ? d.latitude : null,
        typeof d.longitude === 'number' ? d.longitude : null,
      );
      if (inferred) country = inferred;
    }

    // Build a single-line proposedAddress.address1 from house + road.
    const houseRoad = [parsed.house, parsed.road]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ');

    // City / state / postcode are accepted only when libpostal gave a
    // non-empty token. The Data Repair tab shows side-by-side so the
    // operator catches a blank component before applying.
    const proposed: ProposedAddress = {
      address1: houseRoad,
      city: (parsed.city ?? '').trim(),
      state: (parsed.state ?? '').trim(),
      postalCode: (parsed.postcode ?? '').trim(),
      country,
      countryCode: lookupCountryPhoneCode(country),
    };

    const hasCore =
      !!proposed.address1 ||
      !!proposed.city ||
      !!proposed.state ||
      !!proposed.postalCode;

    if (!hasCore) {
      // libpostal returned nothing usable — leave row 'address_unparsed'
      // so it surfaces in the operator UI as needing manual review.
      await Business.updateOne(
        andSeeded({ _id: d._id }),
        {
          $set: { addressStatus: 'address_unparsed' },
          $unset: { proposedAddress: '' },
        },
      );
      return {
        outcome: 'address_unparsed',
        reason: 'libpostal_no_components',
      };
    }

    // Decide mismatch vs correct against currently-stored values.
    // Trims + case-insensitive string compare on each field; empty
    // fields on either side are normalised to '' so a missing stored
    // value compares equal to a missing proposed value.
    const currentAddr1 = trimStr(d.address1 ?? d.addressLine1 ?? '');
    const currentCity = trimStr(d.city ?? '');
    const currentState = trimStr(d.state ?? '');
    const currentPostal = trimStr(d.postalCode ?? '');
    const currentCC = trimStr(d.countryCode ?? '');

    const same =
      eqI(currentAddr1, proposed.address1) &&
      eqI(currentCity, proposed.city) &&
      eqI(currentState, proposed.state) &&
      eqI(currentPostal, proposed.postalCode) &&
      // countryCode is only compared when we have a proposal — a null
      // proposal countryCode shouldn't flip an otherwise-matching row
      // to 'address_mismatch'.
      (!proposed.countryCode ||
        eqI(currentCC, proposed.countryCode));

    if (same) {
      await Business.updateOne(
        andSeeded({ _id: d._id }),
        {
          $set: { addressStatus: 'correct' },
          $unset: { proposedAddress: '' },
        },
      );
      return { outcome: 'correct' };
    }

    await Business.updateOne(
      andSeeded({ _id: d._id }),
      {
        $set: {
          addressStatus: 'address_mismatch',
          proposedAddress: proposed,
        },
      },
    );
    return { outcome: 'address_mismatch', proposed };
  }

  // Eligibility for parsing: has a raw googleFormattedAddress AND
  // addressStatus is 'address_unparsed' (i.e. resolve webhook captured
  // it but we haven't run libpostal on it yet). Rows already flagged
  // 'address_mismatch' or 'correct' are excluded — the operator owns
  // 'mismatch' and 'correct' is final. Scoped seeded-only so the
  // parse-pending count and batch never touch an organically-created
  // business — they have their own address-edit flows.
  private pendingQuery(): Record<string, any> {
    return andSeeded({
      googleFormattedAddress: { $type: 'string', $ne: '' },
      addressStatus: 'address_unparsed',
      isDeleted: { $ne: true },
    });
  }

  private async openTargetConn(
    environment: string,
  ): Promise<mongoose.Connection> {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    const uri = uriKey
      ? this.configService.get<string>(uriKey)
      : undefined;
    if (!uri) {
      throw new Error(SeedingErrorMessages.missingTargetUri(environment));
    }
    return mongoose.createConnection(uri).asPromise();
  }

  private businessModel(conn: mongoose.Connection): mongoose.Model<any> {
    return (
      conn.models['AddressParseBusiness'] ||
      conn.model('AddressParseBusiness', LOOSE_SCHEMA, 'businesses')
    );
  }
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function eqI(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
