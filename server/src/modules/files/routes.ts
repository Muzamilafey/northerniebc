import { Router } from 'express';
import { z } from 'zod';
import { forbidden, notFound, badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { can } from '../../lib/permissions.js';
import { upload } from '../../lib/upload.js';
import { optionalAuth, requirePermission, mfaSatisfied } from '../../middleware/auth.js';
import { StoredFile } from '../../models/index.js';
import { canViewEvidence } from '../results/routes.js';
import { ALLOWED_MIME, isServable, readStoredFile, saveFile } from './storage.js';

export function filesRouter() {
  const r = Router();

  /** Staff uploads (source documents, project evidence, candidate photos, reconciliation evidence). */
  r.post('/', requirePermission('sources.manage', 'projects.manage', 'candidates.manage', 'counties.manage', 'donations.reconcile', 'finance.import'), upload.single('file'), async (req, res) => {
    const { purpose } = parse(z.object({ purpose: z.enum(['SOURCE_DOCUMENT', 'PROJECT_EVIDENCE', 'CANDIDATE_PHOTO', 'PARTY_LOGO', 'COUNTY_LOGO', 'RECONCILIATION_EVIDENCE']) }), req.body);
    if (!req.file) throw badRequest('No file uploaded');
    if (purpose === 'COUNTY_LOGO' && !can(req.user!, 'counties.manage')) throw forbidden();
    if ((purpose === 'PARTY_LOGO' || purpose === 'CANDIDATE_PHOTO') && !can(req.user!, 'candidates.manage')) throw forbidden();
    const isImage = ['CANDIDATE_PHOTO', 'PARTY_LOGO', 'COUNTY_LOGO'].includes(purpose);
    if (isImage && req.file.size > 2 * 1024 * 1024) throw badRequest('Images must be 2 MB or smaller');
    // Images only (JPEG/PNG/WebP). SVG is not accepted because it can carry scripts.
    const allowed = isImage ? ALLOWED_MIME.image : [...ALLOWED_MIME.image, ...ALLOWED_MIME.document];
    const visibility = isImage || purpose === 'SOURCE_DOCUMENT' || purpose === 'PROJECT_EVIDENCE' ? 'PUBLIC' : 'PRIVATE';
    const f = await saveFile(req.file.buffer, { purpose, allowed, originalName: req.file.originalname, uploadedBy: req.user!.id, visibility, requireServable: isImage });
    res.status(201).json({ fileId: String(f._id), sha256: f.sha256, scanStatus: f.scanStatus, visibility: f.visibility });
  });

  /**
   * Serves a file. Public files must be scanned clean. Private files require an authorised user;
   * result evidence is limited to reviewers in scope and the uploading agent.
   */
  r.get('/:id', optionalAuth, async (req, res) => {
    const f = await StoredFile.findById(String(req.params.id)).lean();
    if (!f) throw notFound();
    if (f.visibility !== 'PUBLIC') {
      const u = req.user;
      if (!u || !mfaSatisfied(u)) throw notFound();
      const allowed = f.purpose === 'RESULT_EVIDENCE' ? await canViewEvidence(u, String(f._id)) : String(f.uploadedBy) === u.id || can(u, 'files.read_private');
      if (!allowed) throw forbidden();
    }
    if (!isServable(f.scanStatus)) throw forbidden('File is awaiting malware scanning');
    const buf = await readStoredFile(f.storageKey);
    res.set({
      'Content-Type': f.mime,
      'Content-Length': String(buf.length),
      'Content-Disposition': `${f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${(f.originalName ?? 'file').replace(/"/g, '')}"`,
      'Cache-Control': f.visibility === 'PUBLIC' ? 'public, max-age=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    });
    res.send(buf);
  });

  return r;
}
