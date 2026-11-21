// The introduction a new person is shown before their first request: when it opens by itself, that every slide has
// its picture, and that leaving it at any slide is remembered so it never opens by itself again.
import { afterEach, beforeAll, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { IntroDialog } from '@/features/intro/Intro';
import { SLIDES, pointsFor, slidesFor, startsIntro } from '@/features/intro/intro-definition';
import { introSeen, openIntro, useIntro } from '@/features/intro/intro-state';
import { useDialogStore } from '@/state/dialog-store';
beforeAll(() => startI18n());
afterEach(() => { cleanup(); introSeen.remove(); useIntro.setState({ open: false }); useDialogStore.setState({ dialog: null, behind: [] }); });

it('opens by itself only on a new person\'s first look: the welcome, no Task, nothing said to the coordinator, never closed here', () => {
  expect(startsIntro(false, true, 0, 0)).toBe(true);
  // Someone with work elsewhere opening an empty project, a list with rows, or a browser that closed it before.
  expect(startsIntro(false, true, 3, 0)).toBe(false);
  expect(startsIntro(false, false, 0, 0)).toBe(false);
  expect(startsIntro(true, true, 0, 0)).toBe(false);
  // Someone who has only talked with the coordinator so far; and it waits while the conversation is not read yet.
  expect(startsIntro(false, true, 0, 2)).toBe(false);
  expect(startsIntro(false, true, 0, null)).toBe(false);
});

it('has a picture of its own for every slide in English, which the languages without their own pictures show', () => {
  const pictures = Object.keys(import.meta.glob('../src/features/intro/shots/*.png'));
  for (const slide of SLIDES) expect(pictures, slide.id).toContain(`../src/features/intro/shots/en-${slide.shot}.png`);
  // A picture's numbers are one slide's points: two slides sharing a picture would number it twice over.
  expect(new Set(SLIDES.map(slide => slide.shot)).size).toBe(SLIDES.length);
  // The slide that leads to the settings' Apps tab is left out where that tab is not (a touch screen), and how to
  // install is left out of the installed app's window. A point that can be left out is not numbered in a picture.
  expect(slidesFor(true).some(slide => slide.settings)).toBe(false);
  const apps = SLIDES.find(slide => slide.settings)!;
  expect(pointsFor(apps, true).length).toBe(apps.points.length - 1);
  for (const slide of SLIDES) for (const point of slide.points) if (point.unless) expect(point.part, point.id).toBeUndefined();
});

it('goes through its slides to the end, and closing it at any slide is remembered on this browser', () => {
  openIntro();
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
  expect(useIntro.getState().open).toBe(false);
  view.unmount();
});

it('opens the settings\' Apps tab from its last slide, in place of the introduction', () => {
  openIntro();
  render(<IntroDialog />);
  for (const _ of SLIDES.slice(1)) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open the app and phone steps' }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: 'settings', tab: 'apps' });
  expect(useIntro.getState().open).toBe(false);
  expect(introSeen.get()).toBe(true);
});
