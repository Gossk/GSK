const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BIN_DIR = path.join(__dirname, 'bin');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR);
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const ytDlpBinary = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytDlpWrap = null;

async function getEngine() {
  if (ytDlpWrap) return ytDlpWrap;
  if (!fs.existsSync(ytDlpBinary)) {
    console.log('Descargando motor yt-dlp oficial...');
    await YTDlpWrap.downloadFromGithub(ytDlpBinary);
  }
  ytDlpWrap = new YTDlpWrap(ytDlpBinary);
  return ytDlpWrap;
}

getEngine().then(() => console.log('Motor multimedia listo.'));

const sanitizeFilename = (name) =>
  name.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '').trim() || 'media';

function getAuthArgs() {
  const args = ['--js-runtimes', 'node'];

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

// 1. Obtener vista previa del video
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Ingresa un enlace válido.' });

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
    // Selector universal: toma la mejor pista de video y audio disponible sin restringir contenedor
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
    console.error('Error descarga:', err.message);
    if (!res.headersSent) {
      return res.status(500).send('Error al procesar el archivo.');
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));