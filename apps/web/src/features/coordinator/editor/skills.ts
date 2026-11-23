import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { onBackInReach } from '@/data/connection';
import { resources } from '@/data/resources';
import { useWorkspaceSelector } from '@/data/workspace-store';
import { useConversation } from '../coordinator';
import type { Skill, SkillCatalog } from '@/data/skill-catalog';
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
 * The one judgement of a chosen skill against what the agent the next message goes to can use now: a name its catalog
 * lists, called by the mark the catalog gives it (`invocation`), goes, for the name and its mark are what a message
 * carries and what the CLI resolves. `changed`: the catalog lists the name under another mark (that agent is not the one
 * the skill was chosen for). `unknown` is a catalog that says nothing about it, which is not the skill being wrong. The
 * chip and the send both ask here.
 */
export const skillStanding = (catalog: Pick<SkillCatalog, 'status' | 'skills'>, chosen: Pick<Skill, 'name' | 'invocation'>):
  'usable' | 'changed' | 'gone' | 'unknown' => {
  if (catalog.status !== 'ready') return 'unknown';
  const listed = catalog.skills.find(skill => skill.name === chosen.name);
  return !listed ? 'gone' : listed.invocation === chosen.invocation ? 'usable' : 'changed';
};
/** Why a catalog says nothing about the skills: in the list, on a chip and for a send that cannot go. */
export const skillsUnverified = (t: TFunction, catalog: SkillCatalog) =>
  catalog.reason ? t(`ui:input.skillReasons.${catalog.reason}`, { defaultValue: t('ui:input.skillsUnavailable') }) : t('ui:input.skillsUnavailable');
