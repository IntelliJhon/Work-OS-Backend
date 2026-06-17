import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { env } from '../../config/env';

// Configure cloudinary only if URL is present
if (env.CLOUDINARY_URL) {
  cloudinary.config({
    secure: true,
  });
}

export const uploadStream = (buffer: Buffer, folder: string, originalName: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!env.CLOUDINARY_URL) {
      return reject(new Error('CLOUDINARY_URL is not configured'));
    }

    const cldUploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `workos/${folder}`,
        resource_type: 'auto',
        use_filename: true,
        filename_override: originalName,
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(cldUploadStream);
  });
};

export const getSignedDownloadUrl = (storageKey: string, mimeType: string, originalName: string): string => {
  if (!env.CLOUDINARY_URL) {
    throw new Error('CLOUDINARY_URL is not configured');
  }

  const isRaw = !mimeType.startsWith('image/') && mimeType !== 'application/pdf';
  const resourceType = isRaw ? 'raw' : 'image';
  const ext = originalName.split('.').pop()?.toLowerCase() || '';

  return cloudinary.utils.private_download_url(storageKey, ext, {
    resource_type: resourceType,
    type: 'upload',
    attachment: true,
  });
};

