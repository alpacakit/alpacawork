/** Test preparation uses the same fixed operation header as a browser intent; it never adds it to input. */
import type { APIRequestContext } from '@playwright/test';
import { commandBody, commandHeaders } from '../tests/helpers/command-fetch.ts';
export const commandPost = (request: APIRequestContext, url: string, options: Parameters<APIRequestContext['post']>[1] = {}) =>
  request.post(url, { ...options, data: commandBody(options.data, options.headers) as typeof options.data, headers: Object.fromEntries(commandHeaders(options.data, options.headers)) });
