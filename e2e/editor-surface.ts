import type { Locator } from '@playwright/test';

/** Editing commands and native selection stay on the textbox; paint and scrolling belong to its surface. */
export const editorSurface = (textbox: Locator) => textbox.locator('xpath=ancestor::*[@data-label-editor]');
export const labelLayer = (textbox: Locator) => editorSurface(textbox).locator('[data-label-layer]');
