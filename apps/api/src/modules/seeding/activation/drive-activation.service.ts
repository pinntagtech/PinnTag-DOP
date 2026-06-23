import mongoose from 'mongoose';
import {
  DriveOwnerTypes,
  FolderParentTypes,
  DriveDefaults,
  DriveErrorMessages,
} from '../../../common/constants';

// Schemaless + timestamped — Drive / Gallery folder creates need
// createdAt/updatedAt for parity with the rest of the target DB.
const LOOSE_SCHEMA = new mongoose.Schema<any>({}, { strict: false, timestamps: true });

export class DriveActivationService {
  async createDriveForBusiness(params: {
    businessId: string;
    targetConnection: mongoose.Connection;
  }): Promise<{ driveId: string; success: boolean; message: string }> {
    try {
      if (!mongoose.Types.ObjectId.isValid(params.businessId)) {
        return {
          driveId: '',
          success: false,
          message: DriveErrorMessages.invalidOwnerId(),
        };
      }

      const conn = params.targetConnection;

      const DriveModel =
        conn.models['Drive'] || conn.model('Drive', LOOSE_SCHEMA);
      const AdminModel =
        conn.models['Admin'] || conn.model('Admin', LOOSE_SCHEMA);
      const BusinessModel =
        conn.models['Business'] || conn.model('Business', LOOSE_SCHEMA);

      // Check if drive already exists
      const existing = await DriveModel.findOne({
        owner: new mongoose.Types.ObjectId(params.businessId),
      }).lean();

      if (existing) {
        return {
          driveId: String((existing as any)._id),
          success: true,
          message: DriveErrorMessages.driveAlreadyExists(),
        };
      }

      // Verify business exists
      const business = await BusinessModel.findById(
        params.businessId,
      ).lean();
      if (!business) {
        return {
          driveId: '',
          success: false,
          message: DriveErrorMessages.ownerNotFound(DriveOwnerTypes.BUSINESS),
        };
      }

      // Get default space from Admin
      const admin = await AdminModel.findOne()
        .select('driveDefaultSpace')
        .lean();
      const defaultSpace =
        (admin as any)?.driveDefaultSpace || DriveDefaults.DEFAULT_SPACE;

      // Create drive
      const newDrive = await DriveModel.create({
        owner: new mongoose.Types.ObjectId(params.businessId),
        ownerType: DriveOwnerTypes.BUSINESS,
        TotalSpace: defaultSpace,
        AvailableSpace: defaultSpace,
      });

      return {
        driveId: String(newDrive._id),
        success: true,
        message: '',
      };
    } catch (err) {
      return {
        driveId: '',
        success: false,
        message: err instanceof Error ? err.message : 'Drive creation failed',
      };
    }
  }

  async createGalleryFolder(params: {
    businessId: string;
    driveId: string;
    targetConnection: mongoose.Connection;
  }): Promise<{ folderId: string; success: boolean; message: string }> {
    try {
      const conn = params.targetConnection;

      const FolderModel =
        conn.models['Folder'] || conn.model('Folder', LOOSE_SCHEMA);

      // Check if Gallery folder already exists
      const existing = await FolderModel.findOne({
        folderName: DriveDefaults.GALLERY_FOLDER_NAME,
        drive: new mongoose.Types.ObjectId(params.driveId),
      }).lean();

      if (existing) {
        return {
          folderId: String((existing as any)._id),
          success: true,
          message: 'Gallery already exists',
        };
      }

      // Create folder
      const folder = await FolderModel.create({
        folderName: DriveDefaults.GALLERY_FOLDER_NAME,
        parentDirectory: new mongoose.Types.ObjectId(params.driveId),
        parentType: FolderParentTypes.DRIVE,
        drive: new mongoose.Types.ObjectId(params.driveId),
        owner: new mongoose.Types.ObjectId(params.businessId),
        ownerType: DriveOwnerTypes.BUSINESS,
        isDeleted: false,
      });

      return {
        folderId: String(folder._id),
        success: true,
        message: '',
      };
    } catch (err) {
      return {
        folderId: '',
        success: false,
        message:
          err instanceof Error
            ? err.message
            : 'Gallery folder creation failed',
      };
    }
  }
}
