import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import mongoose from 'mongoose';
import {
  EnvironmentUriKey,
  SeedingErrorMessages,
  PostPublishMessages,
  SeedingLogMessages,
  BotScrapeStatus,
} from '../../../common/constants';
import {
  OutletCategoryList,
  SubscriptionSource,
  SubscriptionStatus,
} from '../../../common/enums';
import { DriveActivationService } from './drive-activation.service';
import { DopLinkService } from './dop-link.service';
import {
  buildOutletBaseFromBusiness,
  buildSeededBusinessFields,
  buildSeededCreditWallet,
  buildSeededOutletFields,
  hasRealBotCover,
  SEED_DEFAULT_COVER,
  stripManagedFields,
} from './seed-defaults';
import { SeedingRecordService } from '../seeding-record.service';
import { ValidationSeverity } from '../../../common/constants';

// Schemaless but timestamped — every doc we create in a target DB via
// these dynamic models gets createdAt/updatedAt stamped by Mongoose.
const LOOSE_SCHEMA = new mongoose.Schema<any>({}, { strict: false, timestamps: true });

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class PostPublishService {
  private readonly logger = new Logger(PostPublishService.name);
  private readonly pinntagApiUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly recordService: SeedingRecordService,
    private readonly dopLinkService: DopLinkService,
  ) {
    this.pinntagApiUrl =
      this.configService.get<string>('app.pinntagApiUrl') ?? '';
  }

  private getTaxonomyModels(conn: mongoose.Connection): {
    IndustryModel: mongoose.Model<any>;
    CategoryModel: mongoose.Model<any>;
  } {
    const industryModelName = 'BusinessIndustry';
    const categoryModelName = 'BusinessCategory';

    const IndustryModel: mongoose.Model<any> =
      conn.models[industryModelName] ||
      conn.model(
        industryModelName,
        new mongoose.Schema(
          { name: String, title: String },
          { collection: 'businessindustries', strict: false },
        ),
      );

    const CategoryModel: mongoose.Model<any> =
      conn.models[categoryModelName] ||
      conn.model(
        categoryModelName,
        new mongoose.Schema(
          {
            name: String,
            title: String,
            industry: { type: mongoose.Schema.Types.ObjectId },
          },
          { collection: 'businesscategories', strict: false },
        ),
      );

    return { IndustryModel, CategoryModel };
  }

  private async resolveIndustryAndCategories(
    business: any,
    conn: mongoose.Connection,
  ): Promise<{
    businessIndustry?: mongoose.Types.ObjectId;
    businessCategories: mongoose.Types.ObjectId[];
    industryName?: string;
    categoryNames: string[];
  }> {
    const { IndustryModel, CategoryModel } = this.getTaxonomyModels(conn);

    let businessIndustry: mongoose.Types.ObjectId | undefined;
    let industryName: string | undefined;

    if (typeof business.industry === 'string' && business.industry.trim()) {
      const name = business.industry.trim();
      industryName = name;
      const pattern = new RegExp(`^${escapeRegex(name)}$`, 'i');
      const industryDoc = await IndustryModel.findOne({
        $or: [{ name: pattern }, { title: pattern }],
      }).lean();

      if (industryDoc) {
        businessIndustry = (industryDoc as any)._id;
      } else {
        const created = await IndustryModel.create({
          name,
          title: name,
        });
        businessIndustry = created._id;
        this.logger.warn(`[PUBLISH] Created new industry: ${name}`);
      }
    } else if (business.businessIndustry) {
      businessIndustry = business.businessIndustry;
    }

    const businessCategories: mongoose.Types.ObjectId[] = [];
    const categoryNames: string[] = [];

    if (Array.isArray(business.categories)) {
      for (const cat of business.categories) {
        if (typeof cat === 'string' && cat.trim()) {
          const catName = cat.trim();
          categoryNames.push(catName);
          const pattern = new RegExp(`^${escapeRegex(catName)}$`, 'i');
          const catDoc = await CategoryModel.findOne({
            $or: [{ name: pattern }, { title: pattern }],
          }).lean();

          if (catDoc) {
            businessCategories.push((catDoc as any)._id);
          } else {
            const createPayload: Record<string, any> = {
              name: catName,
              title: catName,
            };
            if (businessIndustry) {
              createPayload.industry = businessIndustry;
            }
            const created = await CategoryModel.create(createPayload);
            businessCategories.push(created._id);
            this.logger.warn(`[PUBLISH] Created new category: ${catName}`);
          }
        } else if (cat) {
          businessCategories.push(cat);
        }
      }
    } else if (Array.isArray(business.businessCategories)) {
      for (const id of business.businessCategories) {
        businessCategories.push(id);
      }
    }

    return {
      businessIndustry,
      businessCategories,
      industryName,
      categoryNames,
    };
  }

  async activateBusiness(params: {
    businessId: string;
    environment: string;
    sessionId: string;
    sharedConnection?: mongoose.Connection;
    // Caller-controlled multi-location decision.
    // When `parentBusinessId` is provided, the outlet is attached to
    // that parent (no internal name lookup). When `forceStandalone`
    // is true, no parent lookup happens at all. With both unset, the
    // legacy name-only check below runs — preserving existing callers.
    parentBusinessId?: string;
    forceStandalone?: boolean;
  }): Promise<{ success: boolean; message: string; details: any }> {
    const uriKey =
      EnvironmentUriKey[params.environment as keyof typeof EnvironmentUriKey];
    const targetUri = this.configService.get<string>(uriKey);
    if (!targetUri) {
      return {
        success: false,
        message: SeedingErrorMessages.missingTargetUri(params.environment),
        details: null,
      };
    }

    const conn = params.sharedConnection || mongoose.createConnection(targetUri);
    const shouldCloseConn = !params.sharedConnection;

    try {
      const BusinessModel =
        conn.models['Business'] || conn.model('Business', LOOSE_SCHEMA);
      const OutletModel =
        conn.models['Outlet'] || conn.model('Outlet', LOOSE_SCHEMA);
      const SubscriptionModel =
        conn.models['Subscription'] || conn.model('Subscription', LOOSE_SCHEMA);
      const SubscriptionProductModel =
        conn.models['SubscriptionProduct'] ||
        conn.model('SubscriptionProduct', LOOSE_SCHEMA);
      const BusinessUserModel =
        conn.models['BusinessUser'] || conn.model('BusinessUser', LOOSE_SCHEMA);

      const business = await BusinessModel.findById(params.businessId).lean();
      if (!business) {
        return {
          success: false,
          message: SeedingErrorMessages.sessionNotFound(params.businessId),
          details: null,
        };
      }

      // ── Multi-location detection ────────────────────
      // If the caller pre-resolved the parent (or forced standalone),
      // honour that decision. Otherwise fall back to the legacy
      // name-only lookup so existing callers keep working.
      const currentName = (business as any).name;
      let existingParentBusiness: any = null;

      if (params.parentBusinessId) {
        existingParentBusiness = await BusinessModel.findOne({
          _id: new mongoose.Types.ObjectId(params.parentBusinessId),
          isDeleted: { $ne: true },
        }).lean();
      } else if (!params.forceStandalone && currentName) {
        existingParentBusiness = await BusinessModel.findOne({
          name: {
            $regex: new RegExp(`^${escapeRegex(currentName)}$`, 'i'),
          },
          _id: { $ne: new mongoose.Types.ObjectId(params.businessId) },
          isDeleted: { $ne: true },
        }).lean();
      }

      const isMultiLocation = !!existingParentBusiness;
      const outletBusinessId: mongoose.Types.ObjectId = isMultiLocation
        ? existingParentBusiness._id
        : (business as any)._id;

      if (isMultiLocation) {
        this.logger.log(
          `[PUBLISH] Multi-location detected: "${currentName}" ` +
            `already exists as ${existingParentBusiness._id}. ` +
            `Adding new outlet under existing business.`,
        );
      }

      // Resolve string industry/categories → ObjectIds in the target taxonomy.
      // Scraper-imported records skip TransformationEngine (which would have
      // moved strings to rawIndustry/rawCategories for enrichment to resolve),
      // so the inserted doc may still carry plain string industry/categories.
      const resolved = await this.resolveIndustryAndCategories(business, conn);
      if (resolved.businessIndustry) {
        (business as any).businessIndustry = resolved.businessIndustry;
      }
      if (resolved.businessCategories.length > 0) {
        (business as any).businessCategories = resolved.businessCategories;
      }
      const businessUnset: Record<string, any> = {};
      if (typeof (business as any).industry === 'string') {
        businessUnset.industry = '';
        delete (business as any).industry;
      }
      if (Array.isArray((business as any).categories)) {
        businessUnset.categories = '';
        delete (business as any).categories;
      }

      // ── Resolve PinnTag system BusinessUser (used as creator + owner) ────
      const pinntagUserEmail = this.configService.get<string>(
        'app.pinntagBusinessUserEmail',
      );
      const pinntagUser = pinntagUserEmail
        ? await BusinessUserModel.findOne({
            email: pinntagUserEmail,
          }).lean()
        : null;

      const systemUserId: mongoose.Types.ObjectId =
        (pinntagUser as any)?._id ||
        (business as any).authorisedUser ||
        (business as any).creator;

      if (!systemUserId) {
        return {
          success: false,
          message:
            `Cannot seed business ${params.businessId} — no PinnTag ` +
            `system user resolved (email ${pinntagUserEmail ?? 'unset'})`,
          details: null,
        };
      }

      // ── Apply canonical seed-field overlay onto the inserted business ──
      // Defaults that strict:false models would not apply must be written
      // explicitly. buildSeededBusinessFields preserves anything real on
      // `business` (rating, placeId, real cover from bot, etc.).
      const seeded = buildSeededBusinessFields(
        business as any,
        systemUserId as any,
        { hasBotCover: hasRealBotCover(business as any) },
      );
      stripManagedFields(seeded);

      const setUnsetOps: Record<string, any> = { $set: seeded };
      if (Object.keys(businessUnset).length > 0) {
        setUnsetOps.$unset = businessUnset;
      }
      await BusinessModel.updateOne(
        { _id: new mongoose.Types.ObjectId(params.businessId) },
        setUnsetOps,
      );
      Object.assign(business, seeded);

      // ── Mint consumer share link (skip satellites — they're isActive:
      // false and the share button points at the parent). The link
      // service always returns a usable string (long-URL fallback), so
      // this never throws and never produces a null field.
      if (!isMultiLocation) {
        const shareImage =
          (business as any).coverThumbnail ||
          (business as any).cover ||
          SEED_DEFAULT_COVER;
        const appRedirectLink =
          await this.dopLinkService.generateBusinessShareLink(
            String((business as any)._id),
            (business as any).name,
            shareImage,
          );
        await BusinessModel.updateOne(
          { _id: new mongoose.Types.ObjectId(params.businessId) },
          { $set: { appRedirectLink } },
        );
        (business as any).appRedirectLink = appRedirectLink;
      }

      // ── Ensure 2dsphere index on outlets.location (idempotent) ─────────
      try {
        await OutletModel.collection.createIndex({ location: '2dsphere' });
      } catch (err) {
        this.logger.warn(
          `[PUBLISH] 2dsphere index creation skipped: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      const freeProduct = await SubscriptionProductModel.findOne({
        isFree: true,
      }).lean();

      const now = new Date();
      const endDate = new Date(now);
      endDate.setFullYear(endDate.getFullYear() + 1);

      // ── Create Drive + Gallery folder (idempotent) ────────────────────
      // Done before the outlet so its drivePath/galleryPath can reference
      // the created docs.
      const driveService = new DriveActivationService();
      let driveId: string | null = null;
      let galleryFolderId: string | null = null;

      const driveResult = await driveService.createDriveForBusiness({
        businessId: outletBusinessId.toString(),
        targetConnection: conn,
      });

      if (driveResult.success) {
        driveId = driveResult.driveId;
        this.logger.log(PostPublishMessages.driveCreated(driveId));

        const folderResult = await driveService.createGalleryFolder({
          businessId: outletBusinessId.toString(),
          driveId,
          targetConnection: conn,
        });

        if (folderResult.success) {
          galleryFolderId = folderResult.folderId;
          this.logger.log(PostPublishMessages.galleryCreated(galleryFolderId));
        }

        const driveUpdate: Record<string, any> = {
          drive: new mongoose.Types.ObjectId(driveId),
        };
        if (galleryFolderId) {
          driveUpdate.galleryPath = new mongoose.Types.ObjectId(
            galleryFolderId,
          );
        }
        await BusinessModel.updateOne(
          { _id: outletBusinessId },
          { $set: driveUpdate },
        );
      } else {
        this.logger.warn(PostPublishMessages.driveSkipped(driveResult.message));
      }

      // ── Outlet creation (coordinates required) ─────────────────────────
      // Build the canonical outlet base (address, contact) from the
      // business doc. Shared helper — also used by data-repair to
      // backfill missing outlets with identical field mapping.
      const outletBase = buildOutletBaseFromBusiness(business as any);

      const lng = Number(business.longitude);
      const lat = Number(business.latitude);
      const hasCoords =
        Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0);

      let outletId: string | null = null;
      const outletCategory =
        OutletCategoryList.PHYSICAL as OutletCategoryList;

      if (!hasCoords) {
        const msg =
          'Outlet missing coordinates — not discoverable in consumer app';
        this.logger.warn(`[PUBLISH] ${msg} (business ${params.businessId})`);

        const dopRecord =
          await this.recordService.findOneByPublishedId(params.businessId);
        if (dopRecord) {
          await this.recordService.pushValidationIssue(
            String((dopRecord as any)._id),
            { field: 'location', message: msg, severity: ValidationSeverity.WARNING },
          );
          await this.recordService.updateRecord(
            String((dopRecord as any)._id),
            { errorMessage: msg },
          );
        }
      } else {
        const outletDoc = buildSeededOutletFields(outletBase, {
          businessId: outletBusinessId as any,
          creatorId: systemUserId as any,
          category: outletCategory,
          longitude: lng,
          latitude: lat,
          drivePath: driveId
            ? new mongoose.Types.ObjectId(driveId)
            : undefined,
          galleryPath: galleryFolderId
            ? new mongoose.Types.ObjectId(galleryFolderId)
            : undefined,
        });

        const outlet = await OutletModel.create(outletDoc);
        outletId = String(outlet._id);
        this.logger.log(PostPublishMessages.outletCreated(outletId));

        // Push outlet to BOTH arrays + bump BOTH length counters in
        // lockstep, plus the physical/mobile counter — mirrors
        // OutletService in PinnTag main backend. Skipping any of these
        // breaks getDashboardData which reads
        // business.activatedOutlets.length.
        const unitsField =
          outletCategory === OutletCategoryList.MOBILE
            ? 'mobileUnitsCreated'
            : 'physicalUnitsCreated';
        await BusinessModel.findByIdAndUpdate(outletBusinessId, {
          $push: {
            outlets: outlet._id,
            activatedOutlets: outlet._id,
          },
          $inc: {
            activatedOutletsLength: 1,
            activeOutletsLength: 1,
            [unitsField]: 1,
          },
          $set: { isActive: true },
        });
      }

      // ── Subscription (skip for multi-location satellites) ─────────────
      let subscriptionId: string | null = null;
      if (!isMultiLocation && freeProduct) {
        const subscriptionData: Record<string, any> = {
          source: SubscriptionSource.FREE,
          startDate: now,
          endDate,
          invoiceStartDate: now,
          invoiceEndDate: endDate,
          isCancelled: false,
          isTrialActive: false,
          status: SubscriptionStatus.ACTIVE,
          iapPlatform: 'none',
          product: freeProduct._id,
          isFreePlan: true,
          locationsAllowed: (freeProduct as any).maxLocations || 1,
          business: outletBusinessId,
        };

        const subscription = await SubscriptionModel.create(subscriptionData);
        subscriptionId = String(subscription._id);
        this.logger.log(
          PostPublishMessages.subscriptionCreated(subscriptionId),
        );

        await BusinessModel.findByIdAndUpdate(outletBusinessId, {
          $set: { activeSubscription: subscription._id },
        });
      } else if (isMultiLocation) {
        this.logger.log(
          `[PUBLISH] Skipping subscription for multi-location ` +
            `outlet — parent business already has one`,
        );
      }

      // ── Multi-location satellite marker ───────────────────────────────
      if (isMultiLocation) {
        await BusinessModel.updateOne(
          { _id: new mongoose.Types.ObjectId(params.businessId) },
          {
            $set: {
              isLocationOf: existingParentBusiness._id,
              isActive: false,
            },
          },
        );
      }

      // ── Assign business to PinnTag system BusinessUser ────────────────
      if (pinntagUser) {
        await BusinessUserModel.findByIdAndUpdate(pinntagUser._id, {
          $addToSet: { business: outletBusinessId },
          $set: { selectedBusiness: outletBusinessId },
        });
      }

      // ── CreditWallet (idempotent, non-satellite only) ─────────────────
      if (!isMultiLocation) {
        const CreditWalletModel =
          conn.models['CreditWallet'] ||
          conn.model('CreditWallet', LOOSE_SCHEMA, 'creditwallets');
        await CreditWalletModel.findOneAndUpdate(
          { business: outletBusinessId },
          { $setOnInsert: buildSeededCreditWallet(outletBusinessId as any) },
          { upsert: true, new: true },
        );
      }

      // Logo/cover handled by auto-cover from gallery
      // (bot-webhook.service.ts sets cover from first
      // gallery image after gallery scrape completes)
      this.logger.log(
        `[PUBLISH] Logo/cover will be set from gallery ` +
        `for ${params.businessId}`
      );

      this.logger.log(
        PostPublishMessages.activationComplete(params.businessId),
      );
      this.logger.log(
        `Business ${params.businessId} ready — ` +
          `use portal to fetch gallery, menu and reviews`,
      );

      return {
        success: true,
        message: PostPublishMessages.activationComplete(params.businessId),
        details: {
          outletId,
          subscriptionId,
          driveId,
          galleryFolderId,
        },
      };
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Unknown activation error';
      this.logger.error(
        PostPublishMessages.activationFailed(params.businessId, reason),
      );
      return {
        success: false,
        message: PostPublishMessages.activationFailed(
          params.businessId,
          reason,
        ),
        details: null,
      };
    } finally {
      if (shouldCloseConn) {
        await conn.close();
      }
    }
  }

  private async uploadLogoAndCover(
    businessId: string,
    logoUrl: string,
    coverUrl: string,
  ): Promise<void> {
    try {
      // Download both images in parallel
      const [logoRes, coverRes] = await Promise.all([
        axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 15000 }),
        axios.get(coverUrl, { responseType: 'arraybuffer', timeout: 15000 }),
      ]);

      // Build multipart form
      const FormData = require('form-data');
      const form = new FormData();

      form.append('logo', Buffer.from(logoRes.data), {
        filename: 'logo.jpg',
        contentType: logoRes.headers['content-type'] || 'image/jpeg',
      });

      form.append('cover', Buffer.from(coverRes.data), {
        filename: 'cover.jpg',
        contentType: coverRes.headers['content-type'] || 'image/jpeg',
      });

      form.append('stopGeneratingTemplates', 'true');

      await axios.post(
        `${this.pinntagApiUrl}/v1/admin/upload/business-logo-cover/${businessId}`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            'X-Insider-Api-Key': this.configService.get<string>(
              'app.pinntagInsiderApiKey',
            ),
          },
          timeout: 30000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );

      this.logger.log(`Logo and cover uploaded for business ${businessId}`);
    } catch (err) {
      // Fire and forget — log but never throw
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Logo/cover upload failed for ${businessId}: ${message}`,
      );
    }
  }

  private async triggerBotScrape(
    businessId: string,
    placeId: string,
    businessName: string,
    environment: string,
    sessionId: string,
    userRatingCount?: number,
  ): Promise<void> {
    try {
      const botUrl = this.configService.get<string>('app.pythonBotUrl');
      const secret = this.configService.get<string>('app.botWebhookSecret');
      if (!botUrl) return;

      await axios.post(
        `${botUrl}/scrape`,
        {
          placeId,
          businessId,
          businessName,
          environment,
          sessionId,
          skipMenu: false,
          skipGallery: false,
          skipReviews: true,
          maxReviews: userRatingCount || 100,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-bot-secret': secret,
          },
          timeout: 5000,
        },
      );

      await this.recordService.setBotScrapeStatus(
        businessId,
        { status: BotScrapeStatus.SCRAPING, startedAt: new Date() },
      );

      this.logger.log(SeedingLogMessages.botTriggered(businessId, placeId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Bot trigger failed for ${businessId}: ${message}`);
    }
  }
}
