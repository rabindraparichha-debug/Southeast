'use client';

/**
 * Camera photo -> JPEG no larger than `max` px on the long side (proof photos ~1280 px, bills a bit
 * more so the text stays readable). Phone photos are 3–8 MB; this keeps uploads small on 3G and
 * under the bucket limits (proofs 3 MB, bills 5 MB). Works offline (all in the browser).
 */
export async function downscaleJpeg(file: Blob, max = 1280, quality = 0.72): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let width: number;
  let height: number;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp;
    width = bmp.width;
    height = bmp.height;
  } catch {
    const img = await loadImage(file);
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }
  if (!width || !height) throw new Error('invalid_photo');
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('invalid_photo');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ('close' in source) source.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('invalid_photo');
  return blob;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('invalid_photo'));
    };
    img.src = url;
  });
}
