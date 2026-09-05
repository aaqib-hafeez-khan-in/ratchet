// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import type { FastifyInstance } from 'fastify';
import { record, MAX_MESSAGE } from '../../domain/feedback.js';
import { stricterThan } from '../rate-limit.js';

/**
 * "Was this page clear?"
 *
 * The write is unauthenticated on purpose. A reader who cannot understand the
 * pricing page has no workspace and no key, and asking them to get one first
 * would exclude precisely the people whose confusion we most need to hear
 * about. That makes this the second unauthenticated write in the service, so it
 * is deliberately the least powerful thing it could be: it creates no account,
 * grants nothing, reads nothing, and returns no information about anything that
 * already exists.
 *
 * There is deliberately no HTTP read. Site feedback belongs to no workspace, so
 * a console session is the wrong key for it — any workspace owner holding one
 * would be able to read everything every visitor had written. Rather than invent
 * an admin credential and a new production-safety check for it, the operator
 * reads this with `npm run feedback`, against the database they already have,
 * and the worker mails a digest when FEEDBACK_DIGEST_TO is set. A public write
 * plus a public read is a graffiti wall; this is a write-only letterbox.
 */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/feedback', {
    // Ten a minute from one address is far more than a human reading a page
    // will ever send, and low enough that the global ceiling behind it is
    // rarely the thing doing the work.
    config: { rateLimit: stricterThan(10) },
    schema: {
      tags: ['Meta'], operationId: 'submitFeedback',
      summary: 'Tell us a page was unclear (no key needed)',
      description:
        'Records whether one page did its job, with an optional message. Stores no IP, sets '
        + 'no cookie, and cannot be read back. An email is optional and is used only to reply '
        + 'to that message.',
      body: {
        type: 'object',
        required: ['path', 'was_clear'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', maxLength: 120,
            description: 'The page being rated, as a site-relative path.' },
          was_clear: { type: 'boolean' },
          message: { type: 'string', maxLength: MAX_MESSAGE },
          reply_to: { type: 'string', format: 'email', maxLength: 254 },
          viewport: { type: 'string', enum: ['phone', 'tablet', 'desktop', 'wide'],
            description: 'Coarse width bucket, so a layout complaint can be reproduced.' },
          // Bots fill in every field they are given. A human never sees this
          // one, so anything in it means the submission is not from a reader.
          website: { type: 'string', maxLength: 200 },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: { received: { type: 'boolean' } },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body as {
      path: string; was_clear: boolean; message?: string;
      reply_to?: string; viewport?: string; website?: string;
    };

    // Always 202, whatever happened. A caller learning that their submission
    // was dropped learns how the filter works, and a reader who typed a
    // paragraph should never be told it bounced.
    reply.code(202);
    if (b.website) return { received: true };

    await record({
      path: b.path,
      wasClear: b.was_clear,
      message: b.message ?? null,
      replyTo: b.reply_to ?? null,
      viewport: b.viewport ?? null,
    });
    return { received: true };
  });
}
