export const MediaProjections = {
  fileList: {
    _id: 1,
    fileType: 1,
    parentType: 1,
    parent: 1,
    entity: 1,
    isDeleted: 1,
    createdAt: 1,
  },
  imageList: {
    _id: 1,
    url: 1,
    isCoverImage: 1,
    event: 1,
    gallery: 1,
  },
} as const;

export const DriveOwnerTypes = {
  USER: 'User',
  BUSINESS_USER: 'BusinessUser',
  ADMIN: 'Admin',
  BUSINESS: 'Business',
} as const;

export const FolderParentTypes = {
  DRIVE: 'Drive',
  FOLDER: 'Folder',
} as const;

export const DriveDefaults = {
  DEFAULT_SPACE: 100,
  GALLERY_FOLDER_NAME: 'Gallery',
} as const;

export const DriveErrorMessages = {
  invalidOwnerId: () =>
    'Invalid ownerId format. Must be a valid MongoDB ObjectId.',
  ownerNotFound: (type: string) =>
    `No ${type} found with the given ownerId.`,
  galleryFolderReserved: () =>
    'Folder name "Gallery" is reserved and cannot be used.',
  folderNotFound: () => 'Folder not found',
  folderNotInDrive: () => 'Folder not found in this drive',
  driveAlreadyExists: () => 'Drive already exists for this owner',
} as const;
