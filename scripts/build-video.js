// Monta docs/video/worktree-graph.mp4 (+ .gif) a partir dos quadros e legendas gravados por make-video.sh.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', '.tmp', 'rec');
const outDir = path.join(root, 'docs', 'video');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
fs.mkdirSync(outDir, { recursive: true });

const t = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8').replace(/^﻿/, ''));
const caps = JSON.parse(fs.readFileSync(path.join(dir, 'captions.json'), 'utf8'));
const fps = (t.frames / ((t.end - t.start) / 1000)).toFixed(3);

// Texto das legendas vai em arquivos, para não brigar com o escape do filtergraph.
const font = 'C\\:/Windows/Fonts/segoeui.ttf';
const draw = caps.map((c, i) => {
  const txt = path.join(dir, `cap${i}.txt`);
  fs.writeFileSync(txt, c.text);
  const a = ((c.t - t.start) / 1000).toFixed(2);
  const b = (((caps[i + 1] ? caps[i + 1].t : t.end) - t.start) / 1000).toFixed(2);
  const file = txt.replace(/\\/g, '/').replace(':', '\\:');
  return `drawtext=fontfile='${font}':textfile='${file}':fontsize=30:fontcolor=white:box=1:boxcolor=0x000000C8:boxborderw=18:x=(w-text_w)/2:y=h-text_h-80:enable='between(t,${a},${b})'`;
});
const filter = path.join(dir, 'filter.txt');
fs.writeFileSync(filter, draw.join(','));

// A captura não tem ritmo constante: com o horário de cada quadro, cada um dura o que durou de verdade
// e as legendas batem com a tela. Sem os horários (gravações antigas), usa a taxa média.
let input = ['-framerate', fps, '-i', path.join(dir, 'frames', 'f%05d.png')];
if (Array.isArray(t.times) && t.times.length === t.frames) {
  const list = t.times.map((ms, i) => {
    const next = i + 1 < t.times.length ? t.times[i + 1] : t.end;
    return `file 'frames/f${String(i).padStart(5, '0')}.png'\nduration ${((next - ms) / 1000).toFixed(3)}`;
  });
  list.push(`file 'frames/f${String(t.frames - 1).padStart(5, '0')}.png'`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n') + '\n');
  input = ['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt')];
}

const mp4 = path.join(outDir, 'worktree-graph.mp4');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...input,
  '-filter_script:v', filter, '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
  'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
  path.join(outDir, 'worktree-graph.gif')], { stdio: 'inherit' });
console.log(`${t.frames} quadros, ${fps} fps, ${((t.end - t.start) / 1000).toFixed(1)} s`);
