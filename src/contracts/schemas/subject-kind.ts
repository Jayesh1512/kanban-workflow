import { z } from 'zod';
export const SubjectKindSchema = z.union([
  z.literal('lane'),
  z.literal('card'),
  z.literal('message'),
  z.literal('contact'),
  z.literal('company'),
  z.literal('reference'),
  z.literal('review'),
  z.literal('setting'),
  z.literal('teammate'),
  z.literal('credential'),
  z.literal('account'),
  z.literal('chat'),
  z.literal('mcp'),
]);
