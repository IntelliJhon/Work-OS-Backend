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
