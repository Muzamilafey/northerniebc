import multer from 'multer';
import { env } from '../config/env.js';

/** In-memory multipart parser with strict limits; files are validated and scanned before storage. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 5, fields: 50, fieldSize: 100_000 }
});
