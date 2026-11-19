import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { onBackInReach } from '@/data/connection';
import { resources } from '@/data/resources';
import { useWorkspaceSelector } from '@/data/workspace-store';
import { useConversation } from '../coordinator';
import type { SkillCatalog } from '@/data/skill-catalog';
import type { TFunction } from 'i18next';
export type { SkillCatalog } from '@/data/skill-catalog';

export function useSkills(profile: string, conversation: string | null): SkillCatalog {
  const root = useWorkspaceSelector(state => state.info.root), client = useQueryClient();
  const options = resources.skills(root, profile, conversation);
  const query = useQuery({ ...options, enabled: !!root && !!conversation });
  // Recovery is demand on the same Query: simultaneous consumers share its flight.
  useEffect(() => onBackInReach(() => {
    if (!root || !conversation) return;
    const state = client.getQueryState(options.queryKey);
    if (!state?.data || state.status === 'error' || state.data.status === 'unavailable')
      void client.refetchQueries({ queryKey: options.queryKey, exact: true, type: 'active' }, { cancelRefetch: false });
  }), [client, root, profile, conversation]);
  // Empty catalog facts stay the same across unrelated card/draft renders, too.
  const fallback = useMemo<SkillCatalog>(() => ({ status: query.isError ? 'unavailable' : 'loading', profile, skills: [] }), [profile, query.isError]);
  if (conversation && query.data && !query.isError) return query.data;
  return fallback;
}
/** The coordinator's catalog: read once the person turns to the coordinator, not with the page. */
export function useCoordinatorSkills(profile: string): SkillCatalog {
  return useSkills(profile, useConversation(state => state.engaged ? state.conversation?.id ?? null : null));
}
/**
 * The one judgement of a chosen skill against what its agent can use now: a name its catalog lists goes, for the name is
 * what a message carries and what the CLI resolves. `unknown` is a catalog that says nothing about it, which is not the
 * skill being wrong. The chip and the send both ask here.
 */
export const skillStanding = (catalog: Pick<SkillCatalog, 'status' | 'skills'>, name: string): 'usable' | 'gone' | 'unknown' =>
  catalog.status !== 'ready' ? 'unknown' : catalog.skills.some(skill => skill.name === name) ? 'usable' : 'gone';
/** Why a catalog says nothing about the skills: in the list, on a chip and for a send that cannot go. */
export const skillsUnverified = (t: TFunction, catalog: SkillCatalog) =>
  catalog.reason ? t(`ui:input.skillReasons.${catalog.reason}`, { defaultValue: t('ui:input.skillsUnavailable') }) : t('ui:input.skillsUnavailable');
