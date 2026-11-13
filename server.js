const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BIN_DIR = path.join(__dirname, 'bin');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR);
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

let ytDlpWrap = null;

async function getEngine() {
  if (ytDlpWrap) return ytDlpWrap;

  // En Linux/Render usa el yt-dlp instalado por pip (que ya incluye yt-dlp-ejs)
  if (process.platform !== 'win32' && fs.existsSync('/usr/local/bin/yt-dlp')) {
    ytDlpWrap = new YTDlpWrap('/usr/local/bin/yt-dlp');
    return ytDlpWrap;
  }

  // En Windows local descarga el .exe si no existe
  const winBinary = path.join(BIN_DIR, 'yt-dlp.exe');
  if (!fs.existsSync(winBinary)) {
    console.log('Descargando motor yt-dlp para Windows...');
    await YTDlpWrap.downloadFromGithub(winBinary);
  }
  ytDlpWrap = new YTDlpWrap(winBinary);
  return ytDlpWrap;
}

getEngine().then(() => console.log('Motor multimedia con solver EJS listo.'));

const sanitizeFilename = (name) =>
  name.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '').trim() || 'media';

const isTikTok = (url) => url.includes('tiktok.com');

function getAuthArgs() {
  const args = [
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=web_safari,web_embedded,tv'
  ];

  const localCookies = path.join(__dirname, 'cookies.txt');
  const renderSecretCookies = '/etc/secrets/cookies.txt';
  const tempCookies = path.join(os.tmpdir(), 'yt_cookies.txt');

  let sourceFile = null;
  if (fs.existsSync(localCookies)) sourceFile = localCookies;
  else if (fs.existsSync(renderSecretCookies)) sourceFile = renderSecretCookies;

  if (sourceFile) {
    const cleanContent = fs.readFileSync(sourceFile, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(tempCookies, cleanContent, 'utf8');
    args.push('--cookies', tempCookies);
  }

  return args;
}

async function getTikTokFallback(url) {
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  const json = await res.json();
  if (json.code === 0 && json.data) {
    return json.data;
  }
  throw new Error('No se pudo extraer desde TikWM');
}

// 1. Obtener vista previa del video
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !url.trim().startsWith('http')) {
  return res.status(400).json({ error: 'Pega un enlace válido que empiece con https://' });
}

  try {
    const engine = await getEngine();
    const stdout = await engine.execPromise([
      url,
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--ignore-no-formats-error',
      ...getAuthArgs()
    ]);

    const info = JSON.parse(stdout);
    return res.json({
      title: info.title || 'Archivo multimedia',
      thumbnail: info.thumbnail || '',
      duration: info.duration_string || 'HD',
      uploader: info.uploader || info.channel || 'Web',
      platform: info.extractor_key || 'Video'
    });
  } catch (err) {
    if (isTikTok(url)) {
      try {
        const tk = await getTikTokFallback(url);
        return res.json({
          title: tk.title || 'Video de TikTok',
          thumbnail: tk.cover || '',
          duration: tk.duration ? `${tk.duration}s` : 'HD',
          uploader: tk.author?.nickname || 'TikTok',
          platform: 'TikTok'
        });
      } catch (tkErr) {
        console.error('Error respaldo TikTok:', tkErr.message);
      }
    }

    console.error('Error info:', err.message);
    return res.status(500).json({
      error: 'No se pudo leer el enlace. Verifica que sea público y válido.'
    });
  }
});

// 2. Descargar y convertir en la calidad elegida
app.get('/api/stream-download', async (req, res) => {
  const { url, format = 'mp4', quality = 'best', title = 'video' } = req.query;
  if (!url) return res.status(400).send('Falta el enlace.');

  const fileId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const safeTitle = sanitizeFilename(title);
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  const args = [
    url,
    '--no-playlist',
    '--ffmpeg-location', ffmpegPath,
    ...getAuthArgs(),
    '-o', outputTemplate
  ];

  const isAudio = ['mp3', 'm4a', 'wav'].includes(format);

  if (isAudio) {
    args.push('-x', '--audio-format', format, '--audio-quality', '0');
  } else {
    const heightLimit = quality !== 'best' ? `[height<=${quality}]` : '';
    args.push(
      '-f', `bestvideo${heightLimit}+bestaudio/best${heightLimit}/best`,
      '--merge-output-format', format
    );
  }

  try {
    const engine = await getEngine();
    await engine.execPromise(args);

    const finalFile = path.join(DOWNLOAD_DIR, `${fileId}.${format}`);
    return res.download(finalFile, `${safeTitle}.${format}`, () => {
      fs.unlink(finalFile, () => {});
    });
  } catch (err) {
    if (isTikTok(url)) {
      try {
        const tk = await getTikTokFallback(url);
        const mediaUrl = isAudio ? tk.music : (tk.hdplay || tk.play);

        if (mediaUrl) {
          const mediaRes = await fetch(mediaUrl);
          if (!mediaRes.ok) throw new Error('No se pudo obtener el flujo de TikTok');

          const ext = isAudio ? 'mp3' : 'mp4';
          res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
          res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

          return Readable.fromWeb(mediaRes.body).pipe(res);
        }
      } catch (tkErr) {
        console.error('Error descarga respaldo TikTok:', tkErr.message);
      }
    }

    console.error('Error descarga:', err.message);
    if (!res.headersSent) {
      return res.status(500).send('Error al procesar el archivo: ' + err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));