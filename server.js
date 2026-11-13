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

// Detecta cookies en la raíz o en Secret Files de Render
function getBaseArgs() {
  const args = ['--no-playlist', '--js-runtimes', 'node'];
  const localCookies = path.join(__dirname, 'cookies.txt');
  const renderSecretCookies = '/etc/secrets/cookies.txt';

  if (fs.existsSync(localCookies)) {
    args.push('--cookies', localCookies);
  } else if (fs.existsSync(renderSecretCookies)) {
    args.push('--cookies', renderSecretCookies);
  }
  return args;
}

// 1. Obtener metadatos del video
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Por favor ingresa un enlace válido.' });

  const args = [...getBaseArgs(), '--dump-json', url];

  execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 15 }, (error, stdout, stderr) => {
    if (error) {
      console.error('Error yt-dlp info:', stderr || error.message);
      const isBotBlock = (stderr || '').includes('Sign in to confirm');
      return res.status(500).json({
        error: isBotBlock
          ? 'YouTube bloqueó la IP del servidor. Agrega tu archivo cookies.txt.'
          : 'No se pudo obtener información. Verifica que el enlace sea público.'
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
      res.status(500).json({ error: 'Error al procesar los datos del video.' });
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
      console.error('Error yt-dlp download:', stderr || error.message);
      return res.status(500).send('Error al procesar el archivo en el servidor.');
    }

    const finalFile = path.join(DOWNLOAD_DIR, `${fileId}.${ext}`);
    res.download(finalFile, `${safeTitle}.${ext}`, () => {
      fs.unlink(finalFile, () => {});
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor GSK Media activo en puerto ${PORT}`));