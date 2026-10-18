import express from 'express';
import { ChatError } from './chat-errors.mjs';
import { maxFileBytes } from '../shared/document-submissions.mjs';

export function mountDocumentSubmissionRoutes({ me, hr, employeeOnly, hrOnly, submissions }) {
  const service = () => {
    if (!submissions)
      throw new ChatError(
        503,
        'SUBMISSIONS_NOT_CONFIGURED',
        'Document submissions are not available on this server.',
      );
    return submissions;
  };
  const raw = express.raw({ type: 'application/octet-stream', limit: maxFileBytes });
  me.post(
    '/document-submissions',
    employeeOnly,
    (req, res, next) => {
      if (!req.is('application/octet-stream'))
        throw new ChatError(415, 'FILE_REQUIRED', 'Choose a document to upload.');
      raw(req, res, (error) =>
        next(
          error
            ? new ChatError(413, 'FILE_TOO_LARGE', 'Each file must be 25 MB or smaller.')
            : undefined,
        ),
      );
    },
    async (req, res) => {
      let fileName;
      try {
        fileName = decodeURIComponent(req.get('x-file-name') || '');
      } catch {
        throw new ChatError(400, 'FILE_NAME_INVALID', 'Invalid file name.');
      }
      const submission = await service().create(
        req.accountSession.account,
        { ...req.query, fileName },
        req.body,
      );
      res.status(201).json({ submission });
    },
  );
  for (const [router, guard] of [
    [me, employeeOnly],
    [hr, hrOnly],
  ]) {
    router.get('/document-submissions', guard, async (req, res) =>
      res.json(await service().list(req.accountSession.account)),
    );
    router.get('/document-submissions/:id', guard, async (req, res) =>
      res.json({ submission: await service().get(req.accountSession.account, req.params.id) }),
    );
    router.get('/document-submissions/:id/file', guard, async (req, res) => {
      const { record, bytes } = await service().download(req.accountSession.account, req.params.id);
      res
        .set({
          'Content-Type': record.mime,
          'Content-Disposition': `attachment; filename="document.${record.fileName.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(record.fileName).replace(/'/g, '%27')}`,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
        })
        .send(bytes);
    });
  }
  hr.patch('/document-submissions/:id', hrOnly, async (req, res) =>
    res.json({
      submission: await service().review(req.accountSession.account, req.params.id, req.body),
    }),
  );
}
