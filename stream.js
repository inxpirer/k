// stream.js - sends a video/image + mp3 (looped) to a Discord voice channel as a camera or Go Live.
// Run with:  npm run stream
require('dotenv').config();

// STREAM_DEBUG=1 in .env prints the library's internal debug logs
if (process.env.STREAM_DEBUG === '1') {
  process.env.DEBUG_LEVEL = 'DEBUG';
  process.env.DEBUG = '*';
} else {
  process.env.DEBUG_LEVEL = 'ERROR'; // hide the library's INFO logs
}
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('@lng2004/discord.js-selfbot-v13');

const { GUILD_ID, CHANNEL_ID } = process.env;

// ---------- settings (all optional, set in .env) ----------
const STREAM_FILE = process.env.STREAM_FILE;            // video or image (default: first one next to this file)
const MP3_FILE = process.env.MP3_FILE || 'audio.mp3';   // audio to loop
const MP3_VOLUME = Number(process.env.MP3_VOLUME || 1);
const WIDTH = Number(process.env.STREAM_WIDTH || 1280);
const HEIGHT = Number(process.env.STREAM_HEIGHT || 720);
const FPS = Number(process.env.STREAM_FPS || 30);
const BITRATE = Number(process.env.STREAM_BITRATE || 1800);         // kbps
const BITRATE_MAX = Number(process.env.STREAM_BITRATE_MAX || 2500); // kbps
const PRESET = process.env.STREAM_PRESET || 'veryfast';
// Videos are converted ONCE to a light H.264 file (cached), so streaming uses almost no CPU.
// Set STREAM_CACHE=0 to disable and encode live instead.
const USE_CACHE = process.env.STREAM_CACHE !== '0';
const CACHE_DIR = path.join(__dirname, '.stream-cache');
// Restart the stream if no video frames are sent for this many seconds
const STALL_SECONDS = Number(process.env.STREAM_STALL_SECONDS || 15);
// 'camera' (default, camera in the voice channel) or 'go-live' (screen share)
const STREAM_TYPE = process.env.STREAM_TYPE === 'go-live' ? 'go-live' : 'camera';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.gif']);

// ---------- tokens (first one is used) ----------
function loadTokens() {
  if (process.env.TOKENS) {
    return process.env.TOKENS.split(',').map(t => t.trim()).filter(Boolean);
  }
  if (process.env.DISCORD_TOKEN) return [process.env.DISCORD_TOKEN];
  const file = path.join(__dirname, 'tokens.txt');
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').split('\n').map(t => t.trim()).filter(t => t && !t.startsWith('#'));
  }
  return [];
}

const tokens = loadTokens();
if (tokens.length === 0 || !GUILD_ID || !CHANNEL_ID) {
  console.error('❌ Missing TOKENS / DISCORD_TOKEN, GUILD_ID or CHANNEL_ID in .env');
  process.exit(1);
}
if (tokens.length > 1) {
  console.log('ℹ️ Several tokens found - streaming only with the first one.');
}

// ---------- find the video / image ----------
function findSource() {
  if (STREAM_FILE) return path.resolve(__dirname, STREAM_FILE);
  const names = fs.readdirSync(__dirname);
  const pick = names.find(n => VIDEO_EXT.has(path.extname(n).toLowerCase()))
    || names.find(n => IMAGE_EXT.has(path.extname(n).toLowerCase()));
  return pick ? path.join(__dirname, pick) : null;
}

const source = findSource();
if (!source || !fs.existsSync(source)) {
  console.error('❌ No video/image found. Put a file (mp4/mkv/webm/png/jpg...) next to stream.js,');
  console.error('   or set STREAM_FILE=yourfile.mp4 in .env');
  process.exit(1);
}
const isImage = IMAGE_EXT.has(path.extname(source).toLowerCase());

const audioPath = path.resolve(__dirname, MP3_FILE);
const audio = fs.existsSync(audioPath) ? audioPath : null;
if (!audio) console.warn(`⚠️ ${MP3_FILE} not found - ${isImage ? 'stream will be silent' : "using the video's own audio"}`);

