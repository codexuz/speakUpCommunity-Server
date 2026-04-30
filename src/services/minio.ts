import { Client } from 'minio';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import os from 'os';
import path from 'path';
import fs from 'fs';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

const BUCKET = process.env.MINIO_BUCKET || 'speakup-community';

export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
  }
}

export async function uploadAudio(
  fileName: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await minioClient.putObject(BUCKET, fileName, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  return getAudioUrl(fileName);
}

export function getAudioUrl(fileName: string): string {
  return `https://0c274cbb-6ce5-45fb-8540-ad2b7912cd23.srvstatic.uz/${fileName}`;
}

export async function deleteAudio(fileName: string): Promise<void> {
  await minioClient.removeObject(BUCKET, fileName);
}

export async function uploadImage(
  fileName: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await minioClient.putObject(BUCKET, fileName, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  return getAudioUrl(fileName);
}

export async function uploadFile(
  fileName: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await minioClient.putObject(BUCKET, fileName, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  return getAudioUrl(fileName);
}

export async function getAudioBuffer(fileName: string): Promise<Buffer> {
  const stream = await minioClient.getObject(BUCKET, fileName);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a raw (uncompressed) video buffer straight to MinIO under a
 * `threads/tmp/` prefix.  Fast — used by the HTTP route so the request
 * returns immediately.  Returns the MinIO object key (not a public URL).
 */
export async function uploadRawVideo(
  objectKey: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await minioClient.putObject(BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': contentType,
  });
}

/**
 * Download a MinIO object to a local temp file.
 * Returns the absolute path of the written file.
 */
export async function downloadToTmpFile(objectKey: string, suffix: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `minio_${Date.now()}_${suffix}`);
  const stream = await minioClient.getObject(BUCKET, objectKey);
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(tmpPath);
    stream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    stream.on('error', reject);
  });
  return tmpPath;
}

/**
 * Compress a video file at `inputPath` using ffmpeg (H.264 / CRF 28 / 720p max / AAC).
 * Returns { outputPath, thumbPath, durationSecs }.
 * The caller is responsible for deleting the returned files when done.
 */
export async function compressVideoFile(
  inputPath: string,
  baseName: string,
): Promise<{ outputPath: string; thumbPath: string; durationSecs: number }> {
  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `out_${baseName}.mp4`);
  const thumbPath = path.join(tmpDir, `thumb_${baseName}.jpg`);

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-crf 28',
          '-preset fast',
          "-vf scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
          '-movflags +faststart',
          '-pix_fmt yuv420p',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    }),
    new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: ['10%'],
          filename: path.basename(thumbPath),
          folder: path.dirname(thumbPath),
          size: '640x?',
        })
        .on('end', () => resolve())
        .on('error', () => resolve()); // thumbnail failure is non-fatal
    }),
  ]);

  const durationSecs = await new Promise<number>((resolve) => {
    ffmpeg.ffprobe(outputPath, (_err, meta) => {
      resolve(meta?.format?.duration ?? 0);
    });
  });

  return { outputPath, thumbPath, durationSecs };
}

/**
 * Upload a compressed video file + its thumbnail from disk to MinIO.
 * Returns { url, thumbnailUrl, durationSecs }.
 */
export async function uploadCompressedVideo(
  outputPath: string,
  thumbPath: string,
  outKey: string,
  thumbKey: string,
  durationSecs: number,
): Promise<{ url: string; thumbnailUrl: string; durationSecs: number }> {
  const compressedBuffer = fs.readFileSync(outputPath);
  await minioClient.putObject(BUCKET, outKey, compressedBuffer, compressedBuffer.length, {
    'Content-Type': 'video/mp4',
  });

  let thumbnailUrl = '';
  if (fs.existsSync(thumbPath)) {
    const thumbBuffer = fs.readFileSync(thumbPath);
    await minioClient.putObject(BUCKET, thumbKey, thumbBuffer, thumbBuffer.length, {
      'Content-Type': 'image/jpeg',
    });
    thumbnailUrl = getAudioUrl(thumbKey);
  }

  return { url: getAudioUrl(outKey), thumbnailUrl, durationSecs };
}

/**
 * Extract the object key from a public URL and delete it from MinIO.
 * Assumes the URL was generated by getAudioUrl.
 */
export async function deleteMediaFromUrl(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const baseUrl = 'https://0c274cbb-6ce5-45fb-8540-ad2b7912cd23.srvstatic.uz/';
  if (url.startsWith(baseUrl)) {
    const objectKey = url.replace(baseUrl, '');
    await deleteObject(objectKey);
  }
}

/** Delete a MinIO object (silent on missing key). */
export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await minioClient.removeObject(BUCKET, objectKey);
  } catch { /* ignore */ }
}

export { BUCKET, minioClient };

