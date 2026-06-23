// Operator-facing apply path for the Data Repair "Fix address" tab.
//
// listMismatch — paginates over rows that the batch parser has tagged
// addressStatus='address_mismatch'. Returns the stored fields + the
// proposed fields + the raw googleFormattedAddress so the portal can
// render the side-by-side comparison.
//
// applyBatch — writes proposedAddress.address1 onto the live business
// doc's `addressLine1` (the field the consumer app actually reads for
// the public address), alongside city/state/postalCode/country/
// countryCode. `address1` itself is a parser artifact — clean active
// businesses (e.g. Zoo Atlanta) only carry `addressLine1`, so we
// $unset address1 on apply to keep the doc to one canonical field
// and stop the next parser pass from re-flagging on a stale source.
// addressLine2 and locality are left untouched: they may hold valid
// suite/unit info the libpostal parse didn't capture, and we'd
// rather preserve a real suite than auto-clear a "Nueva Base"-style
// junk value (no reliable detector). Operators can edit those fields
// manually if needed.
//
// OUTLETS ARE NOT TOUCHED HERE — earlier versions of this file
// cascaded the business's corrected address down to every linked
// outlet, but that was wrong: a business's outlets are DISTINCT
// physical locations, not copies of the parent ("Discover Atlanta 1"
// = Mercedes-Benz Stadium, its outlet "Alliance Theatre" = 1280
// Peachtree St — different venue, different address). Outlet address
// corruption is detected + fixed via its own pipeline on the outlets
// collection (see listAddressCorruptOutlets in data-repair.service.ts),
// which resolves each outlet from its own name + address.
//
// ONLY this endpoint is allowed to mutate the public address fields
// out of the resolve pipeline; the parser itself never overwrites
// them.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
} from '../../../common/constants';
import { andSeeded } from '../data-repair/data-repair.constants';

const LOOSE_SCHEMA = new mongoose.Schema<any>(
  {},
  { strict: false, timestamps: true },
);

export interface MismatchRow {
  _id: string;
  name?: string;
  googleFormattedAddress?: string;
  current: {
    address1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    countryCode: string;
  };
  proposed: {
    address1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string | null;
    countryCode: string | null;
  };
}

export interface ApplyResult {
  total: number;
  applied: number;
  skipped: number;
  details: Array<{
    businessId: string;
    outcome: 'applied' | 'skipped';
    reason?: string;
    // Populated for applied rows (both dryRun and live) so the operator
    // UI can render the canonical addressLine1 diff. addressLine2 and
    // locality are reported as-is — we don't change them, but showing
    // them helps the operator confirm any leftover junk worth manually
    // clearing post-apply.
    before?: {
      addressLine1: string;
      addressLine2?: string;
      locality?: string;
    };
    after?: {
      addressLine1: string;
      addressLine2?: string;
      locality?: string;
    };
  }>;
  dryRun?: boolean;
}

@Injectable()
export class AddressApplyService {
  private readonly logger = new Logger(AddressApplyService.name);

  constructor(private readonly configService: ConfigService) {}

