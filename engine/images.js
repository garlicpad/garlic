// Picture fingerprints for the anti-vamp check: an exact hash, and a 64-bit difference hash (dHash)
// that survives resizing, recompression and recolouring. Two pictures within a few bits of each
// other are the same picture.
import { createHash } from 'crypto'
import sharp from 'sharp'

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/**
 * dHash: shrink to 9×8 greyscale (normalized, so a recoloured or darker copy lands in the same
 * place), then one bit per pixel: is it brighter than its right neighbour? 16 hex digits.
 * Animated pictures are hashed on their first frame.
 */
export async function dHash(buf) {
  const px = await sharp(buf, { animated: false, limitInputPixels: 50_000_000 })
    .flatten({ background: '#808080' })
    .greyscale()
    .normalize()
    .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer()
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** Both fingerprints. A picture sharp cannot decode is refused as not a picture. */
export async function fingerprint(buf) {
  try {
    return { imgSha: sha256(buf), imgHash: await dHash(buf) }
  } catch (e) {
    throw Object.assign(new Error('that picture could not be read'), { code: 400 })
  }
}
