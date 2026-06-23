import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import axios from 'axios';
import { SeedingLogService } from '../seeding-log.service';
import { SeedingRecordService } from '../seeding-record.service';
import {
  SeedingLogActions,
  SeedingLogMessages,
  EnvironmentUriKey,
  BotScrapeStatus,
} from '../../../common/constants/seeding.constants';
import { uploadBufferToB2 } from '../../../common/utils/b2-upload.util';
import { isGoogleHostedUrl } from '../common/google-url';

@Injectable()
export class BotWebhookService {
  private readonly logger = new Logger(BotWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly logService: SeedingLogService,
    private readonly recordService: SeedingRecordService,
  ) {}

  // Mirror a B2-hosted cover/logo URL back onto the DOP seedingrecord
  // so the operator UI (which reads record.transformedData.cover/logo)
  // reflects what was just fetched. Without this, the target business
  // has the new URL but the records panel never updates.
  private async mirrorMediaToRecord(
    businessId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    try {
      const dopRecord =
        (await this.recordService
          .findOneByPublishedId(businessId)
          .catch(() => null)) ||
        (await this.recordService
          .findOneByCvbBusinessId(businessId)
          .catch(() => null));

      if (!dopRecord) {
        this.logger.warn(
          `[BOT] No DOP record to mirror media for ${businessId}`,
        );
        return;
      }

      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        set[`transformedData.${k}`] = v;
      }
      await this.recordService.updateRecord(
        (dopRecord as any)._id.toString(),
        set,
      );
    } catch (err: any) {
      // Surface as record metadata so the operator can see what happened,
      // never silently drop.
      this.logger.warn(
        `[BOT] Mirror media failed for ${businessId}: ${err?.message}`,
      );
      try {
        const rec = await this.recordService
          .findOneByPublishedId(businessId)
          .catch(() => null);
        if (rec) {
          await this.recordService.updateRecord(
            (rec as any)._id.toString(),
            {
              errorMessage:
                `bot mirror failed: ${err?.message ?? 'unknown'}`,
            },
          );
        }
      } catch {
        // last-resort: already logged above
      }
    }
  }

  async handleWebhook(payload: {
    placeId: string;
    businessId: string;
    environment: string;
    sessionId?: string;
    error?: string;
    reviews: any[];
    gallery: any[];
    menu: any[];
    type?: string;
    imageSync?: {
      cover?: string | null;
      logo?: string | null;
    };
  }): Promise<void> {
    const {
      placeId, businessId, environment,
      sessionId, error, reviews, gallery, menu,
      imageSync, type: jobType,
    } = payload;

    const coverImageSyncSource =
      jobType === 'cover_sync' ? 'cover_sync' : 'image_sync';

    this.logger.log(
      `[BOT] ${businessId} ` +
      `${reviews?.length ?? 0}rev/` +
      `${gallery?.length ?? 0}gal/` +
      `${menu?.length ?? 0}menu`,
    );

    const targetUri = this.resolveTargetUri(environment);
    const conn = await mongoose
      .createConnection(targetUri)
      .asPromise();

    let totalGalleryItems = 0;

    try {
      // Log receipt
      if (sessionId) {
        await this.logService.log({
          sessionId,
          action: SeedingLogActions.BOT_WEBHOOK_RECEIVED,
          actor: 'Bot',
          message: SeedingLogMessages.botWebhookReceived(
            businessId, reviews?.length ?? 0,
          ),
        });
      }

      await this.recordService.setBotScrapeStatus(
        businessId,
        { status: BotScrapeStatus.SCRAPING, startedAt: new Date() },
      );

      if (error) {
        if (sessionId) {
          await this.logService.log({
            sessionId,
            action: SeedingLogActions.BOT_FAILED,
            actor: 'Bot',
            message: `Bot scrape failed for ${businessId}: ${error}`,
          });
        }
        await this.recordService.setBotScrapeStatus(
          businessId,
          {
            status: BotScrapeStatus.FAILED,
            completedAt: new Date(),
            error,
          },
        );
        return;
      }

      const businessOid = new mongoose.Types.ObjectId(businessId);

      // ── Get business drive ────────────────────────────
      // All dynamic schemas are timestamped so any .create() call below
      // stamps createdAt/updatedAt automatically.
      const DriveModel = conn.model(
        'Drive',
        new mongoose.Schema<any>({
          owner: mongoose.Schema.Types.ObjectId,
          ownerType: String,
          AvailableSpace: Number,
          TotalSpace: Number,
        }, { strict: false, timestamps: true }),
        'drives',
      );

      const FolderModel = conn.model(
        'Folder',
        new mongoose.Schema<any>({
          parentDirectory: mongoose.Schema.Types.ObjectId,
          parentType: String,
          drive: mongoose.Schema.Types.ObjectId,
          folderName: String,
          entity: String,
        }, { strict: false, timestamps: true }),
        'folders',
      );

      const FileModel = conn.model(
        'File',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'files',
      );

      const ReviewModel = conn.model(
        'Review',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'reviews',
      );

      const MenuModel = conn.model(
        'Menu',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'menus',
      );

      const BusinessModel = conn.model(
        'Business',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'businesses',
      );

      const FileCategoryModel = conn.model(
        'FileCategory',
        new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
        'filecategories',
      );

      // Get drive and gallery folder
      const drive = await DriveModel.findOne({
        owner: businessOid,
      }).lean() as any;

      if (!drive) {
        this.logger.warn(
          `No drive found for business ${businessId}`
        );
        return;
      }

      this.logger.log(`[BOT] Drive ✓`);

      const galleryFolder = await FolderModel.findOne({
        folderName: 'Gallery',
        drive: drive._id,
      }).lean() as any;

      if (galleryFolder) {
        this.logger.log(`[BOT] Gallery folder ✓`);
      }

      // Get file category for gallery images
      const galleryCategory = await FileCategoryModel.findOne({
        name: 'gallery image',
      }).lean() as any;

      const logoCategory = await FileCategoryModel.findOne({
        name: 'logo',
      }).lean() as any;

      // ── IMAGE SYNC ────────────────────────────────────
      if (imageSync) {
        const { cover, logo } = imageSync;

        if (cover && cover.startsWith('http')) {
          try {
            const response = await axios.get(cover, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                  'AppleWebKit/537.36',
                Referer: 'https://www.google.com/',
              },
            });
            const buffer = Buffer.from(response.data);
            const ct =
              response.headers['content-type'] || 'image/jpeg';

            if (
              buffer.length > 5000 &&
              ct.startsWith('image/')
            ) {
              const uploaded = await uploadBufferToB2(
                buffer,
                `cover-${businessId}-${Date.now()}.jpg`,
                ct,
                this.configService,
              );

              await BusinessModel.updateOne(
                { _id: businessOid },
                {
                  $set: {
                    cover: uploaded.url,
                    coverUploaded: true,
                    coverStatus: {
                      fetched: true,
                      source: coverImageSyncSource,
                      fetchedAt: new Date(),
                    },
                  },
                },
              );

              await this.mirrorMediaToRecord(businessId, {
                cover: uploaded.url,
                coverThumbnail: uploaded.url,
                coverUploaded: true,
              });

              this.logger.log(
                `[BOT] Cover synced for ${businessId}`,
              );
            }
          } catch (err: any) {
            this.logger.warn(
              `[BOT] Cover sync failed: ${err.message}`,
            );
          }
        }

        if (logo && logo.startsWith('http')) {
          try {
            const response = await axios.get(logo, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                  'AppleWebKit/537.36',
                Referer: 'https://www.google.com/',
              },
            });
            const buffer = Buffer.from(response.data);
            const ct =
              response.headers['content-type'] || 'image/jpeg';

            if (
              buffer.length > 3000 &&
              ct.startsWith('image/')
            ) {
              const uploaded = await uploadBufferToB2(
                buffer,
                `logo-${businessId}-${Date.now()}.jpg`,
                ct,
                this.configService,
              );

              await BusinessModel.updateOne(
                { _id: businessOid },
                {
                  $set: {
                    logo: uploaded.url,
                    logoUploaded: true,
                    logoStatus: {
                      fetched: true,
                      source: 'image_sync',
                      syncedAt: new Date(),
                    },
                  },
                },
              );

              await this.mirrorMediaToRecord(businessId, {
                logo: uploaded.url,
                logoThumbnail: uploaded.url,
                logoUploaded: true,
              });

              this.logger.log(
                `[BOT] Logo synced for ${businessId}`,
              );
            }
          } catch (err: any) {
            this.logger.warn(
              `[BOT] Logo sync failed: ${err.message}`,
            );
          }
        }
      }

      // ── GALLERY ───────────────────────────────────────
      const processedUrls = new Set<string>();
      if (gallery && gallery.length > 0 && galleryFolder) {
        for (const folder of gallery) {
          try {
            const folderName = folder.folder_name || 'General';
            const mediaItems = folder.media || [];
            if (mediaItems.length === 0) continue;

            this.logger.log(
              `[BOT] 📸 ${folderName} (${mediaItems.length} img)`,
            );

            // Route Menu folder to menus collection
            if (folderName.toLowerCase() === 'menu') {
              // Create a Menu document for gallery menu photos
              const menuDoc = await MenuModel.create({
                name: 'Menu',
                description: 'Menu photos from Google Maps gallery',
                business: businessOid,
                belongsTo: 'Business',
                type: 'gallery_menu',
                images: [],
                createdAt: new Date(),
              });

              const menuFileIds: mongoose.Types.ObjectId[] = [];

              for (let imgIdx = 0; imgIdx < mediaItems.length; imgIdx++) {
                const item = mediaItems[imgIdx];
                try {
                  if (!item.url || !item.url.startsWith('http')) continue;
                  if (processedUrls.has(item.url)) continue;
                  processedUrls.add(item.url);

                  this.logger.log(
                    `[BOT] ⬇ menu-gallery img ${imgIdx + 1}/${mediaItems.length}`
                  );

                  const response = await axios.get(item.url, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                      'Accept-Language': 'en-US,en;q=0.9',
                      'Referer': 'https://www.google.com/',
                      'sec-fetch-dest': 'image',
                      'sec-fetch-mode': 'no-cors',
                      'sec-fetch-site': 'cross-site',
                    },
                  });

                  const buffer = Buffer.from(response.data);
                  const contentType = response.headers['content-type'] || '';
                  if (!contentType.startsWith('image/')) continue;
                  if (buffer.length < 5000) continue;

                  const mimetype = contentType;
                  const filename = `menu-gallery-${Date.now()}.jpg`;

                  const uploaded = await uploadBufferToB2(
                    buffer, filename, mimetype, this.configService,
                  );

                  const fileDoc = await FileModel.create({
                    metaData: {
                      mimeType: mimetype,
                      url: uploaded.url,
                      thumbnailUrl: uploaded.url,
                      size: buffer.length,
                      originalName: filename,
                    },
                    parentDirectory: drive._id,
                    ParentDirectoryType: 'Drive',
                    fileType: 'image',
                    category: logoCategory?._id,
                    parent: businessOid,
                    parentType: 'BusinessUser',
                    entity: 'file',
                    isDeleted: false,
                  });

                  menuFileIds.push(fileDoc._id as mongoose.Types.ObjectId);
                  totalGalleryItems++;

                } catch (imgErr: any) {
                  this.logger.warn(
                    `[BOT] Menu gallery image failed: ${imgErr.message}`
                  );
                }
              }

              // Update menu with file IDs
              if (menuFileIds.length > 0) {
                await MenuModel.updateOne(
                  { _id: menuDoc._id },
                  { $set: { images: menuFileIds } },
                );
                // Push menu to business
                await BusinessModel.updateOne(
                  { _id: businessOid },
                  { $push: { menus: menuDoc._id } },
                );
              }

              this.logger.log(
                `[BOT] ✓ Menu gallery saved (${menuFileIds.length} img)`
              );

              // Skip normal gallery processing for this folder
              continue;
            }

            // Create subfolder inside Gallery folder
            const subFolder = await FolderModel.create({
              parentDirectory: galleryFolder._id,
              parentType: 'Folder',
              drive: drive._id,
              folderName: folderName,
              entity: 'directory',
            });

            this.logger.log(`[BOT] Subfolder created ✓`);

            let folderFileCount = 0;

            // Upload each image
            for (
              let imageIndex = 0;
              imageIndex < mediaItems.length;
              imageIndex++
            ) {
              const item = mediaItems[imageIndex];
              // Skip invalid URLs
              if (!item.url ||
                  !item.url.startsWith('http') ||
                  item.url.length < 20) {
                continue;
              }

              // ── Video items: save URL directly, no B2 upload ────────
              if (item.type === 'video') {
                try {
                  await FileModel.create({
                    metaData: {
                      mimeType: 'video/mp4',
                      url: item.url,
                      thumbnailUrl: item.thumbnail_url || item.url,
                      originalName: `video-${Date.now()}.mp4`,
                    },
                    parentDirectory: subFolder._id,
                    ParentDirectoryType: 'Folder',
                    fileType: 'video',
                    category: galleryCategory?._id,
                    parent: businessOid,
                    parentType: 'BusinessUser',
                    entity: 'file',
                    isDeleted: false,
                  });
                  totalGalleryItems++;
                  folderFileCount++;
                  this.logger.log(`[BOT] 🎬 video saved`);
                } catch (vidErr: any) {
                  this.logger.warn(
                    `[BOT] Video save failed: ${vidErr.message}`,
                  );
                }
                continue;
              }

              try {
                this.logger.log(
                  `[BOT] ⬇ img ${imageIndex+1}/${mediaItems.length}`,
                );

                // Download image
                const response = await axios.get(item.url, {
                  responseType: 'arraybuffer',
                  timeout: 15000,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://www.google.com/',
                    'sec-fetch-dest': 'image',
                    'sec-fetch-mode': 'no-cors',
                    'sec-fetch-site': 'cross-site',
                  },
                });

                const contentType = response.headers['content-type'] || '';
                const buffer = Buffer.from(response.data);
                const urlLower = (item.url || '').toLowerCase();

                // Filter 1: Skip tiny images (avatars, icons)
                if (buffer.length < 15000) {
                  this.logger.warn(
                    `[BOT] Skip: too small (${buffer.length}b) ` +
                    `${item.url.slice(0, 60)}`,
                  );
                  continue;
                }

                // Filter 2: Skip Google profile avatars by URL pattern
                const isAvatar =
                  urlLower.includes('googleusercontent.com/a/') ||
                  urlLower.includes('/photo.jpg') ||
                  /=s\d{2,3}-c/.test(urlLower) ||
                  urlLower.includes('default-user') ||
                  urlLower.includes('no_photo') ||
                  urlLower.includes('/reviewer/') ||
                  urlLower.includes('/contrib/');

                if (isAvatar) {
                  this.logger.warn(
                    `[BOT] Skip: avatar URL pattern ` +
                    `${item.url.slice(0, 60)}`,
                  );
                  continue;
                }

                // Filter 3: Skip 360° / Street View panoramas
                const isPanorama =
                  urlLower.includes('streetview') ||
                  urlLower.includes('cbp=') ||
                  urlLower.includes('photosphere') ||
                  urlLower.includes('/maps/@');

                if (isPanorama) {
                  this.logger.warn(
                    `[BOT] Skip: panorama ` +
                    `${item.url.slice(0, 60)}`,
                  );
                  continue;
                }

                // Filter 4: Skip user-profile-looking content
                // (small images that aren't on Google's verified
                // place-photo CDN paths)
                const isUserContributed =
                  urlLower.includes('af1qip') === false &&
                  urlLower.includes('gps-cs') === false &&
                  urlLower.includes('gps-proxy') === false &&
                  urlLower.includes('lh3.googleusercontent.com/p/') ===
                    false &&
                  urlLower.includes('lh5.googleusercontent.com') === false;

                if (isUserContributed && buffer.length < 50000) {
                  this.logger.warn(
                    `[BOT] Skip: likely user profile image ` +
                    `${item.url.slice(0, 60)}`,
                  );
                  continue;
                }

                // Filter 5: Content type must be image
                if (!contentType.startsWith('image/')) {
                  this.logger.warn(
                    `[BOT] Skip: non-image content type ${contentType}`,
                  );
                  continue;
                }

                const mimetype =
                  response.headers['content-type'] || 'image/jpeg';
                const filename = `${folderName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.jpg`;

                // Upload to B2
                const uploaded = await uploadBufferToB2(
                  buffer,
                  filename,
                  mimetype,
                  this.configService,
                );

                this.logger.log(
                  `[BOT] ☁ uploaded …${uploaded.url.slice(-40)}`,
                );

                // Create File document
                await FileModel.create({
                  metaData: {
                    mimeType: mimetype,
                    url: uploaded.url,
                    thumbnailUrl: uploaded.url,
                    size: buffer.length,
                    originalName: filename,
                  },
                  parentDirectory: subFolder._id,
                  ParentDirectoryType: 'Folder',
                  fileType: 'image',
                  category: galleryCategory?._id,
                  parent: businessOid,
                  parentType: 'BusinessUser',
                  entity: 'file',
                  isDeleted: false,
                });

                this.logger.log(`[BOT] 💾 saved`);

                await new Promise((resolve) => setTimeout(resolve, 100));

                totalGalleryItems++;
                folderFileCount++;
              } catch (imgErr: any) {
                this.logger.warn(
                  `Failed to upload gallery image: ${imgErr.message}`
                );
              }
            }

            this.logger.log(
              `[BOT] ✓ ${folderName} (${folderFileCount ?? 0} img saved)`,
            );
          } catch (folderErr: any) {
            this.logger.warn(
              `Failed to process gallery folder ` +
                `${folder.folder_name}: ${folderErr.message}`,
            );
            continue;
          }
        }

        if (sessionId && totalGalleryItems > 0) {
          await this.logService.log({
            sessionId,
            action: SeedingLogActions.BOT_GALLERY_SAVED,
            actor: 'Bot',
            message: SeedingLogMessages.botGallerySaved(
              businessId, totalGalleryItems,
            ),
          });
        }

        await this.recordService.setBotScrapeStatus(
          businessId,
          {
            status: BotScrapeStatus.SCRAPING,
            startedAt: new Date(),
            galleryFolders: gallery.length,
            galleryImages: totalGalleryItems,
          },
        );

        // ── CVB: auto-apply logo/cover from gallery ──────
        const dopRecord = await this.recordService
          .findOneByPublishedId(businessId)
          .catch(() => null)
          .then((r) =>
            r
              ? r
              : this.recordService
                  .findOneByCvbBusinessId(businessId)
                  .catch(() => null),
          );

        const isCvbRecord = !!dopRecord?.cvbBusinessId;

        const logoFixPending = (dopRecord?.cvbFixes || []).some(
          (f: any) =>
            f.field === 'logo' &&
            f.status === 'pending' &&
            f.suggestedValue === '__fetch_from_bot__',
        );

        const coverFixPending = (dopRecord?.cvbFixes || []).some(
          (f: any) =>
            f.field === 'cover' &&
            f.status === 'pending' &&
            f.suggestedValue === '__fetch_from_bot__',
        );

        if (isCvbRecord && (logoFixPending || coverFixPending)) {
          const PRIORITY_FOLDERS = [
            'by owner', 'by owner (1)', 'food & drink',
            'vibe', 'menu', 'barbecue', 'wine',
          ];

          let bestImageUrl: string | null = null;

          for (const folderName of PRIORITY_FOLDERS) {
            const folder = (gallery as any[]).find(
              (f) => f?.folder_name?.toLowerCase() === folderName,
            );
            if (folder?.media?.length > 0) {
              bestImageUrl = folder.media[0].url;
              break;
            }
          }

          if (!bestImageUrl) {
            for (const folder of (gallery as any[])) {
              if (folder?.media?.length > 0) {
                bestImageUrl = folder.media[0].url;
                break;
              }
            }
          }

          if (bestImageUrl) {
            try {
              this.logger.log(
                `[BOT] CVB: downloading logo/cover image...`,
              );

              const response = await axios.get(bestImageUrl, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                  'Referer': 'https://www.google.com/',
                  'sec-fetch-dest': 'image',
                  'sec-fetch-mode': 'no-cors',
                  'sec-fetch-site': 'cross-site',
                },
              });

              const buffer = Buffer.from(response.data);
              const contentType =
                response.headers['content-type'] || 'image/jpeg';

              if (
                contentType.startsWith('image/') &&
                buffer.length > 10000
              ) {
                const uploaded = await uploadBufferToB2(
                  buffer,
                  `cvb-logo-${Date.now()}.jpg`,
                  contentType,
                  this.configService,
                );

                this.logger.log(
                  `[BOT] CVB: logo/cover uploaded to B2: ` +
                  `${uploaded.url.slice(-50)}`,
                );

                const cvbConn = await mongoose
                  .createConnection(
                    this.resolveTargetUri(environment),
                  )
                  .asPromise();

                try {
                  const CvbBusinessModel = cvbConn.model(
                    'Business',
                    new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
                    'businesses',
                  );

                  const cvbStatusAt = new Date();
                  const updateFields: Record<string, any> = {};
                  if (logoFixPending) {
                    updateFields.logo = uploaded.url;
                    updateFields.logoUploaded = true;
                    updateFields.logoStatus = {
                      fetched: true,
                      source: 'gallery',
                      syncedAt: cvbStatusAt,
                    };
                  }
                  if (coverFixPending) {
                    updateFields.cover = uploaded.url;
                    updateFields.coverUploaded = true;
                    updateFields.coverStatus = {
                      fetched: true,
                      source: 'gallery',
                      fetchedAt: cvbStatusAt,
                    };
                  }

                  await CvbBusinessModel.updateOne(
                    {
                      _id: new mongoose.Types.ObjectId(
                        dopRecord!.cvbBusinessId!,
                      ),
                    },
                    { $set: updateFields },
                  );

                  // Mirror onto the DOP seedingrecord so the side panel
                  // reflects the resolved CVB cover/logo.
                  const mirror: Record<string, unknown> = {};
                  if (logoFixPending) {
                    mirror.logo = uploaded.url;
                    mirror.logoThumbnail = uploaded.url;
                    mirror.logoUploaded = true;
                  }
                  if (coverFixPending) {
                    mirror.cover = uploaded.url;
                    mirror.coverThumbnail = uploaded.url;
                    mirror.coverUploaded = true;
                  }
                  if (Object.keys(mirror).length > 0) {
                    await this.mirrorMediaToRecord(
                      dopRecord!.cvbBusinessId!,
                      mirror,
                    );
                  }

                  this.logger.log(
                    `[BOT] CVB: logo/cover updated in staging DB ✓`,
                  );
                } finally {
                  await cvbConn.close();
                }

                const updatedFixes = (
                  (dopRecord!.cvbFixes as any[]) || []
                ).map((f: any) => {
                  if (
                    (f.field === 'logo' && logoFixPending) ||
                    (f.field === 'cover' && coverFixPending)
                  ) {
                    return {
                      ...f,
                      status: 'applied',
                      appliedAt: new Date(),
                      appliedBy: 'Bot',
                      suggestedValue: uploaded.url,
                    };
                  }
                  return f;
                });

                await this.recordService.updateRecord(
                  dopRecord!._id.toString(),
                  { cvbFixes: updatedFixes },
                );

                this.logger.log(
                  `[BOT] CVB: logo/cover fixes marked as applied ✓`,
                );
              }
            } catch (logoErr: any) {
              this.logger.warn(
                `[BOT] CVB logo/cover upload failed: ` +
                `${logoErr.message}`,
              );
            }
          }
        }
      }

      // ── AUTO-COVER: use first gallery image as cover ──
      // If business has no cover yet, use the first
      // successfully uploaded gallery image
      if (totalGalleryItems > 0) {
        try {
          const business = await BusinessModel.findById(
            businessOid
          ).lean() as any;

          const needsCover = !business?.cover ||
            !business?.coverUploaded ||
            isGoogleHostedUrl(business?.cover);

          if (needsCover) {
            // Find the first uploaded file for this business
            const FileModel = conn.models['File'] ||
              conn.model('File',
                new mongoose.Schema<any>({}, { strict: false, timestamps: true }),
                'files'
              );

            const firstFile = await FileModel.findOne({
              parent: businessOid,
              'metaData.mimeType': { $regex: /^image/ },
              isDeleted: { $ne: true },
            })
              .sort({ createdAt: 1 })
              .lean() as any;

            if (firstFile?.metaData?.url) {
              const galleryFetchedAt = new Date();
              await BusinessModel.updateOne(
                { _id: businessOid },
                {
                  $set: {
                    cover: firstFile.metaData.url,
                    coverUploaded: true,
                    coverStatus: {
                      fetched: true,
                      source: 'gallery',
                      fetchedAt: galleryFetchedAt,
                    },
                  },
                },
              );
              await this.mirrorMediaToRecord(businessId, {
                cover: firstFile.metaData.url,
                coverThumbnail: firstFile.metaData.url,
                coverUploaded: true,
              });
              this.logger.log(
                `[BOT] Auto-set cover from gallery: ${businessId}`
              );

              // Also set logo if missing
              const needsLogo = !business?.logo ||
                !business?.logoUploaded ||
                isGoogleHostedUrl(business?.logo);

              if (needsLogo) {
                await BusinessModel.updateOne(
                  { _id: businessOid },
                  {
                    $set: {
                      logo: firstFile.metaData.url,
                      logoUploaded: true,
                      logoStatus: {
                        fetched: true,
                        source: 'cover',
                        syncedAt: galleryFetchedAt,
                      },
                    },
                  },
                );
                await this.mirrorMediaToRecord(businessId, {
                  logo: firstFile.metaData.url,
                  logoThumbnail: firstFile.metaData.url,
                  logoUploaded: true,
                });
                this.logger.log(
                  `[BOT] Auto-set logo from gallery: ${businessId}`
                );
              }
            }
          }
        } catch (err: any) {
          this.logger.warn(
            `[BOT] Auto-cover failed: ${err.message}`
          );
        }
      }

      // ── MENU ──────────────────────────────────────────
      const menuIds: mongoose.Types.ObjectId[] = [];
      if (menu && menu.length > 0) {
        // Group items by section
        const sections = new Map<string, any[]>();
        for (const item of menu) {
          const section = item.section || 'Highlights';
          if (!sections.has(section)) sections.set(section, []);
          sections.get(section)!.push(item);
        }

        for (const [section, items] of sections) {
          this.logger.log(
            `[BOT] 🍽 Menu: ${section} (${items.length} items)`,
          );

          // Create menu document
          const menuDoc = await MenuModel.create({
            name: section,
            description: 'Menu highlights from Google Maps',
            business: businessOid,
            belongsTo: 'Business',
            type: section,
            images: [],
            createdAt: new Date(),
          });

          const fileIds: mongoose.Types.ObjectId[] = [];

          // Upload menu item images
          for (const item of items) {
            if (!item.photo_url ||
                !item.photo_url.startsWith('http') ||
                item.photo_url.length < 20) {
              continue;
            }
            try {
              const response = await axios.get(item.photo_url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.9',
                  'Accept-Encoding': 'gzip, deflate, br',
                  'Referer': 'https://www.google.com/',
                  'sec-fetch-dest': 'image',
                  'sec-fetch-mode': 'no-cors',
                  'sec-fetch-site': 'cross-site',
                },
              });

              const contentType = response.headers['content-type'] || '';
              if (!contentType.startsWith('image/')) {
                this.logger.warn(
                  `Skipping non-image: ${contentType} for ${item.photo_url.slice(0, 60)}`
                );
                continue;
              }

              const buffer = Buffer.from(response.data);

              if (buffer.length < 5000) {
                this.logger.warn(
                  `Skipping too-small file: ${buffer.length} bytes`
                );
                continue;
              }

              const mimetype =
                response.headers['content-type'] || 'image/jpeg';
              const filename =
                `menu-${item.name?.replace(/\s+/g, '-').toLowerCase() || 'item'}-${Date.now()}.jpg`;

              const uploaded = await uploadBufferToB2(
                buffer,
                filename,
                mimetype,
                this.configService,
              );

              const fileDoc = await FileModel.create({
                metaData: {
                  mimeType: mimetype,
                  url: uploaded.url,
                  thumbnailUrl: uploaded.url,
                  size: buffer.length,
                  originalName: filename,
                },
                parentDirectory: drive._id,
                ParentDirectoryType: 'Drive',
                fileType: 'image',
                category: logoCategory?._id,
                parent: businessOid,
                parentType: 'BusinessUser',
                entity: 'file',
                isDeleted: false,
              });

              fileIds.push(fileDoc._id as mongoose.Types.ObjectId);
            } catch (menuImgErr: any) {
              this.logger.warn(
                `Failed to upload menu image: ${menuImgErr.message}`
              );
            }
          }

          // Update menu with image file IDs
          if (fileIds.length > 0) {
            await MenuModel.updateOne(
              { _id: menuDoc._id },
              { $set: { images: fileIds } },
            );
          }

          this.logger.log(
            `[BOT] ✓ Menu saved (${fileIds.length} img)`,
          );

          menuIds.push(menuDoc._id as mongoose.Types.ObjectId);
        }

        // Push menu IDs to business
        if (menuIds.length > 0) {
          await BusinessModel.updateOne(
            { _id: businessOid },
            { $push: { menus: { $each: menuIds } } },
          );
        }

        if (sessionId) {
          await this.logService.log({
            sessionId,
            action: SeedingLogActions.BOT_MENU_SAVED,
            actor: 'Bot',
            message: SeedingLogMessages.botMenuSaved(
              businessId, menu.length,
            ),
          });
        }

        await this.recordService.setBotScrapeStatus(
          businessId,
          {
            status: BotScrapeStatus.SCRAPING,
            startedAt: new Date(),
            galleryFolders: gallery?.length ?? 0,
            galleryImages: totalGalleryItems,
            menuItems: menu.length,
          },
        );
      }

      // ── REVIEWS ───────────────────────────────────────
      if (reviews && reviews.length > 0) {
        let savedCount = 0;

        for (const r of reviews) {
          try {
            const reviewDoc = {
              source: 'google_maps',
              business: businessOid,
              entityId: placeId,
              entityType: 'business',
              externalReviewId: r.review_id,
              reviewer: {
                externalId: r.reviewer?.profile_url,
                displayName: r.reviewer?.name || 'Unknown',
                profileUrl: r.reviewer?.profile_url,
                avatarUrl: r.reviewer?.avatar_url,
                badges: r.reviewer?.local_guide
                  ? ['Local Guide'] : [],
                totalReviews: r.reviewer?.review_count,
                totalPhotos: r.reviewer?.photo_count,
                isVerified: false,
                isAnonymous: false,
              },
              rating: r.rating,
              rawRating: r.rating,
              rawRatingMax: 5,
              text: r.text ? String(r.text) : undefined,
              language: r.language
                ? String(r.language)
                : undefined,
              reviewedAt: r.reviewed_at
                ? new Date(r.reviewed_at) : undefined,
              reviewedAtRaw: r.date ? String(r.date) : undefined,
              likesCount: r.likes || 0,
              priceRange: r.price_range
                ? String(r.price_range) : undefined,
              attributes: r.tags || {},
              media: (r.photo_urls || []).map((url: string) => ({
                type: 'image',
                sourceUrl: url,
                thumbnailUrl: url,
              })),
              thread: r.owner_reply ? [{
                authorName: 'Owner',
                authorRole: 'owner',
                text: r.owner_reply.text,
                postedAt: new Date(),
                isEdited: false,
              }] : [],
              metadata: {
                googleReviewId: r.review_id,
                googlePlaceId: placeId,
                googleLocalGuide: r.reviewer?.local_guide || false,
              },
              status: 'active',
              tags: [],
              isSpam: false,
              isFeatured: false,
            };

            // Upsert to avoid duplicates. Mongoose's auto-timestamps
            // do not reliably stamp $setOnInsert payloads on the insert
            // half of an upsert, so we stamp explicitly here.
            if (r.review_id) {
              const nowReview = new Date();
              await ReviewModel.updateOne(
                {
                  source: 'google_maps',
                  externalReviewId: r.review_id,
                },
                {
                  $setOnInsert: {
                    ...reviewDoc,
                    createdAt: nowReview,
                    updatedAt: nowReview,
                  },
                },
                { upsert: true },
              );
            } else {
              await ReviewModel.create(reviewDoc);
            }

            savedCount++;

            if (savedCount % 10 === 0) {
              this.logger.log(
                `[BOT] ⭐ reviews ${savedCount}/${reviews.length}`,
              );
            }
          } catch (revErr: any) {
            this.logger.warn(
              `Failed to save review: ${revErr.message}`
            );
          }
        }

        this.logger.log(
          `[BOT] ✓ reviews done (${savedCount} total)`,
        );

        if (sessionId && savedCount > 0) {
          await this.logService.log({
            sessionId,
            action: SeedingLogActions.BOT_REVIEWS_SAVED,
            actor: 'Bot',
            message: SeedingLogMessages.botReviewsSaved(
              businessId, savedCount,
            ),
          });
        }
      }

      await this.recordService.setBotScrapeStatus(
        businessId,
        {
          status: BotScrapeStatus.DONE,
          completedAt: new Date(),
          reviewCount: reviews?.length ?? 0,
          galleryFolders: gallery?.length ?? 0,
          galleryImages: totalGalleryItems,
          menuItems: menu?.length ?? 0,
        },
      );

      await this.recordService.updateBotProgress(
        businessId,
        {
          status: 'done',
          completedAt: new Date(),
          reviewCount: reviews?.length ?? 0,
          galleryFolders: gallery?.length ?? 0,
          galleryImages: totalGalleryItems ?? 0,
          menuItems: menu?.length ?? 0,
          'progress.gallery.status': 'done',
          'progress.gallery.folders': gallery?.length ?? 0,
          'progress.gallery.images': totalGalleryItems ?? 0,
          'progress.menu.status': 'done',
          'progress.menu.items': menu?.length ?? 0,
          'progress.reviews.status':
            (reviews?.length ?? 0) > 0 ? 'done' : 'pending',
          'progress.reviews.current': reviews?.length ?? 0,
          'progress.reviews.total': reviews?.length ?? 0,
          currentStage: 'done',
          currentDetail:
            `${reviews?.length ?? 0} reviews · ` +
            `${totalGalleryItems ?? 0} images · ` +
            `${menu?.length ?? 0} menu items`,
        },
      );

      this.logger.log(
        `[BOT] ✓ Complete ${businessId} ` +
        `rev=${reviews?.length ?? 0} ` +
        `gal=${totalGalleryItems} ` +
        `menu=${menuIds?.length ?? 0}`,
      );
    } catch (err: any) {
      const message =
        err instanceof Error ? err.message : String(err);
      try {
        await this.recordService.setBotScrapeStatus(
          businessId,
          {
            status: BotScrapeStatus.FAILED,
            completedAt: new Date(),
            error: message,
          },
        );
      } catch (trackErr: any) {
        this.logger.warn(
          `Failed to record bot failure for ${businessId}: ${trackErr.message}`,
        );
      }
      throw err;
    } finally {
      await conn.close();
    }
  }

  private resolveTargetUri(environment: string): string {
    const uriKey =
      EnvironmentUriKey[environment as keyof typeof EnvironmentUriKey];
    if (!uriKey) {
      throw new Error(`No URI key for environment: ${environment}`);
    }
    const uri = this.configService.get<string>(uriKey);
    if (!uri) {
      throw new Error(`No URI configured for: ${uriKey}`);
    }
    return uri;
  }
}