  async listMismatch(args: {
    environment: string;
    page?: number;
    limit?: number;
  }): Promise<{
    businesses: MismatchRow[];
    total: number;
    page: number;
    pages: number;
  }> {
    const page = Math.max(1, args.page ?? 1);
    const limit = Math.min(100, Math.max(1, args.limit ?? 25));

    const conn = await this.openTargetConn(args.environment);
    try {
      const Business = this.businessModel(conn);
      // Seeded-only so the mismatch list (and its total) never include
      // an organically-created business.
      const query = andSeeded({
        addressStatus: 'address_mismatch',
        proposedAddress: { $type: 'object' },
        isDeleted: { $ne: true },
      });
      const total = await Business.countDocuments(query);
      const pages = Math.max(1, Math.ceil(total / limit));
      const docs = (await Business.find(query)
        .select(
          '_id name googleFormattedAddress proposedAddress ' +
            'address1 addressLine1 city state postalCode country ' +
            'countryCode',
        )
        .sort({ _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()) as any[];

      const businesses: MismatchRow[] = docs.map((d) => ({
        _id: String(d._id),
        name: d.name,
        googleFormattedAddress: d.googleFormattedAddress,
        current: {
          address1: trimStr(d.address1 ?? d.addressLine1 ?? ''),
          city: trimStr(d.city),
          state: trimStr(d.state),
          postalCode: trimStr(d.postalCode),
          country: trimStr(d.country),
          countryCode: trimStr(d.countryCode),
        },
        proposed: {
          address1: trimStr(d.proposedAddress?.address1),
          city: trimStr(d.proposedAddress?.city),
          state: trimStr(d.proposedAddress?.state),
          postalCode: trimStr(d.proposedAddress?.postalCode),
          country: d.proposedAddress?.country ?? null,
          countryCode: d.proposedAddress?.countryCode ?? null,
        },
      }));

      return { businesses, total, page, pages };
    } finally {
      await conn.close();
    }
  }

  async applyBatch(args: {
    environment: string;
    businessIds: string[];
    dryRun?: boolean;
  }): Promise<ApplyResult> {
    const ids = (args.businessIds || []).filter(
      (id) => typeof id === 'string' && id.trim().length > 0,
    );
    const result: ApplyResult = {
      total: ids.length,
      applied: 0,
      skipped: 0,
      details: [],
      dryRun: args.dryRun ? true : undefined,
    };
    if (ids.length === 0) return result;

    const conn = await this.openTargetConn(args.environment);
    try {
      const Business = this.businessModel(conn);
      const docs = (await Business.find(
        andSeeded({
          _id: {
            $in: ids.map((id) => new mongoose.Types.ObjectId(id)),
          },
          addressStatus: 'address_mismatch',
          proposedAddress: { $type: 'object' },
        }),
      )
        // Pull addressLine1 (and the legacy address1 parser-artifact for
        // the display fallback) so the dryRun can show what's being
        // overwritten. addressLine2 + locality come along so the
        // before/after diff makes any leftover junk visible.
        .select(
          '_id proposedAddress addressLine1 address1 ' +
            'addressLine2 locality',
        )
        .lean()) as any[];

      const found = new Set(docs.map((d) => String(d._id)));
      for (const id of ids) {
        if (!found.has(id)) {
          result.skipped += 1;
          result.details.push({
            businessId: id,
            outcome: 'skipped',
            reason: 'not_in_mismatch_set',
          });
        }
      }

      for (const d of docs) {
        const businessId = String(d._id);
        const p = d.proposedAddress as Partial<MismatchRow['proposed']>;

        // Refuse to apply a proposal that is structurally empty —
        // defends against a row that drifted to mismatch then had
        // proposedAddress later cleared.
        const hasCore =
          !!trimStr(p?.address1) ||
          !!trimStr(p?.city) ||
          !!trimStr(p?.state) ||
          !!trimStr(p?.postalCode);
        if (!hasCore) {
          result.skipped += 1;
          result.details.push({
            businessId,
            outcome: 'skipped',
            reason: 'empty_proposal',
          });
          continue;
        }

        // Build the before/after diff for addressLine1 (the consumer
        // display field). Prefer addressLine1 over the legacy address1
        // parser-artifact for the "before" value — that's what was on
        // the public page.
        const proposedLine1 = trimStr(p?.address1);
        const before = {
          addressLine1: trimStr(d.addressLine1 ?? d.address1 ?? ''),
          addressLine2: trimStr(d.addressLine2),
          locality: trimStr(d.locality),
        };
        const after = {
          addressLine1: proposedLine1,
          // We don't touch line2/locality on write; report them
          // unchanged so the operator can spot leftover junk.
          addressLine2: before.addressLine2,
          locality: before.locality,
        };

        if (args.dryRun) {
          result.applied += 1;
          result.details.push({
            businessId,
            outcome: 'applied',
            before,
            after,
          });
          continue;
        }

        // Write to addressLine1 (the consumer display field) instead of
        // the parser-artifact address1, alongside city/state/postalCode/
        // country/countryCode. $unset address1 so a stale parser-side
        // value can't shadow the canonical addressLine1 on the next
        // parse pass (the parser reads address1 first, then falls back
        // to addressLine1). Flip status to 'correct' so the row drops
        // out of the mismatch list.
        await Business.updateOne(
          andSeeded({ _id: d._id }),
          {
            $set: {
              addressLine1: proposedLine1,
              city: trimStr(p?.city),
              state: trimStr(p?.state),
              postalCode: trimStr(p?.postalCode),
              ...(p?.country ? { country: p.country } : {}),
              ...(p?.countryCode ? { countryCode: p.countryCode } : {}),
              addressStatus: 'correct',
            },
            $unset: { proposedAddress: '', address1: '' },
          },
        );
        result.applied += 1;
        result.details.push({
          businessId,
          outcome: 'applied',
          before,
          after,
        });
      }

      this.logger.log(
        `[ADDR-APPLY] env=${args.environment} ` +
          `${result.dryRun ? '(dryRun) ' : ''}` +
          `applied=${result.applied} skipped=${result.skipped} ` +
          `of total=${result.total}`,
      );

      return result;
    } finally {
      await conn.close();
    }
  }

  // (Removed) backfillOutletAddresses — earlier versions copied the
  // parent business address down to its outlets. Wrong assumption:
  // outlets are independent physical locations, not parent copies
  // ("Discover Atlanta 1" parent = Mercedes-Benz Stadium, outlet
  // "Alliance Theatre" = 1280 Peachtree St — different venue,
  // different address). Outlet address fixes flow through the outlet
  // corruption detector + per-outlet resolve/parse/apply instead
  // (see listAddressCorruptOutlets in data-repair.service.ts).

  // ── Internals ───────────────────────────────────────────────

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
      conn.models['AddressApplyBusiness'] ||
      conn.model('AddressApplyBusiness', LOOSE_SCHEMA, 'businesses')
    );
  }
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
