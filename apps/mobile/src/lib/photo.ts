// Camera photos are 3–8 MB at full size. Proof, bill and dispatch photos are shrunk on the phone
// before they are saved or queued (same sizes as the web app's downscaleJpeg), so queued items stay
// small, uploads work on a weak signal and stay under the bucket limits (proofs 3 MB, bills 5 MB).
// Shrinking is best effort: if it fails, the original photo is used, never lost.
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

export type PhotoSize = { max: number; quality: number };
/** Delivery proof: enough to see the tiffin at the door. */
export const PROOF_PHOTO: PhotoSize = { max: 1280, quality: 0.7 };
/** Supplier bills and dispatch photos keep a little more detail (text stays readable). */
export const BILL_PHOTO: PhotoSize = { max: 1600, quality: 0.75 };

/** A JPEG no larger than `max` px on the long side; the original uri if anything goes wrong. */
export async function shrinkPhoto(uri: string, size: PhotoSize = PROOF_PHOTO): Promise<string> {
  try {
    // Decoding with a max size never loads the full-resolution image into memory.
    const context = ImageManipulator.manipulate(uri, { maxWidth: size.max, maxHeight: size.max });
    try {
      let image = await context.renderAsync();
      if (Math.max(image.width, image.height) > size.max) {
        const landscape = image.width >= image.height;
        image.release();
        context.resize(landscape ? { width: size.max } : { height: size.max });
        image = await context.renderAsync();
      }
      const saved = await image.saveAsync({ compress: size.quality, format: SaveFormat.JPEG });
      image.release();
      return saved.uri;
    } finally {
      context.release();
    }
  } catch {
    return uri;
  }
}

/** Above this a proof photo would not fit the 3 MB bucket limit with headroom. */
const UPLOAD_LIMIT_BYTES = 2_500_000;

function sizeOf(uri: string): number {
  if (Platform.OS === 'web') return 0;
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

function remove(uri: string) {
  if (Platform.OS === 'web') return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort (it is in the cache folder anyway)
  }
}

/**
 * Bytes to upload for a queued proof photo. Photos queued before shrinking existed (full size) are
 * shrunk to a temporary copy first when they are too big; the queued original is kept until the
 * upload succeeds.
 */
export async function proofPhotoBytes(uri: string, read: (uri: string) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  if (sizeOf(uri) <= UPLOAD_LIMIT_BYTES) return read(uri);
  const small = await shrinkPhoto(uri, PROOF_PHOTO);
  if (small === uri) return read(uri);
  try {
    return await read(small);
  } finally {
    remove(small);
  }
}
