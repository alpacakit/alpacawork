/** The address a failed fetch of a part of the code names, when the browser says it. */
export const failedAddress = (error: unknown) => /https?:\/\/\S+?\.js\b/.exec(error instanceof Error ? error.message : String(error))?.[0];
