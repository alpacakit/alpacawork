import { expect, type APIRequestContext } from '@playwright/test';
import { commandPost } from '../command-post.ts';

/**
 * Places a responsible on a top Task (one whose parent is a project) as a person does, by agent assign: the server
 * refuses a child under a Task without one, and seedQuestion or seedReview asks or reports as that responsible.
 * `profile` is an agent config.yaml names. Returns the Task as it is after, with its new hash.
 */
export async function placeResponsible(request: APIRequestContext, origin: string, task: { id: string; hash: string },
  profile = 'codex'): Promise<{ id: string; hash: string }> {
  const placed = await commandPost(request, `${origin}/api/agent/assign`, { data: { task: task.id, role: 'responsible', profile,
    expectedTaskHash: task.hash } });
  expect(placed.ok(), await placed.text()).toBe(true);
  return (await placed.json()).task;
}
