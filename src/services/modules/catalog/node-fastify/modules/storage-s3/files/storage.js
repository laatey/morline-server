import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

let client;
const s3 = () => (client ??= new S3Client({
  region: env.optional('S3_REGION', 'us-east-1'),
  endpoint: env.optional('S3_ENDPOINT', undefined),
  forcePathStyle: env.bool('S3_FORCE_PATH_STYLE', false),
  credentials: { accessKeyId: env.required('S3_ACCESS_KEY_ID'), secretAccessKey: env.required('S3_SECRET_ACCESS_KEY') }
}));
const bucket = () => env.required('S3_BUCKET');

/** Upload a Buffer, string or stream. */
export async function putObject(key, body, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function deleteObject(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** A temporary URL the browser can download the object from. */
export function signedDownloadUrl(key, expiresInSeconds = 900) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: expiresInSeconds });
}

/** A temporary URL the browser can upload to directly with PUT, so large files skip your server. */
export function signedUploadUrl(key, contentType, expiresInSeconds = 900) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: expiresInSeconds });
}
