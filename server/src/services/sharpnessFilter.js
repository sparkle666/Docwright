import sharp from 'sharp';
import path from 'path';

/**
 * Compute Laplacian variance for an image file.
 * High variance = sharp image, Low variance = blurry/motion-blurred image.
 *
 * The Laplacian operator detects edges. We compute the variance of the output
 * — high variance indicates many strong edges (sharp UI), low variance indicates
 * soft/diffuse edges (blur or motion).
 *
 * Typical ranges:
 * - Sharp UI screenshot: 800–2000
 * - Motion-blurred frame: 20–80
 * - Partially loaded page: 100–200
 *
 * @param {string} filePath - Path to the image file
 * @returns {Promise<number>} Laplacian variance (0–65536 range)
 */
async function laplacianVariance(filePath) {
  try {
    // Load image and convert to grayscale
    const image = sharp(filePath).greyscale();

    // Apply Laplacian kernel (edge detection)
    // The Laplacian kernel is: [[0, -1, 0], [-1, 4, -1], [0, -1, 0]]
    const laplacianKernel = [
      0, -1, 0,
      -1, 4, -1,
      0, -1, 0,
    ];

    const { data } = await image
      .convolve({
        kernel: laplacianKernel,
        width: 3,
        height: 3,
        scale: 1,
        offset: 0,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Compute mean and variance of pixel values
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      sum += data[i];
    }
    const mean = sum / data.length;

    let sumSquaredDiff = 0;
    for (let i = 0; i < data.length; i += 1) {
      const diff = data[i] - mean;
      sumSquaredDiff += diff * diff;
    }
    const variance = sumSquaredDiff / data.length;

    return variance;
  } catch (err) {
    console.error(`Error computing Laplacian variance for ${filePath}:`, err);
    return 0; // Return 0 on error; the frame will be filtered out
  }
}

/**
 * Filter frames by sharpness using Laplacian variance.
 * Discards blurry or motion-blurred frames before they reach the Vision API.
 *
 * @param {Array} frames - Array of frame objects with { id, timestampSeconds, filePath, source }
 * @param {number} threshold - Minimum Laplacian variance to keep (default: 150)
 * @returns {Promise<Array>} Filtered frames with { ...frame, sharpness, isSharp } added
 */
export async function filterBlurryFrames(frames, threshold = 150) {
  if (!frames || frames.length === 0) {
    return [];
  }

  // Compute sharpness for all frames in parallel
  const results = await Promise.all(
    frames.map(async (frame) => {
      const sharpness = await laplacianVariance(frame.filePath);
      return {
        ...frame,
        sharpness,
        isSharp: sharpness >= threshold,
      };
    }),
  );

  // Filter to keep only sharp frames
  const sharpFrames = results.filter((f) => f.isSharp);

  // Log statistics for debugging
  const filtered = results.length - sharpFrames.length;
  const percentageFiltered = Math.round((filtered / results.length) * 100);
  console.log(
    `[Sharpness Filter] ${results.length} frames → ${sharpFrames.length} sharp frames ` +
    `(${percentageFiltered}% filtered, threshold=${threshold})`,
  );

  if (sharpFrames.length === 0) {
    console.warn(
      '[Sharpness Filter] No frames passed the sharpness threshold. ' +
      'Consider lowering the threshold or checking video quality.',
    );
  }

  return sharpFrames;
}

/**
 * Get statistics about frame sharpness in a batch.
 * Useful for tuning the threshold and debugging frame quality issues.
 *
 * @param {Array} frames - Array of frame objects
 * @returns {Promise<object>} Statistics: { min, max, mean, median, threshold }
 */
export async function getSharpnessStats(frames) {
  if (!frames || frames.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, count: 0 };
  }

  const variances = await Promise.all(
    frames.map((frame) => laplacianVariance(frame.filePath)),
  );

  variances.sort((a, b) => a - b);

  const min = variances[0];
  const max = variances[variances.length - 1];
  const mean = variances.reduce((a, b) => a + b, 0) / variances.length;
  const median = variances[Math.floor(variances.length / 2)];

  return { min, max, mean, median, count: variances.length };
}
