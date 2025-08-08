function parseM3U(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const parsed = [];
  let meta = { title: '', logo: '', id: '', group: '' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      meta = { title: '', logo: '', id: '', group: '' };
      const titleMatch = line.match(/,(.*)$/);
      if (titleMatch) meta.title = titleMatch[1].trim();
      const logoMatch = line.match(/tvg-logo=\"(.*?)\"/);
      if (logoMatch) meta.logo = logoMatch[1];
      const idMatch = line.match(/tvg-id=\"(.*?)\"/);
      if (idMatch) meta.id = idMatch[1];
      const groupMatch = line.match(/group-title=\"(.*?)\"/i);
      if (groupMatch) meta.group = groupMatch[1];
    } else if (!line.startsWith('#')) {
      parsed.push({
        title: meta.title || line,
        logo: meta.logo || null,
        id: meta.id || null,
        group: meta.group || null,
        url: line
      });
    }
  }
  return parsed;
}

module.exports = { parseM3U };