// ---------- ffmpeg ----------
function pickFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const test = spawnSync('ffmpeg', ['-version']);
  if (!test.error && test.status === 0) return 'ffmpeg';
  try { return require('ffmpeg-static'); } catch (e) { return 'ffmpeg'; }
}
const FFMPEG = pickFfmpeg();

const VIDEO_FILTER = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;

// H.264 settings that Discord likes (no B-frames, keyframe every second)
function x264Args(tune) {
  return [
    '-c:v', 'libx264',
    '-forced-idr', '1',
    ...(tune ? ['-tune', tune] : []),
    '-preset', PRESET,
    '-b:v', `${BITRATE}k`,
    '-maxrate:v', `${BITRATE_MAX}k`,
    '-bufsize:v', `${Math.round(BITRATE / 2)}k`,
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-g', String(FPS),
    '-keyint_min', String(FPS),
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
  ];
}

// ---------- one-time conversion of the video (cached) ----------
function cachePath() {
  const st = fs.statSync(source);
  const key = [source, st.mtimeMs, st.size, WIDTH, HEIGHT, FPS, BITRATE, BITRATE_MAX, PRESET, audio ? 1 : 0].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `${hash}.mp4`);
}

function prepareCache() {
  return new Promise(resolve => {
    if (isImage || !USE_CACHE) return resolve(null);

    const out = cachePath();
    if (fs.existsSync(out)) {
      console.log('♻️ Using already converted video (cache).');
      return resolve(out);
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${out}.part.mp4`;
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }

    console.log('⏳ Converting the video once to a light H.264 file (can take a while for long videos)...');
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:v:0'];
    if (!audio) args.push('-map', '0:a:0?');
    args.push('-vf', VIDEO_FILTER, '-r', String(FPS), '-fps_mode:v', 'cfr', ...x264Args());
    if (audio) args.push('-an');
    else args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp);

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastErr = '';
    let lastPrint = 0;
    const started = Date.now();
    proc.stderr.on('data', d => { lastErr = String(d).trim().split('\n').slice(-3).join(' | '); });
    proc.stdout.on('data', d => {
      const m = String(d).match(/out_time=(\d+:\d+:\d+)/g);
      if (m && Date.now() - lastPrint > 10000) {
        lastPrint = Date.now();
        console.log(`   ...converted up to ${m[m.length - 1].replace('out_time=', '')}`);
      }
    });
    proc.on('error', err => {
      console.error('❌ Could not run ffmpeg for conversion:', err.message);
      resolve(null);
    });
    proc.on('exit', code => {
      if (code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, out);
        console.log(`✅ Conversion done in ${Math.round((Date.now() - started) / 1000)}s.`);
        resolve(out);
      } else {
        console.error(`⚠️ Conversion failed (code ${code}). ${lastErr}`);
        console.error('   Falling back to live encoding (heavier on the CPU).');
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        resolve(null);
      }
    });
  });
}

// ---------- streaming command ----------
function buildArgs(videoInput, copyVideo) {
  const args = ['-hide_banner', '-loglevel', 'error'];

  // genpts: rebuild clean timestamps so the loop point does not break the stream
  if (isImage) args.push('-loop', '1', '-framerate', String(FPS), '-i', videoInput);
  else args.push('-fflags', '+genpts', '-stream_loop', '-1', '-i', videoInput);

  if (audio) args.push('-stream_loop', '-1', '-i', audio);

  args.push('-map', '0:v:0');
  const hasAudio = Boolean(audio) || !isImage;
  if (audio) args.push('-map', '1:a:0');
  else if (!isImage) args.push('-map', '0:a:0?');

  if (copyVideo) {
    // video is already H.264 with the right settings - no encoding needed
    // convert MP4 (AVCC) packets to Annex B, which the streaming library expects
    args.push('-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb');
  } else {
    args.push(
      '-vf', VIDEO_FILTER,
      '-r', String(FPS),
      '-fps_mode:v', 'cfr',
      ...x264Args(isImage ? 'stillimage' : 'film'),
    );
  }

  if (hasAudio) {
    args.push('-c:a', 'libopus', '-ac', '2', '-ar', '48000', '-b:a', '128k', '-af', `volume=${MP3_VOLUME}`);
  }

  args.push('-f', 'nut', 'pipe:1');
  return args;
}

// ---------- main ----------
let stopped = false;
let ffmpegProc = null;
let streamer = null;
let client = null;
let onStreamDeleted = null; // set per run, called when the stream must be restarted

function killFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    ffmpegProc = null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

async function main() {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { /* ignore */ }

  // convert the video once (skipped for images / when already cached)
  const cached = await prepareCache();
  const videoInput = cached || source;
  const copyVideo = Boolean(cached);

  const { Streamer, playStream } = await import('@dank074/discord-video-stream');

  client = new Client();
  streamer = new Streamer(client);

  // If Discord ends our stream, restart it
  client.on('raw', packet => {
    if (!packet || packet.t !== 'STREAM_DELETE') return;
    if (onStreamDeleted) {
      console.error('⚠️ Discord ended the stream:', JSON.stringify(packet.d));
      onStreamDeleted(new Error('STREAM_DELETE: ' + JSON.stringify(packet.d)));
    }
  });

  const ready = new Promise(resolve => client.once('ready', resolve));
  client.on('error', err => console.error('❌ Client error:', err.message));
  await client.login(tokens[0]);
  await ready;
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎞️ Source: ${path.basename(source)} (${isImage ? 'image' : 'video'})${audio ? ` + ${path.basename(audio)}` : ''}`);
  console.log(`🛠️ ffmpeg: ${FFMPEG}${copyVideo ? ' (light mode: no live video encoding)' : ''}`);

  while (!stopped) {
    let diag = null;
    try {
      console.log('📢 Joining voice channel...');
      await withTimeout(streamer.joinVoice(GUILD_ID, CHANNEL_ID), 30000, 'Voice join timed out');
      console.log('✅ In voice channel.');

      ffmpegProc = spawn(FFMPEG, buildArgs(videoInput, copyVideo), { stdio: ['ignore', 'pipe', 'pipe'] });
      let lastErr = '';
      ffmpegProc.stderr.on('data', d => { lastErr = String(d).trim().split('\n').slice(-3).join(' | '); });
      ffmpegProc.on('error', err => console.error('❌ Could not start ffmpeg:', err.message));
      ffmpegProc.on('exit', code => {
        if (!stopped) console.error(`⚠️ ffmpeg exited (code ${code}). ${lastErr}`);
      });

      console.log(`📺 Streaming (${STREAM_TYPE === 'camera' ? 'camera' : 'Go Live'}) - looping...`);

      // Watchdog promise: rejects when the stream stalls / breaks
      let failRun;
      const watchdog = new Promise((_, rej) => { failRun = rej; });
      watchdog.catch(() => {});
      onStreamDeleted = failRun;

      let ticks = 0;
      let stalledTicks = 0;
      let seenHealthy = false;
      let badTicks = 0;
      let lastTick = Date.now();
      let daveBadTicks = 0;
      const counters = { v: 0, a: 0, vBytes: 0 };
      let last = { v: 0, a: 0 };
      const patch = sc => {
        if (!sc || sc.__patched || !sc.webRtcConn) return false;
        sc.__patched = true;
        const w = sc.webRtcConn;
        const sendV = w.sendVideoFrame.bind(w);
        const sendA = w.sendAudioFrame.bind(w);
        // count only frames that are really sent (the library silently drops them when the RTC link is down)
        w.sendVideoFrame = (f, t) => { if (w.ready) { counters.v++; counters.vBytes += f.length; } return sendV(f, t); };
        w.sendAudioFrame = (f, t) => { if (w.ready) counters.a++; return sendA(f, t); };
        return true;
      };
      diag = setInterval(() => {
        ticks++;
        if (process.send) { try { process.send('hb'); } catch (e) { /* ignore */ } } // heartbeat for run.js (silent)
        // event-loop lag: if the program itself freezes, this shows it
        const nowMs = Date.now();
        const lag = nowMs - lastTick - 5000;
        lastTick = nowMs;
        if (lag > 1500) console.warn(`🐢 Program was frozen for ~${Math.round(lag / 1000)}s (event loop blocked)`);
        const sc = STREAM_TYPE === 'camera'
          ? streamer.voiceConnection
          : streamer.voiceConnection && streamer.voiceConnection.streamConnection;
        patch(sc);

        // connection health: both websockets OPEN (1) and WebRTC connected
        const vc = streamer.voiceConnection;
        const wsState = { voice: vc && vc.ws ? vc.ws.readyState : null, stream: sc && sc.ws ? sc.ws.readyState : null };
        const rtcReady = Boolean(sc && sc.webRtcConn && sc.webRtcConn.ready);
        const connOk = rtcReady && wsState.voice === 1 && wsState.stream === 1;
        if (connOk) seenHealthy = true;
        if (seenHealthy && !connOk) badTicks++; else badTicks = 0;
        if (badTicks > 0) console.warn(`⚠️ Connection problem (${badTicks * 5}s): ws=${JSON.stringify(wsState)} rtcReady=${rtcReady}`);
        if (badTicks * 5 >= 10) {
          failRun(new Error('Connection to Discord lost - restarting the stream'));
        }

        // DAVE (end-to-end encryption) stuck: library sends UNENCRYPTED frames, Discord viewers see nothing
        const daveVer = sc ? sc._daveProtocolVersion : 0;
        const daveBroken = Boolean(sc && daveVer > 0 && !(sc._daveSession && sc._daveSession.ready));
        if (daveBroken) daveBadTicks++; else daveBadTicks = 0;
        if (daveBadTicks > 0) console.warn(`🔐 Encryption (DAVE) not ready for ${daveBadTicks * 5}s`);
        if (daveBadTicks === 2) {
          // quick in-place recovery: re-send our MLS key package
          try { sc.initDave(); console.log('🔐 Re-sent DAVE key package'); } catch (e) { /* ignore */ }
        }
        if (daveBadTicks >= 4) {
          failRun(new Error('DAVE encryption stuck - restarting the stream'));
        }

        const dv = counters.v - last.v;
        const da = counters.a - last.a;
        last = { v: counters.v, a: counters.a };

        // STREAM_DIAG=1 in .env prints this every 5 seconds
        if (process.env.STREAM_DIAG === '1') {
          console.log('[diag]', JSON.stringify({
            t: ticks * 5 + 's',
            videoFramesLast5s: dv,
            audioFramesLast5s: da,
            videoKBtotal: Math.round(counters.vBytes / 1024),
            rtcReady,
            dave: Boolean(sc && sc.daveReady),
            ws: wsState,
          }));
        }

        // stall detection (only after we have seen video flowing at least once)
        if (counters.v > 0 && dv === 0) stalledTicks++; else stalledTicks = 0;
        if (stalledTicks * 5 >= STALL_SECONDS) {
          failRun(new Error(`No video frames for ${STALL_SECONDS}s (stalled)`));
        }
      }, 5000);

      const playP = playStream(ffmpegProc.stdout, streamer, {
        type: STREAM_TYPE,
        width: WIDTH,
        height: HEIGHT,
        frameRate: FPS,
      });
      playP.catch(() => {});

      await Promise.race([playP, watchdog]);
      console.log('ℹ️ Stream ended.');
    } catch (err) {
      console.error('❌ Stream error:', err && (err.message || err));
    }

    onStreamDeleted = null;
    if (diag) clearInterval(diag);
    killFfmpeg();
    try { streamer.stopStream(); } catch (e) { /* ignore */ }
    try { streamer.leaveVoice(); } catch (e) { /* ignore */ }

    if (!stopped) {
      console.log('🔁 Restarting in 2 seconds...');
      await sleep(2000);
    }
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});

// Catch WebSocket errors and restart the stream instead of hanging
function handleCrash(kind, err) {
  const msg = err && (err.message || err.type || err.error?.message || String(err));
  console.error(`⚠️ ${kind}:`, msg);
  if (onStreamDeleted) onStreamDeleted(new Error(`${kind}: ${msg}`));
}
process.on('uncaughtException', err => handleCrash('uncaughtException', err));
process.on('unhandledRejection', err => handleCrash('unhandledRejection', err));

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  stopped = true;
  killFfmpeg();
  try { if (streamer) { streamer.stopStream(); streamer.leaveVoice(); } } catch (e) { /* ignore */ }
  try { if (client) client.destroy(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
});
