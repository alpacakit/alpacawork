/** Before and after side by side from detail-refresh.ts `--film` frames, at their original times (a missing frame is
 * held, never interpolated). The computer's frames are cut to the reader so its line is seen at full size. Usage:
 * node e2e/perf/detail-refresh-film.ts <before.json.film> <after.json.film> <out dir> [label]
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const [before, after, out, label = ''] = process.argv.slice(2); mkdirSync(out!, { recursive: true });
const titles: Record<string, string> = { 'open-diff': '開く（閉じている間に報告が増えた）', 'open-same': '開く（差分なし）', 'open-live': '開いたまま報告が届く' };
const ff = (args: string[]) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-filter_complex_threads', '2', ...args], { encoding: 'utf8', timeout: 120_000 }); if (r.error || r.status !== 0) throw new Error(String(r.error ?? r.stderr)); };
const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
for (const width of [1440, 390]) {
  const clips: string[] = [];
  for (const scene of Object.keys(titles)) {
    const seq = (root: string) => readdirSync(`${root}/${width}-${scene}-0`).filter(n => n.endsWith('.jpg')).sort()
      .map(n => ({ ms: Number(n.slice(0, 5)), file: resolve(`${root}/${width}-${scene}-0/${n}`) }));
    const b = seq(before!), a = seq(after!); const end = Math.max(b.at(-1)!.ms, a.at(-1)!.ms) + 700;
    const lists = [b, a].map((frames, index) => {
      const file = `${out}/${width}-${scene}-${index}.concat`;
      let text = `file '${frames[0]!.file}'\noption framerate 1000\nduration 1.0\n`;
      if (frames[0]!.ms > 0) text += `file '${frames[0]!.file}'\noption framerate 1000\nduration ${frames[0]!.ms / 1000}\n`;
      for (let i = 0; i < frames.length; i++) text += `file '${frames[i]!.file}'\noption framerate 1000\nduration ${((frames[i + 1]?.ms ?? end) - frames[i]!.ms) / 1000}\n`;
      text += `file '${frames.at(-1)!.file}'\noption framerate 1000\n`;
      writeFileSync(file, text); return file;
    });
    const crop = width === 1440 ? 'crop=580:900:860:0,' : '';
    const size = 20;
    const caption = (side: string, colour: string) => `drawtext=fontfile=${font}:text='${side}  ${titles[scene]}${label}':x=10:y=10:fontsize=${size}:fontcolor=${colour},`
      + `drawtext=fontfile=${font}:text='押す前（静止）':enable='lt(t,1.0)':x=10:y=40:fontsize=${size - 6}:fontcolor=white,`
      + `drawtext=fontfile=${font}:text='実時間':enable='gte(t,1.0)':x=10:y=40:fontsize=${size - 6}:fontcolor=white`;
    const filter = `[0:v]${crop}pad=iw:ih+70:0:70:color=0x202020,${caption('前', '0xffc878')}[b];[1:v]${crop}pad=iw:ih+70:0:70:color=0x202020,${caption('後', '0x8ce68c')}[a];`
      + `[b][a]hstack=inputs=2,fps=60,format=yuv420p[v]`;
    const clip = `${out}/${width}-${scene}.mp4`;
    ff(['-safe', '0', '-f', 'concat', '-i', lists[0]!, '-safe', '0', '-f', 'concat', '-i', lists[1]!, '-filter_complex', filter, '-map', '[v]',
      '-t', String(end / 1000 + 1.0), '-c:v', 'libx264', '-threads', '2', '-crf', '20', '-preset', 'fast', clip]);
    clips.push(resolve(clip));
  }
  const join = `${out}/${width}-clips.concat`; writeFileSync(join, clips.map(p => `file '${p}'`).join('\n'));
  const whole = `${out}/compare-${width}.mp4`;
  ff(['-safe', '0', '-f', 'concat', '-i', join, '-c', 'copy', whole]);
  // The same at half speed, to see each step of the line and the rows.
  ff(['-i', whole, '-vf', 'setpts=2*PTS', '-r', '60', '-c:v', 'libx264', '-threads', '2', '-crf', '20', '-preset', 'fast', `${out}/compare-${width}-slow.mp4`]);
  console.log(whole);
}
