import { MAX_AVATAR_BYTES } from "./cast";

/**
 * Turn a frame of the footage into a cast member's face.
 *
 * WHY FROM THE FOOTAGE AND NOT A FILE PICKER. A file picker asks the user to
 * go and find a photograph of someone they are, at that exact moment, looking
 * at on screen. The frame is already there, it is already the right person,
 * and it is already the right person AS THEY APPEAR IN THIS EDIT — the haircut,
 * the costume, the lighting that makes them recognisable in this show and not
 * in a headshot. Grabbing it is one click; finding a photo is a detour out of
 * the app.
 *
 * WHY IT IS INLINED AS A `data:` URL AND NOT A PATH. A cast outlives the
 * footage it was built from: the source gets archived, renamed, moved off the
 * scratch disk, or deleted the week after delivery. A path would leave a
 * roster of broken images exactly when the cast is most useful — on the next
 * season, months later. The cost of inlining is bounded by keeping the image
 * genuinely small, which is what everything below is for.
 */

/** Rendered size. 48px in the UI, so 96 covers 2x displays and nothing more. */
export const AVATAR_SIZE = 96;
/** JPEG quality. Tuned down until a 96px face got close to the byte cap's
 *  comfortable range while staying recognisable; PNG is not an option at this
 *  budget for photographic content. */
export const AVATAR_QUALITY = 0.72;

/**
 * The square to take out of a frame.
 *
 * Centre-crop horizontally, but bias UPWARD vertically. A centred square on a
 * 16:9 frame lands on the middle third of the picture, which for a person
 * standing or sitting in shot is their chest. Faces sit high, so the crop
 * starts one quarter of the way down the overhang rather than half — enough
 * to catch a head in a medium shot without cutting it off in a close-up.
 */
export function avatarCropRect(width: number, height: number): {
  sx: number; sy: number; size: number;
} {
  const size = Math.max(1, Math.min(width, height));
  return {
    sx: Math.round((width - size) / 2),
    sy: Math.round((height - size) / 4),
    size,
  };
}

/** Is this a self-contained image small enough to store on a cast member? */
export function isUsableAvatar(dataUrl: string | null | undefined): dataUrl is string {
  return typeof dataUrl === "string"
    && dataUrl.startsWith("data:image/")
    && dataUrl.length > 0
    && dataUrl.length <= MAX_AVATAR_BYTES;
}

/**
 * Crop a frame to a square face-sized JPEG `data:` URL.
 *
 * Returns null rather than throwing when the blob is not a decodable image or
 * the result would be too large to store — both are "no avatar", and neither
 * is worth interrupting the user over. The size check is real and not
 * belt-and-braces: quality 0.72 at 96px is comfortably inside the cap for a
 * normal frame, but a high-noise or high-detail frame compresses far worse,
 * and a cast of thirty over-budget faces is a file that stops fitting.
 */
export async function frameToAvatarDataUrl(
  frame: Blob,
  size = AVATAR_SIZE,
): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(frame);
  } catch {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { sx, sy, size: src } = avatarCropRect(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, sx, sy, src, src, 0, 0, size, size);
    const url = canvas.toDataURL("image/jpeg", AVATAR_QUALITY);
    return isUsableAvatar(url) ? url : null;
  } catch {
    return null;
  } finally {
    // ImageBitmaps hold decoded pixels off-heap; a leaked one per grab adds up
    // fast when a user is trying five frames to find a good face.
    bitmap.close();
  }
}
