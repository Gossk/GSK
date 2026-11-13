const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const sanitizeFilename = (name) => name.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '').trim() || 'media';

function getBaseArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web,tv_embedded'
  ];

  const localCookies = path.join(__dirname, 'cookies.txt');
  const renderSecretCookies = '/etc/secrets/cookies.txt';
  const writableCookies = '/tmp/cookies.txt';

  // Copiar cookies a /tmp porque yt-dlp necesita permisos de escritura sobre el archivo
  if (fs.existsSync(localCookies)) {
    fs.copyFileSync(localCookies, writableCookies);
    args.push('--cookies', writableCookies);
  } else if (fs.existsSync(renderSecretCookies)) {
    fs.copyFileSync(renderSecretCookies, writableCookies);
    args.push('--cookies', writableCookies);
  }

  return args;
}

// 1. Obtener metadatos
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Ingresa un enlace válido.' });

  const args = [...getBaseArgs(), '--dump-json', url];

  execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
    if (error) {
      console.error('YT-DLP ERROR:', stderr || error.message);
      // Extrae la línea real del error de yt-dlp para que sepas exactamente qué pasó
      const errorLines = (stderr || error.message)
        .split('\n')
        .filter(line => line.includes('ERROR:'))
        .join(' | ');

      return res.status(500).json({
        error: errorLines || 'Error desconocido al ejecutar yt-dlp en el servidor.'
      });
    }

    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || 'N/A',
        uploader: info.uploader || info.channel || 'Desconocido',
        platform: info.extractor_key
      });
    } catch (e) {
      res.status(500).json({ error: 'No se pudo interpretar la respuesta del video.' });
    }
  });
});

// 2. Descargar y convertir
app.get('/api/download', (req, res) => {
  const { url, format, quality, title } = req.query;
  if (!url) return res.status(400).send('Falta el enlace');

  const fileId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const safeTitle = sanitizeFilename(title || 'descarga');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  let args = [...getBaseArgs()];
  let ext = format || 'mp4';

  if (['mp3', 'm4a', 'wav'].includes(ext)) {
    args.push('-x', '--audio-format', ext, '--audio-quality', '0');
  } else {
    const heightFilter = quality && quality !== 'best' ? `[height<=${quality}]` : '';
    args.push(
      '-f', `bestvideo${heightFilter}[ext=mp4]+bestaudio[ext=m4a]/best${heightFilter}[ext=mp4]/best`,
      '--merge-output-format', ext
    );
  }

  args.push('-o', outputTemplate, url);

  execFile('yt-dlp', args, (error, stdout, stderr) => {
    if (error) {
      console.error('YT-DLP DOWNLOAD ERROR:', stderr || error.message);
      const errorLines = (stderr || error.message)
        .split('\n')
        .filter(line => line.includes('ERROR:'))
        .join(' | ');
      return res.status(500).send(errorLines || 'Error al procesar el archivo.');
    }

    const finalFile = path.join(DOWNLOAD_DIR, `${fileId}.${ext}`);
    res.download(finalFile, `${safeTitle}.${ext}`, () => {
      fs.unlink(finalFile, () => {});
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));