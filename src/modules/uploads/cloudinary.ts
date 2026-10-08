import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { env } from '../../config/env';

// Configure cloudinary with parsed credentials if URL is present
if (env.CLOUDINARY_URL) {
  try {
    const parsed = new URL(env.CLOUDINARY_URL);
    cloudinary.config({
      cloud_name: parsed.hostname,
      api_key: parsed.username,
      api_secret: parsed.password,
      secure: true,
    });
  } catch {
    cloudinary.config({
      secure: true,
    });
  }
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

/** Cloudinary's storage class for a file: images (and PDFs) as image, audio and video as video, the rest raw */
export const resourceTypeFor = (mimeType: string): 'image' | 'video' | 'raw' => {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (base.startsWith('image/') || base === 'application/pdf') return 'image';
  if (base.startsWith('audio/') || base.startsWith('video/')) return 'video';
  return 'raw';
};

/**
 * A signed link that plays an audio file in any browser: Cloudinary converts it to MP3 on the fly, so a recording
 * made on Android (WebM) also plays on an iPhone, and the other way round.
 */
export const getPlayableAudioUrl = (storageKey: string): string => {
  if (!env.CLOUDINARY_URL) {
    throw new Error('CLOUDINARY_URL is not configured');
  }
  return cloudinary.url(storageKey, { resource_type: 'video', type: 'upload', format: 'mp3', secure: true, sign_url: true });
};

export const getSignedDownloadUrl = (storageKey: string, mimeType: string, originalName: string): string => {
  if (!env.CLOUDINARY_URL) {
    throw new Error('CLOUDINARY_URL is not configured');
  }

  const resourceType = resourceTypeFor(mimeType);
  const ext = originalName.split('.').pop()?.toLowerCase() || '';

  return cloudinary.utils.private_download_url(storageKey, ext, {
    resource_type: resourceType,
    type: 'upload',
    attachment: true,
  });
};

export const deleteFile = (storageKey: string, mimeType: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!env.CLOUDINARY_URL) {
      return reject(new Error('CLOUDINARY_URL is not configured'));
    }

    const resourceType = resourceTypeFor(mimeType);

    cloudinary.uploader.destroy(
      storageKey,
      {
        resource_type: resourceType,
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
  });
};

