// The introduction a new person is shown before their first request: when it opens by itself, that every slide has
// its picture, and that leaving it at any slide is remembered so it never opens by itself again.
import { afterEach, beforeAll, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { IntroDialog } from '@/features/intro/Intro';
import { SLIDES, slidesFor, startsIntro } from '@/features/intro/intro-definition';
import { introSeen } from '@/features/intro/intro-state';
import { useDialogStore } from '@/state/dialog-store';
beforeAll(() => startI18n());
afterEach(() => { cleanup(); introSeen.remove(); useDialogStore.setState({ dialog: null, behind: [] }); });

it('opens by itself only on a new person\'s first look: the welcome, no Task in the workspace, never closed here', () => {
  expect(startsIntro(false, true, 0)).toBe(true);
  // Someone with work elsewhere opening an empty project, a list with rows, or a browser that closed it before.
  expect(startsIntro(false, true, 3)).toBe(false);
  expect(startsIntro(false, false, 0)).toBe(false);
  expect(startsIntro(true, true, 0)).toBe(false);
});

it('has a picture for every slide in English, which the languages without their own pictures show', () => {
  const pictures = Object.keys(import.meta.glob('../src/features/intro/shots/*.png'));
  for (const slide of SLIDES) expect(pictures, slide.id).toContain(`../src/features/intro/shots/en-${slide.shot}.png`);
  // The slide that leads to the settings' Apps tab is left out where that tab is not (a touch screen).
  expect(slidesFor(true).some(slide => slide.settings)).toBe(false);
});

it('goes through its slides to the end, and closing it at any slide is remembered on this browser', () => {
  useDialogStore.getState().open('intro');
  const view = render(<IntroDialog />);
  const slide = () => document.querySelector('[data-intro]')!.getAttribute('data-intro-slide');
  expect(slide()).toBe(SLIDES[0]!.id);
  for (const next of SLIDES.slice(1)) { fireEvent.click(screen.getByRole('button', { name: 'Next' })); expect(slide()).toBe(next.id); }
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(slide()).toBe(SLIDES.at(-2)!.id);
  // Skipped from the middle: closed, and remembered.
  expect(introSeen.get()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  expect(introSeen.get()).toBe(true);
  expect(useDialogStore.getState().dialog).toBeNull();
  view.unmount();
});

it('opens the settings\' Apps tab from its last slide, in place of the introduction', () => {
  useDialogStore.getState().open('intro');
  render(<IntroDialog />);
  for (const _ of SLIDES.slice(1)) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open the app and phone steps' }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: 'settings', tab: 'apps' });
  expect(introSeen.get()).toBe(true);
});
