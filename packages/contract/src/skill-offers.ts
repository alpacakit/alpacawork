import { z } from 'zod';

/**
 * The skills setup offers, most recommended first. The recommended ones are marked and ticked at first; names and
 * origins are authoritative here, and what each is for belongs to i18n.
 */
export const SKILL_OFFERS = [
  { name: 'askmeclearly', from: { kind: 'repo', repo: 'alpacakit/pocket-skills' }, recommended: true, cost: false },
  { name: 'doyourjob', from: { kind: 'repo', repo: 'alpacakit/pocket-skills' }, recommended: true, cost: false },
  { name: 'alpacawork-betterquality', from: { kind: 'bundled' }, recommended: true, cost: true },
] as const;
export type SkillName = typeof SKILL_OFFERS[number]['name'];
export const skillNameSchema = z.enum(SKILL_OFFERS.map(skill => skill.name));
export const skillStatusSchema = z.object({
  name: skillNameSchema, installed: z.boolean(), available: z.enum(['yes', 'no', 'unknown']),
  claudeLink: z.enum(['ok', 'missing', 'conflict', 'none']),
}).strict();
export type SkillStatus = z.infer<typeof skillStatusSchema>;
export const skillFailureReasonSchema = z.enum(['unreachable', 'link_conflict', 'npm', 'timeout', 'other']);
export const skillJobItemSchema = z.discriminatedUnion('state', [
  z.object({ name: skillNameSchema, state: z.enum(['waiting', 'installing', 'done']) }).strict(),
  z.object({ name: skillNameSchema, state: z.literal('failed'), reason: skillFailureReasonSchema, detail: z.string().max(4000).optional() }).strict(),
]);
const uniqueNames = <T extends { name: SkillName }>(items: T[]) => new Set(items.map(item => item.name)).size === items.length;
export const skillJobSchema = z.object({
  id: z.string().min(1), items: z.array(skillJobItemSchema).min(1).max(SKILL_OFFERS.length).refine(uniqueNames), finished: z.boolean(),
}).strict().refine(job => job.finished === job.items.every(item => item.state === 'done' || item.state === 'failed'));
export type SkillJob = z.infer<typeof skillJobSchema>;
export const skillsResponseSchema = z.object({
  skills: z.array(skillStatusSchema).length(SKILL_OFFERS.length).refine(uniqueNames), place: z.string().min(1), job: skillJobSchema.nullable(),
}).strict();
export type SkillsResponse = z.infer<typeof skillsResponseSchema>;
export const skillInstallRequestSchema = z.object({ names: z.array(skillNameSchema).min(1).max(SKILL_OFFERS.length).refine(names => new Set(names).size === names.length) }).strict();
export const skillInstallResponseSchema = z.object({ job: skillJobSchema }).strict();
/** Remote offers are selectable without probing their origin; only an explicit install may fetch them. */
export const canSelectSkill = (status: SkillStatus): boolean => status.installed ||
  SKILL_OFFERS.some(offer => offer.name === status.name && (offer.from.kind === 'repo' || status.available === 'yes'));
