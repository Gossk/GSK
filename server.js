const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Limpia el título para que sea un nombre de archivo válido
const sanitizeFilename = (name) => name.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '').trim() || 'video';

// Endpoint para obtener vista previa
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Falta el enlace' });

  execFile('yt-dlp', ['--dump-json', '--no-playlist', url], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
    if (error) return res.status(500).json({ error: 'No se pudo leer el enlace. Verifica que sea público.' });
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || '',
        platform: info.extractor_key
      });
    } catch {
      res.status(500).json({ error: 'Error procesando metadatos.' });
    }
  });
});

// Endpoint de descarga
app.get('/api/download', (req, res) => {
  const { url, format, quality, title } = req.query;
  if (!url) return res.status(400).send('Falta URL');

  const fileId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const safeTitle = sanitizeFilename(title || 'descarga');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  let args = ['--no-playlist'];
  let ext = format;

  if (['mp3', 'm4a', 'wav'].includes(format)) {
    args.push('-x', '--audio-format', format, '--audio-quality', '0');
  } else {
    // Video MP4 o WEBM con límite de resolución elegido (ej. 1080, 720, 480)
    const heightFilter = quality && quality !== 'best' ? `[height<=${quality}]` : '';
    args.push(
      '-f', `bestvideo${heightFilter}[ext=mp4]+bestaudio[ext=m4a]/best${heightFilter}[ext=mp4]/best`,
      '--merge-output-format', format || 'mp4'
    );
    ext = format || 'mp4';
  }

  args.push('-o', outputTemplate, url);

  execFile('yt-dlp', args, (error) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Error al descargar o convertir el archivo.');
    }

    const finalFile = path.join(DOWNLOAD_DIR, `${fileId}.${ext}`);
    
    res.download(finalFile, `${safeTitle}.${ext}`, () => {
      // Borra el archivo apenas termina de enviarse para no llenar el disco
      fs.unlink(finalFile, () => {});
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listo en http://localhost:${PORT}`));